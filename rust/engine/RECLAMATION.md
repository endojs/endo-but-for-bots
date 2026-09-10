# Phase 2B reclamation

This implementation follows W6 decision 5: scheduling is consumer policy.
The accepted quiescence restriction defines when a request can be serviced.
The dated architecture review remains unchanged for independent re-verification.

## Behavior and findings

| Finding | Implementation and evidence |
|---|---|
| F010, F076, F090 | `PersistentMachine::collect` uses snapshot `full_collect`, which invokes the exact VM collector. Explicit requests and configured delivery cadence now reclaim chunks and weak entries. `full_collection.rs` checks dead WeakMap/WeakSet entries, retained keys, chunk reduction, and canonical resume; `ironhorse_store_worker.rs` checks durable production collection and recovery. |
| F088 | The existing derived `gc_root(error_accessor)` annotation preserves the boot accessor triple. `gc_anchor_truth.rs` now tests collection before the first use of `Error.stack`, including an uncollected control. The production collector test also reads it after collection and restore. |
| F097 | Both VM collection entry points require the complete `is_quiescent()` predicate. Native-local values across callbacks cannot be exposed to supported collection. The registry's unconditional `DocumentedOnly` rows now require named behavioral tests. Stale-slot debug assertions already existed in both arena accessors at the branch base and remain intact. |
| F165 | Typed `NotQuiescent` and `PreviousCollectionFailed` admission errors replace unchecked entry. Dispatch, native callback, promise job, halted-state, empty-activation, and page-freeing probes check refusal before mutation. |
| F189 | Symbol-key allocation starts below the environment sentinel. `stored_key_id` excludes internal environment markers without hiding malformed ordinary keys. Negative witnesses and live symbol-key collection tests cover the partition. Restore rejects the reserved id. |

`gc_consumer_schedules.rs` pins distinct delivery, pressure, idle, fake-time, explicit,
and never-collect event sequences.
Unreachable sentinels survive each delivery until the consumer requests collection.
The engine neither chooses a cadence nor queues a deferred request.
Existing replica fixtures compare matching schedules across continuous execution and resume.
Generational collection remains explicitly not resume-invariant.

## Integrity and compatibility

Exact collection requires a quiescent interpreter and a clean, current store checkpoint.
The adapter verifies the session epoch and seal before mutation.
It does not choose or increment the consumer's collection counter.
The managed embedding checkpoints a successful event and rewinds on collection or checkpoint
failure, including a collector panic.
A delivery committed before scheduled collection failure remains committed.
The failure is reported separately, so the consumer can retry collection without replaying it.
Fault tests cover these counters, durable state, and retry behavior.

The existing failure latch, derived side-reference indexes, corruption checks, lazy backing
rules, authenticated cadence, and old root/seal validation remain required.
Raw arena collectors are isolated-graph APIs, not a supported route around Interp admission.
Temporary promise-root ranges remain because the implementation reads settlement state from
them and preserves their operands on host halts; removing them needs a separate execution
state refactor.

The VM collection APIs now return `Result`, a source compatibility change.
Snapshots containing a symbol assigned the reserved environment id are rejected as an
unsupported legacy symbol namespace.
They are not silently renumbered or resealed; migration requires a separately validated path.
Canonical empty symbol-table bytes remain unchanged.
Populated-state golden hashes are intentionally repinned, while historical meter costs and
historical fixture files remain preserved.

## Memory and scheduling costs

The existing defaults remain one million slot addresses and 256 MiB of chunk storage.
Custom ceilings are host policy and must be reapplied after restore.
These limits do not bound total process memory or all aggregate side-table allocations.
No collection runs within a crank.
Allocations can reuse previously reclaimed space, but newly unreachable garbage waits until
a supported boundary.
An oversized crank still halts and must be rewound or discarded before collection.
The managed embedding uses the existing default arena ceilings, not a new process-wide cap.

Full collection traces the retained graph, processes ephemerons, sweeps slots, prunes side
tables, and compacts chunks.
It can make a lazy heap fully resident and turn the next checkpoint into a near-full write.
It is more work than the former conservative page-only production path.
The consumer must account for that boundary latency and peak residency when choosing cadence.
Partial collection remains available but does not reclaim chunks or provide exact weak liveness.

The ignored `reclamation_boundary_memory_and_cost` instrument runs seven fresh machines per
size and reports the median collection latency.
For its append-only string-churn crank, boundary chunk length is also the peak arena length.
It excludes Rust scratch allocations and allocator slack and is not a process RSS measurement.
The first macOS release observation is:

| Concatenations | Peak chunk bytes | Retained chunk bytes | Slot addresses / retained live slots | Collection median ms |
|---:|---:|---:|---:|---:|
| 100 | 95,168 | 11,960 | 887 / 887 | 0.119875 |
| 500 | 2,027,968 | 11,960 | 887 / 887 | 0.135917 |
| 1,000 | 8,043,968 | 11,960 | 887 / 887 | 0.178459 |

## Performance evidence

The Linux historical control remains at
`benches/results/linux-reference-controls.json` without threshold changes.
Its free-phase ratios of 1.110×, 1.193×, and 1.254× compare `b2b78ad0` with `51b99651`.
Absolute Linux timings cannot establish a regression ratio for this macOS host.
The portable comparison remeasures the pinned revision with the same current fixtures,
compiler, and host; the fixture adapter handles both old and new collection return types.

Three macOS reports are retained, including failed gates:

- `macos-2b-after.json` compares GC medians to the pre-change observation at `26bbe71b6`.
- `macos-2b-reference-comparison.json` remeasures the original `51b99651` reference.
- `macos-2b-start-comparison.json` remeasures the exact Phase 2B starting revision `26bbe71b6`.

Against the remeasured starting revision, partial/free ratios at 5,000, 20,000, and 80,000
slots are 0.947×/0.943×, 1.002×/1.005×, and 1.018×/1.020× respectively.
The per-slot sweep ratios are 0.866×, 1.026×, and 1.070×.
The older-reference comparison instead reports partial/free increases of roughly 4–6%.
These observations do not show removal of the historical page-free scaling cost.

The overall benchmark gate **fails**: checkpoint-slide ratios against the starting revision
reach 1.314×, exceeding the unchanged 1.25× threshold.
Placeholder ratios near 1× against the starting revision indicate that the larger
older-reference placeholder differences do not isolate Phase 2B.
These are measured regressions/variation, not an overall benchmark pass.
Linux CI measurements and final cross-platform validation remain outstanding.
