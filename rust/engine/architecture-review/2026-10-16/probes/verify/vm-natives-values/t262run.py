# Minimal plain-host test262 runner for ironhorse-xst (sloppy mode only unless onlyStrict).
import os, re, sys, subprocess, json, tempfile, concurrent.futures as cf
T = '/home/user/endo-but-for-bots/rust/engine/target/test262-report/test262-src'
IH = '/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 't262')
H = {}
def harness(name):
    if name not in H:
        H[name] = open(os.path.join(T, 'harness', name), encoding='utf-8').read()
    return H[name]
def meta(src):
    m = re.search(r'/\*---(.*?)---\*/', src, re.S)
    return m.group(1) if m else ''
def listfield(md, key):
    m = re.search(key + r':\s*\[(.*?)\]', md)
    if m: return [x.strip() for x in m.group(1).split(',') if x.strip()]
    m = re.search(key + r':\s*\n((?:\s+-\s+.*\n)+)', md)
    if m: return [x.strip()[2:].strip() for x in m.group(1).splitlines() if x.strip()]
    return []
def run(path):
    src = open(path, encoding='utf-8').read()
    md = meta(src)
    flags = listfield(md, 'flags')
    if 'async' in flags or 'module' in flags: return (path, 'skip-async-module', '')
    neg = re.search(r'negative:\s*\n\s*phase:\s*(\w+)\s*\n\s*type:\s*(\w+)', md)
    pre = ''
    if 'raw' not in flags:
        incs = ['assert.js', 'sta.js'] + listfield(md, 'includes')
        pre = ''.join(harness(i) + '\n' for i in incs)
    body = ('"use strict";\n' if 'onlyStrict' in flags else '') + pre + src
    fd, tmp = tempfile.mkstemp(suffix='.js', dir=OUT)
    with os.fdopen(fd, 'w', encoding='utf-8') as f: f.write(body)
    try:
        p = subprocess.run([IH, tmp], capture_output=True, text=True, timeout=20)
        err = (p.stderr or '').strip().splitlines()
        first = err[0] if err else ''
        if neg:
            ok = p.returncode != 0 and first.startswith(neg.group(2))
        else:
            ok = p.returncode == 0
        return (path, 'pass' if ok else 'fail', first[:200])
    except subprocess.TimeoutExpired:
        return (path, 'timeout', '')
    finally:
        os.unlink(tmp)
def main():
    root = sys.argv[1]
    files = []
    for d, _, fs in os.walk(os.path.join(T, 'test', root)):
        for f in fs:
            if f.endswith('.js') and '_FIXTURE' not in f: files.append(os.path.join(d, f))
    files.sort()
    res = []
    with cf.ThreadPoolExecutor(8) as ex:
        for r in ex.map(run, files): res.append(r)
    from collections import Counter
    c = Counter(r[1] for r in res)
    reasons = Counter(r[2] for r in res if r[1] in ('fail',))
    out = {'root': root, 'counts': dict(c), 'top_fail_reasons': reasons.most_common(25)}
    tag = root.replace('/', '_')
    json.dump(res, open(os.path.join(OUT, tag + '.json'), 'w'))
    print(json.dumps(out, indent=1, ensure_ascii=False))
main()
