// App updates: the service worker fetches a new version in the background, then a bar offers a
// one-tap reload. This starts before the PIN screen, so an update found while the app is still
// locked isn't missed.
import { flushSave } from './store.js';

const ok = 'serviceWorker' in navigator && location.protocol !== 'file:';
const hadController = ok && !!navigator.serviceWorker.controller;
let reg = null;

function showBar() {
  if (document.getElementById('updBar')) return;
  const bar = document.createElement('button');
  bar.id = 'updBar'; bar.className = 'updbar'; bar.textContent = 'New version ready. Tap to update.';
  bar.onclick = async () => { await flushSave(); location.reload(); };
  document.body.appendChild(bar);
}
const check = () => reg?.update().catch(() => {});

export function initUpdates() {
  if (!ok) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showBar(); });
  navigator.serviceWorker.register('./sw.js').then((r) => {
    reg = r;
    check();
    setInterval(() => { if (!document.hidden) check(); }, 30 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => {});
}
// Settings → About: look for a new version now. Resolves 'found', 'latest' or 'offline'.
export async function checkNow() {
  if (!reg) return 'offline';
  try { await reg.update(); } catch { return 'offline'; }
  const w = reg.installing || reg.waiting;
  if (!w) return 'latest';
  if (w.state === 'activated') showBar();
  return 'found';
}
