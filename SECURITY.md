# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. Reports about anything that could leak a seed phrase, lose or double-spend ecash, or reveal who pays whom are the most valuable.

Fixes ship to the live wallet at <https://random21m.github.io/blindsig/> as soon as they're ready.

## How blindsig is built

- **No server of its own.** blindsig is a static site served by GitHub Pages. Your seed phrase, ecash and history stay in your browser's storage and are never uploaded anywhere.
- **Strict Content Security Policy.** Only code from the site itself can run. No inline scripts, no `eval`, no third-party scripts.
- **Nothing loaded from other sites at startup.** Fonts and the optional debug console are served from this site.
- **No referrer.** Requests to mints and other services don't reveal which page they came from.
- **One tab at a time.** Two open copies of the wallet can't spend the same ecash.

## Who the app talks to

| Service | When | Can turn off |
| --- | --- | --- |
| The mints you add | Balances, payments, token checks | No (that's how ecash works) |
| Coinbase price API | Showing fiat values, the price chart, and estimating older payments' value (the same price-history requests as the chart; no payment dates are sent) | Settings → Privacy |
| Cashu auditor (audit.8333.space) | Opening mint details | Settings → Experimental |
| Nostr relays | Only when you use Nostr features (payment requests, NWC, backup, discovery) | Yes, by not enabling them |
| npub.cash | Only if you turn on the Lightning address | Yes |

## Known limits

- Without the PIN lock, your seed phrase and ecash are stored **unencrypted** in the browser, and anyone with your unlocked device can spend them. With the PIN lock on (Settings → PIN lock), the wallet is encrypted with AES-256-GCM under a key derived from the PIN (PBKDF2-SHA256, 600,000 rounds). Only the theme, language, PIN length, lock delay and sound and vibration choices stay readable, so the lock screen can be drawn. A 4- or 6-digit PIN protects against someone picking up the phone. An attacker who copies the browser's storage can still try every PIN offline, so write the seed down and keep it offline either way.
- Face ID / Touch ID unlock uses a passkey kept by your phone (WebAuthn with the PRF extension). The passkey's secret, released only after Face ID or Touch ID, seals a copy of your PIN; that sealed copy sits next to the encrypted wallet. No server is involved, and changing the PIN turns it off.
- A decoy PIN opens a second, separate wallet that's sealed the same way under its own key. The PIN you type decides which wallet opens, and both checks run every time so neither PIN is slower. It's meant for someone looking over your shoulder or forcing you to unlock the app, not for forensics: someone who copies the browser's storage can see that a second sealed wallet exists, though not what's in it. Face ID always opens the real wallet. "Forgot PIN" resets both.
- A time vault locks ecash (NUT-11) to a key whose private half is thrown away, with your refund key allowed only after the unlock date. The mint enforces the date. The refund key and the locked token live in the wallet's storage, not in your seed phrase, so a seed restore can't bring a vault back: keep a backup file.
- Receiving nutzaps publishes a public note (kind 10019) tied to your nostr identity, listing your mints, your relays and a P2PK key used only for nutzaps. Anyone can see which mints you accept. Sent nutzaps are public events too: the amount, the mint and who you sent to are visible on the relays, though the ecash is locked so only the recipient can redeem it.
- Backup files are encrypted with AES-256-GCM under a key from your password (PBKDF2-SHA256, 600,000 rounds). The file holds the whole wallet, including the seed phrase, so its safety rests on the password: use a long one. Anyone with the file and the password can spend your ecash.
- Mints are custodians. A mint can refuse to redeem ecash or go offline. Use small amounts and mints you trust.
- GitHub Pages controls the hosting. If you want to remove that trust, build the site yourself (see the README) and host it on your own domain.
