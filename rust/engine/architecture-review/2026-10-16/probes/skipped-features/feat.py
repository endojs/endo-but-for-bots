import json, sys, collections
d = json.load(open(sys.argv[1]))
def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit'
            or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')):
        return 'unsupported'
    return 'fail'
ft = collections.defaultdict(collections.Counter)
for c in d['cases']:
    for f in c['features']:
        ft[f][verdict(c)] += 1
rows = sorted(ft.items(), key=lambda kv: kv[1]['pass']/sum(kv[1].values()))
print('| feature | cases | pass | fail | unsup | notrun | pass% |')
for k, v in rows:
    t = sum(v.values())
    if v['pass']/t < 0.9:
        print(f"| {k} | {t} | {v['pass']} | {v['fail']} | {v['unsupported']} | {v['not-run']} | {100*v['pass']/t:.1f} |")
