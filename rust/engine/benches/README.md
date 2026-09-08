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
The remaining F045 quadratic paths intentionally make this gate fail until repaired;
there is no expected-failure or skip exception for them.
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
