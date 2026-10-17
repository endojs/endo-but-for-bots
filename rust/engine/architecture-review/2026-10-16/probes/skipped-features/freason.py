import json, sys, collections, re
sys.path.insert(0, '.')
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
for f in sys.argv[2].split(','):
    cnt = collections.Counter()
    ex = {}
    for c in d['cases']:
        if f in c['features'] and verdict(c) != 'pass':
            r = re.sub(r'\s+', ' ', (c['reason'] or ''))[:160]
            cnt[r] += 1; ex.setdefault(r, c['path'])
    print('==', f)
    for k, v in cnt.most_common(4): print('  ', v, k, '|', ex[k])
