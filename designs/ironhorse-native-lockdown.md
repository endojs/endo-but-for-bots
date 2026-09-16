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
`ironhorse-vm/tests/native_lockdown.rs` (11 cases).

Steps 3 and 4 are absent by decision, not omission: both presuppose a guest
`Compartment` (§ Scope boundary). The consequence stated there holds — the
`ses-xs-parity` lockdown case still does not run natively.

**Measured against the XS oracle.** `endot-ih -l` dual-runs each case on
Ironhorse and on XS's own `fx_lockdown`
(`xs-oracle/csrc/xs_shim.c` installs it). Over 6053 files —
`test/ironhorse` (1712, all covered, zero failures), `built-ins/Function`
(511), `built-ins/Date` (703, all covered, zero failures) and
`built-ins/Object` (3127) — `-l` produces outcomes identical to a run without
it, including byte-identical failure SETS on the two subtrees that carry
pre-existing failures (55 and 94, unchanged and unrelated). Ironhorse's
`lockdown()` and XS's do not disagree anywhere those corpora reach.

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
`SesMode::Lockdown` (`ironhorse-262/src/xst.rs`) currently returns
`Some("ses-mode:lockdown-unimplemented")` from `unimplemented_skip`, and
`endot_ih.rs::refuse_unimplemented_ses_mode` turns that into a refusal to start
rather than a run that pre-skips 15288 files and exits 0.
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
| step 4, `Date`/`Math` attenuation | a guest `Compartment` constructor of any kind |
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
worked precedent: the three `%TypedArray%.prototype` methods added in PR #1279
moved ~200 digests across six golden identity fixtures in `ironhorse-snapshot`,
and `regenerate_persistence_identities` is the tool for it.
Budget for that regeneration; it is not incidental.

**The XS oracle is available and should be used.**
`endot-ih` dual-runs each case against XS, and the oracle shim installs
`fx_lockdown`. So `-l` becomes a differential gate as soon as the arm is
removed, rather than a claim to be checked by hand. Use it.

**`#![forbid(unsafe_code)]`, metering, and determinism** apply as they do to
every other native. Note that `xsLockdown.c` calls no `mxMeter`, which is why
`do_harden`'s cost is allocation-driven rather than per-key metered; a native
`lockdown` inherits that shape.

**A compartment must not see it.**
`lockdown` is not an XS realm intrinsic — `fxCreateMachine` never binds it, and
`xst.c` and the oracle shim install it on the host global. The IronHorse
binding should likewise not appear on a compartment's global, which is a
question for `global_props` and `compartment_evaluator` rather than for
`create_hardened_globals`.

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
   No oracle divergence resulted — see § Status.
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

Not done, and not in scope: a guest `Compartment`, `mutabilities` and the
`fxVerify*` audit family, and the daemon's realm-profile choice.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) | Sized this gap and measured the motivating failure. Its § What XS implements is the source for the five steps above; its open question 1 is this document's open question 5. |
| [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) | Phase 4 is where this sits. Its § "the machinery is built; what is absent is the binding layer" names the same three absences. |
| [ironhorse-engine](ironhorse-engine.md) | Owns roadmap stage 4. This is the native half of the choice that stage's deliverable column now presents. |
| [ironhorse-test262-convergence](ironhorse-test262-convergence.md) | Owns `endot-ih` and the corpus lanes this unblocks. |

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
- [x] Size the golden-fixture regeneration against PR #1279's precedent.
      Measured: `regenerate_persistence_identities` covers the TSV corpora for
      both math providers, and six digests in
      `ironhorse-snapshot/tests/metamorphic_determinism.rs` are inline and
      hand-edited — five marker restamps, the canonical blob, and the seal that
      stamps it.
- [ ] A guest `Compartment` (`fx_Compartment`, `xsModule.c:2864`) is the next
      piece, and the one that makes the parity corpus's lockdown case runnable
      natively. It needs its own definition.
- [x] Decide where the oracle-divergence record for a deliberate departure from
      `fx_lockdown` lives. Moot: decision 4 is a divergence in WHICH `harden`
      step 5 calls, and it produced no observable divergence in 6053 corpus
      files, so there is nothing for a ledger to carry. Recorded here instead.
