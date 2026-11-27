// Nostr features: signers, relays, inbox (NIP-17/NIP-04), payment requests (NUT-18),
// npub.cash Lightning address, Nostr Wallet Connect (NIP-47), mint discovery and
// reviews (NIP-87), web of trust, and mint list backup. Formats match cashu.me.
import {
  SimplePool, finalizeEvent, getPublicKey, generateSecretKey, nip19, nip04, nip44, nip17, nip98,
} from 'nostr-tools';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { PaymentRequest, PaymentRequestTransportType, decodePaymentRequest, getEncodedToken, getTokenMetadata, normalizeProofAmounts } from '@cashu/cashu-ts';
import { S, save, bal, total, mintOf, host, normUrl, fmt } from './store.js';
import * as C from './core.js';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const now = () => Math.floor(Date.now() / 1000);

/* ---------------- state ---------------- */
S.nostr = Object.assign({ relays: [...DEFAULT_RELAYS], signer: 'seed', nsec: '', bunker: null, lastDM: 0, seenDM: [], wot: null, backup: false, backupTs: 0 }, S.nostr || {});
S.npc = Object.assign({ enabled: false, host: 'npub.cash', address: '', mint: '', auto: true, showOnReceive: true, lastCheck: 0 }, S.npc || {});
S.pr = Object.assign({ enabled: false, auto: true, requests: [] }, S.pr || {});
S.nwc = Object.assign({ enabled: false, conn: null, seen: [] }, S.nwc || {});
const N = S.nostr;
const events = new EventTarget();
export const on = (name, f) => events.addEventListener(name, (e) => f(e.detail));
const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }));

export const pool = new SimplePool();
export const relays = () => (N.relays.length ? N.relays : DEFAULT_RELAYS);

/* ---------------- keys + signers ---------------- */
export const seedSk = () => C.seedNostrSk();
export const seedPk = () => { const sk = seedSk(); return sk ? getPublicKey(sk) : ''; };
export const nprofile = () => nip19.nprofileEncode({ pubkey: seedPk(), relays: relays().slice(0, 3) });

let signerCache = null;
export async function signer() {
  if (signerCache) return signerCache;
  if (N.signer === 'nsec' && N.nsec) {
    const sk = hexToBytes(N.nsec);
    signerCache = { type: 'nsec', sk, pubkey: getPublicKey(sk), sign: async (t) => finalizeEvent(t, sk) };
  } else if (N.signer === 'nip07' && window.nostr) {
    const pk = await window.nostr.getPublicKey();
    signerCache = { type: 'nip07', pubkey: pk, sign: (t) => window.nostr.signEvent(t) };
  } else if (N.signer === 'nip46' && N.bunker) {
    const bp = await parseBunkerInput(N.bunker.uri);
    if (!bp) throw new Error('invalid bunker URI');
    const bs = BunkerSigner.fromBunker(hexToBytes(N.bunker.clientSk), bp, { pool });
    await bs.connect().catch(() => {});
    const pk = await bs.getPublicKey();
    signerCache = { type: 'nip46', pubkey: pk, sign: (t) => bs.signEvent(t) };
  } else {
    const sk = seedSk(); if (!sk) throw new Error('wallet has no seed yet');
    signerCache = { type: 'seed', sk, pubkey: getPublicKey(sk), sign: async (t) => finalizeEvent(t, sk) };
  }
  return signerCache;
}
export function setSigner(type, data) {
  N.signer = type;
  if (type === 'nsec') {
    const d = nip19.decode(data.trim());
    if (d.type !== 'nsec') throw new Error('not an nsec');
    N.nsec = bytesToHex(d.data);
  }
  if (type === 'nip46') N.bunker = { uri: data.trim(), clientSk: bytesToHex(generateSecretKey()) };
  if (type === 'nip07' && !window.nostr) throw new Error('no NIP-07 signing extension found');
  signerCache = null; save();
  emit('signer');
}
export const npubOf = (pk) => nip19.npubEncode(pk);
export function nsecOfSigner() {
  if (N.signer === 'nsec' && N.nsec) return nip19.nsecEncode(hexToBytes(N.nsec));
  if (N.signer === 'seed' && seedSk()) return nip19.nsecEncode(seedSk());
  return '';
}
C.onSeedChange(() => { signerCache = null; });
// keys that can sign NUT-20 locked mint quotes (npub.cash locks to your nostr key)
C.setQuoteKeyProvider(() => {
  const ks = [];
  if (seedSk()) ks.push(bytesToHex(seedSk()));
  if (N.signer === 'nsec' && N.nsec) ks.push(N.nsec);
  return ks;
});

async function publish(ev, extra = []) {
  const targets = [...new Set([...relays(), ...extra])];
  const res = await Promise.allSettled(pool.publish(targets, ev));
  if (!res.some((r) => r.status === 'fulfilled')) throw new Error('no relay accepted the event');
  return ev;
}

/* ---------------- inbox: NIP-17 gift wraps + NIP-04 DMs ---------------- */
let inboxSub = null;
export function startInbox() {
  stopInbox();
  const sk = seedSk(); if (!sk) return;
  const pk = getPublicKey(sk);
  if (!N.lastDM) { N.lastDM = now(); save(); }
  const seen = new Set(N.seenDM.map((e) => e.id));
  const mark = (ev) => {
    seen.add(ev.id); N.seenDM.push({ id: ev.id, t: ev.created_at });
    const cutoff = now() - 10 * 86400; N.seenDM = N.seenDM.filter((e) => e.t > cutoff).slice(-500);
    N.lastDM = Math.max(N.lastDM, Math.min(now(), ev.created_at)); save();
  };
  inboxSub = pool.subscribeMany(relays(), { kinds: [1059, 4], '#p': [pk], since: N.lastDM - 2 * 86400 }, {
    onevent: (ev) => {
      if (seen.has(ev.id)) return;
      mark(ev);
      let content = '';
      try {
        if (ev.kind === 1059) content = nip17.unwrapEvent(ev, sk).content;
        else content = nip04.decrypt(sk, ev.pubkey, ev.content);
      } catch { return; }
      handleMessage(content).catch((e) => console.warn('inbox', e));
    },
  });
}
export function stopInbox() { try { inboxSub?.close(); } catch {} inboxSub = null; }

async function handleMessage(msg) {
  let payload = null;
  try { payload = PaymentRequest.decodePayload(msg); } catch {}
  if (payload && payload.proofs) {
    const token = getEncodedToken({ mint: payload.mint, proofs: normalizeProofAmounts(payload.proofs), unit: payload.unit || 'sat', ...(payload.memo ? { memo: payload.memo } : {}) });
    const ours = S.pr.requests.find((r) => r.id === payload.id);
    return incoming(token, ours, payload);
  }
  const toks = (msg.match(/cashu[AB][A-Za-z0-9_\-=+/]+/g) || []);
  for (const t of toks) await incoming(t, null, null);
}
function satisfies(req, t) {
  if (!req) return true;
  if (req.unit && t.unit !== req.unit) return false;
  if (req.amount && t.amount < req.amount) return false;
  if (req.mint && normUrl(req.mint) !== t.mint) return false;
  return true;
}
async function incoming(token, req, payload) {
  if (S.history.some((h) => h.token === token)) return;
  let t; try { t = C.parseToken(token); } catch { return; }
  const ok = satisfies(req, t);
  const h = C.H({ kind: 'ecash-in', amount: t.amount, unit: t.unit, mint: t.mint, status: 'pending', token, memo: payload?.memo || (req ? 'payment request' : 'nostr message'), prId: req?.id });
  if (req) { req.payments = [...(req.payments || []), h.id]; save(); }
  const known = !!mintOf(t.mint);
  if (S.pr.auto && known && ok) {
    try { await C.receiveEcash(t); emit('received', h); return; } catch (e) { console.warn(e); }
  }
  emit('incoming', h);
}

/* ---------------- payment requests (NUT-18) ---------------- */
export function createRequest({ amount, unit = S.unit, memo, mint, lock } = {}) {
  const id = Math.random().toString(16).slice(2, 10);
  let nut10;
  if (lock) { const k = C.currentP2pk() || C.newP2pkKey(); nut10 = { kind: 'P2PK', data: k.pub, tags: [] }; }
  const transport = [{ type: PaymentRequestTransportType.NOSTR, target: nprofile(), tags: [['n', '17']] }];
  const pr = new PaymentRequest(transport, id, amount || undefined, unit, mint ? [mint] : undefined, memo || undefined, false, nut10);
  const encoded = pr.toEncodedRequest();
  S.pr.requests.unshift({ id, encoded, amount: amount || 0, unit, memo: memo || '', mint: mint || '', lock: !!lock, ts: Date.now(), payments: [] });
  S.pr.requests = S.pr.requests.slice(0, 50);
  save();
  if (S.pr.enabled && !inboxSub) startInbox();
  return S.pr.requests[0];
}
export const isRequest = (s) => /^creq[ab]/i.test(s.trim());
export function decodeRequest(s) {
  const pr = decodePaymentRequest(s.trim());
  const tr = (pr.transport || []).find((t) => t.type === 'nostr' || t.type === 'post');
  return {
    raw: s.trim(), pr, id: pr.id, amount: pr.amount ? pr.amount.toNumber() : 0, unit: pr.unit || 'sat',
    mints: (pr.mints || []).map(normUrl), memo: pr.description || '', lock: pr.nut10 && pr.nut10.kind === 'P2PK' ? pr.nut10.data : '',
    transport: tr || null, ours: S.pr.requests.some((r) => r.id === pr.id),
  };
}
// create the token and deliver it over the request's transport
export async function payRequest(r, amount) {
  if (!r.transport) throw new Error('this request has no way to deliver the payment');
  if (r.mints.length && !r.mints.includes(S.active)) throw new Error('select one of the mints the request accepts');
  if (r.unit !== S.unit) throw new Error(`the request is in ${r.unit}; switch unit first`);
  const h = await C.sendEcash(amount, { memo: r.memo || 'payment request', lockTo: r.lock || undefined });
  const w = await C.walletFor(h.mint, h.unit);
  const { proofs } = w.decodeToken(h.token);
  const body = r.pr.encodePayload(h.mint, proofs, { unit: h.unit, memo: r.memo || undefined });
  try {
    if (r.transport.type === 'post') {
      const res = await fetch(r.transport.target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) throw new Error('recipient returned ' + res.status);
    } else {
      const d = nip19.decode(r.transport.target);
      const pk = d.type === 'nprofile' ? d.data.pubkey : d.data;
      const extra = d.type === 'nprofile' ? d.data.relays || [] : [];
      const ev = nip17.wrapEvent(seedSk() || generateSecretKey(), { publicKey: pk }, body);
      await publish(ev, extra);
    }
    h.status = 'pending'; h.memo = 'payment request'; save();
    return h;
  } catch (e) {
    throw new Error(`${e.message || e}. The token is saved in your history; you can reclaim it.`);
  }
}

/* ---------------- npub.cash Lightning address ---------------- */
const npcUrl = (p) => `https://${S.npc.host}${p}`;
async function npcFetch(path, opts = {}, authPath) {
  const s = await signer();
  const url = npcUrl(path);
  const authUrl = authPath ? npcUrl(authPath) : url;
  const token = await nip98.getToken(authUrl, opts.method || 'GET', (t) => s.sign(t), false);
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: `Nostr ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.message || `npub.cash error ${r.status}`);
  return j;
}
export async function npcRefresh() {
  const s = await signer();
  const h = S.npc.host;
  S.npc.address = npubOf(s.pubkey) + '@' + h;
  const info = await npcFetch('/api/v2/user/info');
  const u = info.data.user;
  if (u.name) S.npc.address = u.name + '@' + h;
  if (u.mintUrl && mintOf(normUrl(u.mintUrl))) S.npc.mint = normUrl(u.mintUrl);
  else if (S.active) await npcSetMint(S.active);
  save();
  return S.npc;
}
export async function npcSetMint(url) {
  const j = await npcFetch('/api/v2/user/mint', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mint_url: url }) });
  S.npc.mint = normUrl(j.data.user.mintUrl || url); save();
}
let npcBusy = false;
export async function npcSync() {
  if (!S.npc.enabled || npcBusy) return 0;
  npcBusy = true;
  let added = 0;
  try {
    let offset = 0, totalQ = 0, latest = 0;
    do {
      const q = new URLSearchParams({ limit: '50', offset: String(offset) });
      if (S.npc.lastCheck) q.set('since', String(Math.max(0, S.npc.lastCheck - 1)));
      const j = await npcFetch('/api/v2/wallet/quotes?' + q, {}, '/api/v2/wallet/quotes');
      const page = j.data.quotes || [];
      totalQ = j.metadata?.total || 0; offset += page.length;
      for (const qt of page) {
        latest = Math.max(latest, qt.paidAt || qt.createdAt || 0);
        const mint = normUrl(qt.mintUrl);
        if (S.history.some((h) => h.quote === qt.quoteId && h.mint === mint)) continue;
        if (!mintOf(mint)) await C.addMint(mint).catch(() => {});
        const h = C.H({ kind: 'ln-in', amount: qt.amount, unit: 'sat', mint, status: 'pending', quote: qt.quoteId, request: qt.request, expiry: qt.expiresAt, memo: 'Lightning address' });
        added++;
        if (S.npc.auto) { const st = await C.checkInvoice(h).catch(() => 'pending'); if (st === 'done') emit('received', h); }
      }
      if (!page.length) break;
    } while (offset < totalQ);
    if (latest) { S.npc.lastCheck = latest; save(); }
  } finally { npcBusy = false; }
  return added;
}

/* ---------------- Nostr Wallet Connect (NIP-47) ---------------- */
const NWC_METHODS = ['pay_invoice', 'make_invoice', 'get_balance', 'get_info', 'list_transactions', 'lookup_invoice'];
let nwcSub = null;
export function nwcNewConnection(allowance = 1000) {
  const wsk = generateSecretKey(), csk = generateSecretKey();
  S.nwc.conn = { walletSk: bytesToHex(wsk), walletPk: getPublicKey(wsk), secret: bytesToHex(csk), clientPk: getPublicKey(csk), allowance, allowanceLeft: allowance, created: Date.now() };
  S.nwc.seen = []; save();
  return S.nwc.conn;
}
export const nwcString = (c = S.nwc.conn) => c ? `nostr+walletconnect://${c.walletPk}?${relays().map((r) => 'relay=' + encodeURIComponent(r)).join('&')}&secret=${c.secret}` : '';
export async function startNwc() {
  stopNwc();
  const c = S.nwc.conn; if (!S.nwc.enabled || !c) return;
  const wsk = hexToBytes(c.walletSk);
  try {
    const info = finalizeEvent({ kind: 13194, created_at: now(), content: NWC_METHODS.join(' '), tags: [['encryption', 'nip44_v2 nip04']] }, wsk);
    await publish(info);
  } catch (e) { console.warn('nwc info', e); }
  const seen = new Set(S.nwc.seen);
  nwcSub = pool.subscribeMany(relays(), { kinds: [23194], authors: [c.clientPk], '#p': [c.walletPk], since: now() - 3600 }, {
    onevent: async (ev) => {
      if (!S.nwc.enabled || seen.has(ev.id)) return;
      seen.add(ev.id); S.nwc.seen = [...seen].slice(-300); save();
      const enc = (ev.tags.find((t) => t[0] === 'encryption') || [])[1] === 'nip44_v2' ? 'nip44' : 'nip04';
      let cmd;
      try {
        const txt = enc === 'nip44' ? nip44.decrypt(ev.content, nip44.getConversationKey(wsk, ev.pubkey)) : nip04.decrypt(wsk, ev.pubkey, ev.content);
        cmd = JSON.parse(txt);
      } catch { return; }
      let res;
      try { res = await nwcHandle(cmd); } catch (e) { res = { result_type: cmd.method, error: { code: 'INTERNAL', message: String(e.message || e) } }; }
      const body = JSON.stringify(res);
      const content = enc === 'nip44' ? nip44.encrypt(body, nip44.getConversationKey(wsk, ev.pubkey)) : nip04.encrypt(wsk, ev.pubkey, body);
      const tags = [['p', ev.pubkey], ['e', ev.id]]; if (enc === 'nip44') tags.push(['encryption', 'nip44_v2']);
      await publish(finalizeEvent({ kind: 23195, created_at: now(), content, tags }, wsk)).catch((e) => console.warn('nwc reply', e));
      emit('nwc', { cmd, res });
    },
  });
}
export function stopNwc() { try { nwcSub?.close(); } catch {} nwcSub = null; }
const payHash = (inv) => { try { return decodeBolt11(inv).sections.find((s) => s.name === 'payment_hash')?.value; } catch { return undefined; } };
function nwcTx(h) {
  return {
    type: h.kind === 'ln-in' ? 'incoming' : 'outgoing', invoice: h.request || '', description: h.memo || '', payment_hash: h.request ? payHash(h.request) : undefined,
    preimage: h.preimage || undefined, amount: h.amount * 1000, fees_paid: (h.fee || 0) * 1000,
    created_at: Math.floor(h.ts / 1000), settled_at: h.status === 'done' ? Math.floor(h.ts / 1000) : null, expires_at: h.expiry || undefined,
  };
}
async function nwcHandle(cmd) {
  const m = cmd.method, p = cmd.params || {}, c = S.nwc.conn;
  const err = (code, message) => ({ result_type: m, error: { code, message } });
  if (m === 'get_info') return { result_type: m, result: { alias: 'blindsig', color: '#72d99b', pubkey: c.walletPk, network: 'mainnet', block_height: 1, block_hash: '', methods: NWC_METHODS } };
  if (m === 'get_balance') return { result_type: m, result: { balance: total('sat') * 1000 } };
  if (m === 'pay_invoice') {
    if (!S.active) return err('INTERNAL', 'no active mint');
    const q = await C.quoteInvoice(String(p.invoice).toLowerCase(), S.active, 'sat');
    const need = q.amount.toNumber() + q.fee_reserve.toNumber();
    if (need > c.allowanceLeft) return err('QUOTA_EXCEEDED', `allowance left: ${c.allowanceLeft} sat`);
    if (need > bal(S.active, 'sat')) return err('INSUFFICIENT_BALANCE', 'not enough balance at the active mint');
    const h = await C.payInvoice(q, 'Nostr Wallet Connect', S.active, 'sat');
    if (h.status !== 'done') return err('INTERNAL', 'payment pending');
    c.allowanceLeft = Math.max(0, c.allowanceLeft - h.amount - (h.fee || 0)); save();
    return { result_type: m, result: { preimage: h.preimage || '', fees_paid: (h.fee || 0) * 1000 } };
  }
  if (m === 'make_invoice') {
    if (!S.active) return err('INTERNAL', 'no active mint');
    const sats = Math.floor(Number(p.amount) / 1000);
    if (!sats) return err('OTHER', 'amount required');
    const h = await C.createInvoice(sats, S.active, 'sat', p.description || 'Nostr Wallet Connect');
    watchInvoice(h);
    return { result_type: m, result: nwcTx(h) };
  }
  if (m === 'list_transactions') {
    const from = p.from || 0, until = p.until || now(), lim = p.limit || 10, off = p.offset || 0;
    const list = S.history.filter((h) => h.kind.startsWith('ln') && h.unit === 'sat')
      .filter((h) => { const t = h.ts / 1000; return t >= from && t <= until; })
      .filter((h) => !p.type || (p.type === 'incoming') === (h.kind === 'ln-in'))
      .filter((h) => p.unpaid || h.status === 'done')
      .slice(off, off + lim).map(nwcTx);
    return { result_type: m, result: { transactions: list } };
  }
  if (m === 'lookup_invoice') {
    const hash = p.payment_hash || (p.invoice ? payHash(p.invoice) : null);
    const h = S.history.find((x) => x.request && (x.request === p.invoice || payHash(x.request) === hash));
    return h ? { result_type: m, result: nwcTx(h) } : err('NOT_FOUND', 'invoice not found');
  }
  return err('NOT_IMPLEMENTED', 'method not supported');
}
export function watchInvoice(h, ms = 15 * 60e3) {
  const end = Date.now() + ms;
  const tick = async () => {
    if (h.status !== 'pending' || Date.now() > end) return;
    try { const s = await C.checkInvoice(h); if (s === 'done') { emit('received', h); return; } } catch {}
    setTimeout(tick, 4000);
  };
  setTimeout(tick, 2500);
}

/* ---------------- mint discovery + reviews (NIP-87) ---------------- */
const parseReview = (content) => {
  const m = (content || '').match(/^\s*\[(\d)\s*\/\s*5\]\s*([\s\S]*)$/);
  if (!m) return { rating: null, comment: content || '' };
  const r = parseInt(m[1], 10);
  return { rating: r >= 1 && r <= 5 ? r : null, comment: m[2].trim() };
};
const uTag = (ev) => ev.tags.filter((t) => t[0] === 'u' && t[1] && (t[2] === 'cashu' || t.length >= 2)).map((t) => normUrl(t[1]));
export async function discoverMints() {
  const [ann, recs] = await Promise.all([
    pool.querySync(relays(), { kinds: [38172], limit: 2000 }, { maxWait: 6000 }),
    pool.querySync(relays(), { kinds: [38000], '#k': ['38172'], limit: 3000 }, { maxWait: 6000 }),
  ]);
  const map = new Map();
  const get = (url) => { if (!map.has(url)) map.set(url, { url, reviews: [], announced: false, info: null }); return map.get(url); };
  for (const ev of ann) for (const u of uTag(ev)) { if (!/^https?:\/\//.test(u)) continue; const m = get(u); m.announced = true; try { m.info = ev.content ? JSON.parse(ev.content) : m.info; } catch {} }
  const latest = new Map(); // one review per author per mint
  for (const ev of recs) for (const u of uTag(ev)) {
    if (!/^https?:\/\//.test(u)) continue;
    const k = ev.pubkey + '|' + u;
    if (!latest.has(k) || latest.get(k).created_at < ev.created_at) latest.set(k, { ...ev, _u: u });
  }
  for (const ev of latest.values()) {
    const { rating, comment } = parseReview(ev.content);
    get(ev._u).reviews.push({ pubkey: ev.pubkey, rating, comment, at: ev.created_at });
  }
  const wot = N.wot ? new Set(N.wot.pubkeys) : null;
  return [...map.values()].map((m) => {
    const rs = m.reviews.filter((r) => r.rating), wr = wot ? m.reviews.filter((r) => wot.has(r.pubkey)) : [];
    return { ...m, count: m.reviews.length, avg: rs.length ? rs.reduce((a, r) => a + r.rating, 0) / rs.length : 0, wotCount: wr.length };
  }).sort((a, b) => b.wotCount - a.wotCount || b.count - a.count || b.avg - a.avg);
}
export async function mintReviews(url) {
  const all = await discoverMintsFor(url);
  const wot = N.wot ? new Set(N.wot.pubkeys) : null;
  return all.map((r) => ({ ...r, trusted: wot ? wot.has(r.pubkey) : false })).sort((a, b) => b.at - a.at);
}
async function discoverMintsFor(url) {
  const evs = await pool.querySync(relays(), { kinds: [38000], '#k': ['38172'], '#u': [url, url + '/'], limit: 500 }, { maxWait: 5000 });
  const latest = new Map();
  for (const ev of evs) if (!latest.has(ev.pubkey) || latest.get(ev.pubkey).created_at < ev.created_at) latest.set(ev.pubkey, ev);
  return [...latest.values()].map((ev) => ({ pubkey: ev.pubkey, ...parseReview(ev.content), at: ev.created_at }));
}
export async function publishReview(url, rating, text) {
  const s = await signer();
  let content = ''; if (rating) content += `[${rating}/5]`; if (text) content += (content ? ' ' : '') + text.trim();
  const tags = [['k', '38172'], ['u', url, 'cashu']];
  const m = mintOf(url); if (m?.pubkey) tags.push(['d', m.pubkey]);
  const ev = await s.sign({ kind: 38000, created_at: now(), content, tags });
  return publish(ev);
}

/* ---------------- web of trust ---------------- */
export async function buildWot(rootNpubOrHex, onProgress = () => {}) {
  let root = rootNpubOrHex?.trim();
  if (!root) root = (await signer()).pubkey;
  else if (root.startsWith('npub')) root = nip19.decode(root).data;
  const contacts = async (authors) => {
    const evs = await pool.querySync(relays(), { kinds: [3], authors }, { maxWait: 6000 });
    const latest = new Map();
    for (const e of evs) if (!latest.has(e.pubkey) || latest.get(e.pubkey).created_at < e.created_at) latest.set(e.pubkey, e);
    return [...latest.values()].flatMap((e) => e.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]));
  };
  const hop1 = [...new Set(await contacts([root]))];
  onProgress(`${hop1.length} follows`);
  const set = new Set([root, ...hop1]);
  for (let i = 0; i < hop1.length && set.size < 20000; i += 150) {
    (await contacts(hop1.slice(i, i + 150))).forEach((p) => set.add(p));
    onProgress(`${Math.min(i + 150, hop1.length)} / ${hop1.length} · ${set.size} keys`);
  }
  N.wot = { root, pubkeys: [...set].slice(0, 20000), updated: Date.now() }; save();
  return N.wot.pubkeys.length;
}

/* ---------------- mint list backup (kind 30078, same as cashu.me) ---------------- */
function backupKeys(mnemonic = S.mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  const sep = new TextEncoder().encode('cashu-mint-backup');
  const buf = new Uint8Array(seed.length + sep.length); buf.set(seed); buf.set(sep, seed.length);
  const sk = sha256(buf);
  return { sk, pk: getPublicKey(sk) };
}
export async function backupMints() {
  if (!N.backup || !S.mnemonic || !S.mints.length) return false;
  const { sk, pk } = backupKeys();
  const ts = now();
  const content = nip44.encrypt(JSON.stringify({ mints: S.mints.map((m) => m.url), timestamp: ts }), nip44.getConversationKey(sk, pk));
  await publish(finalizeEvent({ kind: 30078, created_at: ts, content, tags: [['d', 'mint-list'], ['client', 'cashu.me']] }, sk));
  N.backupTs = ts; save();
  return true;
}
export async function findBackedUpMints(mnemonic = S.mnemonic) {
  const { sk, pk } = backupKeys(mnemonic);
  const evs = await pool.querySync(relays(), { kinds: [30078], authors: [pk], '#d': ['mint-list'], limit: 10 }, { maxWait: 6000 });
  const urls = new Set();
  for (const ev of evs) { try { JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(sk, pk))).mints.forEach((u) => urls.add(normUrl(u))); } catch {} }
  return [...urls];
}

/* ---------------- lifecycle ---------------- */
let npcTimer = null;
export function startAll() {
  if (!S.mnemonic) return;
  if (S.pr.enabled) startInbox(); else stopInbox();
  if (S.nwc.enabled) startNwc(); else stopNwc();
  clearInterval(npcTimer);
  if (S.npc.enabled) { npcSync().catch(() => {}); npcTimer = setInterval(() => { if (!document.hidden) npcSync().catch(() => {}); }, 45000); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.npc.enabled) npcSync().catch(() => {}); });
export { fmt, host, getTokenMetadata };
