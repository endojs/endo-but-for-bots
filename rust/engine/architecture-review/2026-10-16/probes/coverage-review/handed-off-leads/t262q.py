# usage: python3 -I t262q.py (--path REGEX | --feature NAME) [-v]
# IronHorse's own verdict (ih_alone.verdict, copied verbatim) per case from the
# oracle-off report, with the oracle-on category, for matching cases.
import json, re, sys, collections
OFF = '/home/user/endo-but-for-bots/rust/engine/target/test262-report-oracle-off/report.json'
ON = '/home/user/endo-but-for-bots/rust/engine/target/test262-report/report.json'
def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit'
            or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')):
        return 'unsupported'
    return 'fail'
args = sys.argv[1:]
verbose = '-v' in args
mode, val = args[0], args[1]
off = json.load(open(OFF))['cases']
on = {c['path']: c for c in json.load(open(ON))['cases']}
pat = re.compile(val)
tot = collections.Counter(); oncat = collections.Counter()
for c in off:
    if mode == '--feature':
        if val not in c['features']: continue
    elif not pat.search(c['path']): continue
    v = verdict(c); tot[v] += 1
    o = on.get(c['path'], {}); oncat[o.get('category')] += 1
    if verbose: print(v, '|', c['path'], '|', (c['reason'] or '')[:140], '| on:', o.get('category'), (o.get('reason') or '')[:60])
print(mode, val, 'ih-alone:', dict(tot), 'total', sum(tot.values()), '| oracle-on categories:', dict(oncat))
