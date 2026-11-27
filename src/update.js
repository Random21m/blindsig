// App updates: the service worker fetches a new version in the background, then a bar offers a
// one-tap reload. This starts before the PIN screen, so an update found while the app is still
// locked isn't missed.
import { flushSave, VERSION } from './store.js';

const ok = 'serviceWorker' in navigator && location.protocol !== 'file:';
const hadController = ok && !!navigator.serviceWorker.controller;
let reg = null;

function showBar(hard) {
  if (document.getElementById('updBar')) return;
  const bar = document.createElement('button');
  bar.id = 'updBar'; bar.className = 'updbar'; bar.textContent = 'New version ready. Tap to update.';
  bar.onclick = async () => { await flushSave(); if (hard) await clearShell(); location.reload(); };
  document.body.appendChild(bar);
}
// last resort when the service worker is stuck on an old copy: drop the cached app files (never the
// wallet, which lives in IndexedDB) and the worker, then reload from the site
async function clearShell() {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { await Promise.all(['./', './index.html', './app.js'].map((u) => fetch(u, { cache: 'reload' }))); } catch {} // refresh the browser's own copy too
  try { await reg?.unregister(); } catch {}
}
// is the live site on a newer version than the one running here?
async function behind() {
  try { const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return false; return (await r.json()).version !== VERSION; } catch { return false; }
}
// a normal update shows the bar through controllerchange; if the site is newer but nothing is
// installing after a while, the copy here is stuck, so offer the hard reload instead
async function stuckCheck() {
  if (!(await behind())) return;
  setTimeout(async () => { if (!reg?.installing && !reg?.waiting && (await behind())) showBar(true); }, 12000);
}
const check = () => reg?.update().catch(() => {});

export function initUpdates() {
  if (!ok) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showBar(); });
  navigator.serviceWorker.register('./sw.js').then((r) => {
    reg = r;
    check();
    setTimeout(stuckCheck, 4000);
    setInterval(() => { if (!document.hidden) check(); }, 30 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); setTimeout(stuckCheck, 4000); } });
  }).catch(() => {});
}
// Settings → About: look for a new version now. Resolves 'found', 'latest' or 'offline'.
export async function checkNow() {
  const newer = await behind();
  if (reg) { try { await reg.update(); } catch {} }
  const w = reg && (reg.installing || reg.waiting);
  if (w) { if (w.state === 'activated') showBar(); return 'found'; }
  if (newer) { showBar(true); return 'found'; }
  return navigator.onLine === false ? 'offline' : 'latest';
}
