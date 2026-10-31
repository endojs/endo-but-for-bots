import os, sys, json, collections
d = sys.argv[1]
rows = []
for f in sorted(os.listdir(d)):
    if f == 'manifest.txt': continue
    for line in open(os.path.join(d, f), encoding='utf-8'):
        line = line.rstrip('\n')
        if not line or line.startswith('#'): continue
        path, mode, tok = line.split(' ', 2)
        rows.append((path, mode, tok))
def fam(tok):
    if tok == 'pass': return 'pass'
    if tok.startswith('fail:'):
        r = json.loads(tok[5:])
    elif tok.startswith('skip:'):
        r = tok[5:]
        if r.startswith('"'): r = json.loads(r)
    else: r = tok
    if r.startswith('strict:'): r = r[7:]
    return tok.split(':')[0] + ':' + r
c = collections.Counter()
for p, m, t in rows:
    f = fam(t)
    key = f.split(':')[0] + ':' + ':'.join(f.split(':')[1:3])[:60]
    c[key] += 1
print('rows', len(rows), 'files', len({r[0] for r in rows}))
print('modes', collections.Counter(r[1] for r in rows))
for k, v in c.most_common(80): print(f'{v:7d} {k}')
