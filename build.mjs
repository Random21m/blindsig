import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

rmSync('docs', { recursive: true, force: true });
mkdirSync('docs/icons', { recursive: true });
cpSync('public', 'docs', { recursive: true });

// self-hosted fonts: no request to Google on page load
mkdirSync('docs/fonts/files', { recursive: true });
const faces = [['inter', [400, 500, 600]], ['jetbrains-mono', [300, 400, 500, 600]]];
let css = '';
for (const [pkg, weights] of faces) for (const w of weights) {
  const src = readFileSync(`node_modules/@fontsource/${pkg}/${w}.css`, 'utf8').replace(/, url\(\.\/files\/[^)]+\.woff\) format\('woff'\)/g, '');
  for (const f of src.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)) cpSync(`node_modules/@fontsource/${pkg}/files/${f[1]}`, `docs/fonts/files/${f[1]}`);
  css += src.replace(/url\(\.\/files\//g, 'url(files/');
}
writeFileSync('docs/fonts/fonts.css', css);
// debug console, served from this site instead of a CDN, loaded only when switched on
mkdirSync('docs/vendor', { recursive: true });
cpSync('node_modules/eruda/eruda.js', 'docs/vendor/eruda.js');

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  outfile: 'docs/app.js',
  legalComments: 'eof',
});

const id = Date.now().toString(36);
writeFileSync('docs/sw.js', readFileSync('docs/sw.js', 'utf8').replace('__BUILD__', id));
// what the live site is running, so the app can tell when it's behind (Settings → About)
const ver = readFileSync('src/store.js', 'utf8').match(/VERSION = '([^']+)'/)[1];
writeFileSync('docs/version.json', JSON.stringify({ version: ver, build: id }));

const svg = 'public/icons/icon.svg';
const r = (size, out, src = svg) => execSync(`rsvg-convert -w ${size} -h ${size} ${src} -o docs/icons/${out}`);
r(192, 'icon-192.png');
r(512, 'icon-512.png');

// maskable: square background, art scaled into the safe zone
const m = readFileSync(svg, 'utf8')
  .replace('<rect width="512" height="512" rx="96" fill="#161512"/>', '<rect width="512" height="512" fill="#161512"/><g transform="translate(51 51) scale(.8)">')
  .replace('</svg>', '</g></svg>');
writeFileSync('/tmp/maskable.svg', m);
r(512, 'maskable-512.png', '/tmp/maskable.svg');
// iPhone icon: same art on a full square (iOS adds its own rounded corners; transparent corners turn black)
writeFileSync('/tmp/apple.svg', readFileSync(svg, 'utf8').replace('<rect width="512" height="512" rx="96" fill="#161512"/>', '<rect width="512" height="512" fill="#161512"/>'));
r(180, 'apple-touch-icon.png', '/tmp/apple.svg');
console.log('built', id);
writeFileSync('docs/.nojekyll', '');
