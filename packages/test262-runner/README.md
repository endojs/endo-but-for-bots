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
| `test262:node` | 14 / 16 | the 2 failures are `lockdown()` cases, below |
| `test262:ironhorse-host` | 14 / 16 | the number this ratchet tracks |
| `test262:ironhorse` | 0 / 8 covered | starts now; every case a named skip, below |

Ironhorse now matches the node host's 14/16, and on the same file:
`Symbol.toStringTag-lockdown.js`, whose sloppy and strict runs are the two.
Both hosts fail it, but not for the same reason — see "The `lockdown()` case"
below, and do not read node's failure as an alibi for Ironhorse's.

It went 6/16 to 14/16 in four steps, each of which this lane surfaced:

1. a `return` out of a `switch` left the discriminant on the value stack, so
   a call in an argument list corrupted the caller's pending operands;
2. the codec polyfill had no `TextEncoder.prototype.encodeInto`;
3. it also accepted an emulated ArrayBuffer view it can neither read nor
   write, decoding garbage and dropping writes instead of refusing;
4. `%TypedArray%.prototype.at` was missing — `Array.prototype.at` and
   `String.prototype.at` were both present — and it is the only read an
   emulated immutable view answers.

`designs/ironhorse-ses-compartment-equivalence.md` has the measurements.

### The `lockdown()` case

One file is red on both hosts, for two different reasons. Both are `harden`
running before `lockdown`, which is why it is tempting to file them as one;
they part company on what `harden` did.

Node's failure is not an engine gap.
`@endo/harden`'s selector resolves `Object[Symbol.for('harden')]`, then
`globalThis.harden`, and only failing both installs its own — non-configurably,
with a comment saying that doing so "will prevent any HardenedJS's lockdown
from succeeding".
XS and Ironhorse both supply a host `harden` the selector adopts, so
`repairIntrinsics` starts; Node supplies none, the slot gets installed, and
every `lockdown()`-calling case fails before `repairIntrinsics` does anything.

Ironhorse's failure IS an engine gap, and starting `repairIntrinsics` is as far
as it gets. The native `harden` is a deep freeze that reaches shared
intrinsics: at boot `Function.prototype.constructor` carries the spec's
`{writable: true, enumerable: false, configurable: true}`, and a single
`harden({})` — which `@endo/pass-style` performs while the prelude is still
evaluating — leaves it `{writable: false, configurable: false}`. `lockdown()`
then reaches `tame-function-constructors.js`, tries to redefine that
`constructor` to its inert stand-in, and is refused with
`TypeError: invalid descriptor`. The refusal is spec-correct — a
non-configurable, non-writable data property cannot be redefined to a different
value — so the bug is the freeze, not the rejection. A native `lockdown()`
escapes node's problem but still has to answer this one.

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
