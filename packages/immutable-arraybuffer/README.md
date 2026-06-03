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

The package also provides a companion ponyfill for *freezable virtual TypedArrays*, exposed as `freezable-typedarray-pony.js`. The motivation parallels the immutable `ArrayBuffer`: a `TypedArray` view onto an immutable buffer would itself be observably immutable, but the language does not yet permit a real `TypedArray` exotic object to be frozen. The ponyfill provides emulated views that present the proposed observable shape on top of an emulated immutable backing store.

Two callable exports are available:
- `makePseudoTypedArrayConstructor(OriginalConstructor)` returns a constructor that, when called with an emulated immutable `ArrayBuffer` as its sole argument, returns a freezable view whose prototype overrides the `TypedArray` mutators to throw and whose `buffer` accessor returns the emulated immutable buffer. When called with any other argument list it falls through to `OriginalConstructor`, so callers can use a single constructor uniformly across mutable and immutable buffers.
- `virtualTypedArrayBufferGetter` is a `buffer`-getter function suitable for installation as the replacement of `TypedArray.prototype.buffer` by a shim. It transparently returns the emulated immutable buffer for emulated freezable views and the genuine buffer for genuine views.

The `*Internal` prototype, the brand-check `WeakMap`, and the `getHiddenTypedArray` accessor are deliberately not exported: the ponyfill keeps the emulation's encapsulation just as the immutable-`ArrayBuffer` ponyfill keeps `hiddenBuffers` private to the package. Callers should construct freezable views only through `makePseudoTypedArrayConstructor`.

## Using the Ponyfills Across Native and Shim

A program that wants to be source-compatible with both a future native implementation of the *Immutable ArrayBuffer* proposal and the present-day shim should import the ponyfill's named exports rather than reaching for the methods on `ArrayBuffer.prototype`. The ponyfill's exports fall through to the native methods when present and emulate them when absent, so the calling code does not need to detect which case it is in.

The canonical idiom is:

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

The corresponding pattern for freezable virtual `TypedArrays` builds a constructor once per realm and uses it everywhere a `TypedArray` view is wanted, regardless of whether the backing buffer is mutable or immutable:

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

Two preconditions let this code run the same way under the shim and under a future native implementation:

1. *Either* the program imports `@endo/immutable-arraybuffer/shim.js` at startup *or* it never reaches for `arrayBuffer.sliceToImmutable(...)` and `arrayBuffer.transferToImmutable(...)` and `arrayBuffer.immutable` on a bare `ArrayBuffer`. The ponyfill exports remain a stable interface either way; the methods on `ArrayBuffer.prototype` only exist after the shim runs or after a native implementation ships. A program that wants to be portable should pick one of these disciplines and stay with it.
2. The program does not assume `x instanceof ArrayBuffer` distinguishes immutable from mutable. Both the proposal and this package's emulated immutable buffers inherit from `ArrayBuffer.prototype`, so they are both instances. The way to ask whether a particular buffer is immutable is `isBufferImmutable(x)` (or `x.immutable` if the shim or a native implementation is in effect).

The same discipline applies to the freezable `TypedArray` ponyfill: import `makePseudoTypedArrayConstructor` and use the resulting constructor wherever the program might want to view an immutable buffer; the emulated path and the genuine path agree on the observable shape.

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

The convergence shape is the right one for the *Immutable ArrayBuffer* ponyfills because the proposal contemplates that XS will eventually implement the feature natively, and the observable behavior of the native implementation should agree with the ponyfill's emulation. If a future XS run diverges, the failing assertion in the shared module localizes the divergence and points the reader at the implementation gap. If a future Node run diverges (for example, when a TC39 `transferToImmutable` lands natively in V8), the shared assertions still hold.

Implementation of the XS-side runner is deferred from this round: it requires Moddable SDK toolchain familiarity, the `xst` binary, and the generation pipeline scaffolding already in place for `@endo/ses` and `@endo/module-source`. The Node-side test pair and the shared fixture and assertions modules are reachable as a follow-up without the XS toolchain dependency, and landing them is the right next step.

## Ramifications for `@endo/bytes` as a Spackle

The [spackle](https://docs.endojs.org/documents/spackle.html) pattern describes a module that installs a behavior on a shared intrinsic at a registered symbol and exports an ergonomic callable; the first instance to load wins the race, and subsequent instances find the property already defined and call through. `@endo/harden` is the canonical example: `Object[Symbol.for('harden')]` is the rendezvous; the ergonomic `harden` is the export.

`@endo/bytes` is a near-fit for the same shape. It already provides ergonomic functions that work on `Uint8Array` values whose backing buffer may be an immutable `ArrayBuffer` (`bytesToImmutable`, `bytesFromImmutable`, `concatImmutables`), and it explicitly papers over a portability gap: immutable `ArrayBuffer`s cannot back a `Uint8Array` view directly, and APIs like `TextDecoder.decode` reject them. The spackle question is whether to install these behaviors on a shared intrinsic so all instances of `@endo/bytes` in a realm agree on the implementation, and so a future TC39 standard (or an XS native) can sit at the rendezvous.

### What spackling `@endo/bytes` would mean

Three operations are candidates for the rendezvous-symbol install:

1. `bytesToImmutable(view) -> ArrayBuffer`. The current implementation calls `sliceBufferToImmutable` from `@endo/immutable-arraybuffer` and hardens the result. A spackle would install at, e.g., `Object[Symbol.for('endo.bytesToImmutable')]`, race the first writer, and have subsequent loads of `@endo/bytes` call through to the installed function.
2. `bytesFromImmutable(buffer) -> Uint8Array`. Same shape: a registered symbol, an installed callable, the ergonomic export prefers the installed one.
3. `concatImmutables(buffers) -> ArrayBuffer`. Same shape.

The `bytesEqual`, `bytesFromText`, `bytesToText`, and `concatBytes` functions are not candidates for spackle: they operate purely on `Uint8Array` and have no realm-wide identity concern (no eval-twin recognition problem, no shared `WeakSet` to dedupe, no install-site contention with a future native API). They are conventional ponyfills and should stay that way.

### Required changes to `@endo/bytes`

To turn the three immutable-aware operations into spackles:

- Add an install-and-prefer-install dance for each of the three functions, modeled on `@endo/harden`'s pattern. The export becomes:

  ```js
  // sketch only; actual implementation would mirror @endo/harden
  const SYMBOL = Symbol.for('endo.bytesToImmutable');
  const installed = Object[SYMBOL];
  let implementation;
  if (installed) {
    implementation = installed;
  } else {
    implementation = view => harden(
      sliceBufferToImmutable(view.buffer, view.byteOffset, view.byteOffset + view.byteLength),
    );
    Object.defineProperty(Object, SYMBOL, {
      value: implementation,
      configurable: false,
      writable: false,
      enumerable: false,
    });
  }
  export const bytesToImmutable = implementation;
  ```

- Declare an *ergonomic-and-shared* contract in the README so a downstream library can rely on the install having happened by the time it observes the symbol, regardless of which `@endo/bytes` instance ran first.
- Coordinate with `@endo/immutable-arraybuffer`: if the immutable-`ArrayBuffer` proposal is later spackled at its own registered symbol (for example, `ArrayBuffer.prototype[Symbol.for('sliceToImmutable')]`), `@endo/bytes`'s spackle would prefer the standard install on the intrinsic over its own. The two spackles are not in tension; they layer.
- Decide whether `concatImmutables` is worth spackling now or after the first downstream caller materializes. The current implementation has no realm-wide identity concern of its own (it neither maintains state nor coordinates with eval twins), so the case is weaker than for `harden`. The decision can be deferred without locking out the future move.

### What does not change

- The package's public API surface (the existing named exports) is unchanged. Callers continue to write `import { bytesToImmutable } from '@endo/bytes/to-immutable.js';` and get a callable that does the right thing. The spackle is a property of *how the implementation is shared across eval twins*, not of how the package presents itself to consumers.
- No new dependencies. The spackle pattern uses `Symbol.for` and `Object.defineProperty`; both are already available wherever `@endo/bytes` runs today.
- Existing tests continue to work. The spackle install is idempotent: the first loader wins, subsequent loaders adopt the install. A test that loads `@endo/bytes` once and exercises the functions sees the same behavior with or without the spackle.

### Migration path

If `@endo/bytes` adopts the spackle pattern, the migration is non-breaking for callers:

1. Land the spackle install code in `@endo/bytes`'s three immutable-aware modules. The exported function names and signatures do not change.
2. Update the README to document the rendezvous symbols and the call-through semantics, with a forward reference to the proposed TC39 standardization once that conversation is open.
3. Existing dependents (`@endo/marshal`, `@endo/pass-style`, vat infrastructure) keep working without code changes. They benefit from the realm-wide single-source-of-truth automatically.

The principal open question is whether the `@endo/bytes` operations are realm-identity-sensitive enough to warrant the spackle pattern's extra coordination cost. `@endo/harden` and `@endo/eventual-send` (forthcoming spackle per the spackle document) both have clear realm-identity needs (`WeakSet` dedup, marked-promise recognition). `@endo/bytes`'s immutable-aware operations have a softer case: the principal benefit is that a future native `bytesToImmutable` analog (or a TC39-standardized `Uint8Array.prototype.toImmutable`) could install at the rendezvous and the package's exports would forward to it without modification. That benefit is real but speculative, and the maintainer's judgment on whether to spackle now or wait for the precipitating downstream need is the right gate. This README section documents the option; the actual install lives in a follow-up PR against `@endo/bytes` once the decision is made.
