# IronHorse: a native `lockdown()`

| | |
|---|---|
| **Created** | 2026-09-16 |
| **Updated** | 2026-09-18 |
| **Author** | kumavis (prompted) |
| **Status** | Implemented (`lockdown`); `Compartment` not started |
| **Source** | The gap [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) sized and Phase 4 of [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) sequenced |

## Status

Landed, within the scope boundary below.

`Interp::do_lockdown` (`ironhorse-vm/src/interp/realm.rs`) implements
`fx_lockdown` steps 1, 2 and 5; `create_hardened_globals` binds it as the guest
global `lockdown`, beside `harden` and `petrify`. `endot-ih -l` runs instead of
refusing -- evaluating the harness and the `lockdown()` call as their own
Script, ahead of the case, so nothing in the case can shadow or outrank them --
and `test262:ironhorse` with it. Pinned by
`ironhorse-vm/tests/native_lockdown.rs` (35 cases), most of which were written
from defects adversarial review found after the first revision called this
section "Landed", and the last four from a review round after the second.

The same operation runs on the two HOST paths — `Machine::new()`, which locks
down at construction, and `Machine::lock_down()`, which performs the one a
machine built unfrozen deferred. Both used to freeze (step 5) without rewiring
(step 2), which left `({}).constructor.constructor` compiling guest source in
every compartment of a realm reporting `is_locked_down()`. They share
`do_lockdown`'s step-2 helpers now, so `Intrinsics::is_locked_down` means the
whole operation on every path that can set it.

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
mutability.
Those three cases resolve to the pre-existing renderer gap; that measurement
alone does not explain failures elsewhere in the tree.
The complete checked-in corpus sweep is recorded in § Validation below.

**Independently validated by a suite that predates the work.**
`packages/hardened262` carries `ironhorse/lockdownSloppy` and
`ironhorse/lockdownStrict` profiles whose committed baseline recorded **178**
failures across the two. **54** of those were cases that died at the
`lockdown()` call, and all 54 now pass; the baseline diff is a pure
failed→passed flip over the same file set, with no case regressing and no other
agent's profile moving. (An earlier revision of this paragraph, and commit
`50e802b71`, gave 54 as the profiles' whole failure count. It cleared 30% of
that baseline, not all of it.)

**124 remain, and only 76 of them are the scope boundary.** An earlier revision
said "the remaining 124 are `Compartment` cases and stay red, which is the
scope boundary doing what it says"; counted from the committed baselines, the
split is 76 under `test/Compartment`, 29 `intrinsics/*/intrinsic-metadata.js`,
12 under `test/modules` (mostly `module-source-reflection/ses-legacy`), and 7
others (`TextDecoder`/`TextEncoder` immutable-ArrayBuffer intersection,
`freeze/monadic.js`, `harden/stamp.js`). The 29 metadata outcomes are not `Compartment` failures.
Re-running `scripts/test.js --agent ironhorse --compact test/intrinsics` shows
that all 29 fail identically with and without native lockdown.
Their first failing assertions cover missing `Symbol.toStringTag` properties,
iterator and generator method names/arities, `RegExp.prototype` metadata,
`Math.random`, and `%ThrowTypeError%`.
They are pre-existing intrinsic-surface gaps; the native inert-stand-in cases
pass separately.
Attributing all 124 failures to `Compartment` hid that distinction.
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
function-family and Date prototype constructors to inert stand-ins, then
transitively harden the intrinsics within the scope boundary below —
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
inherits (§ The ordering fact, and what it is actually a fact about), and it
can be made to pass by giving the shim a `harden` that does not walk prototype
chains — measured, and deliberately not taken here.
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
Closing that is `fx_lockdown` step 2 and nothing else, and step 2 closes that route.
The native operation now runs on both host lockdown paths as well as on a
standalone interpreter's guest request.

**3. The daemon's realm profile.**
[ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md)
§ What a next step should establish first asks which of two profiles the
daemon's IronHorse worker takes: the SES shim (already proven in-tree by
`thixotrope-ironhorse-worker`) or a native one.
This work is the native profile's prerequisite, not its decision.
**Treat that question as still open.**
Building native `lockdown()` does not settle it and should not be read as
settling it; it makes the native profile answerable where today it is not.

## The ordering fact, and what it is actually a fact about

**It is a fact about `[[DefineOwnProperty]]`, not about this port.** An earlier
revision of this section opened "the one thing this port must not get wrong:
rewire the constructors first, harden afterwards", and that was wrong twice
over.

Wrong as stated, because mutation testing refutes it: inverting steps 2 and 5
in `do_lockdown` changes no observable behaviour and fails no test. The reason
is `force_locked_down_constructor`, which ASSIGNS the slot rather than defining
the property — XS's `slot->kind = constructor->kind` (`xsLockdown.c:68-69`), the
privileged write this port copies — so a frozen `Function.prototype` is no
obstacle whenever the write happens. The direct write is the contract; the order
is not.

Wrong as a plan, because step 2 now runs on BOTH sides of step 5 regardless.
Hardening walks the roots through the MOP, so a Proxy trap can fire between the
two and put the real evaluator back; `reassert_function_constructors` closes
that window, and no ordering of the two steps could have
(`a_proxy_cannot_restore_the_evaluator_from_inside_the_freeze`).

What is true, and worth its own section, is the cost of the other order for an
implementation that goes through the ordinary MOP — which is exactly how the
SES shim fails on IronHorse.

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

A native `lockdown()` escapes the shim's version of the problem through the
privileged slot write in `fx_lockdown_aux`.
That write can replace an already-frozen constructor property.
An implementation that used ordinary property definition would reproduce the
shim's refusal even in Rust.

## Scope boundary

The goal is `fx_lockdown`, minus the two steps that presuppose a guest
`Compartment`.

| In | Out |
|---|---|
| step 1, idempotence | step 3, the compartment-global template |
| step 2, constructor rewiring, for the four function-family prototypes | step 2's fifth call, on `Compartment.prototype` |
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

Only step 4's Date prototype constructor rewrite is included.
The actual Date/Math attenuation belongs to the compartment-global template and
remains out of scope — see § Decisions, as taken, item 3.

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

**This is the substance of the work.** Five of those six prototypes exist on
IronHorse as named fields (`async_function_proto`,
`async_generator_function_proto`, `generator_function_proto`, `function_proto`,
and `date_proto`); `Compartment.prototype` does not and is out of scope.

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

The privileged write is what allows rewiring an already-frozen prototype.
XS orders step 2 before step 5; IronHorse also reasserts the constructor edges
following the harden walk because proxy traps can change them during that walk.
The stand-in's own surface must be frozen before exposure in step 2.

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

- The roots list is the arena snapshot taken at machine construction.
  The stand-ins are minted during boot, so they are included.
  Step 2 freezes their own surface before exposing them; step 5 still traverses
  them and the prototype graph.
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
every other native.
XS's `xsLockdown.c` calls no `mxMeter`; IronHorse charges its existing harden
traversal, including per-object and per-key work.
Oracle value agreement is the gate, and exact computron parity is advisory.

**A shared realm must be locked down before it admits untrusted siblings.**
Both host construction and deferred host lockdown perform steps 2 and 5.
A guest call on that realm throws `TypeError: lockdown already called`.
An unfrozen shared machine does not bind the native `lockdown`; the host drives
its transition after the trusted shim or initialization code has run.

An earlier ambient-environment guard was removed: promise jobs can change the
current environment, so it did not enforce the intended policy.
The native operation now relies on shared-realm initialization, completed-call
idempotence, and an in-progress guard that rejects calls from proxy traps during
the harden walk.
The guard is transient; the private completion marker is written only after the
entire operation succeeds and is the state carried across persistence.

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
   first call. Measured on `Machine::new()`, which locks down at construction: a
   guest's very first `lockdown()` is
   `TypeError: lockdown already called`. XS has no analogue of that state,
   because XS has no host-side lockdown. This is a real edge of the shared
   flag, not a second call, and "what does a second `lockdown()` do?" was the
   wrong framing to have settled it under.

   For a while it was worse than an edge. `lock_down_intrinsics` performed step
   5 only, so a `Machine::new()` realm was frozen but never REWIRED:
   `Function.prototype.constructor` stayed the live evaluator, and the refusal
   above meant the guest could not ask for the rewiring that would close it.
   Both host paths now perform steps 2 and 5 together, so the flag means what it
   says and the refusal costs the guest nothing.
   `a_frozen_machine_runs_the_whole_lockdown_at_construction` pins the pair, and
   `realms.rs::a_locked_down_machine_denies_every_prototype_chain_evaluator`
   pins the reach it closes.
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
5. **Does the daemon want this at all?** **Deferred 2026-09-18** at the owner's
   direction: the endor daemon is not a current priority. This work does not
   answer the question and no longer needs to -- it makes the native profile
   answerable for whoever asks it later.

   Deferred, not open. Nothing should be sequenced on it, and a reader planning
   work here should treat Phase 4 of
   [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md)
   -- the endor SES bundle bar, which this question gates -- as deferred with
   it. That document is not amended here; its own Status still reads Proposed
   and it remains an ordering proposal with nothing implemented.

   Distinct from the profile question answered the same day, which was about
   `packages/thixotrope`'s IronHorse worker and chose the SES shim. The two are
   separate decisions about separate embedders, and conflating them is easy
   because both were once phrased as "the daemon's IronHorse worker" when only
   thixotrope has one.

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
      providers), the **nine** inline digests in `metamorphic_determinism.rs`
      are re-pinned with a note, and the upgrade consequence is in this
      document's § Constraints and in the PR. (Nine, not six: five marker
      restamps plus the canonical blob and its seal under EACH math provider.
      An earlier revision of this line counted the blob and seal once each,
      which is the exact miscount the two-armed fix exists to prevent.)
- [x] `ses_prelude_reach` stays at its 7/8 pin and `ses_boot_intrinsics`'s
      three realm profiles still pass, with `lockdown` going from `undefined` to
      `function` in the pre-shim census where the engine binds its own.

      **Corrected 2026-09-18: that is two of the three profiles, not all three,
      and an earlier revision of this item said "one change in each" and "the
      engine binding one on every realm".** `create_hardened_globals` binds
      `lockdown` for every `Interp`, but
      `new_shared_realm_machine_configured` REMOVES it again when
      `freeze == false` (`interp/realm.rs:703`): an unfrozen machine exists so
      the SES shim can repair and freeze the graph, the shim installs its own,
      and until it does the engine's would be a realm-wide mutation reachable
      from any compartment of a machine that has not locked down yet. So the
      two plain-`Interp` profiles moved and the unfrozen-`Machine` profile still
      pins `lockdown=undefined` deliberately.

      **Where the term did move, it stopped discriminating, and the tests now
      say so.** `lockdown=function` used to mean "the shim installed one"; where
      the engine binds one it is `function` on both sides of the shim's
      evaluation and carries no information. The unfrozen profile
      pins object identity across the shim's evaluation instead, and the frozen
      profile CALLS the binding and pins `TypeError: lockdown already called` —
      the engine's message, where the shim's would have been
      `Already locked down ... (SES_MULTIPLE_INSTANCES)`.
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
stored in an intrinsic slot at all; step 2 replaces the prototype back-references with inert stand-ins, so those
edges no longer lead to the original evaluators. IronHorse
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

**Open by decision: a failing harden walk revokes the marks of walks that
completed inside it, where XS undoes only its own.**

| # | What diverges | XS | IronHorse |
|---|---|---|---|
| 6 | a walk fails after a nested walk completed under it | `fx_harden`'s `mxCatch` clears the marks of its OWN worklist; the nested walk's marks stay | every mark placed since that walk began is revoked, the nested walk's included |

The mark (`XS_DONT_MARSHALL_FLAG`) is what every later `harden()` and every
`lockdown()` root short-circuits on, so what it promises matters more than when
it is written. XS writes it per instance during the walk and undoes one walk's
worth on failure. That is coherent while only one walk exists, and a Proxy trap
reached from the freeze can always arrange two: the trap runs arbitrary guest
code, `harden()` included.

Under re-entry the mark means less than a nested walk reads into it. It means
"queued, and frozen by whichever walk queued it" — not "the graph under this is
frozen". The nested walk reads the latter, skips that subgraph, completes, and
marks its own roots. When the outer walk then fails and undoes only its own
marks, what is left is a root carrying a mark that promises a freeze nobody
performed.

Measured, before the fix (`a_nested_harden_cannot_inherit_an_unfinished_walks_marks`,
reduced to one leaf object the outer walk had queued and not yet frozen):

```text
outer=TypeError: extensible object | harden(nestedRoot) returns=true |
isFrozen(leaf)=false | leaf.mutable=2
```

and through `lockdown()`, where a guest object attached to `Object.prototype`
before the walks survives step 5 mutable because the root carrying it was
marked (`lockdown_refreezes_an_intrinsic_a_failed_nested_walk_marked`):

```text
outer=TypeError: extensible object | isFrozen(Object.prototype)=true |
isFrozen(smuggled)=false | smuggled.mutable=2
```

Both now read `... | true | 1`. A mark is provisional until the OUTERMOST walk
completes: `Intrinsics::harden_marks` records them in order, a failing walk
revokes every mark placed since it began, and only the outermost walk's
completion makes the survivors permanent
(`revoke_harden_marks`, `interp/property/integrity.rs`).
`a_walk_that_fails_inside_another_walk_revokes_what_completed_under_it` is the
case that needs the scope to be the failing walk rather than the outermost one:
there the outermost walk SUCCEEDS, so nothing later would sweep a mark its
nested failure left behind.

**Revoking rather than withholding is a deliberate second choice.** The
obvious alternative — write no mark until the walk finishes — gives a stronger
invariant and needs no bookkeeping at all. It was implemented, and it breaks
re-entrant termination: a trap that hardens the walk's own root finds it
unmarked, starts a second walk, re-enters the same trap, and the run halts with
`ReentryLimit { depth: 2062, limit: 2048 }` where XS and this port both return.
`a_trap_that_hardens_the_walks_own_root_terminates` pins that. A soundness fix
that turns a terminating program into a halt is a trade, not a fix.

For a walk that is not re-entered, nothing moves: the same instances are
queued, in the same order, at the same metered cost, and the failure path
revokes exactly the marks XS's does.

**Open by decision: a refused harden fails HARD, where XS's is catchable.**

| # | What diverges | XS | IronHorse |
|---|---|---|---|
| 5 | step 5 refusing partway | a catchable exception; the guest continues | `Halt::Refused("lockdown:intrinsic-graph")`, which unwinds the run |

`fx_lockdown`'s harden calls are a straight-line sequence with no rollback, so
a refusal at root `k` leaves earlier roots frozen.
XS lets the guest catch that exception and carry on, but its flag was already set
at entry (`xsLockdown.c:92`), so another call reports "lockdown already called".
IronHorse instead leaves its successful-completion marker false and makes the
refusal uncatchable; a false marker does not mean the realm is still mutable.

Two reasons, and the second is the one that settles it.

First, there is nothing useful a guest can do while holding a realm that is
partly frozen and simultaneously reports `locked_down == false`.

Second, **the retry this document used to advertise does not work.** § Step 5
and `lock_down_intrinsics` both said a hardened root is idempotent, so calling
`lockdown()` again completes the freeze. The case that actually reaches the
failure refutes it: a `Proxy` whose `preventExtensions` trap returns `false`
refuses the same root on every attempt, so the retry throws forever instead of
converging. The documented recovery was a loop that cannot terminate.

Making it a halt also closed a second finding at no extra cost. Every FAILED
`lockdown()` re-ran step 2 and minted five more inert constructors through
unmetered allocation, so `for(;;){try{lockdown()}catch(e){}}` was a
guest-reachable heap-growth primitive. With the failure uncatchable the loop
cannot iterate: measured, a 500-iteration attempt halts on the first refusal.
The fix for the retry claim was the fix for the allocation.

`a_refused_harden_makes_lockdown_fail_hard_and_uncatchably` is the test, and it
is the first in this suite to exercise any failure path at all — every other
case ran `lockdown()` succeeding.

**Closed: a guest `lockdown()` used to make the machine unsnapshottable.**

`Interp::function_persists` admits a function above `boot_slot_count` only with
an explicit reconstruction recipe. XS mints the stand-ins inside `fx_lockdown`
with `fxDuplicateInstance`, and following that literally put them above the
line, so `Function.prototype.constructor` held a reference to a non-persisting
native and the whole machine refused to store: measured `before lockdown: None`,
`after lockdown: Some("a stored reference to a non-persisted native function")`.
A `Machine::new()` host-side freeze mints nothing and stayed persistable, which
pins the cause on those five objects.

**Why XS does not have this problem**, which is the useful comparison.
`fxProjectCallback` (`xsSnapshot.c:1261`) snapshots a host function by storing
an INDEX into `gxCallbacks`, and `fxDuplicateInstance` copies the
`XS_CALLBACK_KIND` slot, so the duplicate carries `fxThrowTypeError`'s pointer
and projects like any other. XS identifies a native by WHAT IT DOES, so one
created mid-run snapshots for free. IronHorse identifies a native by WHERE IT
IS -- `native_names` filters `owner < boot_slot_count` and its restore comment
says "the native implementation stays boot-derived; only chunk locations
travel". A native born after boot had no identity a snapshot could express.
That asymmetry was the bug, not anything in `lockdown()`.

The fix is placement, and both halves are load-bearing:
`create_locked_down_constructors` runs AFTER `create_intrinsics` -- because
boot's own constructor wiring reads `ctor_prototype` back to install
`prototype.constructor`, so a stand-in visible during `create_intrinsics`
installs lockdown's effect at boot -- and BEFORE `boot_slot_count` is fixed, so
they persist by index like any other boot native. Step 2 then only wires, which
means lockdown does not mint new native stand-ins.
Wiring still materializes property slots and lazy prototype members.

An earlier attempt minted them inside `create_intrinsics` and collided with
three separate boot invariants; a second design added a snapshot recipe table
and a format version bump. Neither was needed. **The divergence from XS is only
in WHEN the objects are created, never in what a guest can observe.**

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

## Validation on 2026-09-17

The final stand-in freeze includes `name` and `length`.
Successful completion is carried in a private boot slot, and a separate transient
guard rejects reentry during the harden walk.

- Full engine workspace, including compile/regexp parity and store-integrity:
  **3394 passed, 0 failed, 41 ignored**.
- Deterministic-math VM and snapshot suites: **1654 passed, 0 failed, 33 ignored**.
- Outer-workspace `ironhorse_store_worker` and `ironhorse_runtime_compiler`:
  **14 passed**.
- Both engine runs include all **30 native-lockdown** regressions, the **4
  lockdown-carry** tests, all **14 SES boot-intrinsic** tests, and the SES prelude
  test that pins the 7/8 result.
  `IRONHORSE_SES_BOOT_REQUIRED`, `IRONHORSE_SES_SHIM_REQUIRED`, and
  `IRONHORSE_SES_PRELUDE_REQUIRED` were set, so missing bundles could not silently
  bypass the profiles.
- Both providers' regenerated identities preserve continuation results and costs;
  raw-lockdown restore also survives garbage collection.
- Rustfmt and the CI-pinned Rust 1.88 Clippy gate (`--workspace --all-targets`,
  `-D warnings`) pass.
  Rust 1.91 Clippy also completes, with existing warnings in unchanged files.
- The native hardened262 report matches the committed IronHorse profiles.
  The **29 metadata failures** have identical first failures in the unlocked
  profile; they are separate from the **54 native-lockdown successes**.

The local Apple clang oracle build uses
`CFLAGS=-fno-strict-float-cast-overflow`.
Without that flag, XS's out-of-range double-to-integer cast while parsing numeric
literals produced `2147483647` and twelve false corpus differences on this host.
The failure and flag correction were reproduced on the backed-up WIP `a6b917dfb`.
No XS source change is included.
With the flag, `endot-ih -l --repeat 3` covers all **1712/1712** IronHorse corpus
files with **0 failures and 0 skips**.

The full workspace command was:

```sh
CFLAGS=-fno-strict-float-cast-overflow RUST_MIN_STACK=33554432 \
IRONHORSE_SES_BOOT_REQUIRED=1 IRONHORSE_SES_SHIM_REQUIRED=1 \
IRONHORSE_SES_PRELUDE_REQUIRED=1 \
cargo test --locked --workspace --no-fail-fast \
  --features ironhorse-compile/parity,ironhorse-regexp/parity,ironhorse-vm/store-integrity
```

A temporary `CARGO_TARGET_DIR`, disabled incremental compilation, and disabled
debug symbols keep validation build outputs small; they do not change the test
selection.

The **complete checked-in test262 corpus** was also swept under `-l`:
**39759 files**, excluding `staging` and `_FIXTURE.js` helpers, with no omitted
strict variants.
Every returned path was checked against the discovery manifest exactly once.
Four workers ran 100-file batches with `--case-timeout 10`, `--json`, and
`--update-expectations`, producing 398 reports and expectation files.

| Outcome | Files |
|---|---:|
| Covered | 32072 |
| Failed | 3781 |
| Named pre-run skips | 206 |
| Named post-run skips | 3700 |

This is a completed measurement, not a green conformance claim.
All 1712 `ironhorse/` files are covered.
Of the failures, 2520 are thrown-value rendering differences, and seven are
`ironhorse-hang` verdicts after the ten-second bound.
The remaining failures include missing intrinsic surfaces, parser diagnostics,
and strict property-assignment behavior; the full failure set has not been
attributed case by case.
Two completion-value differences are the pre-existing missing `caller` and
`arguments` properties, reproduced on the same cases without `-l`.
A separate probe without lockdown also reproduces strict indexed assignment to
`Object.freeze(Array.prototype)`: XS throws `TypeError`, while IronHorse silently
refuses the assignment; both retain a frozen prototype with no added property.
Thus the earlier Boolean-only explanation does not account for the whole lane.
The per-case report and generated expectations preserve the measured failures
instead of treating them as passes.

## Validation on 2026-09-18

This revision adds the provisional harden mark and its revocation, the phased
262 runner, and the two shared-corpus gates. Everything below was re-run on
this tree; the 2026-09-17 section above measured `c5e349ca3` and its numbers do
not carry to this head.

- Full engine workspace, including compile/regexp parity and store-integrity:
  **3413 passed, 0 failed, 41 ignored** over 429 suites.
  `IRONHORSE_SES_BOOT_REQUIRED`, `IRONHORSE_SES_SHIM_REQUIRED` and
  `IRONHORSE_SES_PRELUDE_REQUIRED` were set, so the SES lanes could not skip
  silently; their bundles were generated with `yarn bundle:xs`,
  `yarn workspace @endo/test262-runner build` and
  `yarn workspace @endo/thixotrope build:ironhorse-bundles`.
  The run includes the **35 native-lockdown** regressions, the **5**
  lockdown-carry persistence tests, all **14 SES boot-intrinsic** tests, the
  **6** runner phase regressions, and the **2** shared-corpus gates
  (47 hardened262 files / 90 scenarios, and 29 stage4-harden files).
- Deterministic-math VM and snapshot suites: **1661 passed, 0 failed, 33
  ignored**.
- The CI-pinned lint gates, all clean: `cargo +1.88.0 build --locked
  --workspace` under `RUSTFLAGS=-D warnings`, `cargo +1.88.0 clippy --locked
  --workspace --no-deps -- -D warnings` (and again with `--all-targets`), and
  `cargo +1.88.0 fmt --all --check`. Rust 1.91 Clippy reports only the
  pre-existing `is_multiple_of` and `from_ref` lints, in files this change does
  not touch.
- Outer-workspace Endo integrations, `ironhorse_store_worker` and
  `ironhorse_runtime_compiler`: **14 passed, 0 failed**. That workspace needs
  `rust/endo/xsnap/src/archive_text_endowments.js`, which is generated and
  gitignored; `node packages/daemon/scripts/bundle-archive-text-endowments-xs.mjs`
  produces it.
- `corpus_conversion_equivalence`: **1711 total, 1645 covered, 0 failed** on the
  regenerated raw meter pins. It was RED at the previous checkpoint -- 66 of the
  145 pinned cases, each off by the same 9,182,752 raw units, because the pin
  measured the concatenated harness+case Script and the subject is now its own.

The XS oracle was built from the pinned `c/moddable` submodule with the host's
gcc; the `CFLAGS=-fno-strict-float-cast-overflow` the 2026-09-17 section
records is an Apple-clang correction and was not needed here.

**The whole checked-in corpus was re-swept under `-l` on the phased runner.**
The 2026-09-17 sweep measured the concatenating runner, so the phase split
invalidated its interpretation rather than its arithmetic, and this replaces it.
Batches of 100 files, a ten-second per-case bound, and IronHorse's own
discovery (`ironhorse-262-report discover`): 1296 batches over 39,668 case
files, of which 1292 ran (see the exclusion below). The corpus holds 39,759 non-fixture files; discovery excludes
`test/harness`'s 91 self-test files, which are harness, not cases.

| Outcome | Files |
|---|---:|
| Covered | 31,901 |
| Failed | 3,691 |
| Named skips | 3,681 |
| **Executed** | **39,273** |

No selected strict variant was omitted anywhere in the sweep
(`strict-skipped-by-policy=0` in every batch).

**The lane this work targets is green on the phased runner:** `test/ironhorse`
is **1712 files, 1712 covered, 0 failed, 0 skipped** -- the result § Status
reports, re-established after the runner stopped concatenating.

**395 files did not run**, and the exclusion is a property of this host rather
than of the corpus: the four `built-ins/RegExp/property-escapes/generated`
batches. Each case builds a ~1.1M-code-point subject and runs it on BOTH
engines, and each batch holds 3.5-6 GB of oracle RSS, so three of four are
killed by the OOM reaper when run in parallel on a 15 GB box and a single batch
exceeds an hour of CPU alone. `ironhorse-262/scripts/README.md` describes the
same batches as the reason its own sweep carries a 900-second watchdog and a
quarantine path. They are named here rather than folded into the totals.

**The wider lane is not green and is not claimed to be.** The largest failure
classes are thrown-value rendering differences (`abort-value-differs`, 2409),
cases where IronHorse throws and the oracle completes (797), and error-message
differences (207); `ironhorse-hang` accounts for 31 at the ten-second bound.
The largest named skips are aborts both engines reach
(`shared-positive-test-failure`, 1180 + 127 strict), the oracle host's absent
`Intl` (422 + 274), and unimplemented module surfaces (dynamic import 383,
top-level await 196, static linking 122). None of that set is claimed
diagnosed here, and none of it moved with this change in a way this sweep can
attribute: it is a baseline for the phased runner, not a comparison against the
retracted one.

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
- [x] **A `Machine` was frozen but never rewired, and a guest could not ask for
      the rewiring.** `Machine::new()` froze at construction through step 5
      only, so `Function.prototype.constructor` was still the live evaluator on
      a machine reporting `is_locked_down() == true`; and because host and guest
      share `Intrinsics::locked_down`, the guest's first `lockdown()` was
      refused as "already called" and could not close the reach itself.
      Measured: `frozen=true | lockdown=TypeError: lockdown already called |
      reach=2`. Since a `Machine` is the only thing that has compartments, that
      was every compartment in the system, past the `global_names` list that
      documents itself as unable to close a prototype route.

      Fixed by running step 2 on both host freeze paths —
      `new_shared_realm_machine_configured`'s `freeze` arm and
      `lock_down_intrinsics` — through the same
      `poison_function_constructors` / `reassert_function_constructors` pair the
      guest `lockdown()` uses. It mints no new native stand-ins, because they are
      already boot objects; that was the prerequisite, and closing this gap
      before it would have made every `Machine` unsnapshottable.
      Now `frozen=true | lockdown=TypeError: lockdown already called |
      reach=TypeError: secure mode | ownFunction=3` — the compartment's own
      `eval` and `Function` keep working, which is SES's shape, and the three
      unnamed evaluator families (`%GeneratorFunction%`, `%AsyncFunction%`,
      `%AsyncGeneratorFunction%`, reachable ONLY through a prototype chain)
      become unreachable rather than shared.

      `freeze = false` deliberately does NOT poison: that machine exists for the
      SES shim, whose `repairIntrinsics` runs before its own freeze and installs
      its own inert constructors. Two tests that measured which environment a
      prototype-chain evaluator compiles in moved to that shape, since it is now
      the only one that has those routes —
      `realms.rs::every_reachable_evaluator_compiles_in_the_calling_compartment`
      and
      `runtime_compile_meter.rs::shared_dynamic_constructors_use_the_calling_compartments_evaluator_service`.
- [x] **The re-assert after step 5 recreated a WRITABLE constructor when a
      Proxy trap had deleted it.** Found in review on `9f9ff0a74`.
      `a_proxy_cannot_restore_the_evaluator_from_inside_the_freeze` covers a
      trap that REPLACES `Function.prototype.constructor` during the harden
      walk; the one that DELETES it is a different bug and a worse one. The
      delete succeeds while the prototype is still configurable, step 5 then
      freezes a prototype carrying no `constructor`, `find_property` answers
      `None` for a genuinely absent property, and the re-assert's
      `map_or(0, …)` — correct for step 2, where it reproduces XS's freshly
      created slot — recreated it writable and configurable on an
      already-hardened prototype. Measured:
      `w=true e=true c=true | reach=2 | isFrozen(Function.prototype)=false`.
      `lockdown()` returned success, the prototype it had just frozen was no
      longer frozen, and one assignment put the evaluator back.

      `force_locked_down_constructor` now takes a `seal` mode: step 2 preserves
      the existing flag as before, and the re-assert keeps only the enumerable
      bit and forces `XS_DONT_SET_FLAG | XS_DONT_DELETE_FLAG`. In every case but
      the deleted one it is a no-op, because step 5 has already set them.
      Enumerability is carried rather than forced for the same reason step 2
      defaults to `0`: a `constructor` that had to be re-created is enumerable,
      which is what XS produces for the pre-lockdown delete.
      `a_proxy_that_deletes_the_constructor_inside_the_freeze_gets_a_sealed_one_back`
      is the regression, mutation-verified.

      XS has no analogue in either direction: `fx_lockdown` performs steps 2 and
      5 once each with no re-assert, so on XS the trap simply wins. The
      re-assert is this port's deliberate divergence, so its failure modes are
      ours to define.
- [x] **`Intrinsics::locked_down` did not survive persistence.** Found in the
      same review. The flag lives on an `Rc<Realm>` beside the arena rather than
      in it, so nothing carried it: a restored standalone `Interp` answered
      `returned` to a second `lockdown()` where the uninterrupted one answered
      `TypeError: lockdown already called`. Not merely a wrong answer — the
      guest then re-ran the whole operation and was charged for it; `twin`
      compares computrons and measured 2610 against 2624.

      Completion now lives in a private boolean slot allocated at boot.
      The host and guest paths set it only after step 5 and the final constructor
      rewrite succeed; restore reads that slot to recover the realm flag.
      It has no edge from any guest object, so guest code cannot set it.
      The boot fingerprint includes its identity; existing snapshots are refused
      as incompatible with the new boot layout, without changing the wire format.

      Two earlier derivations were insufficient.
      `ctor_prototype` rows for native stand-ins are filtered out of persistence.
      The replacement, `lockdown_step_two_applied`, inspected prototype property
      chains for the stand-ins, but those references exist before step 5 finishes.
      A proxy can refuse the harden walk, leaving those edges and an incomplete
      lockdown behind.
      Starting a new crank clears the halted activation, after which the public
      interpreter API permits a snapshot.
      Before this fix, restore answered `TypeError: lockdown already called`
      while the uninterrupted interpreter still halted with
      `Refused("lockdown:intrinsic-graph")` (114 versus 106 computrons).
      The embedder should discard a failed realm, but restore must still preserve
      its state rather than turn failure into success.

      `ironhorse-snapshot/tests/lockdown_carry.rs` covers successful completion
      through eager, lazy and checkpoint store resume, raw blob restore, a never
      locked-down machine, and the failed-lockdown case.
      Shared-machine restore also requires a true completion marker.
- [x] **A proxy trap could reenter lockdown before completion.**
      `do_harden` marks queued roots before it traverses them.
      A nested call could skip the outer walk's unfinished roots and return
      `undefined`, even though the outer trap could still refuse the freeze.
      An in-progress RAII guard now rejects reentry with
      `TypeError: lockdown already called` and resets on every exit.
      It is separate from the persisted successful-completion marker.
      Regressions cover successful outer completion and a nested attempt followed
      by refusal, another crank, and snapshot restore.
- [x] **A nested harden walk's marks outlived the failed walk they rested on.**
      Found by static review of the re-entry guard above, then reproduced. That guard stops a nested `lockdown()`; it says nothing about
      a nested `harden()`, which any Proxy trap reached from step 5 can call.
      The outer walk's queued-but-unfrozen instances looked hardened to that
      nested walk, which skipped them, completed, and marked its own roots; the
      outer walk's failure then undid only its own marks. What was left is a
      root carrying a mark that makes every later `harden()` -- and every
      `lockdown()` root that reaches it -- return immediately over a graph that
      is not frozen. Measured: `isFrozen(leaf)=false` after `harden(nestedRoot)`
      returns, and `smuggled.mutable=2` after a successful `lockdown()`.

      Fixed by making a mark provisional until the OUTERMOST walk completes.
      `Intrinsics::harden_marks` records them in order; a failing walk revokes
      every mark placed since it began, nested walks' included, and only the
      outermost walk's completion makes the survivors permanent. § Oracle
      divergences row 6 carries the departure from XS, which has the same shape
      of hole, and why withholding the mark instead -- the stronger and simpler
      invariant -- was implemented, measured and rejected: it costs re-entrant
      termination.

      Three regressions, each mutation-verified against a different way of
      getting this wrong: `a_nested_harden_cannot_inherit_an_unfinished_walks_marks`
      and `lockdown_refreezes_an_intrinsic_a_failed_nested_walk_marked` for the
      finding itself, `a_walk_that_fails_inside_another_walk_revokes_what_
      completed_under_it` for the revocation's scope (the outermost walk
      succeeds there, so nothing sweeps later), and
      `a_trap_that_hardens_the_walks_own_root_terminates` for the termination
      the alternative design lost.
- [x] **Worklist marks surviving an abnormal unwind.** Raised as unverified
      beside the finding above: a `harden()` walk unwound by a Rust panic runs
      no cleanup, so an interpreter a supervisor keeps and reuses would carry
      marks for a freeze that never happened. `Halt::HeapExhausted` was never
      the case in question -- it is an ordinary `Err` and takes the revoke path
      -- so the concern was only ever about a panic.

      The provisional-mark record answers it: marks with no walk running are
      exactly the residue such an unwind leaves, so an outermost walk drops any
      it finds before the short-circuit that would trust them.
      `harden_drops_marks_left_by_a_walk_that_never_returned` reproduces that
      state and pins the sweep; removing the sweep turns it red.
      Holding queued indices across a trap is safe for the reason it already
      was -- `collect_garbage` admits only a quiescent machine, so no collection
      can recycle one mid-walk.
- [x] **Stand-ins were guest-writable during step 5.**
      Step 2 exposes the inert constructors before the harden walk enters guest
      proxy traps.
      A trap could add a getter that step 5 then froze into the shared graph.
      In the deferred host path, compartment B invoked compartment A's getter
      after `Machine::lock_down()` returned successfully.
      Making the stand-ins non-extensible blocked added properties and prototype
      changes, but left their existing `name` and `length` configurable.
      A regression against that intermediate fix measured
      `true:guest channel` after replacing `name` with a getter.

      `wire_locked_down_constructor` now materializes and freezes `name` and
      `length`, installs the immutable `prototype`, and prevents extensions
      before publishing `prototype.constructor`.
      This touches only the stand-in's own surface and runs no guest code.
      It matches XS's inherited protection: `xsGlobal.c:160-168` makes
      `%ThrowTypeError%` non-extensible and seals its properties;
      `fxDuplicateInstance` (`xsType.c:104-118`) copies those flags.
      Native regressions cover added properties, metadata replacement, prototype
      changes and the cross-compartment channel.
- [x] **Sweep the `-l` lane end to end.**
      § Validation records all 39759 checked-in corpus files, including the
      3781 failures and 3906 named skips.
      The 398 batches each produced a per-case JSON report and parameterized
      expectation file; the aggregate has exact manifest coverage.
      Wider test262 conformance remains incomplete and is not claimed by this
      native-lockdown implementation.
- [x] **`lockdown();` was spliced into the case body, where the case could
      reach it.** The splice `endot-ih -l` gained in § Status was inside the
      executed Script, and three things follow from that which no amount of
      ordering fixes. A case that declares `function lockdown() {}` shadows the
      call (hoisting puts the declaration before it either way). A `raw` case
      loses its hashbang and its directive prologue, because neither is first
      any more. An `async, onlyStrict` case loses the strictness it asked for,
      for the same reason.

      Setup -- the harness includes, `--prelude`, then `lockdown()` -- is now
      compiled and evaluated as its OWN Script in the same realm, and the
      subject is compiled separately, which is what `xst262.c` does. The two
      share one microtask checkpoint, at the end, so a case that queues a job
      in setup sees it drain where it did before. A setup failure is reported
      as `setup failed:` and can never satisfy a negative case's expectation.
      `ironhorse-262/tests/lockdown_setup.rs` covers the hashbang and prologue
      files from the corpus, both shadowing declarations, async strictness, the
      shared checkpoint, module subjects, and the negative-case case.

      **One corpus consequence, and it is a real change rather than a
      bookkeeping one.** A case's `ironhorse-meter-5-raw-N` pin measured the
      whole concatenated Script, harness included. It now measures the case,
      which is what the pin is for. The 66 harness-using pins were regenerated
      against the case script alone -- each dropping the same 9,182,752 raw
      units, the harness's own cost -- and the 79 `raw`-flagged pins, which
      never had a harness, are unchanged. `corpus_conversion_equivalence` is
      green on the regenerated set and was red on 66 of 145 before it.

      `SesMode::prelude()` is gone rather than kept as documentation. It was
      the `"lockdown();\n{body}"` template whose only callers were its own unit
      tests -- the exact shape that let § Status's disconnected wire pass for a
      measurement -- and `assemble` now writes what the mode contributes once,
      with `a_lockdown_mode_actually_splices_the_call` asserting on the output.
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
      `compartment.evaluate(source)`, and the isolation is the point: evaluated
      source must see only those three names.
      **The isolation does not have to come from a GUEST `Compartment`.** An
      earlier revision of this item called the migration blocked on
      `fx_Compartment`; that was too pessimistic. Measured end to end in
      `native_lockdown.rs::a_host_made_compartment_confines_guest_source_only_with_global_names`,
      the whole shape works today on a `Machine`: the host locks down — at
      construction with `Machine::new()`, or later with `Machine::lock_down()`
      on a machine built unfrozen so a shim can repair the intrinsics first —
      and guest source then runs in a compartment the HOST made. The start
      realm's globals do not reach that guest and its globals do not reach back,
      it shares the frozen intrinsic graph, and
      `({}).constructor.constructor` is a `TypeError` inside it: step 2 closes
      the reach realm-wide, so a compartment inherits it.

      The confinement is a CONJUNCTION, and the test measures both halves.
      `global_names` closes the direct `eval` and `Function` BINDINGS, which
      lockdown cannot — `compartment_evaluator` mints those per compartment,
      after lockdown ran. Lockdown closes the prototype route, which
      `global_names` cannot. A worker that wants guest source to see only `E`,
      `Far` and `harden` needs both, and `E`, `Far` and `harden` arrive as
      endowments rather than names.

      Note for the migration: on an unfrozen machine the guest `lockdown` is not
      bound at all (the shim installs its own, and until it does the engine's
      would be a realm-wide mutation reachable from any compartment of a machine
      that has not locked down yet). So the host drives it, with
      `Machine::lock_down()`.
      What the worker would change is therefore its architecture, not its
      dependency on a missing primitive: it runs on a bare `Interp::new()`
      today, and `Machine::unfrozen_with_start_global_names`' doc comment
      already anticipates the move ("`packages/thixotrope` already runs that
      shape on a bare `Interp`; this offers it a `Machine`").
      **Two things are still missing, and an earlier revision of this item named
      only one.** It said "what is genuinely still missing is ATTENUATION, not
      isolation", which understated the distance to the shim.

      Attenuation is the first: a host-made compartment shares the start
      compartment's `Date` rather than getting the NaN an `fx_lockdown`
      compartment global would give, and `Math` is likewise unsecured. That is
      steps 3 and 4.

      **Corrected 2026-09-18 on two points, both of which change the
      sequencing.** This paragraph read "a host-made compartment's `Date.now()`
      answers from the real clock", and closed by calling steps 3 and 4 "a
      narrower gap than a guest `Compartment` constructor, and the one to close
      if guest source must not read a clock". Neither survives measurement.

      IronHorse's clock is already fixed: `Date.now()` returns `0.0`
      unconditionally (`interp/natives/date.rs:50`), and `Math.random` does not
      exist at all -- `create_math` (`interp/boot.rs:2512`) installs 34 methods
      and `random` is not among them. § Step 4 above and
      `native_lockdown.rs::the_post_lockdown_start_compartment_keeps_its_date_and_lacks_a_compartment`
      both already said so, and the oracle divergence they record is the same
      fact from the other side: `Date.now() > 0` is `true` on XS and `false`
      here. So step 4 is nearly empty as a port, and no guest reads a live
      clock today.

      What a confined guest is actually missing is a compartment global to
      attenuate INTO, which is step 3, which is `mxCompartmentGlobal`, which is
      the guest `Compartment`'s own template. Steps 3 and 4 are therefore not a
      smaller piece to land ahead of the next item; they are the same piece,
      and they belong in its design rather than before it.
      `designs/ironhorse-ses-compartment-equivalence.md` § The work #1295
      deferred, triaged carries this as G1.

      The second is that the worker calls the SHIM's
      `lockdown({errorTaming: 'safe', reporting: 'none', overrideTaming:
      'min'})`, and the native `lockdown()` has no analogue of any of the three.
      `overrideTaming` is not cosmetic: SES converts the frequently-overridden
      `Object.prototype` data properties into accessors so that assigning
      `o.toString = ...` on an INSTANCE still works once the prototype is
      frozen. Without it the assignment is a silent no-op in sloppy mode and a
      `TypeError` in strict. Measured after a native `lockdown()`:
      `protoToStringShape=data:w=false | ownAfterAssign=false |
      valueAfterAssign=[object Object] | defineStillWorks=mine`
      (`a_native_lockdown_does_not_enable_property_override`), and spliced under
      `endot-ih -l` the same probe classifies `shared-positive-test-failure`, so
      XS's `fx_lockdown` behaves identically — this is fidelity to the oracle,
      not a port defect.

      **Corrected 2026-09-18: override enablement is a compatibility
      preference here, not a requirement.** This paragraph read "override
      enablement is what arbitrary guest source needs in order to run at all",
      and concluded that a worker swapping the shim for the native `lockdown()`
      "would confine correctly and break ordinary guest code". That overstates
      it, because the override mistake is a `[[Set]]` problem only.

      A class body and an object literal both define their methods through
      `[[DefineOwnProperty]]` (`ClassDefinitionEvaluation` ->
      `MethodDefinitionEvaluation` -> `DefinePropertyOrThrow`), which never
      consults the prototype chain, and `Object.defineProperty` keeps working
      after lockdown -- the probe above measures `defineStillWorks=mine`. Only
      the ES5 ASSIGNMENT idiom is affected: `Foo.prototype.toString = ...`,
      `Child.prototype.constructor = Child`, `MyError.prototype.name = ...`.
      Class-syntax-first guest source, which is what `packages/thixotrope`'s
      orthogonal-persistence model produces, is structurally immune.

      SES's own list says the same thing. `minEnablements`
      (`packages/ses/src/enablements.js:60`) is six properties on four objects
      -- `%ObjectPrototype%.toString`, `%FunctionPrototype%.toString`,
      `%ErrorPrototype%.name` and `%IteratorPrototype%`'s `toString`,
      `constructor` and `@@toStringTag` -- and each entry's comment names the
      offender it exists for (`// set by "rollup"`; `// set by "precond",
      "ava", "node-fetch"`). It is a shim for transpiled and legacy dependency
      output, not a language-level need.

      Measured in this tree: assignment to `toString`, `name` or `constructor`
      on any prototype, across `packages/` and `rust/endo/xsnap/src/` and
      excluding `node_modules`, the test262 corpus and `dist/`, occurs in three
      places and none is guest-path code -- a comment in `enablements.js`,
      SES's own `property-override.test.js`, and
      `packages/hardened262/scripts/agents/ironhorse.js:27`, a harness adapter
      that rewrites an `Object.defineProperty` call INTO the assignment idiom.

      So the distinction for sequencing is narrower than this item claimed.
      Attenuation is what a CONFINED guest additionally needs. Override
      enablement is a compatibility probe to run before migrating a worker --
      cheap, because the surface is those six properties -- and its residual
      risk is a guest's bundled DEPENDENCY graph rather than its authored
      source. The one idiom that still catches otherwise-modern code is
      `MyError.prototype.name = 'MyError'` after `class MyError extends Error
      {}`, which has a definable alternative.

      **Consequence:** the native route's remaining cost for this worker is the
      compartment template alone, which folds into the guest `Compartment`
      below. It does not trail a second unscoped item behind it.
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
- [ ] **Widen the shared-corpus gates past hardened262 and stage4-harden.**
      The two gates that exist reuse sources, harnesses and committed baselines
      rather than restating assertions, which is the shape to keep.

      **Corrected 2026-09-18: the candidate this item named does not exist.**
      It said the obvious next one was "`packages/hardened262`'s 255
      `test/Object` integrity cases", which "is not a directory to point the
      gate at" because some of them require MUTABLE intrinsics. There is no
      `test/Object` directory in that package, and the 255 figure matches
      nothing in the tree: `packages/hardened262/test` is 123 files in ten
      directories -- 68 `Compartment`, 30 `intrinsics`, 12 `harden`, 7
      `modules`, and one each of `ArrayBuffer`, `TextDecoder`, `TextEncoder`,
      `freeze`, `ironhorse` and `lockdown`.

      What the gate actually leaves out is smaller and differently shaped:
      `native_lockdown_corpora.rs:130` excludes `test/Compartment/` and
      `test/modules/` -- 75 files -- and asserts each is already `false` in the
      committed IronHorse baseline, which is why it runs 47. So the residue is
      not a curation problem at all; it is blocked on a guest `Compartment`,
      the next item below. What this item still wants first is an inventory of
      what the two existing gates do not cover and why, not a directory to
      point at.
      `designs/ironhorse-ses-compartment-equivalence.md` § The work #1295
      deferred, triaged carries it as R1. The SES
      AVA suites are further still: they depend on SES options, override
      enablement and a guest `Compartment`, so they need a real adapter rather
      than source stripping. Deliberately not started here. The `-l` sweep
      below already executes every one of these files as part of the whole
      corpus; what a gate would add is curation, and the correction above is
      why that curation cannot be scoped yet.
- [ ] A guest `Compartment` (`fx_Compartment`, `xsModule.c:2864`) is the next
      piece, and the one that makes the parity corpus's lockdown case runnable
      natively. It needs its own definition.

      What that definition owes, beyond transliterating `fx_Compartment`, is
      scoped in `designs/ironhorse-ses-compartment-equivalence.md` § The work
      #1295 deferred, triaged (G1): there is no template object to snapshot
      because IronHorse builds each compartment's globals from `global_props`
      at `create_environment` (`interp/realm.rs:879`); two of
      `CompartmentOptions`' hooks are booleans rather than callables; relative
      specifiers are inexpressible because `ModuleGraph::resolve` takes no
      referrer and `Realm` has no parent; and a new intrinsic moves the boot
      fingerprint again, forcing the golden-fixture regeneration this work
      measured once already. Steps 3 and 4 fold into it rather than preceding
      it, per the correction two items above.

      What it unblocks, measured: the 75 `packages/hardened262` files the
      shared-corpus gate excludes, and 2 of the 8 cases on the
      `test262:ironhorse` engine lane -- not all 8; the other six need
      `frozenBytes`, `compareBytes`, `concatBytes`, `passStyleOf` and
      `environment`, which no engine has natively
      (`packages/test262-runner/README.md` § The engine lane's zero).

      Blocked on it in turn, and NOT on lockdown: moving
      `packages/thixotrope`'s IronHorse worker off the SES shim, two items
      above.
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
