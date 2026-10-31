import json,re,sys
d=json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report-oracle-off/report.json'))
d2=json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report/report.json'))
m2={c['path']:c for c in d2['cases']}
def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit' or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')): return 'unsupported'
    return 'fail'
for c in d['cases']:
    p=c['path']
    if re.search(r'ArrayIteratorPrototype|StringIteratorPrototype|symbol-tag-(array|string)-builtin',p):
        o=m2.get(p,{})
        print(verdict(c),'|',p,'|',(c['reason'] or '')[:90],'| on:',o.get('category'),(o.get('reason') or '')[:40])
