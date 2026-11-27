// Persistent state, settings and formatting helpers.
import { serializeProofs, deserializeProofs, sumProofs } from '@cashu/cashu-ts';

export const KEY = 'blindsig.v1';
export const VERSION = '1.9.1';

export const DEFAULT_SETTINGS = {
  theme: 'green', // green | white | amber | orange
  lang: '', // '' = follow the device language
  keypad: true,
  sounds: true,
  soundsOnSilent: false, // iPhone: play even with the ring switch on silent
  haptics: true,
  motion: true,
  btcSymbol: false,
  fiat: true,
  fiatCur: 'USD',
  checkIncoming: true,
  checkStartup: true,
  checkAll: false,
  checkSent: true,
  websockets: true,
  autoPaste: false,
  receiveSwaps: false,
  auditor: true,
  auditorApi: 'https://api.audit.8333.space',
  auditorUrl: 'https://audit.8333.space',
  multinut: false,
  nfcEncoding: 'text', // text | url | binary
  nfcQuick: true,
  p2pkQuick: false,
};

const blank = () => ({
  v: 2, mnemonic: null, counters: {}, mints: [], active: null, unit: 'sat',
  proofs: {}, history: [], p2pk: [], price: {}, settings: { ...DEFAULT_SETTINGS }, onboarded: false,
});

function load() {
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!s) return blank();
  s = Object.assign(blank(), s);
  // v1 -> v2 migration: proofs keyed by url, sat only; top-level fiat flag
  if (!s.v || s.v < 2) {
    const np = {};
    for (const [k, v] of Object.entries(s.proofs || {})) np[k.includes('|') ? k : `${k}|sat`] = v;
    s.proofs = np;
    s.history = (s.history || []).map((h) => ({ unit: 'sat', ...h }));
    s.mints = (s.mints || []).map((m) => ({ units: ['sat'], ...m }));
    if (typeof s.fiat === 'boolean') s.settings.fiat = s.fiat;
    delete s.fiat;
    if (typeof s.price === 'number') s.price = { USD: s.price };
    s.onboarded = !!s.mnemonic;
    s.v = 2;
  }
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  return s;
}

export const S = load();
function normalize(s) {
  s = Object.assign(blank(), s);
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  return s;
}

/* ---------- persistence: IndexedDB (no 5 MB limit), localStorage fallback ---------- */
// With a PIN set, the saved state is an encrypted envelope:
// { enc: 1, kdf, iter, salt, chk: {iv, ct}, iv, ct, pub: { theme, lang, len, after } }
// AES-256-GCM with a key derived from the PIN (PBKDF2-SHA256). `pub` holds only what the
// lock screen needs before unlocking. The key lives in memory as a non-extractable CryptoKey.
let db = null;
let key = null; // CryptoKey while a PIN is set and the wallet is unlocked
let env = null; // envelope header (no ciphertext) while a PIN is set
function openDb() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('blindsig', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
const idbGet = (k) => new Promise((res) => { try { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); } catch { res(undefined); } });

// in chunks: spreading a large wallet's bytes into one call overflows the stack
const b64 = (buf) => { const u8 = new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder(), dec = new TextDecoder();
const CHECK = 'blindsig-pin-check';
export const PIN_ITER = 600000;
async function deriveKey(pin, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(k, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}
async function open_(k, box) {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.ct)));
}

let lockedRaw = null; // encrypted envelope found at startup, waiting for the PIN
// load the newest saved state before the rest of the app starts.
// Returns { locked: true, pub } when a PIN must be entered first (then call unlock(pin)).
export async function initStore() {
  db = await openDb();
  let raw = db ? await idbGet('state') : undefined;
  if (raw == null) { try { raw = localStorage.getItem(KEY); } catch {} }
  if (raw == null) return { locked: false };
  let parsed; try { parsed = JSON.parse(raw); } catch { return { locked: false }; }
  if (parsed && parsed.enc === 1) {
    lockedRaw = parsed;
    env = { ...parsed }; delete env.iv; delete env.ct;
    for (const k of Object.keys(S)) delete S[k];
    Object.assign(S, blank());
    if (parsed.pub?.theme) S.settings.theme = parsed.pub.theme;
    if (parsed.pub?.lang) S.settings.lang = parsed.pub.lang;
    if (parsed.pub?.fx) Object.assign(S.settings, parsed.pub.fx);
    return { locked: true, pub: parsed.pub || {} };
  }
  try { const st = normalize(parsed); for (const k of Object.keys(S)) delete S[k]; Object.assign(S, st); } catch {}
  if (db && !(await idbGet('state')) && localStorage.getItem(KEY)) save(); // migrate localStorage -> IndexedDB
  return { locked: false };
}
// does this PIN open the wallet? (checks a small sealed value, not the whole state)
export async function checkPin(pin) {
  if (!env) return true;
  try { const k = await deriveKey(pin, unb64(env.salt), env.iter); return (await open_(k, env.chk)) === CHECK ? k : null; } catch { return null; }
}
// first unlock after a cold start: decrypt the saved state into S
export async function unlock(pin) {
  const k = await checkPin(pin);
  if (!k) return false;
  if (lockedRaw) {
    const st = normalize(JSON.parse(await open_(k, lockedRaw)));
    for (const x of Object.keys(S)) delete S[x];
    Object.assign(S, st);
    lockedRaw = null;
  }
  key = k;
  return true;
}
export const pinOn = () => !!env;
export const pinInfo = () => (env ? { len: env.pub?.len || 6, after: env.pub?.after ?? 300 } : null);
// turn the PIN on, or change it: re-encrypt everything under a new salt and key
export async function setPin(pin, after) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey(pin, salt, PIN_ITER);
  env = { enc: 1, kdf: 'pbkdf2-sha256', iter: PIN_ITER, salt: b64(salt), chk: await seal(k, CHECK), pub: { len: pin.length, after: after ?? env?.pub?.after ?? 300 } };
  key = k;
  await flushSave(true);
}
export async function clearPin() { env = null; key = null; await flushSave(true); }
export async function setLockAfter(sec) { if (!env) return; env.pub.after = sec; await flushSave(true); }

let writing = null, queued = false;
let wiped = false;
export function save() {
  if (wiped) return false;
  queued = true;
  if (!writing) writing = flush();
  return true;
}
async function flush() {
  try {
    while (queued) {
      queued = false;
      try {
        const json = JSON.stringify(S);
        let out = json;
        if (env && key) {
          env.pub.theme = S.settings.theme; env.pub.lang = S.settings.lang || '';
          env.pub.fx = { sounds: S.settings.sounds !== false, haptics: S.settings.haptics !== false, soundsOnSilent: !!S.settings.soundsOnSilent, motion: S.settings.motion !== false };
          out = JSON.stringify({ ...env, ...(await seal(key, json)) });
        } else if (env) continue; // still locked: never overwrite the encrypted state
        await writeRaw(out, !!env);
      } catch (e) {
        // never fall back to writing plaintext; try again shortly
        console.error('save failed', e);
        setTimeout(save, 1500);
      }
    }
  } finally { writing = null; }
}
// wait until everything is on disk (call before reloading the page)
export async function flushSave(force) {
  if (force) save();
  while (writing) await writing;
}
function writeRaw(text, secret) {
  return new Promise((res) => {
    const ls = () => { try { localStorage.setItem(KEY, text); } catch {} res(); };
    if (!db) return ls();
    try {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(text, 'state');
      // once IndexedDB holds the state, drop the old localStorage copy (always, when it would be plaintext)
      tx.oncomplete = () => { try { if (secret || localStorage.getItem(KEY)) localStorage.removeItem(KEY); } catch {} res(); };
      tx.onerror = ls; tx.onabort = ls;
    } catch { ls(); }
  });
}
export async function wipeStore() {
  wiped = true; queued = false;
  while (writing) await writing;
  try { localStorage.removeItem(KEY); localStorage.removeItem(KEY + '.lock'); } catch {}
  env = null; key = null; lockedRaw = null;
  if (db) await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('state'); tx.oncomplete = res; tx.onerror = res; });
}
export const storageKind = () => (db ? 'IndexedDB' : 'localStorage');
export const set = () => S.settings;

/* ---------- proofs ---------- */
const pk = (url, unit) => `${url}|${unit}`;
export const getProofs = (url, unit = S.unit) => { const a = S.proofs[pk(url, unit)]; return a && a.length ? deserializeProofs(a) : []; };
export const setProofs = (url, p, unit = S.unit) => { S.proofs[pk(url, unit)] = p.length ? serializeProofs(p) : []; save(); };
export const addProofs = (url, p, unit = S.unit) => {
  if (!p || !p.length) return;
  const have = getProofs(url, unit), seen = new Set(have.map((x) => x.secret));
  setProofs(url, [...have, ...p.filter((x) => !seen.has(x.secret))], unit);
};
export const sum = (p) => (p && p.length ? sumProofs(p).toNumber() : 0);
export const bal = (url, unit = S.unit) => sum(getProofs(url, unit));
export const total = (unit = S.unit) => S.mints.reduce((t, m) => t + bal(m.url, unit), 0);
export const mintOf = (url) => S.mints.find((m) => m.url === url);
export const unitsAll = () => [...new Set(S.mints.flatMap((m) => m.units || ['sat']))];

/* ---------- formatting ---------- */
export const host = (url) => { try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); } catch { return url; } };
export const mintLabel = (m) => (m ? m.nick || m.name || host(m.url) : '');
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const normUrl = (u) => { u = u.trim().replace(/\/+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return u; };
export const num = (n) => Number(n || 0).toLocaleString('en-US');
const FIAT = { usd: '$', eur: '€', gbp: '£', jpy: '¥' };
export const isFiatUnit = (u) => Object.prototype.hasOwnProperty.call(FIAT, u);
export const decimals = (u) => (u === 'jpy' ? 0 : isFiatUnit(u) ? 2 : 0);

// full amount string with unit, e.g. "1,234 sat", "₿1,234", "$12.50"
export function fmt(n, unit = S.unit) {
  n = Number(n || 0);
  if (unit === 'sat') return S.settings.btcSymbol ? '₿' + num(n) : num(n) + ' sat';
  if (unit === 'msat') return num(n) + ' msat';
  if (isFiatUnit(unit)) return FIAT[unit] + (n / 10 ** decimals(unit)).toLocaleString('en-US', { minimumFractionDigits: decimals(unit), maximumFractionDigits: decimals(unit) });
  return num(n) + ' ' + unit;
}
// split for big displays: { pre, value, post }
export function fmtParts(n, unit = S.unit) {
  n = Number(n || 0);
  if (unit === 'sat') return S.settings.btcSymbol ? { pre: '₿', value: num(n), post: '' } : { pre: '', value: num(n), post: 'sat' };
  if (isFiatUnit(unit)) return { pre: FIAT[unit], value: (n / 10 ** decimals(unit)).toLocaleString('en-US', { minimumFractionDigits: decimals(unit), maximumFractionDigits: decimals(unit) }), post: '' };
  return { pre: '', value: num(n), post: unit };
}
export const unitLabel = (u) => (u === 'sat' ? (S.settings.btcSymbol ? '₿' : 'sat') : u.toUpperCase());
// parse user-typed amount into the unit's base integer (sats, cents)
export const toBase = (txt, unit = S.unit) => {
  const v = parseFloat(String(txt).replace(/[^0-9.]/g, ''));
  if (!isFinite(v) || v <= 0) return 0;
  return Math.round(v * 10 ** decimals(unit));
};
export const FIAT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY', 'BRL', 'MXN', 'INR', 'ZAR', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'TRY', 'ARS', 'NGN'];
export function fiatOf(sats) {
  const p = S.price[S.settings.fiatCur];
  if (!p) return '';
  const v = (sats / 1e8) * p;
  return '≈ ' + v.toLocaleString('en-US', { style: 'currency', currency: S.settings.fiatCur, maximumFractionDigits: v < 1 ? 4 : 2 });
}
