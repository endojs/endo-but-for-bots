# Drop the pseudo-prototype: collapse the immutable-ArrayBuffer lib onto `ArrayBuffer.prototype`

This design captures the *drop-the-pony* redesign erights proposed
on the experiment branch's predecessor pull request (referenced in
the comment whose identifier appears in the project log).
The package keeps its split between a self-contained library layer (today's pony layer)
and a shim layer that installs immutable-ArrayBuffer support onto the
genuine `ArrayBuffer.prototype` at load time.
The redesign changes what the library layer exports and what the shim
does with those exports, not the package's split-into-two-layers shape.

## Status

| Field    | Value                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- |
| Created  | 2026-06-09                                                                                  |
| Authors  | erights (original framing), kriscendobot (write-up)                                         |
| Status   | Proposed                                                                                    |
| Affects  | `packages/immutable-arraybuffer/`, `packages/ses/src/permits.js`, `packages/ses/src/get-anonymous-intrinsics.js` |
| Replaces | The intermediate `%ImmutableArrayBufferPrototype%` intrinsic introduced by the cycle-201 shim |

## Problem

Today, `@endo/immutable-arraybuffer` emulates immutable ArrayBuffers by
constructing instances whose direct prototype is an intermediate object
named `ImmutableArrayBufferInternalPrototype`.
That intermediate prototype inherits from `ArrayBuffer.prototype` and
overrides every method and accessor (`byteLength`, `slice`, `transfer`,
`resize`, and so on) so they consult a `WeakMap`-emulated private field
and either delegate to the underlying genuine buffer or throw the
appropriate "cannot mutate" `TypeError`.
The shim then adds three brand-new properties (`sliceToImmutable`,
`transferToImmutable`, `immutable`) to the genuine `ArrayBuffer.prototype`
so that any genuine ArrayBuffer can be converted to an emulated
immutable one.

This shape forces three load-bearing artifacts that have no analog in
the proposal as natively implemented:

- The intermediate prototype.
  Every emulated immutable buffer has a direct prototype distinct from
  `ArrayBuffer.prototype`.
  SES samples that intermediate prototype at lockdown time via the
  throwaway-instance prototype walk in `get-anonymous-intrinsics.js`
  and registers it as the `%ImmutableArrayBufferPrototype%` intrinsic.
- The `permits.js` `%ImmutableArrayBufferPrototype%` entry.
  A twenty-line block enumerating every property of the intermediate
  prototype that the lockdown phase is allowed to keep.
- The two-surface story.
  Code that reads the package's README has to learn two surfaces:
  the ponyfill (functions that take a buffer argument) and the shim
  (methods on the genuine prototype).
  The two surfaces also disagree about the *call shape* of the same operation:
  `sliceBufferToImmutable(buf, start, end)` versus
  `buf.sliceToImmutable(start, end)`.

The redesign collapses all three.
The library layer stops exporting ponyfill functions and instead exports a record of properties.
The shim copies that record's own-properties onto `ArrayBuffer.prototype` and
`%TypedArrayPrototype%` (the parallel TypedArray side lands on
`%TypedArrayPrototype%` once the freezable TypedArray work merges; see
*Out of scope* for this design's relationship to that work).
Emulated immutable buffers are still created by the lib (they still need a
distinct identity so a brand-check WeakMap can recognise them), but
they no longer have a distinct prototype: their `__proto__` is
`ArrayBuffer.prototype` directly, and the methods that already live on
that prototype (the genuine ones plus the shim-installed ones)
discriminate on whether `this` is in the brand-check WeakMap.

The discriminator is the *amplifier-with-this-fallthrough* pattern: a
brand-check function that returns the underlying genuine buffer if the
receiver is in the WeakMap, and returns the receiver itself otherwise.
The predecessor experiment branch already uses this pattern for
freezable TypedArrays (commit `e02ec0d08`) and erights has signaled it
as the preferred shape for ArrayBuffer too.

## Design

The redesign has five moves.
Each is described below as the diff from master (`4a04d078b`).

### Move 1: Rename "pony" to "lib"

Every occurrence of "pony" in `packages/immutable-arraybuffer/`
filenames, identifiers, exported symbols, JSDoc, test titles, and
README prose becomes "lib".

| Before                                                       | After                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `src/immutable-arraybuffer-pony.js`                          | `src/immutable-arraybuffer-lib.js`                          |
| `test/immutable-arraybuffer-pony-slice.test.js`              | `test/immutable-arraybuffer-lib-slice.test.js`              |
| `test/immutable-arraybuffer-pony-transfer.test.js`           | `test/immutable-arraybuffer-lib-transfer.test.js`           |
| `index.js`: `export * from './src/immutable-arraybuffer-pony.js';` | `export * from './src/immutable-arraybuffer-lib.js';` (but see *Move 3* for whether `index.js` is reachable as a public export) |
| README heading `## The Ponyfill`                             | `## The Lib Layer`                                          |
| README prose "the ponyfill and shim"                         | "the lib layer and shim"                                    |
| Test title `'Immutable ArrayBuffer ponyfill installed and not hardened'` | `'Immutable ArrayBuffer lib installed and not hardened'` |

Identifiers internal to the lib file that contain "ponyfill" or "pony"
in their JSDoc are rewritten.
The exported symbol names (`isBufferImmutable`, `sliceBufferToImmutable`,
`optTransferBufferToImmutable`) are *not* themselves renamed in this
move because they are already lib-neutral; see *Move 3* for whether
they remain exported at all.

In `packages/bytes/src/to-immutable.js`, the JSDoc reference to "the
ponyfill" is rewritten to "the lib layer", with the caveat that this
file's import may be retired entirely under *Move 3's* premise-2
question.

The historical `CHANGELOG.md:18` entry ("sliceToImmutable Hermes
ponyfill and shim") is left as a historical artifact (see *Open
questions* for the call).
Historical changelog text describes what was shipped at the time and is
not retroactively rewritten when terminology moves.

### Move 2: Amplifier-with-this-fallthrough extends to ArrayBuffer

The lib's `getBuffer` (today's `immutable-arraybuffer-pony.js:97-105`)
gains the fallthrough behaviour:

```js
// Before (throws on non-emulated input):
const getBuffer = immuAB => {
  const result = buffers.get(immuAB);
  if (result) return result;
  throw TypeError('Not an emulated Immutable ArrayBuffer');
};

// After (returns the receiver on fallthrough, so the method becomes
// a drop-in replacement for the genuine method when invoked on a
// genuine ArrayBuffer):
const amplifyArrayBuffer = immuAB => {
  const result = buffers.get(immuAB);
  if (result !== undefined) return result;
  return immuAB;
};
```

The name change (`getBuffer` to `amplifyArrayBuffer`) aligns with the
analogous `amplifyTypedArray` on the experiment branch.
Every method on the (formerly pseudo-)prototype uses
`amplifyArrayBuffer(this)` as the way to reach the underlying buffer
for read operations, and the four mutator methods (`resize`, `transfer`,
`transferToFixedLength`, `transferToImmutable`) check membership in the
brand WeakMap to decide whether to throw the "cannot mutate" error or
delegate to the genuine method.

Concretely, the methods restructure as follows.
The read accessors and the `slice` family become straight delegation
(the body looks the same whether `this` is emulated-immutable or a
genuine ArrayBuffer, because `amplifyArrayBuffer` returns the right
underlying buffer either way):

```js
get byteLength() {
  return apply(arrayBufferByteLength, amplifyArrayBuffer(this), []);
},
slice(start = undefined, end = undefined) {
  return arrayBufferSlice(amplifyArrayBuffer(this), start, end);
},
```

The mutators discriminate on brand membership and delegate to the
genuine method on fallthrough.
The genuine methods are captured at module load time before any shim
installation can shadow them:

```js
// At module top, after the existing `slice, transfer: optTransfer`
// destructure:
const { resize: optResize, transferToFixedLength: optTransferToFixedLength } =
  arrayBufferPrototype;

// In the prototype record:
resize(newByteLength = undefined) {
  if (buffers.has(this)) {
    throw TypeError('Cannot resize an immutable ArrayBuffer');
  }
  return apply(optResize, this, [newByteLength]);
},
transfer(newLength = undefined) {
  if (buffers.has(this)) {
    throw TypeError('Cannot detach an immutable ArrayBuffer');
  }
  return apply(optTransfer, this, [newLength]);
},
// transferToFixedLength and transferToImmutable follow the same pattern.
```

The `detached` and `resizable` getters likewise discriminate: they
return `false`/`false` for emulated immutables (current behaviour) and
delegate to the genuine getter for genuine ArrayBuffers.

The `immutable` getter returns `true` for emulated immutables and
`false` for genuine ArrayBuffers (which is the current `isBufferImmutable`
semantics, but expressed as a method on the prototype rather than as a
free function).

The `[toStringTag]` slot is *not* installed on `ArrayBuffer.prototype`
by the shim.
The genuine `ArrayBuffer.prototype` already has
`[toStringTag] = 'ArrayBuffer'`, and overwriting it to
`'ImmutableArrayBuffer'` would break every genuine ArrayBuffer's
`Object.prototype.toString` output.

**Design departure (recorded post-implementation, barrister panel round 1):**
The original framing in this paragraph elected to drop the
`[Symbol.toStringTag]` purposeful violation entirely, on the premise that
`concordance` (used by ava for diagnostic output) would route through
`Buffer.from` either way and would handle the resulting `TypeError` as
unrenderable.
The premise was empirically wrong: with the tag removed, an emulated
immutable reads as `[object ArrayBuffer]`, concordance routes into
`Buffer.from(emulatedImmutable)`, and the resulting `TypeError`
(`Received an instance of ArrayBuffer`) is not handled gracefully but
instead kills 13 ocapn codec test cases.
The implementation restores the
`[Symbol.toStringTag] = 'ImmutableArrayBuffer'` slot as an own property
on each emulated immutable buffer (installed via `defineProperty` in
`makeImmutableArrayBufferInternal`), *not* on the shared prototype.
Genuine ArrayBuffers continue to inherit `'ArrayBuffer'` from the
prototype; emulated immutables carry their own
`'ImmutableArrayBuffer'` slot.
The design's "no intermediate prototype" property is preserved (the
emulated immutable still inherits directly from `ArrayBuffer.prototype`);
the cost is one extra own-property per emulated instance.

The post-departure observable contract:
`Object.prototype.toString.call(immuAB)` returns
`'[object ImmutableArrayBuffer]'` (as it did in master);
`Object.prototype.toString.call(genuineAB)` returns `'[object ArrayBuffer]'`
(unchanged).
The `immutable` accessor remains the canonical brand check for callers
that prefer the explicit accessor over the toStringTag heuristic.

The lib's `sliceBufferToImmutable` and `transferBufferToImmutable`
free functions still exist internally to support the prototype record:
`sliceToImmutable` and `transferToImmutable` in the prototype record
call them.
They are no longer exported (see *Move 3*).

### Move 3: Pseudo-prototype becomes a property record

The library layer's `ImmutableArrayBufferInternalPrototype` (today the
intermediate prototype of every emulated instance) becomes
`immutableArrayBufferLibProperties`: a plain record whose own keys are
the properties the shim is to copy onto `ArrayBuffer.prototype`.
The record:

- Does not have `__proto__: arrayBufferPrototype`.
  It is a plain `Object.create(null)` (or `{}`, immediately followed by
  the defineProperty-non-enumerable loop the current file already uses).
- Is no longer the prototype of any object.
  The `makeImmutableArrayBufferInternal` factory's
  `{ __proto__: ImmutableArrayBufferInternalPrototype }` becomes
  `{ __proto__: arrayBufferPrototype }`.
  Emulated immutable buffers now directly inherit from `ArrayBuffer.prototype`.
  They are still recognisable to the lib via the `buffers` WeakMap brand check;
  they are now also recognisable to `instanceof ArrayBuffer` in the same
  way they were before, and (additionally) to any method on the
  prototype because the methods discriminate on the WeakMap.

The package's `index.js` and `package.json` `exports` need a call:

- **Decision: keep `index.js` and the `.` export, but rewrite
  `index.js` to export only the brand-check helpers a caller could
  legitimately want pre-shim (the typical use case for
  `isBufferImmutable` is "I am a library that wants to detect
  immutability without forcing the shim to be installed").**
  This keeps the package useful as a library outside of an SES context,
  at the cost of exporting one or two symbols.
  The premise-2 narrowing (drop the `.` export entirely; see the
  predecessor experiment branch's commit `a5e31162`) is separated into
  a follow-up PR.

The exact public exports after the redesign:

| Export                                          | Status                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `isBufferImmutable`                             | Keep. Caller-side brand check that works without the shim having been installed.             |
| `sliceBufferToImmutable`                        | Remove. The shim makes `ArrayBuffer.prototype.sliceToImmutable` available; the free-function call shape is redundant. |
| `optTransferBufferToImmutable`                  | Remove. Same reason.                                                                         |

The internal helpers `sliceBufferToImmutable` and
`transferBufferToImmutable` still exist inside the lib file (the
prototype-record methods need them); they are simply not part of the
package's module-export surface.

### Move 4: Shim copies properties onto genuine prototypes

`src/immutable-arraybuffer-shim.js` adapts to the new lib surface.
The shape stays the same (capture, build, warn, install), but the source
of the install set is the lib's exported property record rather than
the shim file's own inline `arrayBufferMethods`:

```js
import { immutableArrayBufferLibProperties } from './immutable-arraybuffer-lib.js';

// ... captures unchanged ...

// Better fidelity emulation of a class prototype: copy with the same
// non-enumerable shape the lib already establishes. The lib file's
// own defineProperty-non-enumerable loop has already done this on the
// record, so getOwnPropertyDescriptors preserves the shape.
const overwrites = ownKeys(immutableArrayBufferLibProperties).filter(
  key => key in arrayBufferPrototype,
);
if (overwrites.length > 0) {
  console.warn(
    `About to overwrite ArrayBuffer.prototype properties ${stringify(overwrites)}`,
  );
}
defineProperties(
  arrayBufferPrototype,
  getOwnPropertyDescriptors(immutableArrayBufferLibProperties),
);
```

The four properties that overwrite genuine prototype methods (`slice`,
`resize`, `transfer`, `transferToFixedLength`) will trigger the
overwrite warning on every load, which is noise.
**Decision: filter the four genuine-overwrite keys out of the warning's
overwrites list, not out of the install loop.**
The install is still load-bearing (the new methods discriminate on
brand membership, the genuine ones do not); the warning is suppressed
for the four because the overwrite is expected and the warning would
otherwise fire on every cold start.
The suppression is implemented as a static `expectedOverwrites` set
with an explanatory comment, and the filter excludes those names
from the `overwrites` list before the `console.warn` check.

**Design departure (recorded post-implementation, barrister panel round 1):**
The four resizable-ArrayBuffer-proposal read accessors (`byteLength`,
`detached`, `maxByteLength`, `resizable`) were originally left off the
`expectedOverwrites` list on the premise that their presence-on-platform
warning was useful diagnostic information.
The premise broke `test-hermes` and `test-xs`: on Hermes and XS the
bundled ses interpreter contexts have no `console` global at all, so
the unguarded `console.warn` reference throws `ReferenceError:
Property 'console' doesn't exist` whenever the `overwrites` list is
non-empty.
On modern Node (>= 19) the four read accessors are always present, so
the list is always non-empty, and the unguarded reference would also
fire on every cold start were `console` not a guaranteed global there.
The implementation expands `expectedOverwrites` to include the four
read accessors (they are expected on modern Node and absent on Hermes /
XS / Node <= 18), and adds a `typeof console !== 'undefined' &&
typeof console.warn === 'function'` guard around the warning call as
defense-in-depth for any future engine without `console`.
The remaining `immutable`, `sliceToImmutable`, `transferToImmutable`
overwrites still surface as warnings on platforms that have
independently shipped part of the proposal's surface, which is the
diagnostic case the warning was designed for.

**Decision: keep master's warn-and-overwrite policy.**
The predecessor experiment branch's
`if (!('sliceToImmutable' in arrayBufferPrototype))` detect-then-skip
is appropriate for the freezable-TypedArray side (where the proposal
is at stage 1 and platforms diverge widely), but for the
immutable-ArrayBuffer side it would mean a half-installed shim on
platforms that ship `sliceToImmutable` natively before the proposal
stabilises.
The warn-and-overwrite policy keeps the shim authoritative until the
proposal reaches stage 4 and the shim is manually retired (per README
line 66's existing guidance).

### Move 5: Drop the `%ImmutableArrayBufferPrototype%` permits entry and intrinsic sampling

Two ses-side files change.

In `packages/ses/src/permits.js`, delete the
`'%ImmutableArrayBufferPrototype%'` block at lines 1393-1412.
The twenty-line entry has no remaining referent: no object in the live
realm now has that prototype, so the permits framework has nothing to
enforce against.

The three lines inside the `%ArrayBufferPrototype%` entry that name
the shim-installed methods (`transferToImmutable: fn`,
`sliceToImmutable: fn`, `immutable: getter` at lines 1385-1387) stay
as-is.
They are still the permits declarations for the methods the shim
installs on the genuine prototype, and those methods still exist after
the redesign.

In `packages/ses/src/get-anonymous-intrinsics.js`, delete lines
170-177 (the throwaway-instance prototype walk that samples
`%ImmutableArrayBufferPrototype%`):

```js
const ab = new ArrayBuffer(0);
const iab = ab.sliceToImmutable();
const iabProto = getPrototypeOf(iab);
if (iabProto !== ArrayBuffer.prototype) {
  intrinsics['%ImmutableArrayBufferPrototype%'] = iabProto;
}
```

With the redesign, `iabProto === ArrayBuffer.prototype` always, so the
conditional body never runs.
Leaving the dead code would be inert but misleading; deletion is the
cleaner outcome and the corresponding permits entry is going away in
the same PR.

The `import '@endo/immutable-arraybuffer/shim.js';` line at
`packages/ses/src/lockdown.js:18` is unchanged.
The shim's install shape is what changes; the trigger is the same.

## Diagram

```mermaid
flowchart LR
  subgraph "Before"
    direction TB
    EB[Emulated immutable buffer] -->|__proto__| IP[ImmutableArrayBufferInternalPrototype]
    IP -->|__proto__| AP1[ArrayBuffer.prototype]
    Shim1[Shim] -->|defineProperties| AP1
    Shim1 -.->|exports| IP
    SES1[SES permits] -->|allows| IP
    GAI1[get-anonymous-intrinsics] -->|samples| IP
  end
  subgraph "After"
    direction TB
    EB2[Emulated immutable buffer] -->|__proto__| AP2[ArrayBuffer.prototype]
    Lib[Lib property record] -.->|copied by shim| AP2
    AP2 -->|methods discriminate via| WM[brand WeakMap]
    EB2 -.->|registered in| WM
  end
```

## Test plan

The existing pony-renamed-to-lib unit tests at
`packages/immutable-arraybuffer/test/immutable-arraybuffer-lib-slice.test.js`
and `immutable-arraybuffer-lib-transfer.test.js` continue to cover the
lib layer in isolation.
Their bodies need three categories of update:

- The import path changes (`-pony.js` to `-lib.js`).
- The free-function `sliceBufferToImmutable` and
  `transferBufferToImmutable` calls that the tests perform under "the
  pony works without the shim" coverage become calls to the new
  internal helpers (which are still imported by the test directly
  from the lib module via a `// @ts-ignore` if needed, since they are
  not publicly exported).
  Alternatively, the tests are restructured to install the shim first
  and then exercise the methods via `buf.sliceToImmutable(...)` rather
  than as free functions; this is the cleaner shape because it matches
  the post-redesign call shape that callers use.
- The brand-check assertions that today expect
  `Object.getPrototypeOf(immuAB) === immutableArrayBufferPrototype`
  instead expect `Object.getPrototypeOf(immuAB) === ArrayBuffer.prototype`
  and `immuAB.immutable === true`.

New tests cover the amplifier-with-this-fallthrough behaviour
explicitly:

- `genuine ArrayBuffer.prototype.slice on a genuine buffer behaves
  unchanged` (the post-shim `slice` is the override; the test asserts
  it delegates to the captured genuine `slice` on fallthrough).
- `genuine ArrayBuffer.prototype.resize on a genuine resizable buffer
  behaves unchanged` (same shape, for the resizable proposal).
- `genuine ArrayBuffer.prototype.transfer on a genuine buffer behaves
  unchanged`.
- `emulated immutable.resize throws TypeError` (the brand-check
  discriminates on WeakMap membership).
- `Object.prototype.toString.call(immuAB) === '[object ArrayBuffer]'`
  (documents the purposeful-violation removal).

The package's existing `test/test-shim.js` (or equivalent shim-level
integration test) extends with the shim-install-onto-genuine-prototype
assertions:

- After `import './shim.js';`, `'sliceToImmutable' in
  ArrayBuffer.prototype === true`.
- The four overwrite warnings (`slice`, `resize`, `transfer`,
  `transferToFixedLength`) do *not* fire (the expected-overwrite
  suppression list filters them).
- The `immutable` overwrite warning *does* fire on platforms where the
  genuine `immutable` accessor has not yet shipped (today: all
  platforms, because the proposal is pre-stage-4).

The ses-side change has its own test plan: the existing
`packages/ses/test/permits-intrinsics.test.js` (or whichever permits
test exists) is exercised against a post-shim realm and asserts that
`'%ImmutableArrayBufferPrototype%'` no longer appears in the intrinsics
map, and that an existing fixture that tested the
intermediate-prototype's reachability via permits is either deleted
(if its only purpose was that intrinsic) or rewritten to assert the
new shape.

## Alternatives considered

- **Keep the pseudo-prototype, only do the rename.**
  Considered and rejected.
  The maintainer's framing in the dispatch and erights's redesign
  comment on the predecessor are explicit that the pseudo-prototype
  layer itself is the artifact to remove.
  A rename-only PR would still leave the
  `%ImmutableArrayBufferPrototype%` intrinsic, the permits entry, and
  the two-surface README story in place.
- **Remove the lib layer entirely and inline everything into the shim.**
  Considered and rejected.
  The lib layer has a load-bearing purpose distinct from the shim:
  it owns the `buffers` WeakMap, the `makeImmutableArrayBufferInternal`
  factory, the platform-feature detection
  (`optTransfer`/`optStructuredClone`), and the brand check.
  Hoisting all of that into the shim file would mean a single
  ~350-line file rather than two ~250+~100-line files, and would
  break the "library importable without forcing the shim" use case
  that `isBufferImmutable` supports.
  Keep the split; change what crosses the boundary.
- **Detect-then-skip shim install policy.** Considered and rejected
  for the reason given in *Move 4*: native `sliceToImmutable` ahead of
  proposal stage 4 is more likely to be a partial or divergent
  implementation than a stable one, and warn-and-overwrite keeps the
  shim authoritative until the manual retirement step that README
  line 66 anticipates.

## Open questions

The redesign is implementable from this document.
The questions below are framing or scope calls that the maintainer may
want to revisit before the builder lands, but none of them block the
builder from making a defensible choice.

- **Premise-2 as part of this PR versus as a separate prerequisite.**
  The redesign as written assumes the package still exports `.`
  (today's shape).
  The predecessor experiment branch's commit `a5e31162` narrows the
  package's `exports` to only `./shim.js` (premise-2 from the
  six-premises framing tracked in the project log).
  This design *does not* fold premise-2 in: it keeps `index.js` and
  the `.` export, narrowed to `isBufferImmutable` only.
  The argument for folding premise-2 in now is fewer round-trip PRs;
  the argument against is keeping each PR's diff scoped to one
  semantic change.
  The builder follows this design's choice (premise-2 out of scope)
  unless the maintainer redirects.
- **CHANGELOG rewrite scope.**
  This design leaves the historical `CHANGELOG.md:18` entry untouched.
  The conservative-rewrite reading of "rename all occurrences of 'pony'"
  is also defensible.
  The builder follows this design's choice (leave historical) unless
  the maintainer redirects in the design PR review.
- **`packages/ses/DESIGN.md` companion file.**
  The ses-side changes (permits entry deletion, intrinsics sampling
  deletion) are small enough that this design captures them in
  *Move 5* and does not warrant a separate `packages/ses/DESIGN.md`.
  If `packages/ses/` later accumulates DESIGN.md sections for other
  architectural threads, the permits-removal note can be folded in
  there at that time.
- **TypedArray-side parallel work.**
  This design's scope is the ArrayBuffer side only.
  The freezable-TypedArray pseudo-prototype drop (the analogous move
  for `%TypedArrayPrototype%`) is on the predecessor experiment branch
  and is structurally similar but not identical (TypedArrays have a
  richer pseudo-constructor story and a separate `internal-heir.js`
  helper).
  It lands as a separate PR with its own DESIGN.md once this
  ArrayBuffer-side work merges and the patterns are validated against
  the genuine `%TypedArrayPrototype%` permits entry.

## Out of scope

- The TypedArray-side analog (drop `%FreezableTypedArrayPrototype%`
  similarly).
  Separate PR, separate design.
- The premise-2 narrowing of the package's `exports`.
  Separate PR.
- Migrating `packages/bytes/src/to-immutable.js` from the lib free
  function to the shim'd method.
  Folds into the premise-2 PR, since the bytes-side change is what
  makes the `.` export retirable.
- Retiring the `concordance` purposeful-violation note in the README.
  Originally framed as an "out of scope" item on the premise that the
  README rewrite would retire the behaviour; the design departure
  recorded in *Move 2* paragraph 7 reverses that premise (the slot
  remains as an own-property on emulated immutables).
  The README's *Purposeful Violation* section is restored under
  *Move 2* and describes the new own-property-only shape rather than
  the prior intermediate-prototype shape.

## References

- erights's redesign comment on the predecessor pull request: the framing this document expands. The exact comment identifier and the maintainer's authorization comment are recorded in the project log alongside this design's authoring dispatch.
- The six-premises framing pull request: this redesign realises premise 1 (drop the intermediate prototype) and leaves premise 2 (narrow the `exports` surface) for a follow-up PR.
- The predecessor experiment branch (`experiment/no-spackle-immutable-arraybuffer-417` on the upstream): the experimental working pattern for the freezable TypedArray side, whose amplifier-with-this-fallthrough discipline this design adopts for the ArrayBuffer side. Translatable commits: `e02ec0d08` (shim install body), `721c68a3` (initial pony scaffolding to translate).
- `packages/module-source/DESIGN.md`: the only other in-package DESIGN.md in the tree; structural precedent for what a package-rooted DESIGN.md looks like.
- `docs/spackle.md`: the polyfill + ponyfill + race-discipline doc; the "no-spackle" framing in the experiment branch's name signals this redesign's commitment to the simpler discipline.
