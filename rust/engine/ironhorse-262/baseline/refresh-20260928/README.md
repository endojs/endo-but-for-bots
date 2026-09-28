# Round 3 measurement: numeric intrinsic constant attributes

This is a candidate measurement, **not a superseding floor**.
It preserves both whole-corpus sweeps and all remaining losses against
[the September 4 floor](../refresh-20260904/).
The current runner no longer counts a positive test as covered merely because
both engines abort.
No verdict policy, corpus pin, oracle pin, or resource ceiling changed in this round.
A maintainer must reconcile the historical floor before this measurement can replace it.

## Results

| Category | Branch point | Fixed engine |
| --- | ---: | ---: |
| covered | 36,599 | 36,673 |
| ironhorse-failure | 2,822 | 2,748 |
| unsupported | 4,791 | 4,791 |
| refused | 5 | 5 |
| skipped | 7,583 | 7,583 |
| infrastructure | 176 | 176 |
| total | 51,976 | 51,976 |

The branch point is `47f6965d882b9c1c3eaaa836dd8d75971a924bb4` on `llm`.
The fixed engine is `9df05366b3`; the reports record its full commit hash.
The later measurement commit changes only these evidence files.
Both runs use `tc39/test262@be13516fb6441b950ba8a3df97eb34062c186972` and
Moddable XS `23b4d6b0a65f35209d9118c4c13c6c9b3e68784d`.

All 74 gains were failures at the branch point.
No covered path was lost against that sweep, and all other per-case verdicts and
reasons remain unchanged.
The fix restores five historical covered paths in `Object.create` and
`Object.defineProperties`.
There were 906 historical losses before the fix; 901 remain afterward:
443 `ironhorse-aborted-limit`, 397 `shared-positive-test-failure`, and 61 other
failures, skips, or infrastructure outcomes.
These are recorded individually, without adding them back to `covered.txt`.

## Change and regression evidence

Math and Number numeric constants and both TypedArray `BYTES_PER_ELEMENT` owners
were installed as writable, enumerable, configurable properties.
They now use the immutable, non-enumerable descriptor required by their intrinsic definitions.
Enumerating Math as the descriptors argument to `Object.create` or
`Object.defineProperties` consequently ignores its constants and processes the
user-defined enumerable descriptor.
The same installation path covers initial linking, runtime property names, and
own-key materialization.

The five tests in
[`intrinsic_numeric_constants.rs`](../../tests/intrinsic_numeric_constants.rs)
run 52 source programs on Ironhorse and the pinned XS oracle.
They check every modeled numeric constant owner, descriptor flags and values,
strict and sloppy assignment, deletion, redefinition, enumerable descriptors,
and lazy linking followed by eval.
All five tests failed before the fix and pass afterward.
The descriptor failure was `true,true,true` instead of `false,false,false`;
the enumerable-descriptor failure was `TypeError: descriptor: not an object`.
These tests check result agreement, not exact computron agreement.

Validation:

- `cargo test --release --manifest-path rust/engine/Cargo.toml -p ironhorse-vm -p ironhorse-compile -p ironhorse-262 -p ironhorse-snapshot` exited zero with `RUST_MIN_STACK=67108864`: 3,304 passed and 43 ignored across 423 test binaries/doc-test groups.
- `cargo +1.88.0 fmt --manifest-path rust/engine/Cargo.toml --all -- --check` passed.
- `cargo +1.88.0 clippy --locked --release --manifest-path rust/engine/Cargo.toml -p ironhorse-vm -p ironhorse-262 --all-targets -- -D warnings` passed.
- All nine pre-push probe/advisory stages passed.

## Evidence and reproduction

- [`before-report.json`](before-report.json) and [`report.json`](report.json):
  complete original runner output, including provenance and every case's verdict.
- [`baseline.json`](baseline.json): totals, comparison, and SHA-256 digests of both reports.
- [`before-covered.txt`](before-covered.txt) and [`covered.txt`](covered.txt):
  covered paths, unique and byte-sorted.
- [`gained.txt`](gained.txt): the 74 newly covered paths.
- [`restored-historical.txt`](restored-historical.txt): the five restored September 4 paths.
- [`historical-losses.json`](historical-losses.json): all 901 unresolved historical paths.

Run each sweep from a clean engine commit using a clean checkout of the pinned corpus:

```sh
RUST_MIN_STACK=67108864 rust/engine/ironhorse-262/scripts/full-run.sh \
  --test262-dir <pinned-test262-checkout> --no-fetch --jobs 14 \
  --oracle on --output <output-directory>
```

Extract covered paths from `cases[].category == "covered"`, sorting with
`key=str.encode` in Python or `LC_ALL=C sort`.
The comparison uses set inclusion, not just a larger covered total.
The reports' `summary.by_category` and `provenance` objects are authoritative.

## Remaining queue

Counts below refer to this pinned corpus and the current classifier.
The old `ironhorse-aborted:wrong-throw:*` buckets are now failures;
`Halt` no longer exposes internal resume/yield transfers.
The earlier 162-resume queue must not be assumed to persist under that architecture.

1. Reconcile the historical floor and investigate the 443 limit demotions.
   A standalone assembled `RegExp/property-escapes/generated/ASCII.js` run stops
   at `HeapExhausted`, with 1,210 slots and 241,986,612 chunk bytes.
   Raising only the probe's chunk ceiling from 256 to 512 MiB leaves that outcome
   unchanged; the matcher also has independent state and payload limits.
   This observation does not diagnose every limit case and does not establish a timeout.
2. Resizable ArrayBuffer support: 1,126 unsupported cases across the non-Temporal/Intl corpus,
   including 938 under TypedArray prototype tests.
3. Class semantics: 257 failures across class statement and expression subtrees.
   Compiler diagnostic fidelity includes a separate 180-case strict-block SyntaxError family.
4. Remaining built-in failure families include Array prototype (110), Number prototype (95),
   RegExp prototype (91), Object prototype (90), SharedArrayBuffer prototype (58),
   TypedArray prototype (41), and Iterator (38 across constructor, concat, and prototype subtrees).
   Native name/length metadata and unreified getters recur across these groups.
5. Module support is already broader than in round 2: module evaluation is no longer
   an infrastructure bucket in this sweep.
   Remaining unsupported reasons include dynamic import (436), top-level await (207),
   and static linking (134).
   Infrastructure includes compiler rejection (98), resolution/linking (34), and
   compiler byte divergence (31).
   No module work was started in this round.

Temporal and Intl remain outside this round's implementation scope.
