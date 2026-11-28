// BIP-353: payment instructions for ₿user@domain, published in DNS and signed with DNSSEC.
// We fetch the records over DNS-over-HTTPS with checking disabled at the resolver, then check the
// whole signature chain here, from the DNS root's published key down to the TXT record, so the
// resolver isn't trusted. Loaded on demand (built as its own file, see build.mjs).
import { Buffer } from 'buffer';
import { dnssecLookUp } from '@relaycorp/dnssec/build/lib/lib/lookup.js';
import { Question } from '@relaycorp/dnssec/build/lib/lib/utils/dns/Question.js';
import { SecurityStatus } from '@relaycorp/dnssec/build/lib/lib/SecurityStatus.js';
import * as packet from '@leichtgewicht/dns-packet';

globalThis.Buffer = globalThis.Buffer || Buffer;
export const DOH = 'https://cloudflare-dns.com/dns-query';

// one query in DNS wire format: recursion wanted, DNSSEC records wanted (DO), checking disabled (CD)
async function resolver(question) {
  const q = packet.encode({
    type: 'query', id: 0, flags: packet.RECURSION_DESIRED | packet.CHECKING_DISABLED,
    questions: [{ type: question.getTypeName(), name: question.name.replace(/\.$/, '') || '.', class: 'IN' }],
    additionals: [{ type: 'OPT', name: '.', udpPayloadSize: 4096, flags: packet.DNSSEC_OK }],
  });
  const r = await fetch(DOH, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: q, cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('DNS lookup failed (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}

const txtOf = (rec) => {
  const f = rec.dataFields;
  const parts = Array.isArray(f) ? f : [f];
  return parts.map((p) => (typeof p === 'string' ? p : new TextDecoder().decode(p))).join('');
};
export const parseName = (s) => {
  const m = String(s).trim().replace(/^₿/, '').match(/^([^@\s]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i);
  return m ? { user: m[1], domain: m[2].toLowerCase() } : null;
};
// returns the bitcoin: URI for the name, or throws with a reason
export async function resolve(input, { lookUp = dnssecLookUp, resolve: res = resolver, date, trustAnchors } = {}) {
  const n = parseName(input);
  if (!n) throw new Error('not a ₿name@domain');
  let name = `${n.user}.user._bitcoin-payment.${n.domain}.`;
  const opts = { ...(date ? { dateOrPeriod: date } : {}), ...(trustAnchors ? { trustAnchors } : {}) };
  for (let hop = 0; hop < 6; hop++) {
    const r = await lookUp(new Question(name, 'TXT'), res, opts);
    if (r.status === SecurityStatus.SECURE) {
      const uris = r.result.records.map(txtOf).filter((t) => /^bitcoin:/i.test(t));
      if (uris.length > 1) throw new Error('this name has more than one payment record, so it can’t be used');
      if (!uris.length) throw new Error('no payment instructions for this name');
      return uris[0];
    }
    // names may point elsewhere with a CNAME, which has to be signed too
    let c = null; try { c = await lookUp(new Question(name, 'CNAME'), res, opts); } catch {}
    if (c && c.status === SecurityStatus.SECURE && c.result.records.length === 1) { name = String(c.result.records[0].dataFields).replace(/\.?$/, '.'); continue; }
    if (r.status === SecurityStatus.INSECURE) throw new Error('this domain isn’t protected by DNSSEC');
    throw new Error(r.status === SecurityStatus.BOGUS ? 'the DNS signatures for this name don’t check out' : 'no payment instructions for this name');
  }
  throw new Error('too many redirects for this name');
}
