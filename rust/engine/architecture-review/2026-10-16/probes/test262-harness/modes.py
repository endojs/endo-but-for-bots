#!/usr/bin/env python3
"""Check the mode column of committed shards against each case's flags.
usage: python3 -I modes.py <whole-tree> <test262 root>"""
import os, re, sys, collections
d, root = sys.argv[1], sys.argv[2]
FM = re.compile(r'/\*---(.*?)---\*/', re.S)
rows = collections.defaultdict(list)
for n in sorted(os.listdir(d)):
    if n == 'manifest.txt': continue
    for line in open(os.path.join(d, n), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, tok = re.split(r'\s', line.strip(), maxsplit=2)
        rows[p].append((m, tok))
c = collections.Counter()
for p, rs in rows.items():
    t = FM.search(open(os.path.join(root, 'test', p), encoding='utf-8').read())
    t = t.group(1) if t else ''
    fl = re.search(r'^flags:\s*\[(.*?)\]', t, re.M)
    flags = [x.strip() for x in fl.group(1).split(',')] if fl else []
    modes = sorted(m for m, _ in rs)
    if 'module' in flags:
        c['module case, rows=' + '+'.join(modes)] += 1
    elif 'onlyStrict' in flags:
        c['onlyStrict case, rows=' + '+'.join(modes) + (' (pre-skip)' if modes == ['sloppy'] else '')] += 1
    elif 'noStrict' in flags or 'raw' in flags:
        c['noStrict/raw case, rows=' + '+'.join(modes)] += 1
    else:
        k = 'default case, rows=' + '+'.join(modes)
        if modes == ['sloppy']:
            k += ' reason=' + rs[0][1].split(':')[0] + ':' + (rs[0][1].split(':')[1] if ':' in rs[0][1] else '')
        c[k] += 1
for k, v in c.most_common():
    print(f'{v:7}  {k}')
