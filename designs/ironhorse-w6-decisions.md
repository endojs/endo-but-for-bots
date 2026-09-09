# IronHorse W6: the open layering decisions, and their answers

| | |
|---|---|
| **Created** | 2026-09-09 |
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

Standing at `1b130df7`:

| # | Decision | State | Findings |
|---|---|---|---|
| 1 | Realm | **Decided** 2026-09-08 — extract a `Realm` | F059, F054, F159, F144 |
| 2 | Engine trait | **Deferred** 2026-09-08, with a stated trigger | F068, F157 |
| 3 | Integrity model | **Decided and implemented** before `f109e8f4` | F058, F015, F057 |
| 4 | Determinism scope | **Decided** 2026-09-08 — vendor `libm`; blocked on coverage | F080, F081 |
| 5 | GC schedule | **Open** — the last one, and it blocks the most code | F091, F010, F076, F090 |

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
configuration. **This is not yet implemented**, and it must not land without the
coverage below.

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

Before flipping the default, state what happens to the 30 corpus files: whether
the XS oracle is rebuilt against the same `libm` (the seam ledger's
"heterogeneous-fleet upgrade path"), or whether those cases move to an expected
divergence list. This is the piece still to scope, and it is tracked above under
[The part still to scope](#the-part-still-to-scope) rather than here.

### The part still to scope

"Rebuild the oracle against it" is the real work and its shape is not settled.
The seam ledger records the swap as "the heterogeneous-fleet upgrade path (a
unilateral swap would break the differential pin and any last-ulp divergence
transitively diverges computrons)" — results feed guest branches, so a last-ulp
difference is a full determinism break, not a rounding nit. Scope that before
committing to a landing date.

**A cheaper intermediate step, available now and not exclusive with the above:**
run those 30 transcendental cases oracle-free on Linux *and* macOS and fail on
divergence. That does not make the engine deterministic; it converts an assumed
risk into a measured one, on the platforms actually shipped. The macOS lane that
makes this possible only started existing at `c14706d3`.

### Documentation debt this decision settles

The existing decision-of-record ("determinism is scoped per release binary per
platform") lives in `designs/ironhorse-snapshot-store-seam.md` — a *store-seam*
document — and in a private comment above `call_math` in `interp.rs`.
Meanwhile `designs/ironhorse-engine.md` still carries the unqualified promise,
and `ironhorse-meter/src/lib.rs` opens with "one canonical, platform-independent
SHA-256 identity," which is true of the weights and reads as a claim about
execution. Whichever way the implementation goes, those three have to agree.

## 5. GC schedule — open, and it blocks the most code

Not in the review's W6 four; filed as F091, under determinism. It behaves like a
W6 item: a policy question, answerable in a meeting, blocking implementation.

**Half of it landed.** `cranks` is no longer unauthenticated: it is bound into
both the manifest root and the seal, and `validate_store` recomputes both at
open, so a length-preserving flip at rest now fails closed twice over.

**What remains is the policy question.** `collect_every` is an embedder-chosen
field of `CadencePolicy` rather than a release constant stamped beside
`COST_TABLE_VERSION`, and a manual `PersistentMachine::collect` lets an operator
fork two honestly-configured replicas' heaps by action alone. The divergence is
recorded in the sealed `collections` counter; nothing refuses it.

**The question: is the GC schedule release policy or embedder policy?**

It gates three high findings and the whole reclamation story — F010 and F076
(nothing in any wired configuration reclaims the chunk arena;
`Interp::collect_garbage` still has zero production callers, the single in-source
call site being `#[cfg(test)]`-gated) and F090 (`WeakMap`/`WeakSet` are strong).
Firing collection at an allocation threshold *is* setting consensus-visible
policy, so the implementation cannot start until this is answered.

This is also the right moment to answer it, for a reason that was not true
before: `rust/engine/benches/results/linux-reference-controls.json` now records
what collection costs, and it shows the free and partial phases regressing with
heap size (1.110x / 1.193x / 1.254x at 5,000 / 20,000 / 80,000 slots) while
per-slot sweep cost is unchanged. Reclamation work can now be measured rather
than guessed at.

## Prompt

> lets talk through the W6 decisions now
>
> we answered 1 and 2 previously, did you not record it?

Written after the fourth revision of the architecture review, when two decisions
answered in conversation — the Realm extraction and the `libm` provider feature —
were found to exist nowhere in the repository and were consequently re-presented
to the maintainer as open questions.
