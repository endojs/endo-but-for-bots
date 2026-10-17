import json, sys, collections, re
d = json.load(open(sys.argv[1]))
cases = d['cases']
cats = ['covered','ironhorse-failure','unsupported','refused','skipped','infrastructure']
def area(p, depth):
    parts = p.split('/')
    return '/'.join(parts[:depth])
def table(groupfn, title, top=None, min_total=0):
    g = collections.defaultdict(collections.Counter)
    for c in cases:
        g[groupfn(c)][c['category']] += 1
    rows = sorted(g.items(), key=lambda kv: -sum(kv[1].values()))
    print(f'\n### {title}\n')
    print('| group | total | covered | % covered | fail | unsupported | refused | skipped | infra |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for k, cnt in rows[:top] if top else rows:
        t = sum(cnt.values())
        if t < min_total: continue
        print(f"| {k} | {t} | {cnt['covered']} | {100*cnt['covered']/t:.1f} | {cnt['ironhorse-failure']} | {cnt['unsupported']} | {cnt['refused']} | {cnt['skipped']} | {cnt['infrastructure']} |")
tot = collections.Counter(c['category'] for c in cases)
print('## Totals'); print(dict(tot), 'total', len(cases))
print('outcomes', dict(collections.Counter(c['outcome'] for c in cases)))
print('strict_skipped', sum(c['strict_skipped'] for c in cases), 'computron_gap', sum(c['computron_gap'] for c in cases))
table(lambda c: area(c['path'],1), 'By top-level tree')
table(lambda c: area(c['path'],2), 'By second-level area', min_total=1)
def reason_class(r):
    r = r or ''
    r = re.sub(r'"[^"]*"', '"…"', r)
    return r.split(':')[0] if ':' in r else r
for cat in ['ironhorse-failure','unsupported','refused','skipped','infrastructure']:
    print(f'\n### Reason prefixes for {cat}\n')
    cnt = collections.Counter(reason_class(c['reason']) for c in cases if c['category']==cat)
    for k,v in cnt.most_common(30): print(f'| {k} | {v} |')
    print(f'\n### Top full reasons for {cat}\n')
    cnt = collections.Counter((c['reason'] or '')[:140] for c in cases if c['category']==cat)
    for k,v in cnt.most_common(40): print(f'| {v} | {k} |')
print('\n### Failures by third-level area (top 40)\n')
cnt = collections.Counter(area(c['path'],3) for c in cases if c['category']=='ironhorse-failure')
for k,v in cnt.most_common(40): print(f'| {k} | {v} |')
print('\n### Non-covered by feature (features of non-covered cases, top 50)\n')
fc = collections.Counter(); ft = collections.Counter()
for c in cases:
    for f in c['features']:
        ft[f]+=1
        if c['category']!='covered': fc[f]+=1
for k,v in fc.most_common(50): print(f'| {k} | {v} of {ft[k]} | {100*(ft[k]-v)/ft[k]:.1f}% covered |')
