// PIN lock: the full-screen PIN pad shown at startup (before the wallet is decrypted) and
// after the app has been in the background. Also the reusable pad for setting a PIN.
import { checkPin, unlock, pinInfo, wipeStore, KEY, esc, decoyOn, flushSave } from './store.js';
import * as I18N from './i18n.js';
import * as FX from './fx.js';
import { bioOn, bioUnlock, bioLabel } from './bio.js';

const t = (s) => I18N.t(s);
const LOCK_KEY = KEY + '.lock'; // { fails, until } — wrong-PIN counter, kept outside the encrypted state

function meta() { try { return JSON.parse(localStorage.getItem(LOCK_KEY)) || { fails: 0, until: 0 }; } catch { return { fails: 0, until: 0 }; } }
function setMeta(m) { try { localStorage.setItem(LOCK_KEY, JSON.stringify(m)); } catch {} }
// 5 tries free, then a wait that doubles each time: 30 s, 1 min, 2 min … up to 1 hour
function failed() {
  const m = meta(); m.fails = (m.fails || 0) + 1;
  if (m.fails >= 5) m.until = Date.now() + Math.min(3600e3, 30e3 * 2 ** (m.fails - 5));
  setMeta(m); return m;
}
const resetFails = () => setMeta({ fails: 0, until: 0 });

const dots = (n, len) => Array.from({ length: len }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

// A PIN pad inside `root`. onPin(pin) resolves to true (accepted), or a message to show and retry.
export function pinPad(root, { len = 6, title, sub = '', onPin, extra = '', lenSwitch = false }) {
  let pin = '', busy = false;
  if (root._key) document.removeEventListener('keydown', root._key);
  root.innerHTML = `<div class="pinpad">
    <h2 id="plT" class="pt" tabindex="-1">${esc(title)}</h2>
    <p class="ps" id="plS">${esc(sub)}</p>
    <div class="pdots" id="plD" aria-hidden="true">${dots(0, len)}</div>
    <p class="pm" id="plM" role="status" aria-live="polite"></p>
    <div class="kp pkp">${KEYS.map((k) => (k ? `<button type="button" data-k="${k}" aria-label="${k === '⌫' ? 'Delete' : k}">${k}</button>` : '<span></span>')).join('')}</div>
    ${lenSwitch ? `<button type="button" class="lnk" id="plLen">${len === 6 ? 'Use a 4-digit PIN' : 'Use a 6-digit PIN'}</button>` : ''}
    ${extra}</div>`;
  const D = root.querySelector('#plD'), M = root.querySelector('#plM');
  const draw = () => { D.innerHTML = dots(pin.length, len); };
  const msg = (s, bad) => { M.textContent = s ? t(s) : ''; M.classList.toggle('bad', !!bad); };
  const wait = () => {
    const m = meta(), left = Math.ceil((m.until - Date.now()) / 1000);
    if (left <= 0) return false;
    msg(left >= 60 ? `Too many tries. Wait ${Math.ceil(left / 60)} min.` : `Too many tries. Wait ${left} s.`, true);
    clearTimeout(root._w); root._w = setTimeout(() => { if (!wait()) msg(''); }, 1000);
    return true;
  };
  async function submit() {
    busy = true; msg('Checking…');
    let r;
    try { r = await onPin(pin); } catch { r = 'Something went wrong. Try again.'; }
    busy = false;
    if (r === true) return;
    pin = ''; draw();
    FX.fail(D);
    msg(typeof r === 'string' ? r : '', true);
    wait();
  }
  root.querySelector('.pkp').onclick = (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (!k || busy) return;
    if (k !== '⌫' && wait()) return FX.fail(D);
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (pin.length < len) pin += k;
    draw();
    if (M.classList.contains('bad') && pin.length) msg('');
    if (pin.length === len) submit();
  };
  // a hardware keyboard works too
  root._key = (e) => {
    if (!root.isConnected) return document.removeEventListener('keydown', root._key);
    if (busy) return;
    const k = /^[0-9]$/.test(e.key) ? e.key : e.key === 'Backspace' ? '⌫' : '';
    if (k) { e.preventDefault(); root.querySelector(`.pkp [data-k="${k}"]`)?.click(); }
  };
  document.addEventListener('keydown', root._key);
  const sw = root.querySelector('#plLen');
  if (sw) sw.onclick = () => pinPad(root, { len: len === 6 ? 4 : 6, title, sub, onPin, extra, lenSwitch });
  wait();
  return { setMsg: msg, get len() { return len; } };
}

let overlay = null;
// opts: { title, sub, cancel } — cancel: a Cancel button instead of "Forgot PIN?" (for confirming a send)
function show(onDone, opts = {}) {
  const info = pinInfo() || { len: 6 };
  overlay = document.getElementById('pinLock') || document.createElement('div');
  overlay.id = 'pinLock'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'plT');
  overlay.hidden = false;
  document.body.appendChild(overlay);
  const app = document.querySelector('.app'), sh = document.getElementById('sheet');
  if (!overlay._prev) overlay._prev = [app?.inert, sh?.inert];
  if (app) app.inert = true;
  if (sh) sh.inert = true;
  const box = document.createElement('div'); box.className = 'plbox';
  overlay.innerHTML = '<div class="brand"><b>$</b> blindsig<span class="cur">_</span></div>';
  overlay.appendChild(box);
  const forgot = (bioOn() ? `<button type="button" class="btn wide pbio" id="plB">${bioLabel() === 'Face ID or Touch ID' ? 'Use Face ID or Touch ID' : 'Use fingerprint or face unlock'}</button>` : '')
    + (opts.cancel ? '<button type="button" class="lnk pforgot" id="plX">Cancel</button>' : '<button type="button" class="lnk pforgot" id="plF">Forgot PIN?</button>');
  const pad = pinPad(box, {
    len: info.len, title: opts.title || 'Enter your PIN', sub: opts.sub || '', extra: forgot,
    onPin: async (pin) => {
      const ok = await onDone(pin);
      if (!ok) { const m = failed(); return m.fails < 5 ? (m.fails === 4 ? 'Wrong PIN. 1 try left before a wait.' : 'Wrong PIN.') : 'Wrong PIN.'; }
      resetFails(); hide(); return true;
    },
  });
  const fp = box.querySelector('#plF'); if (fp) fp.onclick = () => forgotPin(box, () => show(onDone, opts));
  const cx = box.querySelector('#plX'); if (cx) cx.onclick = () => { hide(); opts.cancel(); };
  const bb = box.querySelector('#plB');
  if (bb) bb.onclick = async () => {
    bb.disabled = true; pad.setMsg('');
    try {
      const pin = await bioUnlock();
      pad.setMsg('Checking…');
      if (await onDone(pin)) { resetFails(); hide(); return; }
      pad.setMsg('Face ID didn’t work this time. Use your PIN.', true);
    } catch (e) {
      // cancelled: say nothing; anything else: fall back to the PIN
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') pad.setMsg('Face ID didn’t work this time. Use your PIN.', true);
    } finally { if (bb.isConnected) bb.disabled = false; }
  };
  I18N.translateTree(overlay);
  if (!overlay._focus) overlay._focus = document.activeElement;
  box.querySelector('#plT').focus({ preventScroll: true });
}
function hide() {
  if (!overlay) return;
  document.removeEventListener('keydown', overlay.querySelector('.plbox')?._key);
  overlay.hidden = true; overlay.innerHTML = '';
  const [a, b] = overlay._prev || [false, false]; overlay._prev = null;
  const back = overlay._focus; overlay._focus = null;
  const app = document.querySelector('.app'), sh = document.getElementById('sheet');
  if (app) app.inert = !!a;
  if (sh) sh.inert = !!b;
  try { back?.focus?.({ preventScroll: true }); } catch {}
}
export const isShowing = () => !!overlay && !overlay.hidden;

function forgotPin(box, backTo) {
  document.removeEventListener('keydown', box._key);
  box.innerHTML = `<div class="pinpad pforget"><h2 id="plT" class="pt" tabindex="-1">Forgot your PIN?</h2>
    <p>Your PIN can’t be recovered. It encrypts the wallet on this device, and nobody else has it.</p>
    <p>To get back in, reset blindsig on this device, then restore it with your seed phrase. Your ecash comes back from your mints.</p>
    <p class="warn">Without your seed phrase, resetting loses the ecash on this device for good. P2PK keys you imported and your history are not part of the seed.</p>
    <label class="lbl" for="plC">Type “reset” to confirm.</label><input id="plC" class="field" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="btn wide danger" id="plGo" disabled>Reset this wallet</button>
    <button class="btn wide" id="plBack">Try my PIN again</button></div>`;
  I18N.translateTree(box);
  const c = box.querySelector('#plC'), go = box.querySelector('#plGo');
  c.oninput = () => (go.disabled = c.value.trim().toLowerCase() !== 'reset');
  go.onclick = async () => { await wipeStore(); location.replace(location.pathname); };
  box.querySelector('#plBack').onclick = backTo;
  box.querySelector('#plT').focus({ preventScroll: true });
}

// cold start: theme + language from the unencrypted header, then wait for the right PIN
export async function coldUnlock(pub) {
  document.documentElement.dataset.accent = pub.theme || 'green';
  await I18N.setLang(pub.lang || I18N.detect());
  I18N.startObserver();
  await new Promise((done) => show(async (pin) => { const ok = await unlock(pin); if (ok) setTimeout(done, 0); return ok; }));
}
// lock again while the app is running (the wallet stays loaded in memory underneath)
export function relock() {
  if (isShowing() || !pinInfo()) return;
  // with a decoy PIN, locking starts over from a cold start, so either PIN can open its own wallet
  if (decoyOn()) { flushSave().then(() => location.reload()); return; }
  show(async (pin) => !!(await checkPin(pin)));
}
// confirm a big send: PIN pad (or Face ID) over the current screen, which stays as it was underneath.
// Resolves true when confirmed (or when no PIN is set), false when cancelled.
export function authorize(sub) {
  return new Promise((done) => {
    if (!pinInfo() || isShowing()) return done(!isShowing());
    show(async (pin) => { const ok = !!(await checkPin(pin)); if (ok) setTimeout(() => done(true), 0); return ok; }, { title: 'Confirm with your PIN', sub, cancel: () => done(false) });
  });
}
// ask for the PIN before a sensitive step (showing the seed phrase); resolves to the PIN (or true
// when no PIN is set); stays pending if the person goes back
export function confirmPin(sheetFn, title, back) {
  return new Promise((done) => {
    const info = pinInfo(); if (!info) return done(true);
    sheetFn(title, '<div id="pcBox"></div>', (b) => {
      pinPad(b.querySelector('#pcBox'), {
        len: info.len, title: 'Enter your PIN',
        onPin: async (pin) => {
          if (await checkPin(pin)) { resetFails(); done(pin); return true; }
          failed(); return 'Wrong PIN.';
        },
      });
    }, { back });
  });
}
