// Stand-in for the parts of node:crypto that @relaycorp/dnssec uses to check DNSSEC signatures,
// built on the noble libraries the wallet already ships. Only verification is supported.
// Public keys reach verify() as their raw DNSKEY bytes (see build.mjs, which swaps the library's
// key decoding for one that keeps the bytes).
//
// BIP-353 rules applied here: SHA-1 signatures are refused, and so are RSA keys under 1024 bits.
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { p256, p384 } from '@noble/curves/nist.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ed448 } from '@noble/curves/ed448.js';
import { Buffer } from 'buffer';

const HASHES = { sha1, sha256, sha384, sha512 };
export function createHash(name) {
  const h = HASHES[String(name).toLowerCase()];
  if (!h) throw new Error(`unsupported hash ${name}`);
  const parts = [];
  return {
    update(d) { parts.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); return this; },
    digest() { const all = new Uint8Array(parts.reduce((t, p) => t + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } return Buffer.from(h(all)); },
  };
}

const toBig = (b) => { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; };
const toBytes = (x, len) => { const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; };
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
// DER DigestInfo prefixes for EMSA-PKCS1-v1_5 (RFC 8017)
const DIGEST_INFO = {
  8: [sha256, hex('3031300d060960864801650304020105000420')], // RSA/SHA-256
  10: [sha512, hex('3051300d060960864801650304020305000440')], // RSA/SHA-512
};
function rsaVerify(alg, raw, msg, sig) {
  const spec = DIGEST_INFO[alg]; if (!spec) return false;
  let start = 1, elen = raw[0];
  if (elen === 0) { elen = (raw[1] << 8) | raw[2]; start = 3; }
  const e = toBig(raw.subarray(start, start + elen)), nb = raw.subarray(start + elen);
  const n = toBig(nb);
  if (n.toString(2).length < 1024 || e < 3n) return false;
  const k = nb.length - (nb[0] === 0 ? 1 : 0);
  if (sig.length > k) return false;
  const s = toBig(sig); if (s >= n) return false;
  const em = toBytes(modPow(s, e, n), k);
  const [hash, prefix] = spec, digest = hash(msg);
  const tLen = prefix.length + digest.length;
  if (k < tLen + 11) return false;
  const want = new Uint8Array(k);
  want[0] = 0; want[1] = 1; want.fill(0xff, 2, k - tLen - 1); want[k - tLen - 1] = 0;
  want.set(prefix, k - tLen); want.set(digest, k - digest.length);
  let diff = 0; for (let i = 0; i < k; i++) diff |= em[i] ^ want[i];
  return diff === 0;
}
// verify(hash, data, key, signature): key is { dnssecRaw, alg } from the swapped key decoder
export function verify(_hash, data, key, signature) {
  try {
    const raw = new Uint8Array(key.dnssecRaw), msg = new Uint8Array(data), sig = new Uint8Array(signature);
    switch (key.alg) {
      case 8: case 10: return rsaVerify(key.alg, raw, msg, sig);
      case 13: return raw.length === 64 && p256.verify(sig, msg, Uint8Array.of(4, ...raw), { format: 'der', lowS: false });
      case 14: return raw.length === 96 && p384.verify(sig, msg, Uint8Array.of(4, ...raw), { format: 'der', lowS: false });
      case 15: return raw.length === 32 && ed25519.verify(sig, msg, raw);
      case 16: return raw.length === 57 && ed448.verify(sig, msg, raw);
      default: return false; // RSA/SHA-1 (5, 7) and anything unknown: refused
    }
  } catch { return false; }
}
// never used for checking; present because the library's module imports them
export function createPublicKey() { throw new Error('createPublicKey is not available in the browser'); }
export function sign() { throw new Error('signing is not available in the browser'); }
export function generateKeyPair() { throw new Error('key generation is not available in the browser'); }
