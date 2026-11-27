// Load saved state from IndexedDB before any module reads it, then start the app.
import { initStore } from './store.js';
await initStore();
await import('./app.js');
