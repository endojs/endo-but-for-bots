# IronHorse architecture review: findings still open at `7753a4b9`

The 19 findings of the 2026-09-06 review that are still open or partially open
after the [2026-09-16 revision](ARCHITECTURE-REVIEW.md#2026-09-16-revision-against-7753a4b9),
ordered by severity, open before partially open within a severity.
Severities are the ones the original verification settled on and are not
re-rated by a revision.

This is an index, not an analysis: each finding's claim, evidence, impact,
recommended fix and full status history are in
[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md), in the section named beside it.
The other 172 findings are fixed and are listed in that document's
[Appendix A](ARCHITECTURE-REVIEW.md#appendix-a-full-findings-index).

## Critical

None.

## High

| Id | Status | § | Title |
|---|---|---|---|
| F010 | Partially open | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | Nothing in any wired configuration reclaims the chunk arena; guest JS OOM-kills the worker |
| F062 | Partially open | [3.7](ARCHITECTURE-REVIEW.md#37-security-and-sandboxing) | Silent wrong values at confinement-relevant seams contradict the named-skip doctrine |
| F063 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | Panic-as-control-flow: the coder and scoper are not total |
| F076 | Partially open | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | No allocation-pressure GC and no heap ceiling anywhere in the VM |

## Medium

| Id | Status | § | Title |
|---|---|---|---|
| F039 | Open | [3.8](ARCHITECTURE-REVIEW.md#38-verification-strategy) | Differential fuzzing runs in no in-repo automation |
| F068 | Open | [3.13](ARCHITECTURE-REVIEW.md#313-api-boundaries-and-layering) | No engine abstraction: the Ironhorse `Machine` is a parallel type |
| F110 | Open | [3.11](ARCHITECTURE-REVIEW.md#311-design-drift-and-documentation) | The store-seam design claims three fuzz targets that do not exist |
| F119 | Open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | Exotic-object dispatch by side-table membership |
| F040 | Partially open | [3.8](ARCHITECTURE-REVIEW.md#38-verification-strategy) | Fuzz generator bias is measurable in the trophy ledger |
| F041 | Partially open | [3.8](ARCHITECTURE-REVIEW.md#38-verification-strategy) | The multi-crank oracle is seven hand-written tests |
| F053 | Partially open | [3.14](ARCHITECTURE-REVIEW.md#314-modularity-and-maintainability) | Both mechanical safety nets parse the interpreter as source text |
| F070 | Partially open | [3.6](ARCHITECTURE-REVIEW.md#36-determinism-and-consensus) | Two workspaces, two lockfiles |
| F075 | Partially open | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | The `u16` property-key id space is a monotone machine-lifetime budget |
| F149 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | The compiler has exactly one Script shape, the oracle shim's eval program |

## Low

| Id | Status | § | Title |
|---|---|---|---|
| F106 | Partially open | [3.11](ARCHITECTURE-REVIEW.md#311-design-drift-and-documentation) | The performance envelope has no instrument |
| F121 | Partially open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | `Slot` is 24 bytes, not the documented 32 |
| F122 | Partially open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | The performance envelope has no machine-checked expression |
| F127 | Partially open | [3.9](ARCHITECTURE-REVIEW.md#39-snapshot-and-persistence-seam) | Three Pending rows make every await-bearing machine un-checkpointable |
| F158 | Partially open | [3.14](ARCHITECTURE-REVIEW.md#314-modularity-and-maintainability) | The vm/snapshot coverage contract is enforced by parsing source text |
