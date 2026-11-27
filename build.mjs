import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

rmSync('docs', { recursive: true, force: true });
mkdirSync('docs/icons', { recursive: true });
cpSync('public', 'docs', { recursive: true });

await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  outfile: 'docs/app.js',
  legalComments: 'eof',
});

const id = Date.now().toString(36);
writeFileSync('docs/sw.js', readFileSync('docs/sw.js', 'utf8').replace('__BUILD__', id));

const svg = 'public/icons/icon.svg';
const r = (size, out, src = svg) => execSync(`rsvg-convert -w ${size} -h ${size} ${src} -o docs/icons/${out}`);
r(192, 'icon-192.png');
r(512, 'icon-512.png');
r(180, 'apple-touch-icon.png');
// maskable: square background, art scaled into the safe zone
const m = readFileSync(svg, 'utf8')
  .replace('<rect width="512" height="512" rx="96" fill="#050605"/>', '<rect width="512" height="512" fill="#050605"/><g transform="translate(51 51) scale(.8)">')
  .replace('</svg>', '</g></svg>');
writeFileSync('/tmp/maskable.svg', m);
r(512, 'maskable-512.png', '/tmp/maskable.svg');
console.log('built', id);
writeFileSync('docs/.nojekyll', '');
