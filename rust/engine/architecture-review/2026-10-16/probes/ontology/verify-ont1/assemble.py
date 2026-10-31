import sys, re, os
root = sys.argv[1]; rel = sys.argv[2]; out = sys.argv[3]
src = open(os.path.join(root, 'test', rel), encoding='utf-8').read()
m = re.search(r'/\*---(.*?)---\*/', src, re.S)
meta = m.group(1) if m else ''
inc = []
mi = re.search(r'includes:\s*\[(.*?)\]', meta)
if mi:
    inc = [s.strip() for s in mi.group(1).split(',') if s.strip()]
else:
    mi = re.search(r'includes:\s*\n((?:\s*-\s*\S+\n)+)', meta)
    if mi:
        inc = re.findall(r'-\s*(\S+)', mi.group(1))
parts = []
for h in ['assert.js', 'sta.js'] + inc:
    parts.append(open(os.path.join(root, 'harness', h), encoding='utf-8').read())
parts.append(src)
open(out, 'w', encoding='utf-8').write('\n'.join(parts))
