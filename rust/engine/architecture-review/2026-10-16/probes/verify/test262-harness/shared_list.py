import os, re, sys
d, root = sys.argv[1], sys.argv[2]
FM = re.compile(r'/\*---(.*?)---\*/', re.S)
lex = {}
for n in os.listdir(os.path.join(root, 'harness')):
    if n.endswith('.js'):
        names = re.findall(r'^(?:const|let|class)\s+([A-Za-z0-9_$]+)', open(os.path.join(root, 'harness', n), encoding='utf-8').read(), re.M)
        if names: lex[n] = names
for n in sorted(os.listdir(d)):
    if n == 'manifest.txt': continue
    for line in open(os.path.join(d, n), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, tok = line.strip().split(' ', 2)
        src = open(os.path.join(root, 'test', p), encoding='utf-8').read()
        t = FM.search(src); t = t.group(1) if t else ''
        mi = re.search(r'^includes:\s*\[(.*?)\]', t, re.M | re.S)
        incs = [x.strip() for x in mi.group(1).split(',')] if mi else []
        body = FM.sub('', src)
        used = [nm for i in incs for nm in lex.get(i, []) if re.search(r'\b' + re.escape(nm) + r'\b', body)]
        if used: print(f'{p}:{m} {tok} {",".join(sorted(set(used)))}')
