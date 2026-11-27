// Load saved state from IndexedDB before any module reads it, then start the app.
// With a PIN set, the saved state is encrypted: show the PIN pad and decrypt first.
import { initStore } from './store.js';
import { initUpdates } from './update.js';
initUpdates();
const r = await initStore();
if (r.locked) await (await import('./lock.js')).coldUnlock(r.pub);
await import('./app.js');
