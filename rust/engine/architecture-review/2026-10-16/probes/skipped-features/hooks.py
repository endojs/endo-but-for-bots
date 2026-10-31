import json, sys, collections, re, os
d = json.load(open(sys.argv[1]))
root = sys.argv[2]
def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit'
            or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')):
        return 'unsupported'
    return 'fail'
hooks = ['$262.evalScript', '$262.createRealm', '$262.agent', '$262.IsHTMLDDA', '$262.AbstractModuleSource', '$262.gc', '$262.global', 'host-gc-required']
res = {h: collections.Counter() for h in hooks}
for c in d['cases']:
    p = os.path.join(root, 'test', c['path'])
    try: txt = open(p, encoding='utf-8', errors='replace').read()
    except Exception: continue
    for h in hooks:
        if h in txt or (h == 'host-gc-required' and h in c['features']):
            res[h][verdict(c)] += 1
for h, v in res.items(): print(h, sum(v.values()), dict(v))
