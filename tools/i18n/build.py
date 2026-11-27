import json, re, sys, os
en = json.load(open('/home/claude/i18ntool/en.json'))
os.makedirs('/home/claude/wallet/public/i18n', exist_ok=True)
for f in sorted(os.listdir('/home/claude/i18ntool/tr')):
    code = f.split('.')[0]; d = {}; probs = []
    for ln in open('/home/claude/i18ntool/tr/' + f, encoding='utf-8'):
        ln = ln.rstrip('\n')
        if not ln.strip(): continue
        i, _, txt = ln.partition('\t'); i = int(i)
        src = en[i]
        if set(re.findall(r'\{\d\}', src)) != set(re.findall(r'\{\d\}', txt)): probs.append((i, src, txt))
        if src.startswith(('✓', '·')) and not txt.startswith(src[0]): probs.append((i, 'prefix', txt))
        d[src] = txt
    missing = [i for i, k in enumerate(en) if i and k not in d]
    json.dump(d, open(f'/home/claude/wallet/public/i18n/{code}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    print(code, len(d), 'missing', missing[:10], 'problems', probs[:5])
