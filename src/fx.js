// Sound, motion and haptic feedback: success checkmark + confetti, coin sounds, shake on errors.
// Sounds are synthesized with Web Audio (no audio files, nothing fetched), so they stay tiny
// and work offline. Everything respects the Sounds / Animations settings and reduced motion.
import { S } from './store.js';

const st = () => S.settings;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const motionOn = () => st().motion !== false && !reduced();

/* ---------------- sound ---------------- */
let ctx = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // on iPhone, "ambient" respects the silent switch and mixes with music instead of stopping it
    try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch {}
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// browsers only allow audio after the first tap: unlock it then, silently
const unlock = () => { if (st().sounds !== false) audio(); };
addEventListener('pointerdown', unlock, { passive: true });
addEventListener('keydown', unlock);
document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx) ctx.resume().catch(() => {}); });

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
  node.connect(g); g.connect(a.destination);
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
  src.connect(fl); fl.connect(g); g.connect(a.destination);
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
};
export function play(kind) {
  if (st().sounds === false) return;
  if (kind === 'tap' && !st().keyClicks) return;
  try { const a = audio(); if (a && a.state !== 'closed') SOUNDS[kind]?.(a); } catch {}
}

/* ---------------- haptics ---------------- */
const BUZZ = { received: [18, 40, 28], sent: [22], claimed: [12, 30, 12], error: [30, 50, 30], tap: [6] };
export function buzz(kind) { try { navigator.vibrate?.(BUZZ[kind] || [15]); } catch {} }

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
export function confetti(from) {
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
  const N = Math.min(110, Math.round(W / 4));
  const ps = Array.from({ length: N }, (_, i) => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.25, v = 5 + Math.random() * 8;
    return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, s: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35,
      c: cols[i % cols.length], k: i % 17 === 0 ? 'b' : i % 3 === 0 ? 'dash' : 'px', life: 0 };
  });
  const t0 = performance.now(), DUR = 1900;
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
  play(kind); buzz(kind);
  if (kind === 'received' || kind === 'sent') confetti(anchor);
}
export function fail(el) { play('error'); buzz('error'); shake(el); }
