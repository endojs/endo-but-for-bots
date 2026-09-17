# IronHorse: a native `lockdown()`

| | |
|---|---|
| **Created** | 2026-09-16 |
| **Updated** | 2026-09-16 |
| **Author** | kumavis (prompted) |
| **Status** | Implemented (`lockdown`); `Compartment` not started |
| **Source** | The gap [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) sized and Phase 4 of [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) sequenced |

## Status

Landed, within the scope boundary below.

`Interp::do_lockdown` (`ironhorse-vm/src/interp/realm.rs`) implements
`fx_lockdown` steps 1, 2 and 5; `create_hardened_globals` binds it as the guest
global `lockdown`, beside `harden` and `petrify`. `endot-ih -l` runs instead of
refusing, and `test262:ironhorse` with it. Pinned by
`ironhorse-vm/tests/native_lockdown.rs` (20 cases), nine of which were written
from defects adversarial review found after the first revision called this
section "Landed".

Steps 3 and 4 are absent by decision, not omission: both presuppose a guest
`Compartment` (§ Scope boundary). The consequence stated there holds — the
`ses-xs-parity` lockdown case still does not run natively.

**What the first revision of this section claimed, and why it was worthless.**
It said `endot-ih -l` had dual-run 6053 files against XS's own `fx_lockdown`
and found byte-identical outcomes with and without `-l`, and offered that as
evidence the port agreed with XS. The measurement was real and the inference
was empty: `SesMode::prelude()` — the function producing the `lockdown();`
splice — had no caller outside its own unit tests, so `-l` only lifted the
pre-skip and ran the corpus **unlocked**. Freezing every intrinsic and
poisoning `Function.prototype.constructor` cannot leave a test262 corpus
unchanged; the null result was the tell, and it was read as reassurance.

A differential gate that reports no difference is a gate to check, not a
result to publish. That is the same error this document's § Measured starting
state was written to guard against, made by the author of the guard.

`assemble` now applies the mode's wrap (`xst.rs`), in XS's order —
`xst262.c:1257-1272`: harness, then `lockdown()`, then the case body. The
splice is pinned by `xst::tests::a_lockdown_mode_actually_splices_the_call`,
which asserts on what `assemble` PRODUCES rather than on the template's shape,
because asserting the shape is what let this through.

**The connected lane is not green, and saying only that it runs would repeat
the error in a quieter voice.** `test/ironhorse` — the 1712-case corpus this
work targets — is `1712/1712 covered, 0 failed` under `-l`. The wider built-ins
tree is not. On `built-ins/Boolean`, 49 files: **18 failures without `-l`, 21
with.** The three that `-l` adds are `S15.6.2.1_A4.js`,
`prototype/toString/length.js` and `prototype/valueOf/length.js`.

What those three are is worth stating exactly, because "lockdown regressed
three tests" and what actually happens are different claims. Each is
`abort-value-differs` in which **both engines abort with the same message** and
only the rendered constructor prefix differs — oracle `Test262Error: …`,
IronHorse `Object: …`. Lockdown does not cause that divergence; it causes the
*occasion* for it. Freezing `Boolean.prototype.toString.length` makes
`verifyProperty`'s writability check fail on both engines, and a failing case
is what puts the host's thrown-value renderer on the stdout being compared.

The renderer divergence is pre-existing and independent of lockdown. Measured
with a two-line case that never calls `lockdown()` — a custom-constructor
object thrown uncaught — oracle `[object Object]`, IronHorse `Object: probe`.
So `-l` widens the reported failure count on subtrees whose cases assert
mutability, and every widening measured so far resolves to this one
pre-existing renderer gap rather than to a lockdown defect. That is a claim
about the three cases examined, not about the whole tree; the lane has not been
swept end to end under `-l`.

**Independently validated by a suite that predates the work.**
`packages/hardened262` carries `ironhorse/lockdownSloppy` and
`ironhorse/lockdownStrict` profiles whose committed baseline recorded **178**
failures across the two. **54** of those were cases that died at the
`lockdown()` call, and all 54 now pass; the baseline diff is a pure
failed→passed flip over the same file set, with no case regressing and no other
agent's profile moving. The remaining 124 are `Compartment` cases and stay red,
which is the scope boundary doing what it says. (An earlier revision of this
paragraph, and commit `50e802b71`, gave 54 as the profiles' whole failure count.
It cleared 30% of that baseline, not all of it.)
`test/intrinsics/AsyncFunction/inert-stand-in.js` is the one to read: written
against SES's semantics, it asserts `Object.isFrozen(AsyncFunction)` and that
the stand-in throws on call **and** on construct. That is why the inert
constructor is a `Native` rather than a `NativeMethod` (a `NativeMethod` is not
constructable, so `new` would have failed as "not a constructor" instead of as
a secure-mode refusal), and why `do_lockdown` adds the instances it mints to
its own root set.

Everything under § Measured starting state was run against tree `7753a4b92`,
before the work.
The decisions that gated the work are answered in § Decisions, as taken.

## The goal, in one sentence

Give IronHorse a guest-callable `lockdown()` that does what
`c/moddable/xs/sources/xsLockdown.c`'s `fx_lockdown` does — rewire the
function-family constructors to inert stand-ins, attenuate the ambient
authority `Date` and `Math` carry, then transitively harden the intrinsics —
so that the engine reaches a hardened realm on its own rather than only by
evaluating ~1 MB of SES shim.

## What "native" means here, and what it does not

**Native** means the operation is the engine's, written in Rust in
`ironhorse-vm`, bound as a global the way `harden` and `petrify` already are
(`interp/boot.rs`, `create_hardened_globals`), and reachable from guest code as
`lockdown()`.
It is XS's `fx_lockdown` transliterated, on the same terms as the rest of the
port: an oracle-locked transliteration whose observable behaviour is diffed
against XS case by case.

It is **not** SES's `lockdown()`.
The two are different artifacts and the difference is not a detail.
`packages/ses/src/lockdown.js` runs a permits table, `removeUnpermittedIntrinsics`,
property-override enablement, locale/NaN/domain/regenerator taming, error taming
and fifteen options.
`fx_lockdown` is five steps, no permits table, and no options at all.
The equivalence design's table (§ Equivalence: `lockdown`) has the full
comparison; the short version is that matching XS is the goal and matching SES
is not, and a reviewer who checks this work against `packages/ses` will find
differences that are intended.

It is **not** a guest `Compartment`.
Two of `fx_lockdown`'s five steps only have content when one exists, and both
are scoped out here — see § Scope boundary.

It is **not** the prelude workaround that sits next to it.
The SES shim's `lockdown()` fails on IronHorse today for a reason this document
inherits (§ The ordering fact), and it can be made to pass by giving the shim a
`harden` that does not walk prototype chains — measured, and deliberately not
taken here.
That route changes no engine code and leaves this gap exactly where it is.

## Why: what a native `lockdown()` unblocks

Three consumers, in descending order of how well established the need is.

**1. `endot-ih -l`, and through it `test262:ironhorse`.**
(This section describes the state BEFORE the work; § Status has the result.)
`SesMode::Lockdown` (`ironhorse-262/src/xst.rs`) returned
`Some("ses-mode:lockdown-unimplemented")` from `unimplemented_skip`, and
`endot_ih.rs::refuse_unimplemented_ses_mode` turned that into a refusal to start
rather than a run that pre-skips 35891 files and exits 0.
It now returns `None`, the skip reason no longer exists anywhere, and the
refusal names only the two `Compartment` modes.
`yarn test262` runs `xs && node && ironhorse` in sequence, so it inherits the
refusal.
This is the one consumer whose blocked-on-this status is mechanical and
checkable: delete one match arm and the lane runs.
The XS oracle it diffs against already installs `fx_lockdown`
(`xs-oracle/csrc/xs_shim.c`), so the port is differentially testable from the
first commit.

**2. The confinement hole `global_names` cannot close.**
`CompartmentOptions::global_names` decides which names get *bound* and nothing
else, and its own doc comment says so.
Measured: under `global_names: Some(vec![])` a guest still evaluates
`({}).constructor.constructor('return 1+1')()` to `2`.
Closing that is `fx_lockdown` step 2 and nothing else, and step 2 is correct
only *after* a guest asks for it — which is why it cannot move into machine
construction, and why the engine has no equivalent today.

**3. The daemon's realm profile.**
[ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md)
§ What a next step should establish first asks which of two profiles the
daemon's IronHorse worker takes: the SES shim (already proven in-tree by
`thixotrope-ironhorse-worker`) or a native one.
This work is the native profile's prerequisite, not its decision.
**Treat that question as still open.**
Building native `lockdown()` does not settle it and should not be read as
settling it; it makes the native profile answerable where today it is not.

## The ordering fact

The one thing this port must not get wrong, and the reason the ordering is
worth its own section: **rewire the constructors first, harden afterwards.**
XS does it in that order — steps 2 then 5 — and the cost of the other order is
measurable in this tree today.

Measured on a default `Interp::new()` machine (§ Measured starting state):
`Function.prototype.constructor` boots as the spec's
`{writable: true, enumerable: false, configurable: true}`, and one `harden({})`
leaves it `{writable: false, configurable: false}` with
`Object.isFrozen(Function.prototype)` true.
The native `harden` is a deep freeze that walks prototype chains
(`interp/property/integrity.rs`, `harden_freeze_and_traverse`, which enqueues
`mop_get_prototype`), so any guest that hardens anything at all freezes the
prototype a later rewiring needs.

That is exactly what the SES shim runs into on IronHorse: `@endo/pass-style`
performs one `harden({})` while the prelude is still evaluating, and
`lockdown()` then throws `TypeError: invalid descriptor` from
`tame-function-constructors.js`'s

```js
defineProperties(FunctionPrototype, { constructor: { value: InertConstructor } });
```

The refusal is spec-CORRECT — a non-configurable, non-writable data property
cannot be redefined to a different value — so the freeze is the problem, not the
rejection.
`designs/ironhorse-ses-compartment-equivalence.md` § How far the shim profile
reaches the parity corpus carries this same measurement and is correct as
written; it was corrected there, against an earlier revision that had recorded
node's cause for IronHorse as well.
Re-measured here and confirmed: on node the selector installs
`Object[Symbol.for('harden')]` and `repairIntrinsics` refuses outright, while
on IronHorse that slot stays `undefined`, the refusal never fires, and the
freeze above is what fails instead.
Do not re-derive it from the shared symptom; the two hosts fail the same file
for different reasons.

A native `lockdown()` escapes the shim's version of the problem only by
ordering: it writes the constructor slots directly, before it hardens anything,
the way `fx_lockdown_aux` does. A native `lockdown()` written the other way
round would reproduce the bug in Rust.

## Scope boundary

The goal is `fx_lockdown`, minus the two steps that presuppose a guest
`Compartment`.

| In | Out |
|---|---|
| step 1, idempotence | step 3, the compartment-global template |
| step 2, constructor rewiring, for the four function-family prototypes and `Date.prototype` | step 2's sixth call, on `Compartment.prototype` |
| step 4's `Date.prototype` rewiring (which is step 2's sixth call) | step 4's actual ATTENUATION — the secured `Date`/`Math` that only a compartment global receives |
| — | a guest `Compartment` constructor of any kind |
| step 5, transitive harden (largely present) | `mutabilities` and the `fxVerify*` family |
| the `SesMode::Lockdown` seam in `endot-ih` | `SesMode::Compartment` / `LockdownCompartment` |

The consequence worth stating plainly, because it is the obvious thing to
expect and it will not happen: **this does not turn the `ses-xs-parity`
corpus's `Symbol.toStringTag-lockdown.js` green on `test262:ironhorse`.**
That case reads `Compartment.prototype[Symbol.toStringTag]`, so it needs a
guest `Compartment`, which stays a named feature skip (`"Compartment"` in
`DEFAULT_ENDOR_SKIP_FEATURES`).
What this work does for that lane is let it *start*.

Step 4 is in scope but nearly empty, and the measurement below is why: there is
no `Math.random` on IronHorse to attenuate.
Keeping it in scope is a decision about where the seam goes, not an estimate of
work — see § Decisions, as taken, item 3.

### The start compartment and a compartment are not the same environment

An earlier revision of the table above put "step 4, `Date`/`Math` attenuation"
squarely in scope. That overstated it, and the distinction is worth stating
because it is the easy thing to conflate.

`fx_lockdown` attenuates the **compartment global template**, not the start
compartment. The `fxDuplicateInstance(mxDateConstructor)` plus `fx_Date_secure`
and `fx_Date_now_secure` at `:121-128` are stored into
`instance->next->value.array.address[_Date]`, which becomes
`mxCompartmentGlobal` at `:139`. The host's `Date` global is never touched. So
after `lockdown()`:

* the **start compartment** keeps a working `Date` — `Date.now()` returns a
  number and is not NaN — and that is correct, not a gap;
* a **compartment** created afterwards would get the secured `Date`, whose
  `now()` is NaN, and the secured `Math`.

Measured against the oracle, the start compartment agrees with XS on every
observable here but one: `Date.now() > 0` is `true` on XS and `false` on
IronHorse, because IronHorse's clock is deterministic and returns 0. That is a
pre-existing engine property, not a lockdown effect.
`native_lockdown.rs::the_post_lockdown_start_compartment_keeps_its_date_and_lacks_a_compartment`
pins the table.

What is out of scope is therefore larger than "the `Compartment` constructor".
It is the whole attenuated environment a confined guest is supposed to run in.
That matters for the first real embedding to ask for it — see § Known Gaps,
the `packages/thixotrope` item.

## The specification, step by step

Reading `xsLockdown.c:74-205` against what `ironhorse-vm` has today.

### Step 1 — idempotence

XS sets `XS_DONT_MARSHALL_FLAG` on `mxProgram` and a second call is
`TypeError("lockdown already called")` (`:90-92`).

IronHorse has `Intrinsics::locked_down`, but with the **opposite** contract:
`Interp::lock_down_intrinsics` (`interp/realm.rs`) returns `Ok(())` when the
flag is already set, and its doc comment says the idempotence is deliberate
because "this is the embedder's operation, not the guest's".
A guest `lockdown()` is the guest's operation, so the two contracts collide on
the same flag.
This is a real decision, not a naming detail — § Decisions, as taken, item 2.

Note also that `lock_down_intrinsics` is documented as **not atomic**: a
refusal partway through leaves earlier roots frozen with the flag still false.
A guest-visible operation that can half-apply and report "not applied" needs
that behaviour stated in its own terms, or changed.

### Step 2 — poison the function-family constructors

`fx_lockdown_aux` (`:52`) replaces a prototype's `.constructor` with a
duplicate of `%ThrowTypeError%` carrying `XS_CAN_CONSTRUCT_FLAG`, `length` of
the original, and a `prototype` property pointing back at the prototype.
It writes the slot directly:

```c
slot->kind = constructor->kind;
slot->value = constructor->value;
```

That bypasses `[[DefineOwnProperty]]` entirely, which is what lets XS run this
step against a prototype the guest may already have frozen.
It is called six times: `AsyncFunction.prototype`,
`AsyncGeneratorFunction.prototype`, `Function.prototype`,
`GeneratorFunction.prototype`, `Compartment.prototype` (`:94-103`), and
`Date.prototype` (`:127`).

**This is the substance of the work.** Four of those five prototypes exist on
IronHorse as named fields (`async_function_proto`,
`async_generator_function_proto`, `generator_function_proto`, and the shared
`function_proto`); `Compartment.prototype` does not and is out of scope.

Two things are new:

- **An inert constructor to install.** IronHorse has no `%ThrowTypeError%`:
  neither the identifier nor the restricted `caller`/`arguments` accessors it
  usually rides in on appear in `ironhorse-vm/src`. A `NativeMethod` variant
  that throws a `TypeError` is new, as is minting one instance per prototype
  with the right `length` and `prototype`.
- **A write path that does not go through the ordinary MOP.** XS's direct slot
  write is not an optimization; it is what makes the step work after a
  `harden`. The IronHorse analogue is a deliberately privileged
  `set_own_unmetered_with_flag`-shaped write, and it needs a comment saying why
  it is allowed to ignore the descriptor it is overwriting.

The ordering constraint the motivating bug turned up applies here and is the
single most important line in this document: **rewire first, harden after.**
XS's own order is steps 2 then 5. Doing it the other way is what makes the SES
shim fail on IronHorse today.

### Step 3 — the compartment-global template

Out of scope; it exists to be copied into each new compartment's global.
`fxNewArray(the, _Compartment)` (`:105`), filled from the intrinsics up to but
not including `_Compartment` and stored as `mxCompartmentGlobal` (`:139`).
IronHorse builds each compartment's globals from `global_props` instead, so
this has no counterpart to port until a guest `Compartment` does.

### Step 4 — attenuate `Date` and `Math`

XS duplicates `mxMathObject`, patches `random`/`irandom` on the *duplicate*,
and pulls the duplicate into the compartment template (`:130-137`), so the host
global keeps the real one.
`Date` is half of this: the constructor is duplicated and secured into the
template the same way (`:121-125`, `:128`), and step 2's sixth call also
poisons the *shared* `Date.prototype.constructor`.
XS's comment for this is the one place it implements ocap attenuation rather
than integrity.

On IronHorse the template half is out of scope with step 3, and the shared
half reduces to `Date.prototype.constructor`, which step 2 covers.
`Math.random` does not exist to attenuate — measured, below — so there is
nothing to secure there today.
That makes step 4 nearly empty *as a port*, and the question is whether the
seam should exist anyway; see § Decisions, as taken, item 3.

### Step 5 — harden

XS calls the *guest* `harden` over an enumerated list: every intrinsic, the
hidden prototypes, the internal helpers and accessors,
`Array.prototype[Symbol.unscopables]`, the compartment template, `harden`
itself and `Function` (`:141-200`).

IronHorse already does this, and wider: `lock_down_intrinsics` hardens every
`Kind::Instance` in the arena except the global object and the template cache,
rather than a hand-maintained list.
`Interp::do_harden` is a faithful transliteration of `fx_harden` +
`fx_hardenQueue` + `fx_hardenFreezeAndTraverse`, including the visited-bit
rollback on a mid-walk throw.

Two adjustments the port needs, both consequences of moving the call to guest
time:

- The roots list is the arena snapshot taken at machine construction. The inert
  constructors minted in step 2 are allocated *after* that, so they are not in
  it and would not be hardened. Either they join the roots or step 5 hardens
  them explicitly.
- XS calls the guest `harden` — the one on the global, which a guest may have
  replaced. IronHorse's `do_harden` is the engine's own. Following XS exactly
  would mean honouring a guest replacement, which is a capability question, not
  a fidelity one. The proposal here is to use the engine's `do_harden` and say
  so; § Decisions, as taken, item 4.

## Measured starting state

Run against tree `7753a4b92` on a default `Interp::new()` machine with no
prelude, through a throwaway integration test in
`rust/engine/ironhorse-vm/tests/`.
These are measurements, not readings of comments — one of the comments is
wrong, see the last row.

| probe | result |
|---|---|
| `typeof harden`, `typeof petrify` | `function`, `function` |
| `typeof lockdown`, `typeof mutabilities`, `typeof Compartment` | `undefined`, `undefined`, `undefined` |
| `lockdown()` | `ReferenceError: get lockdown: undefined variable` |
| `Function.prototype.constructor` at boot | `writable: true, enumerable: false, configurable: true` |
| the same, after one `harden({})` | `writable: false, configurable: false`; `Object.isFrozen(Function.prototype)` true |
| `({}).constructor.constructor('return 1+1')()` | `2` |
| `typeof Math.random` | **`undefined`** |
| `typeof Date.now`, `new Date(0).getTime()` | `function`, `0` |
| `typeof Date.prototype.constructor` | `function` |

The last row of the list above is a correction.
`interp/boot.rs`'s `create_hardened_globals` doc comment says `lockdown` and
`mutabilities` are "the reported scope fold of this child — a program that
references either self-names an honest `Halt::NotImplemented` rather than a
wrong value (see their dispatch)".
There is no such dispatch: no `NativeMethod` variant for either name exists,
`create_hardened_globals` inserts only `harden` and `petrify`, and a reference
is an ordinary `ReferenceError`.
`ironhorse-262`'s `DEFAULT_ENDOR_SKIP_FEATURES` repeats the claim — "a named
scope fold in `ironhorse-vm::interp::create_hardened_globals`".
A `ReferenceError` is arguably the more honest answer of the two, so this is a
comment to fix rather than behaviour to change; it is fixed in the commit that
adds this document.

## Constraints the port must respect

**The boot fingerprint moves, so pre-existing snapshots will not restore.**
`Interp::derive_boot_fingerprint` hashes the `intrinsics` map's names and slot
indices and every `functions` entry including its `NativeMethod` variant name.
Binding `lockdown` adds one of each.
`Signature::check_boot` then refuses any snapshot whose recorded fingerprint
differs — `SnapshotError::BootLayoutMismatch`, classified
`StoreFailure::Refused` — and there is no cross-layout heap translator.
This is the documented consequence of an intrinsic-layout change and it has a
worked precedent: the `%TypedArray%.prototype` `at` and
`findLast`/`findLastIndex` commits (`683380e44` and `47b1c6f2e` — NOT PR #1279,
which is a `compartment-mapper` change touching no fixture) each moved 96
digests across six golden identity fixtures in `ironhorse-snapshot`, and
`regenerate_persistence_identities` is the tool for it.
Budget for that regeneration; it is not incidental.

**The XS oracle is available and should be used.**
`endot-ih` dual-runs each case against XS, and the oracle shim installs
`fx_lockdown`. So `-l` becomes a differential gate as soon as the arm is
removed, rather than a claim to be checked by hand. Use it.

**`#![forbid(unsafe_code)]`, metering, and determinism** apply as they do to
every other native. Note that `xsLockdown.c` calls no `mxMeter`, which is why
`do_harden`'s cost is allocation-driven rather than per-key metered; a native
`lockdown` inherits that shape.

**A compartment must not perform it.**
`lockdown` is not an XS realm intrinsic — `fxCreateMachine` never binds it, and
`xst.c` and the oracle shim install it on the host global.
A compartment's global in XS is built by `fx_lockdown` itself out of the
intrinsics array (`xsLockdown.c:105-139`), which never contains the shim's
globals, so an XS compartment cannot see `lockdown` and the question never
arises there.

**Amended after review: the check is on the call, not on the binding.**
An earlier revision of this paragraph said "must not *see* it" and pointed at
`global_props` and `compartment_evaluator`. Hiding the name is the weaker
guarantee and it was the wrong one to ask for. A compartment whose creator
endows it with a `lockdown` reference captured from the start realm walks
straight past a hidden binding, and so does any route that is not a bare name.
`do_lockdown` therefore refuses outright when
`environment.global_obj != realm.global_object()`, and the binding stays
visible exactly as `harden` and `petrify` do.

This is not theoretical. Measured before the guard existed, on
`Machine::unfrozen_with_start_global_names(None)` with two compartments:
compartment A calls `lockdown()` and it returns `undefined`; compartment B,
which read `false | false | false` moments earlier, then reads
`Object.isFrozen(Object.prototype) = true`,
`Object.isFrozen(Function.prototype) = true` and
`Function.prototype.constructor !== Function`. One guest hardened the realm for
every sibling. `a_compartment_cannot_lock_down_the_shared_realm` is the
regression test.

Note that `Machine::unfrozen_with_start_global_names` already documents this
window as caller-owned — "lock down before admitting a second compartment" —
so the measured scenario is also a caller violating a stated precondition. The
guard means the precondition is no longer the only thing standing between two
compartments and a shared-realm mutation.

## Decisions, as taken

1. **Is a guest `Compartment` in or out?** **Out**, as proposed. The cost in
   § Scope boundary is real and was paid: `test262:ironhorse` now starts and
   covers zero of the eight parity cases — two skip on `feature:Compartment`,
   six on `shared-positive-test-failure` because they need the pass-style
   globals only a prelude supplies. If the goal is "that case passes
   natively", the scope is `fx_lockdown` *and* `fx_Compartment`
   (`xsModule.c:2864`), and that deserves its own definition.
2. **What does a second `lockdown()` do?** **It throws**, as XS's does. The
   host-side `Interp::lock_down_intrinsics` stays idempotent; the two share
   `Intrinsics::locked_down` and differ only at this boundary, which both doc
   comments now state. The reasoning is the one `lock_down_intrinsics` already
   gave: an embedder that cannot tell whether it has locked down is the one
   calling twice, and a guest can tell.

   **The consequence the question does not reach:** sharing one flag means a
   machine the HOST froze reports "already called" to a guest that never got a
   first call. Measured on `Machine::new()`, which freezes at construction: a
   guest's very first `lockdown()` is
   `TypeError: lockdown already called`. XS has no analogue of that state,
   because XS has no host-side lockdown. This is a real edge of the shared
   flag, not a second call, and "what does a second `lockdown()` do?" was the
   wrong framing to have settled it under. It matters because
   `lock_down_intrinsics` performs step 5 only — a `Machine::new()` realm is
   frozen but was never REWIRED, so `Function.prototype.constructor` is still
   the live evaluator and the guest cannot ask for the rewiring that would
   close it. `a_frozen_machine_refuses_the_guest_lockdown_and_keeps_the_reach_
   open` pins exactly that, and § Known Gaps carries it as the first open item.
3. **Does step 4 get a seam it does not yet need?** **No seam.** `Math.random`
   does not exist on Ironhorse and the compartment template is out of scope, so
   what survives of step 4 is `Date.prototype.constructor`, which step 2 covers
   as its sixth call. Nothing else was written.
4. **Whose `harden` does step 5 call?** **The engine's `do_harden`**, not the
   guest's. This is a deliberate divergence from `fx_lockdown`, which fetches
   `harden` off the global and calls it about fifty times. Honouring a guest
   replacement would let guest code decide how thoroughly its own realm is
   frozen, which is not a property worth having. It is also what lets the
   foreclosed shim profile still lock down: the thixotrope bundle deletes
   `globalThis.harden` before the shim runs, and the native `lockdown()` does
   not care (pinned in `tests/ses_boot_intrinsics.rs`).
   Whether an oracle divergence results is now answered by measurement rather
   than by the disconnected `-l` wire an earlier revision cited: see
   § Oracle divergences, measured. Decision 4 itself produced none; the width
   of the root set (rows 3 and 4 there) did.
5. **Does the daemon want this at all?** **Still open**, and this work does not
   answer it. It makes the native profile answerable where it was not.

### One decision the implementation forced

**Which instances step 5 hardens.** `lock_down_intrinsics` walks
`Intrinsics::roots`, which a `Machine`-built shared realm populates at
construction and a plain `Interp::new()` machine leaves EMPTY (`Realm::new`).
A plain machine is what `endot-ih`, `ironhorse-xst` and the conformance harness
run, so step 5 would have been a no-op there.

The fix is not to re-run the construction-time enumeration. That filter is
`0..slots.capacity()`, which is every instance in the arena — correct before
any guest code, and catastrophic at `lockdown()` time, when the arena is full
of guest objects and freezing them all would be indistinguishable from a
runaway `harden`. `do_lockdown` derives its roots from `boot_slot_count`
instead, which is the primordial set and nothing else.
`lockdown_leaves_objects_the_guest_already_made_alone` is the regression test,
and nothing else in the suite would catch it.

## Done looks like

Each line is a claim, and each was measured.

- [x] A guest `lockdown()` on a default `Interp::new()` machine: `typeof
      lockdown` is `"function"`, calling it returns `undefined`, and calling it
      twice throws `TypeError: lockdown already called`.
- [x] `({}).constructor.constructor('return 1+1')()` evaluates to `2` before
      `lockdown()` and throws `TypeError: secure mode` after, for all four
      function-family prototypes reachable that way — including the three with
      no global binding at all.
- [x] `SesMode::Lockdown::unimplemented_skip` returns `None`, `"lockdown"` has
      left `DEFAULT_ENDOR_SKIP_FEATURES`, `endot-ih -l` starts, and the run is
      gated against the XS oracle rather than pre-skipped.
- [x] The `ironhorse-snapshot` golden identity fixtures are regenerated for the
      moved boot fingerprint (`regenerate_persistence_identities`, both math
      providers), the six inline digests in `metamorphic_determinism.rs` are
      re-pinned with a note, and the upgrade consequence is in this document's
      § Constraints and in the PR.
- [x] `ses_prelude_reach` stays at its 7/8 pin and `ses_boot_intrinsics`'s
      three realm profiles still pass — with one change in each, `lockdown`
      going from `undefined` to `function` in the pre-shim census, which is the
      engine binding its own and is the only thing that moved.
- [x] This document updated with what the port did and where it diverged from
      `fx_lockdown` (§ Decisions, as taken, 4).
- [x] `packages/hardened262`'s `ironhorse/lockdown*` baselines updated: 54
      cases move from `failed.txt` to `passed.txt`, none the other way. That
      lane (`test-xs`) is the one this work was NOT run against locally before
      the first push, and it caught a real baseline move rather than a
      regression.

Not done, and not in scope: a guest `Compartment`, `mutabilities` and the
`fxVerify*` audit family, and the daemon's realm-profile choice.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) | Sized this gap and measured the motivating failure. Its § What XS implements is the source for the five steps above; its open question 1 is this document's open question 5. |
| [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) | Phase 4 is where this sits. Its § "the machinery is built; what is absent is the binding layer" names the same three absences. |
| [ironhorse-engine](ironhorse-engine.md) | Owns roadmap stage 4. This is the native half of the choice that stage's deliverable column now presents. |
| [ironhorse-test262-convergence](ironhorse-test262-convergence.md) | Owns `endot-ih` and the corpus lanes this unblocks. |

## Oracle divergences, measured

Every row here was measured with `endot-ih`, which dual-runs each case against
XS's own `fx_lockdown` and reports both engines' strings side by side. None of
it is inferred from reading the C.

**Closed by this change.**

| # | What diverged | XS | IronHorse, before |
|---|---|---|---|
| 1 | `name`/`length` of the three shim globals | `harden`/1, `lockdown`/0, `petrify`/1 | `""`/0 for all three |
| 2 | `constructor` re-created after a guest deleted it | `e=true w=false c=false` | `e=false w=false c=false` |

Row 1: `create_hardened_globals` used `alloc_method`, which hard-codes an empty
name chunk and arity 0. `harden` and `petrify` predate native lockdown and were
wrong in both name and arity; `lockdown` was wrong only in its name. The same
one-line switch to `alloc_named_method` closes all three, so all three are
fixed rather than leaving two anonymous siblings beside a named newcomer —
a drive-by, and named as one.

Row 2: step 2 is a *set*, not a define, so when a guest has run
`delete Function.prototype.constructor` it CREATES the property. XS reaches
that through `fxOrdinarySetProperty`'s creation branch, which allocates with
`fxNewSlot`, and a fresh XS slot carries no flags — so XS's re-created
`constructor` is enumerable and stays enumerable through step 5. The present
case and the absent case want opposite defaults, and only the present case is
obvious.

**Open by decision: IronHorse's step 5 is strictly wider than XS's.**

| # | What diverges | XS | IronHorse |
|---|---|---|---|
| 3 | `Object.isFrozen(petrify)` | `false` | `true` |
| 4 | `Object.isFrozen` of `%AsyncFunction%`, `%GeneratorFunction%`, `%AsyncGeneratorFunction%` | `false` | `true` |

XS's step 5 hardens two enumerated intrinsic ranges plus exactly two
non-intrinsics — `harden` and `lockdown` itself. `petrify` is not in the list.
The three dynamic-function constructors fall outside both ranges
(`XS_INTRINSICS_COUNT == _AsyncFunction`), and `%GeneratorFunction%` is never
stored in an intrinsic slot at all; after step 2 the only edge to them is the
inert stand-in, so the transitive walk never reaches them either. IronHorse
derives its roots from `boot_slot_count`, which contains all four.

**This is a divergence, not a free bonus, and § Step 5's "IronHorse already
does this, and wider" understated it.** Width is oracle-visible in four named
places. It is nonetheless kept, for two reasons that are worth stating
separately from the convenience of not changing it: freezing
`%GeneratorFunction%` and friends is what SES's own `lockdown()` does, so the
wider set is the one a HardenedJS guest expects; and both engines leave all
four **callable** after lockdown (`AsyncFunction('return 1')` works on each),
so the divergence is one of integrity, not of confinement — no reach opens or
closes on it. Narrowing to XS's exact set would trade a security property for
a conformance digit.

**Pre-existing, surfaced here but not caused here.**

`%ThrowTypeError%` does not exist on IronHorse at all. XS builds it
(`xsGlobal.c:159-168`) and installs it as the get and set of
`Function.prototype.caller` and `.arguments`; IronHorse has neither property
(`callerDesc=ABSENT argsDesc=ABSENT` against the oracle's `present`), and
`Object.getOwnPropertyNames(Function.prototype)` differs in both membership and
order. This predates lockdown and is out of scope, but it is the reason
`fx_lockdown:202-203` — which re-stamps `%ThrowTypeError%`'s name and home —
has no analogue here. Those two lines are a no-op even in XS (measured: the
function's `name` is `""` and `length` `0` both before and after `lockdown()`),
so their absence costs nothing by itself; the missing surface is the cost.

One question this raises and closes: the inert stand-in's refusal message is
unconditionally `"secure mode"`, never `"strict mode"`, and that is correct.
`fxThrowTypeError` branches on `XS_CAN_CONSTRUCT_FLAG`, and `fx_lockdown_aux`
sets that flag unconditionally (`xsLockdown.c:61`), so no lockdown-installed
stand-in in XS can reach the `"strict mode"` arm. The other consumer of
`fxThrowTypeError` — `Function.prototype.caller`/`.arguments` — is the one
IronHorse is missing.

## Known Gaps and TODOs

- [x] Settle the open decisions before writing code. Done; see § Decisions, as
      taken. Question 1 — a guest `Compartment` — was answered "out", and it
      remains the one that changes the size of the next project by more than
      the rest put together.
- [x] Fix the two comments that describe an unimplemented `lockdown` as a
      `Halt::NotImplemented` scope fold — `interp/boot.rs` and
      `ironhorse-262/src/xst.rs`. `lockdown` is now bound and dispatched;
      `mutabilities` is still absent, still a plain `ReferenceError`, and
      `native_lockdown.rs` pins the SHAPE of that absence so the claim cannot
      quietly come back.
- [x] Run the golden snapshot test under BOTH math providers when re-pinning.
      `metamorphic_determinism.rs`'s final blob and seal assertions branch on
      `ironhorse_vm::MATH_PROVIDER`, because `derive_boot_fingerprint` folds the
      provider in only under `deterministic-math` and those two digests --
      unlike the five markers above them -- are not signature-normalized. The
      file says so in a comment written by whoever was caught by it last; I
      updated the platform arm, the default-feature run stayed green, and CI's
      `--features ironhorse-vm/deterministic-math` step went red. Both arms are
      now measured under their own provider rather than copied.
- [x] Size the golden-fixture regeneration.
      Measured: `regenerate_persistence_identities` covers the TSV corpora for
      both math providers, and **nine** digests in
      `ironhorse-snapshot/tests/metamorphic_determinism.rs` are inline and
      hand-edited — five marker restamps, plus the canonical blob and its seal
      under EACH of the two math providers. Earlier revisions said six, which
      counted the blob and seal once each; the whole point of the
      deterministic-provider fix is that they are two-armed.
- [ ] **A `Machine` is frozen but never rewired, and a guest cannot ask for
      the rewiring.** `Machine::new()` freezes at construction through
      `lock_down_intrinsics`, which performs step 5 only. So
      `Function.prototype.constructor` is still the live evaluator on a machine
      that reports `is_locked_down() == true`, and because host and guest share
      `Intrinsics::locked_down`, the guest's first `lockdown()` is refused as
      "already called" — it cannot close the reach itself. Measured:
      `frozen=true | lockdown=TypeError: lockdown already called | reach=2`.
      The fix is for `lock_down_intrinsics` to run step 2 before step 5, which
      is a change to the embedder-facing freeze and to every host holding a
      `Machine` — including the `packages/thixotrope` worker path that CI
      covers — so it wants its own change and its own measurement, not a
      rider on this one.
      `a_frozen_machine_refuses_the_guest_lockdown_and_keeps_the_reach_open`
      pins the CURRENT behaviour deliberately: what must not happen is the gap
      closing silently while these documents keep claiming the reach is shut.
      If that test goes red, this paragraph is the thing to fix with it.
- [ ] **Sweep the `-l` lane end to end.** § Status measures `test/ironhorse`
      (clean) and `built-ins/Boolean` (18 → 21, all three resolving to a
      pre-existing thrown-value renderer gap). Everything between is unmeasured
      under `-l`. The expectation-list machinery (`--expectations`,
      `--update-expectations`) is the shape this wants, so the lane ratchets
      instead of being re-argued.
- [ ] **`packages/thixotrope`'s Ironhorse worker still runs the SES shim, and
      moving it to the native `lockdown()` is blocked on the compartment
      environment — not on lockdown.** `scripts/bundle-ironhorse-worker.mjs`
      inlines the whole SES bundle, does `delete globalThis.harden` so
      `@endo/harden` picks SES's own rather than the engine's, and calls the
      SHIM's `lockdown({errorTaming: 'safe', reporting: 'none', overrideTaming:
      'min'})`. The native `lockdown()` is not involved in that path at all, so
      `test-thixotrope-ironhorse` passing is a NON-REGRESSION result for this
      work, not a validation of it.
      What blocks the move is that a thixotrope guest is supposed to run as if
      in a compartment. `src/worker-peer.js` implements its
      `evaluate(source, endowments)` facet as `new Compartment()`,
      `Object.assign(compartment.globalThis, {E, Far, harden})` and
      `compartment.evaluate(source)` — the isolation is the point, since
      evaluated source must see only those three names. A native-lockdown start
      compartment supplies `harden`, an extensible `globalThis` and a working
      `eval`/`Function`, but no second global to confine them to and no
      attenuated `Date`/`Math`. Dropping the shim before the compartment
      environment exists would evaluate guest source against the SHARED
      `globalThis` with a real clock: a confinement regression, not a migration.
      So this item is downstream of the `Compartment` item below, and should not
      be attempted before it.
- [ ] **Native `lockdown()` and the SES shim are alternatives, not layers, and
      the failure mode is ugly.** SES guards a second lockdown with
      `seemsToBeLockedDown()`, whose sixth term calls
      `Date.prototype.constructor.now()` and expects NaN — an encoding of SES's
      own layout, where that slot holds the attenuated `SharedDate`.
      `fx_lockdown` puts the INERT stand-in there instead, and the stand-in has
      no `now`, so the guard throws `TypeError: call: not a function` rather
      than returning true and reporting SES's documented
      `SES_MULTIPLE_INSTANCES`. Binding a `lockdown` global also makes that
      conjunction's third term true on every IronHorse realm, where it used to
      be false.
      Measured on BOTH engines (`true|true|true|true|true|TypeError`), so it is
      inherent to `fx_lockdown`'s shape rather than an IronHorse defect, and
      giving the stand-in a `now` would buy a better SES message at the cost of
      oracle fidelity. Recorded rather than fixed; SES itself states it
      "provides security only if it runs first in a given realm". Pinned by
      `native_lockdown.rs::the_ses_shims_already_locked_down_guard_throws_after_a_native_lockdown`.
- [ ] A guest `Compartment` (`fx_Compartment`, `xsModule.c:2864`) is the next
      piece, and the one that makes the parity corpus's lockdown case runnable
      natively. It needs its own definition.
- [x] Decide where the oracle-divergence record for a deliberate departure from
      `fx_lockdown` lives. It lives in § Oracle divergences, measured, below.
      An earlier revision closed this as moot, reasoning that decision 4 is a
      divergence in WHICH `harden` step 5 calls and "produced no observable
      divergence in 6053 corpus files, so there is nothing for a ledger to
      carry". Both halves were wrong. The 6053-file number was the disconnected
      `-l` wire (§ Status), so it measured nothing; and adversarial review
      against the oracle then found five real divergences, three of which
      remain by decision. A ledger that exists only when it would be empty is
      not a ledger.
