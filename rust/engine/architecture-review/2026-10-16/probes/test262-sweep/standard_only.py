import json, sys, collections, re, importlib.util
spec = importlib.util.spec_from_file_location('ih', sys.argv[3]); 
src = open(sys.argv[3]).read().split('\ndef V')[0]  # reuse verdict() only
ns = {}; exec(compile(open(sys.argv[3]).read().split("V = ['pass'")[0].replace("d = json.load(open(sys.argv[1]))", ""), 'ih', 'exec'), ns)
verdict = ns['verdict']
lines = open(sys.argv[2]).read().splitlines()
proposal = set()
for ln in lines:
    if ln.startswith('## Standard language features'): break
    t = ln.split('#')[0].strip()
    if t: proposal.add(t)
print('proposal features:', sorted(proposal))
d = json.load(open(sys.argv[1]))
g = collections.defaultdict(collections.Counter)
for c in d['cases']:
    std = not any(f in proposal for f in c['features'])
    tree = c['path'].split('/')[0]
    g[('standard' if std else 'proposal', tree)][verdict(c)] += 1
    g[('standard' if std else 'proposal', 'ALL')][verdict(c)] += 1
    if std and not c['path'].startswith('intl402') and 'Temporal' not in c['features'] and not c['path'].startswith('annexB'):
        g[('standard', 'ECMA-262 core (no intl402, no annexB, no Temporal)')][verdict(c)] += 1
print('| subset | tree | cases | pass | fail | unsupported | not run | pass % |')
print('|---|---|---:|---:|---:|---:|---:|---:|')
for k in sorted(g):
    c = g[k]; t = sum(c.values())
    print(f"| {k[0]} | {k[1]} | {t} | {c['pass']} | {c['fail']} | {c['unsupported']} | {c['not-run']} | {100*c['pass']/t:.1f} |")
