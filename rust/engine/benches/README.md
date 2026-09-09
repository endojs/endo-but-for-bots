# Performance instruments (F106/F122)

Run the general snapshot controls across four test targets, serially in release mode:

```sh
export CARGO_INCREMENTAL=0
export RUST_MIN_STACK=33554432
python3 rust/engine/benches/run.py --check-baseline --output /tmp/benchmark-report.json
```

Each workload emits its median and its ratio against `baseline.json`.
The file records the source revision, Rust compiler, and host of the measured baseline.
`--check-baseline` automatically remeasures that revision on the current host before
checking the candidate, so the committed host's absolute medians cannot decide a check.
The regression floor is 1.25x the baseline time for each measurement.
It is an early-warning floor, separate from the stage-8 geometric-mean envelope of 2x XS.
A missing, extra, duplicate, zero, or nonfinite measurement is an error.
Fixture failures remain errors, even if the benchmark printed measurements first.

Absolute timings from different machines are not comparable.
The explicit `--reference-baseline` spelling remains supported for nightly CI and
for reference measurements without a threshold check:

```sh
python3 rust/engine/benches/run.py --reference-baseline --check-baseline
```

This needs the baseline commit in local Git history and `tar` on PATH.
The reference checkout is temporary, uses a separate build directory, and is removed
when the command finishes.
The checked-in medians record the pinned baseline measurement; CI reports also
record the reference host and revision used for that run.
Reports identify same-host comparisons separately from historical context.
Both measured sides record a SHA-256 digest of the fixture sources and toolchain pin,
plus the compiler and relevant build environment; a check refuses mismatched provenance.
The archived reference uses its own build directory even if `CARGO_TARGET_DIR` is set.
The pinned revision, 48-metric roster, 1.25x floor, and growth policies are unchanged.
Baseline updates are explicit, reviewable operations, never part of a check:

```sh
python3 rust/engine/benches/run.py --write-baseline
```

Run the growth-class suite separately:

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test scaling_bench -- --ignored --nocapture --test-threads=1
```

It checks string indexing, Map insertion, for-in, and string for-of across consecutive
input doublings, with one warmup and seven measured runs per size.
Every fixture checks its result and deterministic computron count.
Both raw median elapsed time and computrons must grow by less than 2.5x per doubling.
Construction is included in these end-to-end workload measurements.
The F044 and F045 fixes below now pass this gate without changing its thresholds.
The existing nightly full-test262 workflow runs both instruments in an independent
job, and uploads their logs and JSON even when a gate fails.
Ordinary PR CI does not run timing assertions.

## XS microbenchmark comparison

The separate XS microbenchmark comparison is runnable with:

```sh
CARGO_INCREMENTAL=0 RUST_MIN_STACK=33554432 python3 rust/engine/benches/xs_compare.py
```

It measures parse/code generation, property access, calls, allocation churn, and
string operations, alternating engine order over one warmup and seven samples.
Each sample checks an independently specified result.
The report retains sample order, source digests, both revisions, and build settings.
The nightly workflow measures this slice and uploads the report.
`--check-micro` additionally fails when its geometric mean exceeds 2.0x XS elapsed time.
Without that option, command success means valid measurements, not an envelope pass;
`within_microbenchmark_limit` contains the measured decision.

XS uses its pinned oracle build at optimization level 2.
Rust uses the workspace release profile.
Machine creation and teardown are excluded on both sides.
XS compilation times `fxParseScript`; execution includes script preparation, promise
jobs, and result rendering, while bytecode capture is outside both intervals.
IronHorse compilation times `compile_atoms_with`; execution includes intrinsic linking
and `Interp::run`, including completion rendering.
These are fresh-machine microbenchmarks, not steady-state daemon workloads.
Allocation churn is not a direct measurement of collection pauses or heap footprint.
The report always marks the full stage-8 envelope unavailable until its remaining
daemon, comparable heap-footprint, and code-size measurements exist.

## Daemon arm: explicitly blocked

The fourth daemon variant cannot run yet.
`endor worker -e ironhorse` explicitly refuses the worker protocol in
`rust/endo/src/ironhorse_engine.rs`; CBOR transport, host functions, and SES boot
are still needed (F054's open host-function half and roadmap stage 4).
`packages/daemon/test/bench-daemon.js` reports that blocker, and an explicit
`--ironhorse-only` invocation fails instead of timing a substitute or silently skipping.
Per the requested scope, this change does not implement that worker protocol.
Consequently it does not claim the four-variant daemon envelope is measured or met.

## Checker tests

```sh
python3 -m unittest discover -s rust/engine/benches -p 'test_*.py'
```

## Compiler algorithms (F065, first increment)

The compiler growth gate covers a 1.024 MB branch-heavy Script and declaration-heavy
Script, sloppy eval, strict eval, and function bodies.
The original gate used `<2.5x` at every adjacent doubling for elapsed time and parse
computrons, checked deterministic bytecode and symbols, and ran in the nightly job.
The current elapsed-time policy below evaluates approximately linear growth over
the complete fixed range; adjacent metering checks remain unchanged.
The before/after measurements and exact fixture digest are recorded in
[results/f065-compiler-algorithms.json](results/f065-compiler-algorithms.json).
The baseline revision is recorded there; use its recorded fixture to reproduce the
historical measurement.
For a fresh comparison with today's fixture, copy both `performance_bench.rs` and
`common/compiler_growth.rs` into that revision's compiler tests.
Both revisions were measured serially with the same release toolchain and machine.
This increment changed algorithms without changing charges.
The later compiler-budget, runtime, and daemon increments below completed bounded
compilation charging through the F051 bridge.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-compile --test performance_bench -- --ignored --nocapture --test-threads=1
```

## Indexed string receivers (F044)

The receiver-length gate times 100,000 calls to each of the nine indexed String
methods and a property-index control, with construction and relinking excluded.
Lengths range from 16 to 4096 UTF-16 code units with identical dispatch counts and
raw charges for each method.
A second gate measures cold and resident lazy arenas from 32,768 to 1,048,576 units,
with 1000 calls per crank and separate metering checks for each arm.
Both use one warmup and five samples, comparing medians against the smallest size
with a `<2.5x` ceiling.
The VM unit tests additionally assert zero whole-string decodes for 100,000
`charCodeAt` calls and bounded extent faults for indexed reads across page boundaries.

[results/f044-string-indexing.json](results/f044-string-indexing.json) records all
56 before/after measurements, the baseline revision, and the identical fixture digest.
Copy this commit's `scaling_bench.rs` into the baseline revision to reproduce it.
Both timing gates fail before the fix and pass afterward; raw charges are unchanged.
These gates run with the existing nightly scaling suite.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test scaling_bench string_ \
  -- --ignored --nocapture --test-threads=1
```

## Collections and iterator buffers (F045)

[results/f045-collections-and-iteration.json](results/f045-collections-and-iteration.json)
records the before/after data for the collection index, cached live count, and shared
iterator buffers.
Map insertion and string iteration now pass the existing doubling threshold with
unchanged computrons.
At that revision, the end-to-end for-in fixture still failed because constructing
its named-property object was quadratic, independent of iterator traversal.
The follow-up construction fix below closes that remaining gate.

The additional `for_in_traversal_scales_after_construction` fixture measures traversal
separately and reports the single setup time alongside its traversal median.
It uses one warmup and seven measured cranks per size, checks raw charges and dispatch
counts, and requires both traversal time and raw charges to grow by less than 2.5x.
It fails before the iterator fix and passes afterward.
This separates evidence for the repaired traversal from the construction cost
that the subsequent increment addresses.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test scaling_bench for_in_traversal \
  -- --ignored --nocapture --test-threads=1
```

## Bytecode ownership and fresh realms (F176)

The lifecycle gate executes a caller-owned `Rc<[u8]>` 1000 times at each buffer size,
from a seven-byte program to 8 MiB with an unreachable tail.
It requires median execution time to remain within 2.5x of the smallest buffer.
The same fixture also measures 1000 fresh symbol-linked compartment evaluations.
Both use one warmup and five measured samples.
A production fixture additionally measures `Machine::evaluate`, including compilation
and default metering, in `rust/endo/tests/ironhorse_lifecycle_bench.rs`.
The production fixture is a manual measurement; the VM lifecycle gate runs nightly.

[results/f176-lifecycle.json](results/f176-lifecycle.json) records the paired runs,
revisions, fixture digests, and build prerequisites.
The shared-buffer gate fails before the fix and passes afterward.
Raw charges remain unchanged in all measured cases.
The slice-based compatibility APIs still acquire owned bytecode; callers already
holding an `Rc<[u8]>` use the shared APIs to avoid that conversion.
Creating an `Rc<[u8]>` from freshly compiled `Vec<u8>` remains one ownership conversion.

Fresh realms copy an immutable, pristine linked template into independent mutable
arenas and tables; guest execution never mutates the cached template.
The cache holds one exact symbol-table variant per machine.
Tests compare outcomes, raw charges, and metering callbacks against explicit fresh
boot, including repeated mutation, throws, meter refusals, and symbol-table changes.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test lifecycle_bench -- --ignored --nocapture --test-threads=1
cargo test --manifest-path rust/endo/Cargo.toml --locked --release \
  --test ironhorse_lifecycle_bench -- --ignored --nocapture --test-threads=1
```

## Property and call classification (F119)

The classification fixture measures 500,000 ordinary property reads, plain function
calls, array length reads, and native calls in both small and populated realms.
The populated realm retains collections, wrappers, buffers, typed views, RegExp,
Intl objects, and a proxy, so membership probes encounter populated side tables.
Compilation, linking, and VM boot are outside the timer; guest setup is included.
Each case uses one warmup and five measured runs and checks repeatable raw charges
and dispatch counts.

[results/f119-classification.json](results/f119-classification.json) records paired
measurements against the preceding commit, using the identical fixture on the same
host and release toolchain.
The fixture runs nightly and retains its timings as an artifact.
These fixed-workload measurements report changes without imposing a scaling threshold.
Populated-realm property reads and native calls improve about 6% in this run;
small-realm results are roughly unchanged.
The derived index adds about 0.65 microseconds per fresh scalar compartment (6%)
and about 0.51 microseconds per fresh intrinsic compartment (2.4%).
The artifact retains these costs alongside the improvements, with unchanged charges.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test classification_bench \
  -- --ignored --nocapture --test-threads=1
```


## Named-property construction and updates (F045, final increment)

[results/f045-property-construction.json](results/f045-property-construction.json)
records before/after measurements against the preceding commit.
The original end-to-end for-in gate now passes its unchanged doubling threshold.
Long named-property chains use a derived arena index, while enumeration continues
reading the authoritative insertion-order chain.
Pending intrinsic installation copies and scans only the new name-table suffix;
its absolute installation floor still protects guest deletions and replacements.
The install pass retains scans over intrinsic/function metadata, so this change
makes no universal constant-time claim about realms with growing function populations.

The `property_lookup_bench` control performs 10,000 updates to an existing property
on objects with 256 through 16,384 names, excluding construction and relinking.
It reports one setup time and the median of five runs after one warmup.
Its size gate fails before the fix and passes afterward, with identical raw charges
and dispatch counts across revisions and sizes.
Both this control and the original construction gate run nightly.
At 16,000 properties, end-to-end construction plus for-in improves about 38x;
10,000 updates on a 16,384-property object improve about 312x.
Dispatch controls include slowdowns up to 5.3%, while fresh-realm controls stay
within 1%; the artifact records these alongside the gains without a significance claim.
The write-path membership vector grows to the highest indexed slot, like the
arena's existing liveness metadata; it is derived rather than serialized.


```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test property_lookup_bench \
  -- --ignored --nocapture --test-threads=1
```

## Checkpoint sections (F043, foundation only)

The checkpoint fixture retains arrays of 1000, 10,000, and 50,000 elements and
times only the checkpoint following a `1 + 1` crank.
It checks identical raw charges, zero slot/chunk writes, and complete restored-image
equality outside the timer.
One warmup and seven measured checkpoints give the median for each size.
The consecutive-size ceiling is 2.5x; this is a sublinear-growth instrument with
unequal size steps, rather than the doubling test used by other fixtures.

[results/f043-section-foundation.json](results/f043-section-foundation.json) retains
paired measurements for the section identity and integrity primitives.
Both foundation revisions failed at 10,000 and 50,000 elements; F043 was still open.
At that revision, checkpoints still copied, encoded, hashed, and stored the whole small state.
The primitives preserved legacy framing without activating a new store schema.
The timing differences do not establish an improvement; the largest case is slower.
This MemoryStore array fixture does not establish SQLite write amplification or
coverage of all side tables.
Sectioned backend storage, migration, dirty extraction, and broader fixtures must
land before claiming the checkpoint fix.
The dirty-selection increment below makes this instrument a nightly gate.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-snapshot --test checkpoint_scaling_bench \
  -- --ignored --nocapture --test-threads=1
```

## Section storage and migration (F043, second increment)

Schema 28 replaces the whole-small-state leaf with a tree of 32 section leaves.
Schema 26 remains the earlier CESU-8 NAME migration.
Schema 27 retains canonical small state and authenticated manifest policy.
SQLite stores section payloads and hashes separately; migration from schema 27
verifies the old root and seal before atomically restamping without changing payloads.
The migration tests cover partial-insert rollback, table-creation rollback, retry,
and byte-preserving refusal of incompatible legacy stores.
The canonical container hash and raw-charge golden values remain unchanged;
the store seal changes because it binds the new schema and root.

[results/f043-section-storage.json](results/f043-section-storage.json) records the
original pre-rebase MemoryStore checkpoint pair under its earlier schema.
Fresh latest-base measurements follow final integration.
Both storage-only runs fail its scaling threshold; F043 was still open.
The integrated sparse protocol retains omitted sections, validates each supplied
payload canonically, and retains the shared manifest seal over the authenticated root.
MemoryStore and SQLite write only changed sections; FileStore still rewrites its file.
SQLite tests verify that a `1 + 1` crank with 10,000 live array elements updates only
the meter section on both cached and cold paths, and that a failed array write
rolls back before a successful retry.
That increment still extracted and hashed every section to discover changes.
These MemoryStore timings do not establish SQLite performance.
At 50,000 retained array elements, the measured checkpoint median falls from
14.36 ms to 3.82 ms (3.76x), but its growth remains linear and fails the gate.


## Dirty section extraction (F043)

[results/f043-dirty-selection.json](results/f043-dirty-selection.json) retains the
same-host pair against the section-storage commit, with unchanged fixture and charges.
At 50,000 retained array elements, the checkpoint median falls from 4.745 ms to
0.0183 ms (260x), and the original 2.5x growth ceiling passes at both size steps.
This is MemoryStore array timing, not a SQLite throughput measurement.

VM mutation tracking selects sections before materialization and encoding.
Mixed-state counter tests retain arrays, Map entries, and 1000 names; unchanged
checkpoints perform zero array, collection, and name extraction or encoding.
Full restored-image comparisons run outside the counted window, and a full-extraction
positive control checks that the counters observe real work.
Fresh sessions and warmed eager/lazy resumes are covered.
The first checkpoint after restore may serialize normalization changes; only its
successful commit establishes the clean baseline used by subsequent checkpoints.
SQLite migration and failed-write retry tests exercise that baseline boundary.
Session-owned tokens invalidate clean state when interpreters are swapped or another
caller acknowledges a snapshot.
FileStore retains its whole-file rewrite behavior.

The artifact also retains 80 paired dispatch, string, collection, and property
controls with identical charges and passing scaling gates.
An initial ordinary-read dispatch result was 34.4% slower; a full paired repeat
measured 2.4% for that case and up to 7.1% slower across dispatch cases.
Both runs remain in the artifact; these medians do not establish statistical significance.

## Compiler work budget (F065, second increment)

[results/f065-compiler-budget.json](results/f065-compiler-budget.json) retains all
paired legacy runs, including failures, and the new API overhead measurements.
The reviewed 32,000-branch median is 120.9 ms through the legacy API and 129.3 ms
with a live charge callback (about 7% overhead); bytecode and symbols are identical.
All three new fixture modes pass the unchanged 2.5x time/charge growth ceiling.
The legacy baseline and candidate both had noisy failures in earlier pairs.
The final baseline fails at 2.535x branch growth; the final candidate passes.
These medians establish neither a legacy-path speedup nor statistical significance.

The rebased implementation uses the shared `ironhorse-meter-5` release, retaining
upstream weights while changing charging sites and enforcing checked raw limits.
Releases 1–4 and their digest pins remain immutable.
Source admission costs `COMPILE_SOURCE_BYTE_METERING` per UTF-8 byte and occurs in
the lexer before its character/offset allocations.
Tokens, scoper operations, coder nodes/records, symbol interning, and reserved scans
use the shared token/work weights.
BigInt conversion keeps upstream's incremental charges for each growing limb scan;
regexp validation retains upstream’s bounded inner-work checks, including string-set
products, and charges each reported work delta exactly once.
Repeated `using` disposal-slot searches reserve declaration count before traversal.
Optimizer and serialization passes reserve linear scans before allocation.
These weights are deterministic policy, not calibrated CPU time or XS parity.

`ParseMeter` clones retain cumulative charges across errors and compiler panics.
A hard raw allowance caps the bill; multiplication overflow or an attempted excess
consumes only the remaining allowance and refuses stickily.
Host callbacks receive the actual charged delta, with no callback after refusal.
Reentrant charging fails closed, and non-meter panics retain progress and propagate.
Only the private meter refusal is translated at the compilation boundary.
Exact-budget completion remains distinct from an attempted excess.

`compile_atoms_budgeted_with_limit` preserves upstream's `CompiledAtoms` receipt and
Module-aware goal dispatch, with both a raw allowance and a live host callback.
The retained-meter goal API also supports Module, Script, and Eval without changing
atom identity.
Legacy unlimited APIs still count all phases under the shared table.
The following increments integrate the stronger bounds with runtime and daemon meters.

The artifact above records the original pre-rebase pair and its earlier cost policy;
its timings and charges are historical evidence, not measurements of release 5.
A fresh pair against the updated base is required after integration.
The fixture's legacy `raw=0` denotes no host compilation bill, not zero parse work.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-compile --test compile_budget_bench \
  -- --ignored --nocapture --test-threads=1
```

## Live runtime compilation charges (F065, third increment)

`SourceCompiler` now receives a raw allowance and a borrowed live charge callback.
The VM drives it for both `eval` and `Function`, records charges before subsequent
work, and treats refusal as uncatchable `MeterAbort` before relinking or retaining
compiled code.
A successful `CompiledSource.parse_meter_raw` is a receipt checked against callback
deltas; the VM does not charge it again.
The conformance compiler retains its shared meter across its unwind boundary.
Tests compare charged and legacy compilation on the same outer program, proving
that successful, nested, and caught-syntax-error paths add exactly the compiler bill.
Compilation checks saturate the next threshold, preserving the accumulated index
when an accepting host's interval would otherwise wrap it to zero.

The integrated implementation uses the shared `ironhorse-meter-5` release.
Its upstream source/token/work weights and immutable earlier release pins remain
intact; the runtime seam adds a checked raw allowance and verifies live receipts.
Historical snapshots retain their named cost-table refusals and migration tests
continue to authenticate both the version and table digest.

The compiler-budget growth fixture now runs in the nightly compiler scaling lane.
The following increment extends these charges to top-level daemon and worker source.

[results/f065-runtime-compilation.json](results/f065-runtime-compilation.json)
records the original pre-rebase same-host release pair against the compiler-budget
commit, using its earlier cost policy; these are not release 5 measurements.
At 4,000 branches, eval measures 6.34 ms before and 6.27 ms after; Function measures
5.10 ms before and 5.61 ms after (about 10% overhead).
The 1 MB comment case refuses earlier, falling from 5.87 ms to 2.56 ms.
These medians do not establish statistical significance or an eval speedup.
A rejected live source admission retains its full reserved charge before host
refusal, which can exceed the host threshold; the artifact records all raw bills.
The fixture excludes outer compilation and realm creation/linking, while timing
nested source preparation, compilation, relinking, and execution together.
Successful fixtures pin their results (`1` for eval, `undefined` for Function).
Refusal timings compare deliberately changed outcomes: the old 1,000- and
10,000-byte comment cases complete, while the old 1 MB case already aborts later.
Earlier termination is not a same-work compiler acceleration, and timed caller
string allocation/decoding means these measurements do not establish constant-time
VM refusal.
Byte identity is established by the compiler corpus; runtime tests separately check
result equality and exact added charges.

```sh
cargo test --manifest-path rust/engine/Cargo.toml --locked --release \
  -p ironhorse-262 --test runtime_compile_bench \
  -- --ignored --nocapture --test-threads=1
```

## Top-level compilation charges (F065, fourth increment)

Daemon and worker source now enter the compiler with a hard raw allowance derived
from the crank budget and remaining meter capacity.
Source admission occurs before lexer allocation.
The stateless daemon moves the actual meter and host callback into its cached realm,
retaining the index and next consultation threshold without resetting or replaying
compilation charges.
Host consultation occurs outside the template cache borrow, allowing reentrancy.
The persistent daemon arms before compilation and symbol preparation; failures
rewind the entire pending checkpoint window, just as execution failures do.
Compile errors report their attempted raw bill even though the heap and persistent
meter rewind together.
The worker uses a budgeted Script entry point to preserve declaration semantics;
failed preparation exits before checkpointing or releasing a successful result.

[results/f065-top-level-compilation.json](results/f065-top-level-compilation.json)
records the original serial same-host release pair against `5b1e132d6`,
using the pre-rebase cost policy; it is not a release 5 measurement.
For 1,000 stateless evaluations, scalar time changes from 27.77 ms to 28.34 ms
(about 2% overhead), and intrinsic-heavy time from 44.65 ms to 51.80 ms
(about 16% overhead).
Timings cover the whole batch; raw charges and computrons are per evaluation.
The raw bills intentionally increase from 541,976 to 7,816,472 for the scalar and
from 2,149,216 to 42,453,856 for the intrinsic-heavy source.
These medians are not statistical significance claims or persistent-store timings.
Tests separately verify exact charge deltas, Script parity, cache reuse and
reentrancy, refusal before dispatch, and rollback of pending cranks.
This completes top-level integration under the shared `ironhorse-meter-5` release.
Upstream's periodic dispatch checkpoint is retained alongside compilation checks.

## Integrated verification

The [implementation report](../architecture-review/2026-09-06/PERFORMANCE-FIXES.md)
records coverage, compatibility changes, and final integration evidence.
The per-increment results above preserve their original pre-rebase source revisions;
they must not be treated as timings of the integrated release-5 implementation.
`integration_compile_bench.rs` uses the callback API common to both releases so the
same fixture can measure successful branch/declaration compilation and named refusal.
The general control runner is separate from the finding-specific scaling fixtures.

When the nightly compiler gate fails, `profile_compile.py` builds an isolated
archive of the checked-out engine with checked phase-timing probes.
It records parsing, scoping, code generation, optimization, serialization, and
teardown in `compiler-phases.log` while retaining the original gate failure.
The diagnostic has its own target directory, uses the engine toolchain pin, and
removes its temporary checkout on exit.
Probe timings include their overhead; the uninstrumented gates remain authoritative.
The compiler step uses `--no-fail-fast` so both budget and original algorithm
fixtures produce results even if one fails.

`OPT` is a submeasurement within `PHASE serialize`; those two columns overlap.
A diagnostic timeout terminates the entire compiler/benchmark process group before
removing its temporary checkout, so later measurements cannot overlap orphan work.

## Approximately linear compiler growth

Compiler verification now targets approximately linear growth over the measured
range, rather than requiring a separate optimization for each cache transition.
For elapsed time, the fixed 2.5x per-doubling allowance is applied geometrically
across the complete fixture range: `t(last) / t(first) < 2.5^log2(n(last)/n(first))`.
For 4,000–32,000 branches this allows less than 15.625x total growth across 8x input;
linear growth is 8x and quadratic growth is 64x.
The shorter 2,000–8,000 declaration range allows less than 6.25x across 4x input.
This relaxes sensitivity to a localized cache transition, and is a measured growth
envelope rather than proof of asymptotic complexity.
Every adjacent elapsed ratio remains visible, while adjacent meter checks, exact
receipts, and the separate 1.25x cross-revision controls remain unchanged.
The checker rejects incomplete or invalid samples and has synthetic linear,
cache-transition, superlinear, and quadratic regression cases.

## Interpreter decomposition: GC roster increment

[results/1a-gc-roster.json](results/1a-gc-roster.json) retains the first GC module
split's three candidate runs, including unsuccessful comparisons.
The roster generates hook borrows and both collectors' pruning from one inventory;
it also fixes full GC's omission of counted ordinary index-property rows.
The source digest identifies the measured worktree, and the reference is `96db92e23`.
This is an incremental measurement; the remaining 1A decomposition still needs its
final comparison.

An initial measurement-only run against the saved before run showed broad slowdowns,
including unchanged controls.
Its raw runner result did not enforce thresholds; the artifact separately records all
nine ratios above the 1.25x floor.
A fresh reference/candidate pair did not reproduce the large GC regression, but its
slot-allocation control crossed the unchanged 1.25x floor at 1.300x.
A subsequent candidate repeat passed all 48 controls against that fresh reference:
slot allocation was 1.010x, dispatch 0.959x, and full-first, steady full, and partial
collection at 80,000 slots were 1.020x, 1.016x, and 0.980x respectively.
No inlining or other performance tuning was applied between these runs.
These samples record the delta and host variability; they do not establish a speedup.

## Interpreter decomposition: field inventory increment

[results/1a-state-roster.json](results/1a-state-roster.json) retains four runs for
the shared field declaration and GC hook inventory, with every failed threshold.
Against freshly measured original `96db92e23`, several checkpoint controls exceeded
1.25x and repeated, while dispatch and the largest full/partial GC cases were near
parity.
A fresh parent `98946c1bd` comparison measured checkpoint controls at 0.987–1.063x,
but the largest partial-GC case spiked to 1.946x.
Its repeat measured that case at 1.002x; the smallest front-slide control failed at
1.275x and dispatch measured 1.120x.
No performance edits were made between runs.

No run passed every unchanged 1.25x threshold.
The parent comparison does not reproduce the broad checkpoint slowdown as an effect
of this increment, but these samples neither prove equivalence nor establish that
all failures are host noise.
The overall branch performance gate remains unresolved pending final decomposition
measurement.

## Interpreter decomposition: chunk visitation increment

[results/1a-chunk-roster.json](results/1a-chunk-roster.json) records a fresh
parent/candidate comparison for chunk-compaction policies generated from the field
inventory.
All 48 unchanged 1.25x thresholds passed against parent `cf31605bf`.
Dispatch measured 0.980x, slot allocation 1.022x, and full-first, steady full, and
partial collection at 80,000 slots measured 1.007x, 1.039x, and 0.989x respectively.
This is one incremental comparison, not statistical equivalence or final acceptance
of the whole branch's performance.

## Interpreter decomposition: slot visitation increment

[results/1a-slot-roster.json](results/1a-slot-roster.json) retains both measured runs
for the shared full/partial table walks against parent `9b899a9b0`.
The fresh pair measured the largest full-first, steady-full, and partial GC cases at
1.001x, 1.007x, and 0.970x, but four controls exceeded the unchanged 1.25x threshold.
The candidate repeat measured dispatch at 0.996x and those GC cases at 1.014x,
0.999x, and 0.990x; it failed the smallest tail-slide control at 1.268x and the
5,000-slot full-plus-partial control at 1.421x.
No performance edits occurred between runs, and neither run passed every threshold.
The results do not establish equivalence or prove that failures are host noise.
Final whole-branch performance acceptance remains pending.

## Interpreter decomposition: ephemeron increment

[results/1a-weak-roster.json](results/1a-weak-roster.json) retains both runs for
generated weak-table tracing and pruning against parent `47c900e93`.
The fresh pair measured dispatch at 0.998x and the largest full-first, steady-full,
and partial GC cases at 0.972x, 0.931x, and 1.025x.
The repeat measured those at 0.992x, 0.956x, 0.922x, and 1.008x respectively.
Both runs failed the 120,320-slot and 500,000-slot placeholder controls; repeat
ratios were 1.463x and 1.557x.
That fixture constructs a lazy slot arena without invoking the interpreter or GC
visitors, but this does not establish the cause of the changed timings.
The failures remain recorded, no performance tuning was applied, and final branch
acceptance remains pending.


## Completed F052 roster checkpoint

[results/1a-f052-roster.json](results/1a-f052-roster.json) measures clean commit
`7c3aea6b7` against a fresh same-host measurement of the original 1A baseline,
`96db92e2`.
The two revisions ran serially with identical fixtures and Rust 1.91.1 on macOS
arm64, with no concurrent task builds or tests.
All 48 measurements passed the unchanged 1.25x threshold.
Dispatch was 0.990x and slot allocation was 0.989x; the 80k-slot full-first,
full-steady, and partial collections were 1.027x, 1.011x, and 0.994x respectively.
The largest ratio was 1.210x for the 20k-slot gate measurement.
The report retains every median, ratio, and both revisions' provenance.
Earlier incremental reports and their failures remain available above.
This checkpoint covers the completed roster; it is not final performance
acceptance for the remaining 1A decomposition.

Validation at this checkpoint passed 1,043 VM/snapshot tests with store integrity
(18 ignored), including the four source locks, plus clippy and documentation
builds.
The architecture review remains unchanged; an independent scope audit found the
F052 production enumerations generated, while codec wiring and migration/test
ladders remain under F128 and F141.

## Helper extraction checkpoint

[results/1a-helper-extraction.json](results/1a-helper-extraction.json) records
clean commit `59b0cdb08` after the BigInt, Temporal, Date/locale, UTF-16, and
numeric helper moves.
Both runs compare against fresh serial measurements of `96db92e2` on the same
macOS arm64 host with Rust 1.91.1 and identical fixtures.
No task builds or tests ran concurrently with either benchmark.
The first run fails five slide checkpoint measurements at 1.290–1.311x the
reference; the repeat also fails slide measurements and a placeholder metric.
Dispatch in the first run is 0.994x the reference.
The complete raw medians, failures, provenance, and derived ratios from both
runs are retained, with the repeat under `repeat`.
This is an unresolved performance checkpoint, not acceptance of the helper
extraction or the full 1A decomposition.
The slide instrument times checkpointing after collection; its failed metrics
must not be described as timings of the compaction algorithm itself.

Validation for the measured code passed 1,243 engine tests and 116 SQLite tests,
including the source locks, plus clippy, formatting, and documentation builds
with no new warning headings.
