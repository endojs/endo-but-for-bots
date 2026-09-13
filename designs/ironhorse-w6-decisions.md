# IronHorse W6: the open layering decisions, and their answers

| | |
|---|---|
| **Created** | 2026-09-09 |
| **Updated** | 2026-09-13 |
| **Author** | kumavis (prompted) |
| **Status** | Active |
| **Source** | Architecture review workstream W6 (`rust/engine/architecture-review/2026-09-06/ARCHITECTURE-REVIEW.md`) |

## Status

This is the decision of record for the four questions the architecture review
grouped as workstream W6, plus one the review filed elsewhere that behaves the
same way.
Two were answered in conversation and never written down, which is the reason
this document exists: W6's own framing is that these questions "are currently
being answered by accident," and an answer that lives only in a chat log is
still being answered by accident.

Baseline: `1b130df7`; decision 5 updated for Phase 1G at `96db92e23`.

| # | Decision | State | Findings |
|---|---|---|---|
| 1 | Realm | **Decided** 2026-09-08 — extract a `Realm` | F059, F054, F159, F144 |
| 2 | Engine trait | **Deferred** 2026-09-08, with a stated trigger | F068, F157 |
| 3 | Integrity model | **Decided and implemented** before `f109e8f4` | F058, F015, F057 |
| 4 | Determinism scope | **Implemented** 2026-09-10 — software `libm` feature after C1–C4 | F080, F081 |
| 5 | GC schedule | **Decided** 2026-09-09 — engine-consumer policy; reclamation remains Phase 2B | F091, F010, F076, F090 |

## 1. Realm — decided: extract it

The review offered an either/or: extract a `Realm` from `Interp` so intrinsics
can be shared across realms and `Compartment` can point at one, **or** delete
`Compartment` / `Machine` / `Intrinsics` from the public surface until it lands.

**Decision: extract a `Realm`.** We want a Realm definition; the public surface
stays.

What that commits us to, stated so the next reader does not have to re-derive
it. `Compartment::evaluate*` still obtains a fresh, independently-owned `Interp`
per call (`Interp::new()` for the unlinked evaluator, `BootTemplate::instantiate`'s
deep arena copy for the symbol-linked ones).
F176 made that path fast — 228.67 to 11.52 ms per 1,000 fresh realms — but it
made the wrong thing fast: `Intrinsics` now holds a per-machine *pristine
template* that is deep-copied per realm, not shared frozen intrinsics.
The boot cost got cheap instead of going away.
Extraction therefore has to replace that template, not build on it, and requirement
5 (Hardened JavaScript) cannot be built incrementally on today's seams.

Because the public surface stays, F159 becomes a naming obligation rather than a
deletion: `ironhorse_vm::Machine` currently occupies the design's `Machine` name
while being a stateless compartment factory, and that has to be reconciled when
`Realm` lands rather than left as drift.

**Scope clarification (2026-09-13, PR #1263 review).**
The extraction supports one Realm per Machine and multiple Compartments within it.
The Realm's default global environment also serves the start compartment.
Other compartments have their own globals and evaluators over shared ordinary intrinsics.
Functions capture defining environments, invocation contexts stack, and the Machine
pumps one ordered job queue through the same call machinery.
Rooted values share references within a machine; dropping a compartment cannot
invalidate functions or callbacks that remain reachable.
Multiple iframe-style Realms and cross-machine messaging are deferred.
This supersedes the earlier references to N independent realms as this work unit's scope.
Full daemon SES acceptance and arbitrary host-function registration remain separate.

## 2. Engine trait — deferred, and here is the trigger

The review's recommendation was to extract `JsMachine` in
`rust/endo/src/engine.rs` and implement it for `xsnap::Machine` first, which is
mechanical and changes no behaviour.
The surfaces are surveyed in
[ironhorse-engine-trait-research.md](ironhorse-engine-trait-research.md).

**Decision: deferred.** The question that actually decides this is not "when do
we extract the trait" but **"does `rust/endo` need to run on both xsnap and
IronHorse, and by when?"**
Until that is a real requirement with a date, the trait is speculative
generality: it would freeze a common shape across two engines whose seams are
still moving, and the second implementor is the one that tells you what the
shape should be.

**Trigger to reopen:** any of —

- a shipped configuration that must select between xsnap and IronHorse at
  runtime rather than at build time;
- a third consumer of either machine type in `rust/endo`;
- the worker protocol landing (it is the seam where the two types would first
  have to answer the same calls).

**Accepted cost of waiting.** The retrofit surface grows with each window and
this is not free. `PersistentMachine` gained `meter_bounds()` and a
compile-then-execute budget sequence in the `1b130df7` window, neither of which
has an xsnap analogue; `rust/endo/src/ironhorse_engine.rs` grew 331 lines. Two
parallel types (`Machine`, `PersistentMachine`) still share nothing, and engine
selection is still a string match in `bin/endor.rs`. If the trigger fires, expect
the extraction to be larger than the review's "mechanical" estimate.

## 3. Integrity model — already decided, and already implemented

The review asked for integrity to move from a per-property flag to a per-instance
level consulted by every own-state write path.

**This landed before the review's first revision** (commits `11546085`,
`9d4f4689`), and F015, F057 and F058 have read `fixed` at every revision since.
`harden()` no longer returns successfully over a graph it did not freeze — a
failing trap or definition clears the visited bit from every item in the worklist
so a later attempt retries rather than short-circuiting a half-frozen graph.
A frozen `globalThis` rejects bare-identifier assignment.
The `freeze:exotic-object`, `isFrozen:exotic-object` and `harden:exotic-object`
refusals no longer exist in the crate.

**The mechanism differs from the proposal, and the difference matters.** What
landed is not a per-instance integrity level; it is `Object.defineProperty`
admitting every receiver shape (ordinary, array, collection, buffer, view,
wrapper, regexp, proxy) with reflection and integrity operations routed through
the complete `mop_*` dispatchers. The outcome the review wanted is achieved.
But completing a seam only holds if nothing routes around it, and **F056 and
F061 record 47 call sites that still bypass it** — which is why those two are
the residue of this decision rather than an unrelated cluster, and why they
belong to whoever picks up the property/MOP seam work.

W6's bullet list in the review still carries this as an open decision, because
§4 is kept as written against `97d8de25`. Read this row instead.

## 4. Determinism scope — decided: vendor `libm`, behind a feature

The review offered: either vendor `libm` and rebuild the oracle against it, or
state the per-binary-per-platform scope in the design and README where consumers
read it — and canonicalize NaN on ingress either way.

**The NaN half is done.** F081 closed at `1b130df7`: canonicalization sits at
the single `Slot::of` constructor and independently in the snapshot codec, so a
slot mutated in place still encodes canonically.

**Decision: add a Cargo feature selecting the transcendental provider**, pure-Rust
`libm` against the platform's, and treat pure-Rust as the determinism-carrying
configuration.
**Implemented 2026-09-10:** `deterministic-math` selects libm 0.2.16 with
`force-soft-floats`; `consensus` enables it and the ordinary default stays platform.
C1–C3 preceded this work, and C4 landed in `b7ad82dab` before the runtime feature.
The selected provider also covers `**` and enters snapshot compatibility.
See [the implementation record](../rust/engine/DETERMINISM-METERING.md).

Three facts make this cheaper than it reads, all verified at `1b130df7`:

- **`libm` 0.2.16 is already in `rust/engine/Cargo.lock`**, pulled transitively
  by `core_maths` from the ICU stack. A direct dependency on it adds no crate and
  no lockfile churn.
- **The golden computron corpora do not exercise transcendentals.** All 51
  runtime cases use `Math.floor` and `Math.max` only, both exact. Switching
  providers does not force a corpus re-pin.
- **The exposed surface is 30 corpus files** under
  `packages/test262-runner/test262/test/ironhorse` that call `Math.sin`, `cos`,
  `tan`, `exp`, `log`, `pow`, `atan`, `hypot`, `cbrt` or their siblings.

### Required coverage

`ironhorse-vm/tests/` contains **no oracle-free test naming any transcendental**.
The only coverage is those 30 corpus files, and they run in `test-ironhorse-oracle`
— `ubuntu-latest` only, because it needs XS built. So the macOS lane, the very
lane that would catch a cross-platform divergence, does not exercise
transcendentals at all.

This section is the specification. The feature must not land without C1 through
C4; C5 and C6 are independently valuable and can land first.

#### The function set

**22 provider-sensitive functions**, all reached through `Interp::call_math`
(`ironhorse-vm/src/interp.rs`), none of which IEEE-754 requires to be correctly
rounded — which is why two conformant implementations may differ in the last
place:

| Arity | Functions |
|---|---|
| Unary (19) | `acos` `acosh` `asin` `asinh` `atan` `atanh` `cbrt` `cos` `cosh` `exp` `expm1` `log` `log1p` `log10` `log2` `sin` `sinh` `tan` `tanh` |
| N-ary (3) | `atan2` `pow` `hypot` |

**4 exact controls**: `abs`, `ceil`, `floor`, `sqrt`. IEEE-754 requires `sqrt`
to be correctly rounded and the other three are exact, so these must be
bit-identical under every provider and platform. They belong in the same test
file as a control: if a control ever moves, the harness is wrong, not the
provider.

#### C1. Oracle-free known-answer tests, on every lane

One case per function in `ironhorse-vm/tests/`, so they run in `test-ironhorse`,
`test-ironhorse-release` **and** `test-ironhorse-macos` — not in the oracle lane.
Getting these onto the second platform is the entire point; a transcendental
test that only runs on Linux cannot see the divergence it exists to detect.

**Assert on `f64::to_bits()`, never on an epsilon.** An approximate comparison
cannot see the sign of zero, and bit equality is what determinism actually
requires. `assert!((a - b).abs() < 1e-12)` is not acceptable in this file.

#### C2. The neighbour-distinctness rule

A previous attempt at this test was near-worthless: 14 of its 22 assertions
expected `0.0`, so miswiring `sin` to `tan` would have passed it. The rule that
prevents a repeat, stated so it can be enforced mechanically rather than
remembered:

> For each function's chosen probe input, the expected result must differ from
> the result every *other* function in the set produces at that same input.

Make the test file assert this about itself — build the 22 expected values,
check them pairwise-distinct, and fail if any two coincide. Then a lazily chosen
probe cannot silently weaken the net later. Choose inputs away from shared fixed
points: `0` is disqualified for most of the set, and `1` for several.

#### C3. Special-value matrix, bit-exact

ECMA-262 pins these results exactly, so they must hold under **both** providers
and are the strongest part of the net. Per function, cover:

- `NaN`, `+0`, `-0`, `+Infinity`, `-Infinity`
- the smallest positive subnormal, and `f64::MAX`
- each function's domain edges and out-of-domain arguments: `acos(1)`, `acos(2)`
  → `NaN`, `log(0)` → `-Infinity`, `log(-1)` → `NaN`, `atanh(±1)` → `±Infinity`,
  `pow(±1, ±Infinity)` → `NaN` (XS's explicit special case, already implemented),
  `hypot()` with no argument → `0`

A sign-of-zero regression here is the most likely silent break, which is the
second reason for C1's bit-level assertions.

#### C4. Cross-provider differential

Run one shared input vector under both features and record, per function, the
ULP distance between providers. Assert:

- **exact equality** for every case in C3 — a provider that moves a
  spec-mandated value is disqualified, not merely divergent;
- a **stated, checked-in bound** on the ULP distance for ordinary values, with
  the measured distances retained as an artifact.

That artifact is the answer to "what does switching providers actually cost,"
and it is the thing to attach to the decision to flip the default.

#### C5. Cross-platform differential — do this one first

The same oracle-free vector, run on the Linux and macOS lanes under the
**current** platform-libm build, compared bit-for-bit. This needs no feature, no
vendoring and no decision, and it answers the question the whole decision rests
on: *is the platform divergence real on the platforms we ship, today?*

If it is, that is the evidence for flipping the default. If it is not, the
feature is still worth having for fleets we do not control, but its urgency
changes. Either way the measurement is cheap and the lane that makes it possible
only started existing at `c14706d3`.

#### C6. Computron coupling

Transcendental results feed guest branches, so a last-ulp difference diverges
computrons transitively — a full determinism break, not a rounding nit. The
runtime golden corpus has **zero** transcendental cases today, so a provider
swap is invisible to the meter's own vectors.

Add at least one case to `ironhorse-vm/tests/fixtures/computrons.tsv` where a
transcendental result drives a branch, so divergence surfaces as a computron
mismatch and not only as a value mismatch. Note that this case, unlike the
existing 51, *will* need re-pinning if the provider changes — which is the
correct behaviour and the reason to add it deliberately rather than discover it.

#### C7. Oracle expectations under a swap

The ordinary default stays platform and the XS oracle is not rebuilt.
All 30 original provider-sensitive specimens retain their platform assertions.
The oracle-free `math_corpus_profile` test checks their exact inventory under both
providers, accepting only two pinned libm differences (`055.js` and `057.js`).
The other 28 must still pass their original assertions.
The cross-host pure-provider vector allows no Linux/macOS or debug/release differences.
A local 72-file stage3-math XS run with `--repeat 3` confirms exactly those two failures.
See [the C7 record](../rust/engine/DETERMINISM-METERING.md#c7-scope-before-any-default-change).

### The part still to scope

C7's original 30-file question is now scoped as above.
A fleet migration is still a consumer deployment decision: provider changes can
alter guest branches, receipts and durable state, and snapshots reject profiles
with different boot identities.
This feature does not define a heterogeneous-fleet rollout protocol.

### Documentation debt this decision settles

The existing decision-of-record ("determinism is scoped per release binary per
platform") lives in `designs/ironhorse-snapshot-store-seam.md` — a *store-seam*
document — and in a private comment above `call_math` in `interp.rs`.
Meanwhile `designs/ironhorse-engine.md` still carries the unqualified promise,
and `ironhorse-meter/src/lib.rs` opens with "one canonical, platform-independent
SHA-256 identity," which is true of the weights and reads as a claim about
execution. Whichever way the implementation goes, those three have to agree.

## 5. GC schedule — decided: engine-consumer policy

**Decision (Phase 1G, 2026-09-09): GC scheduling is an engine-consumer concern
(EMBEDDER policy).**
Endor and Thixotrope may choose to collect after quiescing a message delivery.
Other consumers may choose pressure-, idle-, or time-based cadences, or explicitly
request collection.
Those are legitimate consumer choices; the engine does not impose one release-fixed
schedule on all of them.

This settles the ownership question in F091 and unblocks specification of Phase 2B.
The engine provides collection mechanics, safe collection boundaries, and the
information consumers need to schedule collection.
The consumer decides when to request it and what scheduling guarantees its own
application requires.
Phase 1G changes no runtime code and does not touch `interp.rs`, which belongs
exclusively to 1A during the freeze.

### Implemented invocation restriction (2026-09-10; Phase 2B)

[Collection only at quiescence](ironhorse-quiescent-gc.md) records the accepted
restriction and its motivation, admission rules, and test migration.
Quiescence is now the only supported whole-machine collection boundary.
Collection during dispatch or after a halted crank is refused before mutation.
This narrows invocation latitude in the contract below without transferring scheduling
policy to the engine.
Pressure, idle, time, and delivery-based policies remain consumer choices;
their requests must be serviced at a supported boundary.
The exact production collector and managed rewind are implemented.
Linux release and macOS engine CI pass at `c73ac252e`; the
[reclamation report](../rust/engine/RECLAMATION.md) records verification, compatibility,
and measured costs, including failed benchmark thresholds.

### Current behavior and the determinism boundary

At `96db92e23`, `CadencePolicy::collect_every` in
`rust/endo/src/ironhorse_engine.rs` is embedder-selected (default `0`).
`PersistentMachine::eval` computes `collect_due` from completed cranks and that
cadence, while `PersistentMachine::collect` accepts an explicit caller request.
Consumer-selected cadence and explicit collection are consistent with this decision;
they are not defects to replace with a GC schedule stamped beside
`COST_TABLE_VERSION`.

Collection changes free-list order and subsequent allocation.
Equal guest inputs and the same engine release alone therefore do not promise
identical durable heaps under different consumer collection schedules.
The sealed `collections` counter records events; it does not make independently
chosen events agree.
A consumer that requires replica-identical heaps must coordinate collection events
and relevant policy as part of its own replicated execution contract, including
recovery and resume.
A consumer without that requirement may use local pressure, idle time or wall time.
This decision does not impose a consensus protocol on all engine consumers.

The already-landed half of F091 stays intact: `cranks` is bound into the manifest
root and seal, both recomputed by `validate_store` at open.
The recorded cadence is currently durable first-writer-wins state: open and succession
checks refuse mismatches, `StoreSession` has no cadence setter, and migration
currently does not rewrite it.
These are existing persistence constraints, not evidence that the engine release
owns scheduling.
Schema-27/28 validation, legacy root verification, and the two manifest hashes
remain carried costs.

### Contract for Phase 2B

1. **Separate scheduling from collection mechanics.**
   Expose supported collection operations and their safe-point requirements so
   consumers can choose their own cadence.
   Quiescence after a message delivery is a useful consumer boundary; it is not a
   mandatory schedule for every engine user.
   Pressure accounting or notifications can inform the consumer without silently
   choosing a consensus-visible collection event inside the engine.
   Phase 2B must specify supported invocation boundaries and preserve all live roots;
   an unsafe request must be refused or deferred to a documented safe point.
   Idle/time/pressure triggers do not authorize collection racing guest execution.

2. **Keep explicit collection available to consumers.**
   Do not remove `PersistentMachine::collect` merely because callers can choose
   different schedules, or require `collect_every` to equal a release constant.
   The current crank cadence is one scheduling option, not the definition of GC
   policy for every consumer.
   Consumer adapters may impose narrower rules, including deterministic post-delivery
   collection, when their application's guarantees require them.
   Such rules belong to those adapters or their protocol, not a universal engine gate.

3. **Preserve persistence integrity while allowing policy evolution.**
   Existing store cadence checks cannot simply be bypassed or normalized on open.
   If a consumer needs to change an existing store's cadence or persist a richer
   scheduling policy, define an explicit validated transition or migration that
   verifies the old integrity state and records the new state.
   A consumer-owned policy can be authenticated without becoming release-owned.
   Whether a consumer must persist its scheduling clock across container/store resume
   depends on its contract; document what each path carries or resets.
   No new GC release-identity field or migration is required solely to settle this
   ownership decision.

4. **Make collection outcomes and recovery usable by the consumer.**
   Preserve heap integrity and the documented durability/rewind contract on failure.
   Report whether a delivery committed and whether its requested collection completed
   so recovery does not replay an already-committed delivery or double-count an event.
   Today scheduled failures are latched by `failed_collections` after the crank has
   become durable; consumer code must be able to act on that outcome.
   The consumer chooses retry, continued execution, or stopping within the engine's
   safe recovery contract.
   A replicated consumer must coordinate that choice if it requires identical heaps;
   a mandatory retry-before-execution rule is not imposed on unrelated consumers.

5. **State the guarantees of each collector.**
   Collector algorithms and snapshot formats still have release compatibility
   obligations; consumer scheduling does not remove them.
   In particular, `generational_collect` is documented as not resume-invariant:
   its `gen_dirty` candidate set resets at resume.
   Do not promise replica-identical heaps across resume for a consumer using that
   collector until its candidate state is made deterministic across that boundary,
   or that consumer's contract otherwise accounts for it.
   Preserve the distinction between memory safety, guest-visible semantics, and
   byte-identical persistence; collection-sensitive features need explicit semantics.

### Acceptance evidence required of Phase 2B

Use oracle-free tests in `ironhorse-vm/tests/` for allocation/reclamation behavior,
with persistence and consumer-boundary tests in the snapshot and Endo suites.
Run the applicable tests on Linux and macOS, including release mode.

- Exercise explicit collection at supported safe points and refusal/defer behavior
  at unsupported points; preserve roots and live state through collection.
- Demonstrate independently chosen post-delivery, pressure, idle and timed requests
  with controlled inputs or a fake clock, without depending on real elapsed time.
  Verify that engine mechanics do not substitute an unsolicited global cadence.
- For consumers promising replica-identical execution, pin independent expected
  collection sequences and compare results, computrons and canonical heap state
  under the same coordinated schedule across continuous execution and resume.
  Compare roots/seals only when persistence histories are also identical.
  Different schedules do not carry an unconditional heap-byte equality promise.
- Fault-inject collection/checkpoint failures and verify documented heap integrity,
  counters, delivery durability, and the consumer's chosen recovery behavior.
- Preserve legacy root/seal and cadence-mismatch refusal tests; if policy transitions
  are added, test their explicit compatibility and migration rules.

F010, F076 and F090 remain implementation work: choosing consumer policy does not
itself reclaim chunks or implement weak collections.
Retain the measured collection baselines in
`rust/engine/benches/results/linux-reference-controls.json` for evaluating 2B and
informing consumers' scheduling choices.

## 6. Phase 1G commissioned review — derived machinery before 2A

**Commissioned 2026-09-09 against `96db92e2308f0a3712dd0faed7b8663f00c42d29`.**
An independent subagent completed the initial bounded pass recorded in
[the commissioned report](../rust/engine/reviews/2026-09-09-derived-machinery.md).
It confirmed no new production defect in the inspected paths; its unreviewed
mutation routes, SQLite coverage and aliasing boundary remain explicit follow-ups.
The commission covers machinery added since the original architecture review,
whose re-verifications do not substitute for a correctness review of these paths.
Read the implementer records W3, W4 and PERFORMANCE-FIXES, and the reviewer-side
PERFORMANCE-TRADEOFFS, under `rust/engine/architecture-review/2026-09-06/`.
Locate current constructs by content, never by the historical review's line numbers.

| Scope (paths relative to `rust/engine/`) | Review obligation |
| --- | --- |
| `ironhorse-vm/src/classification.rs` | Brand precedence and derived classification after insert/remove, slot reuse, GC and restore; compare with authoritative side tables. |
| `ironhorse-vm/src/property_index.rs` | Owner/dependency invalidation through every mutation path, chain edits, slot reuse, collection/remapping and restore; cold/warm lookup equivalence. |
| `ironhorse-vm/src/snapshot_dirty.rs` | Complete section inventory, mutation interception, acknowledgement only after durable success, rewind/restore and retained dirty state after failure. |
| `ironhorse-vm/src/bulk.rs` | Bulk-operation semantic and charge equivalence, partial failure and bypasses of mutation/invalidation hooks. |
| `ironhorse-vm/src/cost.rs`, `meter_consistency.rs`, `source_scan.rs` | Cost routing and reconciliation completeness, syntactic scanner blind spots, fail-closed behavior and independent expected values. |
| `ironhorse-meter/` | Version/digest/release-pin integrity, arithmetic bounds, compiler/runtime shared accounting and compatibility refusals. |
| `ironhorse-text/` | UTF-16 indexing, surrogate and boundary behavior, allocation/length bounds and agreement across callers. |
| Schema-28 migration in `ironhorse-snapshot/`, including `store_sections.rs`, and backend consumers | Stable persisted section IDs, old-root verification before conversion, missing/duplicate/unknown sections, atomicity, canonical round trips and memory/file/SQLite agreement. |

Trace callers and mutation sites as necessary, including reading `interp.rs`;
editing that file remains forbidden during Phase 1.
The retained owner prefilter, reverse-dependency indexes and duplicate section
inventories are carried costs whose invariants must be reviewed, not deleted.

**Deliverable:** a separate report with pinned revision, inspected coverage,
severity/confidence, current content anchors, reproducible evidence or clearly
labelled hypotheses, and oracle-free regression recommendations.
Record uninspected paths and unexecuted tests explicitly; absence of a finding is
not proof of invalidation completeness.
Keep the historical architecture review unchanged.
Before 2A relies on this machinery, triage the report and resolve or explicitly
accept its relevant correctness blockers; re-review changed paths if its base
has moved.
This commission is not a claim that the machinery is certified or its findings
are fixed by Phase 1G.

## Prompt

> lets talk through the W6 decisions now
>
> we answered 1 and 2 previously, did you not record it?

Written after the fourth revision of the architecture review, when two decisions
answered in conversation — the Realm extraction and the `libm` provider feature —
were found to exist nowhere in the repository and were consequently re-presented
to the maintainer as open questions.

### Phase 1G prompt

> Answer whether the GC schedule is release policy or embedder policy (F091),
> record the answer here, and commission a scoped review of the derived machinery
> added since the architecture review, including the meter/text crates and
> schema-28 migration, before Phase 2A builds on it.

### GC ownership clarification

> GC is an engine consumer concern.
> Endor and Thixotrope may decide to run GC after quiescing a message delivery.
> Others may want a pressure-, idle-, or time-based cadence.
