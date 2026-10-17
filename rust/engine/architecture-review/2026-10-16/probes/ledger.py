import json, os, sys, collections
V = sys.argv[1]
RANK = {'critical': 4, 'high': 3, 'medium': 2, 'low': 1, 'none': 0}
rows = []
for f in sorted(os.listdir(V)):
    if not f.endswith('.json') or f.endswith('.pass2.json'): continue
    m = f[:-5]
    d = json.load(open(os.path.join(V, f)))
    p2 = {}
    p2f = os.path.join(V, m + '.pass2.json')
    if os.path.exists(p2f):
        for v in json.load(open(p2f)).get('verdicts', []): p2[v['id']] = v
    for x in d['findings']:
        sev = x['final_severity']
        note = ''
        if x['id'] in p2:
            v = p2[x['id']]
            if v['refuted']:
                sev = 'none'; note = 'refuted in pass 2'
            elif RANK[v['severity']] < RANK[sev]:
                note = f"pass 2 lowered {sev}->{v['severity']}"; sev = v['severity']
            else:
                note = 'pass 2 upheld'
        rows.append(dict(map=m, id=x['id'], verdict=x['verdict'], orig=x['original_severity'], final=sev, note=note, title=x['title']))
json.dump(rows, open(os.path.join(V, '..', 'ledger.json'), 'w'), indent=1)
c = collections.Counter(r['final'] for r in rows)
print('findings', len(rows), dict(c))
print(collections.Counter(r['verdict'] for r in rows))
for r in sorted(rows, key=lambda r: (-RANK[r['final']], r['map'], r['id'])):
    print(f"{r['final']:8} {r['id']:8} {r['verdict'][:22]:22} {r['note'][:26]:26} {r['title'][:120]}")
