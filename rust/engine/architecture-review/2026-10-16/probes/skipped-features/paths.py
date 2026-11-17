import json, sys, collections, re
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
for pat in sys.argv[2:]:
    rx = re.compile(pat)
    v = collections.Counter(); rs = collections.Counter()
    for c in d['cases']:
        if rx.search(c['path']) or ('feat:' in pat and pat[5:] in c['features']):
            vv = verdict(c); v[vv] += 1
            if vv != 'pass': rs[re.sub(r'\s+',' ',(c['reason'] or ''))[:90]] += 1
    t = sum(v.values())
    print(f"{pat}: total={t} pass={v['pass']} fail={v['fail']} unsup={v['unsupported']} notrun={v['not-run']}")
    for k, n in rs.most_common(3): print('     ', n, k)
