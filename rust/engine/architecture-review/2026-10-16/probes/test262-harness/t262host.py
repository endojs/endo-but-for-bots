#!/usr/bin/env python3
"""Run sampled test262 cases through ironhorse-xst as a plain test262 host
(test262's own verdict, no oracle), the way test262-harness assembles them:
["use strict";] sta.js assert.js [doneprintHandle.js if async] includes body.

usage: python3 -I t262host.py <test262 root> <ironhorse-xst> <outdir> <path:mode>...
Prints one line per case: path mode exit verdict first-stderr-line.
"""
import os, re, subprocess, sys

root, host, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
FM_RE = re.compile(r'/\*---(.*?)---\*/', re.S)

def listfield(text, key):
    mm = re.search(r'^' + key + r':\s*\[(.*?)\]', text, re.M | re.S)
    if mm:
        return [x.strip() for x in mm.group(1).split(',') if x.strip()]
    mm = re.search(r'^' + key + r':\s*\n((?:\s+-\s*.*\n?)+)', text, re.M)
    if mm:
        return [l.strip()[1:].strip() for l in mm.group(1).splitlines() if l.strip().startswith('-')]
    return []

for i, spec in enumerate(sys.argv[4:]):
    path, mode = spec.rsplit(':', 1)
    src = open(os.path.join(root, 'test', path), encoding='utf-8').read()
    fm = FM_RE.search(src).group(1)
    flags = listfield(fm, 'flags')
    includes = listfield(fm, 'includes')
    neg = re.search(r'^\s+type:\s*(\S+)', fm, re.M) if re.search(r'^negative:', fm, re.M) else None
    parts = []
    if mode == 'strict':
        parts.append('"use strict";\n')
    if 'raw' not in flags:
        names = ['assert.js', 'sta.js']
        if 'async' in flags:
            names.append('doneprintHandle.js')
        for n in names + includes:
            parts.append(open(os.path.join(root, 'harness', n), encoding='utf-8').read() + '\n')
    parts.append(src)
    f = os.path.join(outdir, f'case{i}.js')
    open(f, 'w', encoding='utf-8').write(''.join(parts))
    try:
        p = subprocess.run([host, f], capture_output=True, text=True, timeout=60)
        code, err = p.returncode, (p.stderr.strip().splitlines() or [''])[0][:160]
    except subprocess.TimeoutExpired:
        code, err = 'timeout', ''
    if neg:
        verdict = 'PASS' if code == 1 and err.startswith(neg.group(1)) else 'FAIL'
    elif 'async' in flags:
        verdict = 'ASYNC?'  # needs print(); ironhorse-xst has none
    else:
        verdict = 'PASS' if code == 0 else 'FAIL'
    print(f'{path} {mode} exit={code} {verdict} {err}')
