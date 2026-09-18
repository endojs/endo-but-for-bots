# IronHorse: SES `Compartment` and `lockdown` equivalence

| | |
|---|---|
| **Created** | 2026-09-15 |
| **Updated** | 2026-09-18 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |
| **Source** | Measured while working Phase 4 of [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) |

## Status

Two things landed with this document.

`rust/engine/ironhorse-vm/src/interp/realm.rs` no longer pins any evaluator to
the default realm, closing a confinement hole a compartment could read and
write through
(`tests/realms.rs::every_reachable_evaluator_compiles_in_the_calling_compartment`).
That test now runs on an UNFROZEN machine, because a `Machine::new()` performs
lockdown at construction and its step 2 removes the prototype-chain routes
altogether — `tests/realms.rs::a_locked_down_machine_denies_every_prototype_chain_evaluator`
is the frozen-machine half. Un-pinning remains the right answer for every
evaluator that stays reachable.

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

**Revised 2026-09-18, after [#1295](https://github.com/endojs/endo-but-for-bots/pull/1295)
merged.**
That pull request landed the native `lockdown()` this document's § next step 3
left open, and named the work it did not do.
§ The work #1295 deferred, triaged sorts that list by what each item needs
before code — a decision, a design note, a measurement, or nothing — and
corrects two claims the same lineage produced: `packages/hardened262` has no
`test/Object` directory, and IronHorse's start-compartment clock is already
fixed at the epoch rather than live.
The second correction inverts a sequencing recommendation: attenuation is not a
smaller piece to land ahead of a guest `Compartment`, it is the same piece.
The **Status** field is unchanged at Proposed deliberately.
What moved is this document's contents, not its acceptance: its first question —
which realm profile the daemon takes — is still unanswered, and it is still the
question that decides whether most of the rest is work at all.

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
14/16 today, both failures on that file (one file, sloppy and strict).
It fails on BOTH hosts, but **for two different reasons**, and an earlier
revision of this section asserted node's reason for Ironhorse as well and
concluded "it is not an Ironhorse gap".
That was an inference from a shared symptom, never a measurement, and it is
wrong. Both reasons are `harden` running before `lockdown`, which is why the
inference looked safe; they part company on what `harden` did.

| | node | Ironhorse |
| --- | --- | --- |
| `Object[Symbol.for('harden')]` after the prelude | `function` | **`undefined`** |
| `globalThis.harden` after the prelude | `undefined` | **`function`** (native) |
| what `lockdown()` throws | `Cannot lockdown (repairIntrinsics) if a prior harden implementation has been used and installed` | **`TypeError: invalid descriptor`** |

On node the selector finds no host `harden`, installs its own at
`Object[Symbol.for('harden')]`, and `repairIntrinsics` refuses outright
(`packages/ses/src/lockdown.js:393`).

On Ironhorse the selector adopts the native `globalThis.harden` exactly as
`ironhorse-pre-shim.js` intends, and the slot stays empty — so that refusal
never fires. What fails instead is
`tame-function-constructors.js:102`:

```js
defineProperties(FunctionPrototype, { constructor: { value: InertConstructor } });
```

Ironhorse's native `harden` is a deep freeze that reaches shared intrinsics.
At boot `Function.prototype.constructor` is the spec's
`{writable: true, enumerable: false, configurable: true}`, but a single
`harden({})` anywhere — and `@endo/pass-style` does one during prelude
evaluation — leaves it `{writable: false, configurable: false}`.
SES then cannot swap in its inert constructor, and the redefine is rejected.
The rejection is spec-CORRECT: redefining a non-configurable, non-writable
data property to a DIFFERENT value must fail, and re-running the same define
with the identical value is accepted.

So this IS an Ironhorse gap, and a sharper one than "no host passes it": the
engine's own `harden` freezes intrinsics that a later `lockdown()` still needs
to tame. A native `lockdown()` would not inherit the node problem, but it does
have to answer this one.

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

It is blocked on something upstream of Ironhorse — and, separately, on
something inside it.
**Every `lockdown()`-calling case fails on the node host today.**
The preludes import `./expose-pass-style-bytes-globals.js`, which pulls
`@endo/pass-style` and so `@endo/harden`; where the host has no native
`harden` for its selector to adopt, `@endo/harden` installs its own at
`Object[Symbol.for('harden')]`, and `repairIntrinsics` refuses to run at all
when it finds one (`packages/ses/src/lockdown.js:393`).
The corpus's one such case, `Symbol.toStringTag-lockdown.js`, is red on node
for that reason — the host reports 14/16 — and three cases ported from
`lockdown.test.js` and `harden.test.js` failed identically when tried.

Ironhorse is red on the same case for a DIFFERENT reason, measured above: its
native `harden` deep-freezes `Function.prototype`, so SES's
`tame-function-constructors.js` can no longer install the inert constructor and
`lockdown()` throws `invalid descriptor`. Porting SES's own suite therefore
needs both answers, not one.

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
| idempotence throw | **yes** | `do_lockdown` throws `TypeError("lockdown already called")`; the host-side `lock_down_intrinsics` stays idempotent |
| constructors poisoned | **yes** | five of XS's six prototypes; `Compartment.prototype` does not exist here |
| per-compartment evaluators | partial | `compartment_evaluator` (`realm.rs:72`) copies `Eval` and `Function`; the other three are non-global and get none. Fixed here by leaving them unpinned rather than by copying |
| compartment-global template | — | globals are built per compartment from `global_props` |
| Math (and half of Date) tamed | partial | `Date.prototype.constructor` is poisoned with the rest; nothing tames `Math`, which has no `random` to tame |
| transitive harden | **yes, wider** | XS hardens an enumerated list; IronHorse hardens every primordial instance |

Steps 1, 2 and 5 are done, the last of them and then some.
Step 3 and the compartment-template half of step 4 are absent because they
presuppose a guest `Compartment`.

This section's earlier revision said steps 1–4 were absent and that step 2
"cannot be done at machine construction: it is correct only *after* a guest
asks for it, which is what IronHorse has no equivalent of". The diagnosis was
right and the last clause is no longer true —
[ironhorse-native-lockdown](ironhorse-native-lockdown.md) is that equivalent,
and the guest `lockdown()` it defines is where step 2 now runs.

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
| function-family constructors poisoned | yes | yes | **yes, at `lockdown()`** — before that, `global_names` still cannot confine |
| Date/Math attenuated for compartments | yes | partly (Date's prototype is poisoned realm-wide) | Date's prototype only; no compartments to attenuate for |
| permits table / unpermitted removal | yes | no | no |
| property-override enablement | yes (`overrideTaming`) | no | no |
| locale, NaN side channel, domains, regenerator | yes | no | no |
| error taming and trapping options | yes | no | no |
| mutable-residue audit | no | **yes** (`mutabilities`) | no |

XS's is the smaller, sharper artifact: five steps, no permits table, and an
audit the shim does not have.
The shim is the larger one — and it is the one already running on IronHorse.

## What a next step should establish first

Written 2026-09-15, before the native `lockdown()` existed.
Question 1 below is two questions wearing one name, and both are now settled.
"The daemon's Ironhorse worker" was written in the endor sense, while every
measurement under it comes from `packages/thixotrope`, which is the only
embedder that HAS an IronHorse worker. Split on 2026-09-18: thixotrope's
profile is answered (keep the SES shim), and endor's is deferred at the owner's
direction. Questions 3 and 5 were answered earlier and are struck through.
For what each remaining piece needs before code — and for two corrections to
the sequencing this section implies — read § The work #1295 deferred, triaged
alongside it.

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
3. ~~**If the native profile wins**, `fx_lockdown`'s five steps above are the
   specification, and step 2 needs a guest-callable `lockdown()` separate from
   machine construction before it can be attempted at all.~~
   Partly done, and it does not decide question 1. The guest-callable
   `lockdown()` landed with steps 1, 2 and 5
   ([ironhorse-native-lockdown](ironhorse-native-lockdown.md)); the targeted
   corpus `test/ironhorse` is 1712/1712 covered, 0 failed under `endot-ih -l`.
   (An earlier revision of this line cited agreement across 6053 corpus files;
   that measurement ran the corpus UNLOCKED, because the `-l` splice had no
   caller, and is retracted in that note's § Status.) What remains for a native
   profile is `Compartment`, which is the larger half.
4. **Do not treat `CompartmentOptions` as SES-compatible** without walking the
   table above. Two of its hook fields are booleans.
5. ~~**Re-word the `ironhorse-engine.md:940` bar.**~~ Done: its first clause is
   marked met and its deliverable column now says the native route is a choice
   rather than the plan, since the shim route reaches the same guest surface.

## The work #1295 deferred, triaged

[ironhorse-native-lockdown](ironhorse-native-lockdown.md) merged as
[#1295](https://github.com/endojs/endo-but-for-bots/pull/1295) on 2026-09-18,
carrying `fx_lockdown` steps 1, 2 and 5 and leaving a named list of things it
did not do.
This section sorts that list by **what each item needs before any code is
written**, because they are not the same kind of work and two of them cannot be
started at all as currently written.
Nothing here re-states the items; the native-lockdown note's § Known Gaps owns
their detail.

Two corrections came out of writing it, both to claims this document's own
lineage produced, and they are recorded first because they change what the
next step is.

### Correction 1 — there is no `test/Object` in `packages/hardened262`

The native-lockdown note's "widen the shared-corpus gates" item names
"`packages/hardened262`'s 255 `test/Object` integrity cases" as the obvious
next candidate.
That directory does not exist.
`packages/hardened262/test` is **123 files** in ten directories: 68
`Compartment`, 30 `intrinsics`, 12 `harden`, 7 `modules`, and one each of
`ArrayBuffer`, `TextDecoder`, `TextEncoder`, `freeze`, `ironhorse` and
`lockdown`.
The 255 figure matches nothing in the tree.

What the shared-corpus gate actually leaves out is measurable and smaller:
`native_lockdown_corpora.rs:130` excludes `test/Compartment/` and
`test/modules/` — **75 files** — and asserts each is already `false` in the
committed IronHorse baseline, which is why the gate runs 47.
So the item's premise ("a directory to point the gate at, minus the cases that
need mutable intrinsics") describes a corpus that is not there, and its real
content is that 75 of 123 files are blocked on a guest `Compartment`.
Corrected in the native-lockdown note by the same pass that wrote this section.

### Correction 2 — IronHorse's start-compartment clock is already fixed

The handoff that closed #1295 said a host-made compartment's `Date.now()`
"answers from the real clock", and sequenced attenuation as the thing to close
first.
The first clause is wrong.
`Date.now()` returns `0.0` unconditionally
(`ironhorse-vm/src/interp/natives/date.rs:50`), and `Math.random` does not
exist at all — `create_math` (`interp/boot.rs:2512`) installs 34 methods and
`random` is not among them.
The merged note's own test comment has this right, and records the resulting
oracle divergence: `Date.now() > 0` is `true` on XS and `false` on IronHorse.

So step 4 is nearly empty **as a port**: its `Math` half has nothing to
attenuate and its `Date` half reduces to `Date.prototype.constructor`, which
step 2 already covers.
The gap a confined guest still has is not a live clock, it is that there is no
compartment global to attenuate *into* — a host-made compartment shares the
start compartment's `Date`, where an `fx_lockdown` compartment global would
answer `NaN`.
That is step 3, and step 3 is the guest `Compartment`'s template.
**The consequence for sequencing is the opposite of the handoff's:** attenuation
is not a smaller piece to land first, it is the same piece, and it should be
folded into the guest-`Compartment` design rather than scheduled ahead of it.

### Decisions — nothing below them is worth starting first

**D1. Which realm profile the daemon's IronHorse worker takes.**
This is § What a next step should establish first, question 1, still open, and
it is still the only question whose answer can make most of the rest
unnecessary.
What has changed is that both sides now have a measured price rather than one.
The native side has steps 1, 2 and 5 and needs step 3, a guest `Compartment`
and override enablement before a thixotrope-shaped guest could run on it.
The shim side runs today in `test-thixotrope-ironhorse` and reaches 16/16 on
the parity corpus in
[#1294](https://github.com/endojs/endo-but-for-bots/pull/1294), at the cost of
~576 KB of guest code per boot, an engine floor, and a boot script that must
keep deleting the lazy `Iterator` helpers.
Owner's call, not an engineering finding.

**Answered 2026-09-18: keep the shim, for now.**
The SES shim stays the guest-facing SES profile, because it supplies the
behaviour a guest actually expects today and the native route's remaining piece
(G1) is not built.
This does not retire the native `lockdown()`, which keeps its own two
consumers: `endot-ih -l`, where any divergence from XS would be a regression
rather than a feature, and a host locking down a `Machine` whose code it wrote.
What the answer defers is putting the native operation in the WORKER position,
where third-party source runs on top of it.
Re-open when G1 lands: per D2 below, the template is then the only thing
separating the two profiles for `packages/thixotrope`.

**And the endor half is deferred outright.** This entry's title says "the
daemon's", which was always ambiguous: endor runs XS, calls neither `fx_harden`
nor `fx_lockdown`, and has no IronHorse worker, so only thixotrope had a profile
to choose. Whether endor wants one at all is a separate decision --
`ironhorse-native-lockdown.md` § Decisions, item 5 -- and on 2026-09-18 the
owner deferred it: endor is not a current priority. Deferred, not open: nothing
should be sequenced on it, and Phase 4 of
[ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md),
which that question gates, is deferred with it.

**One consequence for the rest of this list.** Under the shim profile, I1 (the
lazy `Iterator` helpers) is the chosen route's main engine-side debt -- it is
why both boot scripts delete that surface by hand -- and G1 loses the
thixotrope migration from its justification, keeping the 75 hardened262 files
and the 2 parity-corpus cases. G1's own open question is only tilted, not
settled: nothing guest-facing now depends on the NATIVE `Compartment` being
SES-shaped, since the shim installs one, but the corpus that motivates G1 still
is SES-shaped.

**D2. Whether the native `lockdown()` may diverge from `fx_lockdown` to add
override enablement.**
Only live if D1 answers "native", and it has to be settled *before* the step-3
design rather than after.
SES's `enablePropertyOverrides` converts the frequently-overridden
`Object.prototype` data properties into accessors so that `o.toString = ...` on
an instance still works once the prototype is frozen; `fx_lockdown` has no
analogue, and the same probe spliced under `endot-ih -l` classifies
`shared-positive-test-failure`, so XS behaves identically
(`native_lockdown.rs::a_native_lockdown_does_not_enable_property_override`).
Adding it is therefore a deliberate fourth entry in § Oracle divergences, not a
port gap.
A compartment template that freezes those properties as data and one that
installs accessors are different artifacts, which is why it cannot be settled
after step 3 is built.

**Deferred 2026-09-18, and the reason it is safe to defer is a correction.**
An earlier revision of this entry called enablement "load-bearing, because
without it arbitrary guest source breaks on assignment where the shim's guests
do not". That overstates it. The override mistake is a `[[Set]]` problem: a
class body and an object literal both define their methods through
`[[DefineOwnProperty]]` and never consult the prototype chain, so
class-syntax-first source -- which is what `packages/thixotrope`'s
orthogonal-persistence model produces -- is structurally immune, and
`Object.defineProperty` keeps working regardless. Only the ES5 assignment idiom
is affected, SES's own `minEnablements` is six properties whose comments name
the transpiler and test libraries they exist for, and a search of `packages/`
and `rust/endo/xsnap/src/` finds no guest-path site using that idiom at all.

So enablement is a compatibility probe to run before migrating an embedder, not
a prerequisite for one. Its residual risk is a guest's bundled DEPENDENCY graph
rather than its authored source. The correction is recorded in full in
`ironhorse-native-lockdown.md` § Known Gaps and in the probe's own doc comment,
both of which carried the overstatement.

**It re-sizes the native route.** With enablement demoted, the native profile's
remaining cost for `packages/thixotrope` is the compartment template alone,
which folds into G1 -- so the native option reopens when G1 lands rather than
trailing a second unscoped item behind it. That is why D1's answer is "for
now".

### Design work — needs its own note before code

**G1. A guest `Compartment` (`fx_Compartment`, `xsModule.c:2864`), with steps 3
and 4 folded in.**
Transliterating `fx_Compartment` is the smallest part of it.
What a design note has to settle first:

- **There is no template to snapshot.** `fx_lockdown` step 3 fills
  `mxCompartmentGlobal` from the intrinsics up to `_Compartment`; IronHorse
  builds each compartment's globals from `global_props` at
  `create_environment` (`interp/realm.rs:879`). The note has to decide whether
  to introduce a template object or to attenuate at environment-creation time,
  and that decision is also the answer to step 4 (Correction 2).
- **Two of `CompartmentOptions`' hooks are booleans.** `has_resolve_hook` and
  `has_import_hook` exist so a constructor-shape probe can observe them; they
  resolve and import nothing (§ Equivalence: `Compartment`).
- **Relative specifiers are inexpressible.** `ModuleGraph::resolve` takes one
  argument, `ImportEntry` carries no referrer, and all six resolution sites
  pass the specifier alone. Threading a referrer through them is a prerequisite
  for any real `resolveHook`, and `Realm` has no parent, so XS's inherited-hook
  walk has no counterpart either (§ Module resolution).
- **It moves the boot fingerprint again.** A new intrinsic changes
  `boot_fingerprint`, which refuses every existing snapshot and forces another
  golden-fixture regeneration; #1295 measured that cost as the TSV corpora for
  both math providers plus nine inline digests in
  `ironhorse-snapshot/tests/metamorphic_determinism.rs`.

What it unblocks, measured rather than estimated: the **75** hardened262 files
the shared-corpus gate excludes today (Correction 1), and **2 of the 8** cases
on the `test262:ironhorse` engine lane — not all 8. The other six need
`frozenBytes`, `compareBytes`, `concatBytes`, `passStyleOf` and `environment`,
which a prelude supplies and no engine has natively
(`packages/test262-runner/README.md` § The engine lane's zero).

**And that list is now the whole of it, which is worth stating plainly.** G1
had three justifications when this section was written. Two decisions on
2026-09-18 removed the other two: D1 kept the SES shim for
`packages/thixotrope`, and the endor question was deferred outright. The SES
shim installs its own `Compartment`, so no embedder in this tree needs the
native one. What remains is conformance — corpus coverage and differential
fidelity against the oracle — which is real work with a real number attached,
but it is test coverage rather than a product dependency, and it should be
prioritized as such rather than as a blocker.

That also tilts, without settling, the decision at the head of this item. If the
only consumer is the corpus, then matching XS buys oracle-adjudicable behaviour
and matching SES buys those 75 files; nothing guest-facing pulls either way any
more.

### Research — cannot be scoped until measured

**R1. What a wider shared-corpus gate could actually take.**
Correction 1 removes the item's premise, so what it needs first is an inventory
of what the two existing gates do not cover and why, not a directory to point
at.
The SES AVA suites remain further out for the reason already recorded: they
need SES options, override enablement and a guest `Compartment`, so they want a
real adapter rather than source stripping.

**R2. What the `-l` sweep's 3,691 failures are.**
§ Validation on 2026-09-18 in the native-lockdown note classifies them — 2,409
thrown-value rendering differences, 797 where IronHorse throws and the oracle
completes, 207 error-message differences, 31 hangs at the ten-second bound —
and diagnoses none.
Whether the 2,409 are one renderer fault or many decides whether wider
conformance is a week or a quarter, and no plan should be made without knowing.

**R3. The 395 `built-ins/RegExp/property-escapes/generated` files.**
A host limit, not a corpus or engine one: 3.5–6 GB of oracle RSS per batch and
over an hour of CPU, OOM-killed at 4-way parallelism on a 15 GB box.
No design content; it wants a bigger box and a re-run.

### Implementation — no decision or design owed

**I1. The lazy `Iterator` helpers.**
`map`, `filter`, `take`, `drop` and `flatMap` answer `typeof` as `"function"`
and halt the machine with `NotImplemented("Iterator.helper")` when called
(`interp/natives/dispatch.rs:5631`) — an engine halt, so `try`/`catch` does not
recover and the crank does not complete.
This is the one item on the shim side that is engine work, and it is what makes
the boot script delete the surface by hand.
Not free in the other direction: un-advertising them would convert **326**
`skip:unsupported-opcode` rows across **14** files in
`ironhorse-262/expectations/whole-tree` into ordinary conformance failures, so
implementing them is the honest fix.

**I2. `%ThrowTypeError%`.**
Absent. XS builds it and installs it as the get/set of
`Function.prototype.caller` and `.arguments`; IronHorse has neither property,
so `Object.getOwnPropertyNames(Function.prototype)` differs from XS's in
membership and order, and `fx_lockdown:202-203` has no analogue here.
Predates this work.
`packages/hardened262/test/intrinsics/ThrowTypeError/intrinsic-metadata.js` is
its case, and it is one of the 29 `intrinsic-metadata.js` failures the
hardened262 baseline carries with and without lockdown alike.

### Recorded, no action

**N1. Native `lockdown()` and the SES shim are alternatives, not layers.**
Unchanged and still correct: SES's `seemsToBeLockedDown()` calls
`Date.prototype.constructor.now()`, `fx_lockdown` puts the inert stand-in
there, and the guard throws `TypeError: call: not a function` instead of
reporting `SES_MULTIPLE_INSTANCES`.
Measured on both engines, so giving the stand-in a `now` would buy a better
message at the cost of oracle fidelity.
Pinned by
`native_lockdown.rs::the_ses_shims_already_locked_down_guard_throws_after_a_native_lockdown`.

### Blocked on the above rather than on lockdown

**B1. Moving `packages/thixotrope`'s IronHorse worker off the SES shim.**
Deferred by D1 on 2026-09-18, and gated on G1 alone when it reopens — not on
lockdown, and no longer on D2 beside it.
The isolation half already works: measured end to end in
`native_lockdown.rs::a_host_made_compartment_confines_guest_source_only_with_global_names`,
a host-made compartment on a locked-down `Machine` confines guest source, and
`({}).constructor.constructor` is a `TypeError` inside it.
The confinement is a conjunction — `global_names` closes the direct `eval` and
`Function` bindings that lockdown cannot, lockdown closes the prototype route
that `global_names` cannot — and both halves are in the tree.
What it lacks is the compartment template: a host-made compartment shares the
start compartment's `Date` where an `fx_lockdown` compartment global would
answer `NaN`.
An earlier revision closed this entry with "a worker that swapped the shim
today would confine correctly and break ordinary guest code", on the override
mistake. Per D2 that is too strong — class-syntax source does not trip it, and
nothing on a guest path in this tree uses the idiom that does.

### In flight elsewhere, and stale against `llm`

[#1294](https://github.com/endojs/endo-but-for-bots/pull/1294) is open against
`llm` at `7753a4b9`, which is **before** #1295 merged.
Its description says "until [a native `lockdown()`] lands, the shim route is
the SES profile and `test262:ironhorse` continues to refuse to start"; both
clauses are now stale, and its `ses_boot_intrinsics.rs` census predates a realm
that binds `lockdown` at boot for every profile
(`interp/boot.rs:2144`, unconditional).
It wants a rebase and a reconciliation before its numbers can be read against
this document.
Flagged, not touched.

### Not covered by anything above, and not deferred either

Written 2026-09-18 in answer to "what work is not being covered or explicitly
deferred here?".
Everything in this section is open, unowned, and outside both in-flight workers
(a guest `Compartment`; the #1294 rebase).

**The parity axis is unenforced.** See the re-opened ratchet item in § Known
Gaps. This is the largest of them, because it is the measurement every other
claim about the shim route rests on.

**Two of this document's own open gaps were never carried into the triage.**
Neither is assigned:

- The prelude's `@endo/harden` interaction **on the node host**. #1294 solves
  the IronHorse half with `install-pre-lockdown-harden.js`, and its own
  description says wiring the same repair to node "is a separate change with
  its own baseline to move". Until someone does, node stays at 14/16 for a
  reason we have already diagnosed and fixed elsewhere. The item's second
  clause -- porting SES's own lockdown/`Compartment` assertions into the
  `ses-xs-parity` corpus -- is untouched.
- The stage-4 bar does not run `bootstrap_ses`'s closing `run_promise_jobs()`,
  so it cannot see a divergence in how the two engines settle what
  `@endo/eventual-send`'s shim leaves pending.

**Resolved the day this section was written: the endor daemon.** It appeared
here as open-and-unowned, which was right for about an hour. The owner then
deferred it outright -- endor is not a current priority -- so it is no longer
uncovered, it is declined. Recorded at D1 above and in
`ironhorse-native-lockdown.md` § Decisions, item 5. Phase 4 of
[ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md)
is deferred with it; that document is not amended, so read its Phase 4 against
this note.

**A predictable three-way collision on one file.** `ses_boot_intrinsics.rs`'s
census pins `Compartment=undefined`. When a guest `Compartment` lands, that term
stops discriminating in exactly the way `lockdown=function` did once the engine
bound one -- #1295 had to replace that assertion with an identity comparison for
the same reason. #1294 is also editing that file. Whoever lands second pays for
it, and nobody has been told.

**Adjacent tracks this document does not cover and should not be read as
covering.** `designs/ironhorse-known-defects.md` has 111 of 208 findings open or
partial at `fa3ecfcfd`, 83 of them P1 -- roughly 48 metering calibration and 63
guest-observable divergences. The architecture review has 61 open findings at its
last revision, worked by
[#1302](https://github.com/endojs/endo-but-for-bots/pull/1302). **The unasked
question between them and this thread is R2**: the `-l` sweep's 3,691 failures
are classified but undiagnosed, and nobody has checked whether they are a subset
of that catalog or a distinct population. If they are a subset, R2 is already
someone's work; if they are not, it is nobody's.

### Closed since this document was last revised, by work landing elsewhere

- **A CI lane runs `ses_boot_intrinsics.rs`.** `.github/workflows/ci.yml`
  now has a "Test the SES realm profiles and prelude reach" step with
  `IRONHORSE_SES_SHIM_REQUIRED` and `IRONHORSE_SES_PRELUDE_REQUIRED` set, so
  the two profile tests assert rather than skip.
- **The `ses-xs-parity` ratchet is recorded.** `packages/test262-runner`'s
  README gained § Ratchet, not a gate, with per-lane counts (`node` 14/16,
  `ironhorse-host` 14/16, `ironhorse` 0/8 covered) and the reason each lane
  reports what it does.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) | Phase 4 is where this gap sits; that document carries the boot-bundle measurement and points here for the equivalence detail. |
| [ironhorse-engine](ironhorse-engine.md) | Owns stage 4 (`:37`) and its acceptance wording (`:940`). Its `:201` note that XS implements SES natively is true of the implementation and misleading about the bindings — see § What XS implements. |
| [worker-rust-xs](worker-rust-xs.md) | § Known Gaps (`:501-531`) carries the three-part dependency between `polyfills.js`, the `host<Name>` aliases and any real lockdown, which § next step 2 turns into a work list. |
| [thixotrope](thixotrope.md) | Owns both workers whose configurations this document reads as evidence. |
| [ironhorse-w6-decisions](ironhorse-w6-decisions.md) | §1 is the Realm decision whose extraction (PR #1263) built the compartment machinery this document inventories. |

## Known Gaps and TODOs

- [x] Answer question 1 above — which realm profile — before anything else.
      It is the only question whose answer can make the rest unnecessary.
      Answered 2026-09-18: keep the SES shim as the guest-facing profile for
      now; the native `lockdown()` keeps its own consumers (`endot-ih -l` and a
      host locking down its own `Machine`) and is deferred out of the worker
      position only. Re-open when G1 lands. See D1 in § The work #1295
      deferred, triaged for the scope of the answer and what it changes below.
- [x] Decide whether the native `lockdown()` may diverge from `fx_lockdown` to
      add SES's property-override enablement (D2 in the same section).
      Deferred 2026-09-18, on a correction rather than a trade: enablement is a
      compatibility preference for the ES5 assignment idiom, not something
      arbitrary guest source needs in order to run, because class bodies and
      object literals define rather than assign. It becomes a probe to run
      before migrating an embedder. Re-open if that probe trips on a guest's
      dependency graph.
- [x] No CI lane runs `ses_boot_intrinsics.rs`'s two profile tests.
      `test-thixotrope-ironhorse` has the bundle but builds through the root
      workspace, which excludes `rust/engine`, so running an engine-workspace
      test there compiles the engine a second time.
      They skip on a bare checkout; `IRONHORSE_SES_SHIM_REQUIRED` makes a lane
      that claims to have built the bundle fail instead.
      Closed: `.github/workflows/ci.yml` has a "Test the SES realm profiles and
      prelude reach" step that runs `--test ses_boot_intrinsics --test
      ses_prelude_reach` with `IRONHORSE_SES_SHIM_REQUIRED` and
      `IRONHORSE_SES_PRELUDE_REQUIRED` set, in the oracle lane that built both
      artifacts, so the tests assert rather than skip.
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
      Updated 2026-09-16: that `lockdown()` now exists, so the reach IS
      closable — `({}).constructor.constructor('return 1+1')()` throws
      `TypeError: secure mode` after a guest calls it
      (`ironhorse-vm/tests/native_lockdown.rs`). `global_names` still does not
      confine on its own, and a machine whose guest never calls `lockdown()` is
      exactly as reachable as before, so the doc comment's claim stands as
      written.
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
      calling it is an uncatchable halt (§ next step 2;
      `interp/natives/dispatch.rs:5631`). Triaged as I1 — implementation only,
      no decision or design owed — and the direction is settled by the other
      side's cost: un-advertising would convert 326 `skip:unsupported-opcode`
      rows across 14 files in `ironhorse-262/expectations/whole-tree` into
      ordinary conformance failures, so implementing them is the honest fix.
- [ ] Resolve the prelude's `@endo/harden` interaction so `lockdown()`-calling
      cases can run on the node host, then port SES's own lockdown/Compartment
      assertions into the `ses-xs-parity` corpus (§ Why SES's own suite is not
      the gate yet). Clearing `Object[Symbol.for('harden')]` in the prelude is
      measured NOT to work.
- [ ] Record the `ses-xs-parity` ratchet somewhere a regression is visible.
      The axis is deliberately not a CI gate and does not need to fail a build;
      what it needs is a captured per-lane count to ratchet against.
      **Closed on 2026-09-18 and re-opened the same day; the closure was
      wrong.** It cited `packages/test262-runner/README.md`'s new § Ratchet, not
      a gate and its per-lane table. But this item's complaint was never that
      the README lacked counts -- it was that "the only counts recorded anywhere
      are the prose baselines in that package's README, which nothing checks".
      Better prose is still prose. `"test"` is still `exit 0`, nothing compares
      a run against a committed number, and **no CI lane runs any `test262:*`
      lane at all**: `.github/workflows/ci.yml` builds `@endo/test262-runner`
      only for the prelude artifact the oracle lane consumes, and the `endot-ih`
      invocation there walks the corpus directory rather than this axis. So
      every parity figure in circulation is hand-run, including the 16/16 that
      [#1294](https://github.com/endojs/endo-but-for-bots/pull/1294) exists to
      deliver -- a number nothing will notice losing.
- [x] Wire the Ironhorse prelude into `endot-ih` — landed as a `--prelude`
      flag, with `effective_skip_features` dropping `lockdown`/`Compartment`
      when one is supplied. `SesMode::unimplemented_skip` deliberately still
      returns `Some` for `-l`: a prelude is the SHIM route and does not make
      the NATIVE one work, so `-l` keeps failing closed and
      `SesMode::prelude()` stays unreachable on the live path. The lane that
      actually moved is `test262:ironhorse-host`, which skips `endot-ih`'s
      differential entirely.
      Superseded in part by #1295: `-l` no longer fails closed, setup is
      compiled and evaluated as its own Script, and `SesMode::prelude()` was
      deleted rather than kept — it was the template whose only callers were
      its own unit tests, which is how a disconnected `-l` wire passed for a
      measurement for as long as it did.
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
