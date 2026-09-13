# PR #1263 review follow-up

Source: [review of 1479b2db](https://github.com/endojs/endo-but-for-bots/pull/1263#issuecomment-5649374708).
The target is one Realm per Machine, with multiple Compartments sharing ordinary
intrinsics and retaining distinct globals and evaluators.

Work in this order; complete an adversarial subagent review and resolve its
findings before every commit.

1. [x] Fix duplicate global endowments and descriptor/integrity enforcement;
   test deletion, frozen globals, and caught native/callback host panics.
2. [x] Separate Machine, Realm, Intrinsics, and compartment environment records;
   preserve canonical keys, code storage, and initialization of primordials once.
3. [x] Add machine-associated rooted value sharing; capture defining environments
   for functions and support direct and nested A → B → A guest calls.
4. [x] Bind indirect eval and Function to their compartment; expose Machine job
   pumping and preserve callback contexts and queue ordering across compartments.
5. [x] Retain environments/code through functions, jobs, and host handles after
   collection and Compartment drop; make queued-work abandonment explicit.
6. [x] Check persistent-worker permit policy at open/resume/rewind, rejection and
   meter isolation, carried-state coverage, and the reported async restore issue.
7. [x] Reconcile current documentation and PR scope, run appropriate validation,
   push reviewed commits, and continue CI/conflict monitoring.

Follow-up implementation published to #1263 on 2026-09-13.
The 10-minute monitor continues while the PR remains open; merging is not requested.

## Expanded scope, 2026-09-13

Source: [snapshot and F054 requirements](https://github.com/endojs/endo-but-for-bots/pull/1263#issuecomment-5650044747).
The preceding checklist records the first follow-up, not completion of this scope.

8. [x] Carry shared environment, evaluator, function/frame context, ordered jobs,
   rejection, and host-root records through the schema and restore validator.
9. [x] Expose Machine container persistence and explicit compartment/root
   reacquisition; release unclaimed roots and reattach compiler/permit/loader policy.
10. [x] Integrate shared Machines with paged HeapStore eager/lazy resume,
    checkpoints, collection, and rewind in the supported persistent consumer.
11. [x] Implement F054 host-callable registration through the common dispatcher,
    with rooted captures, stable persisted identities, and explicit reattachment.
12. [x] Add uninterrupted/restored continuity and malformed-state tests, complete
    adversarial review loops, reconcile documentation, and publish reviewed commits.

Multiple Realms, cross-machine messaging, and JsMachine (F068/F157) remain deferred.
Full daemon SES acceptance is a separate acceptance bar, not implied by freezing.
Do not edit the historical architecture review.

Shared persistence review loops resolved queue-only combinator and async anchors,
scoped evaluator restore ordering, cyclic callable admission, module-only environments,
prospective intrinsic binding lookup, report ownership, partial-allocation recovery,
and independent provisional compartment/export root lifetimes.
Both adversarial reviewers reported no remaining blocker in this increment.
Format 21/store 32/row release 2 carry shared state; format-20 byte controls are retained.
F054 host registration was the remaining increment at this checkpoint.

Validation for the shared increment: full ironhorse-snapshot suite; VM unit, realm
and promise-pump suites; Endo engine unit, meter-bound, runtime-compiler and store-worker
suites; deterministic-provider shared/golden/metamorphic suites; Rust 1.88 Clippy with
warnings denied and rustfmt.
Rust API documentation builds, with existing VM rustdoc warnings.

F054 now has a Machine-owned service registry keyed by stable name/ABI identity,
scoped call values, rooted captures, common native dispatch and explicit restore policy.
Both adversarial reviewers cleared the implementation after fixes for swallowed resource
stops, native-depth recovery, compiler ownership, arity reflection, malformed capture/name
payloads and conflicting callable owners.
Format 22/store 33/row release 3 carry host recipes; format-21 byte controls are retained.
The full validation pass also covers the GC registry and fuzz initializer omissions
reported by CI on the shared persistence commit.

Final F054 validation: 930 VM unit/integration tests; 615 snapshot tests plus the
post-collection host-creation regression; 24 Endo engine and 29 integration tests;
deterministic-provider shared/golden/metamorphic tests; compile-fail scoped-value
contracts; all-target VM/snapshot Clippy with warnings denied; fuzz compilation;
Rust documentation build and pinned rustfmt.
The documentation build retains 27 existing VM rustdoc warnings.
The expanded scope is implemented; CI/conflict monitoring remains active for the PR.
