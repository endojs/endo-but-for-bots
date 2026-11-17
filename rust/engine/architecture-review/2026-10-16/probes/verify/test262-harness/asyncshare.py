import os, sys, json, re, collections
d, root = sys.argv[1], sys.argv[2]
FM = re.compile(r'/\*---(.*?)---\*/', re.S)
cache = {}
def flags(p):
    if p not in cache:
        s = open(os.path.join(root, p), encoding='utf-8').read()
        m = FM.search(s); fm = m.group(1) if m else ''
        mm = re.search(r'^flags:\s*\[(.*?)\]', fm, re.M)
        cache[p] = set(x.strip() for x in mm.group(1).split(',')) if mm else set()
    return cache[p]
c = collections.Counter()
for f in sorted(os.listdir(d)):
    if f == 'manifest.txt': continue
    for line in open(os.path.join(d, f), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, t = line.rstrip('\n').split(' ', 2)
        key = None
        if 'oracle-host-missing-temporal' in t: key = 'mt'
        elif 'oracle-host-missing-intl' in t: key = 'mi'
        elif 'over-acceptance' in t: key = 'oa'
        elif 'oracle-host-missing-global' in t: key = 'mg'
        if key:
            c[(key, 'async' in flags(p), 'module' in flags(p))] += 1
for k, v in sorted(c.items()): print(k, v)
