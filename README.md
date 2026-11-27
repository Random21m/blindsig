# blindsig

A cypherpunk Cashu ecash wallet. Installs as a PWA.

- Soft charcoal look with three themes: green, white, amber
- 12-word seed (NUT-13) with full restore (NUT-09), including restore from another seed
- Multiple mints and units (sat, usd, eur…), mint details, MOTD, auditor data, move funds between mints
- Receive: ecash (paste, scan, NFC, auto-paste), Lightning invoices, P2PK-locked ecash, swap-in from other mints
- Send: ecash (static or animated BC-UR QR, link, NFC), Lightning invoices, Lightning addresses, LNURL, Multinut (NUT-15)
- P2PK keys (generate or import nsec), lock tokens to a pubkey or npub
- Privacy controls: invoice/sent-token checks, WebSockets (NUT-17), Coinbase price in 20 currencies
- On-screen keypad, ₿ symbol, unclaimed-token tracking, spent-proof cleanup, keyset counters, export, new seed, reset
- Built on @cashu/cashu-ts 4.14 (latest stable)

- Nostr: identity from your seed (same key as cashu.me), nsec, NIP-07 extension or NIP-46 bunker; custom relays
- Lightning address via npub.cash (NIP-98 auth), with automatic claiming
- Payment requests (NUT-18): create and pay, delivered over nostr (NIP-17) or HTTP POST; ecash in nostr DMs is picked up too
- Nostr Wallet Connect (NIP-47, nip04 and nip44): pay_invoice, make_invoice, get_balance, get_info, list_transactions, lookup_invoice, with an allowance
- Mint discovery and reviews (NIP-87), web of trust, and encrypted mint list backup on nostr (cashu.me compatible)

Coming next: languages.

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
