// Nostr wallet sync (NIP-60): your ecash, encrypted to your nostr key, kept on your relays so other
// Nostr apps that support NIP-60 can use the same wallet (and you can pick it up on another device).
//
// This wallet stays the source of truth. For each mint and unit we publish token events (kind
// 7375) holding exactly the ecash held here; when that changes, new events replace the old ones,
// which are deleted (kind 5) and named in `del`. A spending-history event (kind 7376) records each
// change. On a sync we read every live token event: ecash another app added is checked with the
// mint and taken in, and ecash another app spent (our events were replaced by someone else) is
// checked with the mint and dropped here. The wallet event (kind 17375) carries the mint list and
// the private key nutzaps are locked to (NIP-61), so both apps can redeem them.
import { normalizeProofAmounts } from '@cashu/cashu-ts';
import { S, save, getProofs, setProofs, addProofs, sum, mintOf, fmt, normUrl } from './store.js';
import * as C from './core.js';
import * as N from './nostr.js';

S.nip60 = Object.assign({ enabled: false, events: {}, sig: {}, bal: {}, lastSync: 0, lastError: '' }, S.nip60 || {});
const W = S.nip60;
const now = () => Math.floor(Date.now() / 1000);
const CHUNK = 100; // proofs per token event: keeps events well under relay size limits
const k2 = (url, unit) => `${url}|${unit}`;
const split = (key) => { const i = key.lastIndexOf('|'); return [key.slice(0, i), key.slice(i + 1)]; };
const num = (a) => (a && typeof a === 'object' && a.toNumber ? a.toNumber() : Number(a));
const plain = (p) => ({ id: p.id, amount: num(p.amount), secret: p.secret, C: p.C, ...(p.witness ? { witness: typeof p.witness === 'string' ? p.witness : JSON.stringify(p.witness) } : {}) });
// what this wallet holds for a mint and unit, as a fingerprint (order doesn't matter)
const fingerprint = (proofs) => proofs.map((p) => p.secret).sort().join(',');
const localKeys = () => Object.entries(S.proofs).filter(([, a]) => a && a.length).map(([k]) => k);

const listeners = new Set();
export const onChange = (f) => listeners.add(f);
const changed = (info) => listeners.forEach((f) => { try { f(info); } catch {} });

export const isOn = () => !!W.enabled;

/* ---------------- reading ---------------- */
async function fetchLive(sg) {
  const rs = N.relays();
  const [tok, del, wal] = await Promise.all([
    N.pool.querySync(rs, { kinds: [7375], authors: [sg.pubkey] }, { maxWait: 6000 }),
    N.pool.querySync(rs, { kinds: [5], authors: [sg.pubkey], '#k': ['7375'] }, { maxWait: 6000 }),
    N.pool.querySync(rs, { kinds: [17375], authors: [sg.pubkey] }, { maxWait: 6000 }),
  ]);
  const gone = new Set();
  for (const ev of del) for (const t of ev.tags) if (t[0] === 'e' && t[1]) gone.add(t[1]);
  const seen = new Set(), live = [];
  for (const ev of tok) {
    if (seen.has(ev.id) || gone.has(ev.id)) continue;
    seen.add(ev.id);
    let d; try { d = JSON.parse(await sg.dec(ev.content)); } catch { continue; } // not ours to read
    if (!d || !d.mint || !Array.isArray(d.proofs)) continue;
    (d.del || []).forEach((id) => gone.add(id));
    live.push({ id: ev.id, at: ev.created_at, mint: normUrl(d.mint), unit: d.unit || 'sat', proofs: d.proofs });
  }
  const wallet = wal.sort((a, b) => b.created_at - a.created_at)[0] || null;
  return { live: live.filter((e) => !gone.has(e.id)), wallet };
}
async function readWallet(sg, ev) {
  if (!ev) return null;
  let tags = [];
  try { tags = JSON.parse(await sg.dec(ev.content)); } catch {}
  if (!Array.isArray(tags)) tags = [];
  const all = [...tags, ...ev.tags];
  return {
    privkey: (all.find((t) => t[0] === 'privkey') || [])[1] || '',
    mints: [...new Set(all.filter((t) => t[0] === 'mint' && t[1]).map((t) => normUrl(t[1])))],
  };
}

/* ---------------- writing ---------------- */
async function publishWallet(sg, remote) {
  const nz = N.nutzapKey();
  const mints = [...new Set([...S.mints.map((m) => m.url), ...((remote && remote.mints) || [])])];
  const content = await sg.enc(JSON.stringify([['privkey', nz.priv], ...mints.map((u) => ['mint', u])]));
  await N.publish(await sg.sign({ kind: 17375, created_at: now(), tags: [], content }));
}
// replace the events for one mint+unit with what this wallet holds now
async function publishKey(sg, key, oldIds) {
  const [url, unit] = split(key);
  const proofs = getProofs(url, unit);
  const ids = [];
  for (let i = 0; i < proofs.length; i += CHUNK) {
    const content = await sg.enc(JSON.stringify({ mint: url, unit, proofs: proofs.slice(i, i + CHUNK).map(plain), del: oldIds }));
    const ev = await N.publish(await sg.sign({ kind: 7375, created_at: now(), tags: [], content }));
    ids.push(ev.id);
  }
  if (oldIds.length) {
    await N.publish(await sg.sign({ kind: 5, created_at: now(), content: '', tags: [...oldIds.map((id) => ['e', id]), ['k', '7375']] })).catch(() => {});
  }
  const before = W.bal[key] || 0, after = sum(proofs);
  if (after !== before) {
    const rows = [['direction', after > before ? 'in' : 'out'], ['amount', String(Math.abs(after - before))], ['unit', unit], ...ids.map((id) => ['e', id, '', 'created']), ...oldIds.map((id) => ['e', id, '', 'destroyed'])];
    N.publish(await sg.sign({ kind: 7376, created_at: now(), tags: [], content: await sg.enc(JSON.stringify(rows)) })).catch(() => {});
  }
  if (ids.length) W.events[key] = ids; else delete W.events[key];
  W.sig[key] = fingerprint(proofs);
  if (after) W.bal[key] = after; else delete W.bal[key];
  save();
}

/* ---------------- sync ---------------- */
let running = null;
// full sync: take in what other apps changed, then publish what this wallet holds
export function sync() {
  if (!W.enabled) return Promise.resolve(null);
  if (running) return running;
  running = doSync().finally(() => { running = null; });
  return running;
}
async function doSync() {
  const sg = await N.signer();
  if (!sg.enc) throw new Error('this signer can’t encrypt wallet data');
  const { live, wallet } = await fetchLive(sg);
  const remote = await readWallet(sg, wallet);
  // another app made the wallet first: use its nutzap key too, so nutzaps to either still arrive
  if (remote && remote.privkey && !S.p2pk.some((k) => k.priv === remote.privkey)) {
    const k = C.newP2pkKey(remote.privkey);
    S.p2pk.forEach((x) => { if (x !== k && x.nutzap) delete x.nutzap; });
    k.nutzap = true; k.used = true; save();
    N.nutzapRefreshInfo().catch(() => {});
  }
  const byKey = {};
  for (const e of live) (byKey[k2(e.mint, e.unit)] ||= []).push(e);
  const report = { added: 0, spent: 0, skipped: [] };
  const keys = new Set([...Object.keys(byKey), ...localKeys(), ...Object.keys(W.events)]);
  for (const key of keys) {
    const [url, unit] = split(key);
    const evs = byKey[key] || [];
    const liveIds = new Set(evs.map((e) => e.id));
    const mine = W.events[key] || [];
    const taken = mine.some((id) => !liveIds.has(id)); // someone else replaced our events
    const local = getProofs(url, unit), have = new Set(local.map((p) => p.secret));
    const remoteProofs = new Map();
    for (const e of evs) for (const p of e.proofs) if (p && p.secret) remoteProofs.set(p.secret, p);
    const foreign = [...remoteProofs.values()].filter((p) => !have.has(p.secret));
    const others = evs.some((e) => !mine.includes(e.id)); // events another app wrote
    try {
      if (foreign.length || taken || others) {
        if (!mintOf(url)) await C.addMint(url);
        const w = await C.walletFor(url, unit);
        if (foreign.length) {
          const g = await w.groupProofsByState(normalizeProofAmounts(foreign));
          if (g.pending.length) { report.skipped.push(key); continue; } // in flight elsewhere: wait
          if (g.unspent.length) {
            addProofs(url, g.unspent, unit);
            const amt = sum(g.unspent); report.added += unit === 'sat' ? amt : 0;
            C.H({ kind: 'ecash-in', amount: amt, unit, mint: url, status: 'done', memo: 'from your Nostr wallet', sync: true });
          }
        }
        // another app has been at this mint's ecash: whatever it spent is gone here too
        const held = getProofs(url, unit);
        if (held.length) {
          const g = await w.groupProofsByState(held);
          if (g.spent.length) {
            const sp = new Set(g.spent.map((p) => p.secret));
            setProofs(url, held.filter((p) => !sp.has(p.secret)), unit);
            const amt = sum(g.spent); report.spent += unit === 'sat' ? amt : 0;
            C.H({ kind: 'ecash-out', amount: amt, unit, mint: url, status: 'done', memo: 'spent in another Nostr app', sync: true });
          }
        }
      }
      const cur = fingerprint(getProofs(url, unit));
      if (others || taken || W.sig[key] !== cur) await publishKey(sg, key, evs.map((e) => e.id));
    } catch (e) {
      console.warn('nip60', key, e);
      report.skipped.push(key);
    }
  }
  if (!wallet || !remote || !remote.privkey || W.mintsSig !== S.mints.map((m) => m.url).join()) {
    await publishWallet(sg, remote);
    W.mintsSig = S.mints.map((m) => m.url).join();
  }
  W.lastSync = Date.now(); W.lastError = ''; save();
  changed(report);
  return report;
}
// light check between syncs: publish any mint+unit whose ecash changed here
let pushing = null;
export function push() {
  if (!W.enabled || running || pushing) return pushing || running;
  const dirty = [...new Set([...localKeys(), ...Object.keys(W.events)])].filter((key) => { const [u, n] = split(key); return W.sig[key] !== fingerprint(getProofs(u, n)); });
  if (!dirty.length) return null;
  pushing = (async () => {
    const sg = await N.signer();
    for (const key of dirty) await publishKey(sg, key, W.events[key] || []);
  })().catch((e) => { W.lastError = e.message || String(e); save(); }).finally(() => { pushing = null; });
  return pushing;
}

/* ---------------- on / off ---------------- */
let timers = [];
export function start() {
  stop();
  if (!W.enabled || !S.mnemonic) return;
  const safeSync = () => sync().catch((e) => { W.lastError = e.message || String(e); save(); changed({ error: W.lastError }); });
  safeSync();
  timers.push(setInterval(() => { if (!document.hidden) push(); }, 15000));
  timers.push(setInterval(() => { if (!document.hidden) safeSync(); }, 5 * 60e3));
  onVis = () => { if (!document.hidden) safeSync(); };
  document.addEventListener('visibilitychange', onVis);
}
let onVis = null;
export function stop() {
  timers.forEach(clearInterval); timers = [];
  if (onVis) document.removeEventListener('visibilitychange', onVis); onVis = null;
}
export async function enable(on) {
  if (on) {
    const sg = await N.signer();
    if (!sg.enc) throw new Error('This signer can’t encrypt wallet data. Use your seed, an nsec, or a signer that supports NIP-44.');
    W.enabled = true; save();
    try { await sync(); } catch (e) { W.enabled = false; save(); throw e; }
    start();
  } else {
    W.enabled = false; save(); stop();
  }
}
N.onLifecycle(() => start(), () => stop());
// a different nostr key means a different wallet on the relays: start over with it
N.on('signer', () => { if (!W.enabled) return; W.events = {}; W.sig = {}; W.bal = {}; W.mintsSig = ''; save(); start(); });
export const summary = () => ({ total: Object.entries(W.bal).filter(([k]) => k.endsWith('|sat')).reduce((t, [, v]) => t + v, 0), events: Object.values(W.events).flat().length, fmt });
