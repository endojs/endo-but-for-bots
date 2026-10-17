"""Recompute IronHorse's own test262 verdict with one-Script plain-host passes counted.

Usage: python3 headline.py <oracle-off report.json> <test262-clusters/labels.json> <out.txt>

labels.json is the cluster sweep's per-case label (probes/coverage-review/test262-clusters/label.py).
A case it labels "T262-2 split-Script artifact" or "HARNESS completion-value coercion" passed
when assembled as one Script on ironhorse-xst (sync cases) or reported Test262:AsyncTestComplete
under the sweep's async harness (async cases). Async cases whose sweep reason is
async:unhandled-rejection are reported separately (COV-9).
"""
import json, sys
from collections import Counter

PROPOSALS = set('Intl.Era-monthcode Intl.Locale-info Intl.NumberFormat-v3 Iterator.prototype.join '
                'ShadowRealm await-dictionary decorators error-stack-accessor export-defer '
                'immutable-arraybuffer import-bytes import-defer import-text legacy-regexp '
                'nonextensible-applies-to-private source-phase-imports '
                'source-phase-imports-module-source'.split())


def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit'
            or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')):
        return 'unsupported'
    return 'fail'


def standard(c):
    return not (set(c['features']) & PROPOSALS)


def core(c):
    p = c['path']
    return standard(c) and not p.startswith(('intl402/', 'annexB/')) and 'Temporal' not in p \
        and 'Temporal' not in c['features']


cases = {c['path']: c for c in json.load(open(sys.argv[1]))['cases']}
labels = json.load(open(sys.argv[2]))
extra = {}
for p, lab in labels.items():
    if lab.startswith('T262-2') or lab.startswith('HARNESS completion'):
        c = cases[p]
        assert verdict(c) != 'pass'
        if c['reason'] == 'async:unhandled-rejection':
            kind = 'COV-9 latch'
        elif lab.startswith('HARNESS'):
            kind = 'completion-value coercion'
        else:
            kind = 'T262-2 split-Script'
        extra[p] = kind
with open(sys.argv[3], 'w') as out:
    out.write('# test262 cases scored fail by ih_alone verdict() that pass on the plain host\n')
    out.write('# kind<TAB>path<TAB>sweep reason\n')
    for p in sorted(extra):
        out.write(f"{extra[p]}\t{p}\t{cases[p]['reason']}\n")
print(Counter(extra.values()))
for name, sel in (('whole corpus', lambda c: True), ('standard features', standard),
                  ('core ECMA-262', core)):
    pool = [c for c in cases.values() if sel(c)]
    passed = sum(1 for c in pool if verdict(c) == 'pass')
    add = sum(1 for p in extra if sel(cases[p]))
    print(f'{name}: {len(pool)} cases, {passed} pass ({100 * passed / len(pool):.1f}%), '
          f'with one-Script passes {passed + add} ({100 * (passed + add) / len(pool):.1f}%)')
