// esbuild plugin: lets @relaycorp/dnssec run in the browser (see build.mjs and src/dnssec-shim.js)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const dnssecBrowser = (shim, { stubUtil = true } = {}) => ({
  name: 'dnssec-browser',
  setup(b) {
    b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: resolve(shim) }));
    if (stubUtil) b.onResolve({ filter: /^node:util$/ }, () => ({ path: 'node-util', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const promisify = () => () => { throw new Error("unavailable"); };' }));
    b.onLoad({ filter: /dnssec[\\/]build[\\/]lib[\\/]lib[\\/]utils[\\/]crypto[\\/]keySerialisation\.js$/ }, (a) => {
      let src = readFileSync(a.path, 'utf8')
        .replace('export function serialisePublicKey(', 'function serialisePublicKeyOrig(')
        .replace('export function deserialisePublicKey(', 'function deserialisePublicKeyOrig(');
      src += '\nexport function deserialisePublicKey(s, alg) { return { dnssecRaw: Buffer.from(s), alg }; }'
        + '\nexport function serialisePublicKey(k, alg) { return k && k.dnssecRaw ? Buffer.from(k.dnssecRaw) : serialisePublicKeyOrig(k, alg); }\n';
      return { contents: src, loader: 'js', resolveDir: dirname(a.path) };
    });
  },
});
