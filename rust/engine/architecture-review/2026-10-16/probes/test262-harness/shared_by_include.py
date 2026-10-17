#!/usr/bin/env python3
"""Count shard outcomes for cases whose harness includes declare top-level
const/let/class names, and whether the case body references one of them.
usage: python3 -I shared_by_include.py <whole-tree> <test262 root>"""
import os, re, sys, collections
d, root = sys.argv[1], sys.argv[2]
FM = re.compile(r'/\*---(.*?)---\*/', re.S)
lex = {}
for n in os.listdir(os.path.join(root, 'harness')):
    if n.endswith('.js'):
        names = re.findall(r'^(?:const|let|class)\s+([A-Za-z0-9_$]+)', open(os.path.join(root, 'harness', n), encoding='utf-8').read(), re.M)
        if names: lex[n] = names
out = collections.Counter(); ex = {}
for n in sorted(os.listdir(d)):
    if n == 'manifest.txt': continue
    for line in open(os.path.join(d, n), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, tok = re.split(r'\s', line.strip(), maxsplit=2)
        src = open(os.path.join(root, 'test', p), encoding='utf-8').read()
        t = FM.search(src); t = t.group(1) if t else ''
        mi = re.search(r'^includes:\s*\[(.*?)\]', t, re.M | re.S)
        incs = [x.strip() for x in mi.group(1).split(',')] if mi else []
        body = FM.sub('', src)
        used = [nm for i in incs for nm in lex.get(i, []) if re.search(r'\b' + re.escape(nm) + r'\b', body)]
        if not used: continue
        k = tok.split(':')[0] + (':' + tok.split(':')[1] if tok.startswith('skip:') else '')
        out[k] += 1; ex.setdefault(k, p)
for k, v in out.most_common():
    print(f'{v:6}  {k}   e.g. {ex[k]}')
print('total case/modes whose body uses a harness-include top-level lexical binding:', sum(out.values()))
