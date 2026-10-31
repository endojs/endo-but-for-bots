import json, collections, sys
d = json.load(open(sys.argv[1]))
c = collections.Counter()
ex = {}
for k in d['cases']:
    r = k['reason']
    if r in ('module:compiler-rejected', 'module:compiler-byte-divergence', 'module:resolution-linking'):
        parts = k['path'].split('/')
        key = (r, '/'.join(parts[:3]))
        c[key] += 1
        ex.setdefault(key, k['path'])
for key, n in sorted(c.items(), key=lambda x: -x[1]):
    print(n, key, ex[key])
