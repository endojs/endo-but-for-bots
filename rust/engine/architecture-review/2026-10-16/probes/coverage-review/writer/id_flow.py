import os, re, json, sys, collections
S = sys.argv[1]
maps = {}
for f in sorted(os.listdir(os.path.join(S, 'maps'))):
    t = open(os.path.join(S, 'maps', f), encoding='utf-8').read()
    cand = t.split('## Candidate findings', 1)[1].split('\n## ', 1)[0] if '## Candidate findings' in t else ''
    ids = re.findall(r'^#{3,4}\s+([A-Z0-9]+-(?:NEW-)?\d+)', cand, re.M)
    maps[f[:-3]] = ids
    secs = re.findall(r'^## (.+)$', t, re.M)
    print(f'{f:30} findings {len(ids):3}  ontology-notes: {"yes" if any("Ontology" in s for s in secs) else "NO"}')
ledger = {r['id']: r for r in json.load(open(os.path.join(S, 'ledger.json')))}
mapped = {i for ids in maps.values() for i in ids}
print('\nmap IDs not in ledger:', sorted(mapped - set(ledger)))
print('ledger IDs not in any map heading:', sorted(set(ledger) - mapped))
lens = {}
for f in os.listdir(os.path.join(S, 'lenses')):
    if f.endswith('.md'):
        lens[f[:-3]] = open(os.path.join(S, 'lenses', f), encoding='utf-8').read()
summary = open(os.path.join(S, 'ARCHITECTURE-REVIEW.md'), encoding='utf-8').read()
missing_lens = [i for i in ledger if not any(re.search(r'\b' + re.escape(i) + r'\b', t) for t in lens.values())]
missing_summary_body = [i for i in ledger if not re.search(r'\b' + re.escape(i) + r'\b', summary.split('## Finding index')[0])]
print('ledger IDs in no lens:', missing_lens)
print('ledger IDs not discussed in summary body (index only):', len(missing_summary_body), sorted(missing_summary_body))
