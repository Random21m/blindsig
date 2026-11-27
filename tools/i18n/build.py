import json, re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'public', 'i18n')
en = json.load(open(os.path.join(HERE, 'en.json')))
os.makedirs(OUT, exist_ok=True)
for f in sorted(os.listdir(os.path.join(HERE, 'tr'))):
    code = f.split('.')[0]; d = {}; probs = []
    for ln in open(os.path.join(HERE, 'tr', f), encoding='utf-8'):
        ln = ln.rstrip('\n')
        if not ln.strip(): continue
        i, _, txt = ln.partition('\t'); i = int(i)
        src = en[i]
        if set(re.findall(r'\{\d\}', src)) != set(re.findall(r'\{\d\}', txt)): probs.append((i, src, txt))
        if src.startswith(('✓', '·')) and not txt.startswith(src[0]): probs.append((i, 'prefix', txt))
        d[src] = txt
    missing = [i for i, k in enumerate(en) if i and k not in d]
    json.dump(d, open(os.path.join(OUT, f'{code}.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print(code, len(d), 'missing', missing[:10], 'problems', probs[:5])
