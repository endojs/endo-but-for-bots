# `@endo/immutable-arraybuffer` design notes

This document collects the design discussion that motivated the
ponyfill, the shim, and the integration with `@endo/bytes` as a
spackle. The user-facing API lives in
[`README.md`](./README.md). Consumers do not need to read this
file; reviewers and contributors do.

## Background

Prior proposals
[In-Place Resizable and Growable `ArrayBuffer`s](https://github.com/tc39/proposal-resizablearraybuffer)
and
[ArrayBuffer.prototype.transfer and friends](https://github.com/tc39/proposal-arraybuffer-transfer)
have both reached stage 4. As a result, `ArrayBuffer.prototype`
now has the following methods:

- `transfer(newByteLength?: number) : ArrayBuffer` — move the
  contents of the original buffer to a new buffer, detach the
  original, and return the new buffer. The new buffer is as
  resizable as the original was.
- `transferToFixedLength(newByteLength?: number) : ArrayBuffer` —
  like `transfer` but the new buffer is not resizable.
- `resize(newByteLength: number) : void` — change the size of
  this buffer if possible, or throw otherwise.
- `slice(start?: number, end?: number) : ArrayBuffer` — return a
  new buffer whose initial contents are a copy of that region of
  the original buffer. The original buffer is unmodified.

and the following read-only accessor properties:

- `detached: boolean` — is this buffer detached, or are its
  contents still available?
- `resizable: boolean` — can this buffer be resized?
- `byteLength: number` — how big are the current contents?
- `maxByteLength: number` — how big could this buffer be resized
  to be?

None of these operations enable the creation of an immutable
buffer (a non-detached buffer whose contents cannot be changed,
resized, or detached).

A `DataView` object and a `TypedArray` object are both views
into a buffer backing store. For a `TypedArray`, the contents of
the backing store appear as indexed data properties that reflect
the current contents. Because the contents can change,
`TypedArray`s cannot be frozen.

Some JavaScript implementations (Moddable XS, for example) bring
JavaScript to embedded systems where ROM is more plentiful than
RAM. These systems place voluminous fixed data into ROM, and
currently do so using semantics outside the official JavaScript
standard.

The [OCapN](https://ocapn.org/) network protocol treats strings
and byte-arrays as distinct forms of bulk data to be transmitted
by copy. At JavaScript endpoints (`@endo/pass-style`,
`@endo/marshal`), JavaScript strings represent OCapN strings; the
immutability of strings reflects their by-copy nature. Reflecting
an OCapN byte-array well into JavaScript requires an immutable
container of bulk binary data. There currently is none. An
immutable `ArrayBuffer` would provide exactly the low-level
machinery this needs.

## The proposal's shape

The
[Immutable ArrayBuffer](https://github.com/tc39/proposal-immutable-arraybuffer)
proposal introduces additional methods and read-only accessor
properties on `ArrayBuffer.prototype` that fit naturally into
those above. Just as a buffer can be resizable or not, this
proposal lets buffers be immutable or not. Just as
`transferToFixedSize` moves the contents into a non-resizable
buffer, the proposal provides a transfer that moves the contents
into an immutable buffer.

Additions to `ArrayBuffer.prototype`:

- `transferToImmutable() : ArrayBuffer` — move the contents into
  a new immutable buffer, detach the original, return the new
  buffer.
- `immutable: boolean` — read-only accessor returning whether
  the buffer is immutable.

An immutable buffer cannot be detached or resized.
`maxByteLength === byteLength`. A `DataView` or `TypedArray`
using an immutable buffer as its backing store can be frozen and
immutable. `ArrayBuffer`s, `DataView`s, and `TypedArray`s that
are frozen and immutable could be placed in ROM without going
beyond JavaScript's official semantics.

## Ponyfill design

The proposal would add methods to `ArrayBuffer.prototype`. A
ponyfill cannot, by definition, do so. Instead, the ponyfill
exports two functions corresponding to the two proposal
additions:

- `transferBufferToImmutable(buffer: ArrayBuffer) : ArrayBuffer`
- `isBufferImmutable(buffer: ArrayBuffer) : boolean`

In order for `transferBufferToImmutable` to return something of
type `ArrayBuffer` that is actually immutable, the returned
object cannot be an actual `ArrayBuffer` exotic object. Instead,
an emulated immutable buffer implements the full proposed
`ArrayBuffer` API and inherits from `ArrayBuffer.prototype`.
`x instanceof ArrayBuffer` continues to hold.

The emulated immutable buffers inherit directly from an
intermediate prototype called `immutableArrayBufferPrototype`.
This intermediate prototype contains all the methods and
accessor properties proposed here, plus overrides of the
inherited ones as needed to emulate immutability. For each
emulated immutable buffer, the implementation encapsulates a
genuine `ArrayBuffer` it has exclusive access to, so it can
enforce immutability simply by never modifying it.

## Freezable TypedArray ponyfill

A companion ponyfill for *freezable virtual TypedArrays* lives
inside `@endo/bytes` at
[`packages/bytes/src/freezable-typedarray-pony.js`](../bytes/src/freezable-typedarray-pony.js).
The motivation parallels the immutable `ArrayBuffer`: a
`TypedArray` view onto an immutable buffer would itself be
observably immutable, but the language does not yet permit a
real `TypedArray` exotic object to be frozen. The ponyfill
provides emulated views that present the proposed observable
shape on top of an emulated immutable backing store.
The ponyfill reaches into this package's encapsulated
`hiddenBuffers` and `reverseHiddenBuffers` WeakMaps via a
deliberately narrow private subpath
(`@endo/immutable-arraybuffer/private-for-bytes.js`) so the
ponyfill can recognize and unwrap emulated immutable buffers
without exposing the encapsulation to any other consumer.

Two callable exports:

- `makePseudoTypedArrayConstructor(OriginalConstructor)` returns
  a constructor that, when called with an emulated immutable
  `ArrayBuffer` as its sole argument, returns a freezable view
  whose prototype overrides the `TypedArray` mutators to throw
  and whose `buffer` accessor returns the emulated immutable
  buffer. When called with any other argument list it falls
  through to `OriginalConstructor`, so callers can use a single
  constructor uniformly across mutable and immutable buffers.
- `virtualTypedArrayBufferGetter` is a `buffer`-getter function
  suitable for installation as the replacement of
  `TypedArray.prototype.buffer` by a shim. It transparently
  returns the emulated immutable buffer for emulated freezable
  views and the genuine buffer for genuine views.

The `*Internal` prototype, the brand-check `WeakMap`, and the
`getHiddenTypedArray` accessor are deliberately not exported.

These exports are an **internal seam** consumed by `@endo/bytes`'s
spackle install (which is the application-facing path). New
callers should reach for `@endo/bytes`, not directly for
`makePseudoTypedArrayConstructor`. The seam exists because the
spackle's install needs a per-realm constructor factory; the
constructor itself is registered at a registered symbol on each
TypedArray constructor by the spackle.

## `@endo/bytes` as a spackle

The [spackle](https://docs.endojs.org/documents/spackle.html)
pattern describes a module that installs a behavior on a shared
intrinsic at a registered symbol and exports an ergonomic
callable. The first instance to load wins the race; subsequent
instances find the property already defined and call through.
`@endo/harden` is the canonical example:
`Object[Symbol.for('harden')]` is the rendezvous; the ergonomic
`harden` is the export.

`@endo/bytes` becomes the **spackle front** for three families of
behavior that this package and its consumers need uniformly
across realms, regardless of whether the immutable-`ArrayBuffer`
shim is installed and regardless of whether `lockdown` has run:

- **Immutable `ArrayBuffer` operations** (`bytesToImmutable`,
  `bytesFromImmutable`, `concatImmutables`). The spackle install
  puts the immutable-slice operation at
  `ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')]`
  and the round-trippable wrapping operations at companion
  symbols.
- **Frozen `TypedArray`s backed by immutable `ArrayBuffer`s**.
  The spackle install puts the freezable `TypedArray`
  constructor at `Ctor[Symbol.for('freezableConstructor')]` for
  each TypedArray constructor `Ctor`. The result is one
  freezable constructor per realm; eval twins agree.
- **Text-codec workarounds for immutable buffers**. The spackle
  captures `TextEncoder` and `TextDecoder` once at module load
  and installs codec adapters at registered symbols on
  `Uint8Array`. The capture-on-intrinsic guarantee is
  load-bearing: a compartment global endowment that later
  replaces `TextDecoder` on `globalThis` does not redirect the
  spackle's behavior.

### Symbol rendezvous shape

Per the maintainer's pattern (review 4423421007), the symbols
sit on the relevant intrinsic rather than on `Object`. The
intrinsic is the one whose prototype best describes the
operation: the immutable-slice operation belongs on
`ArrayBuffer.prototype`; the freezable view construction and
text-codec operations belong on `Uint8Array` (the constructor
itself, so the symbol can be installed on the realm's
`Uint8Array` primordial before any view is materialized).

| Rendezvous | Operation |
|---|---|
| `ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')]` | Immutable-slice |
| `ArrayBuffer.prototype[Symbol.for('transferBufferToImmutable')]` | Optional immutable-transfer |
| `ArrayBuffer[Symbol.for('concatImmutables')]` | Concatenate immutables |
| `Uint8Array[Symbol.for('toUtf8String')]` | UTF-8 decode |
| `Uint8Array[Symbol.for('fromUtf8String')]` | UTF-8 encode |
| `Uint8Array[Symbol.for('bytesFromImmutable')]` | Immutable->mutable copy |
| `Ctor[Symbol.for('freezableConstructor')]` | Per-realm freezable `TypedArray` constructor for each TypedArray `Ctor` |

The symbol-on-constructor placement (rather than on a prototype)
for the codec operations was chosen so a compartment global
endowment that later replaces `TextDecoder` on `globalThis`
cannot redirect the install. The spackle captures the primordial
at load time; the registered symbol on the constructor is the
lookup path; the endowment of `globalThis.TextDecoder` does not
reach into the registered symbol on the realm's primordial.

The exact symbol names are subject to coordination with the TC39
proposal authors and with the upstream `@endo/harden` precedent;
the symbol-on-intrinsic discipline is the load-bearing decision
and the names are a follow-up question.

### Required changes to `@endo/ses` permits

The registered symbols on `ArrayBuffer.prototype`, on
`Uint8Array`, and on the other TypedArray constructors must be
admitted by SES's permits table. Without the admission,
lockdown's whitelist-enforcement phase removes them and the
spackle's post-lockdown behavior diverges from its pre-lockdown
behavior.

The lockdown-vs-shim discipline:

- **Without lockdown**: the spackle install runs as ordinary
  `Object.defineProperty` on the realm's intrinsic. `@endo/bytes`
  works against the bare intrinsic.
- **With lockdown, without the immutable-`ArrayBuffer` shim**:
  the spackle install runs *before* `lockdown()` so the
  registered symbols are in place when the whitelist-enforcement
  phase observes them. Permits list the symbols. The
  immutable-`ArrayBuffer` operations come from the spackle (via
  the ponyfill); the methods on `ArrayBuffer.prototype`
  (`sliceToImmutable`, `transferToImmutable`, `immutable`) are
  absent because the shim is not installed.
- **With lockdown, with the immutable-`ArrayBuffer` shim**: the
  shim's installer puts the proposal's methods on
  `ArrayBuffer.prototype` *and* installs at the spackle's
  registered symbol; `@endo/bytes` prefers the standard install.
  Permits list both the spackle's symbols and the shim's added
  methods.

### What does not change

- The public API surface of `@endo/bytes` is unchanged. Callers
  continue to write
  `import { bytesToImmutable } from '@endo/bytes/to-immutable.js';`
  and get a callable that does the right thing. The spackle is a
  property of *how the implementation is shared across eval
  twins*, not of how the package presents itself to consumers.
- No new dependencies.
- Existing tests continue to work. The spackle install is
  idempotent: the first loader wins, subsequent loaders adopt
  the install.

## ESLint rule

The portability concern that motivates the spackle has a
static-analysis counterpart: a program that reaches directly for
`new TextEncoder()`, `new TextDecoder()`,
`new Uint8Array(...)`, or `new ArrayBuffer(...)` bypasses the
spackle. The bypass is silent (the code runs) but forfeits the
realm-wide single-source-of-truth and the lockdown-time
guarantee.

`@endo/eslint-plugin` ships
`@endo/no-direct-codec-or-typedarray-constructor`, a rule that:

- Forbids direct use of the codec and TypedArray constructors
  named above (and `ArrayBuffer` used as a `NewExpression`
  callee).
- Whitelists `@endo/bytes`'s shared capture-at-module-init
  helpers (`packages/bytes/src/install-helpers.js`), the
  freezable-typedarray-pony module
  (`packages/bytes/src/freezable-typedarray-pony.js`), and the
  immutable-ArrayBuffer pony-internal capture site by path
  suffix.
- Provides fix-it hints mapping each forbidden identifier to its
  `@endo/bytes` equivalent.
- Defaults to severity `warn`; downstream packages that consume
  `@endo/bytes` end-to-end may opt into `error`.

## XS / Node.js parity test strategy

The *Immutable ArrayBuffer* proposal is a shape contract: the
same buffer-creation, view-construction, and frozen-view-mutator
rejection sequence should behave the same way regardless of
which JavaScript engine is running it. Two of Endo's target
engines, Moddable XS and Node.js, are the most demanding pair
because XS will use the proposal natively on devices where
ROM-backed buffers are first-class, and Node.js hosts most of
the testing.

To verify parity by construction rather than by prose, the
package follows the parity-test pattern landed elsewhere in the
monorepo (`packages/compartment-mapper/test/cycle-rename*`,
`packages/compartment-mapper/test/cycle-cjs-reexporter*`): a
shared fixture and shared assertions module exercised by an
XS-side test and a Node-side test, both calling the same
expectations.

Proposed layout:

- `packages/immutable-arraybuffer/test/_immutable-arraybuffer-assertions.js`
  exporting `assertImmutableArrayBufferShape(t, ponyfill, env)`
  and `assertFreezableTypedArrayShape(t, ponyfill, env)`.
- `packages/immutable-arraybuffer/test/_immutable-arraybuffer-fixture.js`
  building a source buffer from a fixed byte sequence so both
  runners agree on the values to assert.
- `packages/immutable-arraybuffer/test/parity-node.test.js`
  importing the package's ponyfill exports, the fixture, and the
  shared assertions (Ava-side).
- `packages/immutable-arraybuffer/test/_xs.js`, an XS-side entry
  point modeled on `packages/ses/test/_xs.js`, using the same
  shared assertions and fixture; `print('ok')` reports overall
  success.
- `packages/immutable-arraybuffer/scripts/generate-test-xs.js`
  bundling `_xs.js` with the ponyfill source via
  `@endo/compartment-mapper` (`xs` tag). The resulting
  `tmp/test-xs.js` is executed by `xst` from the Moddable SDK.
- A `test:xs` script entry in this package's `package.json`
  pointing at the XS-side runner.

Once the `@endo/bytes` spackle lands, the parity tests extend to
exercise the four lockdown-vs-shim combinations: with/without
lockdown crossed with with/without the immutable-`ArrayBuffer`
shim. The Node side iterates the four combinations as separate
Ava tests; the XS side iterates them in `_xs.js`. Shared fixtures
cover byte sequences; shared assertions cover observable
behavior.

Implementation of the XS-side runner is deferred: it requires
Moddable SDK toolchain familiarity, the `xst` binary, and the
generation pipeline scaffolding already in place for `@endo/ses`
and `@endo/module-source`. The Node-side test pair and the
shared modules are reachable as a follow-up without the XS
toolchain dependency.

## Migration path

The migration is non-breaking for callers:

1. Land the install code in `@endo/bytes`'s
   immutable-aware modules and in the text-codec modules. The
   exported function names and signatures do not change. The
   freezable `TypedArray` constructor lives in `@endo/bytes` at
   `packages/bytes/src/freezable-typedarray-pony.js`; it consumes
   `hiddenBuffers`, `reverseHiddenBuffers`, and
   `FERAL_GET_ARRAY_BUFFER` from the narrow private subpath
   `@endo/immutable-arraybuffer/private-for-bytes.js`.
2. Land the SES permits update admitting the registered symbols.
3. Land the ESLint rule that forbids direct use of
   `TextEncoder`, `TextDecoder`, the `TypedArray` constructors,
   and `new ArrayBuffer()`.
4. Update consumer documentation to describe the rendezvous
   symbols and the call-through semantics, with a forward
   reference to the proposed TC39 standardization once that
   conversation is open.

Existing dependents (`@endo/marshal`, `@endo/pass-style`, vat
infrastructure) keep working without code changes. They benefit
from the realm-wide single-source-of-truth automatically.

## Follow-up dispatches

The implementation lives in the named packages:

- `@endo/bytes`: the spackle install dance for the six
  operations. `makePseudoTypedArrayConstructor` migrates from
  public to internal as the spackle becomes the public surface.
- `@endo/eslint-plugin`: the
  `no-direct-codec-or-typedarray-constructor` rule.
- `@endo/ses`: the permits update admitting the registered
  symbols on `ArrayBuffer.prototype`, on `ArrayBuffer`, on
  `Uint8Array`, and on the other TypedArray constructors.
- XS-side parity runner wiring: deferred; requires Moddable SDK
  toolchain.

Each follow-up is a separate PR with a separate review cycle.

## Authority structure

Default technical authority on this proposal rests with the
maintainer of `endojs/endo`. The TC39 proposal champion
(Mark S. Miller, erights) is the senior contributor for the
shape question and the SES integration. Reviewer comments on
this package's PRs should be read with that authority structure
in mind.
