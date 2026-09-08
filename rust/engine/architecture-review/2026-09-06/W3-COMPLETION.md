# W3 persistence gates — implementation record

Implemented incrementally on `codex/w3-persistence-gates`, starting from
`origin/llm` at `a4f74814f`.
Every implementation commit received an adversarial subagent review, with fixes
reviewed again before committing.
This record covers all seven W3 steps, including the highlighted findings
F046, F048, F086, F025, and F126.

1. **Lifecycle latch and ledger (F011).** `is_quiescent` starts with `last_crank_completed`;
   the source reconciliation checks its presence and polarity. Halted-crank persistence tests
   exercise refusals even with empty tables.

2. **Dispatch completion and transients (F030, F022, F103, F025, F165).** Successful dispatch
   clears activation registers before host rendering. Host coercion and rendering failures
   travel separately in `RunOutcome` and affect only `host_coerced()`. Every classified
   transient has an independent quiescence gate; retained eval policy is classified as host
   wiring. Constructor targets remain rooted across halts. Cyclic, Symbol, and null-prototype
   completion twins persist and agree after collection.

3. **Data-path proofs (F047, F155, F124).** Immutable `GatedImage` is required by production
   blob and batch writers. Compile-fail tests reject raw images and mutation. The blanket
   `HeapStoreCommit` implementation owns commit admission; backend hooks obtain batches only
   through `VerifiedCommit`. The shared `commit_contract` runs across memory, reopened file,
   and reopened SQLite stores.

4. **Decoder and storage identity (F048, F046, F163, F167, F129).** Canonical container and
   small-state decoding reject unconsumed data. Eager, lazy, and checkpoint gates reject live
   edges into free records, including reuse before fault. Buffer lengths must match allocation
   headers, with detached semantics preserved. CAS reads validate canonical keys and rehash
   content.

5. **Authenticated manifest policy (F126, F091).** Schema 27 roots bind the manifest core;
   seals bind succession. Collection cadence and event count persist, and reopening with a
   different cadence refuses. Hostile manifest changes fail authentication.

6. **Mechanical boot identity (F086).** The boot fingerprint hashes the actual ordered
   intrinsic layout and reconciles all boot-derived fields. Unknown or mismatched boot
   identities receive a distinct refusal. Tests mutate layout without a version change.

7. **Acceptance instruments (F125, F042, F124, F037, F041).** The shared suite exercises all 16
   suspend subsets of a five-crank workload, halted-crank rewind, collection-boundary image
   bytes, reopened stores, and commit refusals. The VM sweeps a full collection at every
   dispatch step across closures, constructors, exceptions, and callbacks. The refusal registry
   checks named corruption labels against positive assertions or explicit exceptions.

## Compatibility and limits

The canonical container format is version 16; the store schema is version 27.
Older container encodings remain inspectable under their documented legacy rules.
Store migration verifies the old root before normalization and restamping.
Snapshots without a matching mechanical boot identity are intentionally refused
for execution; changing a host-provided signature cannot bypass this check.

Unchecked image construction is restricted to the explicit `unchecked-tooling`
feature used by tests and fuzzers.
Ordinary production persistence builds do not expose these bypasses.

FileStore retains its documented single-writer caller contract.
SQLite performs shared commit admission inside an IMMEDIATE transaction.

The refusal registry is a syntactic change detector, not a proof of test execution.
Its checked-in allowlist records existing exact-label coverage debt explicitly;
allowlisted cases must still be rejected by their production guards.
New labels, unknown dynamic producers, constructor or forwarding aliases, and
stale or duplicate exceptions fail the registry.

## Validation

Validation includes VM unit and native-recursion tests, the full snapshot and
SQLite suites, worker persistence tests, engine workspace target checking,
Clippy, and Rust documentation builds.
The repository has existing Clippy and rustdoc warnings; successful checks do not
claim a warning-free baseline.
The generated XS worker bundles needed by the outer Rust workspace are ignored
build artifacts and are not included in these commits.
