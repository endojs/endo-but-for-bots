# IronHorse: collection only at quiescence

| | |
|---|---|
| **Created** | 2026-09-10 |
| **Author** | kumavis (prompted) |
| **Status** | Not Started |
| **Source** | GC correctness follow-up to PRs #1250–#1253 |

## Status and scope

This is an accepted implementation direction, **not implemented by this document**.
The observed code baseline is `211e094c2246d5e977bd54177ef06f1c7fc3e59e`.
Locate constructs by name in the current tree; this document does not depend on line numbers.
No runtime behavior, test contract, collection cadence, or snapshot format changes here.

For now, the only supported whole-machine collection point will be a quiescent interpreter.
This narrows the supported invocation boundaries in
[W6 decision 5](ironhorse-w6-decisions.md#5-gc-schedule--decided-engine-consumer-policy).
The embedder still decides whether and when to request collection among those boundaries.
It is not required to collect after every delivery, nor to use a release-fixed cadence.

## Motivation

Collection while a native operation is executing requires tracing every live guest value
held in Rust locals across a callback, and reloading any value whose chunk offset moves.
An instruction boundary inside a guest callback is not enough: its native caller may still
hold such values on the Rust stack.
Correctly tracing the interpreter's explicit stacks does not discover those Rust locals.

The promise fixes reviewed in PR #1251 illustrate the maintenance burden.
A dequeued job can retain its capability only in local variables while a handler executes.
Finally processing additionally retains the original settlement across observable callbacks;
strings and BigInts can move during compaction.
Adding temporary roots also creates cleanup obligations on every return and error path.
The original patch truncated the value stack after host halts even though `native_try`
preserved the failed callee's activation.
Independent StepLimit and StackOverflow probes reproduced missing operands with call frames
still installed; commit `211e094c2` corrected the cleanup before adoption in part 2 (#1253).
These defects justify reducing the supported state space rather than expanding temporary
root machinery without a production requirement for collection during execution.

Quiescence removes native activations and their temporary values from the collection proof.
The collector must still preserve the complete retained guest graph and update its indexes.
This restriction is not a claim that the existing collector is otherwise proven correct.

## Current behavior at the baseline

| Construct | Observed behavior |
|---|---|
| `Interp::collect_garbage`, `interp/gc.rs` | Public full collection; refuses a previous GC failure but does not require quiescence. |
| `Interp::free_pages`, `interp/gc.rs` | Applies a store collector's page decisions; also lacks a general quiescence admission check. |
| `partial_collect`, `generational_collect`, snapshot `machine.rs` | Already check quiescence around store-driven collection. Other checkpoint/store preconditions also apply. |
| `PersistentMachine::collect`, `rust/endo/src/ironhorse_engine.rs` | Flushes pending completed cranks, collects at a boundary, and persists or rewinds according to its existing contract. |
| `GC_AT_STEP`, VM `interp/tests.rs` and `interp/dispatch.rs` | A `cfg(test)` hook injects full collection at a dispatch boundary, including recursive callback dispatch. This is not a production allocation-triggered collector. |
| `Interp::is_quiescent`, `interp/persist.rs` | Uses the checked field roster and lifecycle latch, not merely an empty call stack. |

The baseline also allows tests to collect after a host halt.
That is a separate unsupported point under this design, even though no Rust callback is
still executing once the host receives the halt.

## Required contract

### Admission and refusal

Use the existing `is_quiescent()` predicate as the common admission rule.
A fresh or valid restored interpreter may satisfy it without having executed a crank.
After execution, it requires a completed crank, drained runnable promise jobs, cleared
activation state, zero native depth, and the existing lifecycle/integrity conditions.
Do not replace it with `call_stack.is_empty()`, a host-return check, or `native_depth == 0`.
Do not weaken the predicate merely to make a collector test pass.

A suspended generator or an unresolved promise can remain in a quiescent heap.
Quiescence means no active execution or runnable job drain; it does not require all retained
asynchronous objects to have settled or all saved continuations to have disappeared.

Both full collection and page freeing must refuse non-quiescent machines before marking,
sweeping, compaction, pruning, dirty-state updates, or setting the GC-in-progress latch.
Prefer an explicit typed admission error, with distinguishable non-quiescent and
previous-collection-failure cases, rather than panicking for an ordinary unsupported request.
Update callers to handle that result; do not return a success-shaped zero-work result.
Keep the collector's internal failure classification separate from admission refusal.
The exact public error type is an implementation choice; document the source compatibility
change when changing today's `GcStats` and `u32` return types.

A refused request must not poison an otherwise healthy machine or alter its execution state.
Do not queue a deferred collection inside the VM as part of this implementation.
The embedder may remember the request and retry at a later valid boundary under its policy.
Retain store collectors' checkpoint/dirty-state gates in addition to VM admission.

### Halts, pressure, and recovery

StepLimit, MeterAbort, StackOverflow, HeapExhausted, uncaught guest throws, and engine faults
must not be reclassified as quiescence merely because control returned to the host.
Collection cannot repair or complete an interrupted crank.
The managed embedding must rewind to a valid checkpoint or discard the machine before
collecting; standalone callers can discard and construct a fresh machine.
This design does not introduce resumable halted execution or a new recovery mechanism.

Do not clear frames, jobs, exception state, or completion latches to obtain GC admission.
Preserve existing halt diagnostics and recovery behavior independently of the collection gate.
A previous collector failure continues to disqualify execution and persistence through the
existing `gc_failed` latch; an admission failure is not a collector failure.

Allocation must not trigger emergency collection during execution.
A crank and its microtask drain must fit within the configured memory budget or halt through
the existing bounded resource-failure path for supervisor recovery.
Audit the embedding's actual allocation limits and metering; do not assume a step limit alone
bounds bytes, or promise that every process allocator failure becomes `HeapExhausted`.
If additional resource limits are needed, scope them explicitly rather than silently enabling
collection inside an allocation routine.

### What remains necessary

Keep full graph tracing, weak/ephemeron processing, side-table pruning, chunk relocation,
code-segment and reaction-arena remapping, and suspended continuation tracing.
Keep native-name chunk-boundary validation and release-mode corrupt-reference refusal.
Preserve derived indexes, reference accounting, lazy backing/residency invariants, and the
permanent collection-failure latch.
Neither quiescence nor test deletion establishes these invariants by itself.

Low-level arena collectors may remain usable for isolated graph tests.
Audit their visibility and whole-machine callers so they do not become an alternate public
route around admission on an `Interp`.
Do not remove register or frame root declarations in the initial gate implementation;
any later simplification must justify each removal independently, including saved frames.

## Implementation sequence

1. Inventory full/page collectors, their callers, test hooks, and public arena access.
   Add common admission at both `Interp` mutation entry points and propagate typed refusal
   through snapshot and embedding APIs without weakening their existing preconditions.
   Document the supported boundary and error behavior on the public methods.
2. Replace successful in-dispatch collection injection with a refusal probe at equivalent
   callback boundaries, or remove the hook after equivalent admission coverage exists.
   Do not retain an unchecked full-machine test collector to make the old tests pass.
   Convert post-halt GC expectations to no-mutation refusal tests.
3. Review temporary promise roots introduced by `47723800` and `4d110d8a` from #1251 and
   adapted by `211e094c2` into #1253.
   Remove only machinery justified exclusively by the now-forbidden collection points,
   after proving it has no separate execution or persistence role.
   Preserve normal/throw semantics, host-halt activation integrity, raw meter charges,
   and next-run reset coverage regardless of whether those roots remain.
   Do not blindly revert either the promise repair or the GC/restore checks in `7ca60b5ac`.
4. Exercise all supported boundary collectors, checkpoint/restore paths, and resource failures.
   Update runtime documentation and W6's implementation status only after the tests pass.
   Use incremental commits with an adversarial subagent review loop before each commit.
   Leave the historical architecture review untouched for its whole-review re-verification.

## Acceptance evidence

Prefer oracle-free integration tests in `rust/engine/ironhorse-vm/tests/`, plus snapshot and
embedding tests; use a narrow unit-test hook only where active execution cannot be observed
through the public API.
Run the relevant tests on Linux and macOS, including release-mode admission checks.

- Refuse collection in top-level dispatch, a guest callback under a native operation, and a
  promise job; observe unchanged activation, heap, meter, and failure-latch state.
  Execution must continue normally after the rejected test request.
- Refuse both full collection and page freeing after representative host halts and uncaught
  throws, including a halt whose stacks happen to be empty.
  Check no mutation using internal observations or store state, not a snapshot API that
  already refuses the halted machine.
- Accept fresh/restored and completed quiescent machines.
  Retain suspended generator/async state, unresolved promises, closures, strings, BigInts,
  weak edges, and native-name metadata across collection and subsequent use.
- Preserve the independent graph/slot-reuse tests and corruption/failure-latch tests.
  Corruption tests must reach their intended validation, not pass because a new admission
  failure masks the corrupt reference being tested.
- Adapt `promise_native_roots_preserve_halted_operand_stack` and
  `promise_native_roots_preserve_stack_overflow_operands` to assert refusal without losing
  their distinct operand-retention and next-run-reset assertions.
  Review `every_dispatch_boundary_survives_a_full_collection`,
  `promise_handler_collection_preserves_the_derived_capability`, and
  `finally_and_thenable_collection_preserves_settlement` under the new contract.
- Preserve snapshot `gc_repeated_lazy.rs` coverage of alternating full/partial collection,
  eviction, lazy resume, and suspended-handler relocation.
  Compare guest results and raw meter receipts against independent expected values or an
  uncollected twin, and canonical bytes under matching persistence/collection histories.
  Do not claim generational collection is resume-invariant: its candidate set currently resets.
- Verify admission refusal does not increment collection counters or persist an event.
  Exercise managed rewind on a bounded resource failure and subsequent valid collection.
  Preserve the distinction between a committed delivery and its later failed collection.

Run formatting and relevant VM/snapshot/embedding tests, including store-integrity coverage.
Retain benchmark baselines and report peak allocation and boundary-collection cost for
representative cranks; do not relax thresholds to justify the restriction.
The earlier dispatch timings in #1250 predate the final GC/promise changes and cannot serve
as measurements of this implementation.

## Tradeoffs and reopening criteria

Garbage accumulates until the crank and microtasks complete, increasing peak memory even
when much of it has become unreachable.
An indefinitely replenished microtask queue never reaches this collection point and must
be bounded by execution/resource policy.
Consumers cannot use GC to rescue an oversized in-flight crank.
Collection schedule still affects allocation order and durable heap bytes; consumers needing
replica agreement must coordinate events and recovery as described by W6.

Reopen collection during execution only for a demonstrated workload that cannot reasonably
fit or be divided into quiescent cranks.
A future design must specify safe points, rooting and relocation of native temporaries,
callback/reentrancy rules, halt cleanup, and independent adversarial coverage before adding
an opt-in mode or an automatic pressure trigger.
Do not infer support from a handful of passing injection tests.

## Dependencies and planning

| Design | Relationship |
|---|---|
| [W6 decisions](ironhorse-w6-decisions.md) | Scheduling ownership retained; supported invocation boundaries narrowed when implemented. |
| [Snapshot store seam](ironhorse-snapshot-store-seam.md) | Existing quiescence, durability, and recovery contracts remain required. |
| [Snapshot GC](ironhorse-snapshot-schema-gc.md) | Collector/schema correctness remains independent work. |
| [Panic and recovery](ironhorse-panic.md) | Related future recovery design, not an implementation prerequisite. |

Assigned to M11's existing IronHorse/store work.
Planning estimate: S, 2–4 developer days for admission, caller/test migration, and review;
provisional until the caller audit, excluding any new allocator-budget project.
This refines existing GC work rather than adding a separate milestone or timeline commitment.

## Prompt

> im still concerned about our GC correctness. im wondering if we can make our
> problem simpler by (for now) requiring GC during quiescence. what do you think?
>
> ok lets record this as an unimplemented design including motivation and enough
> information to implement without the context of this conversation. add to the part 2 PR
