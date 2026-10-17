import json, collections, sys
d = json.load(open(sys.argv[1]))
c = collections.Counter(); ex = {}
for k in d['cases']:
    r = k['reason']
    if r.startswith('strict:'): r = r[7:]
    if r == sys.argv[2]:
        parts = k['path'].split('/')
        key = '/'.join(parts[:3])
        c[key] += 1; ex.setdefault(key, []).append(k['path'])
for key, n in sorted(c.items(), key=lambda x: -x[1])[:25]:
    print(n, key, ex[key][0])
