# Lens: duplicated code

Reviewed commit `61cd656cb`.

## The question

Where does the engine implement one algorithm more than once, carry copy-paste families that
should be one helper, or keep parallel tables that must be edited together by hand?
For each family this lens asks four things: how many copies there are and where, how large
they are, whether the copies have already drifted apart, and what one implementation would
look like.

The engine is a transliteration of XS with deterministic metering and persistent heap images.
That raises the stakes of a second copy.
Two copies of one semantic operation must agree on the result, on the computrons charged, and
on how a failure is classified, and they must keep agreeing as each copy is fixed.
A disagreement in the engine is observable by the guest or the host: as a different value, a
different meter reading, or a different halt or store-failure class.
A disagreement in the harness or the fuzz lane changes what those instruments report, which is
how engine regressions are noticed.

## Why it matters here: copies that have already diverged

Divergence between copies is the mechanism behind a number of verified findings.
The severities below are final: the pass-1 verdict, lowered by pass 2 where a pass-2 verdict
exists (`../verify/<map>.json`, `../verify/<map>.pass2.json`).

| Finding (final severity) | The copies | How they diverged | Guest-visible consequence |
|---|---|---|---|
| NOBJ-NEW-1 (high; pass 2 upheld) | The "detach a `Slot` into a stored value" idiom `let mut v = a; v.id = 0; v.next = NULL;` is written out at 17 sites in `rust/engine/ironhorse-vm/src` | The generic element store keeps the existing item's attributes (`rust/engine/ironhorse-vm/src/interp/property/indexed.rs:86-97`, whose comment assumes the incoming flag is "always the default 0"); seven dense fast paths copy the operand's flag byte (`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:1864`, `:1878`, `:3582`, `:3753`, `:4209-4214`, `:4391`, `:4746`) | A `const` local pushed onto an array is stored non-writable: `a[0] = 99` throws in strict code |
| PROP-1 (high; pass 2 upheld), NOBJ-1 (high; pass 2 upheld) | Read-side key resolution `to_read_key` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:634-680`) and `array_index_read_key` (`rust/engine/ironhorse-vm/src/interp/natives/array.rs:2068`) against their write twins `to_property_id` (`keys.rs:713-721`) and `array_generic_index_id` (`array.rs:2056-2059`) | The read twins keep a canonical index as `ReadKey::Index`; the write twins intern its decimal spelling | Index-heavy generic writes exhaust the permanent 16-bit name table; later name creation throws `RangeError` for the life of the vat |
| NOBJ-2 (high; pass 2 upheld), MEM-4 (high; pass 2 upheld) | `Array.prototype.sort`'s stable fallible merge sort (`rust/engine/ironhorse-vm/src/interp/natives/array.rs:4284`, `array_stable_sort`) and `%TypedArray%.prototype.sort` (`rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:1306-1395`) | The TypedArray copy is an insertion sort; TypedArray `fill`/`reverse` also omit the per-element charge that `Array.prototype.fill` makes | Theta(n^2) host work for O(n) computrons; a metering host cannot interrupt it |
| NVAL-2 (high; pass 2 upheld) | Two BigInt decimal renderers: `bi_to_decimal` (`rust/engine/ironhorse-vm/src/interp/bigint.rs:351-378`) and `bi_to_radix` (`rust/engine/ironhorse-vm/src/interp.rs:3672-3708`) | Different algorithms and opposite metering | `String(x)` is charged about 9 computrons and `x.toString()` about 79.5 million for the same digits |
| INT-3 (medium) | The compiler adapter: canonical `IronhorseSourceCompiler` (`rust/engine/ironhorse-runtime/src/lib.rs:28-127`) against the thixotrope worker's private copy (`rust/thixotrope-ironhorse-worker/src/main.rs:17-116`), itself copied verbatim into `rust/engine/wasm-worker-spike/src/session.rs:24-123` | Only the canonical copy overrides `compile_eval_units` | In a thixotrope vat `eval('super.x')`, `eval('new.target')` and `eval('this.#x')` throw `SyntaxError` and kill the worker |
| SNS-4 (medium) | Eager restore and `validate_store_content` against the lazy page source (`rust/engine/ironhorse-snapshot/src/machine.rs:1396-1404`) | The eager path reports a bad row as typed `RowLength`/`Corrupt`; the lazy path re-reads the row without those checks and panics with a `String` payload | Daemon open and rewind unwind with an anonymous panic instead of a classifiable store error |
| SNI-11 (low), feeding SNI-1, SNI-2, SNI-4 (medium each; pass 2 lowered from high) | Row validation in the decoder, the roster gate and the VM `restore_*` functions | The gate checks owner liveness; the VM also requires `Kind::Instance`; the HEAP gets neither layer's semantic checks | Crafted containers with prototype cycles, bad chunk offsets or kind/payload mismatches are adopted |
| NVAL-10 (medium) | Seven hex-digit decoders: six hand-written helpers (`rust/engine/ironhorse-compile/src/lexer.rs:1450`, `:1459`; `rust/engine/ironhorse-regexp/src/compile.rs:3292`; `rust/engine/ironhorse-vm/src/interp/natives/uri.rs:13`, `annex_b.rs:14`, `base64.rs:40`) and JSON's `u32::from_str_radix` (`rust/engine/ironhorse-vm/src/interp/natives/json.rs:1589-1591`) | Only the JSON copy accepts a leading `+` | `JSON.parse('"\\u+041"')` returns `"A"`; `JSON.rawJSON` then lets `JSON.stringify` emit invalid JSON |
| NOBJ-10 (medium) | The 1,000,000-step iterator loop, written out at the 11 sites the natives map lists plus `rust/engine/ironhorse-vm/src/interp/property/object.rs:213` and `rust/engine/ironhorse-vm/src/interp/iterable.rs:179` | Every copy halts `StepLimit` except `groupBy` (`rust/engine/ironhorse-vm/src/interp/natives/collection.rs:2784`), which silently truncates | `Map.groupBy` over 1,000,005 values returns 1,000,000 of them without error |
| BOOT-2 (medium; downgraded) | Nine key-interning entry points (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:22`, `:75`, `:84`, `:97`, `:111`, `:126`, `:166`, `:183`, `:214`) | Some natives use the variant that skips the lazy-intrinsic install pass (`rust/engine/ironhorse-vm/src/interp/natives/json.rs:1768`, `natives/regexp.rs:1125`, `:1230`, `natives/collection.rs:2880`) | An intrinsic member reads absent, then present, within one crank |
| NVAL-8 (medium) | Eight independent "supported locale" tables plus three locale-language extractors | They disagree about which locales are modelled | Locales reported as supported are formatted with English data |
| FN-19 (low) | Four suspension drivers and the frame records `CallerState` / `SavedFrame` | `SavedFrame` lacks `this_captures`; the async drivers tick `GENERATOR_RESUME_METERING` only when `!is_start`, the generator drivers always | Probe `../probes/verify/vm-functions-async/v19_this_captures.js`: an inner arrow's `this` stays uninitialized across an `await` before `super()` |
| CMP-10 (low) | Two `\u{...}` readers in the lexer: identifiers (`rust/engine/ironhorse-compile/src/lexer.rs:1413-1447`) and strings (`lexer.rs:1506-1560`) | Only the string reader bounds the value | `var \u{100000041} = 1` binds `A` (`../probes/dup/js/escape_twins.js`) |
| NVAL-16 (low) | `String.fromCharCode`'s own ToUint16 (`rust/engine/ironhorse-vm/src/interp/natives/string.rs:73-80`) against `numeric::number_to_u64_wrapping` (`rust/engine/ironhorse-vm/src/interp/numeric.rs:508-520`) | The private copy saturates through `as i64` | `String.fromCharCode(2**63)` yields U+FFFF instead of U+0000 |
| T262-14 (low), T262-3 (low; downgraded) | Six compile-error classification sites; three copies of mode and goal selection in `rust/engine/ironhorse-262/src/xst.rs` | The classifiers disagree on resource stops; the third mode/goal copy forgot the module goal | A module-case hang is filed as an oracle problem; a resource stop could pass a negative case |

One family shows the opposite shape: three copies agree today because they share the same bug,
so fixing one alone would create a divergence.
The compiler's non-decimal literal conversion (`lexer.rs:874-879`, CMP-7, medium), `Number()` on
`0x`/`0o`/`0b` strings (`numeric.rs:233-242`, NVAL-11, medium) and `parseInt` (`numeric.rs:84-99`,
NVAL-11) all accumulate digits in `f64` with one rounding per digit.
`../probes/dup/js/radix_twins.js` shows the three agree on `144115188075855870` for
`0x200000000000011`, where Node gives `144115188075855900` for all three.
A fix to the VM alone would make `0x200000000000011 === Number('0x200000000000011')` false.

The code's own comments record further divergences that have already been fixed:

- `rust/engine/ironhorse-vm/src/interp/dispatch/property_write.rs:285-308`: twice the
  `DELETE_PROPERTY_AT` opcode disagreed with `mop_delete` (a String wrapper's index, and an
  ordinary object's index store), "the same two-spellings split".
- `rust/engine/ironhorse-vm/src/interp/property/integrity.rs:182-189`: a fix taught to
  `set_integrity_level` was missed by `harden`'s own copy of the loop, so `harden(bigArray)`
  poisoned the machine while `Object.freeze(bigArray)` did not.
  The loop exists three times (`:169`, `:248`, `:307`).
- `rust/engine/ironhorse-vm/src/interp/property.rs:64-71`: one copy of the primitive-to-wrapper
  prototype dispatch lacked the Symbol arm, so `Symbol({x:5})['x']` was `5`.
- PROP-12 cites three more key-spelling bugs recorded in comments (`property.rs:1176-1188`,
  `indexed.rs:866-877`, `property.rs:2298-2303`).

## Method

### Mechanical clone scan

A clone scan was run over every engine Rust source under `rust/engine` before this lens was
written.
`../probes/dup/dupscan.py` hashes windows of W consecutive normalized lines.
Normalization strips comments and whitespace, and drops blank lines, punctuation-only lines,
attributes and `use` lines, so a window is made of statements.
Windows whose normalized text is shorter than 12 characters per line are ignored.
Overlapping duplicated windows are merged into maximal runs, and each crate's total is the number
of normalized lines that lie in a run with at least one other copy.
That total counts every copy, the first included: two 34-line copies contribute 68 lines.
The percentage is therefore "share of statements that have a twin", not "lines one could delete".
The scan skips `target/`, `*_generated.rs` and fuzz corpora, and by default skips test files
(paths containing `/tests/`, and files ending in `tests.rs`).
The docstring mentions totals "per crate pair"; the output is per crate.

`../probes/dup/dupscan_lit.py` is the same program with one change to `norm`: string literals
become `S` and numeric literals become `N` before hashing, and it was run with W=8.
It finds clones that differ only in messages, names held in strings, or constants.
Because the length filter is applied after normalization, string-heavy tables fall below it, so
literal-normalized mass can be lower than exact mass for a crate made of tables (see
`ironhorse-meter` below).

Outputs: `../probes/dup/dup-src-w10.txt` (exact, W=10) and `../probes/dup/dup-src-lit-w8.txt`
(literal-normalized, W=8).
This lens re-ran `dupscan.py` at `61cd656cb` with root `rust/engine` and W=10; the output is
byte-identical to `dup-src-w10.txt`.

`dupscan.py`, verbatim:

```python
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
    return re.sub(r'\s+', ' ', line)


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
```

### Supplementary runs by this lens

- `../probes/dup/dupscan_split.py` repeats the same algorithm and splits each crate's mass into
  lines inside inline `#[cfg(test)] mod name { ... }` blocks and production lines
  (`../probes/dup/dup-split-w10.txt`, `../probes/dup/dup-split-lit-w8.txt`).
  Its duplicated-line totals equal the original scans exactly.
- `dupscan.py rust/engine 10 tests` scans the test files the main scan skips
  (`../probes/dup/dup-tests-w10.txt`).
- `../probes/dup/router_check.py` checks that every `NativeMethod` variant the method router
  sends to a `native_method_*` family is named in that family (`../probes/dup/router_check.out`).
- `../probes/dup/default_keys_vs_xs.py` compares `DEFAULT_KEYS` with XS's `gxIDStrings` under
  the XS feature flags (`../probes/dup/default_keys_vs_xs.out`).
- JS probes on the release `ironhorse-xst` against Node 22: `../probes/dup/js/radix_twins.js`,
  `../probes/dup/js/escape_twins.js`, `../probes/dup/js/harden_string.js`.
- Targeted greps, quoted where used (for example the 17 slot-detach sites and the 13
  primitive-prototype copies).

### Region inventories and verification

Each of the 13 region maps (`../maps/<region>.md`) ends with a duplication inventory.
This lens merged those inventories, removed rows that name the same code twice (for example,
the `ParseError` mapping appears in both the boot and the integration maps, and the
`GET_PROPERTY` getter table in both the core-dispatch and the natives-values maps), and grouped
them into the families below.
Findings were then taken from the per-map verification (`../verify/<map>.json`, pass 1) and the
refuter pass for critical and high findings (`../verify/<map>.pass2.json`).
Where a map and its verification disagree, the verification is used.
Inventory rows that no finding covers are map evidence.
This lens re-checked a sample of them at `61cd656cb` (line ranges and counts), notes the counts it
re-derived where they differ from the map, and otherwise cites them as the map states them.

## Measured clone mass

### Per crate

All counts are normalized lines.
"Test mod." is the part of a crate's production files that sits inside inline
`#[cfg(test)] mod` blocks; the "production" columns exclude those blocks.

| Crate | Normalized lines | In inline test mod. | Exact W=10 | Exact % | Exact %, production | Literal W=8 | Literal % | Literal %, production |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `ironhorse-vm` | 64,103 | 3,813 | 2,924 | 4.6 | 4.8 | 4,644 | 7.2 | 7.4 |
| `ironhorse-snapshot` | 20,474 | 9,612 | 759 | 3.7 | 1.9 | 1,670 | 8.2 | 4.1 |
| `ironhorse-compile` | 13,812 | 321 | 216 | 1.6 | 1.6 | 630 | 4.6 | 4.7 |
| `ironhorse-regexp` | 5,529 | 421 | 114 | 2.1 | 2.2 | 174 | 3.1 | 3.4 |
| `ironhorse-262` | 4,714 | 1,842 | 44 | 0.9 | 0.8 | 268 | 5.7 | 3.7 |
| `ironhorse-fuzz` | 1,684 | 476 | 20 | 1.2 | 0.0 | 29 | 1.7 | 0.0 |
| `ironhorse-meter` | 1,037 | 35 | 98 | 9.5 | 9.8 | 36 | 3.5 | 3.6 |
| `stack-lanes` | 955 | 0 | 0 | 0.0 | 0.0 | 21 | 2.2 | 2.2 |
| `xs-oracle` | 923 | 252 | 130 | 14.1 | 19.4 | 152 | 16.5 | 22.7 |
| `wasm-worker-spike` | 882 | 0 | 62 | 7.0 | 7.0 | 62 | 7.0 | 7.0 |
| `ironhorse-unicode` | 143 | 0 | 0 | 0.0 | 0.0 | 18 | 12.6 | 12.6 |
| `ironhorse-text` | 128 | 30 | 0 | 0.0 | 0.0 | 0 | 0.0 | 0.0 |
| `ironhorse-runtime` | 118 | 0 | 58 | 49.2 | 49.2 | 58 | 49.2 | 49.2 |
| `stack-depth-prototypes` | 96 | 0 | 0 | 0.0 | 0.0 | 0 | 0.0 | 0.0 |
| `benches` | 52 | 0 | 0 | 0.0 | 0.0 | 0 | 0.0 | 0.0 |
| **All** | **114,650** | **16,802** | **4,425** | **3.9** | **3.9** | **7,762** | **6.8** | **6.3** |

Reading the table:

- `ironhorse-vm` carries two thirds of all clone mass, and almost all of it is production code.
  Its literal-normalized share (7.4% of production statements) is the figure to track: most VM
  clones differ only in a message string or a constant.
- Almost half of `ironhorse-snapshot`'s normalized lines (9,612 of 20,474) are inline test
  modules: `image.rs` alone has 6,493 lines of tests from `:5464` to its end.
  Of its 759 exact duplicated lines, 558 are in those tests, so its production clone mass is
  1.9% exact and 4.1% literal-normalized.
- `ironhorse-runtime` is 49% duplicated because its 118 statements contain the same
  `ParseError` mapping twice (BOOT-11, INT-13).
- `ironhorse-meter`'s exact mass is the two `sha256` absorb loops and `DEFAULT_KEYS`'s overlap
  with `intrinsic_order.rs`; the latter is all string literals, so it drops out of the
  literal-normalized scan.
- `xs-oracle` and `wasm-worker-spike` are test and prototype code; their percentages are high
  because the crates are small.

The test files the main scan skips are more duplicated than production code: 8.1% exact in
`ironhorse-262` tests, 6.0% in `ironhorse-vm` tests and 4.3% in `ironhorse-snapshot` tests
(`../probes/dup/dup-tests-w10.txt`).
The largest test clone, a 41-47-line run shared by five files
(`rust/engine/ironhorse-vm/tests/cross_segment_callee_callability.rs:17-74`,
`rust/engine/ironhorse-vm/tests/engine_throws_are_catchable.rs:17-74`,
`rust/engine/ironhorse-vm/tests/relink_preserves_guest_edits.rs:115-161`,
`rust/engine/ironhorse-snapshot/tests/persist_gates.rs:151-197`,
`rust/engine/ironhorse-snapshot/tests/dynamic_segments.rs:23-69`), is a test `SourceCompiler`
carrying another copy of the compiler-adapter mapping (family F12).
`rust/engine/ironhorse-vm/tests/common/mod.rs:68-84` holds one more copy, which those files do not
use.

### Largest clone pairs

The exact scan's pairs, largest first, opened and characterized.
"Lines" is the normalized run length of each copy.
Paths are relative to `rust/engine/`.

| # | Lines | Copy | Twin(s) | What it is | Verdict |
|---:|---:|---|---|---|---|
| 1 | 40 | `ironhorse-vm/src/interp/natives/temporal.rs:1192-1244` (`temporal_zoned_from`) | `:1417-1469` (`temporal_zoned_method`, `with`) | Nine-arm ZonedDateTime property-bag field read with per-field range errors | Hazard (F8) |
| 2 | 38 | `ironhorse-snapshot/src/image.rs:7084-7122` | `:7287-7323` | Fixture setup in the inline test module | Acceptable (test) |
| 3 | 35 | `ironhorse-vm/src/interp/suspend.rs:725-768` (`step_async_generator`) | `:935-986` (`step_async`) | Async resume driver body | Hazard, already diverged (F3, FN-19) |
| 4 | 34 | `ironhorse-compile/src/parser.rs:2358-2400` | `ironhorse-vm/src/value.rs:3063-3114` | `number_to_ecma_string`, identical except `pub` and comments | Hazard (F7, CMP-13) |
| 5 | 31 | `ironhorse-vm/src/interp/suspend.rs:262-299` (`resume_generator`) | `:457-487` (`resume_generator_in_place`) | Generator resume admission and driver suspension | Hazard (F3, FN-19) |
| 6 | 31 | `wasm-worker-spike/src/session.rs:34-70` (`compile_source`) | `:83-119` (`compile_source_units`) | `ParseError` mapping | Prototype code, but a verbatim copy of the shipped worker (F12, INT-13) |
| 7 | 29 | `ironhorse-snapshot/src/image.rs:7839-7868` | `image.rs:7093`, `:7296`; `store.rs:3660`, `:3703` | Fixture setup in two inline test modules | Acceptable (test) |
| 8 | 29 | `ironhorse-runtime/src/lib.rs:41-83` (`compile_source`) | `:137-179` (`finish_units`) | `ParseError` to `SourceCompileError` mapping in the canonical adapter | Hazard (F12, BOOT-11) |
| 9 | 27 | `xs-oracle/src/lib.rs:316-352` (`run`) | `:545-566` (`compile_module`), `:392-422` (`outcome_from_raw`) | Oracle result copy-out | Low (test oracle) |
| 10 | 27 | `ironhorse-vm/src/interp/natives/dispatch.rs:2460-2486` (router) | `:6104-6130` (`native_method_string`) | The String-method variant list, written in the router and again in the family | Parallel table (F1, F5) |
| 11 | 25 | `ironhorse-compile/src/coder.rs:2390-2416` (`code_for_in_of`) | `:2578-2604` (`scope_code_used`); third use at `:5853` | Finally-selector lowering around `finalize_targets` | Acceptable: mirrors XS (`c/moddable/xs/sources/xsCode.c:1847-1849`, `:3307-3309`, `:4615` from the repository root) |
| 12 | 23 | `ironhorse-vm/src/interp/natives/dispatch.rs:2231-2253` (router) | `:3418-3440` (`native_method_temporal`) | Temporal and Date variant list | Parallel table (F1) |
| 13 | 22 | `ironhorse-vm/src/interp/natives/dispatch.rs:118-143` (`native_ctor_intl`) | `:420`, `:628`, `:1230`, `:1356`; `natives/weak.rs:31` | Constructor-family signature, `arg` closure and `let _ = (...)` | Boilerplate, low (F5) |
| 14 | 22 | `ironhorse-vm/src/interp/bigint.rs:387-411` (`parse_bigint_string_u64`) | `:433-457` (`parse_bigint_string`) | StringIntegerLiteral prefix and sign parsing | Hazard, low (F8) |
| 15 | 21+17+14 | `ironhorse-meter/src/default_keys.rs:27-78` | `ironhorse-vm/src/interp/intrinsic_order.rs:39-89` | Runs of global constructor names shared by two different XS tables (`gxIDStrings` and the global key order) | Not a clone; but `DEFAULT_KEYS` has drifted from the pin (F1) |
| 16 | 21 | `ironhorse-vm/src/interp/natives/buffer.rs:236-259` (`array_buffer_slice`) | `:559-582` (`shared_array_buffer_slice`) | `slice` | Acceptable: the spec has two algorithms with different detach checks |
| 17 | 20 | `xs-oracle/examples/modprobe.rs:41-69` | `examples/probe.rs:66-94` | Example scaffolding | Acceptable |
| 18 | 20 | `ironhorse-snapshot/src/image.rs:10808-10829` | `:9473`, `:10022` | Per-module `check` helpers in inline tests | Acceptable (test) |
| 19 | 19 | `ironhorse-vm/src/interp/natives/array.rs:284-302` (`array_from_inner`) | `:668-686` (`array_from_async`) | `Array.from` / `Array.fromAsync` prologue | Acceptable: two spec algorithms |
| 20 | 19 | `ironhorse-vm/src/interp/natives/dispatch.rs:222-243` | `:276`, `:341` | Intl constructors' `localeMatcher` option stanza | Low (F8) |
| 21 | 19 | `ironhorse-vm/src/interp/natives/dispatch.rs:3679-3701` | `:3849-3871` | Dense `find`/`findIndex` against `findLast`/`findLastIndex`; only the loop direction differs | Low (F5) |
| 22 | 18 | `ironhorse-meter/src/sha256.rs:67-87` (`update`) | `:116-136` (`raw_update`) | Block absorb loop; `update` is `raw_update` plus a length add | Trivial fix |
| 23 | 18 | `ironhorse-vm/src/interp/natives/array.rs:400-424` | `property/object.rs:178-202` | GetIterator plus `next` validation | Hazard, low (F4) |
| 24 | 18 | `ironhorse-vm/src/interp/natives/array.rs:4597-4618` | `natives/buffer.rs:736-757` | Array and TypedArray `toLocaleString` | Hazard, low (F5) |
| 25 | 18 | `ironhorse-vm/src/interp/apply.rs:191-213` | `:368-398` | CreateListFromArrayLike dense fast path | Hazard, low (F3) |
| 26 | 17 | `ironhorse-vm/src/interp/property/integrity.rs:189-211` (`harden`) | `:270-291` (`petrify`); third loop in `set_integrity_level` (`:307`) | Integrity-stamping loop | Hazard, already diverged once (see above) |
| 27 | 17 | `ironhorse-vm/src/interp/natives/dispatch.rs:3651-3670` | `:3509`, `:3604`, `:3769`, `:3821` | Dense callback loop of `every`/`some`/`forEach`/`map`/`filter` | Low (F5) |
| 28 | 16 | `ironhorse-vm/src/interp/natives/array.rs:344-367`, `property/object.rs:135-153` | `iterable.rs:82`, `natives/collection.rs:487` | Primitive receiver to wrapper prototype for GetMethod | Hazard: 13 copies (F4) |
| 29 | 16 | `ironhorse-vm/src/interp/natives/promise.rs:1189-1208` | `natives/regexp.rs:120-139`; also `natives/buffer.rs:180-215` | SpeciesConstructor, three verbatim copies | Hazard (F4) |
| 30 | 16 | `ironhorse-vm/src/interp/frames.rs:405-420` | `suspend.rs:281`, `:472`, `:734`, `:949` | Push a driver `CallerState` | Hazard (F3, FN-19) |

Pairs that only the literal-normalized scan finds, and that matter:

- `rust/engine/ironhorse-snapshot/src/store.rs:2971-3144` (122 lines, the largest run of either
  scan) is one inline test, `small_section_framing_refusals`, made of five case blocks that differ
  in constants.
  Acceptable; a table-driven loop would be shorter.
- `rust/engine/ironhorse-vm/src/interp.rs:3490-3519` against
  `rust/engine/ironhorse-vm/src/interp/native_ids.rs:1301-1330` (30 lines):
  `native_unsupported_name` and `display_name`, two exhaustive maps from `Native` to a name (F1).
- `rust/engine/ironhorse-snapshot/src/machine.rs:1633-1657` against `:1743-1761` (17 lines): the
  partial and generational collector preambles (F11).
- `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1310-1325` against `:1371-1386`: plain
  `replace` against plain `replaceAll` (F6).
- `rust/engine/ironhorse-262/src/compile_diff.rs:279-301` against `:317-339`: the script and module
  compile differentials, which differ deliberately in the runtime-`SyntaxError` recovery (F12).

Of the 30 exact pairs, six are test, example or prototype code (rows 2, 6, 7, 9, 17, 18; row 6
matters only because the spike copies the shipped worker), four follow XS or the spec or are not
copies at all (rows 11, 15, 16, 19), one is a trivial fix (row 22), and the other 19 are real
maintenance hazards, most of them low.
The scan sees only copies of ten or more statements; most of the families below are made of
shorter idioms repeated many times, which were found by the region reviewers or by grep.

## Duplication families

Families are merged across regions and deduplicated.
Severities are final (see above); "map row" means a duplication-inventory row that no finding
covers.

| Family | Copies | Size | Diverged? | Findings (final severity) |
|---|---|---|---|---|
| F1 Parallel built-in registration tables | 5-9 lists per method, about 12 per constructor; 2 + 2 + 5 linker install copies | about 400 method variants, 53 constructors, 534 default keys | Yes (`DEFAULT_KEYS` against XS, COV-17) | BOOT-10, BOOT-11, COV-17 (low); BOOT-2 (medium) |
| F2 `[[Get]]`/`[[Set]]` walks, by-index twins, key resolution | 3 Get + 4 Set walks; 5 by-index MOP twins; 4 ToPropertyKey, 7 index-to-name, 9 interning entry points | about 1,300 lines | Yes | PROP-11, PROP-12 (low); PROP-1, NOBJ-1 (high); BOOT-2 (medium) |
| F3 Suspension drivers, frame records, call plumbing | 4 drivers, 4 frame records, 5 driver pushes, 13 native frame pushes | about 700 lines of drivers | Yes | FN-19 (low), FN-11 (medium) |
| F4 Iterator protocol, primitive receivers, SpeciesConstructor | 13 + 3 + 14 + 6 + 5 copies | 10-60 lines each | Yes (`groupBy`) | NOBJ-10, FN-13 (medium); BOOT-11 (low) |
| F5 Array dense/generic paths, TypedArray re-implementations, native dispatcher | 32 methods twice; 17 slot-detach sites; 392 routed variants | about 4,700 lines of Array paths, plus 550 of TypedArray copies | Yes | NOBJ-NEW-1, NOBJ-2, MEM-4 (high); NOBJ-12 (medium) |
| F6 GetSubstitution, range searches, regexp tables | 3 + 2 + 4 + 3 | about 300 lines | No | RGX-7 (low) |
| F7 Compiler/VM numeric and lexical helpers | 2-7 copies per helper | about 450 lines | Yes | CMP-13, CMP-10, NVAL-16 (low); CMP-7, NVAL-10, NVAL-11 (medium) |
| F8 Temporal, Date, Intl arithmetic and formatting | 2-8 copies per concept | about 1,300 lines | Yes | NVAL-2 (high); NVAL-8, NVAL-7 (medium); NVAL-14 (low) |
| F9 Persistence validation across decoder, roster and restore | 3 layers; 4 body walks; 25 wrappers; 32 encoders | about 4,200 lines of validation | Yes | SNI-11 (low); SNI-6, SNI-1, SNI-2, SNI-4 (medium) |
| F10 Per-row GC knowledge and meter arithmetic | 3 GC walks, plus 2 persistence walks; 5 chunk-cost formulas | about 730 lines of walks | Partly | MEM-9, MEM-8 (low) |
| F11 Store backends and restore paths | 6 schema gates, 10 row-length checks, 2 restore sequences, 3 commit merges | about 800 lines | Yes | SNS-4 (medium); SNS-12, SNS-13 (low) |
| F12 Compile-error classification and the compiler adapter | 6 classifier sites; 21 adapter mappings; one 179-line verbatim copy | about 700 lines | Yes | INT-3 (medium); T262-14, T262-12, INT-13, INT-8 (low) |
| F13 Fuzz, oracle and test262-harness helpers | 14 harness rows, 13 integration rows | about 1,000 lines | Yes | T262-3, INT-5 (low) |
| F14 Interpreter dispatch idioms | 9 idioms, 5-43 copies each | about 500 lines | No | none |

### F1. Parallel built-in registration tables

**Copies.**
Adding one built-in method touches five to nine hand-maintained lists, and a constructor about
twelve (BOOT-10, verified by tracing `Object.assign` and `Array.prototype.at`):

| List | Location |
|---|---|
| `NativeMethod` variant (about 396 variant lines) and `Native` (53 constructors) | `rust/engine/ironhorse-vm/src/interp/native_ids.rs:55-1130`, `:1141` |
| `Native::display_name`, `arity`, `intrinsics` | `native_ids.rs:1287`, `:1350`, `:1419` |
| `Native` to `native-call:<name>` halt label, again an exhaustive match | `rust/engine/ironhorse-vm/src/interp.rs:3449-3530`, with the label strings registered in `rust/engine/ironhorse-vm/src/halt_labels.rs` |
| Boot registration and roster push (364 lines of `boot.rs` name a `NativeMethod`) | `rust/engine/ironhorse-vm/src/interp/boot.rs:687`, `:1545-1546` |
| XS key-order ranks | `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:36` (`GLOBAL_KEY_ORDER`), `:114` (`INTRINSIC_KEY_ORDER`) |
| Method router and family bodies | `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:2144-2633` (396 variant mentions) and 13 `native_method_*` families, each ending `_ => unreachable!("not one of the ... methods")` (for example `:6324`) |
| Frame-class groups | `natives/dispatch.rs:2329`, `:2526` |
| XS default keys (metering) | `rust/engine/ironhorse-meter/src/default_keys.rs:9` (534 names) |
| `ARRAY_UNSCOPABLES` | `interp.rs:639` |
| Implicit-read dependency gates | `rust/engine/ironhorse-vm/src/interp/link.rs:189-231`, `:425-562` |
| `@@toStringTag` strings | `link.rs:888-971` (the tags are also listed per holder in `INTRINSIC_KEY_ORDER`) |
| Boot-identity fingerprint fields and their test inventory | `boot.rs:177-324` (about 70 hand-listed fields), `boot/tests.rs` |
| Snapshot roster and section lists | `RESTORE_ROWS` (`rust/engine/ironhorse-vm/src/interp/restore.rs:7-32`, 25 rows), roster payloads (34), `SnapshotSection` (34), atom tags (38), side-table ledger (42), required core atoms (`rust/engine/ironhorse-snapshot/src/image.rs:5426`) |

Regenerated artifacts follow every change: seven snapshot fixtures, the inline digests in
`metamorphic_determinism.rs`, the fuzz seed corpus and the whole-tree key-order expectations.

The linker also repeats three install steps by hand (short paths are under
`rust/engine/ironhorse-vm/src/interp/`):

| Concept | Copies |
|---|---|
| Global-binding value and flag selection (BOOT-11, low, as verified) | `install_global_intrinsic_binding` (`rust/engine/ironhorse-vm/src/interp/link.rs:235-305`) against `materialize_runtime_global` (`link.rs:1663-1702`): the same three-way choice (intrinsic through `compartment_evaluator`, value global, `globalThis`) and the same flags |
| `@@species` accessor install, two mechanisms | Promise, RegExp and ArrayBuffer by hand, three 16-line blocks that each find their getter by scanning `functions` (`link.rs:1006-1056`); Array, Map, Set, SharedArrayBuffer and `%TypedArray%` through the `proto_accessors` roster (`rust/engine/ironhorse-vm/src/interp/boot.rs:2299-2321`, `create_species_accessors`) (`../maps/vm-boot-realm-modules.md:711`) |
| Install-state save, `catch_unwind`, restore, `resume_unwind` | five copies: `link.rs:1505-1519`, `:1526-1536`; `property/keys.rs:244-255`; `realm.rs:938-972`; `natives/compartment.rs:132-178` (`../maps/vm-boot-realm-modules.md:715`) |

**Diverged?**
The method router and its 13 families agree today: 392 routed variants, none missing from its
family (`../probes/dup/router_check.out`).
Because each family ends in `unreachable!`, a future mismatch would be a host panic on the first
guest call to that method, not a compile error.
`DEFAULT_KEYS` has drifted from the XS pin it says it was "generated from".
Evaluating `gxIDStrings` (`c/moddable/xs/sources/xsCommon.c`) under the flags the oracle and daemon
builds use (`mxImmutableArrayBuffers` defaults to 0 in `c/moddable/xs/sources/xsCommon.h:92-93`, and
`rust/engine/xs-oracle/build.rs` does not set it) gives 532 keys; `DEFAULT_KEYS` has 534, adding
`immutable` and `transferToImmutable` (`default_keys.rs:535-536`).
With the flag set to 1, XS has 535 keys, including `sliceToImmutable`, which `DEFAULT_KEYS`
lacks (`../probes/dup/default_keys_vs_xs.out`).
The table matches neither configuration.
Default-key membership decides whether creating a runtime key or property charges XS's `fxNewSlot`
(`rust/engine/ironhorse-vm/src/interp/property/keys.rs:29-33`,
`rust/engine/ironhorse-vm/src/interp/environment.rs:80-93`), so a guest key `"transferToImmutable"`
is charged less than the as-built XS charges, and the table is hashed into the cost-table identity
(`rust/engine/ironhorse-meter/src/lib.rs:337-338`).
This lens made the observation statically; COV-17 (low) verified it and measured it.
A dual run against the oracle measures −280 raw (1/234 computron) per affected creation:
relative to the oracle, IronHorse charges a static `transferToImmutable` or `immutable` key 280
raw less than a same-length control name
(`rust/engine/ironhorse-meter/src/default_keys.rs:535-536`; full entry: `../COVERAGE.md`).
Computron parity with XS is a declared non-goal (`rust/engine/ironhorse-262/src/lib.rs:250-254`),
so the drift matters for documentation and parity telemetry only.
It is a finding of its own, not part of BOOT-10, which covers the parallel tables.
No generator or pin comparison is checked in; `default_keys_vs_xs.py` is one.
The overlap that the scan reports between `default_keys.rs` and `intrinsic_order.rs` is two
distinct XS tables that list the same global names in the same order; it is not a copy.

**Consequence.**
BOOT-10 is low.
A forgotten dependency gate yields the BOOT-2 class of missing intrinsic members (medium); a
forgotten rank yields XS-divergent key order.

**Recommendation.**
One declarative table per holder (name, arity, variant, attributes, frame class, tag, family,
unscopable, implicit reads) from which a macro generates boot registration, ranks, the router,
the halt labels and the tag install, as `interp_state!` already does for interpreter fields.
Make each family's dispatch exhaustive by matching on a per-family sub-enum instead of
`NativeMethod` with an `unreachable!` arm.
Generate `DEFAULT_KEYS` from `xsCommon.c` under the oracle's flags, and add a test that compares
it with the pin.

### F2. `[[Get]]`/`[[Set]]` walks, by-index twins and key resolution

**Copies** (short paths are under `rust/engine/ironhorse-vm/src/interp/`):

| Concept | Copies |
|---|---|
| Ordinary `[[Get]]` prototype walk | `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:525` (`ordinary_get`), `:594` (`ordinary_get_walk`), `:684` (`get_in_place_walk`); prefix again in `rust/engine/ironhorse-vm/src/interp/property.rs:1445` |
| Ordinary `[[Set]]` walk | `property/ordinary.rs:794` (`set_in_place_walk`), `:856` (`ordinary_set`), `:922` (`ordinary_set_walk`); `rust/engine/ironhorse-vm/src/interp/property/indexed.rs:771` (`index_set_walk_held`) |
| By-index twins of MOP methods | `rust/engine/ironhorse-vm/src/interp/property/read_index.rs` (506 lines: get `:60`, has `:234`, own descriptor `:279`, delete `:341`, proxy `has` `:442`) against `property.rs` `mop_get`, `:1300`, `:1067`, `:2084` and `property/proxy.rs:625` |
| Own-property presence | `property.rs:1096-1193` (`object_own_property_present`) against `:1067` plus `:1704`; `property/read_index.rs:183` |
| `[[Delete]]` | `DELETE_PROPERTY_AT` in `rust/engine/ironhorse-vm/src/interp/dispatch/property_write.rs:207-334` against `mop_delete` |
| Descriptor-to-flag application | `property/indexed.rs:425-445`, `:488-508`, `:1002-1022`; `property/ordinary.rs:369-385` (exact-scan runs at `property/indexed.rs:424`, `:487`, `:1002`) |
| Function `length`/`name` synthesis | `property/ordinary.rs:114-140` against `property.rs:1750-1775` |
| ToPropertyKey plus intern | `property/keys.rs:405`, `:447`, `:634`, `:713` |
| Index to name | `property/keys.rs:559`, `:618`; `property/indexed.rs:564`; `natives/array.rs:2056`, `:2069`; inline at `property.rs:643` and `render.rs:80` |
| Key interning entry points | `property/keys.rs:22`, `:75`, `:84`, `:97`, `:111`, `:126`, `:166`, `:183`, `:214` |
| Item-flag to descriptor | 4 copies: `property/indexed.rs:394-401`, `:728-740` (`index_prop_descriptor`), `:1099-1107`; `property/read_index.rs:309-316` (`../maps/vm-property-model.md:796`) |
| Raw "prepend a property slot" | 8 copies: `property/ordinary.rs:296-300`; `rust/engine/ironhorse-vm/src/interp/property/descriptors.rs:16-24`, `:39-45`; `rust/engine/ironhorse-vm/src/interp/environment.rs:9-20`, `:343-354`, `:370-386`, `:403-420`; `rust/engine/ironhorse-vm/src/interp/function.rs:567-574` (`../maps/vm-property-model.md:797`) |

**Size.**
About 600 lines of walks (PROP-11), about 500 lines of by-index twins, about 130 lines of
`DELETE` twin, and 20 smaller copies.

**Diverged?**
The walks agree today: PROP-11 found no live divergence by probe, and PROP-12's 26-case dual-key
probe matches Node except for implementation-defined function own-key order.
The key-resolution copies have diverged: the write twins intern index spellings (PROP-1, high;
NOBJ-1, high), and the passless interning variants leave intrinsic members
uninstalled (BOOT-2, medium).
The `DELETE` twin diverged twice in the past (comment at `property_write.rs:285-308`).
The prepend-slot copies disagree in metering (static, not probed):
`define_descriptor_field` (`property/descriptors.rs:16`) ticks `tick_slot_alloc`, but its
key-slot twin `define_descriptor_field_slot` (`:29-46`) does not.
The latter adds every key of `Object.getOwnPropertyDescriptors` on a proxy
(`rust/engine/ironhorse-vm/src/interp/property/object.rs:485-496`).
The walks are held together only by comments such as "keep the two in step"
(`property/ordinary.rs:593`, `:659`, `:775`, `:918`).

**Recommendation.**
Make an array index a key variant end to end (`PropertyKey::{Index(u32), Name(u16),
Symbol(u16)}`) and never intern its spelling; this removes most by-index twins.
Write one walk generic over the key kind and a continuation enum (`Value`, `Delegate(proto)`,
`EnterGetter`, `EnterSetter`), with `#[inline(always)]` wrappers to keep the stack-depth frame
sizes.
Replace the nine interning functions with one entry point taking explicit policy (admitted or
reserved, metered or not, install pass or not), so a call site states the policy instead of
picking a copy.
Route `DELETE_PROPERTY_AT` through `mop_delete`.

### F3. Suspension drivers, frame records and call plumbing

**Copies** (short paths are under `rust/engine/ironhorse-vm/src/interp/`):
Four resume drivers: `rust/engine/ironhorse-vm/src/interp/suspend.rs:224-411`
(`resume_generator`), `:425-525` (`resume_generator_in_place`), `:700-880`
(`step_async_generator`), `:901-1121` (`step_async`), about 690 lines.
Four frame records that move the same activation state: `CallerState`, `CatchJump`,
`SavedFrame`, `SavedJump` (`rust/engine/ironhorse-vm/src/interp.rs:2138`, `:2259`, `:2313`,
`:2344`).
Inside them: the driver `CallerState` push (`frames.rs:404-421`; `suspend.rs:281-300`,
`:472-489`, `:734-753`, `:949-968`), resume admission (4 copies), abandon cleanup (8 copies),
the "#1046" non-boundary-return guard (`suspend.rs:379`, `:833`, `:1050`) and cross-segment
selection (7 copies in `invoke.rs`, `suspend.rs`, `apply.rs`).
Next, return and throw are two enums for one concept, `GenStatus` and `ResumeStatus`
(`rust/engine/ironhorse-vm/src/interp.rs:2362`, `:2462`): the `GenStatus` to `ResumeStatus`
mapping is written three times (`suspend.rs:313-317`, `:498-502`, `:645-649`), plus once from
`NativeMethod` to `GenStatus` (`invoke.rs:712-716`; `../maps/vm-functions-async.md:687`).
The dispatch loop repeats the matching shapes: "return to the caller like `END`" four times
(`rust/engine/ironhorse-vm/src/interp/dispatch.rs:4180-4237`, `:4290-4317`, `:4425-4452`,
`:4492-4521`) and the innermost-driver suspend four times (`:4337-4394`, `:4547-4596`).
Call plumbing (`../maps/vm-functions-async.md`): native frame push (13 copies),
CreateListFromArrayLike with its dense fast path (3 copies; exact-scan pairs `apply.rs:191`
against `:368` and `:257` against `:332`), `Function.prototype.call` forwarding (3), bound-chain
walks (5), and error-object construction (5, in `errors.rs` and `natives/promise.rs:2039-2064`).

**Diverged?**
Yes (FN-19, low).
`SavedFrame` has no `this_captures` field although `CallerState` does, and the probe shows the
guest-visible result.
The async drivers tick `GENERATOR_RESUME_METERING` only when `!is_start` (`suspend.rs:729-731`,
`:939-944`) while the generator drivers always tick (`:276`, `:469`), with no recorded reason.
FN-11 (medium) is the `id_map` that all four records move.

**Recommendation.**
One `Activation` struct shared by `CallerState` and `SavedFrame`, so a field cannot be dropped on
one path, and one jump type with a relative/absolute flag.
One `run_suspended(kind, ...)` with a small per-kind epilogue, and one `return_to_caller(value)`
in the dispatch loop.
Decide the `is_start` metering rule once.

### F4. Iterator protocol, primitive receivers and SpeciesConstructor

**Copies** (short paths are under `rust/engine/ironhorse-vm/src/interp/`):

| Concept | Copies |
|---|---|
| Primitive receiver to wrapper prototype | 13 copies of the `Kind` match, starting at `rust/engine/ironhorse-vm/src/interp/property.rs:72`, `invoke.rs:314`, `natives/array.rs:354`, `:640`, `natives/annex_b.rs:154`, `natives/collection.rs:492`, `:2758`, `natives/dispatch.rs:6414`, `natives/promise.rs:1656`, `natives/buffer.rs:861`, `dispatch/iteration.rs:31`, `property/object.rs:140`, `iterable.rs:87` |
| SpeciesConstructor | three verbatim copies differing only in the default intrinsic: `natives/promise.rs:1177-1210`, `natives/regexp.rs:104-139`, `natives/buffer.rs:180-215` |
| Hand-rolled IteratorStep (call `next`, require an object, read `done` and `value`) | 5 or more in the natives region (`natives/collection.rs:2275-2294`, `:2785-2791`; `natives/buffer.rs:905-936`; `natives/array.rs:435-491`; `natives/collection.rs:550-613`) |
| 1,000,000-step iterator loop | the 11 the natives map lists (`natives/array.rs:435`; `natives/collection.rs:550`, `:1324`, `:1352`, `:1431`, `:1580`, `:1843`, `:2784`; `natives/buffer.rs:905`; `natives/promise.rs:1741`; `natives/intl.rs:883`), plus `property/object.rs:213`, `iterable.rs:179` and `natives/promise.rs:1900` |
| Iterator-protocol name interning with dead cache seeding | `link.rs:448-468`, `:470-485`, `:494-509`, `:520-530`, `:544-554`; `natives/array.rs:606-625` |
| "Is the intrinsic `then`" test | `natives/promise.rs:719-722`, `:1313-1315`, `:1512-1515`, `:1843-1846` |

**Diverged?**
The wrapper-prototype copies reach `%Boolean.prototype%` two ways: four read the cached
`boolean_proto` field and nine look up `intrinsics["Boolean"]` and then `ctor_prototype`.
They agree today.
A helper exists, `primitive_wrapper_prototype` (`natives/annex_b.rs:153`), and is used once.
One copy once lacked the Symbol arm (`property.rs:64-71`).
The iterator-loop copies diverged in outcome: `groupBy` truncates while the rest halt `StepLimit`
(NOBJ-10, medium; FN-13, medium, for the promise and IterableToList copies).
BOOT-11 (low) verified the cache seeding in the six interning blocks as dead.

**Recommendation.**
Make `primitive_wrapper_prototype` `pub(in crate::interp)` and use it at all 13 sites; one
`species_constructor(code, obj, default)`; one `IteratorRecord` with `step`, `value` and `close`
used by every built-in that drains an iterator, with no step cap (the meter bounds it).
Replace the six interning blocks with one `implicit_reads` table (BOOT-11).

### F5. Array dense/generic paths, TypedArray re-implementations and the native dispatcher

**Copies** (short paths are under `rust/engine/ironhorse-vm/src/interp/`):

| Concept | Copies | Size |
|---|---|---|
| Array methods with a dense fast path and a generic MOP path | dense `natives/dispatch.rs:3491-3879`, `:4161-5455`; generic `natives/array.rs:2044-4600`; gates `natives/array.rs:1579-2042` | 32 methods; about 1,680 dense against 2,550 generic lines, plus 460 lines of gates |
| Dense-path fallback stanza (`let result = self.array_generic_*(...)?; truncate; push; return`) | 33 in `natives/dispatch.rs` | 5 lines each |
| Slot-detach idiom (`v.id = 0; v.next = NULL`) | 17 sites in `rust/engine/ironhorse-vm/src` (9 in `natives/dispatch.rs`, 4 in `natives/intl.rs`, and `errors.rs:268`, `natives/array.rs:1329`, `natives/collection.rs:2905`, `property/indexed.rs:89`); only `realm.rs:1174-1176` (`root_value`) also clears `flag` | 3 lines each |
| TypedArray read-only algorithms re-implementing the Array generic ones | `natives/buffer.rs:1406-1620` against `natives/array.rs:3895-4230` | about 215 against 335 lines |
| Sort | `natives/array.rs:4284-4330` (merge) against `natives/buffer.rs:1333-1393` (insertion) | 47 + 62 lines |
| TypedArray element coercion | `natives/buffer.rs:1873-1938`, `:2077-2140`, `:2252-2269` | 60 + 60 + 20 lines |
| "BigInt kind ? `get_bigint` : `get`" | 9 copies although `ta_element_value` (`natives/buffer.rs:641`) exists | |
| Byte copy through a temporary `.to_vec()` | 8 in `natives/buffer.rs` | |
| Argument read `self.stack.get(base + 4 + i)...` | about 155 occurrences and 12 identical `let arg = \|...\|` closures | |
| Method router against family bodies | `natives/dispatch.rs:2144-2633` against 13 families | 396 + 404 variant mentions |
| Boot method recovered by scanning all functions | `natives/array.rs:2448-2454`, `natives/collection.rs:248-254`, plus 8 sites in `link.rs`, `intrinsic_order.rs:1243`, `boot.rs:2300` | |

**Diverged?**
Yes, three ways.
The slot-detach copies in the dense paths keep the operand's flag (NOBJ-NEW-1, high).
The TypedArray sort is the quadratic copy, and TypedArray `fill`/`reverse` charge nothing per
element (NOBJ-2, high; MEM-4, high).
The TypedArray prototype lacks the `toSorted`, `toReversed` and `with` that Array has
(NOBJ-12, medium), a parity gap between the two families.
Recovering `%Object.prototype.toString%` by scanning every function on each call is part of
NOBJ-4 (high).
The router and the families agree today (F1).

**Recommendation.**
A `Slot::stored_element(v)` constructor that clears `id`, `next` and `flag`, used at all 17
sites.
TypedArray methods built on the Array algorithms over an element-access trait, or at least the
shared stable merge sort with a typed numeric fast path.
Cache boot identities in fields instead of scanning `functions`.
A `NativeArgs` view (`args.get(i)`) in place of the closures.

### F6. GetSubstitution, range searches and regexp tables

**Copies.**
`GetSubstitution` three times in `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs`:
`:1273-1303` (string pattern), `:1750-1841` (generic `@@replace`), `:1920-2020` (fast RegExp path),
about 224 lines (RGX-7, low).
The sorted half-open range search twice: `rust/engine/ironhorse-regexp/src/matcher.rs:102-119`
and `rust/engine/ironhorse-regexp/src/compile.rs:3366-3381`, with a related `(code, count)`
variant at `rust/engine/ironhorse-regexp/src/charcase.rs:2475` and the linear delta scans of
`rust/engine/ironhorse-unicode/src/lib.rs:134-175`.
Flag letter to bit mapping at four sites (`compile.rs:593-603`; `natives/regexp.rs:8-39`,
`:185-194`; `rust/engine/ironhorse-vm/src/interp.rs:3535`).
Plain against regexp `replace`/`replaceAll`/`split` scans (`natives/regexp.rs:1309`, `:1370`,
`:2235`).
`ID_Start`/`ID_Continue` in two encodings: `ironhorse-unicode`'s XS-ported delta pairs (lexer and
group names) and `BINARY_PROPERTY_ID_START`/`_ID_CONTINUE` in
`rust/engine/ironhorse-regexp/src/unicode_properties_generated.rs:1544`, `:1407` (`\p{...}`).
In the generated tables, 74 `Script_*` tables are byte-identical to their `Script_Extensions_*`
twins (about 7.4 KB).

**Diverged?**
No.
RGX-7's verifier ran 15 replacement templates through all three `GetSubstitution` paths and
matched Node; the compile map measured the two identifier datasets equal.
The forward and backward capture-reference steps in `matcher.rs:396-415` and `:460-479` differ
deliberately: the backward step keeps XS's byte arithmetic, and the regexp map records this as
a documented XS-faithful quirk.

**Recommendation.**
One `get_substitution(matched, subject, position, captures: &dyn CaptureSource, replacement)`
and one `range_contains(ranges, c)` shared by compiler and matcher (RGX-7).
Generate both identifier encodings from one source, and let `lookup_script_extensions` share a
static where the two script tables are equal.

### F7. Compiler/VM numeric and lexical helpers

**Copies** (`parser.rs`, `lexer.rs` and `coder.rs` are in `rust/engine/ironhorse-compile/src/`;
other short paths are under `rust/engine/ironhorse-vm/src/interp/`):

| Helper | Copies | Size |
|---|---|---|
| `number_to_ecma_string` | `rust/engine/ironhorse-compile/src/parser.rs:2357` and `rust/engine/ironhorse-vm/src/value.rs:3062` | 42 non-comment lines each, identical but for `pub` |
| Canonical array index | `parser.rs:2316` (`string_key_to_index`), `:2339` (`number_to_index`) against `rust/engine/ironhorse-vm/src/interp/numeric.rs:550` (`string_to_index`) | 18 lines each |
| Decimal or radix digits to base-2^32 limbs | `rust/engine/ironhorse-compile/src/coder.rs:6556-6582` against `rust/engine/ironhorse-vm/src/interp/bigint.rs:428-470`; within the VM `bigint.rs:382-423` against `:428-474` | about 25 + 40, and 30 shared lines |
| Radix digits to `f64` | `rust/engine/ironhorse-compile/src/lexer.rs:874-879`; `numeric.rs:84-99` (`parseInt`), `:233-242` (`Number()`) | 3 loops |
| ECMAScript WhiteSpace | `lexer.rs:265-289`; `rust/engine/ironhorse-vm/src/interp/text.rs` (`is_ecma_whitespace`); `rust/engine/ironhorse-regexp/src/compile.rs:1205-1225` | 3 hand lists |
| Hex digit | `lexer.rs:1450`, `:1459`; `rust/engine/ironhorse-regexp/src/compile.rs:3292`; `natives/uri.rs:13`, `natives/annex_b.rs:14`, `natives/base64.rs:40`; JSON's `from_str_radix` (`natives/json.rs:1589-1591`) | 7 |
| `\u{...}` reader | `lexer.rs:1413-1447` (identifiers), `:1506-1560` (strings and templates) | 35 + 55 lines |
| ToUint16 | `natives/string.rs:73-80` against `numeric.rs:508-520` | |

**Diverged?**
`number_to_ecma_string` and the index test are identical today (CMP-13, low, confirmed by
comment-stripped diff), and they must stay identical: compile-time and run-time numeric key
canonicalization would otherwise name different keys for `{1e21: x}` and `o[1e21]`.
The escape readers diverged (CMP-10, low), the JSON hex reader diverged (NVAL-10, medium) and the
ToUint16 copy diverged (NVAL-16, low).
The three radix loops agree because they share CMP-7's and NVAL-11's double rounding (both
medium).

**Recommendation.**
Move `number_to_ecma_string`, `string_to_index`, `number_to_index`, one exact radix-to-number
conversion, the BigInt digit conversion, one hex-digit function, one WhiteSpace predicate and one
`\u` escape reader into `ironhorse-text`, which both crates already depend on
(`rust/engine/ironhorse-compile/Cargo.toml:19`, `rust/engine/ironhorse-vm/Cargo.toml:19`).
Fix CMP-7 and NVAL-11 together in that shared conversion.

### F8. Temporal, Date and Intl arithmetic and number formatting

**Copies** (all under `rust/engine/ironhorse-vm/src/`):

| Concept | Copies | Size |
|---|---|---|
| Exact decimal expansion of an `f64` | `interp/numeric.rs:604-620`; `intl_number.rs:241-278` | 17 + 38 |
| Digit rounding for formatting | `numeric.rs:625-676` (half-up only); `intl_number.rs:312-454`, `:467-532` (nine modes) | 50 + 200 |
| ECMA-402 rounding modes | `intl_number.rs:391-440` (enum); `interp/temporal.rs:720-781` (`f64`, `&str` mode, unknown mode falls to half-expand); `temporal.rs:1308-1373` (`i128`, `&str` mode, unknown mode returns `None`); `temporal.rs:783-791` | 4 implementations |
| Civil date from day number | `interp/date.rs:9-34`; `interp/temporal.rs:948-960` | 26 + 13 |
| ISO date and time parsers | `date.rs:109-179` (strict) and `:209-292` (XS legacy, a near copy); clock parsers `:181-202`, `:294-316`; Temporal `temporal.rs:181-252`, `:962-1019`, `:1103-1151`, `:1179` onward, `:1425-1446` | about 550 lines, seven or more parsers |
| BigInt decimal rendering | `interp/bigint.rs:351-378`; `interp.rs:3672-3708` | 28 + 37 |
| Temporal property-bag field reads | Plain: `interp/natives/temporal.rs:208-276` (`from`), `:333-408` (`with`); Zoned: `:1192-1244`, `:1417-1469` (the largest exact clone in the tree) | 69 + 76, 53 + 53 |
| Locale language extraction and supported-locale tables | `interp/locale.rs:259-265`, `intl_number.rs:916-922` (fallback `"en"` against `""`), `interp/text.rs:114`; 8 supported-locale tables | |
| UTC offset rendering | `locale.rs:445-463` (`GMT+H[:MM]`); `temporal.rs:1081-1099` (`+HH:MM[:SS[.f]]`) | |
| Date method numbering | `interp/boot.rs:2734-2790` (name to `u8`) against `interp/natives/date.rs:19-237` (`u8` to behaviour) | 37 operations |
| Intl option stanzas | `natives/dispatch.rs:222-243`, `:276`, `:341` (`localeMatcher`); `natives/intl.rs:392-410` against `:1107-1125` | |

**Diverged?**
Yes.
The two BigInt renderers differ by about seven orders of magnitude in charge for the same output
(NVAL-2, high).
The supported-locale tables disagree (NVAL-8, medium).
The ISO parsers differ in laxness: the legacy copy normalizes illegal field values that the
strict copy rejects (NVAL-14, low), and the offset grammars differ (`+HH` is accepted by the
legacy parser and the zone table, rejected by the strict one).
The two Temporal rounding copies treat an unknown mode differently (half-expand against `None`).
NVAL-7 (medium) records that Temporal's property-bag reads omit `overflow` handling; with two
copies of each bag reader, a fix must land four times.

**Recommendation.**
One rounding-mode enum with one `round(value, increment, mode)` per numeric representation; one
ISO grammar with a strictness parameter (and, per NVAL-14, run the legacy fallback only on a
grammar failure); one BigInt renderer with one charge; one Temporal field-bag reader per record
type taking the field list and the `overflow` option; one supported-locale predicate.

### F9. Persistence validation across decoder, roster and restore

**Copies.**
Row validation three times: structurally in the decoder (193 `Corrupt` sites in
`rust/engine/ironhorse-snapshot/src/image.rs`), in the roster gate
(`rust/engine/ironhorse-snapshot/src/snapshot_roster.rs`, 947 lines of gates), and in the VM
restore functions (`rust/engine/ironhorse-vm/src/interp/persist.rs`, `restore.rs`,
`shared_persist.rs`), about 4,200 lines in all (SNI-11).
The instruction-start walk over a function body four times (`image.rs:4942`,
`snapshot_roster.rs:1492`, `rust/engine/ironhorse-vm/src/interp/restore.rs:203`, `persist.rs:1795`),
and the nested-body subtraction twice (`snapshot_roster.rs:2069-2097`, `restore.rs:210-224`).
25 `RestoreSession` wrapper verbs kept in sync with `RESTORE_ROWS` by a source-guard test
(`restore.rs:394-604`, `:7-32`).
About 32 one-line `encode_X` to `Vec` wrappers in `image.rs`.
String-list and name-list codecs (`image.rs:837-844` against `:892-899`, `:846-884` against
`:901-939`; exact-scan pair `:847` against `:902`).
Cursor helpers re-spelled inline (4 boolean decoders, 2 `u64_value`, 3 or more `text`, 34
inline ascending-owner checks).
Two conventions for row types: older rows use snapshot-crate `*Image` structs, newer rows reuse
VM structs, bridged by `ArrayRowLike` and `CollectionRowLike` (`image.rs:1158-1215`,
`:1411-1460`).

**Diverged?**
Yes.
The gate checks owner liveness while the VM also requires `Kind::Instance`, and the HEAP falls
between the layers, so crafted containers are adopted (SNI-1, SNI-2, SNI-4: medium each after
pass 2 lowered them from high).
The four body walks are also why import cost is O(rows x body) (SNI-6, medium).

**Recommendation.**
Decide which layer is the semantic validator (the VM, which sees typed state) and keep the decoder
structural; validate the HEAP in one adoption pass (SNI-1/2/4).
One body-walk helper memoized per `(segment, body_start, body_len)` and shared by the gate, the
generator gate and VM restore (SNI-6).
Generate the 25 wrappers from `RESTORE_ROWS` with a macro, replace the `encode_X` wrappers with a
generic `encode_to_vec`, and give `Cursor` the missing primitives.

### F10. Per-row GC knowledge and meter arithmetic

**Copies** (short paths are under `rust/engine/ironhorse-vm/src/interp/`):
Every slot-bearing row type lists its fields in `gc_slot_row!` (marking,
`rust/engine/ironhorse-vm/src/interp/gc_tables.rs:416-683`), again in `gc_chunk!` (chunk offset
rewriting, `gc_tables.rs:153-385`), and for queued jobs a third time in `gc_root!`
(`rust/engine/ironhorse-vm/src/interp/roots.rs:9-237`), about 730 lines (MEM-9, low).
For example, `FromAsyncData`'s eight `Slot` fields appear at `gc_tables.rs:220-237`, `:623-636`
and `roots.rs:202-216`.
Persistence walks the same fields again
(`rust/engine/ironhorse-vm/src/interp/persistence.rs:15-120`, 19 `persist_holder!` arms;
`rust/engine/ironhorse-snapshot/src/stored_slots.rs` visitors).
Related map rows (`../maps/vm-memory-gc-meter.md`): chunk compaction twice
(`rust/engine/ironhorse-vm/src/value.rs:2711-2838` in production, `:2846-2943` test-only; MEM-8,
low), the chunk-cost formula `round_up_8(n) + 16` times the allocation weight five times
(`rust/engine/ironhorse-meter/src/lib.rs:313-318`;
`rust/engine/ironhorse-vm/src/interp/admission.rs:104-112`;
`property/indexed.rs:124-129`; `natives/array.rs:4234-4240`; `natives/json.rs:1184-1188`), and
two `ARRAY_ITEM_BYTES` constants with different meanings.

**Diverged?**
The GC walks agree as far as tests reach; `tests/gc_visitation_registry.rs` proves every
slot-bearing interpreter field is named by a walk and states that it cannot prove each subfield
is visited.
The chunk-cost copies already differ in overflow behaviour: `chunk_cost` saturates,
`charge_chunk_work` returns `MeterAbort`, and the array helpers use unchecked arithmetic.

**Recommendation.**
One `for_each_slot_mut(&mut self, f)` (or a derive) per row type, from which marking, chunk
rewriting, rooting and persistence visiting are generated.
All chunk charges through `ironhorse_meter::chunk_cost`.

### F11. Store backends and restore paths

**Copies** (from `../maps/snapshot-store.md`; paths under `rust/engine/ironhorse-snapshot/src/`
unless noted):

| Concept | Copies |
|---|---|
| Store-schema range gate | six sites: `store.rs:807`, `:1697`, `:1799`, `:1915`, `:2143`, `:2317` (SNS-12 verification; the map listed five) |
| Row length against geometry | 10 sites: `store.rs:1203-1235` (3), `:2230-2256` (2), `:2266-2275`, `:2332-2363` (2), `:2469-2497` (2) |
| Restore sequence | eager `machine.rs:494-528` against lazy `machine.rs:1469-1502`, and the lazy `StorePageSource` (`machine.rs:1396-1404`) |
| `StoreTracking` construction | `machine.rs:1009-1025`, `:1309-1327`, `:1513-1531` |
| Collector preamble | `machine.rs:1567-1575`, `:1637-1659`, `:1747-1763` |
| Per-backend commit merge | `store.rs:2850-2897`, `store_file.rs:625-718`, `rust/endo/ironhorse-store-sqlite/src/lib.rs:1106-1264` |
| Stored-content checks in the SQLite backend | `row_key` (`lib.rs:78-80`) against `page_col` (`lib.rs:70`) and the content checks at `:199`, `:202`, `:250`, `:541`, `:757`, `:955`, `:1070` |
| Empty-store gate on each read | 5 in `MemoryStore`, 7 in SQLite |
| `catch_store_fault` | `machine.rs:677-685`; `rust/endo/src/ironhorse_engine.rs:1071-1081` |
| Section digest | computed by the session (`machine.rs:1169`) and again by each backend |
| Scratch `TempDir` guard | `test_dir.rs:6-37`, `tests/common/mod.rs:6-42`, the SQLite crate's tests and `lib.rs:1655-1693` |

**Diverged?**
Yes.
The lazy page source does not repeat the eager path's length and decode checks and panics with an
untyped payload that every `catch_store_fault` copy re-raises (SNS-4, medium).
The same stored-content damage classifies Poisoned or Transient depending on which SQLite helper
notices it (SNS-13, low).
The six schema gates all classify a newer schema as Corrupt and Poisoned; after the first,
which runs in `StoreManifest::decode`, the others are mostly unreachable duplicates (SNS-12, low).

**Recommendation.**
One `check_schema(manifest)` raising a Refused-class variant; one `expected_row_len(kind,
manifest, index)` used by eager validation and by `StorePageSource`, raising a typed
`StoreFault`; one restore sequence parameterized by the arena source; one `corrupt(what)` helper
in the SQLite backend.
Keep the five page-reachability implementations (see the acceptable families).

### F12. Compile-error classification and the compiler adapter

**Copies.**
The mapping from `ironhorse_compile::ParseError` to the compile halt or `SourceCompileError` is
spelled out at 21 sites (INT-13, low).
Eleven are in shipped and prototype crates: `rust/endo/src/ironhorse_engine.rs:598-641`;
`rust/engine/ironhorse-runtime/src/lib.rs:44-85` and `:140-181`; two in
`rust/engine/ironhorse-262/src/lib.rs`; three in the thixotrope worker; three in the wasm spike.
Ten are in tests.
The worker's `Compiler`, `eval` and `crank_halted`
(`rust/thixotrope-ironhorse-worker/src/main.rs:17-195`) are byte-identical, ignoring whitespace,
to `rust/engine/wasm-worker-spike/src/session.rs:24-202` (179 lines).
Compile-error classification is written six ways in the harness (D9): `compile_failure_name`
(`rust/engine/ironhorse-262/src/lib.rs:118-156`), `compile_for` (`lib.rs:395-410`), three sites in
`rust/engine/ironhorse-262/src/xst.rs` (`:1770-1774`, `:1845-1848`, `:2032-2035`) and
`compile_diff.rs:137-146`.
"The oracle rejected the parse" is decided from error text containing `SyntaxError` in
`compile_diff.rs:143` and in the fuzz crate (`rust/engine/ironhorse-fuzz/src/lib.rs:2302-2307`),
but from emitted bytecode in `xst.rs`.
`catch_unwind(compile_atoms*)` appears at ten sites, each mapping the outcome its own way (D7).

**Diverged?**
Yes.
Only `ironhorse-runtime`'s adapter overrides `compile_eval_units`, so the worker's copy compiles a
different program for direct `eval` (INT-3, medium).
`compile_failure_name` classifies `MeterLimit` and `Overflow` as resource stops while `compile_for`
counts them as correct early-error rejections (T262-14, low; latent while the harness compiles with
an unbounded meter).
The two "oracle rejected" tests disagree on a parsed program that throws `SyntaxError` at run time
(T262-14, INT-8, both low).
The legacy `test262.rs` runner classifies a BothAbort mismatch as a skip where `xst.rs` makes it a
Fail (T262-12, low).

**Recommendation.**
One exhaustive `classify_compile_error(&ParseError) -> {Syntax, Unsupported, Resource}` (or a
`From<CompileError> for SourceCompileError`) in `ironhorse-runtime`, used by every embedder, the
harness and the tests.
Make the worker depend on `ironhorse-runtime` and delete both private adapters; remove the trait
default for `compile_eval_units` so a compiler that cannot honour the eval context must say so.
One compile-only oracle entry for "XS rejected the parse", shared by the harness and the fuzz
target.
Delete the legacy runner (T262-12).

### F13. Fuzz, oracle and test262-harness helpers

**Copies.**
Test262 harness (`../maps/test262-harness.md`, rows D1-D14; paths under
`rust/engine/ironhorse-262/src/`):

| Row | Concept | Copies | Note |
|---|---|---|---|
| D1 | Sloppy/strict verdict fold | `xst.rs:1632-1650`, `:2206-2232` | byte-identical arms |
| D2 | Halt pre-classification | 7 copies (`xst.rs:546-561`, `:671-680`, `:1246-1256`, `:1269-1278`, `:2078-2087`; `lib.rs:1013-1036`; `test262.rs:123-159`) | subtly different arms |
| D3 | `CaseResult` literal | 28 constructions in `xst.rs` | |
| D4 | Synthetic "did not run" `RunOutcome` | `lib.rs:481-494`, `:535-548`, `:559-572`, `:674-687` | |
| D5 | Agreement derivation | `lib.rs:747-775` against `xst.rs:1974-2008` | |
| D6 | Panic payload to string | `lib.rs:430-443`, `xst.rs:2617-2628`, `compile_diff.rs:184-192` | three different fallbacks |
| D8 | Mode and goal selection | `xst.rs:1563-1576`, `:2527-2539`, `:2659-2670` | the third forgot the module goal |
| D10, D11 | Row emission and string quoting | `report.rs:562-581` against `:610-628`; `yaml_quote` (`xst.rs:2474-2487`) against `json_str` (`report.rs:649-665`) | `yaml_quote` lacks `\r`, tab and control escapes |
| D12, D13 | Carve-outs and the reason vocabulary | 3 carve-out mechanisms; reason strings kept in sync by hand in five places | |
| D14 | Test assembly | `test262.rs:81-111` (concatenate) against `xst.rs:464-523` (split) | the live split copy is the one behind T262-2 (medium) |

Integration, fuzz and oracle (`../maps/integration-fuzz-oracle.md`):
the fuzz crate's halt skip pre-check (`rust/engine/ironhorse-fuzz/src/lib.rs:1861-1891`) bypasses
`is_skip_eligible_label`, which documents itself as "the one predicate every discard site consults"
(`rust/engine/ironhorse-262/src/xst.rs:1115-1119`); three differential-check bodies
(`rust/engine/ironhorse-fuzz/src/lib.rs:1898-1920`, `:1940-1986`, `:1993-2028`); two
result-comparison policies, of which the fuzz one
(`rust/engine/ironhorse-fuzz/src/comparison.rs:5-21`) never compares thrown values while
`observables_agree` (`rust/engine/ironhorse-262/src/lib.rs:321-329`) does; two `Bytes` cursors
(`rust/engine/ironhorse-fuzz/src/lib.rs:92-119`, `rust/engine/ironhorse-fuzz/src/regexp.rs:20-45`);
26 seed-expansion loops; six rewind-or-Poisoned blocks in `rust/endo/src/ironhorse_engine.rs`; the
oracle result copy-out (`rust/engine/xs-oracle/src/lib.rs:325-358` against `:391-427`); three
host-globals installs in `rust/engine/xs-oracle/csrc/xs_shim.c` (`:384-417`, `:594-625`,
`:936-949`).
Four classifiers over `Halt` in the embedding disagree (INT-5, low; no production consumer).
Six fuzz-regression regexp tests differ only in their constants
(`rust/engine/ironhorse-regexp/tests/finding_*_regexp_meter_overflow.rs`).

**Diverged?**
Yes: the third mode/goal copy (T262-3, low), the two comparison policies, the fuzz skip predicate,
and the six harness classifiers of F12.
These do not change engine behaviour; they change what the instruments report, which is how
engine regressions are noticed.

**Recommendation.**
One `select_modes(case)`, one `classify_halt(&Halt)` shared by `ironhorse-262` and
`ironhorse-fuzz`, one comparison policy that includes thrown values, one `CaseResult::new`, a
`RunOutcome::not_run(halt)`, and an enum for skip reasons in place of prefix-matched strings.

### F14. Interpreter dispatch idioms

**Copies** (from `../maps/vm-core-dispatch.md`, spot-checked; paths under
`rust/engine/ironhorse-vm/src/interp/`):
branch-operand decode (7 two-byte and 5 four-byte copies in `dispatch.rs`, although
`operand_wide_branch` exists at `:147`); the taken-branch meter check (10 copies); six bitwise
`exec_*` wrappers (`dispatch.rs:3271-3337`); ToObject box-and-replace (5 copies in
`dispatch/iteration.rs:237-286`); the home-object lookup (7 copies); the private-element prologue
(`dispatch/private.rs:7-24`, `:111-132`, `:157-179`, `:216-230`);
`Slot::of(Kind::Reference, Payload::Reference(x))` (35 sites in `dispatch*.rs`, 373 in the
crate); `internal_error` plus `raise_js` (43 sites); and two classifiers for the `"length"` key
(`dispatch/property_read.rs:19` compares the cached id, `dispatch/property_write.rs:41`, `:167`,
`:272` compare an allocated `String`).

**Diverged?**
Not today.
The `DELETE_PROPERTY_AT` twin of `mop_delete` belongs to F2.

**Recommendation.**
Use `operand_wide_branch` for every width, a `Slot::reference(x)` constructor, a
`throw_type_error!`-style helper, and one `is_length_key(id)`.

## Families examined and judged acceptable

- **The `GET_PROPERTY` brand shortcuts as duplicated getters.**
  The core-dispatch map listed them as a second implementation of each Temporal, Locale,
  Collator, RegExp and DisposableStack getter.
  CORE-3's verification refuted that: no native getter exists, so
  `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:44-299` is the only
  implementation, and the defect is the missing accessors (CORE-3, RGX-2, NVAL-4 and NOBJ-9,
  medium each), not duplication.
  The parallel-names row in the natives-values map (`property_read.rs` against the boot prototype
  tables) falls with it.
- **Coder finally-selector lowering** (exact pair 11).
  The three call sites mirror XS's `fxCoderFinalizeTargets` call sites in
  `c/moddable/xs/sources/xsCode.c:1847-1849`, `:3307-3309` and `:4615`; keeping the transliteration
  line-for-line comparable with XS is worth the repetition.
  The same holds for the compiler's tree-walk skeletons and its binding grammar against cover
  conversion (compile map), which reproduce XS's `fxNodeHoist`/`Bind`/`Code` and
  `fxBinding`/`fxBindingFromExpression` split.
- **Spec-shaped pairs.**
  `ArrayBuffer` against `SharedArrayBuffer` `slice` (pair 16), `Array.from` against
  `Array.fromAsync` (pair 19) and the module SCC walks for instantiate and evaluate
  (`rust/engine/ironhorse-vm/src/module.rs:~421-500`, `:626-680`) follow two distinct spec
  algorithms.
- **Five page-reachability implementations** in the store
  (`rust/engine/ironhorse-snapshot/src/store.rs:973-992`, `:1570-1615`, two SQLite CTEs): dense
  and SQL versions are deliberate and parity-tested in
  `rust/endo/ironhorse-store-sqlite/tests/query_gc.rs`.
- **Collections and TypedArray element types.**
  Map, Set, WeakMap and WeakSet share one `CollectionData` and one `call_collection`; the 12
  TypedArray element types are table-driven and Float16 shares the codecs.
  The full and partial prunes are generated from one roster
  (`rust/engine/ironhorse-vm/src/interp/gc_tables.rs:98-135`).
- **Regexp backward capture reference.**
  `rust/engine/ironhorse-regexp/src/matcher.rs:396-415` against `:460-479` differ on purpose,
  documented as XS parity.
- **Cross-crate Unicode tables.**
  General-category and property tables live only in `ironhorse-regexp`; the only overlap is the
  two identifier encodings in F6, measured equal.
- **Router against families** (F1): consistent today (`router_check.out`).
  The hazard is latent, not a divergence.
- **`harden` against `petrify` on String wrappers.**
  The two loops differ in `skip_indexes`
  (`rust/engine/ironhorse-vm/src/interp/property/integrity.rs:179` against `:260-264`), but
  `../probes/dup/js/harden_string.js` shows the same result for `harden`, `Object.freeze` and
  `petrify` on `new String('abc')`.
- **Encoders run twice** (sizing, then writing) in
  `rust/engine/ironhorse-snapshot/src/stream.rs:225-289`: CPU only, and it lets the writer stream.
- **Inline test modules and examples.**
  The `image.rs` and `store.rs` test fixtures (pairs 2, 7, 18 and the 122-line run at
  `rust/engine/ironhorse-snapshot/src/store.rs:2971-3144`), the `xs-oracle` examples (pair 17)
  and the regexp fuzz-regression tests are test code; table-driven forms would shorten them, but
  they carry no product risk.
- **`sha256` absorb loops** (pair 22): one trivially correct copy; `update` can call
  `raw_update`.
- **`DEFAULT_KEYS` against `GLOBAL_KEY_ORDER`** (pair 15): two distinct XS tables, not a copy; the
  real issue is `DEFAULT_KEYS`'s drift from the pin (F1).
- **`compile_one` against `compile_one_module`**
  (`rust/engine/ironhorse-262/src/compile_diff.rs:247`, `:309`): the script variant's
  runtime-`SyntaxError` recovery is a deliberate difference.

## What this lens did not cover

- **Scan scope.**
  The clone scan covers Rust under `rust/engine` only.
  `rust/endo` (`ironhorse_engine.rs`, `ironhorse-store-sqlite`) and
  `rust/thixotrope-ironhorse-worker` were not scanned; their copies here come from the region
  reviewers and from the integration verifier's `diff -w`.
  C (`xs_shim.c`), JavaScript and Python were not scanned.
- **Clone types.**
  The scans detect exact clones and clones that differ only in literals, ten (or eight) normalized
  statements or longer.
  Clones with renamed identifiers, reordered statements or changed control flow, and short idioms
  repeated many times, are found only where a reviewer or a grep found them (for example the
  three-line slot-detach idiom at 17 sites and the 13 primitive-prototype matches).
  There are certainly more.
- **Generated code.**
  `*_generated.rs` is excluded from the scan; the regexp tables' internal redundancy is reported
  from the regexp map, not measured here.
- **Probing.**
  "Not diverged" for F2's walks, F6, F10's GC walks and F14 rests on the region verifiers' probes
  and on static comparison; this lens added probes only for F7 (`radix_twins.js`,
  `escape_twins.js`), the integrity loops (`harden_string.js`), the router consistency and the
  `DEFAULT_KEYS` comparison.
  The `DEFAULT_KEYS` drift's computron consequence was not measured against XS here; COV-17
  measured it later (`../COVERAGE.md`).
- **History.**
  The checkout is shallow (50 commits), so churn and co-change between copies could not be
  measured; past divergences are known only from comments in the code.
- **Classification taxonomies.**
  Where the same condition is classified differently without shared code (halt classes, skip
  reasons, store failure classes), this lens cites the finding only when a copied classifier is
  the cause; the taxonomies themselves belong to the ontology lens.
