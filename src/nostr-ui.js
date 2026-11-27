// Screens for the nostr features. Receives shared UI helpers from app.js.
import { S, save, mintOf, mintLabel, host, esc, fmt, unitLabel, normUrl } from './store.js';
import * as C from './core.js';
import * as N from './nostr.js';

export function nostrUI(x) {
  const { $, $$, sheet, closeSheet, toast, copy, withBusy, kv, toggle, qrSvg, render, niceErr, amountField, readAmt } = x;
  const qrInto = (el, text) => qrSvg(text).then((s) => { if (el && el.isConnected) el.innerHTML = `<div class="qr">${s}</div>`; });
  const stars = (r) => (r ? '★'.repeat(r) + '☆'.repeat(5 - r) : '');
  const short = (s, n = 10) => (s.length > n * 2 + 1 ? s.slice(0, n) + '…' + s.slice(-6) : s);

  /* ---------- settings: Lightning address ---------- */
  function lnaddr() {
    const n = S.npc;
    sheet('Lightning address', `<p class="dim">Get a Lightning address from npub.cash. Payments to it become ecash at your chosen mint. It uses your nostr key (see Nostr settings).</p>
      ${toggle('t_npc', 'Enable', 'Lightning address with ' + esc(n.host), n.enabled)}
      ${n.enabled ? `
        <div class="addrcard"><b id="addr">${esc(n.address || 'Loading…')}</b><div class="btnrow"><button class="btn" id="cpa">Copy</button><button class="btn" id="sha">QR code</button></div></div>
        <div id="aq"></div>
        ${toggle('t_show', 'Show when receiving', 'Show your address in Receive → Lightning.', n.showOnReceive)}
        ${toggle('t_auto', 'Claim automatically', 'Turn incoming payments into ecash right away.', n.auto)}
        <label class="lbl" for="nm">Mint for incoming payments</label>
        <select id="nm" class="field">${S.mints.filter((m) => (m.units || []).includes('sat')).map((m) => `<option value="${esc(m.url)}" ${m.url === n.mint ? 'selected' : ''}>${esc(mintLabel(m))}</option>`).join('')}</select>
        <button class="btn wide" id="ck">Check for payments</button>
        <h3>Username</h3><p class="dim small">Replace the long npub with a short name, like satoshi@${esc(n.host)}. npub.cash may charge for this.</p>
        <form class="addm" id="un"><input id="uname" class="field" placeholder="satoshi" autocapitalize="off" autocomplete="off" maxlength="40"><button class="btn">Check</button></form>
        <div id="ux"></div>` : ''}
      <label class="lbl" for="hs">Server</label><input id="hs" class="field" value="${esc(n.host)}" autocapitalize="off">`, (b) => {
      $('#t_npc', b).onchange = withBusy($('#t_npc', b), async () => {
        n.enabled = $('#t_npc', b).checked; save();
        if (n.enabled) { try { await N.npcRefresh(); } catch (e) { toast(niceErr(e), 'err'); } }
        N.startAll(); lnaddr();
      });
      $('#hs', b).onchange = (e) => { const v = e.target.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (v) { n.host = v; n.address = ''; n.lastCheck = 0; save(); if (n.enabled) N.npcRefresh().then(lnaddr).catch((er) => toast(niceErr(er), 'err')); } };
      if (!n.enabled) return;
      if (!n.address) N.npcRefresh().then(() => { const a = $('#addr', b); if (a) a.textContent = n.address; }).catch((e) => toast(niceErr(e), 'err'));
      $('#cpa', b).onclick = () => copy(n.address, 'Address copied');
      $('#sha', b).onclick = () => qrInto($('#aq', b), 'lightning:' + n.address);
      ['show', 'auto'].forEach((k) => { $('#t_' + k, b).onchange = (e) => { n[k === 'show' ? 'showOnReceive' : 'auto'] = e.target.checked; save(); }; });
      $('#nm', b).onchange = withBusy($('#nm', b), async () => { await N.npcSetMint($('#nm', b).value); toast('Mint updated'); });
      const ck = $('#ck', b); ck.onclick = withBusy(ck, async () => { const a = await N.npcSync(); render(); toast(a ? `New payments: ${a}` : 'No new payments'); });
      const unb = $('#un button', b);
      $('#un', b).onsubmit = (e) => { e.preventDefault(); claim(); };
      const claim = withBusy(unb, async () => {
        const name = $('#uname', b).value.trim().toLowerCase();
        if (!/^[a-z0-9._-]{1,40}$/.test(name)) return toast('Use letters, numbers, dots, dashes or underscores.', 'warn');
        const r = await N.npcUsernameQuote(name);
        if (r.done) { toast('Username set'); return lnaddr(); }
        const q = N.decodeRequest(r.creq), need = q.mints[0];
        const onMint = !need || need === S.active, have = need && mintOf(need);
        const readable = onMint ? await N.npcPayableKeyset(S.active, S.unit) : undefined;
        const ux = $('#ux', b);
        ux.innerHTML = kv([['Username', esc(name + '@' + n.host)], ['Price', `<b>${esc(fmt(q.amount, q.unit))}</b>`], need && ['Paid with ecash from', esc(host(need))], ['Pay from', esc(host(S.active))]])
          + (onMint && readable === null ? `<p class="warn">npub.cash’s server can’t currently read ecash from ${esc(host(S.active))} (this mint uses newer keys), so it will probably refuse the payment. If it does, your sats come straight back, minus a sat or two of mint fees.</p><button class="btn wide" id="buy">Try anyway</button>`
            : onMint ? '<button class="btn primary wide" id="buy">Pay and claim</button>'
            : `<p class="warn">npub.cash only takes ecash from ${esc(host(need))}. ${have ? 'Switch to it, then pay.' : 'Add that mint and move some sats to it first.'}</p><button class="btn wide" id="swn">${have ? `Switch to ${esc(host(need))}` : `Add ${esc(host(need))}`}</button>`);
        const buy = $('#buy', ux);
        if (buy) buy.onclick = withBusy(buy, async () => { await N.npcBuyUsername(name, r.creq); render(); toast('Username claimed'); lnaddr(); });
        const swn = $('#swn', ux);
        if (swn) swn.onclick = withBusy(swn, async () => { if (!have) await C.addMint(need); C.selectMint(need); render(); $('#un button', b)?.click(); });
      });
    }, { back: x.settingsSheet });
  }

  /* ---------- settings: Nostr ---------- */
  async function nostr() {
    let pk = '';
    try { pk = (await N.signer()).pubkey; } catch {}
    const nn = S.nostr;
    const opt = (k, t, d) => `<label class="radio"><input type="radio" name="sg" value="${k}" ${nn.signer === k ? 'checked' : ''}><span class="mt"><b>${t}</b><small>${d}</small></span></label>`;
    sheet('Nostr', `<h3>Your nostr identity</h3>
      ${pk ? `<div class="addrcard"><b>${esc(short(N.npubOf(pk), 14))}</b><div class="btnrow"><button class="btn" id="cnp">Copy npub</button>${N.nsecOfSigner() ? '<button class="btn" id="cns">Copy nsec</button>' : ''}</div></div>` : '<p class="warn">No signer available.</p>'}
      <p class="dim small">Used for your Lightning address and mint reviews. Payment requests and messages always use the key from your wallet seed.</p>
      ${opt('seed', 'Wallet seed phrase', 'Derive a key from your seed (recommended)')}
      ${opt('nsec', 'Your nsec', 'Paste a private key. Not recommended.')}
      ${opt('nip07', 'Signing extension', window.nostr ? 'Use a NIP-07 browser extension' : 'No NIP-07 extension found')}
      ${opt('nip46', 'Remote signer (bunker)', 'Connect a NIP-46 bunker URI')}
      <div id="sgx"></div>
      <h3>Relays</h3>
      <ul class="keys">${N.relays().map((r) => `<li><button data-r="${esc(r)}"><code>${esc(r)}</code><span class="dim">remove</span></button></li>`).join('')}</ul>
      <form class="addm" id="ar"><input id="rl" class="field" placeholder="wss://relay.example" autocapitalize="off"><button class="btn">Add</button></form>
      <h3>Mint list backup</h3>
      ${toggle('t_bk', 'Back up mint list on nostr', 'Encrypted with a key from your seed, so a restore can find your mints.', nn.backup)}
      ${nn.backup ? `<p class="dim small">${nn.backupTs ? 'Last backup ' + new Date(nn.backupTs * 1000).toLocaleString() : 'Not backed up yet.'}</p><button class="btn wide" id="bkn">Back up now</button>` : ''}
      <h3>Web of trust</h3>
      <p class="dim small"><span>Collects the people you follow and the people they follow, to highlight mint reviews from them.</span> ${nn.wot ? `<span>Currently ${nn.wot.pubkeys.length.toLocaleString()} keys.</span>` : ''}</p>
      <input id="wr" class="field" placeholder="Start from npub (leave empty for yours)" autocapitalize="off">
      <button class="btn wide" id="wb">Build web of trust</button>
      <button class="btn wide" id="wo">Crawl ODELL’s web of trust</button><p class="dim small" id="wp"></p>`, (b) => {
      const cnp = $('#cnp', b); if (cnp) cnp.onclick = () => copy(N.npubOf(pk), 'npub copied');
      const cns = $('#cns', b); if (cns) cns.onclick = () => copy(N.nsecOfSigner(), 'nsec copied. Keep it secret.');
      $$('input[name=sg]', b).forEach((r) => (r.onchange = () => {
        const v = r.value, box = $('#sgx', b);
        if (v === 'seed') { N.setSigner('seed'); nostr(); return; }
        if (v === 'nip07') { try { N.setSigner('nip07'); nostr(); } catch (e) { toast(niceErr(e), 'err'); nostr(); } return; }
        box.innerHTML = `<form class="addm" id="sf"><input id="sv" class="field" placeholder="${v === 'nsec' ? 'nsec1…' : 'bunker://…'}" autocapitalize="off" autocomplete="off"><button class="btn primary">Use</button></form>`;
        $('#sf', b).onsubmit = async (e) => {
          e.preventDefault();
          try { N.setSigner(v, $('#sv', b).value); await N.signer(); toast('Signer updated'); nostr(); } catch (er) { toast(niceErr(er), 'err'); }
        };
      }));
      $$('.keys button', b).forEach((x2) => (x2.onclick = () => { S.nostr.relays = N.relays().filter((r) => r !== x2.dataset.r); save(); N.startAll(); nostr(); }));
      $('#ar', b).onsubmit = (e) => {
        e.preventDefault(); let r = $('#rl', b).value.trim(); if (!r) return;
        if (!/^wss?:\/\//.test(r)) r = 'wss://' + r;
        S.nostr.relays = [...new Set([...N.relays(), r])]; save(); N.startAll(); nostr();
      };
      $('#t_bk', b).onchange = withBusy($('#t_bk', b), async () => { nn.backup = $('#t_bk', b).checked; save(); if (nn.backup) { await N.backupMints(); toast('Mint list backed up'); } nostr(); });
      const bkn = $('#bkn', b); if (bkn) bkn.onclick = withBusy(bkn, async () => { await N.backupMints(); toast('Mint list backed up'); nostr(); });
      const wb = $('#wb', b);
      const prog = (t) => { const p = $('#wp', b); if (p) p.textContent = t; };
      wb.onclick = withBusy(wb, async () => { const n = await N.buildWot($('#wr', b).value, prog); toast(`Web of trust: ${n.toLocaleString()} keys`); });
      const wo = $('#wo', b);
      wo.onclick = withBusy(wo, async () => { const n = await N.buildWot(N.ODELL, prog); toast(`Web of trust: ${n.toLocaleString()} keys`); });
    }, { back: x.settingsSheet });
  }

  /* ---------- settings: payment requests ---------- */
  function prSettings() {
    sheet('Payment requests', `<p class="dim">Payment requests (NUT-18) let people pay you ecash over nostr. When enabled, the wallet listens on your relays while it’s open.</p>
      ${toggle('t_pr', 'Enable payment requests', 'Also receives ecash sent to you in nostr direct messages.', S.pr.enabled)}
      ${toggle('t_pra', 'Claim automatically', 'Receive matching payments from known mints right away.', S.pr.auto)}
      <button class="btn primary wide" id="nr">New payment request</button>
      <h3>Your requests</h3>
      <ul class="keys">${S.pr.requests.map((r) => `<li><button data-id="${esc(r.id)}"><span class="mt"><b>${r.amount ? esc(fmt(r.amount, r.unit)) : 'Any amount'}${r.memo ? ' · ' + esc(r.memo) : ''}</b><small>${new Date(r.ts).toLocaleDateString()} · ${`Payments: ${(r.payments || []).length}`}</small></span><span aria-hidden="true">›</span></button></li>`).join('') || '<li class="dim">None yet.</li>'}</ul>`, (b) => {
      $('#t_pr', b).onchange = (e) => { S.pr.enabled = e.target.checked; save(); N.startAll(); };
      $('#t_pra', b).onchange = (e) => { S.pr.auto = e.target.checked; save(); };
      $('#nr', b).onclick = () => newRequest(prSettings);
      $$('.keys button[data-id]', b).forEach((x2) => (x2.onclick = () => showRequest(S.pr.requests.find((r) => r.id === x2.dataset.id), prSettings)));
    }, { back: x.settingsSheet });
  }
  function newRequest(back) {
    sheet('New payment request', `${amountField('amt', 'Leave empty to let the payer choose')}
      <input id="memo" class="field" placeholder="Description (optional)" maxlength="80">
      <label class="chk"><input type="checkbox" id="om"> Only accept ecash from ${esc(mintLabel(mintOf(S.active)) || 'the active mint')}</label>
      <label class="chk"><input type="checkbox" id="lk"> Lock payments to my P2PK key</label>
      <button class="btn primary wide" id="go">Create request</button>`, (b) => {
      $('#go', b).onclick = () => {
        if (!S.pr.enabled) { S.pr.enabled = true; save(); N.startAll(); toast('Payment requests enabled'); }
        const r = N.createRequest({ amount: readAmt(b) || 0, unit: S.unit, memo: $('#memo', b).value.trim(), mint: $('#om', b).checked ? S.active : '', lock: $('#lk', b).checked });
        showRequest(r, back);
      };
    }, { back });
  }
  function showRequest(r, back) {
    if (!r) return;
    const paid = (r.payments || []).map((id) => S.history.find((h) => h.id === id)).filter(Boolean);
    sheet('Payment request', `<div id="rq"></div>
      <p class="big">${r.amount ? esc(fmt(r.amount, r.unit)) : '<small>any amount</small>'}</p>
      ${r.memo ? `<p class="center">${esc(r.memo)}</p>` : ''}
      <pre class="armor sm">${esc(r.encoded)}</pre>
      <button class="btn primary wide" id="cp">Copy request</button>
      ${kv([['Mint', r.mint ? esc(host(r.mint)) : 'Any'], ['Locked', r.lock ? 'Yes, P2PK' : 'No'], ['Payments', String(paid.length)]])}
      ${paid.map((h) => `<p class="small">${h.status === 'done' ? '✓' : '•'} ${esc(fmt(h.amount, h.unit))} · ${new Date(h.ts).toLocaleString()}${h.status === 'pending' ? ' · <span class="warnt">not claimed</span>' : ''}</p>`).join('')}
      <p class="dim small center">${S.pr.enabled ? 'Listening for payments while the app is open.' : 'Payment requests are off; turn them on to receive.'}</p>
      <button class="btn wide danger" id="rdel">Delete request</button>
      <p class="dim small center">Deleting stops this request from being recognised. Payments already received stay in your history.</p>`, (b) => {
      qrInto($('#rq', b), r.encoded);
      $('#cp', b).onclick = () => copy(r.encoded, 'Request copied');
      $('#rdel', b).onclick = () => {
        const btn = $('#rdel', b);
        if (!btn.dataset.sure) { btn.dataset.sure = '1'; btn.textContent = 'Tap again to delete'; return; }
        N.deleteRequest(r.id); toast('Request deleted'); (back || closeSheet)();
      };
    }, { back });
  }

  /* ---------- settings: NWC ---------- */
  function nwc() {
    const c = S.nwc.conn;
    sheet('Nostr Wallet Connect', `<p class="dim">Let other apps pay invoices from your wallet. Payments come from your active mint, in sats, up to the allowance. Works while this app is open.</p>
      ${toggle('t_nwc', 'Enable NWC', '', S.nwc.enabled)}
      ${S.nwc.enabled && c ? `<div id="nq"></div>
        <pre class="armor sm">${esc(N.nwcString())}</pre>
        <div class="btnrow"><button class="btn primary" id="cp">Copy connection</button><button class="btn" id="sq">QR code</button></div>
        ${kv([['Allowance left', `<b>${esc(fmt(c.allowanceLeft, 'sat'))}</b>`], ['Allowance', esc(fmt(c.allowance, 'sat'))]])}
        <form class="addm" id="al"><input id="av" class="field" inputmode="numeric" placeholder="New allowance in sats"><button class="btn">Set</button></form>
        <button class="btn wide danger" id="rv">Revoke and create new connection</button>` : ''}`, (b) => {
      $('#t_nwc', b).onchange = (e) => { S.nwc.enabled = e.target.checked; if (S.nwc.enabled && !S.nwc.conn) N.nwcNewConnection(); save(); N.startAll(); nwc(); };
      if (!(S.nwc.enabled && c)) return;
      $('#cp', b).onclick = () => copy(N.nwcString(), 'Connection copied. Treat it like a password.');
      $('#sq', b).onclick = () => qrInto($('#nq', b), N.nwcString());
      $('#al', b).onsubmit = (e) => { e.preventDefault(); const v = parseInt($('#av', b).value, 10); if (v >= 0) { c.allowance = v; c.allowanceLeft = v; save(); nwc(); } };
      $('#rv', b).onclick = () => { N.nwcNewConnection(c.allowance); N.startAll(); toast('New connection created. The old one stops working.'); nwc(); };
    }, { back: x.settingsSheet });
  }

  /* ---------- mint discovery ---------- */
  function discover(back) {
    sheet('Discover mints', `<p class="dim">Mints announced and reviewed on nostr (NIP-87). Reviews aren’t verified: read them critically.${S.nostr.wot ? ' Reviews from your web of trust are counted separately.' : ''}</p>
      <div id="dl"><p class="dim">Searching relays<span class="cur">_</span></p></div>`, async (b) => {
      try {
        const list = (await N.discoverMints()).slice(0, 60);
        const el = $('#dl', b); if (!el) return;
        if (!list.length) { el.innerHTML = '<p class="dim">No mints found on your relays.</p>'; return; }
        el.innerHTML = `<ul class="mints">${list.map((m) => `<li class="mint"><button class="pick dsc" data-u="${esc(m.url)}"><span class="mk">${mintOf(m.url) ? '✓' : '+'}</span>
          <span class="mt"><b>${esc(m.info?.name || host(m.url))}</b><small>${m.avg ? `${stars(Math.round(m.avg))} ${m.avg.toFixed(1)} · ` : ''}${`Reviews: ${m.count}`}${m.wotCount ? ` · ${`Trusted: ${m.wotCount}`}` : ''}</small></span></button></li>`).join('')}</ul>`;
        $$('.dsc', el).forEach((x2) => (x2.onclick = () => reviews(x2.dataset.u, () => discover(back), true)));
      } catch (e) { const el = $('#dl', b); if (el) el.innerHTML = `<p class="warn">${esc(niceErr(e))}</p>`; }
    }, { back });
  }
  function reviews(url, back, canAdd) {
    const known = !!mintOf(url);
    sheet('Mint reviews', `<p><b>${esc(host(url))}</b></p>
      ${canAdd && !known ? '<button class="btn primary wide" id="ad">Add this mint</button>' : ''}
      <button class="btn wide" id="wr">Write a review</button>
      <div id="rv"><p class="dim">Loading reviews<span class="cur">_</span></p></div>`, async (b) => {
      const ad = $('#ad', b);
      if (ad) ad.onclick = withBusy(ad, async () => { await C.addMint(url); N.backupMints().catch(() => {}); render(); toast('Mint added'); reviews(url, back, false); });
      $('#wr', b).onclick = () => writeReview(url, () => reviews(url, back, canAdd));
      try {
        const rs = await N.mintReviews(url);
        const el = $('#rv', b); if (!el) return;
        el.innerHTML = rs.length ? `<ul class="revs">${rs.map((r) => `<li><div class="rh"><span class="stars">${stars(r.rating)}</span>${r.trusted ? '<em class="pill">web of trust</em>' : ''}<small>${new Date(r.at * 1000).toLocaleDateString()}</small></div>${r.comment ? `<p>${esc(r.comment)}</p>` : ''}<small class="dim">${esc(short(N.npubOf(r.pubkey), 10))}</small></li>`).join('')}</ul>` : '<p class="dim">No reviews yet.</p>';
      } catch (e) { const el = $('#rv', b); if (el) el.innerHTML = `<p class="warn">${esc(niceErr(e))}</p>`; }
    }, { back });
  }
  function writeReview(url, back) {
    let rating = 0;
    sheet('Write a review', `<p class="dim">Published publicly on nostr with your nostr identity.</p>
      <div class="rate">${[1, 2, 3, 4, 5].map((i) => `<button data-r="${i}" aria-label="${i} stars">☆</button>`).join('')}</div>
      <textarea id="tx" rows="4" placeholder="What was your experience with this mint?"></textarea>
      <button class="btn primary wide" id="go" disabled>Publish review</button>`, (b) => {
      const btns = $$('.rate button', b);
      btns.forEach((x2) => (x2.onclick = () => { rating = +x2.dataset.r; btns.forEach((y) => (y.textContent = +y.dataset.r <= rating ? '★' : '☆')); $('#go', b).disabled = false; }));
      const go = $('#go', b);
      go.onclick = withBusy(go, async () => { await N.publishReview(url, rating, $('#tx', b).value); toast('Review published'); back(); });
    }, { back });
  }

  /* ---------- restore: mints from nostr backup ---------- */
  async function findMints(mnemonic, back) {
    sheet('Find my mints', `<div id="fm"><p class="dim">Looking for your mint list on nostr<span class="cur">_</span></p></div>`, async (b) => {
      try {
        const urls = (await N.findBackedUpMints(mnemonic)).filter((u) => !mintOf(u));
        const el = $('#fm', b); if (!el) return;
        if (!urls.length) { el.innerHTML = '<p class="dim">No new mints found in a nostr backup.</p><button class="btn wide" id="bk">Back</button>'; $('#bk', b).onclick = back; return; }
        el.innerHTML = `<p>${`Mints found: ${urls.length}`}</p><p>Choose which to add.</p>
          ${urls.map((u) => `<label class="chk"><input type="checkbox" value="${esc(u)}" checked> ${esc(host(u))}</label>`).join('')}
          <button class="btn primary wide" id="add">Add selected</button>`;
        const add = $('#add', b);
        add.onclick = withBusy(add, async () => {
          for (const c of $$('input[type=checkbox]', b)) if (c.checked) { try { await C.addMint(c.value); } catch (e) { toast(`${host(c.value)}: ${niceErr(e)}`, 'err'); } }
          render(); back();
        });
      } catch (e) { const el = $('#fm', b); if (el) el.innerHTML = `<p class="warn">${esc(niceErr(e))}</p>`; }
    }, { back, locked: x.isLocked() });
  }

  return {
    menu: [
      ['lnaddr', 'Lightning address', 'Receive to an address with npub.cash'],
      ['nostr', 'Nostr', 'Keys, relays, backup and web of trust'],
      ['pr', 'Payment requests', 'Receive ecash payments via nostr'],
      ['nwc', 'Nostr Wallet Connect', 'Use your wallet from other apps'],
    ],
    sections: { lnaddr, nostr, pr: prSettings, nwc },
    discover, reviews, writeReview, newRequest, showRequest, findMints,
  };
}
