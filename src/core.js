// Wallet logic: mints, units, Lightning, ecash, P2PK, swaps, multinut, restore.
import {
  Wallet, getEncodedToken, getTokenMetadata, serializeProofs, deserializeProofs,
  getP2PKExpectedWitnessPubkeys, getPubKeyFromPrivKey, OutputData, Amount, setGlobalRequestOptions,
  verifyMintSignatures,
} from '@cashu/cashu-ts';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bech32 } from '@scure/base';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import {
  S, save, getProofs, setProofs, addProofs, sum, bal, mintOf, host, uid, normUrl, fmt,
} from './store.js';

// a mint that stops answering gets 45 s, not the library's 5 minutes. A Lightning payment that is
// still running after that is not lost: it is recorded as in flight and settles later.
setGlobalRequestOptions({ requestTimeout: 45000 });

/* ---------------- seed + counters ---------------- */
let SEED = S.mnemonic ? mnemonicToSeedSync(S.mnemonic) : null;
export const counterSource = {
  async reserve(id, n) { const start = S.counters[id] || 0; if (n > 0) { S.counters[id] = start + n; save(); } return { start, count: n }; },
  async reserveAt(id, start, count) {
    const cur = S.counters[id] || 0;
    if (start < cur) throw new Error(`counter ${start} already used for keyset ${id}`);
    S.counters[id] = start + count; save(); return { start, count };
  },
  async advanceToAtLeast(id, n) { if ((S.counters[id] || 0) < n) { S.counters[id] = n; save(); } },
  async snapshot() { return { ...S.counters }; },
  async setNext(id, n) { S.counters[id] = n; save(); },
};
export function setSeed(m) { S.mnemonic = m; save(); SEED = mnemonicToSeedSync(m); wallets.clear(); seedListeners.forEach((f) => f()); }
const seedListeners = [];
export const onSeedChange = (f) => seedListeners.push(f);
// nostr key derived like cashu.me: first 32 bytes of the BIP39 seed
export const seedNostrSk = () => (SEED ? SEED.slice(0, 32) : null);
// extra private keys that may unlock NUT-20 locked mint quotes (e.g. npub.cash)
let quoteKeyProvider = () => [];
export const setQuoteKeyProvider = (f) => { quoteKeyProvider = f; };

/* ---------------- wallets ---------------- */
const wallets = new Map();
export function walletFor(url, unit = S.unit, seed = SEED, counters = counterSource) {
  const key = `${url}|${unit}|${seed === SEED ? 'main' : 'alt'}`;
  if (seed !== SEED) return makeWallet(url, unit, seed, counters);
  if (!wallets.has(key)) {
    const p = makeWallet(url, unit, seed, counters);
    wallets.set(key, p);
    p.catch(() => wallets.delete(key));
  }
  return wallets.get(key);
}
async function makeWallet(url, unit, seed, counters) {
  const w = new Wallet(url, { unit, bip39seed: seed, counterSource: counters });
  const c = (S.mintCache ||= {})[url];
  // offline (or the mint is down): carry on with the keys we saved last time, so offline sends and
  // checking the mint's signatures on ecash still work
  if (c && navigator.onLine === false) { w.loadMintFromCache(c.info, c.keys); w.fromCache = true; return w; }
  try { await w.loadMint(); } catch (e) { if (!c) throw e; w.loadMintFromCache(c.info, c.keys); w.fromCache = true; return w; }
  rememberKeys(url, w);
  return w;
}
// a mint's public keys, saved for offline use. Only active keysets keep their keys, to stay small;
// a keyset id is a hash of its keys, so saved keys never go stale.
function rememberKeys(url, w) {
  try {
    const cache = w.keyChain.cache, info = w.getMintInfo().cache;
    const keysets = cache.keysets.map((k) => (k.active ? k : { ...k, keys: undefined }));
    const sig = keysets.map((k) => `${k.id}${k.active ? '+' : '-'}${k.keys ? 'k' : ''}`).join();
    const old = (S.mintCache ||= {})[url];
    if (old && old.sig === sig) return;
    S.mintCache[url] = { sig, info, keys: { ...cache, keysets } }; save();
  } catch (e) { console.warn('mint cache', e); }
}
export const dropWallets = () => wallets.clear();
// wallets made from saved keys are swapped for live ones once we're back online
if (typeof addEventListener === 'function') addEventListener('online', () => { for (const [k, p] of wallets) p.then((w) => w.fromCache && wallets.delete(k), () => {}); });

async function infoSnapshot(w) {
  const info = w.getMintInfo(), c = info.cache || {};
  let ks = [];
  try { ks = (await w.mint.getKeySets()).keysets || []; } catch { ks = w.keyChain.getKeysets().map((k) => ({ id: k.id, unit: k.unit, active: k.isActive, input_fee_ppk: k.fee })); }
  const units = [...new Set(ks.map((k) => k.unit).filter((u) => u && u !== 'auth'))];
  return {
    name: info.name || '', pubkey: info.pubkey || '', units: units.length ? units : ['sat'],
    info: {
      description: c.description || '', description_long: c.description_long || '', motd: c.motd || '',
      contact: (c.contact || []).map((x) => ({ method: x.method, info: x.info })), icon_url: c.icon_url || '',
      version: c.version || '', nuts: Object.keys(c.nuts || {}), tos_url: c.tos_url || '', urls: c.urls || [],
      nut11: !!(c.nuts && c.nuts['11']), nut15: !!(c.nuts && c.nuts['15']), nut17: !!(c.nuts && c.nuts['17']),
      mintMethods: ((c.nuts && c.nuts['4'] && c.nuts['4'].methods) || []).map((x) => ({ method: x.method, unit: x.unit, min: x.min_amount ?? null, max: x.max_amount ?? null })),
      meltMethods: ((c.nuts && c.nuts['5'] && c.nuts['5'].methods) || []).map((x) => ({ method: x.method, unit: x.unit, min: x.min_amount ?? null, max: x.max_amount ?? null })),
    },
    keysets: ks.map((k) => ({ id: k.id, unit: k.unit, active: !!k.active, fee: k.input_fee_ppk || 0 })),
    updated: Date.now(),
  };
}
export async function addMint(url) {
  url = normUrl(url);
  const w = await walletFor(url, 'sat');
  const snap = await infoSnapshot(w);
  const ex = mintOf(url);
  if (ex) Object.assign(ex, snap);
  else S.mints.push({ url, nick: '', motdSeen: '', ...snap });
  if (!S.active) { S.active = url; S.unit = snap.units.includes('sat') ? 'sat' : snap.units[0]; }
  save();
  try { navigator.storage?.persist?.(); } catch {}
  return url;
}
export async function refreshMint(url) {
  const w = await walletFor(url, 'sat');
  try { await w.loadMint(); } catch {}
  const m = mintOf(url); if (m) { Object.assign(m, await infoSnapshot(w)); save(); }
  return m;
}
export function selectMint(url) {
  S.active = url;
  const m = mintOf(url);
  if (m && !(m.units || ['sat']).includes(S.unit)) S.unit = (m.units || ['sat'])[0];
  save();
}

/* ---------------- history ---------------- */
const busy = new Set();
// every entry remembers the bitcoin price at that moment (when prices are on), so history can show
// what a payment was worth then as well as now
export const H = (o) => {
  const h = { id: uid(), ts: Date.now(), unit: S.unit, ...o };
  const cur = S.settings.fiatCur, rate = S.settings.fiat ? S.price[cur] : 0;
  if (rate > 0 && h.unit === 'sat' && !h.fx) h.fx = { cur, rate };
  S.history.unshift(h); save(); return h;
};

/* ---------------- lightning in ---------------- */
export async function createInvoice(amount, url = S.active, unit = S.unit, memo) {
  const w = await walletFor(url, unit);
  const q = await w.createMintQuoteBolt11(amount);
  return H({ kind: 'ln-in', amount, mint: url, unit, status: 'pending', quote: q.quote, request: q.request, expiry: q.expiry, memo });
}
export const supports = (url, dir, method, unit = S.unit) => {
  const m = mintOf(url); const list = m?.info?.[dir === 'mint' ? 'mintMethods' : 'meltMethods'] || [];
  return list.find((x) => x.method === method && x.unit === unit) || null;
};
// BOLT12 offers and on-chain addresses can be paid more than once: mint whatever arrived
async function checkReusable(h) {
  const w = await walletFor(h.mint, h.unit);
  const q = h.method === 'bolt12' ? await w.checkMintQuoteBolt12(h.quote) : await w.checkMintQuoteOnchain(h.quote);
  const delta = q.amount_paid.toNumber() - q.amount_issued.toNumber();
  h.paid = q.amount_paid.toNumber();
  if (delta > 0) {
    const proofs = h.method === 'bolt12' ? await w.mintProofsBolt12(delta, q, h.privkey) : await w.mintProofsOnchain(delta, q, h.privkey);
    addProofs(h.mint, proofs, h.unit);
    if (h.status === 'pending') { h.status = 'done'; h.amount = delta; h.ts = Date.now(); }
    else H({ kind: h.kind, method: h.method, amount: delta, unit: h.unit, mint: h.mint, status: 'done', memo: h.method === 'bolt12' ? 'offer payment' : 'deposit', parent: h.id });
    h.received = (h.received || 0) + delta;
    save();
    return 'done';
  }
  if (q.expiry && Date.now() / 1000 > q.expiry) { h.live = false; if (h.status === 'pending') h.status = 'expired'; save(); }
  return h.status === 'pending' ? 'pending' : 'waiting';
}
const newKey = () => { const priv = bytesToHex(randomBytes(32)); return { priv, pub: bytesToHex(getPubKeyFromPrivKey(hexToBytes(priv))) }; };
export async function createOffer(amount, url = S.active, unit = S.unit, description) {
  const w = await walletFor(url, unit), k = newKey();
  const q = await w.createMintQuoteBolt12(k.pub, { ...(amount ? { amount } : {}), ...(description ? { description } : {}) });
  return H({ kind: 'ln-in', method: 'bolt12', amount: amount || 0, mint: url, unit, status: 'pending', live: true, quote: q.quote, request: q.request, expiry: q.expiry, privkey: k.priv, memo: description, received: 0 });
}
export async function createDepositAddress(url = S.active, unit = S.unit, requested) {
  const w = await walletFor(url, unit), k = newKey();
  const q = await w.createMintQuoteOnchain(k.pub);
  return H({ kind: 'chain-in', method: 'onchain', amount: 0, requested: requested || 0, mint: url, unit, status: 'pending', live: true, quote: q.quote, request: q.request, expiry: q.expiry, privkey: k.priv, received: 0 });
}
export async function checkInvoice(h) {
  if (busy.has(h.id)) return h.status;
  if (h.live && (h.method === 'bolt12' || h.method === 'onchain')) {
    busy.add(h.id);
    try { return await checkReusable(h); } finally { busy.delete(h.id); }
  }
  if (h.status !== 'pending') return h.status;
  busy.add(h.id);
  try {
    const w = await walletFor(h.mint, h.unit);
    const q = await w.checkMintQuoteBolt11(h.quote);
    if (q.state === 'PAID') {
      let cfg;
      if (q.pubkey) {
        const keys = [...quoteKeyProvider(), ...S.p2pk.map((k) => k.priv), h.privkey].filter(Boolean);
        cfg = { privkey: keys };
      }
      const proofs = await w.mintProofsBolt11(h.amount, q, cfg);
      addProofs(h.mint, proofs, h.unit);
      h.status = 'done'; h.ts = Date.now();
    } else if (q.state === 'ISSUED') h.status = 'done';
    else if (h.expiry && Date.now() / 1000 > h.expiry) h.status = 'expired';
    save();
  } finally { busy.delete(h.id); }
  return h.status;
}
// resolves when paid over websocket (NUT-17); caller aborts via signal
export async function waitInvoiceWs(h, signal) {
  const w = await walletFor(h.mint, h.unit);
  await w.on.onceMintPaid(h.quote, { signal, timeoutMs: 30 * 60e3 });
  return checkInvoice(h);
}

/* ---------------- ecash ---------------- */
// ecash hidden in an emoji with Unicode variation selectors (compatible with cashu.me)
export function encodeEmoji(token) {
  return '🥜' + Array.from(token).map((ch) => { const b = ch.charCodeAt(0); return b < 16 ? String.fromCodePoint(0xfe00 + b) : b < 256 ? String.fromCodePoint(0xe0100 + b - 16) : ''; }).join('');
}
export function decodeEmoji(text) {
  let out = '';
  for (const ch of Array.from(text)) {
    const c = ch.codePointAt(0);
    const b = c >= 0xfe00 && c <= 0xfe0f ? c - 0xfe00 : c >= 0xe0100 && c <= 0xe01ef ? c - 0xe0100 + 16 : null;
    if (b === null) { if (out) break; continue; }
    out += String.fromCharCode(b);
  }
  return out;
}
export const hasEmojiToken = (t) => /[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/.test(t);
export function parseToken(str) {
  if (hasEmojiToken(str)) { const d = decodeEmoji(str); if (/^cashu/i.test(d)) str = d; }
  str = str.trim().replace(/^web\+cashu:\/\//i, '').replace(/^cashu:\/\//i, '').replace(/^cashu:/i, '');
  const meta = getTokenMetadata(str);
  return { str, mint: normUrl(meta.mint), unit: meta.unit || 'sat', amount: meta.amount.toNumber(), memo: meta.memo };
}
// inspect P2PK locks after loading the token's mint
export async function tokenLockInfo(t) {
  const w = await walletFor(t.mint, t.unit);
  const { proofs } = w.decodeToken(t.str);
  const locks = new Set(); let until = 0;
  for (const p of proofs) {
    try { getP2PKExpectedWitnessPubkeys(p.secret).forEach((k) => locks.add(k)); } catch {}
    try { const [kind, d] = JSON.parse(p.secret); const lt = kind === 'P2PK' && (d.tags || []).find((t) => t[0] === 'locktime'); if (lt) until = Math.max(until, +lt[1] * 1000); } catch {}
  }
  if (!locks.size) return { locked: false };
  const mine = S.p2pk.filter((k) => locks.has(k.pub) || locks.has('02' + k.pub.slice(2)) || locks.has('03' + k.pub.slice(2)));
  return { locked: true, mine: mine.length > 0, keys: [...locks], until: until > Date.now() ? until : 0 };
}
const privkeys = () => S.p2pk.map((k) => k.priv);

// NUT-12: did the mint really sign this ecash? Checked against the mint's public keys, which works
// offline for mints whose keys we've saved. Only the mint can say whether it's already spent.
// state: ok (every note checks out) | partial (some carry no proof) | none (no proofs included)
//        | bad (a proof doesn't match: likely fake) | unknown (we don't have this mint's keys)
export async function checkSignatures(t) {
  let w;
  try { w = await walletFor(t.mint, t.unit); } catch { return { state: 'unknown' }; }
  let proofs;
  try { proofs = w.decodeToken(t.str).proofs; } catch { return { state: 'unknown' }; }
  const signed = proofs.filter((p) => p.dleq);
  if (!signed.length) return { state: 'none', offline: !!w.fromCache };
  for (const id of new Set(signed.map((p) => p.id))) {
    try { await w.keyChain.ensureKeysetKeys(id); } catch {}
    let ks; try { ks = w.keyChain.getKeyset(id); } catch {}
    if (!ks || !ks.hasKeys) return { state: 'unknown', offline: !!w.fromCache };
  }
  const v = await verifyMintSignatures(signed, (id) => w.keyChain.getKeyset(id), { require: true });
  if (v.invalid.length) return { state: 'bad', offline: !!w.fromCache };
  return { state: signed.length === proofs.length ? 'ok' : 'partial', offline: !!w.fromCache };
}
// the same token without signature proofs: about half the size, for NFC cards with little room
export async function compactToken(token) {
  const t = parseToken(token);
  const w = await walletFor(t.mint, t.unit);
  return getEncodedToken(w.decodeToken(t.str), { removeDleq: true });
}

export async function sendEcash(amount, { memo, lockTo, returnAfter, offline, keysetId } = {}) {
  const url = S.active, unit = S.unit, w = await walletFor(url, unit);
  const before = bal(url, unit);
  if (amount > before) throw new Error('insufficient balance at this mint');
  let res;
  // locked to someone, optionally with a way back: after the locktime our refund key can take it
  const refundAt = lockTo && returnAfter > 0 ? Date.now() + returnAfter : 0;
  if (offline) res = await w.ops.send(amount, getProofs(url, unit)).offlineExactOnly(false).includeFees(false).run();
  else if (lockTo) res = await w.ops.send(amount, getProofs(url, unit)).asP2PK({ pubkey: lockTo, ...(refundAt ? { locktime: Math.ceil(refundAt / 1000), refundKeys: [refundKey().pub] } : {}) }).includeFees(true).run();
  else res = await w.send(amount, getProofs(url, unit), { includeFees: true, ...(keysetId ? { keysetId } : {}) });
  // never record a send unless the token really carries the amount
  if (!res.send.length || sum(res.send) < amount) throw new Error(offline ? 'no exact match for offline sending' : 'could not prepare the token');
  setProofs(url, res.keep, unit);
  // with the mint's signature proofs (NUT-12) the receiver can check the ecash is real, even offline
  const token = getEncodedToken({ mint: url, proofs: res.send, unit, ...(memo ? { memo } : {}) }, { removeDleq: !S.settings.dleq });
  return H({ kind: 'ecash-out', amount, unit, fee: Math.max(0, before - sum(res.keep) - amount), mint: url, status: 'pending', token, memo, lockTo, ...(refundAt && !offline ? { refundAt: Math.ceil(refundAt / 1000) * 1000 } : {}) });
}
export async function receiveEcash(t) {
  await addMint(t.mint);
  const w = await walletFor(t.mint, t.unit);
  const pks = privkeys();
  const proofs = await w.receive(t.str, pks.length ? { privkey: pks } : undefined);
  addProofs(t.mint, proofs, t.unit);
  markP2pkUsed(t);
  const got = sum(proofs);
  const pend = S.history.find((x) => x.kind === 'ecash-in' && x.status === 'pending' && x.token === t.str);
  if (pend) { Object.assign(pend, { amount: got, fee: Math.max(0, t.amount - got), status: 'done', ts: Date.now() }); delete pend.token; save(); return pend; }
  return H({ kind: 'ecash-in', amount: got, unit: t.unit, fee: Math.max(0, t.amount - got), mint: t.mint, status: 'done', memo: t.memo });
}
function markP2pkUsed(t) {
  try {
    const keys = new Set();
    // best effort: mark any key whose pubkey appears in the token string's secrets
    for (const k of S.p2pk) if (t.lockKeys && t.lockKeys.includes(k.pub)) { k.used = true; keys.add(k.pub); }
    if (keys.size) save();
  } catch {}
}
// what the mint keeps when this token is received (its input fee), so we can show what you'll get
export async function receiveFee(t) {
  const w = await walletFor(t.mint, t.unit);
  return w.getFeesForProofs(w.decodeToken(t.str).proofs).toNumber();
}
// take all the ecash out of another wallet's state (the decoy) into this one; returns the sats moved
export async function sweepState(st) {
  let got = 0;
  for (const [k, arr] of Object.entries(st.proofs || {})) {
    if (!arr || !arr.length) continue;
    const i = k.lastIndexOf('|'), url = k.slice(0, i), unit = k.slice(i + 1);
    try {
      if (!mintOf(url)) await addMint(url);
      const w = await walletFor(url, unit);
      const p = await w.receive(getEncodedToken({ mint: url, proofs: deserializeProofs(arr), unit }));
      addProofs(url, p, unit); if (unit === 'sat') got += sum(p);
    } catch (e) { console.error('sweep', e); }
  }
  for (const h of st.history || []) {
    if (h.kind !== 'ecash-in' || h.status !== 'pending' || !h.token) continue;
    try { const t = parseToken(h.token); const w = await walletFor(t.mint, t.unit); const p = await w.receive(t.str); addProofs(t.mint, p, t.unit); if (t.unit === 'sat') got += sum(p); } catch {}
  }
  return got;
}
// the proofs inside a token (v4 tokens need the mint's keyset ids to decode)
export async function tokenProofs(token, url, unit = 'sat') {
  const w = await walletFor(url, unit);
  return w.decodeToken(token).proofs;
}
export async function checkClaimed(h) {
  if (h.kind !== 'ecash-out' || h.status !== 'pending') return h.status;
  const w = await walletFor(h.mint, h.unit);
  const { proofs } = w.decodeToken(h.token);
  const st = await w.checkProofsStates(proofs);
  if (st.length && st.every((s) => s.state === 'SPENT')) { h.status = 'claimed'; save(); }
  return h.status;
}
// live updates for unclaimed tokens over the mint's WebSocket (NUT-17)
const watching = new Map();
export function watchSent(onChange) {
  if (!S.settings.websockets) return;
  for (const h of S.history) {
    if (h.kind !== 'ecash-out' || h.status !== 'pending' || watching.has(h.id) || !mintOf(h.mint)?.info?.nut17) continue;
    const ac = new AbortController(); watching.set(h.id, ac);
    (async () => {
      try {
        const w = await walletFor(h.mint, h.unit);
        const { proofs } = w.decodeToken(h.token);
        const spent = new Set();
        for await (const u of w.on.proofStatesStream(proofs, { signal: ac.signal })) {
          if (u.state === 'SPENT') spent.add(u.proof.secret);
          if (spent.size === proofs.length) { h.status = 'claimed'; save(); onChange && onChange(h); break; }
          if (h.status !== 'pending') break;
        }
      } catch {} finally { watching.delete(h.id); }
    })();
  }
}
export function unwatchAll() { for (const ac of watching.values()) ac.abort(); watching.clear(); }
export async function reclaim(h) {
  const w = await walletFor(h.mint, h.unit);
  const pks = privkeys();
  const proofs = await w.receive(h.token, pks.length ? { privkey: pks } : undefined);
  addProofs(h.mint, proofs, h.unit);
  h.status = 'reclaimed'; save();
}

// Swap a token from another mint into the active mint over Lightning.
export async function swapIncoming(t, dst = S.active) {
  const unit = t.unit;
  if (t.mint === dst) throw new Error('token is already from the active mint');
  const ws = await walletFor(t.mint, unit);
  const proofs = await ws.receive(t.str, privkeys().length ? { privkey: privkeys() } : undefined);
  const amt = sum(proofs);
  // saved straight away: if the tab closes mid-swap the ecash is still in the wallet at the source mint
  const knewMint = !!mintOf(t.mint);
  await addMint(t.mint); addProofs(t.mint, proofs, unit);
  const secrets = new Set(proofs.map((p) => p.secret));
  const drop = () => setProofs(t.mint, getProofs(t.mint, unit).filter((p) => !secrets.has(p.secret)), unit);
  const rescue = async () => {};
  try {
    const inFee = ws.getFeesForProofs(proofs).toNumber();
    let target = amt - inFee, inv, q;
    for (let i = 0; i < 4; i++) {
      if (target <= 0) throw new Error('amount too small to cover swap fees');
      inv = await createInvoice(target, dst, unit, 'swap from ' + host(t.mint));
      q = await ws.createMeltQuoteBolt11(inv.request);
      const need = q.amount.toNumber() + q.fee_reserve.toNumber() + inFee;
      if (need <= amt) break;
      S.history = S.history.filter((x) => x !== inv); save();
      target -= need - amt; q = null;
    }
    if (!q) throw new Error('could not fit swap fees');
    drop();
    let res;
    try { res = await ws.meltProofsBolt11(q, proofs); }
    catch (e) { const g = await ws.groupProofsByState(proofs).catch(() => ({ unspent: proofs })); addProofs(t.mint, [...g.unspent], unit); throw e; }
    if (res.quote.state !== 'PAID') throw new Error('swap payment pending');
    if (res.change?.length) addProofs(t.mint, res.change, unit);
    for (let i = 0; i < 8 && inv.status === 'pending'; i++) { await checkInvoice(inv).catch(() => {}); if (inv.status === 'pending') await new Promise((r) => setTimeout(r, 1200)); }
    inv.fee = Math.max(0, t.amount - inv.amount);
    // the source mint was only added to keep the ecash safe: tidy it away again if nothing is left there
    if (!knewMint && !(mintOf(t.mint)?.units || ['sat']).some((u) => bal(t.mint, u) > 0)) S.mints = S.mints.filter((m) => m.url !== t.mint);
    save();
    return inv;
  } catch (e) {
    await rescue().catch(() => {});
    throw new Error(`${e.message || e} // ecash kept at ${host(t.mint)}`);
  }
}

/* ---------------- lightning out ---------------- */
export const isInvoice = (s) => /^ln(bc|tb|bcrt|tbs)[0-9]/i.test(s);
export const isAddress = (s) => /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
// bech32 LNURLs, and the LUD-17 forms (lnurlw://, lnurlp://, keyauth://) that are plain URLs
export const isLnurl = (s) => /^lnurl1[02-9ac-hj-np-z]+$/i.test(s) || /^(lnurl[cwp]|keyauth):\/\/[^\s]+$/i.test(s);
function decodeLnurl(s) {
  const m = s.match(/^(lnurl[cwp]|keyauth):\/\/(.+)$/i);
  if (m) return (/\.onion(?:[:/]|$)/i.test(m[2].split('/')[0]) ? 'http://' : 'https://') + m[2];
  const { words } = bech32.decode(s.toLowerCase(), 2000); return new TextDecoder().decode(bech32.fromWords(words));
}
// what an LNURL or Lightning address points at: a pay endpoint (payRequest) or a withdraw voucher
// (withdrawRequest, LUD-03). Some services put the whole withdraw request in the link itself.
export async function lnurlResolve(target) {
  const url = isLnurl(target) ? decodeLnurl(target) : (() => { const [u, d] = target.split('@'); return `https://${d}/.well-known/lnurlp/${u}`; })();
  const q = new URL(url).searchParams;
  if (q.get('tag') === 'withdrawRequest' && q.get('callback') && q.get('k1')) {
    return { tag: 'withdrawRequest', callback: q.get('callback'), k1: q.get('k1'), minWithdrawable: +q.get('minWithdrawable') || 1000, maxWithdrawable: +q.get('maxWithdrawable') || 0, defaultDescription: q.get('defaultDescription') || '' };
  }
  let meta;
  try { meta = await (await fetch(url)).json(); } catch { throw new Error('could not reach ' + host(url)); }
  if (meta.status === 'ERROR') throw new Error(meta.reason || 'lnurl error');
  return meta;
}
export async function lnurlMeta(target) {
  const meta = await lnurlResolve(target);
  if (meta.tag !== 'payRequest') throw new Error('not a lightning pay endpoint');
  return meta;
}
// LNURL-withdraw: make an invoice at our mint and hand it to the service, which pays it.
// Returns the invoice's history entry; it completes like any invoice once the payment lands.
export async function lnurlWithdraw(meta, sats, url = S.active) {
  const min = Math.ceil(meta.minWithdrawable / 1000), max = Math.floor(meta.maxWithdrawable / 1000);
  if (sats < min || sats > max) throw new Error(min === max ? `amount must be ${min} sat` : `amount must be ${min}–${max} sat`);
  const h = await createInvoice(sats, url, 'sat', meta.defaultDescription || 'LNURL withdraw');
  h.withdraw = new URL(meta.callback).host; save();
  const cb = new URL(meta.callback);
  cb.searchParams.set('k1', meta.k1);
  cb.searchParams.set('pr', h.request);
  let r;
  try { r = await (await fetch(cb)).json(); } catch { r = { status: 'ERROR', reason: 'could not reach ' + host(meta.callback) }; }
  if (r.status === 'ERROR') {
    // nothing will pay this invoice: don't leave it waiting in the history
    S.history = S.history.filter((x) => x !== h); save();
    throw new Error(r.reason || 'the service refused the withdrawal');
  }
  return h;
}
export async function lnurlInvoice(meta, sats, comment) {
  const msat = sats * 1000;
  if (msat < meta.minSendable || msat > meta.maxSendable) throw new Error(`amount must be ${Math.ceil(meta.minSendable / 1000)}–${Math.floor(meta.maxSendable / 1000)} sat`);
  const cb = new URL(meta.callback);
  cb.searchParams.set('amount', String(msat));
  if (comment && meta.commentAllowed) cb.searchParams.set('comment', comment.slice(0, meta.commentAllowed));
  const r = await (await fetch(cb)).json();
  if (r.status === 'ERROR' || !r.pr) throw new Error(r.reason || 'no invoice returned');
  return r.pr;
}
export async function quoteInvoice(inv, url = S.active, unit = S.unit, mppMsat) {
  const w = await walletFor(url, unit);
  return mppMsat ? w.createMultiPathMeltQuote(inv, mppMsat) : w.createMeltQuoteBolt11(inv);
}
export const isOffer = (s) => /^lno1[02-9ac-hj-np-z]+$/i.test(s.trim());
export function parseBitcoin(s) {
  s = s.trim();
  const m = s.match(/^bitcoin:([^?]+)(?:\?(.*))?$/i);
  const addr = m ? m[1] : s;
  if (!/^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}$/i.test(addr) && !/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr)) return null;
  let sats = 0;
  if (m && m[2]) { const p = new URLSearchParams(m[2]); if (p.get('amount')) sats = Math.round(parseFloat(p.get('amount')) * 1e8); if (p.get('lightning')) return { address: addr, sats, lightning: p.get('lightning'), lno: p.get('lno') }; if (p.get('lno')) return { address: addr, sats, lno: p.get('lno') }; }
  return { address: /^(bc1|tb1|bcrt1)/i.test(addr) ? addr.toLowerCase() : addr, sats };
}
export async function quoteOffer(offer, sats, url = S.active, unit = S.unit) {
  const w = await walletFor(url, unit);
  return w.createMeltQuoteBolt12(offer.trim().toLowerCase(), sats ? sats * 1000 : undefined);
}
export async function quoteOnchain(address, amount, url = S.active, unit = S.unit) {
  const w = await walletFor(url, unit);
  return w.createMeltQuoteOnchain(address, amount);
}
export async function payInvoice(q, memo, url = S.active, unit = S.unit, method = 'bolt11', feeIndex) {
  const w = await walletFor(url, unit);
  const amount = q.amount.toNumber();
  const reserve = method === 'onchain' ? (q.fee_options.find((f) => f.fee_index === feeIndex) || q.fee_options[0]).fee_reserve.toNumber() : q.fee_reserve.toNumber();
  const before = bal(url, unit);
  if (amount + reserve > before) throw new Error(`need ${fmt(amount + reserve, unit)} incl. fee reserve // have ${fmt(before, unit)} at ${host(url)}`);
  const { keep, send } = await w.send(amount + reserve, getProofs(url, unit), { includeFees: true });
  setProofs(url, keep, unit);
  const h = H({ kind: method === 'onchain' ? 'chain-out' : 'ln-out', method, amount, unit, mint: url, status: 'pending', quote: q.quote, request: q.request, memo, inflight: serializeProofs(send), reserve: sum(send) - amount });
  try {
    // prepare first so the blank change outputs are stored before the mint sees the melt:
    // async and on-chain melts only hand out change once the quote is paid
    const preview = await w.prepareMelt(method, q, send);
    h.changeOut = preview.outputData.map((o) => OutputData.serialize(o)); save();
    const res = await w.completeMelt(preview, undefined, method === 'onchain' ? { extraPayload: { fee_index: feeIndex ?? q.fee_options[0].fee_index } } : undefined);
    if (res.quote.state === 'PAID' || (method === 'onchain' && res.quote.outpoint)) {
      addProofs(url, res.change || [], unit);
      h.status = res.quote.state === 'PAID' ? 'done' : 'pending'; h.fee = Math.max(0, before - bal(url, unit) - amount);
      h.preimage = res.quote.payment_preimage || ''; h.outpoint = res.quote.outpoint || '';
      if (h.status === 'done') { delete h.inflight; delete h.changeOut; }
    }
    save();
  } catch (e) {
    await settleMelt(h).catch(() => {});
    if (h.status === 'failed') throw e;
  }
  return h;
}
export async function settleMelt(h) {
  if (!(h.kind === 'ln-out' || h.kind === 'chain-out') || h.status !== 'pending' || busy.has(h.id)) return;
  busy.add(h.id);
  try {
    const w = await walletFor(h.mint, h.unit);
    const q = h.method === 'onchain' ? await w.checkMeltQuoteOnchain(h.quote) : h.method === 'bolt12' ? await w.checkMeltQuoteBolt12(h.quote) : await w.checkMeltQuoteBolt11(h.quote);
    if (q.outpoint) h.outpoint = q.outpoint;
    if (q.state === 'PAID') {
      const sigs = (q.change || []).filter((x) => !Amount.from(x.amount).isZero());
      if (sigs.length && h.changeOut) {
        try {
          await w.ensureOperableKeysets(sigs.map((x) => x.id));
          const before = bal(h.mint, h.unit);
          addProofs(h.mint, w.createMeltChangeProofs(h.changeOut.map((o) => OutputData.deserialize(o)), sigs), h.unit);
          h.change = bal(h.mint, h.unit) - before;
        } catch (e) { console.warn('melt change', e); }
      }
      if (h.reserve != null) h.fee = Math.max(0, h.reserve - (h.change || 0));
      h.status = 'done'; h.preimage = q.payment_preimage || ''; delete h.inflight; delete h.changeOut;
    }
    else if (q.state === 'UNPAID' && h.inflight) {
      const g = await w.groupProofsByState(deserializeProofs(h.inflight));
      addProofs(h.mint, [...g.unspent], h.unit);
      h.status = 'failed'; delete h.inflight;
    }
    save();
  } finally { busy.delete(h.id); }
}
// pay one invoice from several mints at once (NUT-15 multi-path)
export async function payMultinut(invoice, parts, unit = S.unit) {
  const quotes = await Promise.all(parts.map(async ([url, amt]) => [url, await quoteInvoice(invoice, url, unit, amt * 1000)]));
  const results = await Promise.allSettled(quotes.map(([url, q]) => payInvoice(q, 'multinut', url, unit)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) throw failed[0].reason;
  return results.map((r) => r.value);
}
// a move between your own mints: both sides are marked `internal` so summaries don't count them
// as money in or out. maxFeePct: give up (before paying) if the Lightning fee would be higher
export async function moveFunds(to, amount, unit = S.unit, from = S.active, maxFeePct = 0) {
  const inv = await createInvoice(amount, to, unit, 'from ' + host(from));
  inv.internal = true;
  let out;
  try {
    const q = await quoteInvoice(inv.request, from, unit);
    const fee = q.fee_reserve.toNumber();
    if (maxFeePct && fee > Math.max(2, (amount * maxFeePct) / 100)) throw Object.assign(new Error('fee-too-high'), { fee });
    out = await payInvoice(q, 'to ' + host(to), from, unit);
    out.internal = true; save();
  } catch (e) {
    // nothing was paid: drop the invoice we made at the other mint, so it doesn't sit in history
    if (inv.status === 'pending' && !out) { S.history = S.history.filter((x) => x !== inv); save(); }
    throw e;
  }
  for (let i = 0; i < 8 && inv.status === 'pending'; i++) { await checkInvoice(inv).catch(() => {}); if (inv.status === 'pending') await new Promise((r) => setTimeout(r, 1500)); }
  return { inv, out };
}
// time vault: lock sats to a key nobody holds (its private half is thrown away), with our refund
// key allowed after `until`. Before then no one can spend them, us included; afterwards returnDue
// takes them back like any unclaimed locked send.
export async function lockVault(amount, until) {
  const burn = newKey().pub; // the private key is never kept
  const h = await sendEcash(amount, { lockTo: burn, returnAfter: until - Date.now() });
  h.vault = true; save();
  return h;
}
// spreading your risk: moves that bring the fullest mint over `limit` down to 90% of it,
// filling your other mints (each kept under that too), fullest room first
export function spreadPlan(limit) {
  if (!limit) return null;
  const target = Math.floor(limit * 0.9);
  const src = S.mints.map((m) => ({ m, b: bal(m.url, 'sat') })).filter((x) => x.b > limit).sort((a, b) => b.b - a.b)[0];
  if (!src) return null;
  const canMint = (m) => { const mm = m.info?.mintMethods; return (m.units || ['sat']).includes('sat') && (!mm || !mm.length || mm.some((x) => x.method === 'bolt11' && x.unit === 'sat')); };
  const dests = S.mints.filter((m) => m.url !== src.m.url && canMint(m)).map((m) => ({ url: m.url, room: target - bal(m.url, 'sat') })).filter((d) => d.room >= 100).sort((a, b) => b.room - a.room);
  let excess = src.b - target; const moves = [];
  for (const d of dests) { if (excess < 100) break; const a = Math.min(d.room, excess); moves.push({ to: d.url, amount: a }); excess -= a; }
  return { from: src.m.url, have: src.b, moves, left: Math.max(0, excess), noOthers: !dests.length };
}
// carry out a plan, one move at a time; onStep(move, result|error)
export async function spreadRun(plan, { maxFeePct = 0, onStep } = {}) {
  let moved = 0;
  for (const mv of plan.moves) {
    try { const r = await moveFunds(mv.to, mv.amount, 'sat', plan.from, maxFeePct); moved += mv.amount; onStep && onStep(mv, r); }
    catch (e) { onStep && onStep(mv, null, e); if (e.message !== 'fee-too-high') break; }
  }
  return moved;
}

/* ---------------- P2PK keys ---------------- */
export function newP2pkKey(privHex) {
  const priv = privHex || bytesToHex(randomBytes(32));
  const pub = bytesToHex(getPubKeyFromPrivKey(hexToBytes(priv)));
  if (S.p2pk.some((k) => k.pub === pub)) return S.p2pk.find((k) => k.pub === pub);
  const k = { pub, priv, used: false, ts: Date.now() };
  S.p2pk.unshift(k); save();
  return k;
}
export function importNsec(nsec) {
  const { prefix, words } = bech32.decode(nsec.trim().toLowerCase(), 200);
  if (prefix !== 'nsec') throw new Error('not an nsec');
  return newP2pkKey(bytesToHex(bech32.fromWords(words)));
}
// accepts hex pubkey (33-byte compressed or 32-byte x-only) or npub
export function parsePubkey(s) {
  s = s.trim();
  if (/^npub1/i.test(s)) { const { words } = bech32.decode(s.toLowerCase(), 200); return '02' + bytesToHex(bech32.fromWords(words)); }
  if (/^(02|03)[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(s)) return '02' + s.toLowerCase();
  throw new Error('not a valid public key or npub');
}
// our own key for getting locked sends back: kept apart from the keys we hand out for receiving
export function refundKey() {
  let k = S.p2pk.find((x) => x.refund);
  if (!k) { k = newP2pkKey(); k.refund = true; k.used = true; save(); }
  return k;
}
// locked sends whose time is up and that nobody claimed: take them back
export async function returnDue(onReturn) {
  const due = S.history.filter((h) => h.kind === 'ecash-out' && h.status === 'pending' && h.refundAt && h.refundAt <= Date.now());
  for (const h of due) {
    try {
      if ((await checkClaimed(h)) !== 'pending') continue;
      await reclaim(h); h.status = 'returned'; save(); onReturn && onReturn(h);
    } catch {}
  }
}
export const currentP2pk = () => S.p2pk.find((k) => !k.used && !k.refund) || S.p2pk.find((k) => !k.refund) || null;

/* ---------------- maintenance ---------------- */
export async function sweepSpent(onlyActive = false) {
  let removed = 0;
  for (const m of S.mints) {
    if (onlyActive && m.url !== S.active) continue;
    for (const unit of m.units || ['sat']) {
      const p = getProofs(m.url, unit); if (!p.length) continue;
      const w = await walletFor(m.url, unit);
      const g = await w.groupProofsByState(p);
      removed += sum(g.spent);
      setProofs(m.url, [...g.unspent, ...g.pending], unit);
    }
  }
  return removed;
}
// restore ecash from a seed (current one by default) into this wallet
export async function restoreMint(url, mnemonic = S.mnemonic, log = () => {}) {
  const foreign = mnemonic !== S.mnemonic;
  const seed = foreign ? mnemonicToSeedSync(mnemonic) : SEED;
  const tmpCounters = foreign ? { ...counterSource, _c: {}, async reserve(id, n) { const s = this._c[id] || 0; this._c[id] = s + n; return { start: s, count: n }; }, async advanceToAtLeast(id, n) { if ((this._c[id] || 0) < n) this._c[id] = n; }, async reserveAt(id, s, c) { this._c[id] = s + c; return { start: s, count: c }; } } : counterSource;
  await addMint(url);
  const m = mintOf(url);
  const totals = {};
  for (const unit of m.units || ['sat']) {
    const w = await walletFor(url, unit, seed, tmpCounters);
    let found = [];
    for (const ks of w.keyChain.getKeysets()) {
      if (ks.unit !== unit) continue;
      log(`scan ${unit} keyset ${ks.id.slice(0, 12)}…`);
      try {
        await w.keyChain.ensureKeysetKeys(ks.id);
        const { proofs, lastCounterWithSignature } = await w.batchRestore(100, undefined, 0, ks.id);
        if (lastCounterWithSignature != null) await tmpCounters.advanceToAtLeast(ks.id, lastCounterWithSignature + 1);
        found = found.concat(proofs);
      } catch (e) { log(`skip ${ks.id.slice(0, 12)}: ${e.message || e}`); }
    }
    if (!found.length) continue;
    const g = await w.groupProofsByState(found);
    let mine = g.unspent;
    if (foreign && mine.length) { log('re-keying to this wallet…'); mine = await (await walletFor(url, unit)).receive(mine); }
    // count only ecash this wallet didn't already hold (running a restore twice, or after loading a
    // backup file, mustn't add the same money to the history again)
    const held = new Set(getProofs(url, unit).map((p) => p.secret));
    const fresh = mine.filter((p) => !held.has(p.secret));
    addProofs(url, mine, unit);
    const amt = sum(fresh);
    if (amt) { H({ kind: 'ecash-in', amount: amt, unit, mint: url, status: 'done', memo: 'restored from seed' }); log(`found ${fmt(amt, unit)}`); }
    totals[unit] = (totals[unit] || 0) + amt;
  }
  return totals;
}
// move every balance onto fresh outputs (used after generating a new seed)
export async function rekeyAll(log = () => {}) {
  for (const m of S.mints) for (const unit of m.units || ['sat']) {
    const p = getProofs(m.url, unit); if (!p.length) continue;
    log(`re-keying ${fmt(sum(p), unit)} at ${host(m.url)}`);
    const w = await walletFor(m.url, unit);
    const fresh = await w.receive(p);
    setProofs(m.url, fresh, unit);
  }
}
export async function releasePending() {
  let n = 0;
  for (const h of S.history) if ((h.kind === 'ln-out' || h.kind === 'chain-out') && h.status === 'pending' && h.inflight) {
    const proofs = deserializeProofs(h.inflight);
    let unspent = proofs;
    try { unspent = (await (await walletFor(h.mint, h.unit)).groupProofsByState(proofs)).unspent; } catch { continue; } // can't reach the mint: don't guess
    if (unspent.length < proofs.length) continue; // the mint is still paying (or paid): leave it to settle
    addProofs(h.mint, unspent, h.unit); delete h.inflight; h.status = 'failed'; n++;
  }
  save();
  return n;
}
export async function settleAll({ invoices = true, sent = true, all = false } = {}) {
  const twoWeeks = Date.now() - 14 * 864e5;
  const list = S.history.filter((x) => (x.status === 'pending' || x.live) && (all ? x.ts > twoWeeks : true)).slice(0, all ? 60 : 25);
  for (const h of list) {
    try {
      if ((h.kind === 'ln-in' || h.kind === 'chain-in') && invoices) await checkInvoice(h);
      else if (h.kind === 'ln-out' || h.kind === 'chain-out') await settleMelt(h);
      else if (h.kind === 'ecash-out' && sent) await checkClaimed(h);
    } catch {}
  }
}
// fiat price: refreshed every 30 s while the app is on screen and again when you come back to it
let priceAt = 0;
export const priceAge = () => Date.now() - priceAt;
export async function loadPrice() {
  if (!S.settings.fiat) return false;
  const cur = S.settings.fiatCur;
  try {
    const r = await (await fetch(`https://api.coinbase.com/v2/prices/BTC-${cur}/spot`)).json();
    const p = parseFloat(r?.data?.amount);
    priceAt = Date.now();
    if (p > 0 && p !== S.price[cur]) { S.price[cur] = p; save(); return true; }
  } catch {}
  return false;
}
export async function auditInfo(url) {
  const api = S.settings.auditorApi.replace(/\/+$/, '');
  const r = await fetch(`${api}/mints/url?url=${encodeURIComponent(url)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('auditor error ' + r.status);
  const m = await r.json();
  if (!m) return null;
  let swaps = [];
  try { swaps = await (await fetch(`${api}/swaps/mint/${m.id}?skip=0&limit=50`)).json(); } catch {}
  return { ...m, swaps: Array.isArray(swaps) ? swaps : [] };
}
export { getEncodedToken };
