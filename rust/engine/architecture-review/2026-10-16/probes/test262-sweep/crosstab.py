import json, sys, collections, re
a = {c['path']: c for c in json.load(open(sys.argv[1]))['cases']}
b = {c['path']: c for c in json.load(open(sys.argv[2]))['cases']}
x = collections.Counter((a[p]['category'], b[p]['category']) for p in a)
print('| oracle-on \\ oracle-off | ' + ' | '.join(sorted({k[1] for k in x})) + ' |')
cols = sorted({k[1] for k in x})
for r in sorted({k[0] for k in x}):
    print(f'| {r} | ' + ' | '.join(str(x[(r,c)]) for c in cols) + ' |')
def norm(r):
    return re.sub(r'"[^"]*"', '"…"', r or '')[:110]
print('\n## oracle-off reasons by category (top)')
for cat in ['ironhorse-failure','unsupported','skipped','infrastructure','refused']:
    cnt = collections.Counter(norm(c['reason']) for c in b.values() if c['category']==cat)
    print(f'\n### {cat}')
    for k,v in cnt.most_common(25): print(f'| {v} | {k} |')
print('\n## oracle-off by top/second area for Temporal and intl402')
g = collections.defaultdict(collections.Counter)
for c in b.values():
    parts = c['path'].split('/')
    key = '/'.join(parts[:2])
    if 'Temporal' in key or key.startswith('intl402') or key.startswith('annexB') or 'module' in key or 'import' in key:
        g[key][c['category']] += 1
for k, v in sorted(g.items(), key=lambda kv: -sum(kv[1].values()))[:25]:
    print(f'| {k} | {dict(v)} |')
