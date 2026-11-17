import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run262 import fm, harness, T
PRE = """globalThis.__sig = undefined;
function print(m) { if (typeof globalThis.__sig === 'string' && globalThis.__sig.indexOf('Test262:AsyncTestFailure') === 0) return; globalThis.__sig = '' + m; }
"""
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
for path in [l.strip() for l in open(sys.argv[2]) if l.strip()]:
    src = open(os.path.join(T, 'test', path)).read()
    incs, flags, neg, feats = fm(src)
    modes = [True] if 'onlyStrict' in flags else [False] if ('noStrict' in flags or 'raw' in flags) else [False, True]
    for strict in modes:
        body = PRE + harness('assert.js') + '\n' + harness('sta.js') + '\n' + harness('doneprintHandle.js') + '\n'
        for i in incs: body += harness(i) + '\n'
        body += src
        if strict: body = '"use strict";\n' + body
        open(os.path.join(out, path.replace('/', '__') + ('.strict' if strict else '') + '.js'), 'w').write(body)
