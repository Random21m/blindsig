import {
  Wallet,
  getEncodedToken,
  getTokenMetadata,
  sumProofs,
  serializeProofs,
  deserializeProofs,
} from '@cashu/cashu-ts';
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bech32 } from '@scure/base';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

/* ================= state ================= */
const KEY = 'blindsig.v1';
const VERSION = '1.0.0';
const SUGGESTED = [
  { url: 'https://testnut.cashu.space', note: 'test mint // fake sats, invoices auto-pay' },
  { url: 'https://mint.minibits.cash/Bitcoin', note: 'minibits // real sats' },
  { url: 'https://mint.coinos.io', note: 'coinos // real sats' },
];
const blank = () => ({ mnemonic: null, counters: {}, mints: [], active: null, proofs: {}, history: [], fiat: true, price: null });
let S;
try { S = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY)) || {}); } catch { S = blank(); }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('err: could not save // ' + e.message); } };

const getProofs = (url) => { const a = S.proofs[url]; return a && a.length ? deserializeProofs(a) : []; };
const setProofs = (url, p) => { S.proofs[url] = p.length ? serializeProofs(p) : []; save(); };
const addProofs = (url, p) => {
  const have = getProofs(url), seen = new Set(have.map((x) => x.secret));
  setProofs(url, [...have, ...p.filter((x) => !seen.has(x.secret))]);
};
const sum = (p) => (p.length ? sumProofs(p).toNumber() : 0);
const bal = (url) => sum(getProofs(url));
const total = () => S.mints.reduce((t, m) => t + bal(m.url), 0);
const mintOf = (url) => S.mints.find((m) => m.url === url);
const host = (url) => { try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); } catch { return url; } };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normUrl = (u) => { u = u.trim().replace(/\/+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return u; };

/* ================= seed + counters ================= */
let SEED = S.mnemonic ? mnemonicToSeedSync(S.mnemonic) : null;
const counterSource = {
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

/* ================= mint connections ================= */
const wallets = new Map();
function walletFor(url) {
  if (!wallets.has(url)) {
    const p = (async () => {
      const w = new Wallet(url, { unit: 'sat', bip39seed: SEED, counterSource });
      await w.loadMint();
      return w;
    })();
    wallets.set(url, p);
    p.catch(() => wallets.delete(url));
  }
  return wallets.get(url);
}
async function addMint(url) {
  url = normUrl(url);
  if (mintOf(url)) { S.active = url; save(); return url; }
  const w = await walletFor(url);
  const info = w.getMintInfo();
  S.mints.push({ url, name: info.name || host(url), pubkey: info.pubkey || '' });
  if (!S.active) S.active = url;
  save();
  try { navigator.storage?.persist?.(); } catch {}
  return url;
}

/* ================= money flows ================= */
const busy = new Set();
const H = (o) => { const h = { id: uid(), ts: Date.now(), ...o }; S.history.unshift(h); save(); return h; };

async function createInvoice(amount, url = S.active, memo) {
  const w = await walletFor(url);
  const q = await w.createMintQuoteBolt11(amount);
  return H({ kind: 'ln-in', amount, mint: url, status: 'pending', quote: q.quote, request: q.request, expiry: q.expiry, memo });
}
async function checkInvoice(h) {
  if (h.status !== 'pending' || busy.has(h.id)) return h.status;
  busy.add(h.id);
  try {
    const w = await walletFor(h.mint);
    const q = await w.checkMintQuoteBolt11(h.quote);
    if (q.state === 'PAID') {
      const proofs = await w.mintProofsBolt11(h.amount, q);
      addProofs(h.mint, proofs);
      h.status = 'done'; h.ts = Date.now();
    } else if (q.state === 'ISSUED') h.status = 'done';
    else if (h.expiry && Date.now() / 1000 > h.expiry) h.status = 'expired';
    save();
  } finally { busy.delete(h.id); }
  return h.status;
}

async function sendEcash(amount, memo) {
  const url = S.active, w = await walletFor(url);
  const before = bal(url);
  if (amount > before) throw new Error('insufficient balance at this mint');
  const { keep, send } = await w.send(amount, getProofs(url), { includeFees: true });
  setProofs(url, keep);
  const token = getEncodedToken({ mint: url, proofs: send, unit: 'sat', ...(memo ? { memo } : {}) }, { removeDleq: true });
  return H({ kind: 'ecash-out', amount, fee: Math.max(0, before - sum(keep) - amount), mint: url, status: 'pending', token, memo });
}
function parseToken(str) {
  str = str.trim().replace(/^web\+cashu:\/\//i, '').replace(/^cashu:/i, '');
  const meta = getTokenMetadata(str);
  return { str, mint: normUrl(meta.mint), unit: meta.unit, amount: meta.amount.toNumber(), memo: meta.memo };
}
async function receiveEcash(t) {
  if (t.unit && t.unit !== 'sat') throw new Error(`unsupported unit: ${t.unit}`);
  await addMint(t.mint);
  const w = await walletFor(t.mint);
  const proofs = await w.receive(t.str);
  addProofs(t.mint, proofs);
  const got = sum(proofs);
  return H({ kind: 'ecash-in', amount: got, fee: Math.max(0, t.amount - got), mint: t.mint, status: 'done', memo: t.memo });
}
async function checkClaimed(h) {
  if (h.kind !== 'ecash-out' || h.status !== 'pending') return h.status;
  const w = await walletFor(h.mint);
  const { proofs } = w.decodeToken(h.token);
  const st = await w.checkProofsStates(proofs);
  if (st.length && st.every((s) => s.state === 'SPENT')) { h.status = 'claimed'; save(); }
  return h.status;
}
async function reclaim(h) {
  const w = await walletFor(h.mint);
  const proofs = await w.receive(h.token);
  addProofs(h.mint, proofs);
  h.status = 'reclaimed'; save();
}

/* lightning out */
function decodeLnurl(s) {
  const { words } = bech32.decode(s.toLowerCase(), 2000);
  return new TextDecoder().decode(bech32.fromWords(words));
}
const isInvoice = (s) => /^ln(bc|tb|bcrt|tbs)[0-9]/i.test(s);
const isAddress = (s) => /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
const isLnurl = (s) => /^lnurl1[02-9ac-hj-np-z]+$/i.test(s);
async function lnurlMeta(target) {
  const url = isLnurl(target) ? decodeLnurl(target) : (() => { const [u, d] = target.split('@'); return `https://${d}/.well-known/lnurlp/${u}`; })();
  let meta;
  try { meta = await (await fetch(url)).json(); } catch { throw new Error('could not reach ' + host(url)); }
  if (meta.status === 'ERROR') throw new Error(meta.reason || 'lnurl error');
  if (meta.tag !== 'payRequest') throw new Error('not a lightning pay endpoint');
  return meta;
}
async function lnurlInvoice(meta, sats, comment) {
  const msat = sats * 1000;
  if (msat < meta.minSendable || msat > meta.maxSendable) throw new Error(`amount must be ${fmt(Math.ceil(meta.minSendable / 1000))}–${fmt(Math.floor(meta.maxSendable / 1000))} sat`);
  const cb = new URL(meta.callback);
  cb.searchParams.set('amount', String(msat));
  if (comment && meta.commentAllowed) cb.searchParams.set('comment', comment.slice(0, meta.commentAllowed));
  const r = await (await fetch(cb)).json();
  if (r.status === 'ERROR' || !r.pr) throw new Error(r.reason || 'no invoice returned');
  return r.pr;
}
async function quoteInvoice(inv, url = S.active) {
  const w = await walletFor(url);
  return w.createMeltQuoteBolt11(inv);
}
async function payInvoice(q, memo, url = S.active) {
  const w = await walletFor(url);
  const amount = q.amount.toNumber(), reserve = q.fee_reserve.toNumber();
  const before = bal(url);
  if (amount + reserve > before) throw new Error(`need ${fmt(amount + reserve)} sat incl. fee reserve // have ${fmt(before)}`);
  const { keep, send } = await w.send(amount + reserve, getProofs(url), { includeFees: true });
  setProofs(url, keep);
  const h = H({ kind: 'ln-out', amount, mint: url, status: 'pending', quote: q.quote, request: q.request, memo, inflight: serializeProofs(send) });
  try {
    const res = await w.meltProofsBolt11(q, send);
    if (res.quote.state === 'PAID') {
      addProofs(url, res.change || []);
      h.status = 'done'; h.fee = Math.max(0, before - bal(url) - amount); h.preimage = res.quote.payment_preimage || ''; delete h.inflight;
    }
    save();
  } catch (e) {
    await settleMelt(h).catch(() => {});
    if (h.status === 'failed') throw e;
  }
  return h;
}
async function settleMelt(h) {
  if (h.kind !== 'ln-out' || h.status !== 'pending' || busy.has(h.id)) return;
  busy.add(h.id);
  try {
    const w = await walletFor(h.mint);
    const q = await w.checkMeltQuoteBolt11(h.quote);
    if (q.state === 'PAID') { h.status = 'done'; h.preimage = q.payment_preimage || ''; delete h.inflight; }
    else if (q.state === 'UNPAID' && h.inflight) {
      const g = await w.groupProofsByState(deserializeProofs(h.inflight));
      addProofs(h.mint, [...g.unspent]);
      h.status = 'failed'; delete h.inflight;
    }
    save();
  } finally { busy.delete(h.id); }
}
async function moveFunds(to, amount) {
  const from = S.active;
  const inv = await createInvoice(amount, to, 'from ' + mintOf(from).name);
  const q = await quoteInvoice(inv.request, from);
  const out = await payInvoice(q, 'to ' + mintOf(to).name, from);
  for (let i = 0; i < 8 && inv.status === 'pending'; i++) { await checkInvoice(inv).catch(() => {}); if (inv.status === 'pending') await new Promise((r) => setTimeout(r, 1500)); }
  return { inv, out };
}

/* maintenance */
async function sweepSpent() {
  let removed = 0;
  for (const m of S.mints) {
    const p = getProofs(m.url); if (!p.length) continue;
    const w = await walletFor(m.url);
    const g = await w.groupProofsByState(p);
    removed += sum(g.spent);
    setProofs(m.url, [...g.unspent, ...g.pending]);
  }
  return removed;
}
async function restoreMint(url, log = () => {}) {
  const w = await walletFor(url);
  let found = [];
  for (const ks of w.keyChain.getKeysets()) {
    if (ks.unit !== 'sat') continue;
    log(`scan keyset ${ks.id.slice(0, 12)}…`);
    try {
      await w.keyChain.ensureKeysetKeys(ks.id);
      const { proofs, lastCounterWithSignature } = await w.batchRestore(100, undefined, 0, ks.id);
      if (lastCounterWithSignature != null) await counterSource.advanceToAtLeast(ks.id, lastCounterWithSignature + 1);
      found = found.concat(proofs);
    } catch (e) { log(`skip ${ks.id.slice(0, 12)}: ${niceErr(e)}`); }
  }
  if (!found.length) return 0;
  const g = await w.groupProofsByState(found);
  addProofs(url, g.unspent);
  const amt = sum(g.unspent);
  if (amt) H({ kind: 'ecash-in', amount: amt, mint: url, status: 'done', memo: 'restored from seed' });
  return amt;
}
async function settleAll() {
  for (const h of S.history.filter((x) => x.status === 'pending').slice(0, 25)) {
    try {
      if (h.kind === 'ln-in') await checkInvoice(h);
      else if (h.kind === 'ln-out') await settleMelt(h);
      else if (h.kind === 'ecash-out') await checkClaimed(h);
    } catch {}
  }
  render();
}
async function loadPrice() {
  if (!S.fiat) return;
  try {
    const r = await (await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot')).json();
    const p = parseFloat(r?.data?.amount);
    if (p > 0) { S.price = p; save(); renderFiat(); }
  } catch {}
}

/* ================= ui helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const I = {
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;

let tt;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3400);
}
async function copy(text, label = 'copied to clipboard') {
  try { await navigator.clipboard.writeText(text); toast('[ok] ' + label); } catch { toast('err: copy blocked // long-press to select'); }
}
async function pasteInto(el) {
  try { el.value = (await navigator.clipboard.readText()).trim(); el.dispatchEvent(new Event('input')); } catch { el.focus(); toast('long-press the field to paste'); }
}
async function qr(text) {
  try {
    const t = isInvoice(text) ? 'lightning:' + text.toUpperCase() : text;
    return await QRCode.toString(t, { type: 'svg', margin: 0, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#e8ffe9' } });
  } catch { return '<p class="dim">payload too large for qr // copy instead</p>'; }
}
function withBusy(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { await fn(...a); } catch (e) { console.error(e); toast('err: ' + niceErr(e)); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
  };
}
function niceErr(e) {
  const m = String(e?.message || e).toLowerCase();
  if (/failed to fetch|networkerror|load failed/.test(m)) return 'mint unreachable // check connection';
  if (/not enough|insufficient/.test(m)) return 'insufficient balance incl. fees';
  if (/already spent|token already/.test(m)) return 'token already claimed';
  return m.length > 140 ? m.slice(0, 140) + '…' : m;
}
const stamp = (ts) => {
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return today ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const KIND = { 'ln-in': 'ln.in', 'ln-out': 'ln.out', 'ecash-in': 'ecash.in', 'ecash-out': 'ecash.out' };
const STAT = { pending: 'wait', done: 'ok', claimed: 'ok', reclaimed: 'rclm', expired: 'exp', failed: 'fail' };

/* ================= hero ================= */
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let shown = null;
function scramble(el, txt) {
  if (reduce || shown === null) { el.textContent = txt; shown = txt; return; }
  if (txt === shown) return;
  shown = txt;
  const glyphs = '0123456789#$%&*+=?@ABCDEF';
  let f = 0;
  const run = () => {
    f++;
    el.textContent = [...txt].map((c, i) => (c === ',' || f > 6 + i * 2 ? c : glyphs[(Math.random() * glyphs.length) | 0])).join('');
    if (f < 8 + txt.length * 2) requestAnimationFrame(run); else el.textContent = txt;
  };
  run();
}
function hexdump(hex) {
  hex = (hex || '').replace(/[^0-9a-f]/gi, '').padEnd(66, '0').slice(0, 64);
  const rows = [];
  for (let r = 0; r < 2; r++) {
    const b = hex.slice(r * 32, r * 32 + 32).match(/../g);
    const ascii = b.map((x) => { const c = parseInt(x, 16); return c > 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join('');
    rows.push(`${(r * 16).toString(16).padStart(4, '0')}  ${b.slice(0, 8).join(' ')}  ${b.slice(8).join(' ')}  |${ascii}|`);
  }
  return rows.join('\n');
}
function renderFiat() {
  const f = $('#fiat');
  if (!S.fiat || !S.price) { f.textContent = ''; return; }
  f.textContent = '≈ $' + ((total() / 1e8) * S.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' usd';
}

/* ================= render home ================= */
function render() {
  const m = mintOf(S.active);
  $('#mintName').textContent = m ? host(m.url) : 'none';
  scramble($('#bal'), fmt(total()));
  renderFiat();
  $('#mintBal').textContent = S.mints.length > 1 && m ? `${fmt(bal(m.url))} sat @ this mint` : '';
  $('#hex').textContent = m ? `mint.pubkey\n${hexdump(m.pubkey)}` : '';
  const list = S.history.slice(0, 80);
  $('#hist').innerHTML = list.map((h) => {
    const out = h.kind.endsWith('out');
    return `<li><button class="row s-${esc(h.status)} ${out ? 'out' : 'in'}" data-id="${esc(h.id)}">
      <span class="c-t">${stamp(h.ts)}</span><span class="c-k">${KIND[h.kind]}</span>
      <span class="c-a">${out ? '-' : '+'}${fmt(h.amount)}</span><span class="c-s">${h.kind === 'ecash-out' && h.status === 'pending' ? 'open' : STAT[h.status] || h.status}</span></button></li>`;
  }).join('');
  $('#empty').hidden = list.length > 0;
}

/* ================= sheet ================= */
let open = false, locked = false, onClose = null;
function sheet(title, html, mount, opts = {}) {
  locked = !!opts.locked;
  const body = $('#sheetBody');
  body.innerHTML = `<div class="bar"><h2>// ${esc(title)}</h2>${locked ? '' : '<button class="x" aria-label="Close">[x]</button>'}</div>` + html;
  const x = $('.x', body); if (x) x.onclick = () => closeSheet();
  if (onClose) { onClose(); onClose = null; }
  if (!open) { history.pushState({ sheet: 1 }, ''); open = true; $('#sheet').hidden = false; requestAnimationFrame(() => $('#sheet').classList.add('on')); }
  body.scrollTop = 0;
  mount && mount(body);
}
function closeSheet(fromPop) {
  if (!open) return;
  if (locked) { if (fromPop) history.pushState({ sheet: 1 }, ''); return; }
  open = false;
  onClose && onClose(); onClose = null;
  $('#sheet').classList.remove('on');
  setTimeout(() => { if (!open) { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; } }, 220);
  if (!fromPop) history.back();
  render();
}
addEventListener('popstate', () => { if (open) closeSheet(true); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#scanner').hidden) stopScan(); else closeSheet(); } });

const seg = (a, b, which) => `<div class="seg" role="tablist"><button role="tab" data-t="a" aria-selected="${which === 'a'}">${a}</button><button role="tab" data-t="b" aria-selected="${which === 'b'}">${b}</button></div>`;
function bindSeg(b) {
  b.querySelectorAll('.seg button').forEach((t) => (t.onclick = () => {
    b.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', x === t));
    b.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.p !== t.dataset.t));
  }));
}
const amountField = (id, hint) => `<label class="amt"><span class="pr">&gt;</span><input id="${id}" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" aria-label="Amount in sats"><span class="u">sat</span></label><p class="hint">${hint}</p>`;
const readAmt = (el) => parseInt(el.value.replace(/\D/g, ''), 10) || 0;
const needMint = () => { if (!S.active) { mintsSheet(true); return true; } return false; };
const armor = (t, label) => `<pre class="armor"><span>-----BEGIN ${label}-----</span>\n${esc(t)}\n<span>-----END ${label}-----</span></pre>`;
const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

/* ================= onboarding ================= */
function welcome() {
  sheet('init', `<pre class="ascii" aria-hidden="true">
 _     _ _           _     _
| |__ | (_)_ __   __| |___(_) __ _
| '_ \\| | | '_ \\ / _\` / __| |/ _\` |
| |_) | | | | | | (_| \\__ \\ | (_| |
|_.__/|_|_|_| |_|\\__,_|___/_|\\__, |
                             |___/</pre>
    <p class="lead">chaumian ecash for your pocket.<br>bearer money. no accounts. no names.</p>
    <button class="btn primary wide" id="nw">new wallet</button>
    <button class="btn wide" id="rs">restore from seed</button>
    <p class="dim small">keys are generated on this device and never leave it.</p>`, (b) => {
    $('#nw', b).onclick = () => { const m = generateMnemonic(wordlist, 128); showSeed(m, true); };
    $('#rs', b).onclick = restoreSheet;
  }, { locked: true });
}
function seedGrid(m) { return `<ol class="seed">${m.split(' ').map((w, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${esc(w)}</li>`).join('')}</ol>`; }
function showSeed(m, isNew) {
  sheet('seed phrase', `<p>${isNew ? 'write these 12 words down, in order, offline. they restore your ecash if this device is lost.' : 'your recovery phrase. anyone with it can take your ecash.'}</p>
    ${seedGrid(m)}
    ${isNew ? `<label class="chk"><input type="checkbox" id="ok"> i wrote it down</label><button class="btn primary wide" id="go" disabled>continue</button>` : `<button class="btn wide" id="cp">copy</button>`}`, (b) => {
    if (isNew) {
      $('#ok', b).onchange = (e) => ($('#go', b).disabled = !e.target.checked);
      $('#go', b).onclick = () => { setSeed(m); mintsSheet(true); };
    } else $('#cp', b).onclick = () => copy(m, 'seed copied // clear your clipboard after');
  }, { locked: isNew });
}
function setSeed(m) { S.mnemonic = m; save(); SEED = mnemonicToSeedSync(m); wallets.clear(); }
let restoring = false;
function restoreSheet() {
  sheet('restore', `<p>enter your 12 or 24 word seed phrase.</p>
    <textarea id="words" rows="4" placeholder="word1 word2 word3 …" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
    <p class="hint" id="wh">&nbsp;</p>
    <button class="btn primary wide" id="go" disabled>restore</button>
    <button class="btn wide" id="bk">back</button>`, (b) => {
    const ta = $('#words', b), go = $('#go', b);
    const norm = () => ta.value.trim().toLowerCase().split(/\s+/).join(' ');
    ta.oninput = () => {
      const n = norm().split(' ').filter(Boolean).length, ok = validateMnemonic(norm(), wordlist);
      $('#wh', b).textContent = ok ? '[ok] valid phrase' : `${n} words${n === 12 || n === 24 ? ' // checksum failed' : ''}`;
      go.disabled = !ok;
    };
    go.onclick = () => { setSeed(norm()); restoring = true; mintsSheet(true); };
    $('#bk', b).onclick = welcome;
  }, { locked: true });
}
function restoreRun(urls) {
  sheet('restoring', `<pre class="term" id="lg"></pre><button class="btn primary wide" id="dn" disabled>done</button>`, async (b) => {
    const lg = $('#lg', b), log = (s) => { lg.textContent += '> ' + s + '\n'; lg.scrollTop = lg.scrollHeight; };
    let got = 0;
    for (const u of urls) {
      log('mint ' + host(u));
      try { const a = await restoreMint(u, log); got += a; log(`found ${fmt(a)} sat`); } catch (e) { log('err: ' + niceErr(e)); }
    }
    log(`total restored: ${fmt(got)} sat`);
    restoring = false; render();
    const dn = $('#dn', b); dn.disabled = false; dn.onclick = () => { locked = false; closeSheet(); };
  }, { locked: true });
}

/* ================= receive ================= */
function receiveSheet(tab = 'a', prefill = '') {
  if (needMint()) return;
  sheet('receive', `${seg('ecash', 'lightning', tab)}
    <div class="pane" data-p="a" ${tab !== 'a' ? 'hidden' : ''}>
      <textarea id="tok" rows="4" placeholder="paste cashu token" spellcheck="false" autocapitalize="off"></textarea>
      <div class="two"><button class="btn" id="pst">paste</button><button class="btn" id="scn">scan</button></div>
      <div id="prev"></div>
      <button class="btn primary wide" id="rcv" disabled>receive</button>
    </div>
    <div class="pane" data-p="b" ${tab !== 'b' ? 'hidden' : ''}>
      ${amountField('amt', `mint: ${esc(host(S.active))}`)}
      <button class="btn primary wide" id="inv">create invoice</button>
    </div>`, (b) => {
    bindSeg(b);
    const ta = $('#tok', b), rcv = $('#rcv', b);
    let parsed = null;
    ta.oninput = () => {
      parsed = null; rcv.disabled = true; $('#prev', b).innerHTML = '';
      if (!ta.value.trim()) return;
      try { parsed = parseToken(ta.value); } catch { $('#prev', b).innerHTML = '<p class="warn">err: not a valid cashu token</p>'; return; }
      const known = mintOf(parsed.mint);
      $('#prev', b).innerHTML = kv([['amount', `<b>${fmt(parsed.amount)} sat</b>`], ['mint', esc(host(parsed.mint))], parsed.memo && ['memo', esc(parsed.memo)]])
        + (known ? '' : '<p class="warn">! unknown mint. receiving will add it. only accept ecash from mints you trust.</p>');
      rcv.textContent = known ? 'receive' : 'trust mint + receive';
      rcv.disabled = false;
    };
    $('#pst', b).onclick = () => pasteInto(ta);
    $('#scn', b).onclick = () => startScan((t) => { ta.value = t; ta.oninput(); });
    rcv.onclick = withBusy(rcv, async () => done(await receiveEcash(parsed), 'received'));
    if (prefill) { ta.value = prefill; ta.oninput(); }
    const ib = $('#inv', b);
    ib.onclick = withBusy(ib, async () => {
      const a = readAmt($('#amt', b)); if (!a) return toast('err: enter an amount');
      invoiceView(await createInvoice(a));
    });
  });
}
async function invoiceView(h) {
  const svg = await qr(h.request);
  sheet('invoice', `<div class="qr">${svg}</div>
    <p class="big">${fmt(h.amount)} <small>sat</small></p>
    <p class="wait">awaiting payment<span class="cur">_</span></p>
    <button class="btn wide" id="cp">copy invoice</button>
    <p class="dim small center">safe to close. the wallet keeps polling the mint.</p>`, (b) => {
    $('#cp', b).onclick = () => copy(h.request, 'invoice copied');
    let timer;
    const tick = async () => {
      try {
        const s = await checkInvoice(h);
        if (s === 'done') return done(h, 'received');
        if (s === 'expired') { $('.wait', b).textContent = 'invoice expired'; return; }
      } catch {}
      timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 1500);
    onClose = () => clearTimeout(timer);
  });
}

/* ================= send ================= */
function sendSheet(tab = 'a', prefill = '') {
  if (needMint()) return;
  const have = bal(S.active);
  sheet('send', `${seg('ecash', 'lightning', tab)}
    <div class="pane" data-p="a" ${tab !== 'a' ? 'hidden' : ''}>
      ${amountField('amt', `available: ${fmt(have)} sat`)}
      <input id="memo" class="field" placeholder="memo (optional)" maxlength="80" autocomplete="off">
      <button class="btn primary wide" id="mk">create token</button>
    </div>
    <div class="pane" data-p="b" ${tab !== 'b' ? 'hidden' : ''}>
      <textarea id="ln" rows="3" placeholder="invoice, lightning address or lnurl" spellcheck="false" autocapitalize="off"></textarea>
      <div class="two"><button class="btn" id="pst">paste</button><button class="btn" id="scn">scan</button></div>
      <div id="lnx"></div>
      <button class="btn primary wide" id="pay" disabled>continue</button>
    </div>`, (b) => {
    bindSeg(b);
    const mk = $('#mk', b);
    mk.onclick = withBusy(mk, async () => {
      const a = readAmt($('#amt', b)); if (!a) return toast('err: enter an amount');
      const h = await sendEcash(a, $('#memo', b).value.trim()); render(); tokenView(h);
    });

    const ln = $('#ln', b), pay = $('#pay', b), x = $('#lnx', b);
    let stage = null, quote = null, meta = null, label = '';
    const setPay = (t, dis = false) => setTimeout(() => { pay.textContent = t; pay.disabled = dis; }, 0);
    ln.oninput = () => {
      const v = ln.value.trim().replace(/^lightning:/i, '');
      stage = quote = meta = null; x.innerHTML = '';
      if (isInvoice(v)) { stage = 'invoice'; label = ''; }
      else if (isAddress(v) || isLnurl(v)) { stage = 'lnurl'; label = isAddress(v) ? v.toLowerCase() : 'lnurl'; }
      pay.textContent = 'continue'; pay.disabled = !stage;
    };
    const showQuote = () => {
      const a = quote.amount.toNumber(), f = quote.fee_reserve.toNumber();
      x.innerHTML = kv([label && ['to', esc(label)], ['amount', `${fmt(a)} sat`], ['ln fee', `≤ ${fmt(f)} sat`], ['total', `<b>${fmt(a + f)} sat</b>`], ['balance', `${fmt(bal(S.active))} sat`]])
        + '<p class="dim small">unused fee reserve returns as change. mint input fees may apply.</p>';
      stage = 'pay'; setPay(`pay ${fmt(a)} sat`);
    };
    pay.onclick = withBusy(pay, async () => {
      const v = ln.value.trim().replace(/^lightning:/i, '');
      if (stage === 'invoice') { quote = await quoteInvoice(v.toLowerCase()); return showQuote(); }
      if (stage === 'lnurl') {
        meta = await lnurlMeta(v);
        let desc = ''; try { desc = (JSON.parse(meta.metadata).find((e) => e[0] === 'text/plain') || [])[1] || ''; } catch {}
        x.innerHTML = `${desc ? `<p class="dim small">${esc(desc)}</p>` : ''}${amountField('lamt', `${fmt(Math.ceil(meta.minSendable / 1000))}–${fmt(Math.floor(meta.maxSendable / 1000))} sat // have ${fmt(bal(S.active))}`)}
          ${meta.commentAllowed ? `<input id="cmt" class="field" placeholder="comment (optional)" maxlength="${meta.commentAllowed}">` : ''}`;
        stage = 'lnamt'; setPay('get quote'); setTimeout(() => $('#lamt', b)?.focus(), 50); return;
      }
      if (stage === 'lnamt') {
        const a = readAmt($('#lamt', b)); if (!a) return toast('err: enter an amount');
        const pr = await lnurlInvoice(meta, a, $('#cmt', b)?.value.trim());
        quote = await quoteInvoice(pr); return showQuote();
      }
      if (stage === 'pay') {
        const h = await payInvoice(quote, label || undefined);
        if (h.status === 'done') done(h, 'paid'); else { toast('payment in flight // will settle'); closeSheet(); }
      }
    });
    $('#pst', b).onclick = () => pasteInto(ln);
    $('#scn', b).onclick = () => startScan((t) => { ln.value = t; ln.oninput(); });
    if (prefill) { ln.value = prefill; ln.oninput(); }
  });
}
async function tokenView(h) {
  const svg = await qr(h.token);
  sheet('token', `<div class="qr">${svg}</div>
    <p class="big">${fmt(h.amount)} <small>sat</small></p>
    ${h.fee ? `<p class="dim small center">incl. ${fmt(h.fee)} sat mint fee</p>` : ''}
    ${armor(h.token, 'CASHU TOKEN')}
    <div class="two"><button class="btn primary" id="cp">copy</button>${navigator.share ? '<button class="btn" id="sh">share</button>' : '<button class="btn" id="dn">done</button>'}</div>
    <p class="dim small center">bearer instrument. whoever holds it can spend it. reclaim from the log until claimed.</p>`, (b) => {
    $('#cp', b).onclick = () => copy(h.token, 'token copied');
    const sh = $('#sh', b); if (sh) sh.onclick = () => navigator.share({ text: h.token }).catch(() => {});
    const dn = $('#dn', b); if (dn) dn.onclick = () => closeSheet();
  });
}
function done(h, verb) {
  sheet(verb, `<pre class="okb" aria-hidden="true">[ ${verb === 'paid' ? 'TX SETTLED' : 'PROOFS STORED'} ]</pre>
    <p class="big">${h.kind.endsWith('out') ? '-' : '+'}${fmt(h.amount)} <small>sat</small></p>
    ${h.fee ? `<p class="dim small center">fee ${fmt(h.fee)} sat</p>` : ''}
    <button class="btn primary wide" id="dn">done</button>`, (b) => ($('#dn', b).onclick = () => closeSheet()));
  render();
}

/* ================= log detail ================= */
function detail(h) {
  if (h.kind === 'ln-in' && h.status === 'pending') return invoiceView(h);
  const unclaimed = h.kind === 'ecash-out' && h.status === 'pending';
  const st = { pending: unclaimed ? 'unclaimed' : 'pending', done: 'complete', claimed: 'claimed', reclaimed: 'reclaimed', expired: 'expired', failed: 'failed // ecash returned' }[h.status];
  sheet(KIND[h.kind], `<p class="big">${h.kind.endsWith('out') ? '-' : '+'}${fmt(h.amount)} <small>sat</small></p>
    ${kv([['status', st], ['mint', esc(host(h.mint))], ['time', new Date(h.ts).toLocaleString()], h.fee && ['fee', `${fmt(h.fee)} sat`], h.memo && ['memo', esc(h.memo)], h.preimage && ['preimage', `<code>${esc(h.preimage)}</code>`]])}
    ${unclaimed ? `<div class="qr" id="q"></div>${armor(h.token, 'CASHU TOKEN')}
      <button class="btn primary wide" id="cp">copy token</button>
      <div class="two"><button class="btn" id="chk">check</button><button class="btn" id="rc">reclaim</button></div>` : ''}
    ${h.kind === 'ln-out' && h.status === 'pending' ? '<button class="btn wide" id="st">check payment</button>' : ''}`, async (b) => {
    if (unclaimed) {
      $('#q', b).innerHTML = await qr(h.token);
      $('#cp', b).onclick = () => copy(h.token, 'token copied');
      const chk = $('#chk', b), rc = $('#rc', b);
      chk.onclick = withBusy(chk, async () => { const s = await checkClaimed(h); toast(s === 'claimed' ? '[ok] token was claimed' : 'still unclaimed'); if (s === 'claimed') detail(h); });
      rc.onclick = withBusy(rc, async () => { await reclaim(h); toast('[ok] reclaimed'); render(); detail(h); });
    }
    const s2 = $('#st', b);
    if (s2) s2.onclick = withBusy(s2, async () => { await settleMelt(h); render(); detail(h); });
  });
}

/* ================= mints ================= */
function mintsSheet(first = false) {
  const rows = S.mints.map((m) => `<li class="mint ${m.url === S.active ? 'act' : ''}">
      <button class="pick" data-u="${esc(m.url)}"><span class="mk">${m.url === S.active ? '●' : '○'}</span>
      <span class="mt"><b>${esc(m.name)}</b><small>${esc(host(m.url))}</small></span><span class="mb">${fmt(bal(m.url))}</span></button>
      ${bal(m.url) === 0 && m.url !== S.active ? `<button class="rm" data-u="${esc(m.url)}" aria-label="Remove ${esc(m.name)}">[rm]</button>` : ''}</li>`).join('');
  const sugg = SUGGESTED.filter((s) => !mintOf(s.url)).map((s) => `<li><button class="sug" data-u="${esc(s.url)}"><b>+ ${esc(host(s.url))}</b><small>${esc(s.note)}</small></button></li>`).join('');
  sheet(first ? 'select mint' : 'mints', `
    ${first ? `<p>${restoring ? 'add the mints you used before. each one is scanned for your ecash.' : 'a mint issues ecash against bitcoin it holds. trust is required: start small.'}</p>` : ''}
    ${rows ? `<ul class="mints">${rows}</ul>` : ''}
    <form id="add" class="addm"><span class="pr">&gt;</span><input id="mu" class="field" placeholder="https://mint.url" inputmode="url" autocapitalize="off" spellcheck="false"><button class="btn primary" id="ab">add</button></form>
    ${sugg ? `<h3>// known mints</h3><ul class="sugs">${sugg}</ul>` : ''}
    ${S.mints.length > 1 && !first ? '<button class="btn wide" id="mv">move funds between mints</button>' : ''}
    ${first && S.mints.length ? `<button class="btn primary wide" id="fin">${restoring ? 'scan mints' : 'done'}</button>` : ''}`, (b) => {
    b.querySelectorAll('.pick').forEach((x) => (x.onclick = () => { S.active = x.dataset.u; save(); render(); if (first) mintsSheet(true); else closeSheet(); }));
    b.querySelectorAll('.rm').forEach((x) => (x.onclick = () => { S.mints = S.mints.filter((m) => m.url !== x.dataset.u); delete S.proofs[x.dataset.u]; save(); mintsSheet(first); }));
    const ab = $('#ab', b);
    const add = withBusy(ab, async (u) => {
      const url = await addMint(u); S.active = url; save(); render(); toast('[ok] mint added');
      if (first) mintsSheet(true); else closeSheet();
    });
    $('#add', b).onsubmit = (e) => { e.preventDefault(); const u = $('#mu', b).value.trim(); if (u) add(u); };
    b.querySelectorAll('.sug').forEach((x) => (x.onclick = () => add(x.dataset.u)));
    const mv = $('#mv', b); if (mv) mv.onclick = moveSheet;
    const fin = $('#fin', b);
    if (fin) fin.onclick = () => { if (restoring) restoreRun(S.mints.map((m) => m.url)); else { locked = false; closeSheet(); } };
  }, { locked: first });
}
function moveSheet() {
  const others = S.mints.filter((m) => m.url !== S.active);
  sheet('move funds', `<p class="dim small">from ${esc(host(S.active))} // pays a lightning invoice between mints</p>
    ${amountField('amt', `available: ${fmt(bal(S.active))} sat`)}
    <label class="lbl" for="to">to mint</label>
    <select id="to" class="field">${others.map((m) => `<option value="${esc(m.url)}">${esc(host(m.url))}</option>`).join('')}</select>
    <button class="btn primary wide" id="go">move</button>`, (b) => {
    const go = $('#go', b);
    go.onclick = withBusy(go, async () => {
      const a = readAmt($('#amt', b)); if (!a) return toast('err: enter an amount');
      const { inv } = await moveFunds($('#to', b).value, a);
      toast(inv.status === 'done' ? `[ok] moved ${fmt(a)} sat` : 'paid // destination mint still settling');
      closeSheet();
    });
  });
}

/* ================= settings ================= */
function settingsSheet() {
  sheet('config', `
    <h3>// seed</h3>
    <button class="btn wide" id="seed">reveal seed phrase</button>
    <button class="btn wide" id="rst">restore ecash from seed</button>
    <h3>// ecash</h3>
    <button class="btn wide" id="sw">purge spent proofs</button>
    <button class="btn wide" id="bk">export tokens</button>
    <h3>// display</h3>
    <label class="chk"><input type="checkbox" id="fi" ${S.fiat ? 'checked' : ''}> show usd estimate</label>
    <h3>// about</h3>
    <p class="dim small">blindsig ${VERSION} // cashu-ts 4.14 // nut-00…13. ecash is stored in this browser only. keep your seed offline.</p>
    <button class="btn wide danger" id="wipe">wipe wallet</button>`, (b) => {
    $('#seed', b).onclick = () => showSeed(S.mnemonic, false);
    $('#rst', b).onclick = () => (S.mints.length ? restoreRun(S.mints.map((m) => m.url)) : toast('err: add a mint first'));
    const sw = $('#sw', b);
    sw.onclick = withBusy(sw, async () => { const r = await sweepSpent(); render(); toast(r ? `[ok] purged ${fmt(r)} sat of spent proofs` : '[ok] all proofs valid'); });
    $('#bk', b).onclick = exportSheet;
    $('#fi', b).onchange = (e) => { S.fiat = e.target.checked; save(); renderFiat(); if (S.fiat) loadPrice(); };
    $('#wipe', b).onclick = wipeSheet;
  });
}
function exportSheet() {
  const toks = S.mints.filter((m) => bal(m.url) > 0).map((m) => getEncodedToken({ mint: m.url, proofs: getProofs(m.url), unit: 'sat' }));
  const all = toks.join('\n\n');
  sheet('export', `<p class="warn">! these tokens are your money. anyone who sees them can spend them.</p>
    ${toks.length ? `${toks.map((t) => armor(t, 'CASHU TOKEN')).join('')}<button class="btn primary wide" id="cp">copy all</button>` : '<p class="dim">nothing to export.</p>'}`, (b) => {
    const cp = $('#cp', b); if (cp) cp.onclick = () => copy(all, 'tokens copied');
  });
}
function wipeSheet() {
  sheet('wipe', `<p class="warn">! deletes your seed, mints and all ecash on this device. without your seed phrase the funds are gone.</p>
    <p>type <b>wipe</b> to confirm.</p><input id="cf" class="field" autocomplete="off" autocapitalize="off">
    <button class="btn wide danger" id="go" disabled>wipe everything</button>`, (b) => {
    $('#cf', b).oninput = (e) => ($('#go', b).disabled = e.target.value.trim().toLowerCase() !== 'wipe');
    $('#go', b).onclick = () => { localStorage.removeItem(KEY); location.reload(); };
  });
}

/* ================= scanner ================= */
let stream = null, raf = 0, onScan = null;
async function startScan(cb) {
  onScan = cb;
  const sc = $('#scanner'), v = $('video', sc);
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch { toast('err: camera unavailable // paste instead'); return; }
  sc.hidden = false; v.srcObject = stream; await v.play().catch(() => {});
  const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
  const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  let last = 0;
  const loop = async (t) => {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (t - last < 140 || v.readyState < 2) return; last = t;
    let txt = null;
    try {
      if (detector) { const r = await detector.detect(v); txt = r[0]?.rawValue; }
      else {
        const s = Math.min(1, 640 / v.videoWidth); c.width = v.videoWidth * s; c.height = v.videoHeight * s;
        ctx.drawImage(v, 0, 0, c.width, c.height);
        txt = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' })?.data;
      }
    } catch {}
    if (txt) { const f = onScan; stopScan(); navigator.vibrate?.(30); f && f(txt.trim()); }
  };
  raf = requestAnimationFrame(loop);
}
function stopScan() {
  cancelAnimationFrame(raf); onScan = null;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  $('#scanner').hidden = true;
}
function route(txt) {
  const t = txt.trim().replace(/^lightning:/i, '');
  if (/^(cashu:)?cashu[AB]/i.test(t) || /^web\+cashu:/i.test(t)) return receiveSheet('a', t);
  if (isInvoice(t) || isAddress(t) || isLnurl(t)) return sendSheet('b', t);
  if (/^https?:\/\//i.test(t)) { mintsSheet(); setTimeout(() => { const f = $('#mu'); if (f) f.value = t; }, 0); return; }
  toast('err: unrecognised code');
}

/* ================= boot ================= */
$('#recvBtn').onclick = () => receiveSheet();
$('#sendBtn').onclick = () => sendSheet();
$('#scanBtn').onclick = () => (needMint() ? null : startScan(route));
$('#mintChip').onclick = () => mintsSheet();
$('#setBtn').onclick = () => (S.mnemonic ? settingsSheet() : welcome());
$('#scanClose').onclick = stopScan;
$('#sheet .backdrop').onclick = () => closeSheet();
$('#hist').onclick = (e) => { const r = e.target.closest('.row'); if (r) { const h = S.history.find((x) => x.id === r.dataset.id); if (h) detail(h); } };
render();
if (!S.mnemonic) setTimeout(welcome, 300);
else if (!S.mints.length) setTimeout(() => mintsSheet(true), 300);
else settleAll();
loadPrice();
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.mints.length) settleAll(); });
setInterval(() => { if (!document.hidden) loadPrice(); }, 120000);

const qp = new URLSearchParams(location.search).get('token') || '';
if (qp && S.mnemonic) { history.replaceState(null, '', location.pathname); setTimeout(() => route(decodeURIComponent(qp)), 500); }

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
