// Persistent state, settings and formatting helpers.
import { serializeProofs, deserializeProofs, sumProofs } from '@cashu/cashu-ts';

export const KEY = 'blindsig.v1';
export const VERSION = '1.1.0';

export const DEFAULT_SETTINGS = {
  theme: 'green', // green | white | amber
  keypad: true,
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
export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); return true; } catch { return false; }
}
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
export const isFiatUnit = (u) => u in FIAT;
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
