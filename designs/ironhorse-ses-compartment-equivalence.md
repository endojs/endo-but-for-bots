# IronHorse: SES `Compartment` and `lockdown` equivalence

| | |
|---|---|
| **Created** | 2026-09-15 |
| **Updated** | 2026-09-15 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |
| **Source** | Measured while working Phase 4 of [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) |

## Status

Two things landed with this document.

`rust/engine/ironhorse-vm/src/interp/realm.rs` no longer pins any evaluator to
the default realm, closing a confinement hole a compartment could read and
write through
(`tests/realms.rs::every_reachable_evaluator_compiles_in_the_calling_compartment`).

`Machine::unfrozen_with_start_global_names` and `Machine::lock_down` separate the
intrinsic freeze from machine construction, which is what made the two ways of
getting a guest SES surface look mutually exclusive (§ What decides the
profile). `tests/ses_boot_intrinsics.rs` pins all three shapes.

And `CompartmentOptions::global_names` — renamed from `intrinsic_permit`,
whose "permit" read as SES's `permits.js`, the table
`removeUnpermittedIntrinsics` *deletes* against — now says in its name and its
doc comment what it actually does (§ Equivalence: `Compartment`).

Everything else here is a handoff: what the stage-4 SES gap actually is,
measured rather than assumed, and what a reader who was not present needs in
order to size it.

## What is the Problem Being Solved?

`designs/ironhorse-engine.md:37` records stage 4, Hardened JavaScript, as
"Partial — bar not met".
Its bar at `:940` has two clauses: "The endor daemon boot bundles
(`polyfills.js`, `ses_boot.js`, HandledPromise) run identically on both
engines; SES conformance suites pass."
The first clause is met for the boot bundles and has been for some time; the
second is `total=8 covered=6 divergent=0` (`rust/engine/CHANGELOG.md:906`).
The two it does not reach are exactly the two that need the guest
`Compartment`/`lockdown` globals, so the second clause is closer than the
ledger said: an earlier draft of this document quoted a stale "2 files,
covered=0".
Reading the first clause as the whole bar — which the phase that led here did —
hides the gap, and it also hid something better: most of the second clause's
machinery is already working in this tree, by a route the bar does not mention.

## Three configurations, not one

The tree contains three workers. They get Hardened JavaScript three different
ways, and only one of them is what the stage-4 bar describes.

| worker | engine | how it gets SES |
|---|---|---|
| endor daemon (`rust/endo`) | XS | **it does not** — nothing in its boot path calls `lockdown()` |
| `rust/thixotrope-xs-worker` | XS | XS's native `fx_lockdown`, installed by the embedder |
| `rust/thixotrope-ironhorse-worker` | IronHorse | the real `ses` shim, on an unfrozen realm |

**The endor daemon never locks down.**
`rust/endo/xsnap/src/ffi.rs:274-275` declares `fx_harden` and `fx_lockdown`;
nothing in `rust/endo` calls either, and `lib.rs:917` already recorded that.
Its realm runs on unrepaired intrinsics and `polyfills.js`'s deep-freeze
`harden`.

**`thixotrope-xs-worker` does.**
`main.rs:157-158` installs the engine's own `harden` and `lockdown` as globals,
and its generated boot script ends with `lockdown();`
(`packages/thixotrope/scripts/bundle-xs-worker.mjs:71-76`) so that "guest
compartments cannot communicate or interfere through" the intrinsics.
Its worker bundle then does `new Compartment()`
(`packages/thixotrope/src/worker-peer.js:52`).

**`thixotrope-ironhorse-worker` gets there without the engine's help.**
`packages/thixotrope/scripts/bundle-ironhorse-worker.mjs` bundles the real
`ses` shim, slices `polyfills.js` before its assert polyfill, deletes
`globalThis.harden` so the shim can install its own, neuters the
half-implemented `Iterator`, stubs `console`, and calls
`lockdown({ errorTaming: 'safe', reporting: 'none', overrideTaming: 'min' })`.
That is a working guest `lockdown` and a working guest `Compartment` on
IronHorse, in CI, today (`test-thixotrope-ironhorse`).

So the question this document was opened to ask — "does IronHorse need a native
`lockdown` and `Compartment`?" — already has a partial answer in the tree: for
the one IronHorse worker that needs them, no. The shim supplies them.

## What the measurements found

### The boot bundle is not the obstacle

`rust/engine/ironhorse-262/tests/stage4_ses_boot.rs` runs five cranks on one
machine through `dual_run_cranks`: a census, `polyfills.js`, a census,
`ses_boot.js` through `eval_wrapped`'s try/catch shape, a census.
Both engines evaluate the bundle to `'ok'`, and on both exactly one census
entry moves across it: `HandledPromise`, `undefined` to `function`.

`ses_boot.js` is not the SES shim.
It is `@endo/harden`, `@endo/env-options`, `@endo/eventual-send` and the
daemon's own boot file — 70 KB.
Its only `globalThis` write is `HandledPromise`; `@endo/harden`'s selector
reads `Object[Symbol.for('harden')]` first and `globalThis.harden` second, and
`polyfills.js` installs both, so it installs nothing.
The tree already said so, most directly at
`packages/daemon/src/bus-worker-xs-ses-boot.js:16-38`.

### The engine's own surface, and XS's

The pristine census, before any source runs:

| | `lockdown` | `harden` | `petrify` | `mutabilities` | `Compartment` |
|---|---|---|---|---|---|
| XS oracle | `function` | `function` | `function` | `function` | `function` |
| IronHorse | `undefined` | `function` | `function` | `undefined` | `undefined` |

Four of those five oracle entries are not what any XS *worker* necessarily has.
Only `Compartment` is a realm intrinsic, built by `fxBuildModule`
(`xsModule.c:207`) and installed as a global by `xsAPI.c:1519-1523`.
The other four are embedder-installed: `fxCreateMachine` binds none of them and
there is no id for them at all, so each host chooses.
`xst.c:428-429` installs `harden` and `lockdown`; `xstFuzz.c:491-498` and our
oracle shim (`xs-oracle/csrc/xs_shim.c:373-381`) install all four;
`thixotrope-xs-worker` installs `harden` and `lockdown`; the endor daemon
installs none.

Installing `lockdown` alone is not an option: `fx_lockdown` fetches the *guest*
`harden` off the global (`xsLockdown.c:141-143`) and calls it about fifty
times, so a host that installs one without the other has a `lockdown` that
faults.

Two traps for anyone re-measuring.
`harden` and `petrify` are present on IronHorse *before* `polyfills.js` runs —
they are its own `create_hardened_globals` bindings
(`ironhorse-vm/src/interp/boot.rs:2087`), not the polyfill's deep-freeze, and a
census taken after `polyfills.js` cannot tell them apart because
`polyfills.js:158` installs one when it finds none.
And `Object.isFrozen(Object.prototype)` is `false` on both engines throughout
that sequence: no lockdown runs anywhere in it.

### What decides the profile is *when* the freeze happens

This is the finding that matters most, and nothing in the tree said it.

`Interp::new()` leaves the intrinsics mutable.
The `ses` shim repairs them, installs `lockdown`, `harden` and `Compartment`,
and freezes them itself. Measured: the 576 KB
`packages/thixotrope/dist-ironhorse/boot.js` evaluates to `'ok'`, and
`new Compartment({ __options__: true, globals: { x: 5 } })` evaluates `x` to
`5` in its own globals without leaking them outward.

`Machine::new()` freezes the intrinsics at construction
(`new_shared_realm_machine_with_permit`, `interp/realm.rs`).
The shim's `repairIntrinsics` then cannot rewrite a descriptor it needs, and
the same bundle aborts with `invalid descriptor` — leaving the realm with
neither the engine's `harden` (the bundle deleted it) nor the shim's.

That made the two look mutually exclusive: the multi-compartment `Machine` API
came only with the construction-time freeze, and the shim came only with a
bare `Interp`.
**It was the timing, not the API.**
`Machine::unfrozen_with_start_global_names` builds the same shared realm and leaves
the graph mutable; the guest's own `lockdown()` then repairs and freezes it,
and the compartment API survives.
Measured: on such a machine the shim evaluates to `'ok'`, the census goes from
`lockdown=undefined … frozenObjectProto=false` to
`lockdown=function harden=function Compartment=function frozenObjectProto=true`,
a compartment created afterwards sees the graph the guest froze, and global
isolation between compartments still holds.
`Machine::lock_down` performs the same freeze from the host side for a caller
that wants it without a guest `lockdown()`.

The window this opens is real and is the caller's to close: until something
freezes the graph the primordials are shared and writable, so two compartments
of one machine can signal through them.
SES has the same window before its own `lockdown()` and the same rule about
it — lock down before admitting a second compartment.
`tests/ses_boot_intrinsics.rs` pins all three shapes: the shim on a bare
`Interp`, its refusal on a realm frozen first, and the unfrozen `Machine` that
takes it and keeps its compartments.

### What the `ses-xs-parity` axis actually runs

Worth stating plainly, because the axis's name and its `-l` flag both suggest
otherwise: **no host in it tests a native `lockdown`, and no host tests a pure
shim either.**

`test262:xs` passes `--prelude prelude/xs.js` and **no `-l`**.
`xst` installs native `harden` (`fx_harden`) and native `lockdown`
(`fx_lockdown`) as globals at realm setup (`xst.c:428-429`), and the prelude
then imports `ses/lockdown-shim.js`, which overwrites `globalThis.lockdown`
with the shim's.
`harden` is left native.
So the XS lane is a hybrid: **native `harden`, shim `lockdown`**.
The node lane is the same shape minus the native half — no `globalThis.harden`
at all.
Only the Ironhorse lane asks for a native `lockdown`, via `endot-ih -l`
(`xst262.c:1269`'s analogue), and Ironhorse does not have one, so every case
pre-skips.
Three hosts, three different configurations, none of them either of the two
coherent ones.

The hybrid is not incidental, and it is why XS can run lockdown cases at all.
`make-selector.js` resolves harden in order: `Object[Symbol.for('harden')]`,
then `globalThis.harden`, and only failing both does it install its own —
non-configurable, with a comment saying that doing so "will prevent any
HardenedJS's lockdown from succeeding".
On XS the second step finds `fx_harden` and nothing is installed, so
`repairIntrinsics` runs.
On node nothing is found, the slot is installed, and every `lockdown()`-calling
case fails (below).
Ironhorse's own native `harden` puts it in XS's position, which is why the
Ironhorse prelude leaves it alone — deliberately matching XS rather than
picking a third configuration.

That makes the Ironhorse lane comparable to XS today, which is what the axis is
for.
It does not answer which configuration the axis *should* pin, and the two
coherent answers want different work: a pure-shim lane needs the selector to
find the shim's harden rather than a host one, and a native lane needs
`fx_lockdown`'s five steps implemented before it can be run at all.

### How far the shim profile reaches the parity corpus

`packages/test262-runner` runs the `ses-xs-parity` subset against three hosts.
XS and node evaluate a generated SES prelude; the Ironhorse host drives
`endot-ih -l`, which expects an ENGINE-side `lockdown()` and therefore
pre-skips every SES-mode case (`xst.rs`, `SesMode::unimplemented_skip` — note
that `SesMode::prelude()` is never applied on the live path at all).

There is now a third prelude, `src/ironhorse-prelude.js`, and measuring it
gives the first real number for the shim route: **7 of the 8 cases pass**
(`ironhorse-vm/tests/ses_prelude_reach.rs`), up from 3 when the prelude first
ran, against `covered=6` for the engine route, which skips the two that need
the guest surface.
The overlap is not the interesting part; the failures are.

| case | node | Ironhorse via the shim prelude |
|---|---|---|
| `Compartment/prototype/Symbol.toStringTag.js` | pass | **pass** |
| `Compartment/prototype/Symbol.toStringTag-lockdown.js` | **fail** | fail |
| `pass-style-bytes/byte-readers.js` | pass | **pass** |
| `pass-style-bytes/native-or-emulated-shape.js` | pass | **pass** |
| `pass-style-bytes/byte-array-brand.js` | pass | **pass** |
| `view-behavior-matrix/ses-hosts.js` | pass | **pass** |
| `TextEncoder`/`TextDecoder` intersection | pass | **pass** |

`Symbol.toStringTag-lockdown.js` **fails on node too** — the node host reports
14/16 today, both failures on that file.
`@endo/harden` installs `Object[Symbol.for('harden')]` during prelude
evaluation and `repairIntrinsics` then refuses
(`packages/ses/src/lockdown.js:393`).
So one of the two cases the engine route name-skips is one no host currently
passes, and it is not an Ironhorse gap.

Two things the prelude had to get right, both of which are the
`worker-rust-xs.md:515-520` dependency in miniature:

- **Do not delete Ironhorse's native `harden`.** `@endo/harden`'s selector
  takes `Object[Symbol.for('harden')]` first and `globalThis.harden` second,
  installing its own only if neither exists — and an installed
  `Object[@harden]` is exactly what makes `repairIntrinsics` refuse. XS relies
  on the same adoption. `bundle-ironhorse-worker.mjs` does delete it, because
  there `polyfills.js` has already replaced it with a deep-freeze shim.
- **Take only `polyfills.js`'s codec section.** Ironhorse has no host
  `TextEncoder`/`TextDecoder` (node's prelude takes them from `node:util`), but
  the `assert` section collides with test262's `assert` and the `harden`
  section installs `Object[@harden]`. The file's own section markers make the
  slice exact, as `bundle-ironhorse-worker.mjs` already does it.

### Running the real harness, and what it found immediately

The axis's other two hosts are driven by `test262-harness`: it assembles the
case, writes it to a file, runs the host binary on it, and reads an uncaught
throw off stderr.
Ironhorse had no such binary — only `endot-ih`, which is a DIFFERENTIAL runner
answering "does ironhorse agree with XS".
Every verdict it reaches is a function of that agreement, so it cannot award
coverage without the oracle's assent, and feeding XS an ironhorse-shaped
prelude (which a dual-run must) makes XS fail cases it passes under its own.

`ironhorse-xst` is that binary, and it is deliberately tiny: `--host-type xs`
is `eshost`'s "a binary that takes JS files and runs them" adapter, so being
one is most of the work.
The corpus is test262; its own `Test262Error` assertions already encode pass
and fail, and no second engine is needed to read them.

It found a parser bug on the first run, before a single assertion was reached:
**all 16 runs failed with `SyntaxError: invalid directive`.**

`eshost`'s own preamble — prepended to every case it runs — opens with
`ESHostError.thrower = (...args) => {...}`.
Ironhorse's non-simple-parameter-list flag lives on the shared parser flags,
and an arrow's parameters are parsed by the CALLER before `arrow_expression`
snapshots them, so the flag leaked in both directions:

- **Outward.** `var f = (...args) => 1;` poisoned every later `"use strict"`
  in the program, which is why one line of eshost's preamble failed the entire
  corpus.
- **Inward.** `function outer(...rest) { var g = a => { "use strict"; }; }`
  was rejected, though the early error is on ArrowParameters and those are
  simple.

Node accepts both; ironhorse rejected both.
A declared function parses its parameters inside its own save/restore, which is
why only arrows leaked.
Fixed at both arrow call sites, with the differential against node recorded in
`ironhorse-compile`'s parser tests.
The corpus went from **0/16 to 6/16** on that fix alone.

That is the argument for the lane in one paragraph: the differential runner had
been reporting this corpus as an honest set of named skips, exiting 0, for as
long as the corpus has existed — and underneath it was a parser bug that broke
every case in the suite.

### The 8 that failed at 6/16, and the engine bugs behind them

Two findings came out of the 6/16, and both are now fixed. The first took the
corpus to **8/16**; the second was a host-boundary rendering fault that cost no
case a pass but made every failure unreadable, which is its own kind of
expensive. Each is kept here with the reasoning that first got it wrong,
because in both cases the original entry recorded an INFERENCE in the voice of
a measurement, and that is the failure mode this document is most prone to.

**A `return` out of a `switch` abandoned the discriminant on the value stack.**
FIXED. This was originally recorded here as "`passStyleOf`'s first call in
argument position throws `call: not a function`", once per function, with a
bare warm-up call as a complete workaround. Every part of that was a symptom
read as the disease, so the measurements are worth restating:

| shape | before the fix |
| --- | --- |
| `passStyleOf(x)` as a statement | passes |
| `"MARK" + passStyleOf(x)` | **`"objectbyteArray"`** — silently wrong |
| `sink(passStyleOf(x), "Z")` | **throws `call: not a function`** |
| `[passStyleOf(x)]` | **throws `cannot coerce undefined to object`** |
| the same call with a FRESH argument each time | **fails every time** |

It was never once per function. `passStyleOf` memoizes in a `WeakMap` keyed on
the argument, so a second call with the SAME object short-circuits before
reaching the faulty path — which looks like warming up the function and is
actually warming up that one object. A fresh object failed every time, and a
primitive, which is never memoized, failed on every single call.

Nor was it really about argument position, or about `passStyleOf`. The value
that displaced the caller's operand was the last `typeof` computed inside the
walk — `passStyleOf("s")` clobbered with `"string"`, `passStyleOf(42)` with
`"number"`, `passStyleOf(harden({a: 1}))` with `"number"` from the inner `1`.
Argument position only decided WHICH slot got destroyed, and so which of three
unrelated-looking errors came out: a wrong string, a bad callee, or a bad
array element. A statement-position call had no pending operand to lose, which
is the only reason it looked clean.

The cause is two correct-looking halves. `code_switch` keeps the discriminant
live on the stack across every case test and pops it only after the break
target, so `break` reaches that pop and `return` jumps over it; XS's
`fxSwitchNodeCode` emits exactly the same shape. XS is correct anyway because
`XS_CODE_END` resets the stack to the frame base before writing the result
(`mxStack = mxFrameEnd`, xsRun.c:1063). Ironhorse's port restored the caller's
activation in `leave_call` but never its stack, so the abandoned slot landed
wherever the caller's expression had been building.

`leave_call_to_frame_base` restores it on the `END` family, which is where XS
does it. The `START_*` opcodes are deliberately excluded: they hand a
generator or promise back at function entry, before a body has run. Pinned in
`ironhorse-vm/tests/switch_return_frame_base.rs`, which fails on the parent
commit.

This was reachable from any guest code with a `switch` whose cases `return` —
`@endo/pass-style` is simply where the corpus happened to run one — and it
produced silent wrong values, not only exceptions. It is the kind of bug the
differential runner exists to catch and had never reported, because it could
not start.

**A thrown object with a prototype `toString` renders as
`[object Object]`.**
FIXED.
Inside the engine `String(e)`, `e.toString()` and `"" + e` all produce
`Test262Error: <message>` correctly.
Only the HOST boundary lost it: `render_uncaught` goes through the read-only
`render`, which by contract "must not turn the throw into a halt" and so
cannot call guest code.
test262's `Test262Error` is exactly that shape (`sta.js` puts `toString` on
the prototype), so every assertion failure reached a host as
`[object Object]` — which also defeated `eshost`'s `parseError`, whose regex
needs `Name: message`.

This section previously concluded that fixing it "needs a guest-semantics
coercion the VM does not currently expose to hosts", by analogy with XS, which
calls the guest `toString` from its own catch.
That was the wrong read of what the boundary owes.
The message does not need coercing — it needs READING, and `render`'s error
branch already reads a live `name`/`message` through `render_error_property`,
which walks the prototype chain for DATA properties only: no accessor invoked,
no proxy entered, no coercion, and so no resumption of the guest.
Objects that are not engine `Error`s simply never reached that branch and fell
through to `Object.prototype.toString`.

`render_uncaught` now pairs that message with the tag the render already
produced — `Object: Expected SameValue(...)` rather than `[object Object]`,
which is also the `Name: message` shape `eshost` wants.
The tag rather than the constructor's `name`: `toString` is guest code this
still cannot call, and a function's `name` is not reliably a plain slot to
read, so pairing with the tag claims no more than the `[object ...]` it
replaces.
Only that `[object ...]` case changes; a `message` behind an accessor or proxy
still reports its placeholder rather than being coerced.
`uncaught_native_error_rendering` pins both directions.

`endot-ih` shared the limitation and shares the fix, since both hosts render
through the same boundary.

Neither was a SES or prelude problem; both bit any host embedding
ironhorse.

### Why SES's own suite is not the gate yet

`packages/ses/test/` is 105 ava files, 15 of them directly on
lockdown/Compartment/harden semantics.
They are ESM and import `ava`, so they cannot run inside Ironhorse; the
portable route is the `ses-xs-parity` corpus, which `test262-runner`'s README
already describes as holding "additional Hardened JavaScript tests" and which
the `Compartment/prototype` pair is an instance of.
Porting from SES's suite into that corpus is the right shape, and it would
serve a native `lockdown` exactly as well as the shim.

It is blocked on something upstream of Ironhorse.
**Every `lockdown()`-calling case fails on the node host today.**
The preludes import `./expose-pass-style-bytes-globals.js`, which pulls
`@endo/pass-style` and so `@endo/harden`; where the host has no native
`harden` for its selector to adopt, `@endo/harden` installs its own at
`Object[Symbol.for('harden')]`, and `repairIntrinsics` refuses to run at all
when it finds one (`packages/ses/src/lockdown.js:393`).
The corpus's one such case, `Symbol.toStringTag-lockdown.js`, is red on node
for that reason — the host reports 14/16 — and three cases ported from
`lockdown.test.js` and `harden.test.js` failed identically when tried.

Clearing the slot in the prelude, the way it already clears and restores
`assert`, does **not** work, and the reason is simpler than it first looked.
`make-selector.js` installs it `configurable: false, writable: false` —
deliberately, its comment says, because "the non-configurability of this
property will prevent any HardenedJS's lockdown from succeeding" — so in a
module, which is always strict, `delete Object[Symbol.for('harden')]` throws
a `TypeError` and takes the whole prelude with it.
That is why cases which had been passing started failing when it was tried.
(An earlier draft of this section blamed `@endo/pass-style` having already
captured the harden; that was inferred, not measured, and it is wrong —
the delete never gets as far as any captured reference.)
`delete globalThis.harden` is a different operation and does work, which is
why `bundle-ironhorse-worker.mjs` can do it.
XS is unaffected only because `xst` installs a native `harden` the selector
adopts instead — the same reason the Ironhorse prelude must leave Ironhorse's
native one alone.

And nothing would have caught it — though not because the axis fails to gate
CI, which it is not meant to do.
The axis is a **ratchet**: a compatibility measurement whose pass count should
go up and never down, read for its direction rather than as pass/fail
(`packages/test262-runner/README.md`, "Ratchet, not a gate").
A ratchet still has to record a number, and this one recorded none.
`packages/test262-runner`'s `"test"` script is `exit 0`, nothing captured a
per-lane count anywhere, and so a red case sat in the corpus unnoticed —
invisible for want of a baseline, not for want of a gate.

## What XS implements

Everything SES-shaped in XS lives in two files.

| | |
|---|---|
| `xs/sources/xsLockdown.c` | `fx_lockdown`, `fx_harden`, `fx_petrify`, `fx_mutabilities` and the `fxVerify*` audit family (974 lines) |
| `xs/sources/xsModule.c:2864` | `fx_Compartment`, plus `get globalThis`, `evaluate`, `import`, `importNow` on its prototype (`:200-203`) |

### `fx_lockdown`, in order

Reading `xsLockdown.c:74-205` as a specification of what a native IronHorse
`lockdown` would have to do:

1. **Idempotence.** `XS_DONT_MARSHALL_FLAG` on `mxProgram`; a second call is a
   `TypeError("lockdown already called")` (`:90-92`).
2. **Poison the function-family constructors.** `fx_lockdown_aux` (`:52`)
   replaces a prototype's `.constructor` with a duplicate of
   `%ThrowTypeError%` carrying `XS_CAN_CONSTRUCT_FLAG` and a `prototype`
   property. It is called six times: on `AsyncFunction.prototype`,
   `AsyncGeneratorFunction.prototype`, `Function.prototype`,
   `GeneratorFunction.prototype` and `Compartment.prototype` (`:94-103`), and
   on `Date.prototype` (`:127`). These are the **shared realm's** prototypes,
   so after lockdown `(function(){}).constructor` and
   `Date.prototype.constructor` throw for the host too; the compartment's own
   `Function`, `eval` and `Compartment` are fresh instances `fx_Compartment`
   mints.
3. **Snapshot a compartment-global template.** `fxNewArray(the, _Compartment)`
   (`:105`), filled from the intrinsics up to but not including `_Compartment`
   (`:113-119`) and stored as `mxCompartmentGlobal` (`:139`). The excluded
   tail — `Compartment`, `Function`, `[ModuleStuff]`, `eval`
   (`xsCommon.h:857-866`) — is exactly what each compartment gets fresh.
4. **Tame `Math` into the template only.** `:130-137` duplicates
   `mxMathObject`, patches `random`/`irandom` on the duplicate, and pulls it
   into the template, so the host global keeps the real one. `Date` is
   *half* this: its constructor is duplicated and secured into the template
   the same way (`:121-125`, `:128`), but step 2's sixth call also poisons the
   shared `Date.prototype.constructor`. This is the one place XS implements
   ocap attenuation rather than integrity.
5. **Harden.** The guest `harden` is called over every intrinsic, the hidden
   prototypes, the internal helpers and accessors,
   `Array.prototype[Symbol.unscopables]`, the compartment template, `harden`
   itself and `Function` (`:141-200`).

Against `Interp::new_shared_realm_machine_with_permit`, which links intrinsics,
`do_harden`s every arena instance except the global and the template cache,
then sets `locked_down: true` and `shared_compartments = true`:

| `fx_lockdown` step | IronHorse | Note |
|---|---|---|
| idempotence throw | — | it is a constructor, so the question does not arise |
| constructors poisoned | — | frozen in place and still reachable |
| per-compartment evaluators | partial | `compartment_evaluator` (`realm.rs:72`) copies `Eval` and `Function`; the other three are non-global and get none. Fixed here by leaving them unpinned rather than by copying |
| compartment-global template | — | globals are built per compartment from `global_props` |
| Math (and half of Date) tamed | — | nothing in `ironhorse-vm` tames either |
| transitive harden | **yes, wider** | XS hardens an enumerated list; IronHorse hardens every instance in the arena |

Step 5 is done and then some.
Steps 1–4 are absent, and step 2 cannot be done at machine construction: it is
correct only *after* a guest asks for it, which is what IronHorse has no
equivalent of.

### `fx_harden` and `fx_petrify`

Both are already transliterated, faithfully.
`Interp::do_harden` (`interp/property/integrity.rs:17`) is `fx_harden` plus
`fx_hardenQueue` plus `fx_hardenFreezeAndTraverse`, including the detail that
matters: XS clears the visited bit from every queued instance when a proxy trap
or a property definition throws mid-walk (`xsLockdown.c:394-399`), so a later
`harden` retries rather than short-circuiting a half-frozen graph.
IronHorse does the same (`integrity.rs:33-42`).
`do_petrify` (`:155`) is `fx_petrify`.

XS's `harden(x, "petrify")` second argument and its "call lockdown before
harden" guard are both present-but-commented-out (`xsLockdown.c:347-348`,
`:358-366`): XS deliberately does not require lockdown before harden.

### `fx_mutabilities`

The one piece with no IronHorse counterpart and no SES counterpart either.
`fx_mutabilities(x)` (`xsLockdown.c:486`) walks from `x` and returns a sorted
array of every path still mutable, via `fxVerifyInstance` / `fxVerifyProperty`
/ `fxVerifyCode` — including a **bytecode** scan (`:562`) that finds mutable
references reachable from compiled function bodies, which no JavaScript-level
audit can see.
It is XS's answer to "did lockdown actually cover everything".
`create_hardened_globals` names it a deliberate decline (`boot.rs:2080-2086`):
a program referencing it gets `Halt::NotImplemented`.

### `fx_Compartment`

`fx_Compartment` (`xsModule.c:2864`) allocates a program instance, then a fresh
global object populated by copying intrinsic *references* — from the
`mxCompartmentGlobal` template when lockdown has run, from the live intrinsics
otherwise (`:2903-2921`).
`_Infinity`, `_NaN` and `_undefined` are installed `XS_GET_ONLY` and everything
before them `XS_DONT_ENUM_FLAG`.
It mints `Compartment`, `Function` and `eval` fresh, bound to the new program
(`:2923-2956`, plus `ModuleStuff` where `mxModuleStuff` is enabled), and after
lockdown stamps each `XS_DONT_PATCH_FLAG` with every own property non-writable
and non-deletable (`fxPrepareCompartmentFunction:2849`).
Finally it builds a `Realm` (`:3131`) and adopts the module map's unclaimed
modules into it (`:3134-3142`).

The compartment's globals are *properties of a fresh global object holding
references to the one shared frozen graph*, not copies — the same architecture
PR #1263 gave IronHorse.

## Equivalence: `Compartment`

SES's constructor options (`packages/ses/src/compartment.js:353-366`), XS's
(the keys `fx_Compartment` reads), and IronHorse's `CompartmentOptions`
(`ironhorse-vm/src/compartment.rs:265-288`):

| SES option | XS | IronHorse | Assessment |
|---|---|---|---|
| `name` | — | `name: Option<String>` | IronHorse matches SES; XS has no name at all |
| `globals` | `globals` (`:2978`) | `endowments`, `endowments_by_id` | all three present; the `_by_id` map is a compiler-era workaround |
| `modules` | `modules` (`:2997`) | `modules: ModuleGraph` | present in shape on all three; IronHorse's semantics unverified |
| `resolveHook` | callable-checked (`:3066`) | `has_resolve_hook: bool` | **shape only** on IronHorse — a boolean, not a callable |
| `importHook` | `:3078`, falling back to `loadHook` | `has_import_hook: bool` | **shape only**, same |
| `importNowHook` | `:3097`, falling back to `loadNowHook` | — | absent |
| `moduleMapHook` | read as `undefined` (`:3075`) | — | XS declines it explicitly |
| `importMetaHook` | read as `undefined` (`:3115`) | — | XS declines it explicitly |
| `transforms`, `__shimTransforms__` | — | — | shim-only |
| `__noNamespaceBox__`, `noAggregateLoadErrors` | — | — | shim-only |
| — | `globalLexicals` (`:3030`) | — | XS-only; per-name writability from the descriptor |
| — | — | `global_names` | IronHorse-only; see below |

The hooks are the load-bearing row.
`has_resolve_hook` exists so a constructor-shape probe can observe it; it does
not resolve anything.
A guest `Compartment` bound over this would answer `typeof` and
constructor-shape questions and fail the first program that imports a module.
XS is the useful reference precisely because it is honest about the same
boundary: it callable-checks the hooks it honours and pushes `undefined` for
the two it does not.

`global_names` is IronHorse's own, and measuring it is worse than its old
doc comment admitted.
It controls which names are bound as globals and nothing else.
Under `global_names: Some(vec![])` — documented as "only globalThis and
explicit endowments" — a guest still reads `({}).constructor.name` as
`"Object"` and `({}).constructor.constructor.name` as `"Function"`, and
evaluates `({}).constructor.constructor('return 1 + 1')()` to `2`.
The dynamic evaluator is reachable off any object literal.
There is a second route the field's old doc comment did name and this one
should keep: `Compartment::define_global_value` shares a `RootedValue` by
reference on purpose (`compartment.rs:414`), so anything reachable from an
endowed object is reachable whatever the list says — only raw heap-backed
`Slot` endowments are refused.

And a third, found while renaming the field and now pinned by
`tests/realms.rs`: **`global_names` is per-environment, and environments do
not inherit.**
`Machine::with_start_global_names` configures the start realm, but a
compartment does not run in that realm — `Compartment::evaluate` calls
`create_environment`, which assigns `realm.global_names` outright.
So on a machine declaring `Some(["Object"])`, a compartment declaring `None`
reads `typeof Math` as `"object"` and `typeof eval` as `"function"`: fully
unrestricted.
Nor is the machine's list a ceiling the compartment narrows from — a
compartment may name something the machine omitted.
A machine-wide list looks like a boundary around everything on that machine
and is not one, which is the same point as the two routes above, reached from
a different direction.
No route here is SES's attenuation model or XS's: both close the first by
replacing the function-family prototypes' `.constructor` with a throwing stub
during `lockdown()`, which is `fx_lockdown` step 2 and the one step IronHorse
cannot take while it freezes at construction rather than on request.
The doc comment now says so, and the field has since been renamed from
`intrinsic_permit` to `global_names`, whose old "permit" read as SES's
`permits.js` — the table `removeUnpermittedIntrinsics` deletes against,
which is the opposite of what this does.
What remains is left to whoever owns the
API.

### Module resolution: the arity is wrong, not just the type

The `resolveHook` row above says "shape only" because `has_resolve_hook` is a
boolean.
The resolver underneath it is a second, independent gap.

| | resolution |
|---|---|
| SES | `resolveHook(importSpecifier, referrerSpecifier)` — referrer-relative |
| XS | the same two arguments (`xsModule.c:2178-2185`, `mxRunCount(2)`), reached after walking the realm parent chain for an inherited hook (`:2160-2169`), with the referrer-aware `fxFindModule` as the no-hook fallback |
| IronHorse | `ModuleGraph::resolve(&self, specifier: &str)` (`module.rs:283`) — one argument, over a flat `BTreeMap<String, ModuleId>` |

`ImportEntry` carries only `module_request` (`module.rs:106-113`), and all six
resolution sites pass it alone (`:342`, `:358`, `:401`, `:461`, `:582`,
`:656`).
There is no referrer anywhere in the graph, so **a relative specifier cannot be
expressed at all**: two modules in one compartment that both import
`'./helper.js'` necessarily get the same module.
IronHorse's module map is a pre-resolved bundle keyed by absolute specifier,
not a SES module map.

`CompartmentOptions`'s own doc says as much — "The static resolve hook is the
map's own specifier→id resolution" — but the consequence is bigger than a
missing callable.
Turning `has_resolve_hook: bool` into a real hook means threading a referrer
through `ImportEntry` and every resolution site first.
And `Realm` (`interp/realm.rs:6-9`) holds only `intrinsics` and
`default_global`, with no parent, so XS's inherited-hook walk has no IronHorse
counterpart either.

Note that SES's own constructor takes a single object argument as the *legacy*
`(globals, modules, options)` positional form unless it carries the
`__options__: true` sigil (`compartment.js:294-316`) — an easy way to measure
an endowment as "not landing" when it landed under a different name.

## Equivalence: `lockdown`

XS's `fx_lockdown` is not SES's `lockdown()` either, and the difference is
large enough that "match XS" and "run the shim" are different projects.

`packages/ses/src/lockdown.js` calls, in sequence: `tameDomains`,
`tameNaNSideChannel`, `tameLocaleMethods`, `tameFauxDataProperties`,
`removeUnpermittedIntrinsics`, `enablePropertyOverrides`,
`tameRegeneratorRuntime`, and a tamed `harden` (`:345`, `:363`, `:454`, `:456`,
`:469`, `:550`, `:558`, `:583`) — over a permits table and per-intrinsic taming
modules for Date, Math, RegExp, Symbol, Temporal, URL, Error, the function
constructors, `Function.prototype.toString` and module source.
Its options (`:183-251`) are `errorTaming`, `errorTrapping`, `reporting`,
`unhandledRejectionTrapping`, `localeTaming`, `consoleTaming`, `overrideTaming`,
`overrideDebug`, `stackFiltering`, `domainTaming`, `evalTaming`, `regExpTaming`,
`urlBlobTaming`, `legacyRegeneratorRuntimeTaming` and `__hardenTaming__`, plus
deprecated `dateTaming`/`mathTaming`.
Two of those drive rows in the table below: `overrideTaming` is
property-override enablement and `evalTaming` decides what happens to the
evaluators.
XS takes none.

| | SES shim | XS native | IronHorse |
|---|---|---|---|
| transitive freeze of intrinsics | yes | yes | **yes** |
| function-family constructors poisoned | yes | yes | no — which is why `global_names` cannot confine |
| Date/Math attenuated for compartments | yes | partly (Date's prototype is poisoned realm-wide) | no |
| permits table / unpermitted removal | yes | no | no |
| property-override enablement | yes (`overrideTaming`) | no | no |
| locale, NaN side channel, domains, regenerator | yes | no | no |
| error taming and trapping options | yes | no | no |
| mutable-residue audit | no | **yes** (`mutabilities`) | no |

XS's is the smaller, sharper artifact: five steps, no permits table, and an
audit the shim does not have.
The shim is the larger one — and it is the one already running on IronHorse.

## What a next step should establish first

1. **Decide which profile the daemon's Ironhorse worker takes.**
   This is no longer either/or: with the freeze deferred, the shim profile
   keeps the `Machine`/`Compartment` Rust API, so the choice is about which
   `lockdown` the daemon wants rather than about which API it can have.
   The shim profile is proven in-tree by `thixotrope-ironhorse-worker`, is
   what `packages/ses` specifies, and costs the four boot-script workarounds
   in step 2.
   The native profile would match XS instead, and needs `fx_lockdown`'s steps
   1–4, which the engine does not have.
   Remaining cost difference: the shim is ~576 KB of guest code evaluated at
   every boot.
2. **If the shim profile wins, the work is not in `ironhorse-vm` at all.**
   It is making the daemon's boot do what
   `bundle-ironhorse-worker.mjs` already does — and the obstacles that script
   works around are the real backlog: `polyfills.js` installs
   `Object[Symbol.for('harden')]` non-configurable
   (`designs/worker-rust-xs.md:515-520`), which the shim's own selector notes
   "will prevent any HardenedJS's lockdown from succeeding"; lockdown replaces
   `globalThis`, dropping the `host<Name>` aliases both bootstraps resolve
   through (`:521-525`); `Iterator` is advertised before its helpers exist (see
   below); and there is no host `console`.

   The `Iterator` one is an engine defect rather than a boot-script detail, and
   it is worse than the workaround's comment suggests. All eleven helpers are
   present on `Iterator.prototype` (`boot.rs:540-558`) and every one answers
   `typeof` as `"function"`, but the five lazy ones — `map`, `filter`, `take`,
   `drop`, `flatMap` — halt the machine with
   `NotImplemented("Iterator.helper")` when called.
   That is an engine halt, not a `TypeError`: `try`/`catch` does not recover,
   and the crank does not complete. The eager helpers (`reduce`,
   `toArray`, `forEach`, `some`, `every`, `find`) and `Iterator.from` work. So
   any guest that feature-detects `typeof Iterator.prototype.map === 'function'`
   and then calls it kills the worker, which is why
   `bundle-ironhorse-worker.mjs` deletes the whole surface by hand.
   Un-advertising them in the engine is not a free fix: `Iterator.helper` is a
   ledgered named skip with 326 `skip:unsupported-opcode` rows across fourteen
   files in `ironhorse-262/expectations/whole-tree`, and removing the bindings
   would convert those into ordinary conformance failures. Implementing the
   lazy helpers is the honest fix, and it is its own piece of work.
3. **If the native profile wins**, `fx_lockdown`'s five steps above are the
   specification, and step 2 needs a guest-callable `lockdown()` separate from
   machine construction before it can be attempted at all.
4. **Do not treat `CompartmentOptions` as SES-compatible** without walking the
   table above. Two of its hook fields are booleans.
5. ~~**Re-word the `ironhorse-engine.md:940` bar.**~~ Done: its first clause is
   marked met and its deliverable column now says the native route is a choice
   rather than the plan, since the shim route reaches the same guest surface.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) | Phase 4 is where this gap sits; that document carries the boot-bundle measurement and points here for the equivalence detail. |
| [ironhorse-engine](ironhorse-engine.md) | Owns stage 4 (`:37`) and its acceptance wording (`:940`). Its `:201` note that XS implements SES natively is true of the implementation and misleading about the bindings — see § What XS implements. |
| [worker-rust-xs](worker-rust-xs.md) | § Known Gaps (`:501-531`) carries the three-part dependency between `polyfills.js`, the `host<Name>` aliases and any real lockdown, which § next step 2 turns into a work list. |
| [thixotrope](thixotrope.md) | Owns both workers whose configurations this document reads as evidence. |
| [ironhorse-w6-decisions](ironhorse-w6-decisions.md) | §1 is the Realm decision whose extraction (PR #1263) built the compartment machinery this document inventories. |

## Known Gaps and TODOs

- [ ] Answer question 1 above — which realm profile — before anything else.
      It is the only question whose answer can make the rest unnecessary.
- [ ] No CI lane runs `ses_boot_intrinsics.rs`'s two profile tests.
      `test-thixotrope-ironhorse` has the bundle but builds through the root
      workspace, which excludes `rust/engine`, so running an engine-workspace
      test there compiles the engine a second time.
      They skip on a bare checkout; `IRONHORSE_SES_SHIM_REQUIRED` makes a lane
      that claims to have built the bundle fail instead.
- [x] Verify `ModuleGraph` against SES and XS module-map semantics.
      Done 2026-09-15: the resolver takes no referrer, so relative specifiers
      are inexpressible and the map is a pre-resolved bundle
      (§ Module resolution). Threading a referrer is a prerequisite for any
      real `resolveHook`.
- [x] Establish whether `global_names` can be made to mean SES attenuation.
      (The rename it suggests is still open — see below.)
      Measured 2026-09-15: it cannot, as things stand — every denied intrinsic
      including `Function` stays reachable through a prototype chain, and
      closing that is `fx_lockdown` step 2, which needs a `lockdown()` separate
      from machine construction. The doc comment now states this; the rename is
      left to whoever owns the API.
- [x] `stage4_ses_boot.rs` runs in `test-ironhorse-oracle`, which
      `scripts/ci-changes.py` triggered on `rust/engine/**`, the Cargo and
      toolchain files, `c/moddable`, `rust/endo/xsnap/xsnap-platform.*` and the
      test262 corpus — but not on the bar's own inputs. Fixed 2026-09-15:
      `polyfills.js`, `host_aliases.js`, `bus-worker-xs-ses-boot.js` and its
      bundler now trigger the lane.
      Residual, deliberately not closed: `bus-worker-xs-ses-boot.js` is a
      comment header and one `import '@endo/eventual-send/shim.js'`, so the
      bundle's actual content comes from `@endo/eventual-send`,
      `@endo/harden`, `@endo/env-options` and `@endo/compartment-mapper`, none
      of which trigger this Rust lane. A regression there does redden
      `build-xsnap`, which regenerates the bundle and runs the daemon's own
      tests; what it would not do is re-run the dual-run measurement. Widening
      a Rust lane's triggers across the JS workspace is the wrong trade for
      that.
- [ ] Implement the lazy `Iterator` helpers, or decide the engine should not
      advertise them. Today `typeof Iterator.prototype.map` is `"function"` and
      calling it is an uncatchable halt (§ next step 2).
- [ ] Resolve the prelude's `@endo/harden` interaction so `lockdown()`-calling
      cases can run on the node host, then port SES's own lockdown/Compartment
      assertions into the `ses-xs-parity` corpus (§ Why SES's own suite is not
      the gate yet). Clearing `Object[Symbol.for('harden')]` in the prelude is
      measured NOT to work.
- [ ] Record the `ses-xs-parity` ratchet somewhere a regression is visible.
      The axis is deliberately not a CI gate and does not need to fail a build;
      what it needs is a captured per-lane count to ratchet against. Today
      `packages/test262-runner`'s `"test"` is `exit 0` and the only counts
      recorded anywhere are the prose baselines in that package's README
      (node 14/16, `ironhorse-host` 6/16), which nothing checks.
- [x] Wire the Ironhorse prelude into `endot-ih` — landed as a `--prelude`
      flag, with `effective_skip_features` dropping `lockdown`/`Compartment`
      when one is supplied. `SesMode::unimplemented_skip` deliberately still
      returns `Some` for `-l`: a prelude is the SHIM route and does not make
      the NATIVE one work, so `-l` keeps failing closed and
      `SesMode::prelude()` stays unreachable on the live path. The lane that
      actually moved is `test262:ironhorse-host`, which skips `endot-ih`'s
      differential entirely.
- [ ] The bar does not run `bootstrap_ses`'s closing `run_promise_jobs()`, so
      it cannot see a divergence in how the two engines settle what
      `@endo/eventual-send`'s shim leaves pending.

## Prompt

> record or frame the follow up SES / Compartment / lockdown equivalence in a
> work document as a handoff
>
> you can look at what XS implements for reference into what we're trying to
> provide with SES natively with IronHorse
>
> implement IronHorse updates in accordance with
> designs/ironhorse-ses-compartment-equivalence.md

Written after a session that measured the stage-4 bar rather than reasoning
about it, prompted by the observation — correct — that "we have support for
multiple Compartments in a Realm in IronHorse, it must just not be exposed to
the environment".
Two adversarial reviews of the first draft produced most of the corrections
above, including that the repo already contains an XS worker that locks down
and an IronHorse worker that runs the SES shim — which between them answer the
question the first draft opened with.
