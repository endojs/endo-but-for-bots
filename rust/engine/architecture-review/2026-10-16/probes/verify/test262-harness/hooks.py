import os, re, sys, collections
d, root = sys.argv[1], sys.argv[2]
FM = re.compile(r'/\*---(.*?)---\*/', re.S)
hsrc = {}
def inc_text(n):
    if n not in hsrc:
        try: hsrc[n] = open(os.path.join(root, 'harness', n), encoding='utf-8').read()
        except OSError: hsrc[n] = ''
    return hsrc[n]
c = collections.Counter()
for n in sorted(os.listdir(d)):
    if n == 'manifest.txt': continue
    for line in open(os.path.join(d, n), encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        p, m, tok = line.strip().split(' ', 2)
        src = open(os.path.join(root, 'test', p), encoding='utf-8').read()
        t = FM.search(src); t = t.group(1) if t else ''
        mi = re.search(r'^includes:\s*\[(.*?)\]', t, re.M | re.S)
        incs = [x.strip() for x in mi.group(1).split(',')] if mi else []
        text = src + ''.join(inc_text(i) for i in incs)
        for h in ('createRealm', 'evalScript', 'agent', 'detachArrayBuffer', 'AbstractModuleSource', 'gc', 'IsHTMLDDA'):
            if re.search(r'\$262\.' + h + r'\b', text):
                c[(h, 'pass' if tok == 'pass' else tok.split(':')[0])] += 1
for k, v in sorted(c.items()): print(k, v)
