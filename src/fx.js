// Sound, motion and haptic feedback: success checkmark + confetti, coin sounds, shake on errors.
// Sounds are synthesized with Web Audio (no audio files, nothing fetched), so they stay tiny
// and work offline. Everything respects the Sounds / Animations settings and reduced motion.
import { S } from './store.js';

const st = () => S.settings;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const motionOn = () => st().motion !== false && !reduced();

/* ---------------- sound ---------------- */
let ctx = null, out = null, born = 0;
// iPhone: "ambient" mixes with music but stays quiet while the ring switch is on silent;
// "playback" (the Play on silent setting) is heard even on silent, like a video would be.
const sessionType = () => (st().soundsOnSilent ? 'playback' : 'ambient');
export function setSession() { try { if (navigator.audioSession) navigator.audioSession.type = sessionType(); } catch {} }
function fresh() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { ctx?.close(); } catch {}
  setSession();
  ctx = new AC(); born = Date.now();
  // everything goes through one master volume and a limiter, so phone speakers get a full,
  // clear sound without clipping when notes overlap
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.002; lim.release.value = 0.12;
  out = ctx.createGain(); out.gain.value = 2.6;
  out.connect(lim); lim.connect(ctx.destination);
  return ctx;
}
function audio() {
  if (!ctx || ctx.state === 'closed') return fresh();
  if (ctx.state !== 'running') ctx.resume().catch(() => {}); // "suspended", or iPhone's "interrupted"
  return ctx;
}
// Browsers only allow audio after a tap. iPhone only counts touchend/click (not pointerdown) and
// needs a sound actually started inside that tap, so play one silent sample to unlock it.
// After the app was in the background (paying from another app, a call, the lock screen) iPhone
// leaves the context "interrupted" and a plain resume often never comes back, so on the next tap
// a stuck context is replaced with a new one, created inside the tap.
let unlocked = false, everUnlocked = false;
const unlock = (e) => {
  // only real taps count: the haptic trick clicks a hidden switch, and that synthetic click must
  // never replace the audio context (a context made outside a tap stays silent on iPhone)
  if (!e.isTrusted || st().sounds === false) return;
  if (ctx && ctx.state === 'running' && unlocked) return;
  // a context made in this tap or just before is still starting up (iPhone switches it to running
  // a moment later), so wake it rather than replacing it. Only one that stays stuck is replaced.
  const starting = ctx && Date.now() - born < 2000;
  const a = !ctx || ctx.state === 'closed' ? fresh() : ctx.state === 'running' || !everUnlocked || starting ? audio() : fresh();
  if (!a) return;
  try { a.resume().catch(() => {}); const src = a.createBufferSource(); src.buffer = a.createBuffer(1, 1, 22050); src.connect(a.destination); src.start(0); unlocked = everUnlocked = true; } catch {}
};
// the backup elements need their own first start inside a tap
addEventListener('touchend', (e) => { if (e.isTrusted && st().sounds !== false) primeBackup(); }, { capture: true, passive: true });
addEventListener('click', (e) => { if (e.isTrusted && st().sounds !== false) primeBackup(); }, { capture: true, passive: true });
for (const ev of ['touchend', 'click', 'keydown']) addEventListener(ev, unlock, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) unlocked = false; // check again on the first tap after coming back
  else ctx.resume().catch(() => {});
});

// one soft note: frequency glide, quick attack, smooth decay
function note(a, { f, f2 = f, at = 0, dur = 0.16, vol = 0.16, type = 'sine', lp = 0 }) {
  const t = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o;
  if (lp) { const fl = a.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; o.connect(fl); node = fl; }
  node.connect(g); g.connect(out || a.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
// a short breath of filtered noise, for the "whoosh" of sending
function whoosh(a, { at = 0, dur = 0.22, vol = 0.07 } = {}) {
  const t = a.currentTime + at, len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource(), fl = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf; fl.type = 'bandpass'; fl.Q.value = 0.9;
  fl.frequency.setValueAtTime(2600, t); fl.frequency.exponentialRampToValueAtTime(500, t + dur);
  g.gain.setValueAtTime(vol, t);
  src.connect(fl); fl.connect(g); g.connect(out || a.destination);
  src.start(t);
}
const SOUNDS = {
  // two bright coin notes, a fifth apart, with a soft shimmer on top
  received: (a) => { note(a, { f: 987.8, dur: 0.11, vol: 0.13, type: 'triangle' }); note(a, { f: 1318.5, at: 0.085, dur: 0.42, vol: 0.15, type: 'triangle' }); note(a, { f: 2637, at: 0.085, dur: 0.3, vol: 0.025 }); },
  // a quick whoosh with a falling tone: money leaving
  sent: (a) => { whoosh(a); note(a, { f: 880, f2: 523.3, at: 0.04, dur: 0.2, vol: 0.09 }); },
  // gentle confirmation when someone claims a token you sent
  claimed: (a) => { note(a, { f: 1568, dur: 0.24, vol: 0.08 }); note(a, { f: 2093, at: 0.07, dur: 0.3, vol: 0.06 }); },
  // two low, muted notes: not alarming, just "nope"
  error: (a) => { note(a, { f: 196, dur: 0.09, vol: 0.12, type: 'square', lp: 700 }); note(a, { f: 174.6, at: 0.11, dur: 0.14, vol: 0.12, type: 'square', lp: 700 }); },
  // the faintest tick for the keypad
  tap: (a) => note(a, { f: 1900, dur: 0.025, vol: 0.025, type: 'triangle' }),
  // PIN keys: a slightly fuller click, like a phone's passcode screen
  pin: (a) => { note(a, { f: 1500, dur: 0.035, vol: 0.05, type: 'triangle' }); note(a, { f: 3000, dur: 0.02, vol: 0.012 }); },
};
/* backup player: the same sounds pre-rendered to tiny WAV files and played with <audio>.
   iPhone sometimes leaves Web Audio "interrupted" after the app was in the background, and a new
   context can't start until the next tap. <audio> elements that were started once inside a tap
   can play later without one, so they cover that gap. */
const backup = {};
let lastEngine = '';
function wav(buf) {
  const d = buf.getChannelData(0), n = d.length, b = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, buf.sampleRate, true); b.setUint32(28, buf.sampleRate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
async function renderBackup() {
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC || typeof Audio === 'undefined') return;
  for (const kind of ['received', 'sent', 'claimed', 'error', 'pin']) {
    try {
      const oc = new OC(1, Math.round(44100 * 0.7), 44100);
      const lim = oc.createDynamicsCompressor(); lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.002; lim.release.value = 0.12;
      const g = oc.createGain(); g.gain.value = 2.6; g.connect(lim); lim.connect(oc.destination);
      const keep = out; out = g; try { SOUNDS[kind](oc); } finally { out = keep; }
      const el = new Audio(wav(await oc.startRendering())); el.preload = 'auto';
      backup[kind] = el;
    } catch {}
  }
}
renderBackup();
// start each backup element once inside a real tap (muted), so it may play later without one
function primeBackup() {
  for (const el of Object.values(backup)) {
    if (el._ok) continue;
    try { el.muted = true; const pr = el.play(); el._ok = true; (pr?.then ? pr : Promise.resolve()).then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => { el._ok = false; el.muted = false; }); } catch {}
  }
}
function playBackup(kind) {
  const el = backup[kind === 'tap' ? 'pin' : kind];
  if (!el || !el._ok) return false;
  try { el.muted = false; el.currentTime = 0; el.play()?.catch?.(() => {}); lastEngine = 'backup'; return true; } catch { return false; }
}
export function play(kind) {
  if (st().sounds === false) return;
  if (kind === 'tap' && !st().keyClicks) return;
  try {
    const a = audio();
    if (a && a.state === 'running') { SOUNDS[kind]?.(a); lastEngine = 'web audio'; return; }
    if (playBackup(kind)) return;
    if (a && a.state !== 'closed') { SOUNDS[kind]?.(a); lastEngine = 'web audio (waking)'; } // plays as soon as it wakes
  } catch {}
}
// Settings → Appearance → Test sound: what the sound system is doing, for troubleshooting
export function soundStatus() {
  return [ctx ? ctx.state : 'not started', navigator.audioSession ? navigator.audioSession.type : 'no session control', lastEngine || 'nothing played yet', Object.values(backup).filter((e) => e._ok).length ? 'backup ready' : 'backup not ready'].join(' · ');
}

/* ---------------- haptics ---------------- */
const BUZZ = { received: [18, 40, 28], sent: [22], claimed: [12, 30, 12], error: [30, 50, 30], tap: [6], pin: [10], test: [40, 60, 40, 60, 80] };
// iPhone has no vibration API. Safari (iOS 18+) gives a real haptic tick when a switch control is
// toggled, so toggle an invisible one. Several ticks a short moment apart make a pattern.
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const TICKS = { received: 2, sent: 1, claimed: 2, error: 3, tap: 1, pin: 1, test: 4 };
function iosTick() {
  try {
    const l = document.createElement('label'), i = document.createElement('input');
    i.type = 'checkbox'; i.setAttribute('switch', ''); l.setAttribute('aria-hidden', 'true'); l.style.display = 'none';
    l.appendChild(i); document.head.appendChild(l); l.click(); l.remove();
  } catch {}
}
export function buzz(kind) {
  if (st().haptics === false) return;
  if (navigator.vibrate) { try { navigator.vibrate(BUZZ[kind] || [15]); } catch {} return; }
  if (!isIOS) return;
  const n = TICKS[kind] || 1;
  for (let k = 0; k < n; k++) k ? setTimeout(iosTick, k * 110) : iosTick();
}

// a light tick (and the optional click sound) on every button, switch and list row.
// Keypads handle their own feedback, so they're skipped here.
const TAPPABLE = 'button, a.btn, .tg, .radio, .chk, .row, [role=tab]';
addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  const t = e.target;
  if (t.tagName === 'INPUT' && t.closest('label')) return; // the second click a label passes to its switch
  const el = t.closest?.(TAPPABLE);
  if (!el || el.disabled || el.closest('.kp')) return;
  buzz('tap'); play('tap');
}, { capture: true, passive: true });

// iPhone only shows :active (pressed) styles when the page listens for touches, and even then a
// quick tap can miss it, so keypad keys also get a "down" class for the length of the press
addEventListener('touchstart', () => {}, { passive: true });
addEventListener('pointerdown', (e) => {
  const k = e.target.closest?.('.kp button');
  if (!k) return;
  k.classList.add('down');
  const t0 = performance.now();
  const up = () => { setTimeout(() => k.classList.remove('down'), Math.max(0, 110 - (performance.now() - t0))); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); };
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
}, { capture: true, passive: true });

/* ---------------- motion ---------------- */
// shake an element sideways, like a head saying "no"
export function shake(el) {
  if (!el || !motionOn()) return;
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}
// count a number up from zero (the success screen's amount); format returns trusted HTML
export function countUp(el, to, format, ms = 650) {
  if (!el || !motionOn() || !to) { if (el) el.innerHTML = format(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms), e = 1 - (1 - p) ** 3;
    el.innerHTML = format(Math.round(to * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// confetti in the theme's colours: pixels, dashes and the odd ₿, bursting from a point
// big: a full-screen spray from both bottom corners and the middle (used to show the setting works)
export function confetti(from, big = false) {
  if (!motionOn()) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti'; cv.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  document.body.appendChild(cv);
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const cols = [css.getPropertyValue('--ac').trim(), css.getPropertyValue('--ink').trim(), css.getPropertyValue('--warn').trim(), css.getPropertyValue('--ac').trim()];
  const r = from?.getBoundingClientRect?.();
  const ox = r ? r.left + r.width / 2 : W / 2, oy = r ? r.top + r.height / 2 : H / 3;
  const N = big ? Math.min(260, Math.round(W / 1.6)) : Math.min(110, Math.round(W / 4));
  // big: three fountains (bottom left, bottom right, middle), aimed to cover the whole screen
  const src = (i) => (!big ? [ox, oy, -Math.PI / 2, Math.PI * 1.25, 5, 8] : i % 3 === 0 ? [0, H, -Math.PI / 3, 0.7, 14, 12] : i % 3 === 1 ? [W, H, -Math.PI * 2 / 3, 0.7, 14, 12] : [W / 2, H / 2, -Math.PI / 2, Math.PI * 2, 4, 10]);
  const ps = Array.from({ length: N }, (_, i) => {
    const [x0, y0, dir, spread, v0, vr] = src(i);
    const a = dir + (Math.random() - 0.5) * spread, v = v0 + Math.random() * vr * (big ? Math.sqrt(H / 800) : 1);
    return { x: x0, y: y0, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, s: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35,
      c: cols[i % cols.length], k: i % 17 === 0 ? 'b' : i % 3 === 0 ? 'dash' : 'px', life: 0 };
  });
  const t0 = performance.now(), DUR = big ? 2800 : 1900;
  const frame = (t) => {
    const el = t - t0; g.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      g.globalAlpha = Math.max(0, 1 - el / DUR);
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c;
      if (p.k === 'b') { g.font = `600 ${p.s * 3.2}px "JetBrains Mono", monospace`; g.fillText('₿', -p.s, p.s); }
      else if (p.k === 'dash') g.fillRect(-p.s, -p.s / 4, p.s * 2.2, p.s / 2);
      else g.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
      g.restore();
    }
    if (el < DUR) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}

/* ---------------- moments ---------------- */
export function success(kind, anchor) {
  buzz(kind);
  // in the background, sound and confetti would only fire late when you come back: skip them
  if (document.hidden) return;
  play(kind);
  // no confetti over the PIN screen: it would draw over the lock and hint at what happened
  if ((kind === 'received' || kind === 'sent') && !document.querySelector('#pinLock:not([hidden])')) confetti(anchor);
}
export function fail(el) { play('error'); buzz('error'); shake(el); }
