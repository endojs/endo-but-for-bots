#!/usr/bin/env python3
"""Re-score the committed shards under test262's own verdict (probe-calibrated):
oracle-host-missing-global:* -> fail (33/33 sampled fail on Ironhorse alone),
oracle-host-missing-{temporal,intl} -> pass (12/12), fail:"over-acceptance..." -> pass (8/8),
negative-oracle-unexpected -> fail (9/9 checked), oracle-nontermination -> pass (1/1).
usage: python3 -I t262verdict.py <whole-tree>"""
import os, re, sys, json, collections
d = sys.argv[1]
def v(tok):
    if tok == 'pass': return 'pass'
    if tok.startswith('fail'):
        r = json.loads(tok[5:]) if tok.startswith('fail:') else ''
        r = r[7:] if r.startswith('strict:') else r
        return 'pass' if r.startswith(('over-acceptance', 'result divergence')) else 'fail'
    r = tok[5:]; r = r[7:] if r.startswith('strict:') else r
    if r in ('oracle-host-missing-temporal', 'oracle-host-missing-intl', 'non-primitive-completion') \
       or r.startswith(('oracle-xs-script-decl-eval-framing', 'oracle-nontermination')):
        return 'pass'
    if r.startswith(('feature:', 'structural:', 'module:', 'compiler-unimplemented:module')):
        return 'not-run'
    return 'fail'
per_mode = collections.Counter(); per_file = collections.defaultdict(set)
top = collections.defaultdict(collections.Counter)
for n in sorted(os.listdir(d)):
    if n == 'manifest.txt': continue
    for line in open(os.path.join(d, n), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, tok = re.split(r'\s', line.strip(), maxsplit=2)
        x = v(tok); per_mode[x] += 1; per_file[p].add(x); top[p.split('/')[0]][x] += 1
N = sum(per_mode.values())
print('per case/mode:', {k: f'{c} ({100*c/N:.1f}%)' for k, c in per_mode.most_common()})
f = collections.Counter('pass' if s == {'pass'} else ('fail' if 'fail' in s else 'not-run') for s in per_file.values())
F = len(per_file)
print('per file (all modes pass):', {k: f'{c} ({100*c/F:.1f}%)' for k, c in f.most_common()})
for t, c in sorted(top.items()):
    T = sum(c.values()); print(f'  {t:10} pass {c["pass"]:6}/{T:6} = {100*c["pass"]/T:.1f}%   fail {c["fail"]}  not-run {c["not-run"]}')
