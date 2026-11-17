#!/usr/bin/env python3
"""Clone scan over Rust sources: hash windows of W normalized lines.

Normalization: strip comments and whitespace, drop blank lines and lines
that are only braces/punctuation, so windows are made of statements.
Reports maximal duplicated runs (merged adjacent windows) by location,
grouped into clone families, with total duplicated line counts per
crate pair.
"""
import os
import re
import sys
from collections import defaultdict

ROOT = sys.argv[1]
W = int(sys.argv[2]) if len(sys.argv) > 2 else 10
INCLUDE_TESTS = len(sys.argv) > 3 and sys.argv[3] == 'tests'

SKIP_PARTS = ('/target/', '_generated.rs', '/fuzz/corpus')


def is_test_path(p):
    return '/tests/' in p or p.endswith('tests.rs') or p.endswith('_tests.rs')


def norm(line):
    line = re.sub(r'//.*$', '', line)
    line = line.strip()
    if not line:
        return None
    if re.fullmatch(r'[{}()\[\];,]*', line):
        return None
    if line.startswith('#[') or line.startswith('use ') or line.startswith('pub use '):
        return None
    line = re.sub(r"\"(?:[^\"\\\\]|\\\\.)*\"", "S", line)
    line = re.sub(r"\b\d[\d_xa-fA-F]*\b", "N", line)
    return re.sub(r"\s+", " ", line)


files = []
for dp, dn, fn in os.walk(ROOT):
    for f in fn:
        p = os.path.join(dp, f)
        if not f.endswith('.rs') or any(s in p for s in SKIP_PARTS):
            continue
        if is_test_path(p) != INCLUDE_TESTS:
            continue
        files.append(p)

seqs = {}
for p in files:
    out = []
    in_block = False
    with open(p, encoding='utf-8', errors='replace') as fh:
        for i, raw in enumerate(fh, 1):
            s = raw
            if in_block:
                if '*/' in s:
                    s = s.split('*/', 1)[1]
                    in_block = False
                else:
                    continue
            if '/*' in s and '*/' not in s:
                s = s.split('/*', 1)[0]
                in_block = True
            n = norm(s)
            if n is not None:
                out.append((i, n))
    seqs[p] = out

index = defaultdict(list)
for p, seq in seqs.items():
    for k in range(len(seq) - W + 1):
        key = '\n'.join(x[1] for x in seq[k:k + W])
        if len(key) < W * 12:  # skip windows of trivially short lines
            continue
        index[key].append((p, k))

# Mark duplicated window starts per file.
dup_starts = defaultdict(set)
for key, locs in index.items():
    if len(locs) > 1:
        for p, k in locs:
            dup_starts[p].add(k)

# Merge into runs of normalized lines.
runs = []
for p, ks in dup_starts.items():
    ks = sorted(ks)
    seq = seqs[p]
    start = prev = ks[0]
    for k in ks[1:] + [None]:
        if k is not None and k == prev + 1:
            prev = k
            continue
        first_line = seq[start][0]
        last_line = seq[prev + W - 1][0]
        runs.append((p, first_line, last_line, prev - start + W))
        if k is not None:
            start = prev = k

def crate_of(p):
    rel = os.path.relpath(p, ROOT)
    return rel.split('/')[0]

per_crate = defaultdict(int)
for p, a, b, n in runs:
    per_crate[crate_of(p)] += n
total = defaultdict(int)
for p, seq in seqs.items():
    total[crate_of(p)] += len(seq)

print(f'# window={W} lines, tests={INCLUDE_TESTS}')
print('crate\tnormalized_lines\tlines_in_duplicated_runs\tpct')
for c in sorted(total):
    print(f'{c}\t{total[c]}\t{per_crate[c]}\t{100.0*per_crate[c]/max(1,total[c]):.1f}')
print()
print('# largest duplicated runs (normalized lines, path:first-last)')
for p, a, b, n in sorted(runs, key=lambda r: -r[3])[:120]:
    print(f'{n}\t{os.path.relpath(p, ROOT)}:{a}-{b}')

print()
print('# clone pairs (first shared window of each run -> partner locations)')
seen = set()
for p, a, b, n in sorted(runs, key=lambda r: -r[3])[:80]:
    seq = seqs[p]
    k = next(i for i, x in enumerate(seq) if x[0] == a)
    key = '\n'.join(x[1] for x in seq[k:k + W])
    locs = index.get(key, [])
    partners = [f'{os.path.relpath(q, ROOT)}:{seqs[q][j][0]}' for q, j in locs if not (q == p and j == k)]
    sig = tuple(sorted([f'{os.path.relpath(p, ROOT)}:{a}'] + partners))
    if sig in seen:
        continue
    seen.add(sig)
    print(f'{n}\t{os.path.relpath(p, ROOT)}:{a}-{b}\t<->\t' + ', '.join(partners[:4]))
