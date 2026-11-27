# blindsig

A cypherpunk Cashu ecash wallet. Installs as a PWA.

- 12-word seed (NUT-13 deterministic secrets) with full restore (NUT-09)
- Multiple mints: pick, switch, add any URL, move funds between mints over Lightning
- Receive: ecash tokens (paste/scan) or Lightning invoice (mint)
- Send: ecash tokens (QR, copy, share) or Lightning: bolt11 invoice, lightning address, LNURL-pay
- Unclaimed-token tracking and reclaim, spent-proof purge, token export, USD estimate
- Built on @cashu/cashu-ts 4.14 (latest stable)

## Deploy

The built site lives in `docs/` and is served by GitHub Pages (Settings → Pages → Deploy from branch → main, /docs).
(service workers and the camera require HTTPS):

- Netlify Drop: drag the `docs` folder onto https://app.netlify.com/drop
- or any HTTPS static host with `docs` as the site root

Open the URL on your phone, then "Add to Home Screen".

## Develop

    npm install
    npm run build      # bundles src/app.js + public/ into docs/

## Security notes

- The seed phrase and ecash live in this browser's localStorage, unencrypted.
  Anyone with access to the unlocked device can spend. Write the seed down offline.
- Mints are custodians. Use small amounts and mints you trust.
