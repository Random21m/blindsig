// Face ID / Touch ID unlock with a passkey (WebAuthn) and its PRF extension. The passkey gives back
// 32 secret bytes only after Face ID or Touch ID; those bytes make the key that seals the PIN.
// Nothing leaves the device: the passkey lives in the phone's keychain, no server is involved.
import { b64, unb64, bioInfo, setBio, clearBio, bioPin } from './store.js';

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const aesKey = (bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function bioAvailable() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}
export const bioOn = () => !!bioInfo();
export const bioLabel = () => (/iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) ? 'Face ID or Touch ID' : 'fingerprint or face unlock');

async function prf(id, salt) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: rnd(32), rpId: location.hostname, userVerification: 'required', timeout: 60000,
    allowCredentials: [{ type: 'public-key', id: unb64(id) }],
    extensions: { prf: { eval: { first: unb64(salt) } } },
  } });
  const out = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!out) throw new Error('no-prf');
  return aesKey(new Uint8Array(out));
}
// turn on: make a passkey, then seal the (already checked) PIN with its PRF key
export async function bioEnroll(pin) {
  const salt = b64(rnd(32));
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'blindsig', id: location.hostname },
    user: { id: rnd(16), name: 'blindsig', displayName: 'blindsig wallet' },
    challenge: rnd(32), timeout: 60000,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
    extensions: { prf: { eval: { first: unb64(salt) } } },
  } });
  if (!cred) throw new Error('cancelled');
  const ext = cred.getClientExtensionResults?.().prf;
  if (ext && ext.enabled === false) throw new Error('no-prf');
  const id = b64(cred.rawId);
  // some phones give the secret right away, others only on the first use
  const key = ext?.results?.first ? await aesKey(new Uint8Array(ext.results.first)) : await prf(id, salt);
  await setBio(id, salt, key, pin);
}
// unlock: Face ID / Touch ID → the PIN
export async function bioUnlock() {
  const b = bioInfo(); if (!b) throw new Error('off');
  return bioPin(await prf(b.id, b.salt));
}
export { clearBio };
