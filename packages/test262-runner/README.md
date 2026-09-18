# test262-runner

Run ECMAScript compliance tests on Node.js, XS, and Ironhorse (the XS→Rust port),
with a prelude that shims Hardened JavaScript on these platforms.

## Hosts

The `ses-xs-parity` axis runs against three engines off one maintained subset.
Ironhorse has two lanes because it is the only engine with a differential
runner, and the two answer different questions:

* `yarn test262:xs` — XS via `xst` and the SES prelude.
* `yarn test262:node` — Node.js and the SES prelude.
* `yarn test262:ironhorse-host` — Ironhorse as a plain test262 host, driven by
  `test262-harness` exactly as the two lanes above are, through the
  `ironhorse-xst` binary and the SES prelude. This is the lane that measures
  Hardened-JavaScript compatibility, and the one the ratchet below tracks.
  Requires a Rust toolchain.
* `yarn test262:ironhorse` — the same corpus through `endot-ih`, Ironhorse's
  DIFFERENTIAL runner, which executes each case on both Ironhorse and an XS
  oracle and gates on their agreement. It answers "does Ironhorse agree with
  XS", not "does Ironhorse pass the test", so it is a divergence hunt rather
  than a compatibility measure. It asks for a native `lockdown()`
  (`xst262.c`'s `-l`), which Ironhorse now implements
  (`designs/ironhorse-native-lockdown.md`), so the lane starts and runs.
  It still covers nothing on THIS corpus, for reasons that have nothing to do
  with lockdown — see "The engine lane's zero" below. Requires a Rust
  toolchain and the `c/moddable` submodule (the XS oracle it diffs against),
  the same XS dependency the `xs` host already needs.

`yarn test262` runs `xs`, `node` and `ironhorse` in sequence. It used to
inherit that last lane's refusal to start; it no longer does.

See `designs/ironhorse-test262-convergence.md` for the convergence that
makes Ironhorse the third host.

## Ratchet, not a gate

This is a compatibility measurement, not a CI gate.
No lane here is wired into CI (`"test"` is `exit 0`), and none needs to be:
a red case does not block a merge.

What it is for is the direction of travel.
The pass count is expected to go UP and never down, and a drop is the signal
worth acting on — a regression in the engine, the prelude, or the corpus.
Read it that way rather than as pass/fail.

Counts at the time of writing, over the 16 runs the corpus produces
(8 cases, each in sloppy and strict mode):

| lane | passing | notes |
| --- | --- | --- |
| `test262:xs` | not measured here | needs `xst`; build the `c/moddable` submodule |
| `test262:node` | 14 / 16 | the 2 failures are the `lockdown()` case, below |
| `test262:ironhorse-host` | **16 / 16** | the number this ratchet tracks |
| `test262:ironhorse` | 0 / 8 covered | starts now; every case a named skip, below |

Ironhorse now passes the whole corpus, including the one case node still fails:
`Symbol.toStringTag-lockdown.js`, whose sloppy and strict runs are node's two.
The hosts were red on it for different reasons, which is why node's 14/16 was
never a ceiling for this lane — see "The `lockdown()` case" below.

It went 6/16 to 14/16 in four steps, each of which this lane surfaced:

1. a `return` out of a `switch` left the discriminant on the value stack, so
   a call in an argument list corrupted the caller's pending operands;
2. the codec polyfill had no `TextEncoder.prototype.encodeInto`;
3. it also accepted an emulated ArrayBuffer view it can neither read nor
   write, decoding garbage and dropping writes instead of refusing;
4. `%TypedArray%.prototype.at` was missing — `Array.prototype.at` and
   `String.prototype.at` were both present — and it is the only read an
   emulated immutable view answers.

A fifth step took it to 16/16: the prelude stopped handing SES Ironhorse's
native prototype-traversing `harden`, which had been freezing the very
intrinsics `lockdown()` still needed to tame. See "The `lockdown()` case".

`designs/ironhorse-ses-compartment-equivalence.md` has the measurements.

### The `lockdown()` case

One file — `Symbol.toStringTag-lockdown.js`, whose sloppy and strict runs are
two of the sixteen — used to be red on both hosts, for two different reasons.
Ironhorse now passes it; node still does not.
Both reasons are `harden` running before `lockdown`, which is why it was
tempting to file them as one; they part company on what `harden` did.

Node's failure is not an engine gap.
`@endo/harden`'s selector resolves `Object[Symbol.for('harden')]`, then
`globalThis.harden`, and only failing both installs its own — non-configurably,
with a comment saying that doing so "will prevent any HardenedJS's lockdown
from succeeding".
XS and Ironhorse both supply a host `harden` the selector adopts, so
`repairIntrinsics` starts; Node supplies none, the slot gets installed, and
every `lockdown()`-calling case fails before `repairIntrinsics` does anything.

Ironhorse's failure was an engine gap, and starting `repairIntrinsics` was as
far as it got. Ironhorse's native `harden` is a faithful port of XS's
`fx_hardenFreezeAndTraverse` and walks prototype chains: at boot
`Function.prototype.constructor` carries the spec's
`{writable: true, enumerable: false, configurable: true}`, and a single
`harden({})` — which `@endo/pass-style` performs while the prelude is still
evaluating — left it `{writable: false, configurable: false}`. `lockdown()`
then reached `tame-function-constructors.js`, tried to redefine that
`constructor` to its inert stand-in, and was refused with
`TypeError: invalid descriptor`. The refusal is spec-correct — a
non-configurable, non-writable data property cannot be redefined to a different
value — so the bug was the freeze, not the rejection.

## The Ironhorse lockdown shim

Ironhorse now has a native `lockdown()`, but no guest `Compartment`. The
`ironhorse-host` lane therefore still runs SES's **shim**, which supplies both,
and two files prepare the realm for it. Which file a repair
belongs in is decided by whether it is an engine gap or a consequence of what
this corpus loads.

`src/ironhorse-pre-shim.js` imports `@endo/ironhorse-prelude`, the engine's own
prologue, shared with the shipped worker.
Its `harden` decision is to **delete** Ironhorse's native one before the shim is
evaluated.
That is not a detail: `packages/ses/src/make-hardener.js:142-147` ADOPTS an
existing `globalThis.harden`, and `packages/ses/src/lockdown.js:85` calls it at
module scope, so whatever is at `globalThis.harden` when the shim is *evaluated*
becomes the guest's `harden` for the life of the realm — `lockdown()` does not
replace it.
Ironhorse's native `harden` is a port of XS's `fx_hardenFreezeAndTraverse` and
walks prototype chains, so leaving it there would freeze
`Function.prototype.constructor` at the first pre-lockdown `harden()` and
`tame-function-constructors.js` could no longer install its inert constructor.
Deleting it hands the shim its own hardener, which traverses — which is what
`harden` is for.

`src/install-pre-lockdown-harden.js` handles what is left, and it is this
corpus's problem rather than the engine's.
Four constraints meet, and only one arrangement satisfies all four:

1. **Something will harden before `lockdown()`.**
   `expose-pass-style-bytes-globals.js` pulls `@endo/pass-style`, `@endo/bytes`
   and `@endo/immutable-arraybuffer`, all of which call `harden()` at module
   scope. Six of the eight cases need those globals and never call
   `lockdown()`, so the prelude cannot defer them behind it.
2. **`globalThis.harden` must exist when the selector first runs**, or
   `@endo/harden` installs its own into `Object[Symbol.for('harden')]` and
   `repairIntrinsics` refuses outright. That is node's failure above.
3. **Whatever hardens must not freeze the intrinsics `lockdown()` still has to
   tame**, or `tame-function-constructors.js` cannot install its inert
   constructors. That was Ironhorse's failure above.
4. **It must be gone again before `lockdown()` runs.** The shim collects the
   start global's own `harden` as an intrinsic and separately adds its own
   (`lockdown.js:355`); `initProperty` (`ses/src/intrinsics.js:39`) compares
   them and throws `Conflicting definitions of harden`. The only arrangement
   where that is not a conflict is the one constraint 3 forbids — where the
   shim adopted this very function, so the two are the same object.

So the module installs `@endo/harden`'s
`makeHardener({ traversePrototypes: false })` *after* the shim — present, so the
selector adopts it and nothing lands in the poisoning slot; gentle, so the
intrinsics survive to be tamed; late, so the shim keeps its own — and wraps
`globalThis.lockdown` to withdraw it again on the way in.
`makeHardener` rather than the package default, because the default export is
the *selector*, and giving it to `globalThis.harden` would leave it finding
itself.
Nothing about this is Ironhorse-specific; node fails the same case for the same
reason and would take the same repair, which is a separate change with its own
baseline to move.

**Coverage.** `rust/engine/ironhorse-vm/tests/ses_prelude_reach.rs` runs all
eight cases through the generated prelude and pins each outcome, so the number
here cannot go stale; it is the shim route's ratchet. The realm profiles the
shim depends on are pinned separately by `ses_boot_intrinsics.rs`, which loads
the *shipped* `packages/thixotrope/dist-ironhorse/boot.js` rather than this
prelude. Its census reports `hardenTraverses` rather than `typeof harden`,
because every configuration in that file has *a* `harden` and only the
behaviour distinguishes them. Both run in the `test-ironhorse-oracle` lane with
`IRONHORSE_SES_PRELUDE_REQUIRED` and `IRONHORSE_SES_SHIM_REQUIRED` set, which
make a missing artifact a failure rather than a skip.

Note that the shim route and the shipped worker are not the same environment
and are not meant to be. `dist-ironhorse/boot.js` calls `lockdown()` on the
line after the shim, with nothing having hardened, so it needs no stand-in at
all; this prelude must leave the realm *un*-locked-down, because one of the
eight cases asserts a descriptor `lockdown()` changes — `Symbol.toStringTag.js`
wants `Compartment.prototype[Symbol.toStringTag]` still `configurable: true`,
and measured after an explicit `lockdown()` it fails with exactly that.
`Symbol.toStringTag-lockdown.js` fails post-lockdown too, for a different and
equally real reason: it calls `lockdown()` itself, and SES refuses a second
one.
So two of the eight are cases the worker's guests could not run at all.

The other six all pass under the options the worker ships.
Under SES's *defaults* four of them instead halt on
`native-call:TypedArray:from-array-like`.
That is one fact rather than two: `bundle-ironhorse-worker.mjs` chose
`overrideTaming: 'min'` for exactly this reason — its comment names Ironhorse's
typed-array copy profile refusing the accessor-based iterator overrides that
`'moderate'` installs on `Array.prototype`.
An earlier revision of this section reported that default-option column as
though it were unconditional — "four are blocked post-lockdown by an unrelated
engine gap" — which understated the shipped configuration by four cases.

| | pre-lockdown | worker's options | SES defaults |
| --- | --- | --- | --- |
| `Symbol.toStringTag.js` | pass | **fail** | **fail** |
| `Symbol.toStringTag-lockdown.js` | pass | fail | fail |
| `byte-array-brand.js`, `byte-readers.js`, `native-or-emulated-shape.js`, `TextDecoder` intersection | pass | pass | **halt** |
| `ses-hosts.js`, `TextEncoder` intersection | pass | pass | pass |
| | **8 / 8** | **6 / 8** | **2 / 8** |

That table is **pinned, not quoted**: `ses_prelude_reach.rs`'s `POST_LOCKDOWN`
runs all eight cases in a locked-down realm under both option sets, in the same
`test-ironhorse-oracle` lane as the pre-lockdown pin, and fails with a
copy-pasteable replacement when any cell moves.
The worker column is the ratchet for the realm the worker actually ships; the
defaults column is a second ratchet on the engine gap, and flips to `PASS` when
that native call lands.
One case is enough to decide the prelude's own lockdown, and the one is real.

**The native `lockdown()` has landed, and the shim is still the chosen route.**
XS's `fx_lockdown` (`c/moddable/xs/sources/xsLockdown.c`) rewires those same
constructors with direct slot writes, underneath `[[DefineOwnProperty]]`, so a
frozen `Function.prototype` never obstructs it, and Ironhorse now implements its
steps 1, 2 and 5 natively — `designs/ironhorse-native-lockdown.md` has the
ledger.

That settled the realm-profile question rather than opening it: the SES shim
stays the **guest-facing** SES profile, and the native `lockdown()` is deferred
out of the worker position. It keeps two consumers of its own — `endot-ih -l`,
where divergence from the XS oracle is a regression, and a host locking down a
`Machine` whose code it wrote — but neither is the guest surface. The deciding
gap is `Compartment`: the native route implements no guest one
(`fx_Compartment`), and the shim supplies it along with `lockdown`.

So this shim route is what the worker ships, which is why the post-lockdown pin
above measures the worker's realm rather than only this prelude's.
`test262:ironhorse` — the differential runner, which now starts rather than
refusing — reports this corpus's two `Compartment` cases as `feature:Compartment`
skips. § The engine lane's zero, below, has that number and what the rest of it
is short of.

### The engine lane's zero

`test262:ironhorse` now starts. Before the native `lockdown()` it refused: `-l`
named a mode with no implementation, and `endot-ih` exited 2 rather than
running all 35891 files, pre-skipping every one with a truthful
`ses-mode:lockdown-unimplemented`, and exiting 0 — a lane that reads as a
passing third host while testing nothing. A ratchet needs a real number more
than a green tick.

The number it now reports on this corpus is **0 of 8 covered, 8 named skips**,
and that is not a lockdown result. Two cases skip on `feature:Compartment`
(`Symbol.toStringTag.js` and `Symbol.toStringTag-lockdown.js`), the constructor
Ironhorse models as a host-side Rust API rather than a guest intrinsic. The
other six are `shared-positive-test-failure`, and they do not all want the same
thing:

| Case | Needs | Supplied by |
|---|---|---|
| `byte-array-brand.js` | `frozenBytes`, `passStyleOf` | `src/expose-pass-style-bytes-globals.js` |
| `byte-readers.js` | `frozenBytes`, `compareBytes`, `concatBytes` | same |
| `native-or-emulated-shape.js` | `frozenBytes` | same |
| `immutable-arraybuffer-intersection.js` | `frozenBytes` | same |
| `ses-hosts.js` | `environment` | `src/ironhorse-prelude.js` |

No engine has any of these natively, so Ironhorse and the XS oracle fail them
identically — which is agreement, which is a skip rather than a divergence.

So the engine lane measures the guest surface, and the guest surface is **six
names short**: `Compartment`, `frozenBytes`, `compareBytes`, `concatBytes`,
`passStyleOf` and `environment`. An earlier revision of this paragraph said
"one name short" and that `Compartment` landing would move it. Both are wrong,
and the second is the one that matters: `Compartment` moves **2 of the 8**, and
the remaining 6 need globals a prelude currently supplies, one of which
(`ses-hosts.js`) is not in the bytes family at all. For a compatibility count
today, read `test262:ironhorse-host`.

What `-l` bought is a differential gate on the lockdown itself. An earlier
revision of this paragraph claimed that gate had already reported agreement
over 6053 files. **Disregard that claim.** The measurement ran, but
`SesMode::prelude()` had no caller on the run path at the time, so `-l` lifted
the pre-skip and then ran the corpus *unlocked*; byte-identical outcomes with
and without the flag were the symptom, not the result.
`designs/ironhorse-native-lockdown.md` § Status has the post-mortem.

With the splice actually connected, what the gate reports is:

* `test/ironhorse`, 1712 files: **1712 covered, 0 failed** under `-l`.
* `built-ins/Boolean`, 49 files: **18 failures without `-l`, 21 with.** All
  three additions are cases where lockdown legitimately makes a `verifyProperty`
  assertion fail on *both* engines, and the two engines then render the same
  thrown `Test262Error` differently (`Test262Error: …` vs `Object: …`). That
  renderer gap is pre-existing and reproduces with no `lockdown()` in the case
  at all.
* Everything between those two is unmeasured under `-l`.

Five oracle divergences in the lockdown itself were found by review rather than
by this gate; two are fixed and three are open by decision. The ledger is in
`designs/ironhorse-native-lockdown.md` § Oracle divergences, measured.

`ironhorse-xst` answers to the same principle in the other direction.
A negative parse-phase case passes when the host prints `SyntaxError` on
stderr, so reporting every compile failure under that name would let a
construct Ironhorse has not ported yet — or an exhausted work allowance, or a
regexp resource ceiling — count as a passing case.
The host reports those as `InternalError` instead, which fails the case
honestly, and only the grammar's own early errors claim `SyntaxError`.
The ratchet can then only go up for something Ironhorse actually does.

## Test262 subset

The `test262` directory contains

* a copy of the `tests` and `harness` directories from https://github.com/tc39/test262.
* additional tests from https://github.com/Moddable-OpenSource/moddable
* additional Hardened JavaScript tests
* Ironhorse bring-up and regression cases under `test/ironhorse/`

We currently only run tests expressly marked with the `ses-xs-parity` feature
in their front-matter. The XS and Node suites also exclude the
`ironhorse-dual-run`, `ironhorse-meter-exact`, and
`ironhorse-meter-determinism` classifiers. Those annotations keep the cases in
one corpus while preventing hosts without Ironhorse's differential and
metering checks from attempting them. Ironhorse's Rust suites select those
same cases by their classifiers and apply the supported checks.

## Justification

Maintaining a local copy of tests taken at a given revision provides not only stability, it's also much faster on autobuilds than having to both checkout the test262 git repo and filter for relevant tests, and having to do so at every test run.

This technique is the same used by all major JavaScript engines:
- https://github.com/WebKit/webkit/tree/master/JSTests/test262
- https://github.com/v8/v8/tree/master/test/test262
- https://github.com/mozilla/gecko-dev/tree/master/js/src/tests/test262
etc.
