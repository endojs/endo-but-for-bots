#!/usr/bin/env python3
"""Per-feature non-pass breakdown by reason family, plus $262 hook use via
harness includes. usage: python3 -I features.py <whole-tree> <test262 root> feat..."""
import os, re, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
shard_dir, root = sys.argv[1], sys.argv[2]
feats = sys.argv[3:]
FM = re.compile(r'/\*---(.*?)---\*/', re.S)
def lf(t, k):
    m = re.search(r'^' + k + r':\s*\[(.*?)\]', t, re.M | re.S)
    if m: return [x.strip() for x in m.group(1).split(',') if x.strip()]
    m = re.search(r'^' + k + r':\s*\n((?:\s+-\s*.*\n?)+)', t, re.M)
    if m: return [l.strip()[1:].strip() for l in m.group(1).splitlines() if l.strip().startswith('-')]
    return []
cache = {}
def fm(p):
    if p not in cache:
        s = open(os.path.join(root, 'test', p), encoding='utf-8').read()
        t = FM.search(s); t = t.group(1) if t else ''
        cache[p] = (lf(t, 'features'), lf(t, 'includes'), s)
    return cache[p]
def fam(tok):
    if tok == 'pass': return 'pass'
    if tok.startswith('fail'): return 'fail'
    r = tok[5:]
    if r.startswith('strict:'): r = r[7:]
    return r.split(':')[0] + (':' + r.split(':')[1] if r.startswith(('unsupported-opcode', 'feature', 'structural', 'oracle-host-missing-global')) else '')
per = collections.defaultdict(collections.Counter)
inc_hooks = collections.defaultdict(collections.Counter)
hook_re = re.compile(r'\$262\.(\w+)')
inc_hook_map = {}
for n in os.listdir(os.path.join(root, 'harness')):
    if n.endswith('.js'):
        inc_hook_map[n] = set(hook_re.findall(open(os.path.join(root, 'harness', n), encoding='utf-8').read()))
for name in sorted(os.listdir(shard_dir)):
    if name == 'manifest.txt': continue
    for line in open(os.path.join(shard_dir, name), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        path, mode, tok = re.split(r'\s', line.strip(), maxsplit=2)
        f, inc, src = fm(path)
        for x in feats:
            if x in f: per[x][fam(tok)] += 1
        hooks = set(hook_re.findall(src))
        for i in inc:
            hooks |= inc_hook_map.get(i, set())
        for h in hooks:
            inc_hooks[h][fam(tok) if not tok.startswith('skip') else 'skip:' + fam(tok)] += 1
            inc_hooks[h]['total'] += 1
for x in feats:
    c = per[x]; tot = sum(c.values())
    print(f'{x}: total {tot}, pass {c["pass"]} ({100*c["pass"]/max(tot,1):.1f}%)')
    for k, v in c.most_common(8):
        if k != 'pass': print(f'    {v:6}  {k}')
print()
print('$262 hooks referenced by the case OR any harness include it lists:')
for h, c in sorted(inc_hooks.items(), key=lambda kv: -kv[1]['total']):
    print(f'  $262.{h:20} total {c["total"]:6}  pass {c["pass"]:6}  fail {c["fail"]:5}  ' +
          ', '.join(f'{k}={v}' for k, v in c.most_common() if k.startswith('skip'))[:200])
