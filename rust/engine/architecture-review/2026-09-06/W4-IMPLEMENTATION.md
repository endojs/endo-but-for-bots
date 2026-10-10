# W4 implementation record

Implemented on `codex/w4-cost-determinism`, based on `bots/llm` at `a4f74814f`.
This records the W4 implementation without rewriting the historical findings in
[the architecture review](ARCHITECTURE-REVIEW.md#w4-a-real-cost-table-with-change-detection-and-a-meter-that-is-armed-medium).
Each implementation commit received an adversarial subagent review and fixes
were reviewed again before committing.

## Cost identity and doctrine

The shared [ironhorse-meter crate](../../ironhorse-meter/src/lib.rs) owns the
ordered weight table, `DEFAULT_KEYS`, SHA-256 digest, and
[append-only release pins](../../ironhorse-meter/src/releases.rs).
The VM, compiler, regexp engine, and snapshot layer share that identity.
`METR` carries both the release name and digest; container, eager/lazy store,
and migration readers reject incompatible identities and legacy name-only state.
The original legacy fixtures remain unchanged; storage-format migration tests
explicitly construct compatible synthetic meter identities.

Ironhorse's frozen XS-derived estimates are its release contract.
XS cost drift is advisory, including with the legacy `--gate-meter-exact` flag;
observable result and error comparisons still gate conformance.
These weights do not claim measured CPU calibration.
Release 2 unified UTF-16 string charges and charged Proxy internal methods,
descriptor allocations, keys, and invariant work.
Release 3 added compilation accounting and admission.

## Compilation and execution budgets

[Budgeted compilation](../../ironhorse-compile/src/coder.rs) admits source bytes
before source-sized allocations and charges tokens, scope and symbol scans,
code generation, optimizer scans and record moves, serialization, and growing
BigInt limb conversion.
Its incremental callback debits the running meter and stops immediately on refusal.
Successful `CompiledSource` values report raw and whole compilation costs already
charged through that callback; `eval` and `Function` do not charge those reports twice.
Syntax failures retain incurred charges during the operation, while budget refusal
is a distinct, uncatchable host stop.
The infallible coder's nested loops stop through a private contained unwind;
non-meter panics propagate, and `panic=abort` builds are rejected at compile time.

The [Endo seam](../../../endo/src/ironhorse_engine.rs) begins the crank budget
before compilation and preserves its baseline and consultation window through execution.
Persistent compilation, linking, and execution failures rewind to the last checkpoint.
Fresh boot, resume, and rewind install a host under the default bounded policy;
unbounded execution requires explicit opt-in.
Lower-level restored interpreters can temporarily lack a callback and fail closed
until one is attached; the shipped persistent seam never returns that state.
Straight-line bytecode checks the meter every 4,096 dispatched instructions.
The inherited `dispatch_result!` catch landing checkpoint remains covered by the
existing unwind and meter tests.

## Independent release vectors

- [51 runtime cases](../../ironhorse-vm/tests/fixtures/computrons.tsv) pin results,
  halt kinds, raw costs, and whole computrons across the metering families.
- [15 compilation cases](../../ironhorse-compile/tests/fixtures/computrons.tsv) pin
  lexical costs and complete raw/whole compilation costs and check emitted atoms.
- [16 carried-state cases](../../ironhorse-snapshot/tests/fixtures/state_golden.tsv)
  pin initial/final container hashes, initial seal roots, raw costs, and continuation
  results across continuous execution, container restore, eager store restore, and
  cold lazy store restore.
  These include collection and iterator order, UTF-16 keys, BigInts, closures,
  generators, pending promises, proxies, accessors, private fields, regexp state,
  dates, Intl bound functions, and disposal state.
  Suspended async-generator persistence is outside W4 and remains an explicitly
  tested refusal rather than a claimed snapshot vector.

The oracle-free tests run in the existing Linux debug/release and macOS CI matrix.
The local debug and release runs use the same checked-in pins; no test regenerates them.
The test262 `--repeat` gate compares results, errors, halt diagnostics, raw/whole
costs, dispatched counts, compiler outcomes, bytecode, and symbol bytes.
Async repeats additionally compare the completion sentinel and rejection latch.
Module compile negatives repeat before verdict selection, and missing reruns fail closed.
CI invokes `--repeat 3` over all 1,712 committed Ironhorse corpus cases.

## Validation

Compiler parity and budget suites, VM compilation and runtime golden suites,
snapshot continuation vectors, and Endo meter/store lifecycle tests pass.
The 1,712-case committed corpus passes with three runs per case.
Runtime, compilation, and snapshot vectors pass in both debug and release on macOS/arm64 locally;
Linux/x86-64 coverage is wired through the existing CI matrix.

The repository-wide JavaScript `yarn docs` and `yarn build:types` checks fail in
this checkout on missing workspace module declarations (including `@endo/errors`,
`@endo/captp`, and `@endo/platform/fs/extended`).
Those checks do not validate the Rust implementation, and this work changes no
JavaScript source or type declarations.
