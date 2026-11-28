<p align="center">
  <img src="assets/logo.svg" width="112" alt="blindsig logo">
</p>

<h1 align="center">blindsig</h1>

<p align="center">
  <b>A cypherpunk Cashu ecash wallet.</b><br>
  Private bitcoin payments in your browser. Installs as an app. No account, no sign-up.
</p>

<p align="center">
  <a href="https://random21m.github.io/blindsig/"><b>Open the wallet →</b></a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#demo">Demo</a>
  &nbsp;·&nbsp;
  <a href="#screenshots">Screenshots</a>
  &nbsp;·&nbsp;
  <a href="#run-it-yourself">Run it yourself</a>
  &nbsp;·&nbsp;
  <a href="#support">Support</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.26.1-72d99b?style=flat-square&labelColor=161512" alt="version 1.26.1">
  <img src="https://img.shields.io/badge/cashu--ts-4.14-72d99b?style=flat-square&labelColor=161512" alt="cashu-ts 4.14">
  <img src="https://img.shields.io/badge/PWA-installable-f2b763?style=flat-square&labelColor=161512" alt="installable PWA">
  <img src="https://img.shields.io/badge/languages-14-efe9dd?style=flat-square&labelColor=161512" alt="14 languages">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-efe9dd?style=flat-square&labelColor=161512" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://random21m.github.io/blindsig/"><img src="assets/hero.png" alt="blindsig in its four themes: green, burnt orange, white and amber" width="100%"></a>
</p>

## What is it?

[Cashu](https://cashu.space) is ecash for bitcoin. A mint issues tokens that work like digital banknotes: you hold them on your own device, and thanks to blind signatures the mint can't see who pays whom. blindsig is a wallet for those tokens. It does everything [cashu.me](https://cashu.me) does, with a calmer terminal-style look that's easy on the eyes.

## Get started

1. Open **<https://random21m.github.io/blindsig/>** on your phone.
2. Add it to your home screen (Share → Add to Home Screen on iPhone, ⋮ → Install app on Android).
3. Write down your 12-word seed phrase, pick a mint, and receive some sats over Lightning.
4. Turn on the PIN lock under Settings → PIN lock, so the wallet is encrypted on your phone. Face ID or Touch ID can unlock it too.
5. Make a backup file (Settings → Backup & restore) and keep it with its password somewhere safe.

> [!WARNING]
> Mints hold the bitcoin behind your ecash, so they are custodians. Use small amounts and mints you trust, and keep your seed phrase offline.

## Demo

<p align="center">
  <a href="assets/blindsig-demo.mp4"><img src="assets/demo-thumb.jpg" width="300" alt="Play the blindsig demo video"></a><br>
  <sub>About two and a half minutes: a new wallet, receiving over Lightning with a note, sending ecash, a gift card, paying and saving a contact, the PIN lock with Face ID, what each payment was worth then and now, splitting a bill, the time vault, a tip jar card, hiding amounts, the live price chart and the themes. Tap to play.</sub>
</p>

## Screenshots

<table>
  <tr>
    <td align="center"><img src="assets/screens/home-green.png" width="250" alt="Home screen"><br><sub><b>Home</b>: balance, fiat value and history</sub></td>
    <td align="center"><img src="assets/screens/invoice.png" width="250" alt="Lightning invoice"><br><sub><b>Receive</b>: Lightning invoice</sub></td>
    <td align="center"><img src="assets/screens/token.png" width="250" alt="Ecash token"><br><sub><b>Send</b>: ecash token as QR, text or link</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/offer.png" width="250" alt="BOLT12 offer"><br><sub><b>BOLT12</b>: a reusable offer you can be paid to again and again</sub></td>
    <td align="center"><img src="assets/screens/onchain.png" width="250" alt="On-chain send"><br><sub><b>On-chain</b>: send to a bitcoin address with a fee choice</sub></td>
    <td align="center"><img src="assets/screens/received.png" width="250" alt="Payment received"><br><sub><b>Done</b>: payment received</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/mints.png" width="250" alt="Mints"><br><sub><b>Mints</b>: add, switch and discover mints</sub></td>
    <td align="center"><img src="assets/screens/auditor.png" width="250" alt="Mint details with auditor"><br><sub><b>Mint details</b>: features, keysets and auditor results</sub></td>
    <td align="center"><img src="assets/screens/settings.png" width="250" alt="Settings"><br><sub><b>Settings</b>: backup, Nostr, NWC, privacy and more</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/lock.png" width="250" alt="PIN lock screen"><br><sub><b>PIN lock</b>: asked when the app opens</sub></td>
    <td align="center"><img src="assets/screens/pin-settings.png" width="250" alt="PIN lock settings"><br><sub><b>PIN settings</b>: when to ask again, change or turn off</sub></td>
    <td align="center"><img src="assets/screens/appearance.png" width="250" alt="Appearance settings"><br><sub><b>Appearance</b>: four themes, sound, vibration and motion</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/note.png" width="250" alt="A private note on a transaction"><br><sub><b>Notes</b>: a private note on any transaction</sub></td>
    <td align="center"><img src="assets/screens/search.png" width="250" alt="Searching history"><br><sub><b>Search</b>: find payments by note, memo or amount</sub></td>
    <td align="center"><img src="assets/screens/backup.png" width="250" alt="Backup file"><br><sub><b>Backup file</b>: the whole wallet in one password-locked file</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/chart.png" width="250" alt="Live bitcoin price chart"><br><sub><b>Price chart</b>: tap the price for a live chart, drag to read it</sub></td>
    <td align="center"><img src="assets/screens/contacts.png" width="250" alt="Contacts on the send screen"><br><sub><b>Contacts</b>: pay the people you pay often in one tap</sub></td>
    <td align="center"><img src="assets/screens/onboard.png" width="250" alt="Welcome screen"><br><sub><b>Start</b>: a quick intro, then a 12-word seed. No account.</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/gift.png" width="250" alt="Gift card"><br><sub><b>Gift cards</b>: sats on a card with a message, to share, save or print</sub></td>
    <td align="center"><img src="assets/screens/gift-claim.png" width="250" alt="Claiming a gift"><br><sub><b>Claim a gift</b>: scan it, no wallet needed yet</sub></td>
    <td align="center"><img src="assets/screens/comeback.png" width="250" alt="Lock to one person"><br><sub><b>Sends that come back</b>: locked to one person, back to you if unclaimed</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/summary.png" width="250" alt="Monthly summary"><br><sub><b>Summary</b>: money in and out each month, worth then, CSV export</sub></td>
    <td align="center"><img src="assets/screens/spread.png" width="250" alt="Spread your risk"><br><sub><b>Spread your risk</b>: move the extra from a full mint in one tap</sub></td>
    <td align="center"><img src="assets/screens/decoy.png" width="250" alt="Decoy PIN"><br><sub><b>Decoy PIN</b>: a second PIN that opens a small, separate wallet</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/tipjar.png" width="250" alt="Tip jar card"><br><sub><b>Tip jar</b>: your Lightning address on a card to print or share</sub></td>
    <td align="center"><img src="assets/screens/vault.png" width="250" alt="Time vault"><br><sub><b>Time vault</b>: sats locked away until a date, even from you</sub></td>
    <td align="center"><img src="assets/screens/split.png" width="250" alt="Split a bill"><br><sub><b>Split a bill</b>: one request each, with live progress</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screens/nutzap.png" width="250" alt="Nutzap"><br><sub><b>Nutzaps</b>: send ecash to anyone's npub over Nostr</sub></td>
    <td align="center"><img src="assets/screens/nfc.png" width="250" alt="Write to NFC card"><br><sub><b>NFC cards</b>: put a gift on a card any phone can tap (Android writes)</sub></td>
    <td align="center"><img src="assets/screens/mint-details.png" width="250" alt="Mint details"><br><sub><b>Mint details</b>: what a mint supports, its keysets and auditor record</sub></td>
  </tr>
</table>

### Four themes

Green, white, amber and burnt orange, all on the same soft charcoal background. Change it under Settings → Appearance.

<table>
  <tr>
    <td align="center"><img src="assets/screens/home-green.png" width="190" alt="Green theme"><br><sub>Green</sub></td>
    <td align="center"><img src="assets/screens/home-white.png" width="190" alt="White theme"><br><sub>White</sub></td>
    <td align="center"><img src="assets/screens/home-amber.png" width="190" alt="Amber theme"><br><sub>Amber</sub></td>
    <td align="center"><img src="assets/screens/home-orange.png" width="190" alt="Burnt orange theme"><br><sub>Burnt orange</sub></td>
  </tr>
</table>

<sub>Screenshots were taken against a local test mint with fake Lightning, so the amounts aren't real.</sub>

## Features

**Wallet**

- 12-word seed (NUT-13) with full restore (NUT-09), including restoring from another seed
- Backup file: the whole wallet (seed, ecash, history, notes, keys and settings) in one file locked with a password. Restoring it checks your mints so spent ecash is dropped and anything newer is picked up. Handy for moving to a new phone, or from Safari to the Home Screen app
- Multiple mints and units (sat, usd, eur…), mint messages, nicknames, and moving funds between mints
- A warning when one mint holds more than an amount you choose (100,000 sat by default), with a one-tap plan to spread the extra across your other mints. Turn on "Spread automatically" and it happens by itself while the app is open, skipping any move whose fee could be over 2%
- Mint discovery and reviews over Nostr (NIP-87), auditor results, and mint-list backup (compatible with cashu.me)
- Mints that require an account (NUT-21/22): log in once with the mint's login page, then each request uses a blind token so the mint can't tie your payments to your account
- Tidy up ecash: swap many small notes for the fewest that make the same amount, for shorter tokens and lower fees later

**Receive**

- Ecash: paste, scan (including animated QR), NFC, share from another app (Android), or auto-paste from the clipboard (not on iPhone, where Safari asks before every paste)
- A check that the mint really signed the ecash (NUT-12 DLEQ), before you accept it. It works offline for mints you've used, and ecash that fails it can't be parked for later
- Lightning invoices, BOLT12 offers you can reuse, and on-chain deposit addresses
- LNURL-withdraw: scan a voucher, faucet or ATM code and the sats land in your mint
- Tokens from other mints, either kept there or swapped into your mint
- "Receive later" to park a token in your history and claim it when you're ready

**Send**

- Ecash as a static or animated QR (BC-UR), a link, NFC, or hidden inside an emoji
- NFC cards and stickers (Android): load a card with ecash or a gift so any phone that taps it, iPhones included, opens the claim link; write your tip jar to a sticker; and the scanner reads cards too
- Offline sending: exact-amount tokens made without contacting the mint, even right after opening the app (the mint's keys are saved)
- Tokens carry the mint's signature proofs, so whoever you pay can check them offline (can be turned off for shorter tokens)
- Lightning invoices, Lightning addresses, LNURL, BOLT12 offers, ₿user@domain names (BIP-353, checked with DNSSEC in the app), and bitcoin addresses and URIs (BIP-21/321)
- Tap a shop terminal like Numo to pay (Android, Web NFC)
- Lock with a code (HTLC, NUT-14): whoever gets the token also needs a code you send separately; take it back any time until it's claimed
- Multinut payments across several mints (NUT-15), and P2PK-locked tokens to a pubkey, npub or contact, optionally with the key hidden from the mint (P2BK, NUT-28)
- Time vault: lock sats away until a date you choose. Nobody can spend them before then, not even you; on the day they come back to your wallet by themselves. Vault keys are blinded, so the mint can't tell your vaults belong together
- Sends that come back: lock ecash to one person, and if they don't claim it in time (an hour, a day, a week or 30 days) it returns to your wallet on its own
- Contacts: save people and places you pay often (Lightning address, LNURL, BOLT12 offer or npub) and pay them in two taps. After paying a new address, one tap saves it

**Nostr**

- A Nostr identity from your seed (the same key as cashu.me), or an nsec, browser extension (NIP-07) or remote signer (NIP-46)
- Lightning address via npub.cash, with automatic claiming, live updates, optional short usernames (price shown up front), and payments locked to your key so only your wallet can claim them
- Payment requests (NUT-18) with a description, an optional lock to your key, and delete. Delivered over Nostr or HTTP, checked in full before they're claimed, and payable from any of your mints when the request allows it. Ecash in Nostr DMs is picked up automatically
- Nostr Wallet Connect (NIP-47) with a spending allowance, so other apps can use your wallet
- Nostr wallet sync (NIP-60): keep your ecash on your relays, encrypted to your nostr key, so Nostr apps that support it share the same balance. Ecash spent or received in another app shows up here, and nutzaps can be redeemed by either

**Privacy and safety**

- Hide amounts: tap the balance to show •••• instead of your balance and payment amounts (like cashu.me)
- Hide history: tap History to fold your transactions away for a clean main screen
- You choose which background checks run: invoices, sent tokens, WebSockets (NUT-17) and price lookups
- Sent tokens update live when someone claims them
- Private notes on any transaction, kept only on your device (and encrypted with the PIN lock), and search across notes, memos and amounts
- What a payment was worth: each one remembers the bitcoin price at that moment, so its details show the value then and now. A monthly summary shows money in and out, with a CSV export of your whole history for budgeting or taxes
- Optional PIN lock that also encrypts the wallet on the device (AES-256-GCM, key from the PIN via PBKDF2). It asks again after a time in the background you choose, before showing the seed phrase, and waits longer after repeated wrong guesses. Face ID or Touch ID can unlock it, using a passkey on your phone (WebAuthn PRF), with no server involved
- Confirm big sends: with the PIN lock on, ask for the PIN (or Face ID) before sending more than an amount you pick
- Decoy PIN: a second PIN that opens a separate, small wallet instead of your real one, for when someone forces you to unlock. Put a little in it so it looks real; removing it moves its ecash back
- A reminder to make a backup file once the wallet holds money, repeated monthly until you do
- Data stays in this browser's IndexedDB, and only one tab can run the wallet at a time, so two tabs can't spend the same ecash
- Spent-proof cleanup, keyset counters, export and new-seed tools for when something looks off

**Everywhere**

- 14 languages: English, Español, Português (Brasil), Français, Deutsch, Italiano, Svenska, Čeština, Ελληνικά, Türkçe, العربية (right to left), ไทย, 日本語 and 中文
- On-screen keypad, optional ₿ symbol, prices in 20 currencies
- Nutzaps (NIP-61): send ecash to anyone's npub (type or scan it in Send), and turn on receiving so people can nutzap you from Nostr apps. Unclaimed nutzaps come back after a week
- Split a bill: one Lightning request per person, shared one by one or all at once to a group chat, with live progress ("2 of 3 paid")
- Tip jar card: your Lightning address as a big QR code on a printable card, for a counter, a stream or a market stall
- Gift cards: turn sats into a card with a message and a QR code to share, save or print. Whoever scans it can claim the gift, even without a wallet yet, and you can take it back if nobody does
- Tap the bitcoin price at the top for a live chart (hour, day, week, month, year or all time); drag along it to read any point
- Four themes: green, white, amber and burnt orange
- Coin sounds, confetti and a drawn checkmark when payments complete, a shake when something's off (each can be turned off). Sound and vibration only when money arrives or leaves. On iPhone, sounds can play even with the phone on silent
- Works offline once installed

## Run it yourself

blindsig is a static site, so any HTTPS host works. Service workers and the camera need HTTPS.

```sh
npm install
npm run build      # bundles src/main.js and public/ into docs/
```

- **GitHub Pages:** Settings → Pages → Deploy from branch → `main`, `/docs`.
- **Netlify Drop:** drag the `docs` folder onto <https://app.netlify.com/drop>.

## Translations

UI text is English in the source and swapped at runtime from `public/i18n/<code>.json`. Source strings live in `tools/i18n/en.json` and translations in `tools/i18n/tr/<code>.tsv` (`index<TAB>text`). New strings go at the end of `en.json` so existing indices stay put. Run `python3 tools/i18n/build.py` to regenerate the JSON files.

The translations were machine-assisted and haven't been reviewed by native speakers. Corrections are welcome.

## Security and privacy

- **No server of its own, no account.** Your seed phrase, ecash and history stay in your browser.
- **Strict Content Security Policy.** Only the site's own code can run, and fonts are self-hosted, so opening the wallet doesn't ping Google or a CDN.
- **You control the extras.** Price lookups, the mint auditor, Nostr and npub.cash can all be turned off. [SECURITY.md](SECURITY.md) lists every service the app talks to.
- **Turn on the PIN lock.** Without it, your seed phrase and ecash are stored unencrypted in this browser and anyone with your unlocked phone can spend them. With it, they're encrypted under your PIN. A short PIN stops someone who picks up your phone. It won't hold off a determined attacker who copies the browser's data, so write the seed down and keep it offline either way.
- **Mints are custodians.** Use small amounts and mints you trust.

Found a security problem? Please [report it privately](https://github.com/Random21m/blindsig/security/advisories/new) instead of opening an issue.

## Support

blindsig is free and open source. If it's useful to you, a tip over Lightning helps keep it going. Scan the code with any Lightning wallet, or use **Send a tip** in the app (Settings → About).

<p align="center"><img src="assets/support.png" width="560" alt="Lightning tip QR code for blindsig"></p>

```
npub1t5nvfnlmegsqkqegcpnyek4qf4fc2f2gx2t4lm88h2kq22plpmxqdhgpa9@npub.cash
```

Starring the repo, reporting bugs and fixing translations help too.

## Built with

[cashu-ts](https://github.com/cashubtc/cashu-ts) · [nostr-tools](https://github.com/nbd-wtf/nostr-tools) · [esbuild](https://esbuild.github.io) · inspired by [cashu.me](https://github.com/cashubtc/cashu.me)

## License

[MIT](LICENSE). Use it, fork it, run your own.
