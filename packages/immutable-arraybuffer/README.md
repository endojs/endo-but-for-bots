# `@endo/immutable-arraybuffer`

This `@endo/immutable-arraybuffer` package provides both a ponyfill and a shim for a proposed new JavaScript feature: *Immutable ArrayBuffers*.
- A ponyfill just defines and exports new things without modifying old things. The `index.js` file implements the ponyfill, providing the exports of the unqualified `@endo/immutable-arraybuffer` package.
- A shim modifies the existing JavaScript primordials as needed to most closely emulate the feature as proposed. The `shim.js` file uses the exports from `index.js` to modify `ArrayBuffer.prototype` to resemble the API being proposed. Importing `@endo/immutable-arraybuffer/shim.js` will cause these changes.

Below, we use the term "buffer" to refer informally to an instance of an `ArrayBuffer`, whether immutable or not.

## Background

Prior proposals [In-Place Resizable and Growable `ArrayBuffer`s](https://github.com/tc39/proposal-resizablearraybuffer) and [ArrayBuffer.prototype.transfer and friends](https://github.com/tc39/proposal-arraybuffer-transfer) have both reached stage 4, and so are now an official part of JavaScript. Altogether, `ArrayBuffer.prototype` now has the following methods:
- `transfer(newByteLength?: number) :ArrayBuffer` -- move the contents of the original buffer to a new buffer, detach the original buffer, and return the new buffer. The new buffer will be as resizable as the original was.
- `transferToFixedLength(newByteLength?: number) :ArrayBuffer` -- like `transfer` but the new buffer is not resizable.
- `resize(newByteLength: number) :void` -- change the size of this buffer if possible, or throw otherwise.
- `slice(start?: number, end?: number) :ArrayBuffer` -- Return a new buffer whose initial contents are a copy of that region of the original buffer. The original buffer is unmodified.

and the following read-only accessor properties
- `detached: boolean` -- is this buffer detached, or are its contents still available from this buffer object?
- `resizable: boolean` -- can this buffer be resized, or is it fixed-length?
- `byteLength: number` -- how big are the current contents of this buffer?
- `maxByteLength: number` -- how big could this buffer be resized to be?

None of the operations above enable the creation of an immutable buffer, i.e., a non-detached buffer whose contents cannot be changed, resized, or detached.

Both a `DataView` object and a `TypedArray` object are views into a buffer backing store. For a `TypedArray` object, the contents of the backing store appear as indexed data properties of the `TypeArray` object that reflect the current contents of this backing store. Currently, because there is no way to prevent the contents of the backing store from being changed, `TypedArray`s cannot be frozen.

Some JavaScript implementations, like Moddable XS, bring JavaScript to embedded systems, like device controllers, where ROM is much more plentiful and cheaper than RAM. These systems need to place voluminous fixed data into ROM, and currently do so using semantics outside the official JavaScript standard.

The [OCapN](https://ocapn.org/) network protocol treats strings and byte-arrays as distinct forms of bulk data to be transmitted by copy. At JavaScript endpoints speaking OCapN such as `@endo/pass-style` + `@endo/marshal`, JavaScript strings represent OCapN strings. The immutability of strings in the JavaScript language reflects their by-copy nature in the protocol. Likewise, to reflect an OCapN byte-array well into the JavaScript language, we need an immutable container of bulk binary data. There currently are none. An Immutable `ArrayBuffer` would provide exactly the low-level machinery we need.

## Overview of the *Immutable ArrayBuffer* Proposal

The *Immutable ArrayBuffer* proposal introduces additional methods and read-only accessor properties to `ArrayBuffer.prototype` that fit naturally into those explained above. Just as a buffer can be resizable or not, or detached or not, this proposal enables buffers to be immutable or not. Just as `transferToFixedSize` moves the contents of a original buffer into a newly created non-resizable buffer, this proposal provides a transfer operation that moves the contents of an original original buffer into a newly created immutable buffer. Altogether, this proposal only adds to `ArrayBuffer.prototype` one method
- `transferToImmutable() :ArrayBuffer` -- move the contents of the original buffer into a new immutable buffer, detach the original buffer, and return the new buffer.

and one read-only accessor
- `immutable: boolean` -- is this buffer immutable, or can its contents be changed?

An immutable buffer cannot be detached or resized. Its `maxByteLength` is the same as its `byteLength`. A `DataView` or `TypedArray` using an immutable buffer as its backing store can be frozen and immutable. `ArrayBuffer`s, `DataView`s, and `TypedArray`s that are frozen and immutable could be placed in ROM without going beyond JavaScript's official semantics.

## The Ponyfill

The proposal would add methods to `ArrayBuffer.prototype`. But a ponyfill, by definition, cannot do so. Instead, it defines and exports two functions corresponding to the two additions above
- `transferBufferToImmutable(buffer: ArrayBuffer) :ArrayBuffer`
- `isBufferImmutable(buffer: ArrayBuffer) :boolean`

In order for `transferBufferToImmutable` to be able to return something of type `ArrayBuffer` that is actually immutable, that object cannot be an actual `ArrayBuffer` exotic object. Instead, an emulated immutable buffer implements the full proposed `ArrayBuffer` API and ultimately inherits from `ArrayBuffer.prototype`. Thus, `x instanceof ArrayBuffer` will act as proposed.

The emulated immutable buffers inherit directly from an intermediate prototype we refer to as `immutableArrayBufferPrototype`. This intermediate prototype contains all the methods and read-only accessor properties proposed here, as well as overrides of those inherited from `ArrayBuffer.prototype` as needed to emulate the behavior of an immutable instance. For each emulated immutable buffer, the implementation encapsulates a genuine `ArrayBuffer` that it has exclusive access to, so it can enforce immutability simply by never modifying it.

## The Freezable TypedArray Ponyfill

The package also provides a companion ponyfill for *freezable virtual TypedArrays*, currently exposed as `freezable-typedarray-pony.js`. The motivation parallels the immutable `ArrayBuffer`: a `TypedArray` view onto an immutable buffer would itself be observably immutable, but the language does not yet permit a real `TypedArray` exotic object to be frozen. The ponyfill provides emulated views that present the proposed observable shape on top of an emulated immutable backing store.

The freezable-`TypedArray` machinery is the *implementation* of the proposal's shape. Application code should reach for it through `@endo/bytes`, not directly: see "Ramifications for `@endo/bytes` as a Spackle" below for the spackle pattern that ensures one freezable `TypedArray` constructor per realm, an idiomatic import surface, and an ESLint rule that discourages reaching for the bare constructors. The exports listed below are scheduled to become module-internal once the spackle lands; new callers should treat `@endo/bytes` as the public surface.

Two callable exports are currently available:
- `makePseudoTypedArrayConstructor(OriginalConstructor)` returns a constructor that, when called with an emulated immutable `ArrayBuffer` as its sole argument, returns a freezable view whose prototype overrides the `TypedArray` mutators to throw and whose `buffer` accessor returns the emulated immutable buffer. When called with any other argument list it falls through to `OriginalConstructor`, so callers can use a single constructor uniformly across mutable and immutable buffers. Once the spackle lands in `@endo/bytes`, this export is expected to be internalized: the public path will be `@endo/bytes`, which will install one constructor at a realm-wide registered symbol and prefer it on subsequent loads.
- `virtualTypedArrayBufferGetter` is a `buffer`-getter function suitable for installation as the replacement of `TypedArray.prototype.buffer` by a shim. It transparently returns the emulated immutable buffer for emulated freezable views and the genuine buffer for genuine views.

The `*Internal` prototype, the brand-check `WeakMap`, and the `getHiddenTypedArray` accessor are deliberately not exported: the ponyfill keeps the emulation's encapsulation just as the immutable-`ArrayBuffer` ponyfill keeps `hiddenBuffers` private to the package. Callers should construct freezable views only through `@endo/bytes` once the spackle lands, and through `makePseudoTypedArrayConstructor` in the interim.

## Using the Ponyfills Across Native and Shim

The recommended public path is **`@endo/bytes`**, which presents the spackle front for immutable `ArrayBuffer`s, frozen `TypedArray`s backed by them, and the text-codec workarounds needed when those buffers cross `TextEncoder`/`TextDecoder`. Reaching directly for `@endo/immutable-arraybuffer`'s ponyfill exports (and for `freezable-typedarray-pony.js`) remains supported, but it is the *implementation surface*, not the *application surface*. The spackle pattern documented under "Ramifications for `@endo/bytes` as a Spackle" below makes the realm-wide single-source-of-truth and the ESLint-enforced idiomatic usage automatic for callers that consume `@endo/bytes`.

The shim is opt-in. A program that wants to reach for `arrayBuffer.sliceToImmutable(...)` and the other proposal methods directly on `ArrayBuffer.prototype` imports `@endo/immutable-arraybuffer/shim.js` at startup; a program that consumes `@endo/bytes` does not need the shim, because the spackle calls through to the registered symbol on the intrinsic when present and falls back to the ponyfill when absent. Both paths are exercised by the cross-runner parity tests described under "Proposed XS / Node.js Parity Tests" below: with and without lockdown, with and without the shim, on both Node and XS.

A program that wants to be source-compatible with both a future native implementation of the *Immutable ArrayBuffer* proposal and the present-day shim should import the ponyfill's named exports (or, preferably, `@endo/bytes`'s named exports) rather than reaching for the methods on `ArrayBuffer.prototype`. The ponyfill's exports fall through to the native methods when present and emulate them when absent, so the calling code does not need to detect which case it is in.

The canonical idiom for the implementation surface is:

```js
import {
  sliceBufferToImmutable,
  isBufferImmutable,
  // optTransferBufferToImmutable may be undefined on
  // platforms that lack both structuredClone and
  // ArrayBuffer.prototype.transfer (Node <= 16, some
  // JavaScriptCore versions, Hermes). Guard the import
  // site if your code path is reachable there.
  optTransferBufferToImmutable,
} from '@endo/immutable-arraybuffer';

const ab = new ArrayBuffer(8);
new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);

const immutable = sliceBufferToImmutable(ab);
isBufferImmutable(immutable); // true

if (optTransferBufferToImmutable) {
  const transferred = optTransferBufferToImmutable(ab);
  isBufferImmutable(transferred); // true
}
```

The application-surface equivalent is to reach for `@endo/bytes`'s named exports. The recommended import-and-use shape is:

```js
import {
  bytesToImmutable,
  bytesFromImmutable,
  bytesFromText,
  bytesToText,
  concatImmutables,
} from '@endo/bytes';

const buffer = bytesToImmutable(bytesFromText('hello'));
// buffer is an immutable ArrayBuffer.
const text = bytesToText(bytesFromImmutable(buffer));
// text === 'hello'; the round trip never touches a writable buffer.
```

The ESLint rule shipped from `@endo/eslint-plugin` (see "Forbidding direct use via eslint-plugin" below) discourages reaching for `new TextEncoder()`, `new TextDecoder()`, the `TypedArray` constructors (`Uint8Array`, `Uint16Array`, and friends), and `new ArrayBuffer()` directly. Each of these has a `@endo/bytes` equivalent that captures the underlying primordial once at module load and forwards to the realm-wide spackle install, so eval twins, lockdown, and the immutable-`ArrayBuffer` shim agree on the observable shape.

The corresponding pattern for freezable virtual `TypedArrays` is, at the implementation surface, to build a constructor once per realm and use it everywhere a `TypedArray` view is wanted, regardless of whether the backing buffer is mutable or immutable. The spackle pattern moves the once-per-realm install to a registered symbol on the intrinsic; while the spackle is pending, the bare ponyfill exposes the seam:

```js
import { sliceBufferToImmutable } from '@endo/immutable-arraybuffer';
import { makePseudoTypedArrayConstructor } from '@endo/immutable-arraybuffer/freezable-typedarray-pony.js';

const FreezableUint8Array = makePseudoTypedArrayConstructor(Uint8Array);

// Works with a mutable buffer: falls through to Uint8Array.
const mutableView = new FreezableUint8Array(new ArrayBuffer(4));

// Works with an emulated immutable buffer: returns a
// freezable view whose mutators throw.
const immutable = sliceBufferToImmutable(new ArrayBuffer(4));
const frozenView = new FreezableUint8Array(immutable);
```

When the spackle lands in `@endo/bytes`, the equivalent shape becomes:

```js
// Hypothetical post-spackle shape; lands in a follow-up PR
// against @endo/bytes. The application code reaches for
// @endo/bytes's freezable view rather than constructing one
// directly. The single realm-wide installer wins the race;
// subsequent loads of @endo/bytes call through.
import { freezableUint8Array } from '@endo/bytes';
const view = freezableUint8Array(buffer);
```

Two preconditions let the implementation-surface code run the same way under the shim and under a future native implementation:

1. *Either* the program consumes `@endo/bytes` (which calls through the spackle, no shim required), *or* the program imports `@endo/immutable-arraybuffer/shim.js` at startup, *or* it never reaches for `arrayBuffer.sliceToImmutable(...)` and `arrayBuffer.transferToImmutable(...)` and `arrayBuffer.immutable` on a bare `ArrayBuffer`. The ponyfill exports remain a stable interface either way; the methods on `ArrayBuffer.prototype` only exist after the shim runs or after a native implementation ships. A program that wants to be portable should pick one of these disciplines and stay with it. The shim is no longer obligatory: it is opt-in for programs that want the proposal's methods on the bare intrinsic.
2. The program does not assume `x instanceof ArrayBuffer` distinguishes immutable from mutable. Both the proposal and this package's emulated immutable buffers inherit from `ArrayBuffer.prototype`, so they are both instances. The way to ask whether a particular buffer is immutable is `isBufferImmutable(x)` (or `x.immutable` if the shim or a native implementation is in effect).

The same discipline applies to the freezable `TypedArray` ponyfill: import `makePseudoTypedArrayConstructor` (or, once spackled, the `@endo/bytes` equivalent) and use the resulting constructor wherever the program might want to view an immutable buffer; the emulated path and the genuine path agree on the observable shape.

### Detecting and adapting to a native implementation

A program that wants a single hot-path that works regardless of whether the platform has a native `transferToImmutable` (or a native freezable view) can sense it by feature-detecting the ponyfill's optional export and the buffer methods:

```js
import {
  sliceBufferToImmutable,
  isBufferImmutable,
  optTransferBufferToImmutable,
} from '@endo/immutable-arraybuffer';

// Will be defined on Node >= 17 (structuredClone) or
// Node >= 21 (ArrayBuffer.prototype.transfer); undefined
// on platforms that have neither.
const canTransfer = optTransferBufferToImmutable !== undefined;
```

The presence of native `ArrayBuffer.prototype.immutable` on a fresh `new ArrayBuffer(0)` indicates that a native implementation or the shim is in effect:

```js
const hasNativeOrShim = 'immutable' in new ArrayBuffer(0);
```

Programs that prefer not to feature-detect can require the shim at startup (importing `@endo/immutable-arraybuffer/shim.js` from the first module loaded) and treat `arrayBuffer.sliceToImmutable(...)`, `arrayBuffer.transferToImmutable(...)`, and `arrayBuffer.immutable` as available throughout the realm; modern shim practice in this package's caveats below covers what happens when a native implementation later lands underneath the shim.

## Forbidding direct use via eslint-plugin

The portability question that motivates the spackle pattern has a static-analysis counterpart: a program that reaches directly for `new TextEncoder()`, `new TextDecoder()`, `new Uint8Array(...)` (and the other `TypedArray` constructors), or `new ArrayBuffer(...)` bypasses the spackle. The bypass is silent (the code runs), but it forfeits the realm-wide single-source-of-truth (one constructor per realm, one decoder per realm), it forfeits the ESLint-discouraged-vs-encouraged-import audit trail, and it forfeits the lockdown-time guarantee that a compartment endowment cannot override the codec.

`@endo/eslint-plugin` will ship a rule that forbids these direct uses across consumers of the spackle. The rule's shape:

- **Forbidden identifiers.** `TextEncoder`, `TextDecoder`, `Uint8Array`, `Uint16Array`, `Uint32Array`, `Uint8ClampedArray`, `Int8Array`, `Int16Array`, `Int32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`, and `ArrayBuffer` (when used as a `NewExpression` callee).
- **Exception: capturing the intrinsic at module load.** The pattern `const Constructor = globalThis.Constructor;` (or equivalent module-init capture) is allowed at the spackle's install site. The rule whitelists the spackle module itself (`@endo/bytes`, `@endo/immutable-arraybuffer`'s freezable-typedarray-pony) by path or by a per-rule allowlist option, so the spackle's own implementation is not self-flagging.
- **Fix-it suggestions.** The rule surfaces a hint pointing at the `@endo/bytes` equivalent: `new TextEncoder()` becomes `bytesFromText(...)`, `new TextDecoder()` becomes `bytesToText(...)`, `new Uint8Array(buffer)` becomes the spackled freezable equivalent, `new ArrayBuffer(n)` becomes `bytesToImmutable(bytesFromText(''))`-shaped construction for the immutable case (and stays bare for the throwaway-mutable case, which the rule's allowlist will accommodate).
- **Severity.** Default `warn`, opt-in `error` for packages that consume `@endo/bytes` end-to-end.
- **Rationale string.** Each rule emission cites the spackle pattern documented here and the lockdown-time guarantee: a compartment global endowment can replace `TextDecoder` on `globalThis`, but the spackle's installed function on `Uint8Array[Symbol.for('toUtf8String')]` is captured at module load on the realm's primordial, so the endowment override does not redirect the spackle's behavior.

The rule itself, the test fixtures that prove it triggers on the forbidden patterns and does not trigger on the spackle's own capture pattern, and the package's `recommended` config entry are scope for a follow-up PR against `@endo/eslint-plugin`. The README documents the rule's shape so consumers know what to expect and so the follow-up PR's reviewer has the contract to check against.

## The Shim

The immutable-arraybuffer shim additionally adds to `ArrayBuffer.prototype` a
- `transferToImmutable` method trivially derived from the ponyfill's `transferBufferToImmutable`.
- `sliceToImmutable` method trivially derived from the ponyfill's `sliceBufferToImmutable`.
- `immutable` read-only accessor property trivially derived from the ponyfill's `isBufferImmutable`.

## Caveats

The *Immutable ArrayBuffer* shim falls short of the proposal in the following ways
- The ponyfill and shim rely on the underlying platform having either `structuredClone` or `ArrayBuffer.prototype.transfer`. However, Node <= 16 has neither. Node 17 introduces `structuredClone` and Node 21 introduces `ArrayBuffer.prototype.transfer`. Without either, the ponyfill and shim fail to initialize.
- The proposal does not introduce an intermediate prototype, but rather modifies the behavior of the built-in methods on `ArrayBuffer.prototype` itself, to act appropriately on immutable `ArrayBuffer`s. By contrast, the ponyfill's and shim's emulated immutable buffers inherit directly from an intermediate prototype we refer to as `immutableArrayBufferPrototype`. That intermediate prototype directly inherits from `ArrayBuffer.prototype`. All the differential behavior for immutable buffers are provided by overrides found on `immutableArrayBufferPrototype`.
- The `immutableArrayBufferPrototype` intermediate prototype is an artifact of the emulation, but it is not encapsulated. It is trivially discoverable as the object that emulated immutable buffers directly inherit from.
- The shim's emulated immutable buffers are not real `ArrayBuffer` exotic objects. If they were, the shim would not be able to protect them from being written. Even though they implement the full proposed `ArrayBuffer` API, they cannot be plug-compatible -- they cannot be used as the backing stores of `DataView`s or `TypedArray`s. Perhaps follow-on shims might modify `DataView` and `TypedArray` to emulate that as well, but that is hard and beyond the ambition of this ponyfill + shim.
- Unlike genuine `ArrayBuffer` or `SharedArrayBuffer` exotic objects, the shim's emulated immutable buffers cannot be cloned or transfered between JS threads.
- Even after the *Immutable ArrayBuffer* proposal is implemented by the platform, the current code will still replace it with the shim implementation, in accord with shim best practices. See https://github.com/endojs/endo/pull/2311#discussion_r1632607527 . It will require a later manual step to delete the shim, after manual analysis of the compat implications.
- This is a plain *JavaScript* ponyfill/shim, not by itself a *Hardened JavaScript* polyfill/shim. Thus, the objects and function it creates are not hardened by this ponyfill/shim itself. Rather, the ses-shim is expected to import these, and then treat the resulting objects as if they were additional primordials, to be hardened during `lockdown`'s harden phase.

## Purposeful Violation

Since the `ImmutableArrayBufferInternal` class is only an artifact of the ponyfill and shim (i.e., is absent both from the real proposal and from native implementations), `ImmutableArrayBufferInternal` should not need its own `Symbol.toStringTag` property. Especially not one that differs from `ArrayBuffer.prototype`. Adding one reduces the fidelity of the ponyfill and shim. Nevertheless, we set `ImmutableArrayBufferInternal.prototype[Symbol.toStringTag]` to `'ImmutableArrayBuffer'`. Why?

At https://github.com/concordancejs/concordance/blob/791d2a89b40eb13f2c889ac270dd8be190cf8073/lib/describe.js#L36 Node's concordance, in order to render diagnostic output for an object, sniffs the result of `toString()`. If the result seems to indicate that the object is an ArrayBuffer, then concordance assumes it can do things with the object (`Buffer.from`) that can only be done on genuine ArrayBuffers. To avoid this, the ponyfill and shim ensures that the sniff will not match `'ArrayBuffer'`.

Ava also uses Node's concordance for its diagnostic output, which is how we discovered the problem.

## Proposed XS / Node.js Parity Tests

The *Immutable ArrayBuffer* proposal is a shape contract: the same buffer-creation, view-construction, and frozen-view-mutator-rejection sequence should behave the same way regardless of which JavaScript engine is running it. Two of Endo's target engines, Moddable XS and Node.js, are the most demanding pair because XS uses the proposal natively (or will, once it lands) on devices where ROM-backed buffers are first-class, and Node.js will host most of the testing.

To verify this parity by construction rather than by prose, the package will follow the parity-test pattern landed elsewhere in the monorepo (`packages/compartment-mapper/test/cycle-rename*`, `packages/compartment-mapper/test/cycle-cjs-reexporter*`, and friends): a shared fixture and shared assertions module exercised by an XS-side test and a Node-side test, both calling the same expectations. The proposed shape for this package:

- A shared assertions module, `packages/immutable-arraybuffer/test/_immutable-arraybuffer-assertions.js`, exporting `assertImmutableArrayBufferShape(t, ponyfill, env)` and `assertFreezableTypedArrayShape(t, ponyfill, env)`. Each takes an Ava-like `t` (the XS side uses the lightweight `assert` shim demonstrated in `packages/ses/test/_xs.js`; the Node side uses Ava directly) and the ponyfill's named exports. The assertions verify:
  - `sliceBufferToImmutable(buffer, start, end)` returns a buffer for which `isBufferImmutable` is `true`.
  - The returned buffer's `byteLength` matches the requested window and its contents match a known fixture byte sequence.
  - On platforms where `optTransferBufferToImmutable` is defined, `transferBufferToImmutable(buffer)` detaches the original and returns an immutable buffer with the original's contents.
  - The complaining-mutator overrides on the emulated immutable prototype throw a `TypeError` for `resize`, `transfer`, `transferToFixedLength`.
  - For the freezable `TypedArray` ponyfill: `new PseudoUint8Array(immutableBuffer)` succeeds, `pseudo.buffer === immutableBuffer`, the indexed reads agree with the fixture, and the complaining mutators (`copyWithin`, `fill`, `reverse`, `set`, `sort`) throw a `TypeError`.

- A shared fixture module, `packages/immutable-arraybuffer/test/_immutable-arraybuffer-fixture.js`, that builds the source buffer from a fixed byte sequence so both runners agree on the values to assert. The fixture is plain JavaScript with no Ava import; both the Node-side test and the XS-side test consume it.

- A Node-side parity test, `packages/immutable-arraybuffer/test/parity-node.test.js`, importing the package's ponyfill exports, the fixture, and the shared assertions:

  ```js
  import test from 'ava';
  import * as ponyfill from '@endo/immutable-arraybuffer';
  import * as freezablePony from '@endo/immutable-arraybuffer/freezable-typedarray-pony.js';
  import { makeSourceBuffer } from './_immutable-arraybuffer-fixture.js';
  import {
    assertImmutableArrayBufferShape,
    assertFreezableTypedArrayShape,
  } from './_immutable-arraybuffer-assertions.js';

  test('immutable ArrayBuffer ponyfill - Node parity', t => {
    const source = makeSourceBuffer();
    assertImmutableArrayBufferShape(t, ponyfill, { source });
  });

  test('freezable TypedArray ponyfill - Node parity', t => {
    const source = makeSourceBuffer();
    assertFreezableTypedArrayShape(t, ponyfill, freezablePony, { source });
  });
  ```

- An XS-side parity entry point, `packages/immutable-arraybuffer/test/_xs.js`, modeled on `packages/ses/test/_xs.js`. The XS side uses the same shared assertions and the same shared fixture; the only difference is that `t` is the minimal `assert.equal` / `assert.throws` shim, and `print('ok')` reports overall success. A companion script `packages/immutable-arraybuffer/scripts/generate-test-xs.js` (modeled on `packages/ses/scripts/generate-test-xs.js`) bundles `_xs.js` together with the ponyfill source using `@endo/compartment-mapper` with the `xs` tag; the resulting `tmp/test-xs.js` is then executed by `xst` from the Moddable SDK. `test:xs` in this package's `package.json` would point at that script once the XS toolchain wiring is in place.

Once the `@endo/bytes` spackle lands, the parity tests are extended to exercise the four lockdown-vs-shim combinations described under "Required changes to `@endo/ses` permits" below: with/without lockdown crossed with with/without the immutable-`ArrayBuffer` shim. The Node side iterates the four combinations as separate Ava tests; the XS side iterates the same combinations in the `_xs.js` entry point. Shared fixtures and shared assertions cover the observable behavior; the four combinations cover the configuration matrix. The cross-runner-cross-configuration agreement is what certifies the spackle's portability.

The convergence shape is the right one for the *Immutable ArrayBuffer* ponyfills because the proposal contemplates that XS will eventually implement the feature natively, and the observable behavior of the native implementation should agree with the ponyfill's emulation. If a future XS run diverges, the failing assertion in the shared module localizes the divergence and points the reader at the implementation gap. If a future Node run diverges (for example, when a TC39 `transferToImmutable` lands natively in V8), the shared assertions still hold.

Implementation of the XS-side runner is deferred from this round: it requires Moddable SDK toolchain familiarity, the `xst` binary, and the generation pipeline scaffolding already in place for `@endo/ses` and `@endo/module-source`. The Node-side test pair and the shared fixture and assertions modules are reachable as a follow-up without the XS toolchain dependency, and landing them is the right next step.

## Ramifications for `@endo/bytes` as a Spackle

The [spackle](https://docs.endojs.org/documents/spackle.html) pattern describes a module that installs a behavior on a shared intrinsic at a registered symbol and exports an ergonomic callable; the first instance to load wins the race, and subsequent instances find the property already defined and call through. `@endo/harden` is the canonical example: `Object[Symbol.for('harden')]` is the rendezvous; the ergonomic `harden` is the export.

`@endo/bytes` becomes the **spackle front** for three families of behavior that this package and its consumers need uniformly across realms, regardless of whether the immutable-`ArrayBuffer` shim is installed and regardless of whether lockdown has run:

- **Immutable `ArrayBuffer` operations** (the existing `bytesToImmutable`, `bytesFromImmutable`, `concatImmutables`). The spackle install puts the immutable-slice operation at `ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')]` and the round-trippable wrapping operations at companion symbols on `ArrayBuffer.prototype`.
- **Frozen `TypedArray`s backed by immutable `ArrayBuffer`s**. The spackle install puts the freezable `TypedArray` constructor at a registered symbol on the relevant intrinsic (sketched below). The result is one freezable constructor per realm; eval twins agree on which constructor a `frozenView instanceof FreezableUint8Array` check resolves against; the `makePseudoTypedArrayConstructor` ponyfill export becomes internal as the spackle front replaces it as the public surface.
- **Text-codec workarounds for immutable buffers**. `TextDecoder.decode` and `TextEncoder.encode` do not accept emulated immutable `ArrayBuffer`s as input/output backing stores. The spackle install captures `TextEncoder` and `TextDecoder` once at module load, installs the codec adapters at registered symbols on the relevant intrinsic (sketched below), and exposes ergonomic `bytesFromText` and `bytesToText` functions that route through the install. The capture-on-intrinsic guarantee is the load-bearing one: a compartment global endowment that later replaces `TextDecoder` on `globalThis` does not redirect the spackle's behavior, because the spackle holds the realm's original `TextDecoder` and its decode operation is reachable as `Uint8Array[Symbol.for('toUtf8String')]` (or a comparable symbol) on the realm's primordial.

### Symbol rendezvous shape

The pattern proposed by the maintainer (review `4423421007`) is to put the symbols on the relevant intrinsic rather than on `Object`. The intrinsic is the one whose prototype best describes the operation: the immutable-slice operation belongs on `ArrayBuffer.prototype`; the freezable view construction and text-codec operations belong on `Uint8Array` (the constructor itself, so the symbol can be installed on the realm's `Uint8Array` primordial before any view is materialized). The candidate registrations are:

- `ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')]`: the immutable-slice operation, called as `arrayBuffer[Symbol.for('sliceBufferToImmutable')](start, end)`. The eponymous TC39 method `ArrayBuffer.prototype.sliceToImmutable` (if and when it lands) sits at the same rendezvous via the shim's installer, and the spackle prefers the standard install when present.
- `ArrayBuffer.prototype[Symbol.for('transferBufferToImmutable')]`: the immutable-transfer operation, parallel to the slice operation. Optional on platforms that lack `structuredClone` and `ArrayBuffer.prototype.transfer`.
- `Uint8Array[Symbol.for('toUtf8String')]`: the decode operation, called as `Uint8Array[Symbol.for('toUtf8String')](view, { fatal })`. The spackle holds the realm's original `TextDecoder` once at module load; the registered symbol on the `Uint8Array` constructor is the rendezvous; the ergonomic `bytesToText` import from `@endo/bytes` calls through. The symbol-on-constructor placement (rather than on `Uint8Array.prototype` as a method) was chosen so a compartment global endowment that later replaces `TextDecoder` on `globalThis` cannot redirect the install: the spackle captures the primordial at load time, the registered symbol on the constructor is the lookup path, and the compartment's endowment of `globalThis.TextDecoder` does not reach into the registered symbol on the realm's primordial.
- `Uint8Array[Symbol.for('fromUtf8String')]`: the encode operation, parallel to the decode operation. The spackle holds the realm's original `TextEncoder` once at module load.
- `Uint8Array[Symbol.for('freezableConstructor')]` (working name): the per-realm freezable `TypedArray` constructor for the `Uint8Array` family. The spackle's first loader installs `makePseudoTypedArrayConstructor(Uint8Array)`; subsequent loaders call through. Companion symbols on `Uint16Array`, `Uint32Array`, and the other `TypedArray` constructors carry the constructors for their respective views.

The exact symbol names are subject to coordination with the TC39 proposal authors and with the upstream `@endo/harden` precedent; the symbol-on-intrinsic discipline is the load-bearing decision and the names are a follow-up question.

### Candidates for the install dance

The current `@endo/bytes` operations that become spackle installs:

1. `bytesToImmutable(view) -> ArrayBuffer`. The current implementation calls `sliceBufferToImmutable` from `@endo/immutable-arraybuffer` and hardens the result. A spackle would install at, e.g., `ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')]`, race the first writer, and have subsequent loads of `@endo/bytes` call through to the installed function.
2. `bytesFromImmutable(buffer) -> Uint8Array`. Same shape: a registered symbol, an installed callable, the ergonomic export prefers the installed one.
3. `concatImmutables(buffers) -> ArrayBuffer`. Same shape.
4. `bytesFromText(s) -> Uint8Array`. The spackle holds the realm's original `TextEncoder` and installs at `Uint8Array[Symbol.for('fromUtf8String')]`. The capture-on-intrinsic is what gives the lockdown-time guarantee: a compartment global endowment of `TextEncoder` does not redirect the install.
5. `bytesToText(view, options) -> string`. The spackle holds the realm's original `TextDecoder` (both lenient and `fatal: true` instances) and installs at `Uint8Array[Symbol.for('toUtf8String')]`. Same capture-on-intrinsic guarantee.
6. The freezable `TypedArray` constructor family. The spackle installs `makePseudoTypedArrayConstructor(C)` for each `C` in `Uint8Array, Uint16Array, ...` at the corresponding registered symbol on the constructor. The `makePseudoTypedArrayConstructor` ponyfill export from `freezable-typedarray-pony.js` becomes internal once the spackle is the public path.

The `bytesEqual` and `concatBytes` functions remain conventional ponyfills: they operate purely on `Uint8Array` and have no realm-wide identity concern (no eval-twin recognition problem, no shared `WeakSet` to dedupe, no install-site contention with a future native API).

### Required changes to `@endo/bytes`

To turn the immutable-aware operations into spackles:

- Add an install-and-prefer-install dance for each of the functions, modeled on `@endo/harden`'s pattern, but registering the symbol on the relevant intrinsic (per "Symbol rendezvous shape" above) rather than on `Object`. The export becomes:

  ```js
  // sketch only; actual implementation would mirror @endo/harden
  const SYMBOL = Symbol.for('sliceBufferToImmutable');
  const installed = ArrayBuffer.prototype[SYMBOL];
  let implementation;
  if (installed) {
    implementation = view => harden(
      installed.call(view.buffer, view.byteOffset, view.byteOffset + view.byteLength),
    );
  } else {
    const installedSlice = (start, end) =>
      sliceBufferToImmutable(this, start, end);
    Object.defineProperty(ArrayBuffer.prototype, SYMBOL, {
      value: installedSlice,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    implementation = view => harden(
      installedSlice.call(view.buffer, view.byteOffset, view.byteOffset + view.byteLength),
    );
  }
  export const bytesToImmutable = implementation;
  ```

  The text-codec install captures the realm's original `TextEncoder` and `TextDecoder` at module load (`const enc = new globalThis.TextEncoder()` evaluated *before* any compartment endowment could replace it) and registers the codec adapter on `Uint8Array` at the rendezvous symbol. The freezable `TypedArray` install builds `makePseudoTypedArrayConstructor(C)` for each `C` and registers the result at the corresponding symbol on `C`.

- Declare an *ergonomic-and-shared* contract in the README so a downstream library can rely on the install having happened by the time it observes the symbol, regardless of which `@endo/bytes` instance ran first.
- Coordinate with `@endo/immutable-arraybuffer`: when the immutable-`ArrayBuffer` proposal lands natively (or its shim runs) and installs `ArrayBuffer.prototype.sliceToImmutable` directly, `@endo/bytes`'s spackle prefers the standard install on the intrinsic over its own. The two spackles are not in tension; they layer.
- Decide whether `concatImmutables` is worth spackling now or after the first downstream caller materializes. The current implementation has no realm-wide identity concern of its own (it neither maintains state nor coordinates with eval twins), so the case is weaker than for `harden`. The decision can be deferred without locking out the future move.

### Required changes to `@endo/ses` permits

The registered symbols on `ArrayBuffer.prototype`, on `Uint8Array`, and on the other `TypedArray` constructors must be admitted by SES's permits table. Without the admission, lockdown's whitelist-enforcement phase removes them, the spackle's install loses its rendezvous after lockdown runs, and the post-lockdown behavior diverges from the pre-lockdown behavior. The permits update is a small, localized change to `@endo/ses`'s `whitelist.js` (or its successor table) that admits each `Symbol.for(...)` key the spackle uses as a permitted property name on the respective intrinsic.

The lockdown-vs-shim discipline that follows from the permits update:

- **Without lockdown**: the spackle install runs as ordinary `Object.defineProperty` on the realm's intrinsic; no shim is required. `@endo/bytes` works against the bare intrinsic.
- **With lockdown, without the immutable-`ArrayBuffer` shim**: the spackle install runs *before* `lockdown()` so the registered symbols are in place when the whitelist-enforcement phase observes them. Permits must list the symbols. The immutable-`ArrayBuffer` operations are still provided by the spackle (via the ponyfill); the methods on `ArrayBuffer.prototype` (`sliceToImmutable`, `transferToImmutable`, `immutable`) are not present because the shim is not installed. Programs that consume `@endo/bytes` rather than reaching for the bare methods continue to work uniformly.
- **With lockdown, with the immutable-`ArrayBuffer` shim**: the shim's installer puts the proposal's methods on `ArrayBuffer.prototype` *and* installs at the spackle's registered symbol; `@endo/bytes` prefers the standard install. Permits must list both the spackle's symbols and the shim's added methods. This is the configuration in which the proposal's methods are reachable on the bare intrinsic.

The XS/Node parity tests described above exercise the spackle on all four combinations: with/without lockdown, with/without the shim. The Node side iterates the four combinations as separate Ava tests; the XS side iterates the same combinations in the `_xs.js` entry point. Shared assertions cover the observable behavior; shared fixtures cover the byte sequences. The cross-runner agreement is what the parity-test pattern certifies.

### What does not change

- The package's public API surface (the existing named exports) is unchanged. Callers continue to write `import { bytesToImmutable } from '@endo/bytes/to-immutable.js';` and get a callable that does the right thing. The spackle is a property of *how the implementation is shared across eval twins*, not of how the package presents itself to consumers.
- No new dependencies. The spackle pattern uses `Symbol.for` and `Object.defineProperty`; both are already available wherever `@endo/bytes` runs today.
- Existing tests continue to work. The spackle install is idempotent: the first loader wins, subsequent loaders adopt the install. A test that loads `@endo/bytes` once and exercises the functions sees the same behavior with or without the spackle.

### Migration path

The migration is non-breaking for callers:

1. Land the spackle install code in `@endo/bytes`'s immutable-aware modules and in the text-codec modules. The exported function names and signatures do not change. The freezable `TypedArray` constructor moves from `@endo/immutable-arraybuffer/freezable-typedarray-pony.js` (`makePseudoTypedArrayConstructor` becomes internal) to `@endo/bytes`'s spackle install.
2. Land the SES permits update admitting the registered symbols.
3. Land the ESLint rule in `@endo/eslint-plugin` that forbids direct use of `TextEncoder`, `TextDecoder`, the `TypedArray` constructors, and `new ArrayBuffer()`, with the spackle's install site whitelisted.
4. Update the documentation to describe the rendezvous symbols and the call-through semantics, with a forward reference to the proposed TC39 standardization once that conversation is open.
5. Existing dependents (`@endo/marshal`, `@endo/pass-style`, vat infrastructure) keep working without code changes. They benefit from the realm-wide single-source-of-truth automatically.

### Follow-up dispatches

This README's reiteration is descriptive: it documents the elaborated proposal so consumers and reviewers can align on the shape. The implementation lives in follow-up dispatches against the named packages:

- `@endo/bytes`: land the spackle install dance for the six operations (immutable-`ArrayBuffer` slice + transfer, text codec encode + decode, freezable `TypedArray` constructor family, idempotent install via registered symbols on the relevant intrinsic). The freezable-`TypedArray` pony module's `makePseudoTypedArrayConstructor` export migrates from public to module-internal as the spackle becomes the public surface.
- `@endo/eslint-plugin`: land the rule that forbids direct use of `TextEncoder`, `TextDecoder`, the `TypedArray` constructors, and `new ArrayBuffer()`, with the spackle's capture-at-module-init site whitelisted. Tests cover positive triggers and negative non-triggers.
- `@endo/ses`: land the permits update admitting the registered symbols on `ArrayBuffer.prototype` and on the `TypedArray` constructors. Without this update, lockdown removes the symbols and the spackle's post-lockdown behavior diverges from its pre-lockdown behavior.
- XS-side parity runner wiring: land the `_xs.js` entry point, the `generate-test-xs.js` script, the `test:xs` script in `package.json`, and the four lockdown-vs-shim combinations the parity tests exercise. Requires Moddable SDK toolchain.

Each follow-up is a separate PR with a separate review cycle. The split keeps the changes per package small, keeps the review surfaces focused, and lets the XS-side wiring proceed when the toolchain becomes available without blocking the rest of the work.
