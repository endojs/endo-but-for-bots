"""IronHorse's own test262 verdict, derived from the oracle-off endot-ih sweep.

Mapping (validated against a plain-host ironhorse-xst run of built-ins/Temporal:
2,023/2,023 ironhorse-only-complete cases pass there and 2,378/2,378
oracle-host-missing-global cases fail there):
  pass         covered; any reason containing 'ironhorse-only-complete';
               'oracle-nontermination' (ironhorse terminated alone; 3 cases)
  not-run      pre-skip outcomes; structural:* skips; feature:* skips
  unsupported  the engine declined: unsupported-opcode:*, compiler-unimplemented:*,
               ironhorse-aborted-limit, refused:*, module:resolution-linking,
               module:compiler-rejected
  fail         everything else (ironhorse threw / mis-signalled / over-accepted a
               negative / both engines failed)
"""
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
V = ['pass','fail','unsupported','not-run']
def tab(keyfn, title, min_total=1, limit=None):
    g = collections.defaultdict(collections.Counter)
    for c in d['cases']: g[keyfn(c)][verdict(c)] += 1
    print(f'\n### {title}\n')
    print('| area | cases | pass | fail | unsupported | not run | pass % of all | pass % of run |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|')
    rows = sorted(g.items(), key=lambda kv: -sum(kv[1].values()))
    for k, cnt in (rows[:limit] if limit else rows):
        t = sum(cnt.values())
        if t < min_total: continue
        run = t - cnt['not-run']
        print(f"| {k} | {t} | {cnt['pass']} | {cnt['fail']} | {cnt['unsupported']} | {cnt['not-run']} | {100*cnt['pass']/t:.1f} | {100*cnt['pass']/max(1,run):.1f} |")
tot = collections.Counter(verdict(c) for c in d['cases'])
print('## IronHorse-alone totals'); print(dict(tot), 'of', len(d['cases']))
tab(lambda c: 'all', 'Whole corpus')
tab(lambda c: c['path'].split('/')[0], 'By top-level tree')
tab(lambda c: '/'.join(c['path'].split('/')[:2]), 'By second-level area (25+ cases)', min_total=25)
print('\n### Fail reasons (IronHorse alone), top 30\n')
import re
cnt = collections.Counter(re.sub(r'"[^"]*"', '"…"', c['reason'] or '')[:120] for c in d['cases'] if verdict(c)=='fail')
for k,v in cnt.most_common(30): print(f'| {v} | {k} |')
print('\n### Unsupported reasons, all\n')
cnt = collections.Counter(c['reason'] for c in d['cases'] if verdict(c)=='unsupported')
for k,v in cnt.most_common(): print(f'| {v} | {k} |')
print('\n### Not-run reasons, all\n')
cnt = collections.Counter(c['reason'] for c in d['cases'] if verdict(c)=='not-run')
for k,v in cnt.most_common(): print(f'| {v} | {k} |')
print('\n### Features with the most non-passing cases (top 40)\n')
fc = collections.Counter(); ft = collections.Counter()
for c in d['cases']:
    for f in c['features']:
        ft[f] += 1
        if verdict(c) != 'pass': fc[f] += 1
print('| feature | not passing | cases | pass % |'); print('|---|---:|---:|---:|')
for k,v in fc.most_common(40): print(f'| {k} | {v} | {ft[k]} | {100*(ft[k]-v)/ft[k]:.1f} |')
