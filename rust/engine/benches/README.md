# Performance instruments (F106/F122)

Run all seven existing snapshot benchmarks, serially in release mode:

```sh
python3 rust/engine/benches/run.py --check-baseline --output /tmp/benchmark-report.json
```

Each workload emits its median and its ratio against `baseline.json`.
The file records the source revision, Rust compiler, and host of the measured baseline.
The regression floor is 1.25x the baseline time for each measurement.
It is an early-warning floor, separate from the stage-8 geometric-mean envelope of 2x XS.
A missing, extra, duplicate, zero, or nonfinite measurement is an error.
Fixture failures remain errors, even if the benchmark printed measurements first.

Absolute timings from different machines are not comparable.
For nightly CI, remeasure the pinned source revision on the same runner using the
candidate's benchmark fixtures, then compare the candidate against that reference:

```sh
python3 rust/engine/benches/run.py --reference-baseline --check-baseline
```

This needs the baseline commit in local Git history and `tar` on PATH.
The reference checkout is temporary, uses a separate build directory, and is removed
when the command finishes.
The checked-in medians retain the initial measurement; CI reports also record the
reference host and revision used for that run.
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
It uses the same `<2.5x` doubling criterion for elapsed time and parse computrons,
checks deterministic bytecode and symbols, and runs in the nightly job.
The before/after measurements and exact fixture digest are recorded in
[results/f065-compiler-algorithms.json](results/f065-compiler-algorithms.json).
The baseline revision is recorded there; copy the same `performance_bench.rs` into
that revision's compiler tests to reproduce the before measurement.
Both revisions were measured serially with the same release toolchain and machine.
This increment changes algorithms, not charges; bounded compilation and charging
through the F051 runtime/daemon bridge remain necessary to close F065 fully.

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
