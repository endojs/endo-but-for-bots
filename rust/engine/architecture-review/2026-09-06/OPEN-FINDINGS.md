# IronHorse architecture review: findings still open at `0b25cdba9`

The 10 findings of the 2026-09-06 review that are still open or partially open
after the
[2026-09-17 resolution pass](ARCHITECTURE-REVIEW.md#2026-09-17-revision-against-0b25cdba9),
ordered by severity, and within a severity: open, then partially open, then held.
Severities are the ones the original verification settled on and are not
re-rated by a revision.

This is an index, not an analysis: each finding's claim, evidence, impact,
recommended fix and full status history are in
[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md), in the section named beside it.
The other 181 findings are fixed and are listed in that document's
[Appendix A](ARCHITECTURE-REVIEW.md#appendix-a-full-findings-index).

Nine came off this list in the resolution pass — F039, F040, F041, F053, F062,
F070, F110, F121 and F158 — and F106/F122 narrowed to one clause without
leaving it.

**Held** marks a finding that is not actionable yet because a design decision it
depends on has not been taken.
A held finding is still open; it is not scheduled, and it should not be picked up
as work until the decision it waits on lands.

## Critical

None.

## High

| Id | Status | § | Title |
|---|---|---|---|
| F063 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | Panic-as-control-flow: the coder and scoper are not total |
| F010 | Held (partially open) | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | Nothing in any wired configuration reclaims the chunk arena; guest JS OOM-kills the worker |
| F076 | Held (partially open) | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | No allocation-pressure GC and no heap ceiling anywhere in the VM |

F010 and F076 are held pending a GC usage-pattern design.
Their remaining residue is the intra-crank half — no collection runs within a
crank, and `collect_every` defaults to 0 — and what the right behaviour there is
depends on how consumers actually use collection, which W6 decision 5 assigned
to them and has not yet been designed.
Neither should be actioned until that design exists; the reclamation half is
already closed.

The resolution pass added a measurement to the pair rather than work: the heap
footprint instrument it landed for F106/F122 puts the engine at about 2.5x XS
on allocation churn against a 1.1x bar, and under 0.3x on every workload that
does not churn. That is the cost of not collecting within a crank, priced for
the first time.

## Medium

| Id | Status | § | Title |
|---|---|---|---|
| F068 | Open | [3.13](ARCHITECTURE-REVIEW.md#313-api-boundaries-and-layering) | No engine abstraction: the Ironhorse `Machine` is a parallel type |
| F119 | Open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | Exotic-object dispatch by side-table membership |
| F075 | Partially open | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | The `u16` property-key id space is a monotone machine-lifetime budget |
| F149 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | The compiler has exactly one Script shape, the oracle shim's eval program |

F068 is open by a decision of record, not by omission: W6 decision 2 defers the
trait extraction with three named triggers.
Closing it means reopening that decision, which is a larger call than a fix.

## Low

| Id | Status | § | Title |
|---|---|---|---|
| F106 | Partially open | [3.11](ARCHITECTURE-REVIEW.md#311-design-drift-and-documentation) | The performance envelope has no instrument |
| F122 | Partially open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | The performance envelope has no machine-checked expression |
| F127 | Partially open | [3.9](ARCHITECTURE-REVIEW.md#39-snapshot-and-persistence-seam) | Three Pending rows make every await-bearing machine un-checkpointable |

F106 and F122 are down to one clause between them.
Three of the stage-8 envelope's four measurements now exist — throughput
(gated at 2.0x), code size (~6x against a 2x bar) and heap (0.2x-2.5x against a
1.1x bar) — and none of the three bars is met on every workload, which is what
an instrument is for.
The fourth, the four-variant daemon benchmark, is blocked on the worker
protocol rather than on anything in these findings.
