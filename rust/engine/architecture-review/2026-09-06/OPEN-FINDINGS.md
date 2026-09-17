# IronHorse architecture review: findings still open at `2c69bf78d`

The 9 findings of the 2026-09-06 review that are still open or partially open
after the [2026-09-17 resolution passes][pass], ordered by severity, and
within a severity: open, then partially open, then held.

[pass]: ARCHITECTURE-REVIEW.md#2026-09-17-resolution-pass-third-against-2c69bf78d

Severities are the ones the original verification settled on and are not
re-rated by a revision.

This is an index, not an analysis: each finding's claim, evidence, impact,
recommended fix and full status history are in
[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md), in the section named beside it.
The other 182 findings are fixed and are listed in that document's
[Appendix A](ARCHITECTURE-REVIEW.md#appendix-a-full-findings-index).

The count has moved for the first time since the FIRST pass, which closed
nine: the second closed none, and this one closed F127.
The low-severity set is down to F106 and F122, which are one clause between
them and blocked on the worker protocol.

**Held** marks a finding that is not actionable yet because a design decision it
depends on has not been taken.
A held finding is still open; it is not scheduled, and it should not be picked up
as work until the decision it waits on lands.

**Blocked** marks a clause that has an owner and a prerequisite that is not a
decision: today, all of them wait on the worker protocol.

## Critical

None.

## High

| Id | Status | § | Title |
|---|---|---|---|
| F063 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | Panic-as-control-flow: the coder and scoper are not total |
| F010 | Held (partially open) | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | Nothing in any wired configuration reclaims the chunk arena; guest JS OOM-kills the worker |
| F076 | Held (partially open) | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | No allocation-pressure GC and no heap ceiling anywhere in the VM |

F063's residue is now exactly one thing: the reachability audit of the
compiler's remaining `panic!`/`unreachable!`/`expect` sites.
The classification half is closed end to end, and the compiler is measured
total over all 53,575 sources of the pinned test262 corpus — an empirical
floor, not the audit, and the finding stays open on that difference.

F010 and F076 are held pending a GC usage-pattern design.
Their remaining residue is the intra-crank half — no collection runs within a
crank, and `collect_every` defaults to 0 — and what the right behaviour there is
depends on how consumers actually use collection, which W6 decision 5 assigned
to them and has not yet been designed.
Neither should be actioned until that design exists; the reclamation half is
already closed.

The first resolution pass added a measurement to the pair rather than work: the
heap footprint instrument it landed for F106/F122 puts the engine at about 2.5x
XS on allocation churn against a 1.1x bar, and under 0.3x on every workload that
does not churn. That is the cost of not collecting within a crank, priced for
the first time.

## Medium

| Id | Status | § | Title |
|---|---|---|---|
| F119 | Open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | Exotic-object dispatch by side-table membership |
| F068 | Partially open | [3.13](ARCHITECTURE-REVIEW.md#313-api-boundaries-and-layering) | No engine abstraction: the Ironhorse `Machine` is a parallel type |
| F075 | Partially open | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | The `u16` property-key id space is a monotone machine-lifetime budget |
| F149 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | The compiler has exactly one Script shape, the oracle shim's eval program |

F119 is open as a DESIGN question and is no longer ungated: the probe chain is
counted and pinned by equality, so it cannot grow unnoticed, but neither of the
finding's two fixes has been done and whether the chain should be a chain is
still the open call.
Reopening it means measuring against
[PERFORMANCE-TRADEOFFS.md](PERFORMANCE-TRADEOFFS.md), which measured the
obvious alternative slower.

F068 was open by a decision of record; W6 decision 2 is now reopened and the
trait is extracted. What remains is its third clause, `Engine::Ironhorse` and
spawn-payload selection, **blocked** on the worker protocol.

F075's residue is reclamation, and its prerequisite is named in the finding:
the `NAME` row must carry explicit `(id, name)` pairs instead of positional
order, with its own format increment, before GC can prune `symbol_names` at
all.
The expensive half is the live-id sweep, which fails quietly rather than
loudly.

F149 cannot be closed in the compiler.
It needs a persistent realm lexical environment in the VM — distinct from
global-object properties and from execution frames, preserved across cranks,
integrated with roots, relinking, snapshot, restore validation and rollback —
which `rust/engine/phase-1b-handoffs/F149.md` coordinates with the decided
Realm extraction.

## Low

| Id | Status | § | Title |
|---|---|---|---|
| F106 | Partially open | [3.11](ARCHITECTURE-REVIEW.md#311-design-drift-and-documentation) | The performance envelope has no instrument |
| F122 | Partially open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | The performance envelope has no machine-checked expression |

F106 and F122 are down to one clause between them.
Three of the stage-8 envelope's four measurements now exist — throughput
(gated at 2.0x), code size (~6x against a 2x bar) and heap (0.2x-2.5x against a
1.1x bar) — and none of the three bars is met on every workload, which is what
an instrument is for.
The fourth, the four-variant daemon benchmark, is **blocked** on the worker
protocol.

## Closed since the previous edition

**F127** — Three Pending rows make every await-bearing machine
un-checkpointable — closed at `2c69bf78d`: the claim's remaining clause and the
recommendation's second one.
The `Array.fromAsync` accumulations travel in `ASYN` at format 24 and the four
`FromAsync*` reaction kinds resume, which leaves the persist whitelist covering
every kind the enum defines; and `PersistentMachine`'s documentation states
what a checkpoint refuses where an embedder meets it.
Its status block is worth reading for the defect list rather than the feature:
the carry as first written turned a refusal into a host panic on any queued
`Array.fromAsync` job, and four claims it made about its own test coverage were
false.
