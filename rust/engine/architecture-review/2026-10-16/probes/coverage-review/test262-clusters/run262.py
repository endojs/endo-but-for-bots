"""Plain-host test262 runner over ironhorse-xst (and optionally node).
Assembles assert.js + sta.js + the case's includes + body as ONE Script
(the test262-harness shape); strict variant prepends "use strict";.
Usage: run262.py [--node] [--jobs N] [--out results.jsonl] path...   (paths relative to test/)
       run262.py --list file.txt ...                                  (one path per line)"""
import sys, os, re, subprocess, json, yaml
from concurrent.futures import ThreadPoolExecutor
T = '/home/user/endo-but-for-bots/rust/engine/target/test262-report/test262-src'
X = '/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst'
NODE = '/opt/node22/bin/node'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assembled')
os.makedirs(OUT, exist_ok=True)
def fm(src):
    m = re.search(r'/\*---(.*?)---\*/', src, re.S)
    try: y = yaml.safe_load(m.group(1)) if m else {}
    except Exception: y = {}
    y = y or {}
    return y.get('includes') or [], y.get('flags') or [], y.get('negative'), y.get('features') or []
def harness(name): return open(os.path.join(T, 'harness', name)).read()
def assemble(path, strict):
    src = open(os.path.join(T, 'test', path)).read()
    incs, flags, neg, feats = fm(src)
    if 'raw' in flags: return src
    pre = harness('assert.js') + '\n' + harness('sta.js') + '\n'
    if 'async' in flags: pre += harness('doneprintHandle.js') + '\n'
    for i in incs: pre += harness(i) + '\n'
    body = pre + src
    if strict: body = '"use strict";\n' + body
    return body
def run(cmd, f):
    try:
        p = subprocess.run(cmd + [f], capture_output=True, text=True, timeout=60)
        lines = [l for l in p.stderr.strip().splitlines() if l.strip()]
        return p.returncode, (lines[0] if lines else '')[:400] if p.returncode else ''
    except subprocess.TimeoutExpired:
        return 124, 'TIMEOUT'
def one(path, node):
    src = open(os.path.join(T, 'test', path)).read()
    incs, flags, neg, feats = fm(src)
    if 'onlyStrict' in flags: modes = [True]
    elif 'noStrict' in flags or 'raw' in flags: modes = [False]
    else: modes = [False, True]
    out = []
    for strict in modes:
        body = assemble(path, strict)
        fn = os.path.join(OUT, path.replace('/', '__') + ('.strict' if strict else '') + '.js')
        open(fn, 'w').write(body)
        rc, msg = run([X], fn)
        if neg: ok = rc != 0 and msg.startswith(neg['type'])
        else: ok = rc == 0
        r = dict(path=path, mode='strict' if strict else 'sloppy', ok=ok, rc=rc, msg=msg, neg=neg, isasync='async' in flags)
        if node:
            nrc, nmsg = run([NODE], fn)
            r['node_ok'] = (nrc != 0) if neg else (nrc == 0); r['node_msg'] = nmsg[:200]
        out.append(r)
    return out
def main(argv):
    node = '--node' in argv
    jobs = 1; outp = None; paths = []
    it = iter(argv)
    for a in it:
        if a == '--jobs': jobs = int(next(it))
        elif a == '--out': outp = next(it)
        elif a == '--list': paths += [l.strip() for l in open(next(it)) if l.strip()]
        elif a == '--node': pass
        else: paths.append(a)
    fo = open(outp, 'w') if outp else None
    with ThreadPoolExecutor(jobs) as ex:
        for res in ex.map(lambda p: one(p, node), paths):
            for r in res:
                if fo: fo.write(json.dumps(r) + '\n'); fo.flush()
                else: print(f"{'PASS' if r['ok'] else 'FAIL'}\t{r['mode']}\t{r['path']}\tih:{r['rc']}:{r['msg'][:200]}" + (f"\tnode:{'ok' if r.get('node_ok') else 'x'}:{r.get('node_msg','')[:100]}" if node else '') + ('\t[async]' if r['isasync'] else ''), flush=True)
if __name__ == '__main__': main(sys.argv[1:])
