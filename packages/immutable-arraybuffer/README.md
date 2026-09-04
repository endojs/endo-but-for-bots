# `@endo/immutable-arraybuffer`

This `@endo/immutable-arraybuffer` package provides a shim for a proposed new JavaScript feature: *Immutable ArrayBuffers*.
A shim modifies the existing JavaScript primordials as needed to most closely emulate the feature as proposed.
Importing `@endo/immutable-arraybuffer/shim.js` will cause these changes.

The package's main entry point additionally exports two byte utilities
that pair with the shim:

```js
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';

// Wrap a Uint8Array's contents in a hardened frozen Uint8Array backed by
// an immutable ArrayBuffer (a `'byteArray'` passable). Honors the view's
// byteOffset/byteLength.
const passable = frozenBytes(new Uint8Array([1, 2, 3]));

// Copy such a value (or any view / ArrayBufferLike) back out into a fresh
// mutable Uint8Array so APIs like TextDecoder.decode can consume it.
const mutable = thawedBytes(passable);
```

Importing the main entry installs the shim as a side effect, since
`frozenBytes` depends on it. The bare shim install remains available as
the separate `@endo/immutable-arraybuffer/shim.js` export for callers
that want only the platform changes.

Below, we use the term "buffer" to refer informally to an instance of an `ArrayBuffer`, whether immutable or not.

## Background

Prior proposals [In-Place Resizable and Growable `ArrayBuffer`s](https://github.com/tc39/proposal-resizablearraybuffer) and [ArrayBuffer.prototype.transfer and friends](https://github.com/tc39/proposal-arraybuffer-transfer) have both reached stage 4, and so are now an official part of JavaScript.
Altogether, `ArrayBuffer.prototype` now has the following methods:
- `transfer(newByteLength?: number) :ArrayBuffer` -- move the contents of the original buffer to a new buffer, detach the original buffer, and return the new buffer.
The new buffer will be as resizable as the original was.
- `transferToFixedLength(newByteLength?: number) :ArrayBuffer` -- like `transfer` but the new buffer is not resizable.
- `resize(newByteLength: number) :void` -- change the size of this buffer if possible, or throw otherwise.
- `slice(start?: number, end?: number) :ArrayBuffer` -- Return a new buffer whose initial contents are a copy of that region of the original buffer.
The original buffer is unmodified.

and the following read-only accessor properties
- `detached: boolean` -- is this buffer detached, or are its contents still available from this buffer object?
- `resizable: boolean` -- can this buffer be resized, or is it fixed-length?
- `byteLength: number` -- how big are the current contents of this buffer?
- `maxByteLength: number` -- how big could this buffer be resized to be?

None of the operations above enable the creation of an immutable buffer, that is, a non-detached buffer whose contents cannot be changed, resized, or detached.

Both a `DataView` object and a `TypedArray` object are views into a buffer backing store.
For a `TypedArray` object, the contents of the backing store appear as indexed data properties of the `TypeArray` object that reflect the current contents of this backing store.
Currently, because there is no way to prevent the contents of the backing store from being changed, `TypedArray`s cannot be frozen.

Some JavaScript implementations, like Moddable XS, bring JavaScript to embedded systems, like device controllers, where ROM is much more plentiful and cheaper than RAM.
These systems need to place voluminous fixed data into ROM, and currently do so using semantics outside the official JavaScript standard.

The [OCapN](https://ocapn.org/) network protocol treats strings and byte-arrays as distinct forms of bulk data to be transmitted by copy.
At JavaScript endpoints speaking OCapN such as `@endo/pass-style` + `@endo/marshal`, JavaScript strings represent OCapN strings.
The immutability of strings in the JavaScript language reflects their by-copy nature in the protocol.
Likewise, to reflect an OCapN byte-array well into the JavaScript language, we need an immutable container of bulk binary data.
There currently are none.
A frozen `Uint8Array` would provide exactly the low-level machinery we need.

## Overview of the *Immutable ArrayBuffer* Proposal

The *Immutable ArrayBuffer* proposal introduces additional methods and read-only accessor properties to `ArrayBuffer.prototype` that fit naturally into those explained above.
Just as a buffer can be resizable or not, or detached or not, this proposal enables buffers to be immutable or not.
Just as `transferToFixedSize` moves the contents of a original buffer into a newly created non-resizable buffer, this proposal provides a transfer operation that moves the contents of an original original buffer into a newly created immutable buffer.
Altogether, this proposal only adds to `ArrayBuffer.prototype` one method
- `transferToImmutable() :ArrayBuffer` -- move the contents of the original buffer into a new immutable buffer, detach the original buffer, and return the new buffer.

and one read-only accessor
- `immutable: boolean` -- is this buffer immutable, or can its contents be changed?

An immutable buffer cannot be detached or resized.
Its `maxByteLength` is the same as its `byteLength`.
A `DataView` or `TypedArray` using an immutable buffer as its backing store can be frozen and immutable.
`ArrayBuffer`s, `DataView`s, and `TypedArray`s that are frozen and immutable could be placed in ROM without going beyond JavaScript's official semantics.

## The Shim

Importing `@endo/immutable-arraybuffer/shim.js` installs the proposed methods (`transferToImmutable`, `sliceToImmutable`) and accessor (`immutable`) onto `ArrayBuffer.prototype`, along with replacements for the genuine `slice`, `resize`, `transfer`, and `transferToFixedLength` methods that discriminate on whether the receiver is an emulated immutable buffer.
For genuine ArrayBuffers, the replacements delegate to the captured genuine methods and behave identically to before.
For emulated immutable buffers, the methods either return the appropriate immutable behaviour (for `slice`) or throw the appropriate "cannot mutate" `TypeError` (for the mutators).

The shim's install policy is first-evaluation-wins.
The first evaluation in a realm installs the emulation when native `sliceToImmutable` is absent.
Later evaluations, including an "eval twin" loaded from another physical copy of the package, see the installed method and defer to the winner.
Public byte helpers call the winning `ArrayBuffer.prototype.sliceToImmutable` instead of a package-copy-local implementation, so every emulated buffer and view belongs to the winning installation.

## Caveats

The *Immutable ArrayBuffer* shim falls short of the proposal in the following ways
- The shim relies on the underlying platform having either `structuredClone` or `ArrayBuffer.prototype.transfer`.
See [Platform support for `transferToImmutable`](#platform-support-for-transfertoimmutable) below for the per-engine version thresholds and the guidance on when feature-testing is necessary.
Without either, the shim still shims `ArrayBuffer.prototype.sliceToImmutable` but omits `ArrayBuffer.prototype.transferToImmutable`.
- The shim's emulated immutable buffers are not real `ArrayBuffer` exotic objects.
If they were, the shim would not be able to protect them from being written.
Even though they implement the full proposed `ArrayBuffer` API, they cannot be plug-compatible as direct exotic-object arguments to all native APIs.
The freezable `TypedArray` and `DataView` emulations (see below) cover construction of every standard ArrayBuffer view on an emulated immutable buffer.
- Unlike genuine `ArrayBuffer` or `SharedArrayBuffer` exotic objects, the shim's emulated immutable buffers cannot be cloned or transfered between JS threads.
- This is a plain *JavaScript* shim, not by itself a *Hardened JavaScript* polyfill/shim.
Thus, the objects and function it creates are not hardened by this shim itself.
Rather, the ses-shim is expected to import this, and then treat the resulting objects as if they were additional primordials, to be hardened during `lockdown`'s harden phase.

## The Freezable TypedArray Emulation

The shim also installs a freezable `TypedArray` emulation alongside the `ArrayBuffer`-side install.
After the shim loads, constructing a `TypedArray` from an emulated immutable `ArrayBuffer` produces an emulated freezable wrapper:

```js
import '@endo/immutable-arraybuffer/shim.js';

const ab = new ArrayBuffer(4);
const iab = ab.sliceToImmutable();

const view = new Uint8Array(iab);

view instanceof Uint8Array;                // true
Object.getPrototypeOf(view) === Uint8Array.prototype; // true (no intermediate prototype)
view.buffer === iab;                       // true (returns the immutable wrapper)
view.byteLength;                           // 4
view.at(0);                               // 0

view.fill(1);                             // throws TypeError (mutator blocked)
view.set([1]);                            // throws TypeError
view.reverse();                           // throws TypeError
view.copyWithin(0, 1);                    // throws TypeError
view.sort();                              // throws TypeError

Object.freeze(view);
Object.isFrozen(view);                    // true
```

The emulation covers all eleven concrete `TypedArray` constructors (`Int8Array`, `Int16Array`, `Int32Array`, `Uint8Array`, `Uint8ClampedArray`, `Uint16Array`, `Uint32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`).

Constructing from a genuine mutable `ArrayBuffer` produces a genuine writable `TypedArray` view, unchanged from before:

```js
const mutableAb = new ArrayBuffer(4);
const view = new Uint8Array(mutableAb);
view.fill(1); // succeeds: genuine writable view
```

## The Freezable DataView Emulation

Constructing a `DataView` on an emulated immutable buffer uses the same wrapper pattern.
The constructor delegates byte-offset and byte-length conversion and range checks to the native `DataView` constructor.
The wrapper inherits directly from `DataView.prototype`, retains the `[object DataView]` brand, and exposes the immutable buffer through `.buffer`.
All `get*` methods delegate to the hidden genuine view, while every `set*` method throws `TypeError`.
`Object.freeze` and `harden` can therefore freeze the wrapper without changing its readable contents.

```js
const source = new ArrayBuffer(4);
new DataView(source).setUint32(0, 0x12345678);
const immutable = source.sliceToImmutable();
const view = new DataView(immutable);

view.getUint32(0); // 0x12345678
view.setUint8(0, 0); // throws TypeError
Object.freeze(view); // succeeds
Object.prototype.toString.call(view); // '[object DataView]'
```

Construction on a genuine mutable buffer still produces a genuine writable `DataView`, including after the view object itself is frozen.
`ArrayBuffer.isView` reports `false` for an emulated DataView wrapper and `true` for a genuine DataView.
That is the same implementation distinction used for emulated and genuine TypedArrays, not a DataView-versus-TypedArray distinction.

### Indexed assignment on emulated freezable views

The emulated wrapper is a plain ordinary object, not a native integer-indexed exotic.
An indexed assignment (`view[0] = 42`) therefore creates an own property on the wrapper rather than writing to the underlying buffer.
The underlying buffer's bytes are never touched.

On a non-frozen wrapper the own property shadows the prototype's read delegate; `view[0]` reads back `42` while `Uint8Array.prototype.at.call(view, 0)` still reads `0` (the underlying byte).
On a frozen wrapper the assignment throws `TypeError` in strict mode (ES module code is always strict), and the buffer is unchanged.

This is a known constraint of the TC39 proposal: there is no way to intercept integer-indexed assignments on a plain object via the prototype chain.

### Distinguishing genuine and emulated views

An emulated view wrapper is **not** an `ArrayBuffer` view.

```js
import '@endo/immutable-arraybuffer/shim.js';

const iab = new ArrayBuffer(4).sliceToImmutable();
const emulated = new Uint8Array(iab);
const genuine = new Uint8Array(4);

ArrayBuffer.isView(emulated); // false  (the committed fidelity loss)
ArrayBuffer.isView(genuine);  // true
```

An emulated wrapper is a plain ordinary object (`Object.create(Uint8Array.prototype)`) with no `[[ViewedArrayBuffer]]` / `[[TypedArrayName]]` internal slots, so `ArrayBuffer.isView` reports `false` for it.
A genuine `Uint8Array` — whether backed by a mutable buffer or, on a native stage-3 engine, by a genuine immutable buffer — reports `true` and is integer-indexable in place.
This is the observable distinction consumers use. There is no separate shim
brand contract.

Current clients use it as follows:

- `@endo/pass-style` combines `ArrayBuffer.isView` with the prototype, backing-buffer, whole-span, and own-index checks required for a byteArray. The emulated shape has no own integer-indexed properties; the genuine shape has exactly `length` matching indexed properties.
- The `thawedBytes` utility (exported from this package) and `@endo/bytes`' readers use a genuine view in place and copy a non-view emulated `Uint8Array` wrapper first.

The shim **must not** be "improved" in any way that would make an emulated wrapper report `ArrayBuffer.isView === true` (it cannot, short of making the wrapper a genuine exotic) or that would otherwise blur this distinction — for example by materializing own integer-indexed data properties on the wrapper (which would push it out of the zero-own-index emulated shape `@endo/pass-style` requires).
`test/shim-typedarray.test.js` pins `ArrayBuffer.isView(wrapper) === false` (and `true` for a genuine view) as the committed regression, and the client packages mirror it with their own tests, so it is both the shim's responsibility not to break clients and each client's responsibility not to be silently broken.

The `immutable` accessor on the view's `.buffer` is **not** this distinguisher.
It distinguishes an **immutable** buffer from a **mutable** one; it does *not* distinguish a **genuine** immutable view from an **emulated** one.
Both an emulated wrapper and a (future-native) genuine view backed by an immutable buffer report `.buffer.immutable === true`, so the accessor cannot tell them apart — it answers a question about the *buffer's* mutability, not about the *view's* provenance.
`ArrayBuffer.isView` separates their implementations.

### Integer-indexed reads on emulated freezable views (an incidental consequence)

Symmetric to the assignment constraint above, an integer-indexed *read* on an emulated freezable wrapper does **not** reach the underlying byte.
On a fresh wrapper `view[i]` evaluates to `undefined`, never the byte stored in the immutable buffer.
The bytes are readable only through the integer-indexed *protocol* — `view.at(i)`, `Uint8Array.prototype.at.call(view, i)`, `for..of`, spread — which the shim redirects to the wrapper's hidden genuine `TypedArray`.
A direct `view[i]` reads an ordinary property off a plain object: the wrapper carries no own indexed properties, its `[[Prototype]]` is `Uint8Array.prototype`, and (per the same TC39-proposal constraint) the shim installs no integer-indexed read accessor on `%TypedArray%.prototype` that could intercept `view[i]`.

This `view[i] === undefined` behavior is a real but **incidental** consequence of the wrapper being a plain object — the same plain-object nature that makes `ArrayBuffer.isView` report `false`.
It is not a separate discriminator and clients do not sniff `view[i]` to tell an emulated wrapper from a genuine view; they use `ArrayBuffer.isView`.
Clients simply route *around* the incidental behavior — `@endo/bytes` copies a non-view wrapper before indexing, so it never observes `view[i]` on one — rather than depending on it as a brand.
The shim should nonetheless keep the wrapper an ordinary plain object with no own integer-indexed slots, because that is what keeps it a non-view with zero own indexed properties (the emulated shape `@endo/pass-style` requires); `test/shim-typedarray.test.js` records `view[i] === undefined` as a companion observation to the committed `isView` pin.

### `[Symbol.toStringTag]` on emulated views (repaired by a getter wrapper)

The shim replaces the genuine `%TypedArrayPrototype%[Symbol.toStringTag]` getter with a wrapper around it, so an emulated freezable wrapper reports the same string tag as a genuine view.

The genuine `%TypedArrayPrototype%[Symbol.toStringTag]` getter is `this`-sensitive: it reads the receiver's `[[TypedArrayName]]` internal slot.
An emulated wrapper is a plain ordinary object (`Object.create(Uint8Array.prototype)`) with no such slot, so the *unmodified* getter would return `undefined` for it and `Object.prototype.toString.call(view)` would read `'[object Object]'`.
The shim's replacement getter closes that gap: on an emulated wrapper it amplifies to the hidden genuine `TypedArray` and reads *its* internal-slot tag; on a genuine `TypedArray` it falls through to the captured genuine getter; on any other receiver it returns `undefined`, exactly as the genuine getter does.

```js
import '@endo/immutable-arraybuffer/shim.js';

const iab = new ArrayBuffer(4).sliceToImmutable();
const emulated = new Uint8Array(iab);
const genuine = new Uint8Array(4);

Object.prototype.toString.call(emulated); // '[object Uint8Array]'  (repaired)
Object.prototype.toString.call(genuine);  // '[object Uint8Array]'
```

This is a **getter-wrapper** fix, not a `[Symbol.toStringTag]` **data property** on the wrapper.
A data property would patch only the `Object.prototype.toString` lookup path while leaving the genuine `this`-sensitive getter still reporting `undefined` on a wrapper; the getter wrapper makes the getter and `Object.prototype.toString` agree.
The wrapper therefore still carries **no** own `[Symbol.toStringTag]` — the tag comes from the prototype getter.

Consequently `[Symbol.toStringTag]` is not an emulated-vs-genuine distinguisher; consumers use `ArrayBuffer.isView` when they need that distinction.
One downstream consequence worth naming: a brand check that captures *this* (shim-installed) getter as an internal-slot probe — as `@endo/harden`'s `isTypedArray` does — will now classify an emulated wrapper as a `TypedArray` *if it captures the getter after the shim installs*.
That reroutes such a wrapper through `harden`'s `freezeTypedArray` branch rather than the ordinary `Object.freeze` branch, which is benign: the wrapper carries no own integer-indexed properties, so `freezeTypedArray` reduces to `preventExtensions` plus a no-op over an empty own-key set, and `harden(wrapper)` succeeds either way.
`test/shim-typedarray-tostringtag.test.js` pins the repaired `'[object Uint8Array]'` reading and the getter-wrapper (not data-property) shape.

## Function expressions versus declarations

Throughout `src/lib.js`, exported bindings that hold function values use `const`
with a named function expression rather than `function` declarations.
The reason is JavaScript function-declaration hoisting.

In the presence of an import cycle, a hoisted `function` declaration's value is
accessible to an importing module before the exporting module finishes
initializing.
An early importer that reads the exported name gets the function value already
present (because hoisting put it there before the module body ran), but any
other module-level state the function closes over may not yet be initialized,
creating a subtle hazard.

By using `const` instead, the JavaScript standard specifies that an early
importer in a cycle that reads the name before the exporting module's
initializer runs would get a Temporal Dead Zone (TDZ) error, making the hazard
visible at runtime rather than silent.

Two implementation notes for ses-shim environments:

- The ses-shim's compiler from JS ESM module code to JS evaluable code does not
  correctly implement TDZ.
  A cycle hazard of this kind may therefore not be caught at runtime when
  running under the ses-shim.
- XS (Moddable's engine) uses native compartment and module support and does
  implement TDZ correctly, so the same hazard would be caught at runtime on XS.

This file introduces no such import cycle; the convention is documented here
so future maintainers understand why function declarations are avoided throughout
endo.

Source: erights review comment 3439479281 on `src/lib.js` line 578.

## Platform support for `transferToImmutable`

The shim's emulation of `ArrayBuffer.prototype.transferToImmutable` requires the underlying platform to provide either `ArrayBuffer.prototype.transfer` (preferred when present) or the global `structuredClone` (used as a fallback to move the buffer's contents into a new backing store).
`sliceToImmutable` and the `immutable` accessor work on every platform; only `transferToImmutable` carries this dependency.

The following table records the first engine version that ships at least one of those primitives.
A cell marked **either** means the platform has both `structuredClone` and `ArrayBuffer.prototype.transfer`; a cell marked **structuredClone only** means the shim uses the structured-clone fallback path.
"Deficient" means neither primitive is present and `ArrayBuffer.prototype.transferToImmutable` is therefore absent after the shim loads.

### Engines

| Engine | First version with `structuredClone` | First version with `ArrayBuffer.prototype.transfer` | Status as of shipping today |
| --- | --- | --- | --- |
| V8 (Chromium) | 9.8 (with Chrome 98, Feb 2022) | 11.4 (with Chrome 114, May 2023) | **either** |
| SpiderMonkey (Firefox) | shipped with Firefox 94 (Nov 2021) | shipped with Firefox 122 (Jan 2024) | **either** |
| JavaScriptCore (WebKit) | shipped with Safari 15.4 (Mar 2022) | shipped with Safari 17.4 (Mar 2024) | **either** |
| Hermes | not implemented | not implemented | **deficient** |

The `structuredClone` global is a Web/HTML platform feature exposed to script through the engine's host environment; the dates above are for the host build that first exposed it.
`ArrayBuffer.prototype.transfer` is a TC39 language feature (ES2024) implemented in the engine itself.

### Runtimes and browsers

| Runtime / browser | First version with `structuredClone` | First version with `ArrayBuffer.prototype.transfer` | Status as of shipping today |
| --- | --- | --- | --- |
| Node.js | 17.0.0 (Oct 2021) | 21.0.0 (Oct 2023) | **either** on Node 21 and later; **structuredClone only** on Node 17 through 20; **deficient** on Node 16 and earlier |
| Deno | 1.14 (Sep 2021) | 1.33 (May 2023) | **either** on Deno 1.33 and later |
| Chrome / Edge | 98 (Feb 2022) | 114 (May 2023) | **either** on Chrome 114 and later; **structuredClone only** on Chrome 98 through 113 |
| Firefox | 94 (Nov 2021) | 122 (Jan 2024) | **either** on Firefox 122 and later; **structuredClone only** on Firefox 94 through 121 |
| Safari | 15.4 (Mar 2022) | 17.4 (Mar 2024) | **either** on Safari 17.4 and later; **structuredClone only** on Safari 15.4 through 17.3 |
| React Native (Hermes) | not implemented | not implemented | **deficient** |

Node 22 (active LTS at the time of writing) and Node 24 (current) both have `ArrayBuffer.prototype.transfer` and use the preferred path.
Node 18 and Node 20 reach the structured-clone fallback path; both are past or near end-of-life under the Node release schedule.

### Feature-testing guidance

Only code that might run on a **deficient** platform needs to feature-test for `ArrayBuffer.prototype.transferToImmutable`:

```js
import '@endo/immutable-arraybuffer/shim.js';

if (typeof ArrayBuffer.prototype.transferToImmutable === 'function') {
  // use transferToImmutable
} else {
  // fall back to sliceToImmutable (always present once the shim loads)
}
```

Code whose deployment targets are all non-deficient (any modern browser, Node.js 17 and later, Deno 1.14 and later) can rely on `transferToImmutable` being present after `import '@endo/immutable-arraybuffer/shim.js'` and skip the feature test.
React Native on Hermes and pre-Node-17 server environments are the practical cases that still require the test.

## Purposeful Violation

This package sets `[Symbol.toStringTag]` to `'emulated immutable ArrayBuffer'` on each emulated immutable buffer (as an own property of the instance, not on the shared `ArrayBuffer.prototype`).
The rationale: Node's [concordance](https://github.com/concordancejs/concordance/blob/791d2a89b40eb13f2c889ac270dd8be190cf8073/lib/describe.js#L36) (used by ava for diagnostic output) sniffs the result of `Object.prototype.toString.call(value)` to decide whether it can do `Buffer.from(value)` on the object.
`Buffer.from` only works on genuine `ArrayBuffer` exotic objects; passing an emulated immutable buffer to it throws a `TypeError` that concordance does not handle gracefully.
The own-property `[Symbol.toStringTag] = 'emulated immutable ArrayBuffer'` slot keeps concordance from routing the value through `Buffer.from` and lets it fall through to the unrenderable-value path.

The drop-the-pseudo-prototype redesign removed the intermediate prototype that earlier versions hung this slot on; the slot is now installed per-instance via `defineProperty` in `makeImmutableArrayBufferInternal`.
Genuine ArrayBuffers continue to inherit `'ArrayBuffer'` from the prototype: `Object.prototype.toString.call(new ArrayBuffer(0))` reads as `'[object ArrayBuffer]'`.
Only emulated immutable buffers carry the `'emulated immutable ArrayBuffer'` slot: `Object.prototype.toString.call(new ArrayBuffer(0).sliceToImmutable())` reads as `'[object emulated immutable ArrayBuffer]'`.
Callers that need to distinguish emulated immutable buffers from genuine ones programmatically should prefer the `immutable` accessor on `ArrayBuffer.prototype` (installed by the shim), which is the canonical brand check.
