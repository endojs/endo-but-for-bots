#!/usr/bin/env python3
"""Re-run dupscan.py's exact algorithm (same normalization, window, run
merging) and split each crate's duplicated-run mass into lines inside an
inline `#[cfg(test)] mod name { ... }` block versus production lines.

A test module is recognized as `#[cfg(test)]` followed within two lines by
`mod name {`; it ends at the first later line consisting of the same
indentation plus `}` (rustfmt layout).
Usage: dupscan_split.py ROOT [W] [lit]
"""
import os
import re
import sys
from collections import defaultdict

ROOT = sys.argv[1]
W = int(sys.argv[2]) if len(sys.argv) > 2 else 10
LIT = len(sys.argv) > 3 and sys.argv[3] == 'lit'
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
    if LIT:
        line = re.sub(r"\"(?:[^\"\\\\]|\\\\.)*\"", "S", line)
        line = re.sub(r"\b\d[\d_xa-fA-F]*\b", "N", line)
    return re.sub(r'\s+', ' ', line)


def test_ranges(lines):
    out = []
    for i, s in enumerate(lines):
        if s.strip() == '#[cfg(test)]':
            for j in range(i + 1, min(i + 3, len(lines))):
                m = re.match(r'^(\s*)(pub(\([^)]*\))? )?mod \w+ \{\s*$', lines[j])
                if m:
                    ind = m.group(1)
                    for k in range(j + 1, len(lines)):
                        if lines[k].rstrip() == ind + '}':
                            out.append((j + 1, k + 1))
                            break
                    break
    return out


files = []
for dp, dn, fn in os.walk(ROOT):
    for f in fn:
        p = os.path.join(dp, f)
        if not f.endswith('.rs') or any(s in p for s in SKIP_PARTS):
            continue
        if is_test_path(p):
            continue
        files.append(p)

seqs = {}
tranges = {}
for p in files:
    out = []
    in_block = False
    with open(p, encoding='utf-8', errors='replace') as fh:
        raw_lines = fh.read().split('\n')
    tranges[p] = test_ranges(raw_lines)
    for i, raw in enumerate(raw_lines, 1):
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
        if len(key) < W * 12:
            continue
        index[key].append((p, k))

dup_starts = defaultdict(set)
for key, locs in index.items():
    if len(locs) > 1:
        for p, k in locs:
            dup_starts[p].add(k)

runs = []
for p, ks in dup_starts.items():
    ks = sorted(ks)
    seq = seqs[p]
    start = prev = ks[0]
    for k in ks[1:] + [None]:
        if k is not None and k == prev + 1:
            prev = k
            continue
        runs.append((p, seq[start][0], seq[prev + W - 1][0], prev - start + W))
        if k is not None:
            start = prev = k


def crate_of(p):
    return os.path.relpath(p, ROOT).split('/')[0]


def in_test(p, line):
    return any(a <= line <= b for a, b in tranges[p])


total = defaultdict(int)
total_test = defaultdict(int)
for p, seq in seqs.items():
    total[crate_of(p)] += len(seq)
    total_test[crate_of(p)] += sum(1 for (i, _) in seq if in_test(p, i))
dup = defaultdict(int)
dup_test = defaultdict(int)
for p, a, b, n in runs:
    c = crate_of(p)
    dup[c] += n
    if in_test(p, a):
        dup_test[c] += n

print(f'# window={W} lit={LIT}; inline #[cfg(test)] modules split out')
print('crate\tnorm_lines\tof_which_test_mod\tdup_lines\tdup_in_test_mod\tprod_dup_pct')
for c in sorted(total):
    prod = total[c] - total_test[c]
    pd = dup[c] - dup_test[c]
    print(f'{c}\t{total[c]}\t{total_test[c]}\t{dup[c]}\t{dup_test[c]}\t{100.0*pd/max(1,prod):.1f}')
