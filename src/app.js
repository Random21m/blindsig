import * as FX from './fx.js';
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getEncodedTokenBinary, getDecodedTokenBinary } from '@cashu/cashu-ts';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { UR, UREncoder, URDecoder } from '@gandlaf21/bc-ur';
import {
  S, save, VERSION, DEFAULT_SETTINGS, getProofs, bal, total, sum, mintOf, mintLabel, host, esc, fmt, fmtParts, unitLabel,
  toBase, isFiatUnit, fiatOf, FIAT_CURRENCIES, KEY, wipeStore, storageKind, pinOn, pinInfo, setPin, clearPin, setLockAfter, flushSave,
  decoyOn, inDecoy, freshState, setDecoy, editDecoy, clearDecoy, isMainPin, isDecoyPin,
  encryptBackup, decryptBackup, replaceState,
} from './store.js';
import * as L from './lock.js';
import { checkNow } from './update.js';
import * as BIO from './bio.js';
import * as C from './core.js';
import * as N from './nostr.js';
import { nostrUI } from './nostr-ui.js';
import * as I18N from './i18n.js';
import * as CH from './chart.js';
import * as GIFT from './gift.js';

// the developer's Lightning address, for tips (Settings → About)
const TIP_ADDR = 'npub1t5nvfnlmegsqkqegcpnyek4qf4fc2f2gx2t4lm88h2kq22plpmxqdhgpa9@npub.cash';
const SUGGESTED = [
  { url: 'https://testnut.cashu.space', note: 'Test mint. Fake sats, invoices pay themselves.' },
  { url: 'https://mint.minibits.cash/Bitcoin', note: 'Minibits. Real sats.' },
  { url: 'https://mint.coinos.io', note: 'Coinos. Real sats.' },
];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const st = S.settings;

/* ================= feedback ================= */
let tt;
function toast(msg, kind = 'ok') {
  const t = $('#toast'); t.textContent = msg; t.dataset.kind = kind; t.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3600);
}
async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Copy blocked. Long-press to select instead.', 'warn'); }
}
async function pasteInto(el) {
  try { el.value = (await navigator.clipboard.readText()).trim(); el.dispatchEvent(new Event('input')); } catch { el.focus(); toast('Long-press the field to paste.', 'warn'); }
}
// a gentle "no": warning toast, error sound and a shake of the amount being typed
function nope(msg) { toast(msg, 'warn'); FX.fail($('#sheet .amt:not([hidden])') || $('#sheet .sb')); }
function niceErr(e) {
  const m = String(e?.message || e);
  if (/time(d)? ?out|aborted/i.test(m)) return 'The mint is taking too long to answer. Try again in a moment.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Mint unreachable. Check your connection.';
  if (/not enough|insufficient/i.test(m)) return 'Not enough balance, including fees.';
  if (/already spent|token already/i.test(m)) return 'That ecash was already claimed.';
  if (/outputs have already been signed/i.test(m)) return 'Counter clash. Bump keyset counters in Advanced settings.';
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}
function withBusy(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { await fn(...a); } catch (e) { console.error(e); toast(niceErr(e), 'err'); FX.fail(btn); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
  };
}
const later = (f) => setTimeout(f, 0);

/* ================= QR ================= */
async function qrSvg(text) {
  try { return await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'L', color: { dark: '#111111', light: '#f4efe6' } }); }
  catch { return '<p class="qrerr">Too large for one QR. Use the animated code or copy.</p>'; }
}
function qrInvoice(box, inv) { qrSvg('lightning:' + inv.toUpperCase()).then((s) => { if (box.isConnected) box.innerHTML = s; }); }
// static or animated (BC-UR, compatible with cashu.me) QR for tokens
function qrToken(wrap, token) {
  const SPEEDS = [[500, 'slow'], [250, 'medium'], [150, 'fast']], SIZES = [[50, 'S'], [100, 'M'], [150, 'L']];
  let animated = token.length > 700, sp = 1, sz = 1, timer = null, enc = null;
  wrap.innerHTML = `<div class="qr" data-q></div><div class="qrctl"></div>`;
  const box = $('[data-q]', wrap), ctl = $('.qrctl', wrap);
  const stop = () => { clearInterval(timer); timer = null; };
  const draw = async () => {
    stop();
    if (!animated) { box.innerHTML = await qrSvg(token); }
    else {
      enc = new UREncoder(UR.fromBuffer(Buffer.from(token)), SIZES[sz][0], 0);
      const tick = async () => { const s = await qrSvg(enc.nextPart().toUpperCase()); if (box.isConnected) box.innerHTML = s; else stop(); };
      await tick(); timer = setInterval(tick, SPEEDS[sp][0]);
    }
    ctl.innerHTML = `<button class="chip" data-a="mode">${animated ? 'Animated' : 'Static'}</button>${animated ? `<button class="chip" data-a="speed">Speed: ${SPEEDS[sp][1]}</button><button class="chip" data-a="size">Size: ${SIZES[sz][1]}</button>` : ''}`;
    $$('button', ctl).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'mode') animated = !animated;
      if (b.dataset.a === 'speed') sp = (sp + 1) % 3;
      if (b.dataset.a === 'size') sz = (sz + 1) % 3;
      draw();
    }));
  };
  draw();
  return stop;
}

/* ================= amount input + keypad ================= */
function amountField(id, hint, unit = S.unit) {
  const fiat = isFiatUnit(unit);
  const p = fmtParts(0, unit);
  return `<div class="amtwrap"><label class="amt"><span class="amt-pre">${esc(p.pre)}</span><input id="${id}" data-unit="${esc(unit)}" ${st.keypad ? 'inputmode="none" readonly' : `inputmode="${fiat ? 'decimal' : 'numeric'}"`} placeholder="0" autocomplete="off" aria-label="Amount"><span class="amt-post">${esc(p.post)}</span></label>
    <p class="hint" data-hint="${id}">${hint}</p>
    ${st.keypad ? `<div class="kp" data-for="${id}">${['1', '2', '3', '4', '5', '6', '7', '8', '9', fiat ? '.' : '', '0', '⌫'].map((k) => (k ? `<button type="button" data-k="${k}">${k}</button>` : '<span></span>')).join('')}</div>` : ''}</div>`;
}
function bindKeypads(b) {
  $$('.kp', b).forEach((kp) => {
    const inp = $('#' + kp.dataset.for, b);
    kp.onclick = (e) => {
      const k = e.target.closest('button')?.dataset.k; if (!k) return;
      let v = inp.value;
      if (k === '⌫') v = v.slice(0, -1);
      else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
      else if (v.replace('.', '').length < 12) { if (v.includes('.') && v.split('.')[1].length >= 2) return FX.shake(inp.closest('.amt')); v = v === '0' ? k : v + k; }
      else return FX.shake(inp.closest('.amt'));
      inp.value = v; inp.dispatchEvent(new Event('input'));
    };
  });
  $$('.amt input', b).forEach((i) => i.addEventListener('input', () => {
    if (!st.keypad) i.value = i.value.replace(isFiatUnit(i.dataset.unit) ? /[^0-9.]/g : /\D/g, '');
    // long amounts: widen the box to fit every digit and shrink the digits to fit the screen
    const n = i.value.length;
    if (n <= 7) { i.style.fontSize = ''; i.style.maxWidth = ''; return; }
    const room = i.closest('.amtwrap').clientWidth - 70; // leave space for the unit
    i.style.maxWidth = (n + 0.6) + 'ch';
    i.style.fontSize = Math.max(20, Math.min(56, room / ((n + 0.6) * 0.62))) + 'px';
  }));
}
const readAmt = (b, id = 'amt') => { const i = $('#' + id, b); return toBase(i.value, i.dataset.unit); };

/* ================= home ================= */
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let shownBal = null;
function scramble(el, txt) {
  if (reduce || shownBal === null || txt === shownBal) { el.textContent = txt; shownBal = txt; return; }
  shownBal = txt;
  const g = '0123456789#$%&*+=?', L = txt.length; let f = 0;
  const run = () => { f++; el.textContent = [...txt].map((c, i) => (/[,.]/.test(c) || f > 4 + i * 2 ? c : g[(Math.random() * g.length) | 0])).join(''); if (f < 6 + L * 2) requestAnimationFrame(run); else el.textContent = txt; };
  run();
}
const KIND = {
  'ln-in': ['Received', 'Lightning'], 'ln-out': ['Sent', 'Lightning'], 'ecash-in': ['Received', 'Ecash'], 'ecash-out': ['Sent', 'Ecash'],
  'chain-in': ['Received', 'On-chain'], 'chain-out': ['Sent', 'On-chain'],
};
const RETURN_AFTER = [[0, 'Never'], [3600e3, '1 hour'], [864e5, '1 day'], [7 * 864e5, '1 week'], [30 * 864e5, '30 days']];
// contacts saved with an npub can be picked as the person to lock ecash to
const keyContacts = () => (S.contacts || []).map((c) => ({ ...c, npub: (String(c.to).match(/^(npub1[02-9ac-hj-np-z]+)(@|$)/i) || [])[1] })).filter((c) => c.npub);
const whenShort = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const isGiftMemo = (m) => /^🎁/u.test(m || '');
const kindOf = (h) => h.vault ? ['Locked', 'Time vault'] : h.nutzap ? [KIND[h.kind][0], 'Nutzap'] : (h.gift || (h.kind === 'ecash-in' && isGiftMemo(h.memo)) ? [KIND[h.kind][0], 'Gift card'] : KIND[h.kind]);
const STATUS = { pending: 'Pending', done: '', claimed: '', reclaimed: 'Reclaimed', returned: 'Came back', expired: 'Expired', failed: 'Failed' };
let logFilter = 'all', logLimit = 100;
function stamp(ts) {
  const d = new Date(ts), s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// small live BTC price in the top bar, in the theme's accent colour
let shownPrice = 0, dirTimer;
function btcPrice() {
  const el = $('#btcPrice'), price = st.fiat ? S.price[st.fiatCur] : 0;
  el.hidden = !price;
  if (!price) return;
  $('#btcVal').textContent = price.toLocaleString('en-US', { style: 'currency', currency: st.fiatCur, maximumFractionDigits: 0 });
  el.title = `1 BTC · ${st.fiatCur}`;
  if (shownPrice && price !== shownPrice) {
    $('#btcDir').textContent = price > shownPrice ? '▲' : '▼';
    el.classList.remove('moved'); void el.offsetWidth; el.classList.add('moved');
    clearTimeout(dirTimer); dirTimer = setTimeout(() => el.classList.remove('moved'), 4000);
  }
  shownPrice = price;
}
// tap the price chip: a live chart of the bitcoin price, drag along it to read any point
let chartPeriod = 'day';
const money = (n, cur) => n.toLocaleString('en-US', { style: 'currency', currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 });
function priceChart() {
  const cur = st.fiatCur;
  sheet('Bitcoin price', `<div class="pch" data-notr>
      <div class="pcp" id="pcP">${S.price[cur] ? money(S.price[cur], cur) : '…'}</div>
      <div class="pcc" id="pcC">&nbsp;</div>
    </div>
    <div class="pcw" id="pcW" tabindex="0" role="img" aria-label="Bitcoin price chart"><div class="pcmsg dim small" id="pcM">Loading…</div></div>
    <div class="pct dim small" data-notr><span id="pcT0"></span><span id="pcT1"></span></div>
    ${seg(CH.RANGES.map(([k, p]) => [p, k]), chartPeriod)}
    <dl class="kv" id="pcK"></dl>
    <p class="dim small center">Prices from Coinbase · live while open</p>
    <button class="btn wide" id="pcS">Price settings</button>`, (b) => {
    let pts = null, geo = null, ctrl = null, scrub = -1, dead = false;
    const W = $('#pcW', b), P = $('#pcP', b), Cc = $('#pcC', b), M = $('#pcM', b);
    const label = () => CH.RANGES.find((r) => r[1] === chartPeriod)[2];
    function head() {
      if (!pts) return;
      const s = CH.stats(pts);
      if (scrub >= 0) {
        const [t, p] = pts[scrub], d = p - s.first;
        P.textContent = money(p, cur);
        Cc.className = 'pcc ' + (d < 0 ? 'dn' : 'up');
        Cc.innerHTML = `<bdi>${d < 0 ? '▼' : '▲'} ${esc(money(Math.abs(d), cur))} (${Math.abs((d / s.first) * 100).toFixed(2)}%)</bdi> · <bdi>${esc(CH.when(t, chartPeriod))}</bdi>`;
        return;
      }
      P.textContent = money(s.last, cur);
      Cc.className = 'pcc ' + (s.change < 0 ? 'dn' : 'up');
      Cc.innerHTML = `<bdi>${s.change < 0 ? '▼' : '▲'} ${esc(money(Math.abs(s.change), cur))} (${Math.abs(s.pct).toFixed(2)}%)</bdi> · <span>${esc(I18N.t(label()))}</span>`;
    }
    function draw() {
      if (!pts || dead) return;
      const w = W.clientWidth || 320, h = W.clientHeight || 200, s = CH.stats(pts);
      geo = CH.geometry(pts, w, h);
      const tone = s.change < 0 ? 'var(--err)' : 'var(--up,var(--ac))';
      const [lx, ly] = geo.xy[geo.xy.length - 1];
      W.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
        <defs><linearGradient id="pcG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone}" stop-opacity=".28"/><stop offset="1" stop-color="${tone}" stop-opacity="0"/></linearGradient></defs>
        <path d="${geo.area}" fill="url(#pcG)"/>
        <path d="${geo.line}" fill="none" stroke="${tone}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle class="pcnow" cx="${lx}" cy="${ly}" r="4" fill="${tone}"/>
        <g id="pcX" style="display:none"><line x1="0" x2="0" y1="0" y2="${h}" stroke="var(--dim)" stroke-dasharray="3 3"/><circle r="5" fill="${tone}" stroke="var(--bg)" stroke-width="2"/></g>
      </svg>`;
      W.setAttribute('aria-label', `${I18N.t('Bitcoin price chart')}: ${I18N.t(label())}, ${money(s.first, cur)} → ${money(s.last, cur)}`);
      $('#pcT0', b).textContent = CH.when(pts[0][0], chartPeriod);
      $('#pcT1', b).textContent = CH.when(pts[pts.length - 1][0], chartPeriod);
      $('#pcK', b).innerHTML = `<dt>Low</dt><dd data-notr>${esc(money(s.lo, cur))}</dd><dt>High</dt><dd data-notr>${esc(money(s.hi, cur))}</dd>`;
      I18N.translateTree($('#pcK', b));
      mark(); head();
    }
    function mark() {
      const g = $('#pcX', W); if (!g || !geo) return;
      g.style.display = scrub < 0 ? 'none' : ''; if (scrub < 0) return;
      const [x, y] = geo.xy[scrub];
      g.firstElementChild.setAttribute('x1', x); g.firstElementChild.setAttribute('x2', x);
      g.lastElementChild.setAttribute('cx', x); g.lastElementChild.setAttribute('cy', y);
    }
    const at = (e) => { if (!geo) return; const r = W.getBoundingClientRect(); scrub = CH.nearest(geo.xy, e.clientX - r.left); mark(); head(); };
    const off = () => { if (scrub < 0) return; scrub = -1; mark(); head(); };
    W.onpointerdown = (e) => { at(e); };
    W.onpointermove = (e) => { if (e.pointerType === 'mouse' || e.buttons) at(e); };
    W.onpointerup = W.onpointercancel = (e) => { if (e.pointerType !== 'mouse') off(); };
    W.onpointerleave = off;
    W.onkeydown = (e) => {
      if (!pts) return;
      const k = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (k) { e.preventDefault(); scrub = Math.max(0, Math.min(pts.length - 1, (scrub < 0 ? pts.length - 1 : scrub) + k * Math.max(1, Math.round(pts.length / 60)))); mark(); head(); }
      else if (e.key === 'Escape' && scrub >= 0) { e.stopPropagation(); off(); }
    };
    W.onblur = off;
    // nothing from the last range stays on screen while the next one loads or fails
    const blank = () => { Cc.className = 'pcc'; Cc.innerHTML = '&nbsp;'; P.textContent = S.price[cur] ? money(S.price[cur], cur) : '…'; $('#pcK', b).innerHTML = ''; $('#pcT0', b).textContent = $('#pcT1', b).textContent = ''; };
    async function load(quiet) {
      ctrl?.abort(); ctrl = new AbortController();
      const period = chartPeriod;
      if (!quiet && !CH.fresh(cur, period)) { pts = null; blank(); W.innerHTML = '<div class="pcmsg dim small">Loading…</div>'; I18N.translateTree(W); }
      try {
        const raw = await CH.series(cur, period, ctrl.signal);
        if (dead || period !== chartPeriod) return;
        pts = CH.withSpot(raw, S.price[cur]); draw();
      } catch (e) {
        if (dead || e.name === 'AbortError' || period !== chartPeriod) return;
        if (quiet && pts) return;
        pts = null; geo = null; blank();
        W.innerHTML = '<div class="pcmsg"><p class="dim small">Couldn’t load the chart. Check your connection.</p><button class="btn" id="pcR">Try again</button></div>';
        I18N.translateTree(W);
        $('#pcR', W).onclick = () => load();
      }
    }
    bindSeg(b, (p) => { chartPeriod = p; scrub = -1; load(); });
    $('#pcS', b).onclick = () => SECTIONS.privacy();
    // live: the spot price every 30 s, and the history again once it goes stale
    const tick = async () => { if (document.hidden || dead) return; if (await C.loadPrice()) render(); load(true); };
    const timer = setInterval(tick, 30000);
    let rz; const onRz = () => { clearTimeout(rz); rz = setTimeout(draw, 120); };
    addEventListener('resize', onRz);
    onClose = () => { dead = true; clearInterval(timer); clearTimeout(rz); removeEventListener('resize', onRz); ctrl?.abort(); };
    load();
  });
}
// shrink the balance digits until the whole line fits the screen
function fitBal() {
  const row = $('.balrow'), el = $('#bal');
  el.style.fontSize = '';
  // every item uses min-width:0, so add up the parts' natural widths instead of trusting the row
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const need = [...row.children].reduce((t, c) => t + c.scrollWidth, 0) + gap * (row.children.length - 1), have = row.clientWidth;
  if (need > have) {
    const fixed = need - el.scrollWidth;
    el.style.fontSize = Math.max(22, parseFloat(getComputedStyle(el).fontSize) * ((have - fixed) / el.scrollWidth) * 0.96) + 'px';
  }
}
addEventListener('resize', () => fitBal());
function render() {
  document.documentElement.dataset.accent = st.theme;
  $('#lockBtn').hidden = !pinOn();
  document.documentElement.dataset.motion = st.motion === false ? 'off' : 'on';
  const m = mintOf(S.active);
  $('#mintName').textContent = m ? mintLabel(m) : 'No mint selected';
  $('#mintHost').textContent = m && m.nick ? host(m.url) : '';
  const units = m ? m.units || ['sat'] : ['sat'];
  const uc = $('#unitChip'); uc.textContent = unitLabel(S.unit); uc.hidden = units.length < 2; uc.disabled = units.length < 2;
  const p = st.hideAmounts ? { pre: '', value: HIDDEN, post: '' } : fmtParts(total(), S.unit);
  $('#balPre').textContent = p.pre; $('#balPost').textContent = p.post;
  scramble($('#bal'), p.value);
  fitBal();
  $('.balrow').setAttribute('aria-pressed', String(!!st.hideAmounts));
  $('#fiat').textContent = S.unit === 'sat' && st.fiat && !st.hideAmounts ? fiatOf(total('sat')) : '';
  btcPrice();
  $('#mintBal').textContent = S.mints.length > 1 && m && !st.hideAmounts ? `${fmt(bal(m.url))} at this mint` : '';
  // backup reminder: never backed up (or not for a month) once there's money and some history;
  // dismissing it waits a month. Not shown together with the Safari-tab warning.
  const MONTH = 30 * 864e5, now = Date.now();
  // mint risk: one mint holding more than the limit (sats). Dismissing waits until it grows by half again.
  const risky = st.mintWarn ? S.mints.find((x) => { const v = bal(x.url, 'sat'); return v > st.mintWarn && v > (x.riskAck || 0) * 1.5; }) : null;
  $('#riskWarn').hidden = !(risky && $('#tabWarn').hidden);
  if (risky && st.autoSpread) later(autoSpread);
  if (risky) { $('#riskText').textContent = `${mintLabel(risky)} holds ${st.hideAmounts ? HIDDEN : fmt(bal(risky.url, 'sat'), 'sat')}. A mint holds the bitcoin behind your ecash, so keep large amounts across a few mints you trust.`; $('#riskWarn').dataset.u = risky.url; }
  $('#bkWarn').hidden = !(S.mnemonic && $('#tabWarn').hidden && $('#riskWarn').hidden && (total('sat') >= 1000 || S.history.length >= 3) && total('sat') > 0
    && (!S.lastBackup || now - S.lastBackup > MONTH) && now - (st.backupNagged || 0) > MONTH);
  // motd
  const motd = m?.info?.motd;
  $('#motd').hidden = !(motd && motd !== m.motdSeen);
  if (motd) $('#motdText').textContent = motd;
  // log
  // folded history: just the "History ▸" line, for a clean main screen
  $('#histToggle').setAttribute('aria-expanded', String(!st.hideHistory));
  $('#logBody').hidden = !!st.hideHistory; $('#logTabs').hidden = !!st.hideHistory;
  const q = histQ.trim().toLowerCase();
  $('#histQ').hidden = S.history.length < 2 && !q;
  const list = S.history.filter((h) => !(h.split && h.status !== 'done')).filter((h) => logFilter === 'all' || (logFilter === 'pending' ? h.status === 'pending' : logFilter === 'ln' ? h.kind.startsWith('ln') || h.kind.startsWith('chain') : h.kind.startsWith('ecash')))
    .filter((h) => !q || q.split(/\s+/).every((w) => searchText(h).includes(w)));
  const shown = list.slice(0, logLimit);
  $('#moreHist').hidden = list.length <= logLimit;
  $$('#logTabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.f === logFilter));
  $('#hist').innerHTML = shown.map((h) => {
    const out = h.kind.endsWith('out');
    const [verb, via] = kindOf(h);
    const open = h.kind === 'ecash-out' && h.status === 'pending';
    const claim = h.kind === 'ecash-in' && h.status === 'pending';
    if (h.live) {
      const title = h.method === 'onchain' ? 'Deposit address' : 'Lightning offer';
      return `<li><button class="row s-live" data-id="${esc(h.id)}">
      <span class="ri in" aria-hidden="true">↓</span>
      <span class="rt"><b>${title}</b><small><span>${stamp(h.ts)}</span>${h.note ? ' · <span dir="auto">✎ ' + esc(h.note) + '</span>' : h.memo ? ' · <span dir="auto">' + esc(h.memo) + '</span>' : ''}</small></span>
      <span class="ra"><span class="amtv in">${st.hideAmounts ? HIDDEN : '+' + esc(fmt(h.received || 0, h.unit || 'sat'))}</span><em class="pill p-live">Reusable</em></span></button></li>`;
    }
    const stx = h.vault ? (h.status === 'pending' ? `🔒 ${vaultDay(h.refundAt)}` : h.status === 'returned' ? I18N.t('Unlocked') : STATUS[h.status] ?? '') : open ? 'Unclaimed' : claim ? 'Tap to claim' : STATUS[h.status] ?? '';
    const sub = h.note ? '✎ ' + h.note : h.kind === 'chain-out' && h.memo === h.request ? '' : h.memo;
    return `<li><button class="row s-${esc(h.status)}" data-id="${esc(h.id)}">
      <span class="ri ${out ? 'out' : 'in'}" aria-hidden="true">${out ? '↑' : '↓'}</span>
      <span class="rt"><b>${verb} · ${via}</b><small><span>${stamp(h.ts)}</span>${sub ? ' · <span dir="auto">' + esc(sub) + '</span>' : ''}</small></span>
      <span class="ra"><span class="amtv ${out ? 'out' : 'in'}">${st.hideAmounts ? HIDDEN : (out ? '−' : '+') + esc(fmt(h.amount, h.unit || 'sat'))}</span>${stx ? `<em class="pill p-${h.vault && h.status === 'pending' ? 'vault' : open || claim ? 'open' : esc(h.status)}">${esc(stx)}</em>` : ''}</span></button></li>`;
  }).join('');
  $('#empty').hidden = list.length > 0;
  $('#sumBtn').hidden = !S.history.some(counted);
  if (splitRefresh) splitRefresh();
  const vs = vaults(), vc = $('#vaultChip');
  vc.hidden = !vs.length;
  if (vs.length) vc.textContent = `🔒 ${st.hideAmounts ? HIDDEN : fmt(vs.reduce((t, h) => t + h.amount, 0), 'sat')} ${I18N.t('in the time vault')}`;
  $('#chkAll').hidden = !(logFilter === 'pending' && list.length);
  $('#empty').textContent = q ? 'No matches.' : S.history.length ? 'Nothing in this view.' : 'No transactions yet. Receive some ecash or top up over Lightning.';
}

// big sends: with a PIN set, ask for it (or Face ID) before more than st.confirmOver sats leave
async function bigOk(amount, unit = S.unit) {
  const sats = unit === 'sat' ? amount : unit === 'msat' ? amount / 1000 : 0;
  if (!st.confirmOver || !pinOn() || sats <= st.confirmOver) return true;
  return L.authorize(`Sending ${fmt(amount, unit)}`);
}
// hidden amounts (like cashu.me): tap the balance to switch
const HIDDEN = '••••';
// history search: notes, memos, amounts (as shown and as plain digits), kind, status and mint
let histQ = '';
function searchText(h) {
  const [verb, via] = KIND[h.kind] || ['', ''];
  return [I18N.t(verb), I18N.t(via), verb, via, h.note, h.memo, fmt(h.amount || h.received || 0, h.unit || 'sat'), String(h.amount || h.received || 0), I18N.t(STATUS[h.status] || ''), host(h.mint || '')].filter(Boolean).join(' ').toLowerCase();
}

/* ================= sheet system ================= */
let open = false, locked = false, onClose = null, lastFocus = null, flushNote = null;
function sheet(title, html, mount, opts = {}) {
  locked = !!opts.locked; shownDetail = null;
  if (flushNote) { const f = flushNote; flushNote = null; f(); }
  if (onClose) { const f = onClose; onClose = null; f(); }
  const body = $('#sheetBody');
  body.innerHTML = `<div class="bar">${opts.back ? '<button class="back" aria-label="Back">‹</button>' : ''}<h2 id="sheetTitle" tabindex="-1">${esc(title)}</h2>${locked ? '' : '<button class="x" aria-label="Close">✕</button>'}</div><div class="sb">${html}</div>`;
  const x = $('.x', body); if (x) x.onclick = () => closeSheet();
  const bk = $('.back', body); if (bk) bk.onclick = opts.back;
  if (!open) {
    history.pushState({ sheet: 1 }, ''); open = true; $('#sheet').hidden = false; requestAnimationFrame(() => $('#sheet').classList.add('on'));
    // keyboard and screen readers stay inside the panel; the page behind is out of reach until it closes
    lastFocus = document.activeElement; $('.app').inert = true;
  }
  body.scrollTop = 0;
  bindKeypads(body);
  mount && mount(body);
  $('#sheetTitle', body).focus({ preventScroll: true });
}
function closeSheet(fromPop) {
  if (!open) return;
  if (locked) { if (fromPop) history.pushState({ sheet: 1 }, ''); return; }
  open = false;
  if (flushNote) { const f = flushNote; flushNote = null; f(); }
  if (onClose) { const f = onClose; onClose = null; f(); }
  $('.app').inert = false;
  if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true }); lastFocus = null;
  $('#sheet').classList.remove('on');
  setTimeout(() => { if (!open) { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; } }, 220);
  if (!fromPop) history.back();
  render();
}
addEventListener('popstate', () => { if (open) closeSheet(true); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#scanner').hidden) stopScan(); else closeSheet(); } });

const seg = (items, which) => `<div class="seg" role="tablist">${items.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${k === which}">${l}</button>`).join('')}</div>`;
function bindSeg(b, onSwitch) {
  $$('.seg button', b).forEach((t) => (t.onclick = () => {
    $$('.seg button', b).forEach((x) => x.setAttribute('aria-selected', x === t));
    $$('.pane', b).forEach((p) => (p.hidden = p.dataset.p !== t.dataset.t));
    onSwitch && onSwitch(t.dataset.t);
  }));
}
const bigAmt = (n, unit, sign = '') => { const p = fmtParts(n, unit); return `${sign}${esc(p.pre)}${esc(p.value)}${p.post ? ` <small>${esc(p.post)}</small>` : ''}`; };
const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const armor = (t) => `<pre class="armor"><span>-----BEGIN CASHU TOKEN-----</span>\n${esc(t)}\n<span>-----END CASHU TOKEN-----</span></pre>`;
const toggle = (id, label, desc, on) => `<label class="tg"><span class="tgt"><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i aria-hidden="true"></i></label>`;
// every switch says what it just did ("Sounds: on"); runs before the switch's own handler, so a
// handler with its own message (an error, "Mint list backed up") still has the last word
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.matches?.('.tg input[type=checkbox]') || !el.closest('#sheet')) return;
  const name = el.closest('.tg').querySelector('b')?.textContent || '';
  if (name) toast(`${name}: ${el.checked ? 'on' : 'off'}`);
}, true);
const needMint = () => { if (!S.active) { mintsSheet(true); return true; } return false; };

/* ================= onboarding ================= */
const SLIDES = [
  ['Ecash is digital cash', 'Tokens you hold on your device, like notes in a wallet. Payments are private: the mint can’t see who pays whom.'],
  ['Mints hold the bitcoin', 'A mint issues ecash against bitcoin it keeps. You trust the mint with your funds, so pick carefully and start small.'],
  ['Your seed is your backup', 'A 12-word phrase can restore your ecash if you lose this device. Write it down and keep it offline.'],
];
function welcome(i = 0, replay = false) {
  if (i < SLIDES.length) {
    const [h, p] = SLIDES[i];
    return sheet(`${i + 1} / ${SLIDES.length}`, `${i === 0 ? `<pre class="ascii" aria-hidden="true"> _     _ _           _     _
| |__ | (_)_ __   __| |___(_) __ _
| '_ \\| | | '_ \\ / _\` / __| |/ _\` |
| |_) | | | | | | (_| \\__ \\ | (_| |
|_.__/|_|_|_| |_|\\__,_|___/_|\\__, |
                             |___/</pre>` : ''}
      <h3 class="slh">${h}</h3><p class="lead">${p}</p>
      <div class="dots">${SLIDES.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <button class="btn primary wide" id="nx">Next</button>${i > 0 ? '<button class="btn wide" id="pv">Back</button>' : ''}`, (b) => {
      $('#nx', b).onclick = () => welcome(i + 1, replay);
      const pv = $('#pv', b); if (pv) pv.onclick = () => welcome(i - 1, replay);
    }, { locked: !replay });
  }
  if (replay) { locked = false; return closeSheet(); }
  sheet('Set up', `<p class="lead">Create a new wallet, or restore one from your seed phrase.</p>
    <button class="btn primary wide" id="nw">Create new wallet</button>
    <button class="btn wide" id="rs">Restore from seed phrase</button>
    <button class="btn wide" id="rf">Restore from backup file</button>
    <p class="dim small">Keys are generated on this device and never leave it.</p>`, (b) => {
    $('#nw', b).onclick = () => showSeed(generateMnemonic(wordlist, 128), true);
    $('#rs', b).onclick = () => restoreSheet(true);
    $('#rf', b).onclick = () => backupRestoreSheet(true);
  }, { locked: true });
}
const seedGrid = (m) => `<ol class="seed">${m.split(' ').map((w, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${esc(w)}</li>`).join('')}</ol>`;
function showSeed(m, isNew, back) {
  sheet('Seed phrase', `<p>${isNew ? 'Write these 12 words down in order and keep them offline. They restore your ecash if this device is lost.' : 'Anyone with these words can take your ecash. Never share them.'}</p>
    ${seedGrid(m)}
    ${isNew ? `<label class="chk"><input type="checkbox" id="ok"> I wrote it down</label><button class="btn primary wide" id="go" disabled>Continue</button>`
    : '<button class="btn wide" id="cp">Copy seed phrase</button>'}`, (b) => {
    if (isNew) {
      $('#ok', b).onchange = (e) => ($('#go', b).disabled = !e.target.checked);
      $('#go', b).onclick = () => { C.setSeed(m); S.onboarded = true; save(); if (!claimPending()) mintsSheet(true); };
    } else $('#cp', b).onclick = () => copy(m, 'Seed copied. Clear your clipboard after.');
  }, { locked: isNew, back });
}
let restoring = false;
function restoreSheet(onboarding) {
  sheet('Restore', `<p>Enter your 12 or 24 word seed phrase.</p>
    <textarea id="words" rows="4" placeholder="word1 word2 word3 …" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
    <p class="hint" id="wh">&nbsp;</p>
    <button class="btn primary wide" id="go" disabled>Restore</button>`, (b) => {
    const ta = $('#words', b), go = $('#go', b);
    const norm = () => ta.value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
    ta.oninput = () => {
      const n = norm().split(' ').filter(Boolean).length, ok = validateMnemonic(norm(), wordlist);
      $('#wh', b).textContent = ok ? '✓ Valid phrase' : `${n} words${n === 12 || n === 24 ? ' · checksum doesn’t match' : ''}`;
      go.disabled = !ok;
    };
    go.onclick = () => { C.setSeed(norm()); S.onboarded = true; save(); restoring = true; mintsSheet(true); };
  }, { locked: onboarding, back: onboarding ? () => welcome(SLIDES.length) : undefined });
}
function restoreRun(urls, mnemonic, afterBackup) {
  sheet(afterBackup ? 'Checking your mints' : 'Restoring', `${afterBackup ? '<p class="dim small">Your backup is loaded. Now checking which ecash is still unspent and picking up anything newer than the backup.</p>' : ''}<pre class="term" id="lg"></pre><button class="btn primary wide" id="dn" disabled>Done</button>`, async (b) => {
    const lg = $('#lg', b), log = (s) => { lg.textContent += '> ' + s + '\n'; lg.scrollTop = lg.scrollHeight; };
    const got = {};
    if (afterBackup) {
      log('checking for spent ecash');
      try { const r = await C.sweepSpent(); log(r ? `removed ${fmt(r)} already spent` : 'all ecash is unspent'); } catch (e) { log('error: ' + niceErr(e)); }
    }
    for (const u of urls) {
      log('mint ' + host(u));
      try { const r = await C.restoreMint(u, mnemonic || S.mnemonic, log); for (const [k, v] of Object.entries(r)) got[k] = (got[k] || 0) + v; } catch (e) { log('error: ' + niceErr(e)); }
    }
    const parts = Object.entries(got).filter(([, v]) => v).map(([k, v]) => fmt(v, k));
    log(`done · restored ${parts.length ? parts.join(' + ') : 'nothing'}`);
    restoring = false; render();
    const dn = $('#dn', b); dn.disabled = false; dn.onclick = () => { locked = false; closeSheet(); claimPending(); };
  }, { locked: true });
}

/* ================= receive ================= */
function receiveSheet(tab = 'ecash', prefill = '') {
  if (needMint()) return;
  const k = C.currentP2pk();
  const tabs = [['ecash', 'Ecash'], ['ln', 'Lightning'], ['req', 'Request']];
  const chain = C.supports(S.active, 'mint', 'onchain'), b12 = C.supports(S.active, 'mint', 'bolt12');
  if (chain) tabs.splice(2, 0, ['btc', 'Bitcoin']);
  if (st.p2pkQuick && k) tabs.push(['lock', 'Lock key']);
  sheet('Receive', `${seg(tabs, tab)}
    <div class="pane" data-p="ecash" ${tab !== 'ecash' ? 'hidden' : ''}>
      <textarea id="tok" rows="4" placeholder="Paste a cashu token" spellcheck="false" autocapitalize="off"></textarea>
      <div class="btnrow"><button class="btn" id="pst">Paste</button><button class="btn" id="scn">Scan</button>${st.nfcQuick && 'NDEFReader' in window ? '<button class="btn" id="nfc">NFC</button>' : ''}</div>
      <div id="prev"></div>
      <button class="btn primary wide" id="rcv" disabled>Receive</button>
      <div id="swpbox" hidden><label class="lbl" for="swto">Swap to mint</label><select id="swto" class="field"></select>
      <p class="dim small">This swap will incur Lightning network fees.</p><button class="btn wide" id="swp">Swap</button></div>
      <button class="btn wide" id="later" hidden>Receive later</button>
    </div>
    <div class="pane" data-p="ln" ${tab !== 'ln' ? 'hidden' : ''}>
      ${S.npc.enabled && S.npc.showOnReceive && S.npc.address ? `<div class="addrcard"><small class="dim">Your Lightning address</small><b>${esc(S.npc.address)}</b><div class="btnrow"><button class="btn" id="cpa">Copy</button><button class="btn" id="qra">QR code</button><button class="btn" id="tjb">Tip jar</button></div><div id="aq"></div></div><p class="dim small center">Or create a one-time invoice:</p>` : ''}
      ${amountField('amt', `Into ${esc(mintLabel(mintOf(S.active)))}`)}
      <input id="desc" class="field" placeholder="Description (optional)" maxlength="80">
      ${b12 ? '<label class="chk"><input type="checkbox" id="b12"> <span>Reusable offer (BOLT12)</span></label>' : ''}
      <button class="btn primary wide" id="inv">Create invoice</button>
      <p class="center small lnks"><button class="lnk" id="spl">Split a bill</button><button class="lnk" id="tjl">Make a tip jar card</button></p>
    </div>
    ${chain ? `<div class="pane" data-p="btc" ${tab !== 'btc' ? 'hidden' : ''}>
      <p class="dim">Deposit bitcoin on-chain. The mint credits ecash after the transaction confirms.</p>
      ${amountField('camt', 'Optional amount for the QR code')}
      ${limitNote(chain)}
      <button class="btn primary wide" id="addr">Get deposit address</button>
    </div>` : ''}
    <div class="pane" data-p="req" ${tab !== 'req' ? 'hidden' : ''}>
      <p class="dim">A payment request (NUT-18) lets someone pay you ecash over nostr, even when you’re not online at the same time.</p>
      <button class="btn primary wide" id="nreq">Create payment request</button>
      ${S.pr.requests[0] ? '<button class="btn wide" id="lreq">Show last request</button>' : ''}
    </div>
    ${st.p2pkQuick && k ? `<div class="pane" data-p="lock" ${tab !== 'lock' ? 'hidden' : ''}>
      <p class="dim">Share this key. Ecash locked to it can only be redeemed by this wallet.</p>
      <div class="qrwrap" id="pkq"></div><pre class="armor sm">${esc(k.pub)}</pre>
      <button class="btn wide" id="pkc">Copy key</button></div>` : ''}`, (b) => {
    bindSeg(b, (t) => { if (t === 'ecash') autoPaste(); });
    const ta = $('#tok', b), rcv = $('#rcv', b), swp = $('#swp', b);
    let parsed = null, seq = 0;
    ta.oninput = async () => {
      parsed = null; rcv.disabled = true; $('#swpbox', b).hidden = true; $('#later', b).hidden = true; $('#prev', b).innerHTML = '';
      if (!ta.value.trim()) return;
      try { parsed = C.parseToken(ta.value); } catch { $('#prev', b).innerHTML = '<p class="warn">That isn’t a valid cashu token.</p>'; return; }
      const known = mintOf(parsed.mint), me = ++seq;
      const draw = (lock) => {
        $('#prev', b).innerHTML = (isGiftMemo(parsed.memo) ? giftBanner(parsed) : '') + kv([['Amount', `<b>${esc(fmt(parsed.amount, parsed.unit))}</b>`], ['Mint', esc(host(parsed.mint))], parsed.memo && !isGiftMemo(parsed.memo) && ['Memo', esc(parsed.memo)],
          lock && lock.locked && ['Lock', lock.mine ? '✓ Locked to your key' : '<span class="warnt">Locked to someone else</span>'],
          lock && lock.until && ['Claim by', `${esc(whenShort(lock.until))}<br><small class="dim">After that it goes back to the sender.</small>`]])
          + (known ? '' : '<p class="warn">Unknown mint. Receiving adds it to your wallet. Only accept ecash from mints you trust.</p>');
      };
      draw();
      rcv.textContent = known ? 'Receive' : 'Trust mint and receive';
      rcv.disabled = false;
      $('#later', b).hidden = false;
      const targets = S.mints.filter((m) => m.url !== parsed.mint && (m.units || ['sat']).includes(parsed.unit));
      if (st.receiveSwaps && targets.length) { $('#swpbox', b).hidden = false; $('#swto', b).innerHTML = targets.map((m) => `<option value="${esc(m.url)}" ${m.url === S.active ? 'selected' : ''}>${esc(mintLabel(m))}</option>`).join(''); }
      C.tokenLockInfo(parsed).then((lock) => { if (me === seq) { parsed.lockKeys = lock.keys; draw(lock); } }).catch(() => {});
    };
    $('#pst', b).onclick = () => pasteInto(ta);
    $('#scn', b).onclick = () => startScan((t) => { ta.value = t; ta.oninput(); });
    const nfc = $('#nfc', b); if (nfc) nfc.onclick = () => nfcRead((t) => { ta.value = t; ta.oninput(); });
    rcv.onclick = withBusy(rcv, async () => done(await C.receiveEcash(parsed), 'Received'));
    swp.onclick = withBusy(swp, async () => done(await C.swapIncoming(parsed, $('#swto', b).value), 'Swapped in'));
    $('#later', b).onclick = () => {
      if (S.history.some((h) => h.kind === 'ecash-in' && h.token === parsed.str)) return toast('Ecash already in history', 'warn');
      C.H({ kind: 'ecash-in', amount: parsed.amount, unit: parsed.unit, mint: parsed.mint, status: 'pending', token: parsed.str, memo: parsed.memo || 'receive later' });
      toast('Ecash added to history'); closeSheet();
    };
    const autoPaste = async () => {
      // iPhone shows a Paste bubble for every clipboard read, which blocks the page until it's tapped
      if (!st.autoPaste || ta.value || FX.isIOS) return;
      try { const t = (await navigator.clipboard.readText()).trim(); if (/^(cashu:)?cashu[AB]/i.test(t) || C.hasEmojiToken(t)) { ta.value = t; ta.oninput(); } } catch {}
    };
    if (prefill) { ta.value = prefill; ta.oninput(); } else if (tab === 'ecash') autoPaste();
    const ib = $('#inv', b);
    ib.onclick = withBusy(ib, async () => {
      const a = readAmt(b);
      const desc = $('#desc', b).value.trim() || undefined;
      if ($('#b12', b)?.checked) return liveView(await C.createOffer(a || 0, S.active, S.unit, desc));
      if (!a) return nope('Enter an amount.');
      invoiceView(await C.createInvoice(a, S.active, S.unit, desc));
    });
    const ad = $('#addr', b);
    if (ad) ad.onclick = withBusy(ad, async () => liveView(await C.createDepositAddress(S.active, S.unit, readAmt(b, 'camt'))));
    const tjb = $('#tjb', b); if (tjb) tjb.onclick = () => tipSheet();
    $('#tjl', b).onclick = () => tipSheet();
    $('#spl', b).onclick = () => splitHome();
    const cpa = $('#cpa', b); if (cpa) { cpa.onclick = () => copy(S.npc.address, 'Address copied'); $('#qra', b).onclick = () => qrSvg('lightning:' + S.npc.address).then((s) => { $('#aq', b).innerHTML = `<div class="qr">${s}</div>`; }); N.npcSync().then((n) => n && render()).catch(() => {}); }
    $('#nreq', b).onclick = () => NU.newRequest(() => receiveSheet('req'));
    const lreq = $('#lreq', b); if (lreq) lreq.onclick = () => NU.showRequest(S.pr.requests[0], () => receiveSheet('req'));
    if (st.p2pkQuick && k) { qrSvg(k.pub).then((s) => { const q = $('#pkq', b); if (q) q.innerHTML = `<div class="qr">${s}</div>`; }); $('#pkc', b).onclick = () => copy(k.pub, 'Key copied'); }
  });
}
function invoiceView(h) {
  sheet('Invoice', `<div class="qr" id="iq"></div>
    <p class="big">${bigAmt(h.amount, h.unit)}</p>
    <p class="wait" id="ws">Waiting for payment<span class="cur">_</span></p>
    <button class="btn wide" id="cp">Copy invoice</button>
    <button class="btn wide" id="ck">Check now</button>
    <p class="dim small center">Safe to close. Pending invoices are checked again later.</p>`, (b) => {
    addNote(b, h);
    qrInvoice($('#iq', b), h.request);
    $('#cp', b).onclick = () => copy(h.request, 'Invoice copied');
    let timer, dead = false;
    const ctrl = new AbortController();
    const finish = (s) => { if (dead) return; if (s === 'done') { dead = true; done(h, 'Received'); } else if (s === 'expired') $('#ws', b).textContent = 'Invoice expired.'; };
    const ck = $('#ck', b);
    ck.onclick = withBusy(ck, async () => { const s = await C.checkInvoice(h); if (s === 'pending') toast('Not paid yet.', 'warn'); finish(s); });
    if (st.websockets && mintOf(h.mint)?.info?.nut17) C.waitInvoiceWs(h, ctrl.signal).then(finish).catch(() => {});
    if (st.checkIncoming) {
      const tick = async () => { if (dead) return; try { const s = await C.checkInvoice(h); finish(s); if (s !== 'pending') return; } catch {} timer = setTimeout(tick, st.websockets ? 6000 : 2500); };
      timer = setTimeout(tick, 2000);
    }
    onClose = () => { dead = true; clearTimeout(timer); ctrl.abort(); };
  });
}

function limitNote(m) {
  if (!m || (m.min == null && m.max == null)) return '';
  const f = (v) => fmt(v);
  const t = m.min != null && m.max != null ? `Deposits outside ${f(m.min)}–${f(m.max)} won’t be credited.` : m.min != null ? `Deposits below ${f(m.min)} won’t be credited.` : `Deposits above ${f(m.max)} won’t be credited.`;
  return `<p class="warn small">${esc(t)}</p>`;
}
// reusable receive targets: BOLT12 offers and on-chain deposit addresses
function liveView(h) {
  const chain = h.method === 'onchain';
  const qrText = chain ? `bitcoin:${h.request}${h.requested ? `?amount=${(h.requested / 1e8).toFixed(8)}` : ''}` : h.request.toUpperCase();
  sheet(chain ? 'Deposit address' : 'Lightning offer', `<div class="qr" id="lq"></div>
    ${h.amount && !chain ? `<p class="big">${bigAmt(h.amount, h.unit)}</p>` : h.requested ? `<p class="big">${bigAmt(h.requested, h.unit)}</p>` : ''}
    <pre class="armor sm">${esc(h.request)}</pre>
    <p class="wait" id="ws">${chain ? 'Waiting for a deposit' : 'Waiting for payment'}<span class="cur">_</span></p>
    ${kv([['Received so far', `<b id="rsf">${esc(fmt(h.received || 0, h.unit))}</b>`], ['Reusable', chain ? 'Yes, send more anytime' : 'Yes, pay as often as you like']])}
    ${chain ? limitNote(C.supports(h.mint, 'mint', 'onchain', h.unit)) : ''}
    <button class="btn wide" id="cp">${chain ? 'Copy address' : 'Copy offer'}</button>
    <button class="btn wide" id="ck">Check now</button>
    <p class="dim small center">${chain ? 'On-chain deposits need confirmations before the mint credits them.' : 'Safe to close. The offer keeps working.'}</p>`, (b) => {
    addNote(b, h);
    qrSvg(qrText).then((x) => { const q = $('#lq', b); if (q) q.innerHTML = x; });
    $('#cp', b).onclick = () => copy(h.request, chain ? 'Address copied' : 'Offer copied');
    let timer, dead = false, seen = h.received || 0;
    const update = () => { const r = $('#rsf', b); if (r) r.textContent = fmt(h.received || 0, h.unit); if ((h.received || 0) > seen) { toast(`Received ${fmt(h.received - seen, h.unit)}`); FX.success('received'); seen = h.received; render(); } };
    const ck = $('#ck', b);
    ck.onclick = withBusy(ck, async () => { await C.checkInvoice(h); update(); if ((h.received || 0) === seen) toast('Nothing new yet.', 'warn'); });
    const tick = async () => { if (dead || !h.live) return; try { await C.checkInvoice(h); update(); } catch {} timer = setTimeout(tick, chain ? 15000 : 4000); };
    if (st.checkIncoming) timer = setTimeout(tick, 3000);
    onClose = () => { dead = true; clearTimeout(timer); };
  });
}

/* ================= send ================= */
function sendSheet(tab = 'ecash', prefill = '') {
  if (needMint()) return;
  const have = bal(S.active);
  sheet('Send', `${seg([['ecash', 'Ecash'], ['ln', 'Lightning']], tab)}
    <div class="pane" data-p="ecash" ${tab !== 'ecash' ? 'hidden' : ''}>
      ${amountField('amt', `Available: ${esc(fmt(have))}`)}
      <input id="memo" class="field" placeholder="Memo (optional)" maxlength="80" autocomplete="off">
      <label class="chk"><input type="checkbox" id="off"> <span>Send offline (exact amount only, no mint contact)</span></label>
      <details class="more" id="lockBox"><summary>Lock to one person (P2PK)</summary>
        ${keyContacts().length ? `<div class="cts" role="list" aria-label="Contacts">${keyContacts().map((c) => `<button type="button" role="listitem" class="ctc" data-k="${esc(c.npub)}"><b dir="auto">${esc(c.name)}</b></button>`).join('')}</div>` : ''}
        <input id="lock" class="field" placeholder="Public key or npub" autocomplete="off" autocapitalize="off" spellcheck="false">
        <p class="hint">Only the holder of the matching private key can redeem it.</p>
        ${mintOf(S.active)?.info?.nut11 === false ? '<p class="warn small">This mint doesn’t support locked ecash.</p>' : `<label class="lbl" for="ret">If they don’t claim it, send it back to me after</label>
        <select id="ret" class="field">${RETURN_AFTER.map(([v, l]) => `<option value="${v}" ${v === 864e5 ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <p class="hint">Until then only they can claim it. Afterwards it comes back to you automatically.</p>`}</details>
      <button class="btn primary wide" id="mk">Create token</button>
      <button class="btn wide" id="gft"><span aria-hidden="true">🎁</span> Make a gift card</button>
    </div>
    <div class="pane" data-p="ln" ${tab !== 'ln' ? 'hidden' : ''}>
      ${S.contacts?.length ? `<div class="cts" role="list" aria-label="Contacts">${[...S.contacts].sort((p, q) => (q.last || 0) - (p.last || 0)).slice(0, 8).map((c) => `<button role="listitem" class="ctc" data-id="${esc(c.id)}"><b dir="auto">${esc(c.name)}</b></button>`).join('')}${S.contacts.length > 8 ? '<button class="ctc more" id="ctAll">All contacts</button>' : ''}</div>` : ''}
      <textarea id="ln" rows="3" placeholder="Invoice, address, LNURL, offer, request or bitcoin address" spellcheck="false" autocapitalize="off"></textarea>
      <div class="btnrow"><button class="btn" id="pst">Paste</button><button class="btn" id="scn">Scan</button></div>
      <div id="lnx"></div>
      <button class="btn primary wide" id="pay" disabled>Continue</button>
    </div>`, (b) => {
    bindSeg(b);
    const mk = $('#mk', b);
    mk.onclick = withBusy(mk, async () => {
      const a = readAmt(b); if (!a) return nope('Enter an amount.');
      const lockRaw = $('#lock', b).value.trim();
      const lockTo = lockRaw ? C.parsePubkey(lockRaw) : undefined;
      const offline = $('#off', b).checked;
      if (lockTo && offline) return nope('Locked ecash can’t be sent offline. Turn off offline mode.');
      if (lockTo && mintOf(S.active)?.info?.nut11 === false) return nope('This mint doesn’t support locked ecash.');
      if (!(await bigOk(a))) return;
      const returnAfter = lockTo ? +($('#ret', b)?.value || 0) : 0;
      let h;
      try { h = await C.sendEcash(a, { memo: $('#memo', b).value.trim() || undefined, lockTo, returnAfter, offline }); }
      catch (e) { if (offline) throw new Error('No exact match for offline sending. Turn off offline mode or pick another amount.'); throw e; }
      render(); tokenView(h); C.watchSent(sentClaimed);
      FX.play('sent'); FX.buzz('sent'); // money leaving: the send sound, no confetti
    });
    $$('#lockBox .ctc', b).forEach((x) => (x.onclick = () => { $('#lock', b).value = x.dataset.k; $$('#lockBox .ctc', b).forEach((y) => y.classList.toggle('on', y === x)); }));
    $('#gft', b).onclick = () => giftSheet(readAmt(b), $('#memo', b).value.trim());
    const ln = $('#ln', b), pay = $('#pay', b), x = $('#lnx', b);
    let stage = null, quote = null, meta = null, label = '', invoice = '', req = null, chainInfo = null, method = 'bolt11', feeIndex;
    const setPay = (t, dis = false) => later(() => { pay.textContent = t; pay.disabled = dis; });
    ln.oninput = () => {
      const v = ln.value.trim().replace(/^lightning:/i, '');
      stage = quote = meta = null; x.innerHTML = '';
      chainInfo = C.parseBitcoin(v);
      if (chainInfo && (chainInfo.lightning || chainInfo.lno)) { ln.value = chainInfo.lightning || chainInfo.lno; return ln.oninput(); }
      if (chainInfo) { stage = 'chain'; label = chainInfo.address; }
      else if (C.isOffer(v)) { stage = 'offer'; label = 'BOLT12 offer'; }
      else if (N.isRequest(v)) { stage = 'creq'; label = 'payment request'; }
      else if (C.isInvoice(v)) { stage = 'invoice'; label = ''; }
      else if (C.isAddress(v) || C.isLnurl(v)) { stage = 'lnurl'; label = C.isAddress(v) ? v.toLowerCase() : 'LNURL'; }
      else if (isNpub(v)) { stage = 'npub'; label = 'nutzap'; }
      pay.textContent = 'Continue'; pay.disabled = !stage;
    };
    const showQuote = () => {
      const a = quote.amount.toNumber(), f = quote.fee_reserve.toNumber(), haveNow = bal(S.active);
      const short = a + f > haveNow;
      const others = S.mints.filter((m) => m.url !== S.active && (m.units || []).includes(S.unit) && bal(m.url) > 0);
      x.innerHTML = kv([label && ['To', esc(label)], ['Amount', esc(fmt(a))], ['Lightning fee', `up to ${esc(fmt(f))}`], ['Total', `<b>${esc(fmt(a + f))}</b>`], ['Balance', esc(fmt(haveNow))]])
        + (short ? '<p class="warn">Not enough at this mint.</p>' : '<p class="dim small">Unused fee reserve comes back as change.</p>')
        + (method === 'bolt11' && st.multinut && others.length && mintOf(S.active)?.info?.nut15 ? '<button class="btn wide" id="mn">Pay from several mints (Multinut)</button>' : '');
      stage = 'pay'; setPay(`Pay ${fmt(a)}`, short);
      const mn = $('#mn', b); if (mn) mn.onclick = () => multinutSheet(invoice, a);
    };
    pay.onclick = withBusy(pay, async () => {
      const v = ln.value.trim().replace(/^lightning:/i, '');
      if (isNpub(v)) return nutzapSheet(v);
      if (stage === 'offer' || stage === 'chain') {
        const kind = stage === 'offer' ? 'bolt12' : 'onchain';
        if (!C.supports(S.active, 'melt', kind)) return toast(kind === 'bolt12' ? 'This mint can’t pay BOLT12 offers.' : 'This mint can’t send on-chain.', 'err');
        x.innerHTML = amountField('oamt', kind === 'bolt12' ? 'Leave empty if the offer has an amount' : `Available: ${esc(fmt(bal(S.active)))}`) + (kind === 'onchain' ? limitNote(C.supports(S.active, 'melt', 'onchain')) : '');
        bindKeypads(x);
        if (chainInfo?.sats) $('#oamt', b).value = String(chainInfo.sats);
        stage = stage === 'offer' ? 'offeramt' : 'chainamt'; setPay('Get quote'); return;
      }
      if (stage === 'offeramt') { method = 'bolt12'; quote = await C.quoteOffer(v, readAmt(b, 'oamt')); return showQuote(); }
      if (stage === 'chainamt') {
        const a = readAmt(b, 'oamt'); if (!a) return nope('Enter an amount.');
        method = 'onchain'; quote = await C.quoteOnchain(chainInfo.address, a);
        const opts = quote.fee_options || [];
        feeIndex = opts[0]?.fee_index;
        x.innerHTML = kv([['To', `<code>${esc(chainInfo.address)}</code>`], ['Amount', esc(fmt(quote.amount.toNumber()))]])
          + '<h3>Network fee</h3>' + opts.map((o, i) => `<label class="radio"><input type="radio" name="fee" value="${o.fee_index}" ${i === 0 ? 'checked' : ''}><span class="mt"><b>${esc(fmt(o.fee_reserve.toNumber()))}</b><small>${`~${o.estimated_blocks} blocks`}</small></span></label>`).join('')
          + `<p class="dim small">Balance: ${esc(fmt(bal(S.active)))}</p>`;
        $$('input[name=fee]', x).forEach((r) => (r.onchange = () => { feeIndex = +r.value; }));
        stage = 'pay'; setPay(`Pay ${fmt(quote.amount.toNumber())}`); return;
      }
      if (stage === 'creq') {
        req = N.decodeRequest(v);
        const okMint = N.requestMintOk(req, S.active), fee = okMint ? N.requestFee(req, S.active) : 0;
        const alt = req.mints.find((u) => mintOf(u));
        const short = req.amount && req.amount + fee > bal(S.active);
        x.innerHTML = kv([['Amount', req.amount ? `<b>${esc(fmt(req.amount, req.unit))}</b>` : 'Payer chooses'], fee && ['Fee from this mint', esc(fmt(fee, req.unit))], fee && req.amount && ['Total', `<b>${esc(fmt(req.amount + fee, req.unit))}</b>`], req.memo && ['For', `<span dir="auto">${esc(req.memo)}</span>`], ['Mints', req.mints.length ? esc(req.mints.map(host).join(', ')) + (req.strict ? '' : ' (preferred)') : 'Any'], req.lock && ['Locked to', esc(req.lock.slice(0, 14)) + '…'], ['Delivery', req.transport ? (req.transport.type === 'post' ? 'HTTP POST' : 'nostr') : 'none']])
          + (req.unit !== S.unit ? `<p class="warn">This request is in ${esc(unitLabel(req.unit))}. Switch unit first.</p>` : '')
          + (okMint ? '' : `<p class="warn">The request only accepts ${esc(req.mints.map(host).join(', '))}.</p>${alt ? `<button class="btn wide" id="swm">Switch to ${esc(host(alt))}</button>` : ''}`)
          + (fee ? '<p class="dim small">This mint isn’t on the request’s list, so the recipient adds a fee to move the ecash to theirs.</p>' : '')
          + (short ? '<p class="warn">Not enough at this mint.</p>' : '')
          + (req.amount ? '' : amountField('ramt', `Available: ${esc(fmt(bal(S.active)))}`));
        bindKeypads(x);
        const swm = $('#swm', b); if (swm) swm.onclick = () => { C.selectMint(alt); render(); sendSheet('ln', v); };
        stage = 'creqpay'; setPay(req.amount ? `Pay ${fmt(req.amount + fee, req.unit)}` : 'Pay', !okMint || req.unit !== S.unit || short); return;
      }
      if (stage === 'creqpay') {
        const a = req.amount || readAmt(b, 'ramt'); if (!a) return nope('Enter an amount.');
        if (!(await bigOk(a + (N.requestMintOk(req, S.active) ? N.requestFee(req, S.active) : 0), req.unit))) return;
        const h = await N.payRequest(req, a); render(); done(h, 'Sent'); return;
      }
      if (stage === 'invoice') { method = 'bolt11'; invoice = v.toLowerCase(); quote = await C.quoteInvoice(invoice); return showQuote(); }
      if (stage === 'lnurl') {
        meta = await C.lnurlMeta(v);
        let desc = ''; try { desc = (JSON.parse(meta.metadata).find((e) => e[0] === 'text/plain') || [])[1] || ''; } catch {}
        x.innerHTML = `${desc ? `<p class="dim">${esc(desc)}</p>` : ''}${amountField('lamt', `${Math.ceil(meta.minSendable / 1000).toLocaleString()}–${Math.floor(meta.maxSendable / 1000).toLocaleString()} sat · have ${esc(fmt(bal(S.active), 'sat'))}`, 'sat')}
          ${meta.commentAllowed ? `<input id="cmt" class="field" placeholder="Comment (optional)" maxlength="${meta.commentAllowed}">` : ''}`;
        bindKeypads(x);
        stage = 'lnamt'; setPay('Get quote'); return;
      }
      if (stage === 'lnamt') {
        const a = readAmt(b, 'lamt'); if (!a) return nope('Enter an amount.');
        invoice = await C.lnurlInvoice(meta, a, $('#cmt', b)?.value.trim());
        quote = await C.quoteInvoice(invoice); return showQuote();
      }
      if (stage === 'pay') {
        const qa = Number(quote?.amount?.toNumber?.() ?? quote?.amount ?? 0) + Number(quote?.fee_reserve?.toNumber?.() ?? quote?.fee_reserve ?? 0);
        if (!(await bigOk(qa))) return;
        const h = await C.payInvoice(quote, label || undefined, S.active, S.unit, method, feeIndex);
        const target = reusableTarget(ln.value.trim().replace(/^lightning:/i, ''));
        const known = target && S.contacts.find((c) => c.to.toLowerCase() === target.toLowerCase());
        if (known) { known.last = Date.now(); save(); }
        if (h.status === 'done') done(h, 'Paid', target && !known ? target : undefined); else { toast(method === 'onchain' ? 'Transaction submitted. It confirms on-chain.' : 'Payment in flight. It will settle.', 'warn'); render(); closeSheet(); }
      }
    });
    $('#pst', b).onclick = () => pasteInto(ln);
    $('#scn', b).onclick = () => startScan((t) => { ln.value = t; ln.oninput(); later(() => pay.click()); });
    $$('.ctc[data-id]', b).forEach((x) => (x.onclick = () => { const c = S.contacts.find((y) => y.id === x.dataset.id); if (!c) return; ln.value = c.to; ln.oninput(); later(() => pay.click()); }));
    const cta = $('#ctAll', b); if (cta) cta.onclick = () => contactsSheet(() => sendSheet('ln'));
    if (prefill) { ln.value = prefill; ln.oninput(); later(() => pay.click()); }
  });
}
function multinutSheet(invoice, amount) {
  const ms = S.mints.filter((m) => (m.units || []).includes(S.unit) && bal(m.url) > 0 && m.info?.nut15);
  sheet('Multinut', `<p class="dim">Split ${esc(fmt(amount))} across mints. Each mint needs extra balance for its Lightning fee reserve.</p>
    <ul class="mn">${ms.map((m) => `<li><label class="chk"><input type="checkbox" data-u="${esc(m.url)}" checked><span class="mt"><b>${esc(mintLabel(m))}</b><small>${esc(fmt(bal(m.url)))} available</small></span></label><input class="field mnamt" data-u="${esc(m.url)}" inputmode="numeric"></li>`).join('')}</ul>
    <p class="hint" id="mh"></p>
    <button class="btn primary wide" id="go">Pay ${esc(fmt(amount))}</button>`, (b) => {
    const boxes = $$('input[type=checkbox]', b), fields = $$('.mnamt', b);
    const alloc = () => {
      const sel = boxes.filter((c) => c.checked).map((c) => c.dataset.u);
      const tot = sel.reduce((t, u) => t + bal(u), 0);
      let left = amount;
      fields.forEach((f) => { f.disabled = !sel.includes(f.dataset.u); f.value = ''; });
      sel.forEach((u, i) => { const share = i === sel.length - 1 ? left : Math.min(left, Math.floor((amount * bal(u)) / tot)); left -= share; $(`.mnamt[data-u="${CSS.escape(u)}"]`, b).value = share; });
      check();
    };
    const check = () => { const s = fields.filter((f) => !f.disabled).reduce((t, f) => t + (parseInt(f.value, 10) || 0), 0); $('#mh', b).textContent = s === amount ? '✓ Amounts add up' : `Parts add up to ${s} of ${amount}`; $('#go', b).disabled = s !== amount; };
    boxes.forEach((c) => (c.onchange = alloc)); fields.forEach((f) => (f.oninput = check));
    alloc();
    const go = $('#go', b);
    go.onclick = withBusy(go, async () => {
      const parts = fields.filter((f) => !f.disabled && parseInt(f.value, 10) > 0).map((f) => [f.dataset.u, parseInt(f.value, 10)]);
      if (!(await bigOk(amount))) return;
      const res = await C.payMultinut(invoice, parts);
      done({ kind: 'ln-out', amount, unit: S.unit, fee: res.reduce((t, h) => t + (h.fee || 0), 0) }, 'Paid');
    });
  }, { back: () => sendSheet('ln', invoice) });
}
function tokenView(h, fromLog) {
  const link = location.origin + location.pathname + '#token=' + h.token;
  let stop = () => {};
  sheet('Ecash token', `<div class="qrwrap" id="tq"></div>
    <p class="big">${bigAmt(h.amount, h.unit)}</p>
    ${h.fee ? `<p class="dim small center">Includes ${esc(fmt(h.fee, h.unit))} mint fee</p>` : ''}
    ${h.lockTo ? `<p class="dim small center">Locked to ${esc(lockName(h.lockTo))}</p>` : ''}
    ${h.refundAt && h.status === 'pending' ? `<p class="okline small center">If it isn’t claimed by ${esc(whenShort(h.refundAt))}, it comes back to you.</p>` : ''}
    ${armor(h.token)}
    <div class="btnrow"><button class="btn primary" id="cp">Copy</button><button class="btn" id="cl">Copy link</button><button class="btn" id="ce" aria-label="Copy as emoji" title="Copy as emoji"><span aria-hidden="true">🥜</span> Emoji</button>${navigator.share ? '<button class="btn" id="sh">Share</button>' : ''}</div>
    ${'NDEFReader' in window ? '<button class="btn wide" id="nfw">Write to NFC card</button>' : ''}
    ${fromLog ? `<div class="btnrow"><button class="btn" id="chk">Check status</button>${!h.lockTo || (h.refundAt && h.refundAt <= Date.now()) ? '<button class="btn" id="rc">Reclaim</button>' : ''}</div>` : ''}
    <p class="dim small center">${h.lockTo ? 'Only the person it’s locked to can claim it.' : 'Whoever holds this token can spend it. Until it’s claimed you can reclaim it from your history.'}</p>`, (b) => {
    addNote(b, h);
    stop = qrToken($('#tq', b), h.token);
    onClose = () => stop();
    $('#cp', b).onclick = () => copy(h.token, 'Token copied');
    $('#cl', b).onclick = () => copy(link, 'Link copied');
    $('#ce', b).onclick = () => copy(C.encodeEmoji(h.token), 'Emoji copied. Paste it anywhere.');
    const sh = $('#sh', b); if (sh) sh.onclick = () => navigator.share({ text: h.token }).catch(() => {});
    const nw = $('#nfw', b); if (nw) nw.onclick = withBusy(nw, () => nfcWrite(h.token));
    if (fromLog) {
      const chk = $('#chk', b), rc = $('#rc', b);
      chk.onclick = withBusy(chk, async () => { const s = await C.checkClaimed(h); toast(s === 'claimed' ? 'The token was claimed.' : 'Not claimed yet.', s === 'claimed' ? 'ok' : 'warn'); if (s === 'claimed') detail(h); });
      if (rc) rc.onclick = withBusy(rc, async () => { await C.reclaim(h); toast('Reclaimed into your wallet'); render(); detail(h); });
    }
  });
}
// a lock target shown as the contact's name when we know it
function lockName(pub) {
  const c = keyContacts().find((x) => { try { return C.parsePubkey(x.npub) === pub; } catch { return false; } });
  return c ? c.name : pub.slice(0, 12) + '…';
}
/* ================= nutzaps ================= */
const isNpub = (t) => /^(nostr:)?(npub1[02-9ac-hj-np-z]{58}|nprofile1[02-9ac-hj-np-z]+)$/i.test(t.trim());
const shortNpub = (t) => { const x = t.replace(/^nostr:/i, ''); return x.length > 24 ? x.slice(0, 12) + '…' + x.slice(-6) : x; };
function nutzapSheet(target) {
  if (needMint()) return;
  target = target.trim().replace(/^nostr:/i, '');
  sheet('Nutzap', `<p class="dim center">To <b dir="ltr">${esc(shortNpub(target))}</b></p><div id="nzb"><p class="dim center">Looking up their nutzap settings<span class="cur">_</span></p></div>`, async (b) => {
    let info;
    try { info = await N.nutzapInfo(target); } catch (e) { $('#nzb', b).innerHTML = `<p class="warn">${esc(niceErr(e))}</p>`; return; }
    if (!b.isConnected) return;
    if (!info.ok) {
      const npub = target.startsWith('npub1') ? target : N.npubOf(info.pk);
      $('#nzb', b).innerHTML = `<p>They haven’t set up nutzaps yet.</p><p class="dim">You can pay their npub.cash Lightning address instead, if they use one.</p><button class="btn primary wide" id="nzl">Pay ${esc(shortNpub(npub))}@npub.cash</button>`;
      I18N.translateTree($('#nzb', b));
      $('#nzl', b).onclick = () => sendSheet('ln', npub + '@npub.cash');
      return;
    }
    const shared = info.mints.filter((u) => mintOf(u));
    $('#nzb', b).innerHTML = `${amountField('nzamt', `${I18N.t('They accept')}: ${esc(info.mints.map(host).join(', ') || '—')}`)}
      <label class="lbl" for="nzc">Comment</label><input id="nzc" class="field" maxlength="140" placeholder="Optional" autocomplete="off" dir="auto">
      ${shared.length ? '' : `<p class="warn small">${esc(I18N.t('None of the mints they accept is in your wallet. Add one of them to send a nutzap.'))}</p>`}
      <p class="dim small">The ecash is locked to their key and sent over Nostr. If they don’t take it within a week, it comes back to you.</p>
      <button class="btn primary wide" id="nzgo" ${shared.length ? '' : 'disabled'}>Send nutzap</button>`;
    bindKeypads($('#nzb', b)); I18N.translateTree($('#nzb', b));
    const go = $('#nzgo', b);
    go.onclick = withBusy(go, async () => {
      const a = readAmt(b, 'nzamt'); if (!a) return nope('Enter an amount.');
      const url = N.nutzapMint(info, a);
      if (!url) return nope(`Not enough at a mint they accept (${info.mints.map(host).join(', ')}).`);
      if (!(await bigOk(a))) return;
      const h = await N.sendNutzap(info, a, $('#nzc', b).value.trim(), url);
      render(); FX.play('sent'); FX.buzz('sent'); done(h, 'Nutzapped');
    });
  });
}
/* ================= split the bill ================= */
// one Lightning invoice per person; progress comes from which of them are paid
let splitRefresh = null;
const splitParts = (sp) => sp.parts.map((x) => ({ ...x, h: S.history.find((h) => h.id === x.hid) }));
function splitStats(sp) {
  const ps = splitParts(sp), paid = ps.filter((x) => x.h?.status === 'done');
  return { ps, paid: paid.length, n: ps.length, got: paid.reduce((t, x) => t + x.amount, 0), want: ps.reduce((t, x) => t + x.amount, 0) };
}
function splitHome() {
  const list = (S.splits || []).slice(0, 10);
  if (!list.length) return splitNew();
  sheet('Split a bill', `<ul class="spl">${list.map((sp) => { const t = splitStats(sp); return `<li><button class="splr" data-id="${esc(sp.id)}"><span><b dir="auto">${esc(sp.title || I18N.t('Bill'))}</b><small class="dim">${esc(stamp(sp.ts))}</small></span><span class="vr"><b>${t.paid}/${t.n}</b><small class="dim">${esc(fmt(t.got, 'sat'))}</small></span></button></li>`; }).join('')}</ul>
    <button class="btn primary wide" id="spN">New split</button>`, (b) => {
    $$('.splr', b).forEach((x) => (x.onclick = () => splitView(x.dataset.id)));
    $('#spN', b).onclick = () => splitNew();
  }, { back: () => receiveSheet('ln') });
}
function splitNew() {
  if (needMint()) return;
  if (S.unit !== 'sat') { S.unit = 'sat'; save(); render(); }
  let n = 4;
  sheet('Split a bill', `${amountField('samt', 'The whole bill')}
    <label class="lbl" for="sfor">What for?</label><input id="sfor" class="field" maxlength="40" placeholder="Dinner" autocomplete="off" dir="auto">
    <label class="lbl">Split between</label>
    <div class="stepper"><button class="btn" id="sMinus" aria-label="Fewer people">−</button><b id="sN" aria-live="polite">4</b><button class="btn" id="sPlus" aria-label="More people">+</button><span class="dim" id="sPeople"></span></div>
    <label class="check"><input type="checkbox" id="sMe" checked> <span>I’m paying my share too</span></label>
    <label class="lbl" for="sNames">Names</label><input id="sNames" class="field" placeholder="Optional, separated by commas" autocomplete="off" dir="auto">
    <p class="okline center" id="sEach"></p>
    <button class="btn primary wide" id="sGo">Create requests</button>`, (b) => {
    const others = () => n - ($('#sMe', b).checked ? 1 : 0);
    const upd = () => {
      $('#sN', b).textContent = String(n); $('#sPeople', b).textContent = I18N.t('people');
      $('#sMinus', b).disabled = n <= 2; $('#sPlus', b).disabled = n >= 12;
      const a = readAmt(b, 'samt');
      $('#sEach', b).textContent = a ? I18N.t('Each pays about {0}. You’ll get {1} requests to share.').replace('{0}', fmt(Math.ceil(a / n), 'sat')).replace('{1}', others()) : '';
    };
    $('#sMinus', b).onclick = () => { n = Math.max(2, n - 1); upd(); };
    $('#sPlus', b).onclick = () => { n = Math.min(12, n + 1); upd(); };
    $('#sMe', b).onchange = upd;
    $('#samt', b).addEventListener('input', upd); b.addEventListener('click', (e) => { if (e.target.closest('.kp')) setTimeout(upd, 0); });
    upd();
    const go = $('#sGo', b);
    go.onclick = withBusy(go, async () => {
      const total = readAmt(b, 'samt'); if (!total) return nope('Enter an amount.');
      if (total < n) return nope('Enter an amount.');
      const title = $('#sfor', b).value.trim(), names = $('#sNames', b).value.split(',').map((x) => x.trim()).filter(Boolean);
      // shares that add up to the bill exactly: the first few round up
      const base = Math.floor(total / n), extra = total - base * n;
      const shares = Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
      if ($('#sMe', b).checked) shares.pop();
      const sp = { id: 'sp' + Date.now().toString(36), ts: Date.now(), title, total, n, parts: [] };
      for (let i = 0; i < shares.length; i++) {
        const name = names[i] || I18N.t('Person {0}').replace('{0}', i + 1);
        const h = await C.createInvoice(shares[i], S.active, 'sat', [title || I18N.t('Bill'), name].join(' · '));
        h.split = sp.id;
        sp.parts.push({ name, amount: shares[i], hid: h.id });
      }
      S.splits = [sp, ...(S.splits || [])].slice(0, 30); save();
      splitView(sp.id);
    });
  }, { back: () => ((S.splits || []).length ? splitHome() : receiveSheet('ln')) });
}
function splitView(id) {
  const sp = (S.splits || []).find((x) => x.id === id); if (!sp) return splitHome();
  let timer = 0, dead = false, done0 = splitStats(sp).paid === splitStats(sp).n;
  sheet(sp.title || 'Split a bill', `<div id="spHead"></div><ul class="spl" id="spList"></ul>
    <button class="btn wide" id="spAll">Copy all for a group chat</button>
    <p class="dim small">Each person scans or opens their own request. Requests expire after a while; paid ones land in your history.</p>`, (b) => {
    const draw = () => {
      if (dead || !b.isConnected) return;
      const t = splitStats(sp), pct = t.want ? Math.round((t.got / t.want) * 100) : 0;
      $('#spHead', b).innerHTML = `<p class="big">${bigAmt(t.got, 'sat')}</p>
        <p class="dim small center">${esc(I18N.t('{0} of {1} paid').replace('{0}', t.paid).replace('{1}', t.n))} · ${esc(I18N.t('of {0}').replace('{0}', fmt(t.want, 'sat')))}</p>
        <div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`;
      $('#spList', b).innerHTML = t.ps.map((x, i) => { const s = x.h?.status || 'expired'; return `<li><button class="splr" data-i="${i}" ${s === 'pending' ? '' : 'disabled'}><span><b dir="auto">${esc(x.name)}</b><small class="dim">${esc(fmt(x.amount, 'sat'))}</small></span><em class="pill ${s === 'done' ? 'p-done' : s === 'pending' ? 'p-open' : 'p-expired'}">${esc(I18N.t(s === 'done' ? 'Paid' : s === 'pending' ? 'Show request' : 'Expired'))}</em></button></li>`; }).join('');
      $$('#spList .splr', b).forEach((x) => (x.onclick = () => splitShare(sp, +x.dataset.i)));
      if (!done0 && t.paid === t.n) { done0 = true; FX.play('received'); FX.confetti($('#spHead', b), true); toast('Everyone paid'); }
    };
    splitRefresh = draw;
    draw();
    const tick = async () => {
      if (dead) return;
      for (const x of splitParts(sp)) if (x.h && x.h.status === 'pending') { try { await C.checkInvoice(x.h); } catch {} }
      render(); timer = setTimeout(tick, st.websockets ? 5000 : 3000);
    };
    timer = setTimeout(tick, 1500);
    onClose = () => { dead = true; clearTimeout(timer); splitRefresh = null; };
    $('#spAll', b).onclick = () => {
      const lines = splitParts(sp).filter((x) => x.h?.status === 'pending').map((x) => `${x.name} (${fmt(x.amount, 'sat')}): lightning:${x.h.request}`);
      if (!lines.length) return toast('Everyone paid');
      copy(`${sp.title || I18N.t('Bill')}\n\n${lines.join('\n\n')}`, 'Copied');
    };
  }, { back: () => { splitRefresh = null; splitHome(); } });
}
function splitShare(sp, i) {
  const x = splitParts(sp)[i]; if (!x?.h) return;
  sheet(x.name, `<p class="big">${bigAmt(x.amount, 'sat')}</p><p class="dim center" dir="auto">${esc(sp.title || I18N.t('Bill'))}</p>
    <div class="qr" id="sq"></div>
    <div class="btnrow"><button class="btn primary" id="ssh">Share</button><button class="btn" id="scp">Copy</button></div>`, (b) => {
    qrSvg('lightning:' + x.h.request).then((svg) => { $('#sq', b).innerHTML = svg; });
    const text = `${sp.title || I18N.t('Bill')} · ${x.name}: ${fmt(x.amount, 'sat')}\nlightning:${x.h.request}`;
    $('#scp', b).onclick = () => copy(x.h.request, 'Invoice copied');
    $('#ssh', b).onclick = async () => { try { if (navigator.share) await navigator.share({ text }); else copy(text, 'Copied'); } catch (e) { if (e?.name !== 'AbortError') copy(text, 'Copied'); } };
    let dead = false; const watch = async () => { if (dead) return; try { if ((await C.checkInvoice(x.h)) === 'done') { render(); FX.play('received'); toast(`${x.name} paid`); return splitView(sp.id); } } catch {} setTimeout(watch, 2500); };
    setTimeout(watch, 1500); onClose = () => { dead = true; };
  }, { back: () => splitView(sp.id) });
}
/* ================= time vault ================= */
const vaults = () => S.history.filter((h) => h.vault && h.status === 'pending' && (h.unit || 'sat') === 'sat');
const vaultDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
function vaultLeft(ts) {
  const d = Math.ceil((ts - Date.now()) / 864e5);
  if (ts <= Date.now()) return I18N.t('unlocking now');
  if (d <= 1) { const h = Math.max(1, Math.round((ts - Date.now()) / 36e5)); return I18N.t(h === 1 ? 'in 1 hour' : 'in {0} hours').replace('{0}', h); }
  return I18N.t('in {0} days').replace('{0}', d);
}
const VAULT_FOR = [[7, 'One week'], [30, 'One month'], [91, 'Three months'], [182, 'Six months'], [365, 'One year']];
function vaultSheet(opts = {}) {
  const vs = vaults();
  sheet('Time vault', `<p>Lock sats away until a date you choose. Until then nobody can spend them, not even you. On the day, they come back to your wallet by themselves.</p>
    ${vs.length ? `<ul class="spl">${vs.map((h) => `<li><span><b class="vt">🔒 ${esc(fmt(h.amount, 'sat'))}</b><small class="dim">${esc(mintLabel(mintOf(h.mint) || { url: h.mint }))}</small></span><span class="vr"><b>${esc(vaultDay(h.refundAt))}</b><small class="dim">${esc(vaultLeft(h.refundAt))}</small></span></li>`).join('')}</ul>` : ''}
    <button class="btn primary wide" id="vNew">Lock sats</button>`, (b) => {
    $('#vNew', b).onclick = () => vaultNew();
  }, opts);
}
function vaultNew() {
  if (needMint()) return;
  if (mintOf(S.active)?.info?.nut11 === false) return toast('This mint doesn’t support locked ecash.', 'warn');
  if (S.unit !== 'sat') { S.unit = 'sat'; save(); render(); }
  const minDay = new Date(Date.now() + 864e5).toISOString().slice(0, 10), maxDay = new Date(Date.now() + 5 * 365 * 864e5).toISOString().slice(0, 10);
  sheet('Lock sats', `${amountField('vamt', `Available: ${esc(fmt(bal(S.active, 'sat'), 'sat'))}`)}
    <label class="lbl" for="vfor">Lock for</label>
    <select id="vfor" class="field">${VAULT_FOR.map(([d, l]) => `<option value="${d}" ${d === 30 ? 'selected' : ''}>${l}</option>`).join('')}<option value="date">Pick a date…</option></select>
    <input id="vday" class="field" type="date" min="${minDay}" max="${maxDay}" hidden>
    <p class="okline small center" id="vwhen"></p>
    <label class="check"><input type="checkbox" id="vok"> <span id="vokT"></span></label>
    <p class="dim small">The mint ${esc(mintLabel(mintOf(S.active) || { url: S.active }))} holds them until then, like all your ecash. Your seed phrase can’t bring a vault back if you lose this phone, so keep a backup file.</p>
    <button class="btn primary wide" id="vGo" disabled>Lock</button>`, (b) => {
    const until = () => {
      const v = $('#vfor', b).value;
      if (v === 'date') { const d = $('#vday', b).value; if (!d) return 0; const t = new Date(d + 'T09:00'); return isNaN(t) ? 0 : t.getTime(); }
      return Date.now() + +v * 864e5;
    };
    const upd = () => {
      $('#vday', b).hidden = $('#vfor', b).value !== 'date';
      const u = until();
      $('#vwhen', b).textContent = u ? I18N.t('Unlocks {0}').replace('{0}', whenShort(u)) : '';
      $('#vokT', b).textContent = u ? I18N.t('I understand I can’t get these sats back before {0}.').replace('{0}', vaultDay(u)) : I18N.t('Pick a date.');
      $('#vGo', b).disabled = !u || !$('#vok', b).checked;
    };
    $('#vfor', b).onchange = () => { $('#vok', b).checked = false; upd(); };
    $('#vday', b).oninput = () => { $('#vok', b).checked = false; upd(); };
    $('#vok', b).onchange = upd;
    upd();
    const go = $('#vGo', b);
    go.onclick = withBusy(go, async () => {
      const a = readAmt(b, 'vamt'); if (!a) return nope('Enter an amount.');
      const u = until(); if (!u || u <= Date.now()) return nope('Pick a date.');
      if (!(await bigOk(a))) return;
      await C.lockVault(a, u);
      render(); FX.play('sent'); FX.buzz('sent');
      toast(`${fmt(a, 'sat')} locked until ${vaultDay(u)}`);
      vaultSheet();
    });
  }, { back: () => vaultSheet() });
}
/* ================= cards: gift cards and the tip jar ================= */
// share, save, copy link and print for a card picture. get() returns the current { blob, url }
function cardTools(b, get, { name, text, link }) {
  const file = () => new File([get().blob], name, { type: 'image/png' });
  const canFiles = () => get().blob && typeof File === 'function' && navigator.canShare?.({ files: [file()] });
  const download = () => { const a = document.createElement('a'); a.href = get().url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
  $('#gSh', b).onclick = async () => {
    if (!get().blob) return;
    try {
      if (canFiles()) await navigator.share({ files: [file()], text });
      else if (navigator.share) await navigator.share({ text });
      else return copy(link, 'Link copied');
    } catch (e) { if (e?.name !== 'AbortError') copy(link, 'Link copied'); }
  };
  // phones: the share sheet has "Save Image"; computers: a normal download
  $('#gSv', b).onclick = async () => { if (!get().blob) return; if (canFiles()) { try { await navigator.share({ files: [file()] }); } catch (e) { if (e?.name !== 'AbortError') download(); } } else download(); };
  const cl = $('#gCl', b); if (cl) cl.onclick = () => copy(link, 'Link copied');
  const pr = $('#gPr', b); if (pr) pr.onclick = () => {
    const url = get().url; if (!url) return;
    const area = document.createElement('div'); area.id = 'printArea'; area.innerHTML = `<img src="${url}" alt="">`;
    document.body.appendChild(area); document.documentElement.classList.add('printing');
    const end = () => { area.remove(); document.documentElement.classList.remove('printing'); removeEventListener('afterprint', end); };
    addEventListener('afterprint', end);
    $('img', area).decode().catch(() => {}).then(() => { window.print(); setTimeout(() => { if (area.isConnected && !matchMedia('print').matches) end(); }, 1500); });
  };
}
const designPicker = (cur) => `<div class="gds" role="radiogroup" aria-label="Design">${GIFT.DESIGNS.map(([k, l]) => `<button role="radio" class="gd gd-${k}" data-d="${k}" aria-checked="${cur === k}"><i aria-hidden="true"></i>${l}</button>`).join('')}</div>`;
// a card for a counter, a stream or a stall: your Lightning address as a big QR code
const LNADDR = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
function tipSheet() {
  const t = { address: S.npc?.address || '', title: '', name: '', design: 'classic', ...(S.tipJar || {}) };
  const canvas = document.createElement('canvas');
  let blob = null, url = '', timer = 0;
  sheet('Tip jar card', `<p class="dim">A card with your Lightning address and a big QR code, for a counter, a stream or a market stall. Anyone can tip you with any Lightning wallet.</p>
    <div class="gcard"><img id="gImg" alt=""></div>
    <label class="lbl" for="tja">Lightning address</label><input id="tja" class="field" placeholder="you@npub.cash" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(t.address)}">
    ${!S.npc?.address ? '<p class="hint">No address yet? <button class="lnk" id="tjs">Set up a free one</button></p>' : ''}
    <label class="lbl" for="tjt">Headline</label><input id="tjt" class="field" maxlength="30" placeholder="Tips welcome" autocomplete="off" dir="auto" value="${esc(t.title)}">
    <label class="lbl" for="tjn">Name</label><input id="tjn" class="field" maxlength="30" placeholder="Your name or shop (optional)" autocomplete="off" dir="auto" value="${esc(t.name)}">
    ${designPicker(t.design)}
    <div class="btnrow"><button class="btn primary" id="gSh">Share</button><button class="btn" id="gSv">Save image</button></div>
    <div class="btnrow"><button class="btn" id="gCl">Copy address</button>${typeof window.print === 'function' ? '<button class="btn" id="gPr">Print</button>' : ''}</div>`, (b) => {
    const img = $('#gImg', b), A = $('#tja', b);
    const ok = () => LNADDR.test(A.value.trim());
    const paint = async () => {
      const address = A.value.trim().toLowerCase();
      t.address = address; t.title = $('#tjt', b).value.trim(); t.name = $('#tjn', b).value.trim();
      S.tipJar = { address: t.address, title: t.title, name: t.name, design: t.design }; save();
      A.classList.toggle('bad', !!address && !ok());
      await GIFT.drawTip(canvas, { design: t.design, address: ok() ? address : '', name: t.name,
        words: { title: t.title || I18N.t('Tips welcome'), scan: I18N.t('Scan with any Lightning wallet'), none: I18N.t('Add your Lightning address') } });
      blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob); img.src = url;
      img.alt = `${I18N.t('Tip jar card')}: ${address}`;
      $$('#gSh, #gSv, #gCl, #gPr', b).forEach((x) => (x.disabled = !ok()));
    };
    const later_ = () => { clearTimeout(timer); timer = setTimeout(paint, 250); };
    $$('#tja, #tjt, #tjn', b).forEach((x) => (x.oninput = later_));
    $$('.gd', b).forEach((x) => (x.onclick = () => { $$('.gd', b).forEach((y) => y.setAttribute('aria-checked', y === x)); t.design = x.dataset.d; paint(); }));
    const tjs = $('#tjs', b); if (tjs) tjs.onclick = () => SECTIONS.lnaddr();
    paint();
    onClose = () => { clearTimeout(timer); setTimeout(() => url && URL.revokeObjectURL(url), 1000); };
    cardTools(b, () => ({ blob, url }), { name: 'blindsig-tip-jar.png', text: `⚡ ${t.address}`, link: '' });
    $('#gCl', b).onclick = () => copy(A.value.trim(), 'Address copied');
  });
}
/* ================= gift cards ================= */
// the message rides in the token's memo ("🎁 Happy holidays! — Sam"), so any Cashu wallet shows it
const giftMemo = (msg, from) => '🎁 ' + [msg || I18N.t('A gift for you'), from && '— ' + from].filter(Boolean).join(' ');
function splitGift(memo) {
  const m = String(memo || '').replace(/^🎁\s*/u, ''), i = m.lastIndexOf(' — ');
  return i > 0 ? { msg: m.slice(0, i), from: m.slice(i + 3) } : { msg: m, from: '' };
}
const giftBanner = (t) => { const g = splitGift(t.memo); return `<div class="giftr"><span aria-hidden="true">🎁</span><b>A gift for you</b>${g.msg ? `<p dir="auto">${esc(g.msg)}</p>` : ''}${g.from ? `<small dir="auto">— ${esc(g.from)}</small>` : ''}</div>`; };
const giftLink = (token) => location.origin + location.pathname + '#token=' + token;
const seasonDesign = () => ([10, 11, 0].includes(new Date().getMonth()) ? 'winter' : 'classic');
function giftSheet(amount = 0, msg = '') {
  if (needMint()) return;
  sheet('Gift card', `<p class="dim">Send sats as a card with a QR code. Whoever scans it gets the ecash, even without a wallet yet. Share it, save it or print it.</p>
    ${amountField('gamt', `Available: ${esc(fmt(bal(S.active)))}`)}
    <label class="lbl" for="gm">Message</label><input id="gm" class="field" maxlength="60" placeholder="Happy holidays!" autocomplete="off" dir="auto" value="${esc(isGiftMemo(msg) ? '' : msg)}">
    <label class="lbl" for="gf">From</label><input id="gf" class="field" maxlength="24" placeholder="Your name (optional)" autocomplete="off" dir="auto">
    <button class="btn primary wide" id="gmk">Create gift card</button>`, (b) => {
    if (amount) { $('#gamt', b).value = String(isFiatUnit(S.unit) ? amount / 100 : amount); $('#gamt', b).dispatchEvent(new Event('input')); }
    const go = $('#gmk', b);
    go.onclick = withBusy(go, async () => {
      const a = readAmt(b, 'gamt'); if (!a) return nope('Enter an amount.');
      if (!(await bigOk(a))) return;
      const m = $('#gm', b).value.trim(), f = $('#gf', b).value.trim();
      const h = await C.sendEcash(a, { memo: giftMemo(m, f) });
      h.gift = { design: seasonDesign() }; save();
      render(); giftView(h); C.watchSent(sentClaimed);
      FX.play('sent'); FX.buzz('sent');
    });
  }, { back: () => sendSheet('ecash') });
}
function giftView(h, fromLog) {
  const link = giftLink(h.token), g = splitGift(h.memo), canvas = document.createElement('canvas');
  let blob = null, url = '';
  sheet('Gift card', `<div class="gcard"><img id="gImg" alt=""></div>
    <div class="gds" role="radiogroup" aria-label="Design">${GIFT.DESIGNS.map(([k, l]) => `<button role="radio" class="gd gd-${k}" data-d="${k}" aria-checked="${(h.gift?.design || 'winter') === k}"><i aria-hidden="true"></i>${l}</button>`).join('')}</div>
    <div class="btnrow"><button class="btn primary" id="gSh">Share</button><button class="btn" id="gSv">Save image</button></div>
    <div class="btnrow"><button class="btn" id="gCl">Copy link</button>${typeof window.print === 'function' ? '<button class="btn" id="gPr">Print</button>' : ''}</div>
    ${fromLog ? '<div class="btnrow"><button class="btn" id="chk">Check status</button><button class="btn" id="rc">Reclaim</button></div>' : ''}
    <p class="dim small center">Whoever scans the code gets the ecash. If nobody claims it, you can take it back from your history.</p>`, (b) => {
    addNote(b, h);
    const img = $('#gImg', b);
    const paint = async () => {
      const amt = h.unit === 'sat' ? Number(h.amount).toLocaleString('en-US') : fmt(h.amount, h.unit);
      await GIFT.draw(canvas, {
        design: h.gift?.design || 'winter', amount: amt, unit: h.unit === 'sat' ? 'sats' : '', fiat: h.unit === 'sat' && st.fiat ? fiatOf(h.amount) : '',
        msg: g.msg, from: g.from, link, words: { title: I18N.t('A gift for you'), scan: I18N.t('Scan with your phone camera to claim'), from: g.from ? I18N.t('from ' + g.from) : '', tooBig: I18N.t('This gift has too many small parts to fit in one code. Send the link instead.'), link: I18N.t('Open the link to claim') },
      });
      blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob); img.src = url;
      img.alt = `${I18N.t('Gift card')}: ${fmt(h.amount, h.unit)}${g.msg ? ' · ' + g.msg : ''}`;
    };
    paint();
    onClose = () => { setTimeout(() => url && URL.revokeObjectURL(url), 1000); };
    $$('.gd', b).forEach((x) => (x.onclick = () => {
      $$('.gd', b).forEach((y) => y.setAttribute('aria-checked', y === x));
      h.gift = { ...(h.gift || {}), design: x.dataset.d }; save(); paint();
    }));
    cardTools(b, () => ({ blob, url }), { name: 'blindsig-gift.png', text: `${g.msg ? g.msg + ' ' : ''}🎁 ${link}`, link });
    if (fromLog) {
      const chk = $('#chk', b), rc = $('#rc', b);
      chk.onclick = withBusy(chk, async () => { const s = await C.checkClaimed(h); toast(s === 'claimed' ? 'The gift was claimed.' : 'Not claimed yet.', s === 'claimed' ? 'ok' : 'warn'); if (s === 'claimed') detail(h); });
      rc.onclick = withBusy(rc, async () => { await C.reclaim(h); toast('Reclaimed into your wallet'); render(); detail(h); });
    }
  });
}
// someone opened a gift link without a wallet: show the gift first, then set them up and claim it
let pendingToken = null;
function giftWelcome() {
  let t; try { t = C.parseToken(pendingToken); } catch { pendingToken = null; return welcome(0); }
  sheet('You got a gift', `${isGiftMemo(t.memo) ? giftBanner(t) : '<div class="giftr"><span aria-hidden="true">🎁</span><b>Someone sent you bitcoin</b></div>'}
    <p class="big">${bigAmt(t.amount, t.unit, '+')}</p>
    <p class="dim small center">Held by the mint ${esc(host(t.mint))}</p>
    <p>blindsig is a private bitcoin wallet that runs in your browser. Make one in a few seconds to keep this gift. No account, no email.</p>
    <button class="btn primary wide" id="gc">Claim it</button>
    <button class="btn wide" id="gh">I already have a wallet</button>`, (b) => {
    C.receiveFee(t).then((f) => { if (f > 0 && f < t.amount) $('.big', b).innerHTML = bigAmt(t.amount - f, t.unit, '+'); }).catch(() => {});
    $('#gc', b).onclick = () => showSeed(generateMnemonic(wordlist, 128), true);
    $('#gh', b).onclick = () => welcome(SLIDES.length);
  }, { locked: true });
}
// right after a new wallet is made or restored: claim the gift that brought them here
function claimPending() {
  if (!pendingToken) return false;
  const tok = pendingToken; pendingToken = null;
  later(async () => {
    try { const t = C.parseToken(tok); const h = await C.receiveEcash(t); C.selectMint(t.mint); locked = false; done(h, 'Gift claimed'); N.backupMints().catch(() => {}); }
    catch (e) { locked = false; toast(niceErr(e), 'err'); if (!S.mints.length) mintsSheet(true); else receiveSheet('ecash', tok); }
  });
  return true;
}
// an address worth saving as a contact: Lightning address, LNURL or BOLT12 offer (not one-time invoices)
const reusableTarget = (v) => (C.isAddress(v) ? v.toLowerCase() : C.isLnurl(v) || C.isOffer(v) ? v : '');
function done(h, verb, saveTo) {
  const out = h.kind.endsWith('out');
  sheet(verb, `<div class="okb" aria-hidden="true"><svg viewBox="0 0 84 84"><circle class="ring" cx="42" cy="42" r="38"/><circle class="disc" cx="42" cy="42" r="38"/><path class="tick" d="M26 43.5l10.5 10.5L58.5 31"/></svg></div>
    <p class="big" id="dnAmt">${bigAmt(h.amount, h.unit, out ? '−' : '+')}</p>
    ${h.fee ? `<p class="dim small center">Fee ${esc(fmt(h.fee, h.unit))}</p>` : ''}
    <button class="btn primary wide" id="dn">Done</button>`, (b) => {
    $('#dn', b).onclick = () => closeSheet();
    addNote(b, h, $('#dn', b));
    if (saveTo) { $('#dn', b).insertAdjacentHTML('beforebegin', '<button class="btn wide" id="svc">Save as contact</button>'); I18N.translateTree($('#svc', b)); $('#svc', b).onclick = () => contactEdit({ to: saveTo }, () => closeSheet()); }
    if (h.amount) FX.countUp($('#dnAmt', b), h.amount, (n) => bigAmt(n, h.unit, out ? '−' : '+'));
    setTimeout(() => FX.success(out ? 'sent' : 'received', $('.okb', b)), 120);
  });
  render();
}

const sentClaimed = () => { render(); };
// a locked send nobody claimed in time is back in the wallet
const cameBack = (h) => { toast(h.vault ? `${fmt(h.amount, h.unit)} from your time vault is back in your wallet.` : `${fmt(h.amount, h.unit)} came back to you. It wasn’t claimed in time.`); FX.play('received'); render(); };

/* ================= history detail ================= */
// a private note on any transaction: kept with your history on this device (encrypted with the
// PIN lock), never sent anywhere
function addNote(b, h, before) {
  const sb = $('.sb', b); if (!sb || $('#hn', b)) return;
  (before || sb).insertAdjacentHTML(before ? 'beforebegin' : 'beforeend', `<div class="note"><label class="lbl" for="hn">Note</label>
    <textarea id="hn" rows="2" maxlength="280" placeholder="Add a private note" dir="auto" autocapitalize="sentences"></textarea>
    <p class="dim small" id="hns">Only saved on this device.</p></div>`);
  const t = $('#hn', b), st2 = $('#hns', b);
  t.value = h.note || '';
  let tm = null;
  const store = () => { clearTimeout(tm); tm = null; const v = t.value.trim(); if ((h.note || '') === v) return; if (v) h.note = v; else delete h.note; save(); render(); st2.textContent = v ? 'Note saved.' : 'Only saved on this device.'; };
  t.oninput = () => { clearTimeout(tm); tm = setTimeout(store, 500); };
  t.onblur = store;
  flushNote = () => { if (tm) store(); };
}
/* ================= value then, and monthly summary ================= */
const amountOf = (h) => (h.live ? h.received || 0 : h.amount || 0);
const fiatMoney = (v, cur) => v.toLocaleString('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 });
// what this entry was worth when it happened, in the currency of that moment: { v, cur, est }
function valueThen(h) {
  if (!h.fx || (h.unit || 'sat') !== 'sat') return null;
  return { v: (amountOf(h) / 1e8) * h.fx.rate, cur: h.fx.cur, est: !!h.fx.est };
}
function valueRows(h) {
  if ((h.unit || 'sat') !== 'sat' || !st.fiat || !amountOf(h)) return [];
  const then = valueThen(h), nowP = S.price[st.fiatCur];
  const now = nowP ? (amountOf(h) / 1e8) * nowP : 0;
  const rows = [];
  if (then) rows.push(['Value then', `${esc(fiatMoney(then.v, then.cur))}${then.est ? ` <small class="dim">${esc(I18N.t('(estimated)'))}</small>` : ''}`]);
  if (now) {
    const pct = then && then.cur === st.fiatCur && then.v ? ((now - then.v) / then.v) * 100 : null;
    rows.push(['Value now', `${esc(fiatMoney(now, st.fiatCur))}${pct != null && Math.abs(pct) >= 0.05 ? ` <small class="${pct < 0 ? 'dn' : 'up'}">${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(1)}%</small>` : ''}`]);
  }
  return rows;
}
// older entries (from before this was recorded): estimate the price from the year's or all-time
// price history. The same requests the price chart makes, so no payment dates leave the phone.
async function fillFx(list) {
  if (!st.fiat) return 0;
  const cur = st.fiatCur, need = list.filter((h) => !h.fx && (h.unit || 'sat') === 'sat' && h.ts);
  if (!need.length) return 0;
  const yearAgo = Date.now() - 360 * 864e5;
  let year = [], all = [];
  try { year = await CH.series(cur, 'year'); } catch {}
  if (need.some((h) => h.ts < yearAgo)) { try { all = await CH.series(cur, 'all'); } catch {} }
  const near = (pts, t) => { if (!pts.length || t < pts[0][0] - 30 * 864e5) return 0; let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; return best[1]; };
  let n = 0;
  for (const h of need) { const r = h.ts >= yearAgo ? near(year, h.ts) || near(all, h.ts) : near(all, h.ts); if (r > 0) { h.fx = { cur, rate: r, est: 1 }; n++; } }
  if (n) save();
  return n;
}
// what counts: money that really moved (not pending, failed, expired, or sent and taken back)
const counted = (h) => (h.unit || 'sat') === 'sat' && amountOf(h) > 0 && !h.internal && (h.live || ['done', 'claimed'].includes(h.status));
const monthKey = (ts) => { const d = new Date(ts); return d.getFullYear() * 100 + d.getMonth(); };
const monthName = (k, long) => new Date(Math.floor(k / 100), k % 100, 1).toLocaleDateString([], { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined });
function monthTotals(k) {
  const t = { in: 0, out: 0, fees: 0, nIn: 0, nOut: 0, fIn: 0, fOut: 0, fFees: 0, missing: 0 };
  for (const h of S.history) {
    if (!counted(h) || monthKey(h.ts) !== k) continue;
    const out = h.kind.endsWith('out'), a = amountOf(h), fee = h.fee || 0, then = valueThen(h);
    const rate = then && then.cur === st.fiatCur ? h.fx.rate / 1e8 : 0;
    if (out) { t.out += a; t.nOut++; t.fees += fee; } else { t.in += a; t.nIn++; }
    if (rate) { if (out) { t.fOut += a * rate; t.fFees += fee * rate; } else t.fIn += a * rate; } else if (st.fiat) t.missing++;
  }
  return t;
}
function summarySheet(k) {
  const months = [...new Set(S.history.filter(counted).map((h) => monthKey(h.ts)))].sort((a, b) => b - a);
  const nowK = monthKey(Date.now());
  if (!months.includes(nowK)) months.unshift(nowK);
  k = k ?? months[0];
  const fiat = st.fiat && S.price[st.fiatCur];
  const draw = (b) => {
    const t = monthTotals(k), net = t.in - t.out - t.fees, fNet = t.fIn - t.fOut - t.fFees;
    const fm = (v) => (fiat ? `<small class="dim">${esc(fiatMoney(v, st.fiatCur))}</small>` : '');
    $('#smBody', b).innerHTML = `<p class="big">${bigAmt(Math.abs(net), 'sat', net < 0 ? '−' : '+')}</p>
      ${fiat ? `<p class="dim small center">${esc(I18N.t('Net'))} · ${esc(fiatMoney(fNet, st.fiatCur))} ${esc(I18N.t('at the time'))}</p>` : ''}
      ${kv([[`${I18N.t('In')} (${t.nIn})`, `<b>${esc(fmt(t.in, 'sat'))}</b> ${fm(t.fIn)}`], [`${I18N.t('Out')} (${t.nOut})`, `<span class="ink">${esc(fmt(t.out, 'sat'))}</span> ${fm(t.fOut)}`], ['Fees', `${esc(fmt(t.fees, 'sat'))} ${fm(t.fFees)}`]])}
      ${t.missing ? `<p class="dim small">${esc(I18N.t('{0} payments have no price from the time.').replace('{0}', t.missing))}</p>` : ''}`;
    I18N.translateTree($('#smBody', b));
    // the last six months, in and out
    const last = []; for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); last.push(monthKey(d)); }
    const tots = last.map((m) => monthTotals(m)), max = Math.max(1, ...tots.map((x) => Math.max(x.in, x.out + x.fees)));
    $('#smBars', b).innerHTML = last.map((m, i) => `<button class="smb ${m === k ? 'on' : ''}" data-k="${m}" aria-label="${esc(monthName(m, true))}"><span class="bars"><i class="bi" style="height:${(tots[i].in / max) * 100}%"></i><i class="bo" style="height:${((tots[i].out + tots[i].fees) / max) * 100}%"></i></span><small>${esc(monthName(m))}</small></button>`).join('');
    $$('.smb', b).forEach((x) => (x.onclick = () => { k = +x.dataset.k; $('#smMonth', b).value = String(k); draw(b); }));
  };
  sheet('Summary', `<select id="smMonth" class="field" aria-label="Month">${months.slice(0, 36).map((m) => `<option value="${m}" ${m === k ? 'selected' : ''}>${esc(monthName(m, true))}</option>`).join('')}</select>
    <div id="smBody"></div>
    <div class="smbars" id="smBars"></div>
    <p class="smleg dim small"><span><i class="bi"></i>In</span><span><i class="bo"></i>Out</span></p>
    <p class="dim small">Completed payments in sats. Pending, failed and taken-back sends aren’t counted.</p>
    <button class="btn wide" id="smCsv">Export history (CSV)</button>`, (b) => {
    $('#smMonth', b).onchange = (e) => { k = +e.target.value; draw(b); };
    draw(b);
    if (st.fiat && S.history.some((h) => counted(h) && !h.fx)) fillFx(S.history.filter(counted)).then((n) => { if (n && b.isConnected) draw(b); });
    const csv = $('#smCsv', b);
    csv.onclick = withBusy(csv, async () => {
      if (st.fiat) await fillFx(S.history.filter((h) => h.amount || h.received));
      const q = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
      const rows = [['date', 'type', 'via', 'status', 'amount', 'unit', 'fee', 'value_then', 'currency', 'estimated', 'mint', 'memo', 'note']];
      for (const h of [...S.history].reverse()) {
        const [verb, via] = kindOf(h), then = valueThen(h);
        rows.push([new Date(h.ts).toISOString(), verb.toLowerCase(), via.toLowerCase(), h.live ? 'live' : h.status, amountOf(h), h.unit || 'sat', h.fee || 0, then ? then.v.toFixed(2) : '', then ? then.cur : '', then?.est ? 'yes' : '', h.mint || '', h.memo || '', h.note || '']);
      }
      if (await saveFile(rows.map((r) => r.map(q).join(',')).join('\n') + '\n', `blindsig-history-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv')) toast('History exported');
    });
  });
}
let shownDetail = null; // the entry whose details are on screen (to refresh them once its old price is found)
function detail(h) {
  if (h.live) return liveView(h);
  if (h.kind === 'ln-in' && h.status === 'pending') return invoiceView(h);
  if (h.vault && h.status === 'pending') return vaultSheet();
  if (h.kind === 'ecash-out' && h.status === 'pending') return h.gift ? giftView(h, true) : tokenView(h, true);
  if (h.kind === 'ecash-in' && h.status === 'pending' && h.token) {
    receiveSheet('ecash', h.token);
    later(() => addNote($('#sheetBody'), h));
    if (h.warn) later(() => $('#sheet .sb')?.insertAdjacentHTML('afterbegin', '<p class="warn">This payment doesn’t fully match your request: after the mint’s fees it comes up short, it isn’t from a mint you asked for, or it isn’t locked to your key as requested. You can still claim it.</p>'));
    return;
  }
  const [verb, via] = kindOf(h);
  if ((h.unit || 'sat') === 'sat' && st.fiat && !h.fx && counted(h)) fillFx([h]).then((n) => { if (n && open && shownDetail === h) detail(h); });
  const stx = { pending: 'Pending', done: 'Complete', claimed: 'Claimed', reclaimed: 'Reclaimed', returned: 'Came back: not claimed in time', expired: 'Expired', failed: 'Failed, ecash returned' }[h.status];
  sheet(`${verb} · ${via}`, `<p class="big">${bigAmt(h.amount, h.unit, h.kind.endsWith('out') ? '−' : '+')}</p>
    ${kv([['Status', stx], h.kind === 'chain-out' && ['To', `<code>${esc(h.request)}</code>`], ['Mint', esc(host(h.mint))], ['Time', new Date(h.ts).toLocaleString()], h.fee && ['Fee', esc(fmt(h.fee, h.unit))], ...valueRows(h), h.memo && h.memo !== h.request && ['Memo', `<span dir="auto">${esc(h.memo)}</span>`], h.preimage && ['Preimage', `<code>${esc(h.preimage)}</code>`], h.outpoint && ['Transaction', `<code>${esc(h.outpoint)}</code>`]])}
    ${h.request && h.kind !== 'chain-out' ? `<details class="more"><summary>${h.method === 'bolt12' ? 'Offer' : 'Invoice'}</summary><pre class="armor sm">${esc(h.request)}</pre><button class="btn wide" id="cpi">${h.method === 'bolt12' ? 'Copy offer' : 'Copy invoice'}</button></details>` : ''}
    ${(h.kind === 'ln-out' || h.kind === 'chain-out') && h.status === 'pending' ? '<button class="btn wide" id="st">Check payment</button>' : ''}
    ${h.kind === 'ln-in' && h.status === 'expired' ? '<button class="btn wide" id="re">Check again</button>' : ''}
    ${h.status !== 'pending' ? '<button class="btn wide danger" id="del">Delete from history</button>' : ''}`, (b) => {
    shownDetail = h;
    addNote(b, h); const dl = $('#del', b); if (dl) $('.sb', b).appendChild(dl);
    const del = $('#del', b); if (del) del.onclick = () => { S.history = S.history.filter((x) => x !== h); save(); render(); closeSheet(); };
    const cpi = $('#cpi', b); if (cpi) cpi.onclick = () => copy(h.request, h.method === 'bolt12' ? 'Offer copied' : 'Invoice copied');
    const s2 = $('#st', b); if (s2) s2.onclick = withBusy(s2, async () => { await C.settleMelt(h); render(); detail(h); });
    const re = $('#re', b); if (re) re.onclick = withBusy(re, async () => { h.status = 'pending'; const s = await C.checkInvoice(h); if (s === 'pending') { h.status = 'expired'; save(); toast('Still unpaid.', 'warn'); } render(); detail(h); });
  });
}

/* ================= mints ================= */
function mintsSheet(first = false) {
  const rows = S.mints.map((m) => `<li class="mint ${m.url === S.active ? 'act' : ''}">
      <button class="pick" data-u="${esc(m.url)}"><span class="mk" aria-hidden="true">${m.url === S.active ? '●' : '○'}</span>
      ${(() => { const u = (m.units || ['sat']).includes(S.unit) ? S.unit : 'sat', amt = st.hideAmounts ? HIDDEN : fmt(bal(m.url, u), u), long = amt.length > 12;
        return `<span class="mt"><b>${esc(mintLabel(m))}</b><small>${esc(host(m.url))}${(m.units || []).length > 1 ? ' · ' + m.units.map(unitLabel).join(' ') : ''}</small>${long ? `<span class="mb">${esc(amt)}</span>` : ''}</span>
      ${long ? '<span></span>' : `<span class="mb">${esc(amt)}</span>`}`; })()}</button>
      <button class="info" data-u="${esc(m.url)}" aria-label="Details for ${esc(mintLabel(m))}">i</button></li>`).join('');
  const sugg = SUGGESTED.filter((s) => !mintOf(s.url)).map((s) => `<li><button class="sug" data-u="${esc(s.url)}"><b>+ ${esc(host(s.url))}</b><small>${esc(s.note)}</small></button></li>`).join('');
  sheet(first ? 'Choose a mint' : 'Mints', `
    ${first ? `<p>${restoring ? 'Add the mints you used before. Each one is scanned for your ecash.' : 'A mint issues ecash against bitcoin it holds. You trust it with your funds, so start small.'}</p>` : ''}
    ${rows ? `<ul class="mints">${rows}</ul>` : ''}
    <form id="add" class="addm"><input id="mu" class="field" placeholder="https://mint.url" inputmode="url" autocapitalize="off" spellcheck="false"><button class="btn primary" id="ab">Add</button></form>
    ${sugg ? `<h3>Suggested mints</h3><ul class="sugs">${sugg}</ul>` : ''}
    ${restoring ? '<button class="btn wide" id="fnm">Find my mints on nostr</button>' : ''}
    <button class="btn wide" id="dsc">Discover mints</button>
    ${S.mints.length > 1 && !first ? '<button class="btn wide" id="mv">Move funds between mints</button>' : ''}
    ${!first ? `<label class="lbl" for="mw">Warn me when one mint holds more than</label><select id="mw" class="field">${[0, 50000, 100000, 500000, 1000000].map((v) => `<option value="${v}" ${(st.mintWarn ?? 100000) === v ? 'selected' : ''}>${v ? esc(fmt(v, 'sat')) : 'Don’t warn me'}</option>`).join('')}</select>
    ${S.mints.length > 1 ? toggle('t_autoSpread', 'Spread automatically', 'When a mint goes over that, move the extra to your other mints by itself, while blindsig is open. Skips any move whose fee could be over 2%.', st.autoSpread) : ''}` : ''}
    ${first && S.mints.length ? `<button class="btn primary wide" id="fin">${restoring ? 'Scan these mints' : 'Done'}</button>` : ''}`, (b) => {
    $$('.pick', b).forEach((x) => (x.onclick = () => { C.selectMint(x.dataset.u); render(); if (first) mintsSheet(true); else closeSheet(); }));
    $$('.info', b).forEach((x) => (x.onclick = () => mintDetails(x.dataset.u, () => mintsSheet(first))));
    const ab = $('#ab', b);
    const add = withBusy(ab, async (u) => {
      const url = await C.addMint(u); C.selectMint(url); render(); toast('Mint added'); N.backupMints().catch(() => {}); if (N.nutzapsOn()) N.startNutzaps();
      if (first) mintsSheet(true); else closeSheet();
    });
    $('#add', b).onsubmit = (e) => { e.preventDefault(); const u = $('#mu', b).value.trim(); if (u) add(u); };
    $$('.sug', b).forEach((x) => (x.onclick = () => add(x.dataset.u)));
    const mv = $('#mv', b); if (mv) mv.onclick = moveSheet;
    bindToggles(b, ['autoSpread'], () => { if (st.autoSpread) autoSpread(); });
    const mw = $('#mw', b); if (mw) mw.onchange = () => { st.mintWarn = +mw.value; save(); render(); toast(+mw.value ? `You’ll be warned above ${fmt(+mw.value, 'sat')} at one mint` : 'Mint warnings off'); };
    $('#dsc', b).onclick = () => NU.discover(() => mintsSheet(first));
    const fnm = $('#fnm', b); if (fnm) fnm.onclick = () => NU.findMints(S.mnemonic, () => mintsSheet(true));
    const fin = $('#fin', b);
    if (fin) fin.onclick = () => { N.startAll(); if (restoring) restoreRun(S.mints.map((m) => m.url)); else { locked = false; closeSheet(); claimPending(); } };
  }, { locked: first });
}
function mintDetails(url, back) {
  const m = mintOf(url); if (!m) return;
  const i = m.info || {};
  const balances = (m.units || ['sat']).map((u) => [unitLabel(u), esc(fmt(bal(url, u), u))]);
  sheet('Mint details', `
    <div class="mhead">${i.icon_url ? `<img src="${esc(i.icon_url)}" alt="" onerror="this.remove()">` : ''}<div><b>${esc(m.name || host(url))}</b><small>${esc(host(url))}</small></div></div>
    ${i.motd ? `<p class="warn">Message from the mint: ${esc(i.motd)}</p>` : ''}
    ${i.description ? `<p>${esc(i.description)}</p>` : ''}
    ${i.description_long ? `<details class="more"><summary>More about this mint</summary><p class="dim">${esc(i.description_long)}</p></details>` : ''}
    ${kv([...balances, ['Version', esc(i.version || '–')], ['Units', esc((m.units || ['sat']).join(', '))], ...((i.contact || []).map((c) => [esc(c.method), esc(c.info)]))])}
    <label class="lbl" for="nick">Nickname</label>
    <div class="addm"><input id="nick" class="field" value="${esc(m.nick || '')}" placeholder="${esc(m.name || host(url))}" maxlength="40"><button class="btn" id="sv">Save</button></div>
    <h3>Supported features</h3>
    <div class="chips">${(i.nuts || []).sort((a, b) => a - b).map((n) => `<span class="chip ro">NUT-${String(n).padStart(2, '0')}</span>`).join('') || '<span class="dim">Unknown</span>'}</div>
    <h3>Keysets</h3>
    <ul class="ks">${(m.keysets || []).map((k) => `<li><code>${esc(k.id.slice(0, 16))}…</code><span>${esc(k.unit)}</span><span>${k.active ? 'active' : 'inactive'}</span><span>${k.fee ? k.fee + ' ppk' : 'no fee'}</span></li>`).join('')}</ul>
    ${st.auditor ? '<h3>Auditor</h3><div id="aud" class="dim">Loading audit data…</div>' : ''}
    <div class="btnrow"><button class="btn" id="cu">Copy URL</button><button class="btn" id="rf">Refresh</button><button class="btn" id="rvw">Reviews</button></div>
    ${url !== S.active ? '<button class="btn primary wide" id="use">Use this mint</button>' : ''}
    <button class="btn wide danger" id="rm">Remove mint</button>`, (b) => {
    $('#sv', b).onclick = () => { m.nick = $('#nick', b).value.trim(); save(); render(); toast('Saved'); };
    $('#cu', b).onclick = () => copy(url, 'Mint URL copied');
    $('#rvw', b).onclick = () => NU.reviews(url, () => mintDetails(url, back), false);
    const rf = $('#rf', b); rf.onclick = withBusy(rf, async () => { await C.refreshMint(url); mintDetails(url, back); });
    const use = $('#use', b); if (use) use.onclick = () => { C.selectMint(url); render(); closeSheet(); };
    $('#rm', b).onclick = () => removeMint(url, back);
    if (st.auditor) C.auditInfo(url).then((a) => {
      const el = $('#aud', b); if (!el) return;
      if (!a) { el.innerHTML = `This mint isn’t audited yet. <a href="${esc(st.auditorUrl)}" target="_blank" rel="noopener">${esc(host(st.auditorUrl))}</a>`; return; }
      const ok = a.swaps.filter((s) => s.state === 'OK').length;
      const bars = a.swaps.slice(0, 40).reverse().map((s) => `<i class="${s.state === 'OK' ? 'ok' : 'bad'}" title="${esc(s.state)}"></i>`).join('');
      el.innerHTML = (a.swaps.length ? `<div class="audbars" aria-label="Recent swaps">${bars}</div><p class="dim small">Recent test swaps, oldest to newest. Tall bars succeeded.</p>` : '') + kv([['State', esc(a.state)], ['Mints / melts', `${a.n_mints} / ${a.n_melts}`], ['Errors', String(a.n_errors)], ['Recent swaps', a.swaps.length ? `${ok}/${a.swaps.length} ok` : '–'], ['Updated', esc(new Date(a.updated_at).toLocaleString())]])
        + `<a class="dim small" href="${esc(st.auditorUrl)}" target="_blank" rel="noopener">Full report at ${esc(host(st.auditorUrl))}</a>`
        + `<p class="dim small">The auditor holds ${esc(fmt(a.balance || 0, 'sat'))} at this mint for testing.</p><button class="btn wide" id="don">Support the auditor</button>`;
      const don = $('#don', b);
      if (don) don.onclick = withBusy(don, async () => {
        const r = await (await fetch(`${st.auditorApi.replace(/\/+$/, '')}/pr?url=${encodeURIComponent(url)}`)).json();
        const pr = String(r.pr || '').replace(/"/g, '');
        if (!pr) throw new Error('The auditor has no payment request right now.');
        C.selectMint(url); render(); sendSheet('ln', pr);
      });
    }).catch((e) => { const el = $('#aud', b); if (el) el.textContent = 'Auditor unavailable: ' + niceErr(e); });
  }, { back });
}
function removeMint(url, back) {
  const m = mintOf(url), held = (m.units || ['sat']).reduce((t, u) => t + bal(url, u), 0);
  sheet('Remove mint', `<p>${held ? `<span class="warnt">This mint still holds ecash for you.</span> Removing it deletes those proofs from this device. Move or spend them first.` : 'Remove this mint from your wallet?'}</p>
    ${held ? '<label class="chk"><input type="checkbox" id="ok"> I understand the ecash here will be lost</label>' : ''}
    <button class="btn wide danger" id="go" ${held ? 'disabled' : ''}>Remove ${esc(mintLabel(m))}</button>`, (b) => {
    const ok = $('#ok', b); if (ok) ok.onchange = () => ($('#go', b).disabled = !ok.checked);
    $('#go', b).onclick = () => {
      S.mints = S.mints.filter((x) => x.url !== url);
      for (const k of Object.keys(S.proofs)) if (k.startsWith(url + '|')) delete S.proofs[k];
      if (S.active === url) { S.active = S.mints[0]?.url || null; if (S.active) C.selectMint(S.active); }
      save(); render(); N.backupMints().catch(() => {}); mintsSheet();
    };
  }, { back: () => mintDetails(url, back) });
}
/* ================= spreading your risk across mints ================= */
function spreadSheet() {
  const limit = st.mintWarn || 100000, plan = C.spreadPlan(limit);
  const lbl = (u) => esc(mintLabel(mintOf(u) || { url: u }));
  if (!plan) return mintsSheet();
  if (!plan.moves.length) {
    return sheet('Spread your risk', `<p>${lbl(plan.from)} holds ${esc(fmt(plan.have, 'sat'))}, more than your limit of ${esc(fmt(limit, 'sat'))} at one mint.</p>
      <p class="dim">${plan.noOthers ? 'Add another mint you trust, and blindsig can move some of it there.' : 'Your other mints are full up to the limit too. Add another mint you trust, or raise the limit.'}</p>
      <button class="btn primary wide" id="spAdd">Add a mint</button>`, (b) => { $('#spAdd', b).onclick = () => mintsSheet(); }, { back: () => mintsSheet() });
  }
  const total = plan.moves.reduce((t, m) => t + m.amount, 0);
  sheet('Spread your risk', `<p>${lbl(plan.from)} holds ${esc(fmt(plan.have, 'sat'))}. Move ${esc(fmt(total, 'sat'))} to your other mints so no single mint holds too much.</p>
    <ul class="spl">${plan.moves.map((m) => `<li><span>→ ${lbl(m.to)}</span><b>${esc(fmt(m.amount, 'sat'))}</b></li>`).join('')}</ul>
    ${plan.left ? `<p class="dim small">${esc(fmt(plan.left, 'sat'))} more would need another mint.</p>` : ''}
    <p class="dim small">Each move is a Lightning payment between mints, so a small fee applies (usually under 1%).</p>
    <button class="btn primary wide" id="spGo">Move now</button>
    ${toggle('t_autoSpread', 'Spread automatically', 'When a mint goes over your limit, move the extra to your other mints by itself, while blindsig is open. Skips any move whose fee could be over 2%.', st.autoSpread)}`, (b) => {
    bindToggles(b, ['autoSpread'], () => { if (st.autoSpread) autoSpread(); });
    const go = $('#spGo', b);
    go.onclick = withBusy(go, async () => {
      let ok = 0, fail = '';
      await C.spreadRun(plan, { onStep: (mv, r, e) => { if (r) ok += mv.amount; else fail = e ? niceErr(e) : ''; render(); } });
      render();
      if (ok) { toast(`Moved ${fmt(ok, 'sat')}. Your sats are spread across your mints.`); FX.play('received'); closeSheet(); }
      else throw new Error(fail || 'Nothing was moved.');
    });
  }, { back: () => mintsSheet() });
}
// with "Spread automatically" on: check now and then, and after money comes in
let spreading = false, spreadAt = 0;
async function autoSpread() {
  if (!st.autoSpread || spreading || !st.mintWarn || Date.now() - spreadAt < 60e3 || document.hidden) return;
  const plan = C.spreadPlan(st.mintWarn);
  if (!plan || !plan.moves.length) return;
  spreading = true; spreadAt = Date.now();
  try {
    const moved = await C.spreadRun(plan, { maxFeePct: 2, onStep: () => render() });
    if (moved) toast(`Spread ${fmt(moved, 'sat')} from ${mintLabel(mintOf(plan.from) || { url: plan.from })} to your other mints.`);
  } catch {} finally { spreading = false; render(); }
}
function moveSheet() {
  const others = S.mints.filter((m) => m.url !== S.active && (m.units || []).includes(S.unit));
  if (!others.length) return toast(`No other mint supports ${unitLabel(S.unit)}.`, 'warn');
  sheet('Move funds', `<p class="dim">From ${esc(mintLabel(mintOf(S.active)))}. Pays a Lightning invoice between mints, so fees apply.</p>
    ${amountField('amt', `Available: ${esc(fmt(bal(S.active)))}`)}
    <label class="lbl" for="to">To mint</label>
    <select id="to" class="field">${others.map((m) => `<option value="${esc(m.url)}">${esc(mintLabel(m))}</option>`).join('')}</select>
    <button class="btn primary wide" id="go">Move</button>`, (b) => {
    const go = $('#go', b);
    go.onclick = withBusy(go, async () => {
      const a = readAmt(b); if (!a) return nope('Enter an amount.');
      const { inv } = await C.moveFunds($('#to', b).value, a);
      toast(inv.status === 'done' ? `Moved ${fmt(a)}` : 'Paid. Destination mint still settling.', inv.status === 'done' ? 'ok' : 'warn');
      closeSheet();
    });
  }, { back: () => mintsSheet() });
}

/* ================= settings ================= */
const MENU = [
  ['backup', 'Backup & restore', 'Seed phrase and ecash recovery'],
  ['vault', 'Time vault', 'Lock sats away until a date'],
  ['security', 'PIN lock', 'Lock and encrypt the app with a PIN'],
  ['contacts', 'Contacts', 'People and places you pay often'],
  ['p2pk', 'P2PK', 'Receive ecash locked to your keys'],
  ['privacy', 'Privacy', 'Network checks and Bitcoin price'],
  ['appearance', 'Appearance', 'Theme, sound, vibration and keypad'],
  ['hardware', 'Hardware', 'NFC cards'],
  ['experimental', 'Experimental', 'Swaps, auditor, Multinut'],
  ['advanced', 'Advanced', 'Developer tools and wallet reset'],
  ['language', 'Language', 'Choose your language'],
  ['about', 'About', 'Version and links'],
];
function settingsSheet() {
  sheet('Settings', `<ul class="menu">${MENU.map(([k, t, d]) => `<li><button data-k="${k}"><span class="mt"><b>${t}</b><small>${d}</small></span><span aria-hidden="true">›</span></button></li>`).join('')}</ul>`, (b) => {
    $$('.menu button', b).forEach((x) => (x.onclick = () => SECTIONS[x.dataset.k]()));
  });
}
const back = () => settingsSheet();
function bindToggles(b, keys, after) {
  keys.forEach((k) => {
    const el = $('#t_' + k, b); if (!el) return;
    el.onchange = () => {
      st[k] = el.checked; save(); render(); after && after(k);
    };
  });
}
const SECTIONS = {
  vault() { vaultSheet({ back: settingsSheet }); },
  backup() {
    sheet('Backup & restore', `<h3>Seed phrase</h3><p class="dim">Your seed phrase restores your wallet. Keep it private.</p>
      <button class="btn wide" id="seed">Show seed phrase</button>
      <h3>Restore ecash</h3><p class="dim">Scan your mints for ecash made by a seed phrase: this wallet’s, or another one. Ecash found with another seed is moved into this wallet.</p>
      <textarea id="other" rows="3" placeholder="Leave empty to use this wallet’s seed" spellcheck="false" autocapitalize="off"></textarea>
      <button class="btn wide" id="rst">Restore</button>
      <h3>Backup file</h3><p class="dim">One file with everything: seed phrase, ecash, history, notes and keys, locked with a password. Use it to move to a new phone, or from Safari to the Home Screen app.</p>
      <div class="btnrow"><button class="btn" id="bkc">Create backup file</button><button class="btn" id="bkr">Restore from file</button></div>
      <h3>Export</h3><button class="btn wide" id="exp">Export all ecash as tokens</button>`, (b) => {
      $('#bkc', b).onclick = () => backupCreateSheet();
      $('#bkr', b).onclick = () => backupRestoreSheet(false);
      $('#seed', b).onclick = async () => { if (await L.confirmPin(sheet, 'Show seed phrase', SECTIONS.backup)) showSeed(S.mnemonic, false, SECTIONS.backup); };
      $('#rst', b).onclick = () => {
        const o = $('#other', b).value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
        if (o && !validateMnemonic(o, wordlist)) return toast('That seed phrase isn’t valid.', 'err');
        if (!S.mints.length) return toast('Add a mint first.', 'warn');
        restoreRun(S.mints.map((m) => m.url), o || undefined);
      };
      $('#exp', b).onclick = () => exportSheet(false);
    }, { back });
  },
  contacts() { contactsSheet(back); },
  security() {
    const info = pinInfo();
    if (!info) {
      sheet('PIN lock', `<p class="dim">Ask for a PIN every time blindsig opens. The PIN also encrypts the wallet on this device, so your seed phrase and ecash can’t be read from it without the PIN.</p>
        <p class="warn">If you forget your PIN, the only way back in is your seed phrase. Make sure it’s written down first.</p>
        <label class="chk"><input type="checkbox" id="ok"> My seed phrase is written down</label>
        <button class="btn primary wide" id="on" disabled>Set up PIN</button>
        <button class="btn wide" id="sd">Show seed phrase</button>`, (b) => {
        $('#ok', b).onchange = (e) => ($('#on', b).disabled = !e.target.checked);
        $('#on', b).onclick = () => choosePin();
        $('#sd', b).onclick = () => showSeed(S.mnemonic, false, SECTIONS.security);
      }, { back });
      return;
    }
    const AFTER = [[0, 'Right away'], [60, 'After 1 minute'], [300, 'After 5 minutes'], [900, 'After 15 minutes'], [3600, 'After 1 hour']];
    sheet('PIN lock', `<p class="okline">PIN lock is on. Your wallet is encrypted on this device.</p>
      <h3>Ask again</h3><p class="dim small">How long blindsig can be in the background before it asks for your PIN again. It always asks when the app starts.</p>
      ${AFTER.map(([v, l]) => `<label class="radio"><input type="radio" name="aft" value="${v}" ${info.after === v ? 'checked' : ''}><span class="mt"><b>${l}</b></span></label>`).join('')}
      <div id="bioRow"></div>
      <h3>Confirm big sends</h3><p class="dim small">Ask for your PIN (or Face ID) before sending more than this, so someone holding your unlocked phone can’t empty the wallet.</p>
      ${[0, 1000, 10000, 100000].map((v) => [v, v ? `Over ${fmt(v, 'sat')}` : 'Never']).map(([v, l]) => `<label class="radio"><input type="radio" name="cov" value="${v}" ${(st.confirmOver || 0) === v ? 'checked' : ''}><span class="mt"><b>${l}</b></span></label>`).join('')}
      ${inDecoy() ? '' : `<h3>Decoy PIN</h3><p class="dim small">A second PIN that opens a separate, small wallet. For when someone forces you to unlock.</p>
      <button class="btn wide" id="dcy">${decoyOn() ? 'Decoy PIN: on' : 'Set up a decoy PIN'}</button>`}
      <button class="btn wide" id="lk">Lock now</button>
      ${inDecoy() ? '' : '<button class="btn wide" id="ch">Change PIN</button><button class="btn wide danger" id="off">Turn off PIN lock</button>'}`, (b) => {
      $$('input[name=aft]', b).forEach((r) => (r.onchange = () => setLockAfter(+r.value)));
      $$('input[name=cov]', b).forEach((r) => (r.onchange = () => { st.confirmOver = +r.value; save(); toast(+r.value ? `Big sends need your PIN: over ${fmt(+r.value, 'sat')}` : 'Big sends don’t need your PIN'); }));
      // Face ID / Touch ID, where the phone supports it
      BIO.bioAvailable().then((ok) => {
        const row = $('#bioRow', b); if (!ok || !row || inDecoy()) return;
        const apple = BIO.bioLabel() === 'Face ID or Touch ID';
        row.innerHTML = toggle('t_bio', apple ? 'Unlock with Face ID or Touch ID' : 'Unlock with fingerprint or face unlock', 'Your PIN still works, and is still needed to change these settings.', BIO.bioOn());
        I18N.translateTree(row);
        const t = $('#t_bio', row);
        t.onchange = async () => {
          if (!t.checked) { await BIO.clearBio(); return; }
          t.checked = false;
          const pin = await L.confirmPin(sheet, apple ? 'Face ID or Touch ID' : 'Fingerprint or face unlock', SECTIONS.security);
          if (typeof pin !== 'string') return;
          try { await BIO.bioEnroll(pin); toast(apple ? 'Face ID or Touch ID is on' : 'Fingerprint or face unlock is on'); }
          catch (e) { toast(e?.message === 'no-prf' ? 'This phone can’t unlock blindsig this way yet. Your PIN still works.' : e?.name === 'NotAllowedError' ? 'Cancelled.' : niceErr(e), 'warn'); }
          SECTIONS.security();
        };
      });
      $('#lk', b).onclick = () => { closeSheet(); L.relock(); };
      const dcy = $('#dcy', b); if (dcy) dcy.onclick = () => decoySheet();
      if (inDecoy()) return;
      $('#ch', b).onclick = async () => { if (await L.confirmPin(sheet, 'Change PIN', SECTIONS.security)) choosePin(true); };
      $('#off', b).onclick = async () => {
        // the decoy lives inside the PIN lock: remove it first, which moves its ecash back here
        if (decoyOn()) { toast('Remove the decoy PIN first. That moves its ecash back here.', 'warn'); return decoySheet(); }
        if (!(await L.confirmPin(sheet, 'Turn off PIN lock', SECTIONS.security))) return;
        await clearPin(); toast('PIN lock is off'); render(); SECTIONS.security();
      };
    }, { back });
  },
  p2pk() {
    sheet('P2PK', `<p class="dim">Generate keys to receive ecash locked to you. Experimental: if you lose these keys, ecash locked to them can’t be unlocked. Keys are stored with your wallet but are not derived from your seed.</p>
      <div class="btnrow"><button class="btn primary" id="gen">Generate key</button><button class="btn" id="imp">Import nsec</button></div>
      ${toggle('t_p2pkQuick', 'Quick access', 'Show your locking key in Receive.', st.p2pkQuick)}
      <h3>${`Keys: ${S.p2pk.length}`}</h3>
      <ul class="keys">${S.p2pk.map((k) => `<li><button data-p="${esc(k.pub)}"><code>${esc(k.pub.slice(0, 20))}…${esc(k.pub.slice(-6))}</code>${k.refund ? '<em class="pill">returns</em>' : k.used ? '<em class="pill">used</em>' : ''}</button></li>`).join('')}</ul>`, (b) => {
      $('#gen', b).onclick = () => { C.newP2pkKey(); toast('Key generated'); SECTIONS.p2pk(); };
      $('#imp', b).onclick = () => importNsecSheet();
      bindToggles(b, ['p2pkQuick']);
      $$('.keys button', b).forEach((x) => (x.onclick = () => copy(x.dataset.p, 'Public key copied')));
    }, { back });
  },
  privacy() {
    sheet('Privacy', `<p class="dim">These settings change how often the wallet talks to mints and other services.</p>
      ${toggle('t_checkIncoming', 'Check incoming invoice', 'Poll the invoice you’re looking at until it’s paid.', st.checkIncoming)}
      ${toggle('t_checkStartup', 'Check pending on startup', 'Check pending invoices and payments when the app opens.', st.checkStartup)}
      ${toggle('t_checkAll', 'Check all invoices', 'Re-check unpaid invoices in the background for up to two weeks.', st.checkAll)}
      ${toggle('t_checkSent', 'Check sent ecash', 'Periodically check whether tokens you sent were claimed.', st.checkSent)}
      ${toggle('t_hideHistory', 'Hide history', 'Fold your transactions away on the main screen for a clean look. Tap History to open it.', st.hideHistory)}
      ${toggle('t_hideAmounts', 'Hide amounts', 'Show •••• instead of your balance and payment amounts on the main screen. Tap the balance to switch.', st.hideAmounts)}
      ${toggle('t_websockets', 'Use WebSockets', 'Instant updates from mints that support it (NUT-17).', st.websockets)}
      ${toggle('t_fiat', 'Get exchange rate from Coinbase', 'Show your balance in fiat.', st.fiat)}
      <label class="lbl" for="cur">Fiat currency</label>
      <select id="cur" class="field">${FIAT_CURRENCIES.map((c) => `<option ${c === st.fiatCur ? 'selected' : ''}>${c}</option>`).join('')}</select>`, (b) => {
      bindToggles(b, ['hideHistory', 'hideAmounts', 'checkIncoming', 'checkStartup', 'checkAll', 'checkSent', 'websockets', 'fiat'], (k) => { if (k === 'fiat' && st.fiat) C.loadPrice().then(render); schedule(); });
      $('#cur', b).onchange = (e) => { st.fiatCur = e.target.value; save(); C.loadPrice().then(render); };
    }, { back });
  },
  appearance() {
    const THEMES = [['green', 'Green'], ['white', 'White'], ['amber', 'Amber'], ['orange', 'Burnt orange']];
    sheet('Appearance', `<h3>Theme</h3>
      <div class="themes">${THEMES.map(([k, l]) => `<button class="th" data-th="${k}" aria-pressed="${st.theme === k}"><i class="sw sw-${k}"></i>${l}</button>`).join('')}</div>
      ${toggle('t_keypad', 'On-screen keypad', 'Use the built-in number pad for amounts.', st.keypad)}
      ${toggle('t_btcSymbol', 'Use ₿ symbol', 'Show ₿1,000 instead of 1,000 sat.', st.btcSymbol)}
      <h3>Sound and motion</h3>
      ${toggle('t_sounds', 'Sounds', 'A coin sound when money arrives, a soft pop when it leaves.', st.sounds)}
      ${FX.isIOS ? toggle('t_soundsOnSilent', 'Play on silent', 'Hear sounds even when your iPhone is set to silent. Music from other apps may pause while blindsig is open.', st.soundsOnSilent) : ''}
      ${toggle('t_haptics', 'Vibration', 'A short buzz when money arrives or leaves, on phones that allow it.', st.haptics !== false)}
      ${toggle('t_motion', 'Animations', 'Confetti and a drawn checkmark when a payment completes. Off when your device asks for reduced motion.', st.motion)}`, (b) => {
      $$('.th', b).forEach((x) => (x.onclick = () => { st.theme = x.dataset.th; save(); render(); SECTIONS.appearance(); }));
      bindToggles(b, ['keypad', 'btcSymbol', 'sounds', 'soundsOnSilent', 'haptics', 'motion'], (k) => {
        if (k === 'soundsOnSilent') { FX.setSession(); if (st.sounds) FX.play('received'); }
        if (k === 'sounds' && st.sounds) FX.play('received');
        if (k === 'haptics' && st.haptics) FX.buzz('received');
        if (k === 'motion' && st.motion) FX.confetti(null, true);
      });
    }, { back });
  },
  hardware() {
    const ok = 'NDEFReader' in window;
    sheet('Hardware', `${ok ? '' : '<p class="warn">This browser doesn’t support Web NFC. It works in Chrome on Android.</p>'}
      <h3>NFC encoding</h3><p class="dim">How tokens are written to NFC cards.</p>
      ${[['text', 'Text', 'Store the token as plain text'], ['url', 'URL', 'Store a link to this wallet with the token'], ['binary', 'Binary', 'Store the token as compact binary']].map(([k, t, d]) => `<label class="radio"><input type="radio" name="enc" value="${k}" ${st.nfcEncoding === k ? 'checked' : ''}><span class="mt"><b>${t}</b><small>${d}</small></span></label>`).join('')}
      ${toggle('t_nfcQuick', 'Quick access to NFC', 'Show an NFC button when receiving ecash.', st.nfcQuick)}`, (b) => {
      $$('input[name=enc]', b).forEach((r) => (r.onchange = () => { st.nfcEncoding = r.value; save(); }));
      bindToggles(b, ['nfcQuick']);
    }, { back });
  },
  experimental() {
    sheet('Experimental', `<p class="dim">These features are new. Use small amounts.</p>
      ${toggle('t_receiveSwaps', 'Receive swaps', 'Offer to swap ecash from another mint into your active mint when receiving.', st.receiveSwaps)}
      ${FX.isIOS ? '' : toggle('t_autoPaste', 'Paste ecash automatically', 'Fill in a token from your clipboard when you open Receive.', st.autoPaste)}
      ${toggle('t_multinut', 'Multinut', 'Pay one invoice from several mints at once (NUT-15).', st.multinut)}
      ${toggle('t_auditor', 'Mint auditor', 'Show reliability data from an independent auditor in mint details.', st.auditor)}
      <label class="lbl" for="au">Auditor URL</label><input id="au" class="field" value="${esc(st.auditorUrl)}">
      <label class="lbl" for="aa">Auditor API URL</label><input id="aa" class="field" value="${esc(st.auditorApi)}">`, (b) => {
      bindToggles(b, ['receiveSwaps', 'autoPaste', 'multinut', 'auditor']);
      $('#au', b).onchange = (e) => { st.auditorUrl = e.target.value.trim() || DEFAULT_SETTINGS.auditorUrl; save(); };
      $('#aa', b).onchange = (e) => { st.auditorApi = e.target.value.trim() || DEFAULT_SETTINGS.auditorApi; save(); };
    }, { back });
  },
  advanced() {
    const ids = Object.entries(S.counters);
    sheet('Advanced', `<p class="dim">For troubleshooting. Read each description before using it.</p>
      <h3>Remove spent proofs</h3><p class="dim small">Ask your mints which ecash is already spent and remove it. Use if your balance looks wrong.</p>
      <button class="btn wide" id="sw">Remove spent proofs</button>
      <h3>Export active proofs</h3><p class="dim small">Copy the whole balance of the active mint and unit as one token.</p>
      <button class="btn wide" id="ex">Export active proofs</button>
      <h3>Keyset counters</h3><p class="dim small">Tap a keyset to bump its counter by 10. Fixes “outputs have already been signed” errors.</p>
      <ul class="ks">${ids.length ? ids.map(([id, n]) => `<li><button class="kc" data-id="${esc(id)}"><code>${esc(id.slice(0, 18))}…</code><span>counter ${n}</span></button></li>`).join('') : '<li class="dim">No counters yet.</li>'}</ul>
      <h3>Release pending payments</h3><p class="dim small">Return ecash held for in-flight Lightning payments to your balance. If a payment did go through, run “Remove spent proofs” after.</p>
      <button class="btn wide" id="rel">Release pending payments</button>
      <h3>New seed phrase</h3><p class="dim small">Generate a new seed and move your whole balance onto it. Your old seed will no longer restore this ecash.</p>
      <button class="btn wide" id="ns">Generate new seed phrase</button>
      <h3>Debug console</h3><p class="dim small">Opens a JavaScript console for debugging. Never paste anything into it that you don’t understand. A thief might try to trick you into it.</p>
      <button class="btn wide" id="dbg">Toggle debug console</button>
      <h3>Onboarding</h3><button class="btn wide" id="ob">Show onboarding again</button>
      <h3>Reset</h3><p class="dim small">Deletes everything on this device. Back up your seed first.</p>
      <button class="btn wide danger" id="wipe">Reset wallet data</button>`, (b) => {
      const sw = $('#sw', b); sw.onclick = withBusy(sw, async () => { const r = await C.sweepSpent(); render(); toast(r ? `Removed ${fmt(r)} of spent proofs` : 'All proofs are valid'); });
      $('#ex', b).onclick = () => exportSheet(true);
      $$('.kc', b).forEach((x) => (x.onclick = () => { S.counters[x.dataset.id] = (S.counters[x.dataset.id] || 0) + 10; save(); SECTIONS.advanced(); }));
      const rel = $('#rel', b); rel.onclick = withBusy(rel, async () => { const n = await C.releasePending(); render(); toast(n ? `Pending payments released: ${n}` : 'Nothing to release. Payments still in flight are left to settle.'); });
      $('#ns', b).onclick = newSeedSheet;
      $('#ob', b).onclick = () => welcome(0, true);
      $('#dbg', b).onclick = () => {
        const el = document.querySelector('#eruda');
        if (el) { try { window.eruda?.destroy(); } catch {} el.remove(); return; }
        const sc = document.createElement('script'); sc.src = 'vendor/eruda.js';
        sc.onload = () => { try { window.eruda.init(); } catch {} };
        sc.onerror = () => toast('Could not load the debug console.', 'err');
        document.body.appendChild(sc);
      };
      $('#wipe', b).onclick = wipeSheet;
    }, { back });
  },
  language() {
    const cur = st.lang || I18N.detect();
    sheet('Language', `<ul class="langs">${I18N.LANGS.map(([c, n]) => `<li><label class="radio"><input type="radio" name="lg" value="${c}" ${c === cur ? 'checked' : ''}><span class="mt"><b data-notr>${esc(n)}</b></span></label></li>`).join('')}</ul>`, (b) => {
      $$('input[name=lg]', b).forEach((r) => (r.onchange = async () => { st.lang = r.value; save(); await I18N.setLang(r.value); render(); }));
    }, { back });
  },
  about() {
    sheet('About', `<p><b>blindsig ${VERSION}</b></p>
      <p class="dim">A Cashu ecash wallet built on cashu-ts. Ecash and your seed are stored only in this browser. Mints are custodians: use ones you trust and keep amounts small.</p>
      ${kv([['Library', 'cashu-ts 4.14'], ['Proofs held', String(Object.values(S.proofs).reduce((t, a) => t + (a?.length || 0), 0))], ['Mints', String(S.mints.length)], ['Storage', storageKind()], ['Encryption', pinOn() ? 'PIN (AES-256)' : 'Off']])}
      <button class="btn wide" id="upd">Check for updates</button>
      <h3>Support blindsig</h3>
      <p class="dim">blindsig is free and open source. If it’s useful to you, a tip helps keep it going.</p>
      <div class="addrcard"><small class="dim">Lightning address</small><b>${esc(TIP_ADDR)}</b>
        <div class="btnrow"><button class="btn" id="tcp">Copy</button><button class="btn" id="tqr">QR code</button></div><div id="tq"></div>
        ${S.npc?.address === TIP_ADDR ? '' : '<button class="btn primary wide" id="tip">Send a tip</button>'}</div>
      <h3>Links</h3>
      <a class="btn wide" href="https://cashu.space" target="_blank" rel="noopener">cashu.space</a>
      <a class="btn wide" href="https://github.com/Random21m/blindsig" target="_blank" rel="noopener">Source code</a>`, (b) => {
      $('#tcp', b).onclick = () => copy(TIP_ADDR, 'Address copied');
      $('#tqr', b).onclick = () => { const q = $('#tq', b); if (q.innerHTML) { q.innerHTML = ''; return; } qrSvg('lightning:' + TIP_ADDR).then((s) => { q.innerHTML = `<div class="qr">${s}</div>`; }); };
      const tip = $('#tip', b); if (tip) tip.onclick = () => sendSheet('ln', TIP_ADDR);
      const u = $('#upd', b);
      u.onclick = withBusy(u, async () => {
        const r = await checkNow();
        toast(r === 'found' ? 'Downloading the new version. It’s ready in a moment.' : r === 'latest' ? 'You have the latest version.' : 'Couldn’t check for updates. Are you online?', r === 'offline' ? 'warn' : 'ok');
      });
    }, { back });
  },
};
// common PINs a thief would try first
const easyPin = (p) => /^(\d)\1+$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p) || ['121212', '112233', '123123', '696969', '1212', '6969', '2580', '258025'].includes(p);
/* ================= decoy PIN ================= */
// a second PIN that opens a separate, small wallet; the real one stays sealed underneath
const DECOY_AMOUNTS = [0, 1000, 5000, 10000, 21000];
function decoyAmounts(b) {
  const have = bal(S.active, 'sat');
  return `<h3>Put some sats in it</h3><p class="dim small">A decoy with a little money in it looks real. Moved from ${esc(mintLabel(mintOf(S.active) || { url: S.active }))} (you have ${esc(fmt(have, 'sat'))}).</p>
    ${DECOY_AMOUNTS.map((v, i) => `<label class="radio"><input type="radio" name="dam" value="${v}" ${i === 0 ? 'checked' : ''} ${v > have ? 'disabled' : ''}><span class="mt"><b>${v ? esc(fmt(v, 'sat')) : 'Nothing for now'}</b></span></label>`).join('')}`;
}
async function fundDecoy(amount) {
  if (!amount) return null;
  const h = await C.sendEcash(amount);
  h.note = I18N.t('Moved to decoy wallet'); save();
  return { id: 'dcy' + Date.now().toString(36), ts: Date.now(), kind: 'ecash-in', status: 'pending', token: h.token, amount, unit: 'sat', mint: h.mint, auto: true };
}
function decoySheet() {
  if (inDecoy()) return SECTIONS.security();
  if (decoyOn()) {
    return sheet('Decoy PIN', `<p class="okline">Decoy PIN is on.</p>
      <p class="dim">Enter it instead of your PIN when blindsig opens, and the decoy wallet opens instead of this one. To try it, tap Lock now and enter the decoy PIN.</p>
      <button class="btn wide" id="dlk">Lock now</button>
      <button class="btn wide" id="dadd">Add sats to the decoy</button>
      <button class="btn wide danger" id="drm">Remove decoy PIN</button>
      <p class="dim small">Removing it moves the decoy’s ecash back into this wallet.</p>`, (b) => {
      $('#dlk', b).onclick = () => { closeSheet(); L.relock(); };
      $('#dadd', b).onclick = () => decoyPinThen('Add sats to the decoy', (pin) => sheet('Add sats to the decoy', `${decoyAmounts()}<button class="btn primary wide" id="dgo">Add</button>`, (bb) => {
        const go = $('#dgo', bb);
        go.onclick = withBusy(go, async () => {
          const v = +($('input[name=dam]:checked', bb)?.value || 0); if (!v) return nope('Pick an amount.');
          const e = await fundDecoy(v);
          if (!(await editDecoy(pin, (st) => { st.history.unshift(e); }))) throw new Error('decoy PIN changed');
          render(); toast(`${fmt(v, 'sat')} moved to the decoy wallet`); decoySheet();
        });
      }, { back: decoySheet }));
      $('#drm', b).onclick = () => decoyPinThen('Remove decoy PIN', async (pin) => {
        sheet('Remove decoy PIN', '<p class="dim center">Moving the decoy’s ecash back…</p>', null, { locked: true });
        let got = 0;
        try { await editDecoy(pin, async (st) => { got = await C.sweepState(st); }); } catch (e) { console.error(e); }
        await clearDecoy(); locked = false; render();
        toast(got ? `Decoy removed. ${fmt(got, 'sat')} moved back to this wallet.` : 'Decoy removed');
        SECTIONS.security();
      });
    }, { back: SECTIONS.security });
  }
  sheet('Decoy PIN', `<p>A second PIN that opens a separate, small wallet instead of this one.</p>
    <p class="dim">If someone ever forces you to unlock blindsig, enter the decoy PIN. They see only the decoy wallet, with its own balance and history. This wallet stays locked and out of sight.</p>
    <ul class="dim small tips"><li>Put a little in the decoy so it looks real.</li><li>Face ID always opens your real wallet. Use the PIN when it matters.</li><li>Lock now and Ask again work for both: whichever PIN you enter decides the wallet.</li></ul>
    <button class="btn primary wide" id="dgo">Set up a decoy PIN</button>`, (b) => {
    $('#dgo', b).onclick = () => chooseDecoy();
  }, { back: SECTIONS.security });
}
function decoyPinThen(title, fn) {
  const info = pinInfo();
  sheet(title, '<div id="pcBox"></div>', (b) => L.pinPad($('#pcBox', b), {
    len: info.len, title: 'Enter your decoy PIN',
    onPin: async (p) => { const ok = await editDecoy(p, () => {}); if (!ok) return 'That isn’t your decoy PIN.'; later(() => fn(p)); return true; },
  }), { back: decoySheet });
}
function chooseDecoy() {
  const info = pinInfo();
  sheet('Decoy PIN', '<div id="pcBox"></div>', (b) => {
    const box = $('#pcBox', b);
    const first = (msg) => {
      const pad = L.pinPad(box, {
        len: info.len, title: 'Choose a decoy PIN', sub: 'Different from your real PIN, and the same length.',
        onPin: async (p) => (easyPin(p) ? 'That PIN is too easy to guess. Pick another.' : (await isMainPin(p)) ? 'That’s your real PIN. Pick a different one.' : (later(() => again(p)), true)),
      });
      if (msg) pad.setMsg(msg, true);
    };
    const again = (p1) => L.pinPad(box, {
      len: p1.length, title: 'Enter it again', sub: 'To make sure you typed it right.',
      onPin: async (p) => { if (p !== p1) { later(() => first('Those PINs didn’t match. Try again.')); return true; } later(() => decoyFund(p)); return true; },
    });
    first();
  }, { back: decoySheet });
}
function decoyFund(pin) {
  sheet('Decoy wallet', `${decoyAmounts()}<button class="btn primary wide" id="dmk">Create decoy wallet</button>`, (b) => {
    const go = $('#dmk', b);
    go.onclick = withBusy(go, async () => {
      const v = +($('input[name=dam]:checked', b)?.value || 0);
      const st = freshState();
      st.mnemonic = generateMnemonic(wordlist, 128); st.onboarded = true;
      st.mints = S.mints.map((m) => ({ ...m })); st.active = S.active; st.unit = 'sat'; st.price = { ...S.price };
      for (const k of ['theme', 'lang', 'fiat', 'fiatCur', 'sounds', 'haptics', 'soundsOnSilent', 'motion', 'keypad', 'btcSymbol', 'confirmOver']) if (k in S.settings) st.settings[k] = S.settings[k];
      st.settings.backupNagged = Date.now();
      const e = await fundDecoy(v); if (e) st.history.unshift(e);
      await setDecoy(pin, st);
      render(); toast('Decoy PIN is on'); decoySheet();
    });
  }, { back: decoySheet });
}
function choosePin(change) {
  const title = change ? 'Change PIN' : 'Set up PIN';
  sheet(title, '<div id="pcBox"></div>', (b) => {
    const box = $('#pcBox', b);
    const first = (msg) => {
      const pad = L.pinPad(box, {
        len: decoyOn() ? pinInfo().len : 6, lenSwitch: !decoyOn(), title: change ? 'Choose a new PIN' : 'Choose a PIN',
        sub: 'You’ll enter it every time blindsig opens.',
        onPin: async (p) => (easyPin(p) ? 'That PIN is too easy to guess. Pick another.' : (await isDecoyPin(p)) ? 'That’s your decoy PIN. Pick another.' : (later(() => again(p)), true)),
      });
      if (msg) pad.setMsg(msg, true);
    };
    const again = (p1) => L.pinPad(box, {
      len: p1.length, title: 'Enter it again', sub: 'To make sure you typed it right.',
      onPin: async (p) => {
        if (p !== p1) { later(() => first('Those PINs didn’t match. Try again.')); return true; }
        try { await setPin(p); } catch (e) { return niceErr(e); }
        toast(change ? 'PIN changed' : 'PIN lock is on. Your wallet is now encrypted.');
        render(); SECTIONS.security(); return true;
      },
    });
    first();
  }, { back: SECTIONS.security });
}
/* ---------- backup file ---------- */
function saveFile(text, name, type = 'application/json') {
  const blob = new Blob([text], { type });
  const file = typeof File === 'function' ? new File([blob], name, { type }) : null;
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60e3); };
  // phones: the share sheet has "Save to Files"; computers: a normal download
  if (file && navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], title: 'blindsig backup' }).then(() => true, (e) => { if (e?.name === 'AbortError') return false; download(); return true; });
  download(); return Promise.resolve(true);
}
function backupCreateSheet() {
  sheet('Create backup file', `<p class="dim">Choose a password for the file. You’ll need it to restore. If you lose it, the file can’t be opened.</p>
    <label class="lbl" for="bp1">Password</label><input id="bp1" class="field" type="password" autocomplete="new-password" minlength="8">
    <label class="lbl" for="bp2">Same password again</label><input id="bp2" class="field" type="password" autocomplete="new-password">
    <p class="hint" id="bph">At least 8 characters.</p>
    <button class="btn primary wide" id="bgo">Create backup file</button>`, (b) => {
    const go = $('#bgo', b);
    go.onclick = withBusy(go, async () => {
      const p1 = $('#bp1', b).value, p2 = $('#bp2', b).value;
      if (p1.length < 8) return nope('Use at least 8 characters.');
      if (p1 !== p2) return nope('The passwords don’t match.');
      const text = await encryptBackup(p1);
      const d = new Date(), name = `blindsig-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
      sheet('Backup ready', `<p class="okline">Your backup file is ready.</p>
        <p class="warn">Anyone with this file and its password can take your ecash. Keep both safe, and don’t use the same wallet on two phones at once.</p>
        <button class="btn primary wide" id="bsv">Save file</button>
        <p class="dim small center">${esc(name)}</p>`, (b2) => {
        $('#bsv', b2).onclick = async () => { if (await saveFile(text, name)) { S.lastBackup = Date.now(); save(); toast('Backup file saved'); } };
      }, { back: SECTIONS.backup });
    });
  }, { back: SECTIONS.backup });
}
function backupRestoreSheet(onboarding) {
  sheet('Restore from backup file', `<p class="dim">Pick a blindsig backup file and enter its password.</p>
    <input id="bf" type="file" accept=".json,application/json,text/plain" class="field">
    <label class="lbl" for="bpw">Password</label><input id="bpw" class="field" type="password" autocomplete="current-password">
    <button class="btn primary wide" id="bgo">Restore</button>`, (b) => {
    const go = $('#bgo', b);
    go.onclick = withBusy(go, async () => {
      const f = $('#bf', b).files?.[0];
      if (!f) return nope('Choose the backup file first.');
      let r;
      try { r = await decryptBackup(await f.text(), $('#bpw', b).value); } catch (e) {
        return nope({ 'not-backup': 'That file isn’t a blindsig backup.', 'wrong-password': 'Wrong password, or the file is damaged.', damaged: 'The backup file is damaged.' }[e.message] || niceErr(e));
      }
      const finish = async () => { r.state.afterImport = 1; r.state.onboarded = true; await replaceState(r.state); if (pendingToken) history.replaceState(null, '', location.pathname + '#token=' + encodeURIComponent(pendingToken)); location.reload(); };
      const have = S.mnemonic && (S.mints.some((m) => bal(m.url) > 0) || S.history.length);
      if (onboarding || !have) return finish();
      // replacing a wallet that's in use: make sure its owner can get it back
      const now = S.mints.reduce((t, m) => t + bal(m.url), 0);
      sheet('Replace this wallet?', `<p class="warn">Restoring replaces the wallet on this device. Make sure you have its seed phrase or a backup file first.</p>
        ${kv([['Balance on this device', esc(fmt(now))], ['Backup made', esc(r.created ? new Date(r.created).toLocaleString() : '?')]])}
        <label class="chk"><input type="checkbox" id="rok"> I can get the current wallet back</label>
        <button class="btn wide danger" id="rgo" disabled>Replace with backup</button>`, (b2) => {
        $('#rok', b2).onchange = (e) => ($('#rgo', b2).disabled = !e.target.checked);
        const rg = $('#rgo', b2); rg.onclick = withBusy(rg, finish);
      }, { back: () => backupRestoreSheet(false) });
    });
  }, { locked: onboarding, back: onboarding ? () => welcome(SLIDES.length) : SECTIONS.backup });
}
/* ---------- contacts ---------- */
// people and places you pay often: a name and a Lightning address, LNURL or BOLT12 offer.
// Kept with the wallet on this device (encrypted with the PIN lock, included in backup files).
function contactsSheet(backTo) {
  const list = [...(S.contacts || [])].sort((a, b) => a.name.localeCompare(b.name));
  sheet('Contacts', `${list.length ? `<ul class="menu">${list.map((c) => `<li><button data-id="${esc(c.id)}"><span class="mt"><b dir="auto">${esc(c.name)}</b><small dir="ltr">${esc(c.to.length > 42 ? c.to.slice(0, 26) + '…' + c.to.slice(-10) : c.to)}</small></span><span aria-hidden="true">›</span></button></li>`).join('')}</ul>` : '<p class="dim">No contacts yet. Save someone here, or tap “Save as contact” after paying a Lightning address.</p>'}
    <button class="btn primary wide" id="ctAdd">Add contact</button>`, (b) => {
    $$('.menu button', b).forEach((x) => (x.onclick = () => { const c = S.contacts.find((y) => y.id === x.dataset.id); if (c) contactEdit(c, () => contactsSheet(backTo)); }));
    $('#ctAdd', b).onclick = () => contactEdit({}, () => contactsSheet(backTo));
  }, { back: backTo });
}
function contactEdit(c, after) {
  const isNew = !c.id;
  sheet(isNew ? 'Add contact' : 'Contact', `<label class="lbl" for="cn">Name</label><input id="cn" class="field" maxlength="40" autocomplete="off" dir="auto" value="${esc(c.name || '')}">
    <label class="lbl" for="ct">Lightning address, LNURL, offer or npub</label><textarea id="ct" rows="2" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(c.to || '')}</textarea>
    <button class="btn primary wide" id="csv">${isNew ? 'Save contact' : 'Save changes'}</button>
    ${isNew ? '' : '<button class="btn wide" id="cpay">Pay</button><button class="btn wide danger" id="cdel">Delete contact</button>'}`, (b) => {
    $('#csv', b).onclick = () => {
      const name = $('#cn', b).value.trim();
      let to = $('#ct', b).value.trim().replace(/^lightning:/i, '');
      if (/^npub1[0-9a-z]{58}$/i.test(to)) to = to.toLowerCase() + '@npub.cash'; // an npub's Lightning address
      if (!name) return nope('Give the contact a name.');
      if (!reusableTarget(to)) return nope('That isn’t a Lightning address, LNURL, offer or npub.');
      to = reusableTarget(to);
      if (S.contacts.some((y) => y.id !== c.id && y.to.toLowerCase() === to.toLowerCase())) return nope('You already have a contact with that address.');
      if (isNew) S.contacts.push({ id: Math.random().toString(36).slice(2, 10), name, to, last: Date.now() });
      else Object.assign(S.contacts.find((y) => y.id === c.id), { name, to });
      save(); toast(isNew ? 'Contact saved' : 'Contact updated'); after();
    };
    const cp = $('#cpay', b); if (cp) cp.onclick = () => sendSheet('ln', c.to);
    const cd = $('#cdel', b); if (cd) cd.onclick = () => { S.contacts = S.contacts.filter((y) => y.id !== c.id); save(); toast('Contact deleted'); after(); };
    if (isNew && !c.to) later(() => $('#cn', b)?.focus());
  }, { back: after });
}
function importNsecSheet() {
  sheet('Import nsec', `<p class="dim">Use a nostr private key as a P2PK key, so ecash locked to your npub can be redeemed here.</p>
    <input id="ns" class="field" placeholder="nsec1…" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="btn primary wide" id="go">Import</button>`, (b) => {
    $('#go', b).onclick = () => { try { C.importNsec($('#ns', b).value); toast('Key imported'); SECTIONS.p2pk(); } catch (e) { toast(niceErr(e), 'err'); } };
  }, { back: SECTIONS.p2pk });
}
function exportSheet(activeOnly) {
  const list = [];
  for (const m of S.mints) for (const u of m.units || ['sat']) {
    if (activeOnly && (m.url !== S.active || u !== S.unit)) continue;
    const p = getProofs(m.url, u); if (p.length) list.push([m, u, C.getEncodedToken({ mint: m.url, proofs: p, unit: u })]);
  }
  const all = list.map((x) => x[2]).join('\n\n');
  sheet('Export', `<p class="warn">These tokens are your money. Anyone who sees them can spend them.</p>
    ${list.length ? list.map(([m, u, t]) => `<p class="small"><b>${esc(mintLabel(m))}</b> · ${esc(fmt(sum(getProofs(m.url, u)), u))}</p>${armor(t)}`).join('') + '<button class="btn primary wide" id="cp">Copy all</button>' : '<p class="dim">Nothing to export.</p>'}`, (b) => {
    const cp = $('#cp', b); if (cp) cp.onclick = () => copy(all, 'Tokens copied');
  }, { back: activeOnly ? SECTIONS.advanced : SECTIONS.backup });
}
function newSeedSheet() {
  sheet('New seed phrase', `<p class="warn">Your balance will be moved onto the new seed. Write the new words down before continuing.</p>
    <label class="chk"><input type="checkbox" id="ok"> I understand my old seed phrase will stop working</label>
    <button class="btn wide danger" id="go" disabled>Generate new seed</button>`, (b) => {
    $('#ok', b).onchange = (e) => ($('#go', b).disabled = !e.target.checked);
    $('#go', b).onclick = () => {
      const m = generateMnemonic(wordlist, 128);
      sheet('New seed phrase', `${seedGrid(m)}<label class="chk"><input type="checkbox" id="ok2"> I wrote down the new words</label>
        <button class="btn primary wide" id="go2" disabled>Switch to new seed</button><pre class="term" id="lg" hidden></pre>`, (b2) => {
        $('#ok2', b2).onchange = (e) => ($('#go2', b2).disabled = !e.target.checked);
        const g = $('#go2', b2);
        g.onclick = withBusy(g, async () => {
          const lg = $('#lg', b2); lg.hidden = false;
          C.setSeed(m);
          await C.rekeyAll((s) => (lg.textContent += '> ' + s + '\n'));
          lg.textContent += '> done\n'; toast('New seed is active'); render();
          later(() => { g.textContent = 'Close'; g.onclick = () => closeSheet(); });
        });
      }, { locked: true });
    };
  }, { back: SECTIONS.advanced });
}
function wipeSheet() {
  sheet('Reset wallet', `<p class="warn">Deletes your seed, mints and all ecash on this device. Without your seed phrase the funds are gone.</p>
    <p>Type “reset” to confirm.</p><input id="cf" class="field" autocomplete="off" autocapitalize="off">
    <button class="btn wide danger" id="go" disabled>Reset everything</button>`, (b) => {
    $('#cf', b).oninput = (e) => ($('#go', b).disabled = e.target.value.trim().toLowerCase() !== 'reset');
    $('#go', b).onclick = async () => { N.stopAll(); await wipeStore(); location.replace(location.pathname); };
  }, { back: SECTIONS.advanced });
}

/* ================= NFC ================= */
async function nfcWrite(token) {
  const w = new window.NDEFReader();
  let rec;
  if (st.nfcEncoding === 'url') rec = { recordType: 'url', data: location.origin + location.pathname + '#token=' + token };
  else if (st.nfcEncoding === 'binary') rec = { recordType: 'mime', mediaType: 'application/octet-stream', data: getEncodedTokenBinary(await decodeForBinary(token)) };
  else rec = { recordType: 'text', data: token };
  toast('Hold the card to your phone…', 'warn');
  await w.write({ records: [rec] });
  toast('Written to NFC card');
}
async function decodeForBinary(token) {
  const t = C.parseToken(token);
  const w = await C.walletFor(t.mint, t.unit);
  return w.decodeToken(t.str);
}
async function nfcRead(cb) {
  try {
    const r = new window.NDEFReader(); const ctrl = new AbortController();
    await r.scan({ signal: ctrl.signal });
    toast('Hold an NFC card to your phone…', 'warn');
    r.onreading = (ev) => {
      for (const rec of ev.message.records) {
        let txt = '';
        if (rec.recordType === 'text' || rec.recordType === 'url') txt = new TextDecoder(rec.encoding || 'utf-8').decode(rec.data);
        else if (rec.recordType === 'mime') { try { txt = C.getEncodedToken(getDecodedTokenBinary(new Uint8Array(rec.data.buffer))); } catch {} }
        const m = txt.match(/cashu[AB][A-Za-z0-9_\-=+/]+/);
        if (m) { ctrl.abort(); cb(m[0]); return; }
      }
      toast('No token on that card.', 'warn');
    };
  } catch (e) { toast('NFC: ' + niceErr(e), 'err'); }
}

/* ================= scanner ================= */
let stream = null, raf = 0, onScan = null, urDec = null;
async function startScan(cb) {
  onScan = cb; urDec = null;
  const sc = $('#scanner'), v = $('video', sc);
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch { toast('Camera unavailable. Paste instead.', 'warn'); return; }
  sc.hidden = false; $('#scanProg').textContent = ''; v.srcObject = stream; await v.play().catch(() => {});
  const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
  const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  let last = 0;
  const loop = async (t) => {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (t - last < 120 || v.readyState < 2) return; last = t;
    let txt = null;
    try {
      if (detector) { const r = await detector.detect(v); txt = r[0]?.rawValue; }
      else {
        const s = Math.min(1, 640 / v.videoWidth); c.width = v.videoWidth * s; c.height = v.videoHeight * s;
        ctx.drawImage(v, 0, 0, c.width, c.height);
        txt = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' })?.data;
      }
    } catch {}
    if (!txt) return;
    if (/^ur:/i.test(txt)) {
      urDec = urDec || new URDecoder();
      try { urDec.receivePart(txt.toLowerCase()); } catch {}
      $('#scanProg').textContent = `Animated code · ${Math.round(urDec.estimatedPercentComplete() * 100)}%`;
      if (urDec.isComplete() && urDec.isSuccess()) { const out = new TextDecoder().decode(urDec.resultUR().decodeCBOR()); const f = onScan; stopScan(); f && f(out); }
      return;
    }
    const f = onScan; stopScan(); f && f(txt.trim());
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
  if (/^(cashu:)?cashu[AB]/i.test(t) || /^web\+cashu:/i.test(t)) return receiveSheet('ecash', t);
  if (C.isInvoice(t) || C.isAddress(t) || C.isLnurl(t) || N.isRequest(t) || C.isOffer(t) || C.parseBitcoin(t)) return sendSheet('ln', t);
  if (C.hasEmojiToken(t)) return receiveSheet('ecash', t);
  if (isNpub(t)) return nutzapSheet(t);
  if (/[#?]token=/.test(t)) { const m = t.match(/token=([^&]+)/); if (m) return receiveSheet('ecash', decodeURIComponent(m[1])); }
  if (/^https?:\/\//i.test(t)) { mintsSheet(); later(() => { const f = $('#mu'); if (f) f.value = t; }); return; }
  toast('Didn’t recognise that code.', 'warn');
}

/* ================= background checks ================= */
let bg = [];
function schedule() {
  bg.forEach(clearInterval); bg = [];
  if (st.checkSent) bg.push(setInterval(() => { if (!document.hidden) C.settleAll({ invoices: false, sent: true }).then(render); }, 45000));
  if (st.checkAll) bg.push(setInterval(() => { if (!document.hidden) C.settleAll({ invoices: true, sent: false, all: true }).then(render); }, 60000));
  if (st.fiat) bg.push(setInterval(() => { if (!document.hidden) C.loadPrice().then((ch) => ch && render()); }, 30000));
  bg.push(setInterval(render, 60000));
  bg.push(setInterval(() => { if (!document.hidden) C.returnDue(cameBack); }, 30000));
  bg.push(setInterval(autoSpread, 90000));
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && st.fiat && C.priceAge() > 15000) C.loadPrice().then((ch) => ch && render());
});

/* ================= install prompt ================= */
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#instBtn').hidden = false; });
function installHelp() {
  if (installEvt) { installEvt.prompt(); installEvt = null; $('#instBtn').hidden = true; return; }
  sheet('Install', `<p>On iPhone: tap Share, then Add to Home Screen.</p><p>On Android: open the browser menu, then Install app.</p><p class="dim small">The Home Screen app keeps its own storage, separate from Safari. If you’ve been using blindsig in a Safari tab, write down your seed phrase first (Settings → Backup & restore), then restore it in the installed app.</p>`);
}

/* ================= boot ================= */
const NU = nostrUI({ $, $$, sheet, closeSheet, toast, copy, withBusy, kv, toggle, qrSvg, render, niceErr, amountField, readAmt, settingsSheet, isLocked: () => locked });
MENU.splice(1, 0, ...NU.menu);
Object.assign(SECTIONS, NU.sections);
N.on('incoming', (h) => { toast(h.warn ? `A payment of ${fmt(h.amount, h.unit)} doesn’t fully match your request. Check it in your history before claiming.` : `Incoming ecash: ${fmt(h.amount, h.unit)}. Tap it in your history to claim.`, 'warn'); render(); });
N.on('received', (h) => { toast(`Received ${fmt(h.amount, h.unit)}`); FX.success('received'); render(); });
N.on('nwc', () => render());
N.on('nutzap', (h) => { toast(`⚡ ${I18N.t('Nutzap')}: +${fmt(h.amount, h.unit)}${h.memo ? ' · ' + h.memo : ''}`); FX.success('received'); render(); });
$('#recvBtn').onclick = () => receiveSheet();
$('#sendBtn').onclick = () => sendSheet();
$('#scanBtn').onclick = () => (needMint() ? null : startScan(route));
$('#mintChip').onclick = () => mintsSheet();
$('#unitChip').onclick = () => { const m = mintOf(S.active); const u = m?.units || ['sat']; S.unit = u[(u.indexOf(S.unit) + 1) % u.length]; save(); render(); };
$('#setBtn').onclick = () => (S.mnemonic ? settingsSheet() : welcome());
$('#sumBtn').onclick = () => summarySheet();
$('#vaultChip').onclick = () => vaultSheet();
$('#btcPrice').onclick = () => { if (S.price[st.fiatCur]) priceChart(); };
$('#instBtn').onclick = installHelp;
$('#bkHow').onclick = () => backupCreateSheet();
$('#riskMove').onclick = () => spreadSheet();
$('#riskX').onclick = () => { const m = mintOf($('#riskWarn').dataset.u); if (m) { m.riskAck = bal(m.url, 'sat'); save(); } render(); };
$('#bkWarnX').onclick = () => { st.backupNagged = Date.now(); save(); render(); };
$('#lockBtn').onclick = () => L.relock();
// ask for the PIN again after time in the background ("Right away" also hides the app-switcher snapshot)
{
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    const p = pinInfo(); if (!p) return;
    if (document.hidden) { hiddenAt = Date.now(); if (p.after === 0) L.relock(); }
    else if (hiddenAt && Date.now() - hiddenAt >= p.after * 1000) L.relock();
  });
}
$('#scanClose').onclick = stopScan;
$('#motdX').onclick = () => { const m = mintOf(S.active); if (m) { m.motdSeen = m.info.motd; save(); render(); } };
$('#sheet .backdrop').onclick = () => closeSheet();
$('#logTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { logFilter = b.dataset.f; logLimit = 100; render(); } };
$('#moreHist').onclick = () => { logLimit += 100; render(); };
{
  const flip = () => { st.hideAmounts = !st.hideAmounts; save(); shownBal = null; render(); toast(st.hideAmounts ? 'Amounts hidden. Tap the balance to show them.' : 'Amounts shown'); };
  const br = $('.balrow'); br.onclick = flip;
  $('#histToggle').onclick = () => { st.hideHistory = !st.hideHistory; save(); render(); };
  br.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
}
{ let t = null; $('#histQ').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { histQ = e.target.value; logLimit = 100; render(); }, 120); }; }
$('#chkAll').onclick = withBusy($('#chkAll'), async () => { await C.settleAll({ invoices: true, sent: true, all: true }); render(); toast('Checked all pending'); });
$('#hist').onclick = (e) => { const r = e.target.closest('.row'); if (r) { const h = S.history.find((x) => x.id === r.dataset.id); if (h) detail(h); } };
if (!navigator.standalone && !matchMedia('(display-mode: standalone)').matches && /iphone|ipad/i.test(navigator.userAgent)) $('#instBtn').hidden = false;
// iPhone Safari tab (not installed): Safari may clear site data after ~7 days without a visit.
// Remind wallet owners once a week until they install it.
{
  const inTab = FX.isIOS && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
  const tw = $('#tabWarn');
  if (inTab && S.mnemonic && Date.now() - (st.tabWarnDismissed || 0) > 7 * 864e5) tw.hidden = false;
  $('#tabWarnX').onclick = () => { tw.hidden = true; st.tabWarnDismissed = Date.now(); save(); };
  $('#tabHow').onclick = installHelp;
}

I18N.startObserver();
I18N.setLang(st.lang || I18N.detect()).then(render);
render();

/* only one tab may run the wallet at a time (two tabs could reuse the same secrets) */
const tabId = Math.random().toString(36).slice(2);
const chan = 'BroadcastChannel' in window ? new BroadcastChannel('blindsig') : null;
let blocked = false;
function blockTab() {
  if (blocked) return;
  blocked = true;
  N.stopAll(); C.unwatchAll(); bg.forEach(clearInterval); bg = [];
  $('#tabLock').hidden = false;
}
if (chan) {
  chan.onmessage = (e) => {
    const d = e.data || {};
    if (d.from === tabId) return;
    if (d.type === 'hello' && !blocked) chan.postMessage({ type: 'running', from: tabId });
    else if (d.type === 'running' || d.type === 'takeover') blockTab();
  };
  chan.postMessage({ type: 'hello', from: tabId });
}
$('#tlUse').onclick = () => { chan?.postMessage({ type: 'takeover', from: tabId }); location.reload(); };
setTimeout(() => {
  if (blocked) return;
  schedule();
  if (!S.mnemonic) { if (pendingToken) giftWelcome(); else welcome(0); }
  else if (!S.mints.length) mintsSheet(true);
  else if (S.afterImport) { delete S.afterImport; save(); restoreRun(S.mints.map((m) => m.url), undefined, true); C.watchSent(sentClaimed); }
  else {
    if (st.checkStartup) C.settleAll({ invoices: true, sent: st.checkSent }).then(render);
    C.returnDue(cameBack);
    S.mints.forEach((m) => { if (!m.updated || Date.now() - m.updated > 6 * 3600e3) C.refreshMint(m.url).then(render).catch(() => {}); });
    C.watchSent(sentClaimed);
  }
  C.loadPrice().then(render);
  if (S.mnemonic) N.startAll();
  // ecash moved in for us (the decoy's starting sats): claim it quietly
  for (const h of S.history.filter((x) => x.auto && x.kind === 'ecash-in' && x.status === 'pending' && x.token)) C.receiveEcash(C.parseToken(h.token)).then(render).catch(() => {});
}, chan ? 350 : 0);
document.addEventListener('visibilitychange', () => { if (!blocked && !document.hidden && S.mints.length) { if (st.checkStartup) C.settleAll({ invoices: true, sent: st.checkSent }).then(render); C.returnDue(cameBack); } });

const incoming = (location.hash.match(/token=([^&]+)/) || [])[1] || new URLSearchParams(location.search).get('token');
if (incoming && S.mnemonic) { history.replaceState(null, '', location.pathname); setTimeout(() => route(decodeURIComponent(incoming)), 500); }
else if (incoming) { history.replaceState(null, '', location.pathname); pendingToken = decodeURIComponent(incoming); }
// a token link opened while the app is already open (same page, only the #token part changes)
addEventListener('hashchange', () => {
  const t = (location.hash.match(/token=([^&]+)/) || [])[1];
  if (!t || !S.mnemonic) return;
  history.replaceState(null, '', location.pathname); route(decodeURIComponent(t));
});
// home-screen shortcuts (long-press the app icon on Android): Receive, Send, Scan
const action = new URLSearchParams(location.search).get('action');
if (action && S.mnemonic) {
  history.replaceState(null, '', location.pathname);
  setTimeout(() => { if (needMint()) return; if (action === 'receive') receiveSheet(); else if (action === 'send') sendSheet(); else if (action === 'scan') startScan(route); }, 500);
}

