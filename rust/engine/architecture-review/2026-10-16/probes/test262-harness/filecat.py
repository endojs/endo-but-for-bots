#!/usr/bin/env python3
"""Fold shard rows per file the way xst.rs::run_case folds modes (fail wins,
then sloppy's non-covered verdict, then strict's), and classify with the
stats.py replica of report.rs::classify. usage: python3 -I filecat.py <whole-tree>"""
import os, re, sys, json, collections
sys.argv = [sys.argv[0], sys.argv[1], '/dev/null']
d = sys.argv[1]
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stats.py')).read()
ns = {}
body = src.split('# --- aggregate')[0].split('# --- categorization')[1]; exec(body.split('\n', 1)[1], ns)
rows = collections.defaultdict(dict)
for n in sorted(os.listdir(d)):
    if n == 'manifest.txt': continue
    for line in open(os.path.join(d, n), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, tok = re.split(r'\s', line.strip(), maxsplit=2)
        if tok == 'pass': k, r = 'pass', ''
        elif tok.startswith('fail'): k, r = 'fail', json.loads(tok[5:]) if tok.startswith('fail:') else ''
        else: k, r = 'skip', tok[5:]
        rows[p][m] = (k, r)
c = collections.Counter()
for p, ms in rows.items():
    order = [ms[m] for m in ('sloppy', 'strict') if m in ms]
    fails = [x for x in order if x[0] == 'fail']
    if fails: k, r = fails[0]
    else:
        non = [x for x in order if x[0] != 'pass']
        k, r = non[0] if non else ('pass', '')
    c[ns['classify'](k, r)] += 1
T = sum(c.values())
for k, v in c.most_common(): print(f'{k:18} {v:6}  {100*v/T:.1f}%')
print('files', T)
