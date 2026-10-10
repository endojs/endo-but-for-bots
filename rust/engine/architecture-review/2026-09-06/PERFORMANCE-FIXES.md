# Performance findings: implementation and verification

This follow-up covers F043, F044, F045, F119, F065, and F176.
The original review remains a historical record of the findings.
The implementation is based on `bots/llm` at `51b99651b` and preserves that base's
allocation admission, heap ceilings, snapshot authentication, and periodic metering.

## Requirements and evidence

| Finding | Implemented change | Verification |
| --- | --- | --- |
| F043 | Schema 28 gives each of 32 small-state sections its own leaf; mutation tracking selects dirty sections before extraction, encoding, hashing, and backend writes. | `checkpoint_scaling_bench` uses the original 1,000/10,000/50,000-element arrays and compares complete restored images; `side_table_ledger`, store checkpoint tests, and SQLite tests cover clean mixed tables, eager/lazy restore, write failure, retry, and migration. |
| F044 | Indexed string methods and indexed properties read bounded UTF-16 units; only whole-text operations materialize the receiver. | Zero whole-decode counter for 100,000 `charCodeAt` calls, lazy extent tests, coercion/oracle cases, and receiver-length scaling from 16 through 4,096 units. |
| F045 | Canonical SameValueZero indexes accompany ordered collection entries; iterator key/string buffers use shared ownership. Property-chain indexes and incremental name installation also remove the original for-in construction bottleneck. | Collection/iterator semantics, GC and restore tests, Map insertion at 1k–8k, for-in at 2k–16k, isolated traversal, string iteration, and existing-property update gates. |
| F119 | One derived classification lookup selects exotic property behavior and callable dispatch; tracked table mutations retain overlap precedence. | Classification tests cover ordinary/exotic overlap, updates, restore, GC, slot reuse, and the existing oracle corpus; fixed-workload timings include both small and populated realms. |
| F065 | Optimizer target indexing and mark/retain compaction remove repeated scans/removals; eval declarations reverse once. Retained compilation meters enforce raw allowances and live host refusal across eval, Function, daemon, and worker entry points. | Original approximately 1 MB branch scaling, declaration scaling, byte-identity corpus, exact charge receipts, syntax/unwind charges, regexp inner-work refusal, daemon rollback, and Script-goal worker tests. |
| F176 | Shared `Rc<[u8]>` entry points retain caller-owned bytecode; fresh evaluations clone a pristine boot template and replay its metered installation cost. | Shared-buffer scaling through 8 MiB, escaping-function lifetime, fresh-realm isolation, metering equivalence, symbol changes, callback reentrancy, and production daemon lifecycle timings. |

Each implementation increment received an adversarial review before committing.
Integration findings were folded into the corresponding implementation commits.
A final review checked these requirements against the rebased code and tests.

## Compatibility and limits

Meter release 5 retains the immutable release 1–4 weight pins and changes compiler
charging/admission policy; old releases remain explicitly distinguishable.
RegExp compilation retains upstream's bounded inner-work accounting and resource
refusals, with cumulative receipts converted to charged deltas exactly once.
Runtime-only golden charges remain pinned to the release-4 baseline.
Schema 28 migrates authenticated canonical schema-27 small-state payloads without
changing their bytes, then records the new section root and seal.

Dirty tracking is per section, not per element within a changed table.
MemoryStore and SQLite retain unchanged sections; FileStore still rewrites its file.
The first checkpoint after restore can persist normalization before establishing a
clean baseline.
The compatibility slice APIs still acquire owned bytecode; callers with shared
bytecode use the shared entry points to avoid that conversion.
Derived indexes and cached boot templates consume host memory; the arena ceilings
are not a claim of a universal host-memory limit.

The daemon worker-protocol benchmark arm remains explicitly blocked on F054's host
function surface and the stage-4 SES boot bundle.
It is orthogonal to these in-process performance fixes.

## Measurement provenance

The twelve per-increment artifacts in [the benchmark results](../../benches/results/)
retain the original same-host before/after measurements, including noisy or failing
runs and observed regressions.
Their full original revision pins refer to the preserved
`codex/ironhorse-performance-pre-integration-4122a8250` history.
They are historical evidence; they are not measurements of the rebased release-5
implementation.
The benchmark README describes the fixtures, thresholds, and measurement boundaries.

## Integration audit

The initial complete pair is retained in
[`integrated-initial.json`](../../benches/results/integrated-initial.json).
All candidate scaling assertions passed, but the general controls exposed a roughly
41% full-GC regression.
The follow-up in
[`integrated-gc-review.json`](../../benches/results/integrated-gc-review.json)
measured the baseline, initial implementation, and reviewed removal/free fixes.
Classification maps now avoid dirty/index writes on absent removals, and the property
cache uses owner membership to avoid hashing ordinary unindexed garbage.
The additional owner prefilter costs one byte per slot up to its high-water owner
index; it is retained host memory, not a bit-packed vector.
The full-GC slowdown fell to roughly 4–6% in that follow-up.

Three alternating trials of generational GC and wake controls are retained in
[`integrated-control-repeats.json`](../../benches/results/integrated-control-repeats.json).
Median-of-trial comparisons remained below the unchanged 1.25x control threshold,
but generational collection still showed approximately 16–20% overhead.
Review then found that GC reclassified every surviving function through mutable
retention despite only filtering keys.
A key-only retention API removes that work and marks classification/section dirt
only for actual removals.
Its tests cover unchanged refinements, clean no-op retention, overlapping classes,
and unwind after a completed removal.
No measurements above are relabeled as timings of that later fix.

## Validation

The integrated engine release suites, snapshot/VM/text remainder, and doctests passed
after correcting the integration failures described below.
The full Ironhorse corpus met all 1,712 expectations with three repetitions and strict
skip reasons.
SQLite/worker tests passed (118), as did the daemon store-worker integration tests (8).
The final GC changes passed the VM library, heap-ceiling, relink, side-table ledger,
and GC side-table tests.
The workspace all-target/all-feature Clippy gate uses Rust 1.88; release measurements
use Rust 1.91.1, with incremental compilation disabled.

The integration audit repaired tests for early authenticated-payload rejection,
schema-27 intermediate seals, and the exact registry of section refusals.
Those corrections preserve the original exact refusal checks and are folded into the
schema implementation commit.
Release-5 fixture labels retain the prior runtime-only charges and immutable meter
release pins.

## Final integrated measurements

[`integrated-final.json`](../../benches/results/integrated-final.json) compares
`51b99651b` with the final production implementation at `151c494598e64fe4`.
The latter is preserved on `codex/ironhorse-performance-measured-151c4945`.
Fixtures and their helper/boot inputs match across sides; binary digests and raw logs
are recorded, with Rust 1.91.1 and `RUST_MIN_STACK=33554432` on the same host.
All 13 candidate targets passed their fixture assertions, including every original
scaling threshold.
The general controls are compared separately; a successful target exit alone is not
a claim that the cross-revision 1.25x floor passed.

| Workload | Before | After |
| --- | ---: | ---: |
| F043 unchanged checkpoint, 50,000-element array | 10.40 ms | 0.494 ms |
| F044 100,000 indexed character reads, 4,096-unit receiver | 189.79 ms | 63.85 ms |
| F045 Map insertion, 4,000 entries | 22.45 ms | 2.916 ms |
| F045 for-in including construction, 16,000 names | 11.196 s | 1.772 s |
| F045 10,000 existing-property updates, 16,384 names | 3.252 s | 7.324 ms |
| F065 1.024 MB branch compilation | 3.185 s | 129.59 ms |
| F176 1,000 shared runs of an 8 MiB entry buffer | 133.52 ms | 0.127 ms |
| F176 1,000 fresh scalar realms | 228.67 ms | 11.52 ms |
| F176 1,000 production daemon scalar evaluations | 250.26 ms | 31.05 ms |

These gains have costs at smaller inputs.
The 1,000-element checkpoint rose from 0.318 to 0.867 ms; the tiny shared-entry case
rose from 0.100 to 0.166 ms for 1,000 runs.
F119 classification cases ranged from about 3% faster to 7% slower, so the structural
probe reduction does not establish an across-the-board elapsed-time win.
The fixed-length indexed-property control also retains its measured overhead in the
raw report.

Runtime-only receipts remain equal across these fixtures.
Compilation-inclusive receipts intentionally change under meter release 5:
the callback branch fixture falls from 67,183,183,654,912 to 91,490,217,984 raw units,
while daemon scalar evaluation rises from 2,516,248 to 2,716,952 raw units.
Named-refusal timings are labeled separately from successful compilation.

The final full-GC controls cost about 3% more, while generational controls range from
about 14% faster to 4% slower.
The complete pair nevertheless flagged `slide_500_front_ms`,
`placeholder_1000000_ms`, `placeholder_4000000_ms`, and `wake_lazy_ms` against 1.25x.
Those failures are retained in the artifact and prompted a separate, fixed
three-trial audit of all general controls with alternating baseline/candidate order.
The checked-in baseline uses only the newly measured **before** values at
`51b99651b`; it does not reset the reference to the candidate.

The completed [three-trial audit](../../benches/results/integrated-final-controls.json)
contains all 24 target runs and all 48 metrics.
Every median-of-trial comparison is below 1.25x, with no discarded trials or changed
thresholds; this repeated local audit does not replace the single-pair CI gate.
The earlier single-pair failures remain visible, so CI must still be watched.

The subsequent Linux run at `8dcdfb671` passed snapshot baseline and runtime scaling
checks but failed compiler growth at the unchanged 2.5x threshold.
Its isolated phase diagnostic showed a scope/traversal cost increase around the
512 KB branch fixture; parsing stayed approximately linear.
The [raw Linux logs and local follow-up pair](../../benches/results/compiler-lazy-declaration-index.json)
retain that failure, the diagnostic overhead caveat, and every local timing.

The follow-up allocates declaration indexes only when a scope gains a declaration.
Empty blocks retain one optional pointer instead of empty map/vector metadata.
It preserves lookup charges, duplicate precedence, and stable declaration IDs.
Serial local release pairs show roughly 1–3% improvement in the budgeted branch
fixture, with existing declaration controls within 1.9% of their before timings.
A new identical-fixture control with 2,000–8,000 populated sibling blocks measures
the extra allocation per nonempty scope; its after timings are about 0–1% lower.
These local results do not establish that the Linux scaling failure is resolved;
the candidate still needs to pass that lane without changing its threshold.

The Linux follow-up at `b27c59a84` passed all three budgeted compiler modes,
but the original branch-growth fixture still failed at 2.526x for 16,000 branches.
All other workflow gates passed.
The next change omits the unused access-diagnostic log during private compilation;
public scoper entry points still produce it, and semantic resolutions and charges
remain identical in tests covering closures and synthesized class scopes.
The [next serial local pair](../../benches/results/compiler-access-log.json) retains
both the Linux failure and all new measurements.
Budgeted branch timings improve about 1–3%; ordinary branch timings range from
0.4% faster to 0.7% slower, and function-declaration controls are 5–6% slower.
All local growth gates pass, with unchanged receipts and thresholds.
Linux verification remains outstanding for this follow-up.

The subsequent Linux run at `c99e93560` still crosses the adjacent compiler ceiling
around 512 KB, despite approximately 12x total elapsed growth for
8x input and exactly linear compiler receipts.
It also retains one failed snapshot control: placeholder construction at 120,320
slots rose from 8.025 to 10.369 microseconds (1.292x); all larger placeholder sizes
passed, as did the other 47 controls.
That isolated observation remains open for the next unchanged baseline comparison.

The requested scope is now approximately linear scaling, with further speed
optimization deferred.
An uncommitted AST literal-boxing experiment was measured and then reverted.
Compiler elapsed verification therefore uses the full fixed-range growth envelope
described in the benchmark README, preserving every adjacent ratio as a diagnostic.
This explicitly relaxes the earlier adjacent elapsed ceiling; it does not alter
metering checks or the separate 1.25x baseline threshold.
Applying the new envelope to the retained pre-algorithm measurements still rejects
all five original branch/declaration series (3.85–4.26x geometric growth per doubling).
Fresh CI verification is still required before readiness.
