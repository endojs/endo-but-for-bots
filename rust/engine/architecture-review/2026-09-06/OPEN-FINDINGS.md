# IronHorse architecture review: findings still open at `27e637606`

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

F063's residue was the reachability audit of the compiler's remaining
`panic!`/`unreachable!`/`expect` sites, and the audit has now been run.
It refuted the claim: `try{}catch{function f(){}}` — twenty-six bytes of valid
ES2022 — aborted the compiler under every goal, and a module-goal
`async function f(a=await 0){}` reached `code_await` with no return target.
Both are fixed, and test262 could not have caught the first: the corpus's one
DIRECTLY nested function-declaration-in-catch case is a `negative: parse`
fixture the parser rejects before the coder runs.
The second took two attempts — a coder-side guard fixed the goal that panicked
and left three goals compiling the same early error into a function whose body
never ran, so the rule moved to the parser where all four modes refuse it.
The two other callers of the asserting helper the catch bug tripped — the two
loop coders — now code their body's defines the same way, and the helper is
deleted, so that class is gone rather than resting on a grammar argument.
What keeps the finding open is narrower, and the scoper half is now a list
rather than a surface: of its 29 `expect`/`unwrap` sites, six are in its own
`#[cfg(test)]` modules, and the 23 production ones are nine shapes, fifteen of
which are the three `Option<usize>` scope fields.
Those three do not share one invariant: `scope` and `function_scope` are set
on entry and restored on exit, so one argument — whether a visitor can run
outside the scope that set it — retires twelve, but `body_scope` is CLEARED to
`None` on function entry and re-established by the body, so it is `None` inside
an open scope and its three readers rest on token dispatch instead.
`body_scope`'s window is now probed rather than argued —
`tests/scoper_totality.rs` drives every way to nest a declarator in a
parameter default across all five goal modes, and none panics — which closes
one of the nine shapes and leaves eight.
The panic surface is wider than those 29 in any case: `node_id` asserts in
release mode from 39 call sites — audited, and unreachable, because the
`u32::MAX` sentinel is only issued on identity exhaustion and `finish_tree`
refuses such a tree at the parse exit; a scanner now holds the exit roster
complete, since that was the one assumption a later entry point could break.
Eight of the nine `expect`/`unwrap` shapes remain.
The bookkeeping `expect`s and the audit's non-reproducible negative over
generated sources are the rest.

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
does not churn.
That is the cost of not collecting within a crank, priced for the first time.

## Medium

| Id | Status | § | Title |
|---|---|---|---|
| F119 | Open | [3.10](ARCHITECTURE-REVIEW.md#310-performance-architecture) | Exotic-object dispatch by side-table membership |
| F068 | Partially open | [3.13](ARCHITECTURE-REVIEW.md#313-api-boundaries-and-layering) | No engine abstraction: the Ironhorse `Machine` is a parallel type |
| F075 | Partially open | [3.1](ARCHITECTURE-REVIEW.md#31-robustness-and-resource-exhaustion) | The `u16` property-key id space is a monotone machine-lifetime budget |
| F149 | Partially open | [3.3](ARCHITECTURE-REVIEW.md#33-compiler-pipeline) | The compiler has exactly one Script shape, the oracle shim's eval program |

F119 is open as a DESIGN question, is no longer ungated, and its two stated
exits are now both closed.
The probe chain is counted and pinned by equality so it cannot grow unnoticed.
The second recommendation — make the callee-class probes lazy — was attempted
at `488398e36` and refuted by two existing tests: a RESTORED bound function or
proxy can carry a runnable body, so the side tables are authoritative and the
class cannot be inferred from the one lookup a call already makes.
That makes the second recommendation depend on the first, whose exotic-kind tag
was measured slower in six of eight cases and removed.
Reopening it means measuring against
[PERFORMANCE-TRADEOFFS.md](PERFORMANCE-TRADEOFFS.md) with a third design.

F068 was open by a decision of record; W6 decision 2 is now reopened and the
trait is extracted.
What remains is its third clause, `Engine::Ironhorse` and spawn-payload
selection, **blocked** on the worker protocol.

F075's residue is reclamation, and it is bigger than the finding's own
recommendation reads.
The `NAME` row does need explicit `(id, name)` pairs and a format increment,
but an inventory at `488398e36` found the live-id sweep must also cover about
twenty-five scalar and map-key holders the existing GC traversal does not
reach, every retained bytecode buffer, and ids held in host handles outside
`Interp` — which a collector cannot see by construction, so reclamation needs
a rooting protocol for those or a rule that host-installed names never prune.
Sparsity also silently defeats the persisted checks, every one of which spells
the bound as `id <= len` rather than as membership.
The sweep fails quietly rather than loudly, which is the silent-wrong-value
class F062 is about.

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
