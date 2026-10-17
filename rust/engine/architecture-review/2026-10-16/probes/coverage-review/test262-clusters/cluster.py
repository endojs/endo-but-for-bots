import json, sys, collections, re
sys.path.insert(0, '../../../probes/test262-sweep')
d = json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report-oracle-off/report.json'))
def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit'
            or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')):
        return 'unsupported'
    return 'fail'
def norm(r):
    r = re.sub(r'"[^"]*"', '"…"', r or '')
    r = re.sub(r'«[^»]*»', '«…»', r)
    return r[:140]
np = [c for c in d['cases'] if verdict(c) in ('fail','unsupported')]
json.dump([dict(c, v=verdict(c)) for c in np], open('nonpass.json','w'))
g = collections.Counter(('/'.join(c['path'].split('/')[:3]), verdict(c), norm(c['reason'])) for c in np)
mode = sys.argv[1] if len(sys.argv)>1 else 'clusters'
if mode=='clusters':
    for (a,v,r),n in sorted(g.items(), key=lambda kv:-kv[1]):
        if n>=10: print(f'{n}\t{a}\t{v}\t{r}')
elif mode=='areas':
    ga = collections.Counter('/'.join(c['path'].split('/')[:3]) for c in np)
    for a,n in ga.most_common():
        if n>=10: print(n,a)
