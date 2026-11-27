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
| Coinbase price API | Showing fiat values | Settings → Privacy |
| Cashu auditor (audit.8333.space) | Opening mint details | Settings → Experimental |
| Nostr relays | Only when you use Nostr features (payment requests, NWC, backup, discovery) | Yes, by not enabling them |
| npub.cash | Only if you turn on the Lightning address | Yes |

## Known limits

- Your seed phrase and ecash are stored **unencrypted** in the browser. Anyone with your unlocked device can spend them. Write the seed down and keep it offline.
- Mints are custodians. A mint can refuse to redeem ecash or go offline. Use small amounts and mints you trust.
- GitHub Pages controls the hosting. If you want to remove that trust, build the site yourself (see the README) and host it on your own domain.
