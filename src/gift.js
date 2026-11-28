// Ecash gift cards: a picture with the amount, a message and a QR code that opens blindsig and
// claims the ecash. Drawn on a canvas so it can be shared, saved or printed as an image.
import QRCode from 'qrcode';

export const DESIGNS = [
  ['winter', 'Winter'],
  ['gold', 'Gold'],
  ['party', 'Party'],
  ['classic', 'Classic'],
];
const LOOK = {
  winter: { bg: ['#123526', '#071510'], ink: '#f4efe6', dim: 'rgba(244,239,230,.62)', ac: '#e9c46a' },
  gold: { bg: ['#1d1812', '#0b0a08'], ink: '#f6eedf', dim: 'rgba(246,238,223,.6)', ac: '#f2b763' },
  party: { bg: ['#2c1340', '#110818'], ink: '#fbf1f6', dim: 'rgba(251,241,246,.62)', ac: '#ff8fb1' },
  classic: { bg: ['#171a15', '#0c0e0b'], ink: '#ece6da', dim: 'rgba(236,230,218,.6)', ac: '#74d99a' },
};
export const W = 1080, H = 1800;
const SANS = '"Inter", system-ui, sans-serif', MONO = '"JetBrains Mono", ui-monospace, monospace';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function round(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function wrap(g, text, max, lines) {
  const out = []; let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const t = cur ? cur + ' ' + w : w;
    if (g.measureText(t).width <= max || !cur) cur = t; else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; let l = out[lines - 1]; while (l && g.measureText(l + '…').width > max) l = l.slice(0, -1); out[lines - 1] = l.trimEnd() + '…'; }
  // a single word longer than the line: cut it
  return out.map((l) => { if (g.measureText(l).width <= max) return l; while (l && g.measureText(l + '…').width > max) l = l.slice(0, -1); return l + '…'; });
}
function snowflake(g, x, y, r) {
  g.save(); g.translate(x, y);
  for (let i = 0; i < 6; i++) {
    g.rotate(Math.PI / 3);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -r);
    g.moveTo(0, -r * 0.55); g.lineTo(-r * 0.22, -r * 0.75); g.moveTo(0, -r * 0.55); g.lineTo(r * 0.22, -r * 0.75);
    g.stroke();
  }
  g.restore();
}
function decor(g, d, L) {
  const r = rng(d.length * 977 + 5);
  if (d === 'winter') {
    g.fillStyle = 'rgba(255,255,255,.5)';
    for (let i = 0; i < 70; i++) { const x = r() * W, y = r() * H * 0.5, s = 1.5 + r() * 3.5; g.globalAlpha = 0.15 + r() * 0.45; g.beginPath(); g.arc(x, y, s, 0, 7); g.fill(); }
    g.globalAlpha = 1; g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 3; g.lineCap = 'round';
    for (const [x, y, s] of [[110, 120, 46], [965, 200, 60], [1000, 600, 30], [70, 520, 34], [50, 1180, 34], [1030, 1420, 36]]) snowflake(g, x, y, s);
  } else if (d === 'gold') {
    const gr = g.createRadialGradient(W / 2, 260, 20, W / 2, 260, 700);
    gr.addColorStop(0, 'rgba(242,183,99,.26)'); gr.addColorStop(1, 'rgba(242,183,99,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(242,183,99,.16)'; g.lineWidth = 2;
    for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(W + 40, -40, 220 + i * 70, 0, 7); g.stroke(); }
    g.fillStyle = 'rgba(242,183,99,.06)'; g.font = `700 760px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('₿', W * 0.18, H * 0.78);
  } else if (d === 'party') {
    const cols = ['#ff8fb1', '#ffd166', '#74d99a', '#7cc6ff', '#c792ff'];
    for (let i = 0; i < 160; i++) {
      const x = r() * W, y = r() < 0.7 ? r() * 520 : 520 + r() * (H - 520), w = 10 + r() * 16, h = 5 + r() * 8;
      if ((x > 80 && x < W - 80 && y > 740 && y < 1680) || (x > 150 && x < W - 150 && y > 110 && y < 730) || (x > 120 && x < W - 120 && y > 1670)) continue; // keep the words and the code clear
      g.save(); g.translate(x, y); g.rotate(r() * Math.PI); g.globalAlpha = 0.35 + r() * 0.5; g.fillStyle = cols[i % cols.length]; g.fillRect(-w / 2, -h / 2, w, h); g.restore();
    }
    g.globalAlpha = 1;
  } else {
    g.strokeStyle = 'rgba(116,217,154,.06)'; g.lineWidth = 1;
    for (let x = 0; x <= W; x += 54) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
    for (let y = 0; y <= H; y += 54) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
    g.fillStyle = L.ac; g.font = `600 34px ${MONO}`; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText('$ gift_', 70, 110);
  }
}

// opts: { design, amount (already formatted, e.g. "21,000"), unit ("sats"), fiat, msg, link, words: { title, scan, from ("from Sam"), tooBig, link } }
export async function draw(canvas, o) {
  canvas.width = W; canvas.height = H;
  try { await Promise.all([document.fonts.load(`600 60px "Inter"`), document.fonts.load(`600 60px "JetBrains Mono"`)]); } catch {}
  const g = canvas.getContext('2d'), L = LOOK[o.design] || LOOK.winter;
  const bg = g.createLinearGradient(0, 0, W * 0.3, H); bg.addColorStop(0, L.bg[0]); bg.addColorStop(1, L.bg[1]);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  decor(g, o.design, L);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  // title
  g.fillStyle = L.ac; g.font = `600 36px ${MONO}`;
  const title = o.words.title.toUpperCase();
  if ('letterSpacing' in g) g.letterSpacing = '6px';
  g.fillText(title, W / 2, 176);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  // amount: number big, unit beside it
  g.font = `600 150px ${MONO}`; const nw = g.measureText(o.amount).width;
  g.font = `500 58px ${MONO}`; const uw = o.unit ? g.measureText(o.unit).width + 24 : 0;
  let size = 150; if (nw + uw > W - 140) size = Math.floor(150 * (W - 140 - uw) / nw);
  g.font = `600 ${size}px ${MONO}`; const nw2 = g.measureText(o.amount).width, x0 = W / 2 - (nw2 + uw) / 2;
  g.textAlign = 'left'; g.fillStyle = L.ink; g.fillText(o.amount, x0, 345);
  if (o.unit) { g.font = `500 58px ${MONO}`; g.fillStyle = L.dim; g.fillText(o.unit, x0 + nw2 + 24, 345); }
  g.textAlign = 'center';
  if (o.fiat) { g.font = `400 40px ${SANS}`; g.fillStyle = L.dim; g.fillText(o.fiat, W / 2, 412); }
  // message and sender
  let y = 510;
  if (o.msg) {
    g.font = `500 54px ${SANS}`; g.fillStyle = L.ink;
    const lines = wrap(g, '“' + o.msg + '”', W - 180, 3);
    lines.forEach((l, i) => g.fillText(l, W / 2, y + i * 70)); y += lines.length * 70;
  }
  if (o.words.from) { g.font = `400 40px ${SANS}`; g.fillStyle = L.ac; g.fillText(o.words.from, W / 2, y + (o.msg ? 6 : 0)); }
  // the code: as big as the card allows, since a token link is long and a print has to scan
  const box = 880, bx = (W - box) / 2, by = 770;
  g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 40; g.shadowOffsetY = 12; g.fillStyle = '#f7f3ea'; round(g, bx, by, box, box, 40); g.fill(); g.restore();
  let qr = null; try { qr = QRCode.create(o.link, { errorCorrectionLevel: 'L' }); } catch {}
  if (qr) {
    const n = qr.modules.size, m = Math.floor((box - 72) / n), q = m * n, qx = Math.round(bx + (box - q) / 2), qy = Math.round(by + (box - q) / 2);
    g.fillStyle = '#121212';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) g.fillRect(qx + c * m, qy + r * m, m, m);
  } else {
    // too much ecash for one code (many small parts): the link still works
    g.fillStyle = '#121212'; g.font = `500 44px ${SANS}`;
    wrap(g, o.words.tooBig, box - 120, 4).forEach((l, i) => g.fillText(l, W / 2, by + box / 2 - 60 + i * 60));
  }
  // footer
  g.font = `500 40px ${SANS}`; g.fillStyle = L.ink; g.fillText(qr ? o.words.scan : o.words.link, W / 2, 1720);
  g.font = `400 28px ${MONO}`; g.fillStyle = L.dim; g.fillText('bitcoin ecash · blindsig', W / 2, 1768);
  return !!qr;
}
