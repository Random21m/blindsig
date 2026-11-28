// Lightweight UI translation: English text in the DOM is swapped for the chosen
// language as it appears. Dictionaries live in i18n/<code>.json (English -> translation);
// keys with {0}, {1} are templates.
export const LANGS = [
  ['en', 'English'], ['es', 'Español'], ['pt', 'Português (Brasil)'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['sv', 'Svenska'], ['cs', 'Čeština'], ['el', 'Ελληνικά'], ['tr', 'Türkçe'],
  ['ar', 'العربية'], ['th', 'ไทย'], ['ja', '日本語'], ['zh', '中文 (简体)'],
];
let dict = {}, pats = [];
export let lang = 'en';
const orig = new WeakMap();
const ATTRS = ['placeholder', 'aria-label'];
const SKIP = 'script,style,textarea,code,pre,.armor,.seed,[data-notr],#bal,#balPre';

export function detect() {
  const n = (navigator.language || 'en').toLowerCase();
  const hit = LANGS.find(([c]) => n === c || n.startsWith(c + '-'));
  return hit ? hit[0] : 'en';
}
export async function setLang(code) {
  lang = LANGS.some(([c]) => c === code) ? code : 'en';
  dict = {}; pats = [];
  if (lang !== 'en') {
    try { dict = await (await fetch(`i18n/${lang}.json`)).json(); } catch { dict = {}; }
    pats = Object.keys(dict).filter((k) => k.includes('{0}')).sort((a, b) => b.length - a.length).map((k) => {
      const parts = k.split(/\{(\d)\}/);
      let re = '^', order = [];
      parts.forEach((p, i) => { if (i % 2) { re += '(.+?)'; order.push(+p); } else re += p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
      return [new RegExp(re + '$', 's'), dict[k], order, k.includes('·')];
    });
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  translateTree(document.body);
}
// dates and times in the app's language (the phone's own format when that's the same language)
export const dateLocale = () => ((navigator.language || 'en').toLowerCase().startsWith(lang) ? undefined : lang);
export function t(s) {
  if (lang === 'en' || !s) return s;
  const k = s.trim();
  if (!k) return s;
  let out = dict[k];
  if (out == null) {
    // keep numbers and units in their own direction inside right-to-left sentences
    const rtl = document.documentElement.dir === 'rtl';
    for (const [re, tpl, order, dot] of pats) {
      const m = k.match(re);
      if (m && !dot && m.slice(1).some((v) => v.includes('·'))) continue;
      if (m) { out = tpl.replace(/\{(\d)\}/g, (_, i) => { const j = order.indexOf(+i); const v = j >= 0 ? m[j + 1] : ''; return rtl ? '\u2068' + t(v) + '\u2069' : t(v); }); break; }
    }
  }
  if (out == null && k.includes(' · ')) {
    const parts = k.split(' · ').map((p) => t(p));
    if (parts.join(' · ') !== k) out = parts.join(' · ');
  }
  if (out == null) return s;
  const lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
  return lead + out + tail;
}
function doText(n) {
  const rec = orig.get(n), cur = n.nodeValue;
  const src = rec && cur === rec.out ? rec.src : cur;
  const out = t(src);
  if (out !== cur) n.nodeValue = out;
  orig.set(n, { src, out });
}
function doAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const key = 'data-i18n-' + a, cur = el.getAttribute(a);
    const src = el.getAttribute(key + '-out') === cur ? el.getAttribute(key) : cur;
    const out = t(src);
    el.setAttribute(key, src); el.setAttribute(key + '-out', out);
    if (out !== cur) el.setAttribute(a, out);
  }
}
export function translateTree(root) {
  if (!root) return;
  if (root.nodeType === 3) { if (!root.parentElement?.closest(SKIP)) doText(root); return; }
  if (root.nodeType !== 1) return;
  if (root.matches('[placeholder],[aria-label]')) doAttrs(root);
  root.querySelectorAll('[placeholder],[aria-label]').forEach(doAttrs);
  if (root.closest(SKIP)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = w.nextNode())) if (n.nodeType === 3 && n.nodeValue.trim()) doText(n);
}
let busy = false;
const mo = new MutationObserver((list) => {
  if (lang === 'en' || busy) return;
  busy = true;
  try {
    for (const m of list) {
      if (m.type === 'characterData') translateTree(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else m.addedNodes.forEach((n) => translateTree(n));
    }
  } finally { busy = false; }
});
export function startObserver() {
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
