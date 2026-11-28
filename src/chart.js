import { dateLocale } from './i18n.js';
// Live bitcoin price chart: Coinbase's public price history, drawn as a small SVG line.
// No keys, no account; the same host the price chip already uses.
export const RANGES = [
  // [tab, Coinbase period, label, how long a fetched series stays fresh]
  ['1H', 'hour', 'Past hour', 30e3],
  ['1D', 'day', 'Past day', 60e3],
  ['1W', 'week', 'Past week', 5 * 60e3],
  ['1M', 'month', 'Past month', 15 * 60e3],
  ['1Y', 'year', 'Past year', 60 * 60e3],
  ['All', 'all', 'All time', 60 * 60e3],
];
const cache = new Map();

export function fresh(cur, period) {
  const c = cache.get(cur + period), r = RANGES.find((x) => x[1] === period);
  return c && Date.now() - c.at < r[3] ? c.pts : null;
}
// oldest first: [[unix ms, price], ...]
export async function series(cur, period, signal) {
  const hit = fresh(cur, period);
  if (hit) return hit;
  const r = await fetch(`https://api.coinbase.com/v2/prices/BTC-${encodeURIComponent(cur)}/historic?period=${period}`, { signal });
  if (!r.ok) throw new Error('price history ' + r.status);
  const j = await r.json();
  const pts = (j?.data?.prices || [])
    .map((p) => [Number(p.time) * 1000, parseFloat(p.price)])
    .filter(([t, p]) => t > 0 && p > 0)
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) throw new Error('price history empty');
  cache.set(cur + period, { at: Date.now(), pts });
  return pts;
}
// the latest spot price goes on the end so the line finishes where the chip says it is
export function withSpot(pts, spot, now = Date.now()) {
  if (!(spot > 0) || !pts.length || now <= pts[pts.length - 1][0]) return pts;
  return [...pts, [now, spot]];
}
export function stats(pts) {
  let lo = Infinity, hi = -Infinity, loI = 0, hiI = 0;
  pts.forEach(([, p], i) => { if (p < lo) { lo = p; loI = i; } if (p > hi) { hi = p; hiI = i; } });
  const first = pts[0][1], last = pts[pts.length - 1][1];
  return { lo, hi, loI, hiI, first, last, change: last - first, pct: first ? ((last - first) / first) * 100 : 0 };
}
// pixel geometry for a w×h box with a little room above and below the line
export function geometry(pts, w, h, pad = 10) {
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], { lo, hi } = stats(pts);
  const span = hi - lo || hi * 0.001 || 1;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * w;
  const y = (p) => pad + (1 - (p - lo) / span) * (h - pad * 2);
  const xy = pts.map(([t, p]) => [x(t), y(p)]);
  const line = xy.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)} ${b.toFixed(1)}`).join('');
  const area = `${line}L${w} ${h}L0 ${h}Z`;
  return { xy, line, area };
}
// index of the point closest to a horizontal position
export function nearest(xy, px) {
  let lo = 0, hi = xy.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xy[m][0] < px) lo = m; else hi = m; }
  return Math.abs(xy[lo][0] - px) <= Math.abs(xy[hi][0] - px) ? lo : hi;
}
export function when(ms, period) {
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  if (period === 'hour' || (period === 'day' && today)) return d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  if (period === 'day') return d.toLocaleDateString(dateLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (period === 'week') return d.toLocaleDateString(dateLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (period === 'month') return d.toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (period === 'year') return d.toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
  return d.toLocaleDateString(dateLocale(), { month: 'short', year: 'numeric' });
}
