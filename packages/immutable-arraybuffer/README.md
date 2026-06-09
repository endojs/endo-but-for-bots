# `@endo/immutable-arraybuffer`

This `@endo/immutable-arraybuffer` package provides a lib layer and a shim for a proposed new JavaScript feature: *Immutable ArrayBuffers*.
- The lib layer in `src/immutable-arraybuffer-lib.js` defines a property record of the methods and accessors the proposal adds to `ArrayBuffer.prototype`, along with the factory that constructs emulated immutable buffers.
The package exports only `isBufferImmutable` from `index.js`, a brand check usable without forcing the shim to be installed.
- A shim modifies the existing JavaScript primordials as needed to most closely emulate the feature as proposed.
The `shim.js` file copies the lib layer's property record onto `ArrayBuffer.prototype`.
Importing `@endo/immutable-arraybuffer/shim.js` will cause these changes.

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
An Immutable `ArrayBuffer` would provide exactly the low-level machinery we need.

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

## The Lib Layer

The lib layer in `src/immutable-arraybuffer-lib.js` does not modify `ArrayBuffer.prototype` directly.
Instead, it exports
- `isBufferImmutable(buffer: ArrayBuffer) :boolean` (via `index.js`) -- a brand check that returns true for emulated immutable buffers and false otherwise.
- `immutableArrayBufferLibProperties` -- a plain record whose own properties are the methods and accessors the shim installs onto `ArrayBuffer.prototype`.
This record is internal to the package; only the shim consumes it.

In order for emulated immutable buffers to be of type `ArrayBuffer`, they cannot be actual `ArrayBuffer` exotic objects (which would be writable).
Instead, an emulated immutable buffer is a plain object whose direct prototype is `ArrayBuffer.prototype`.
So `x instanceof ArrayBuffer` will act as proposed.
The lib layer maintains a brand `WeakMap` from emulated immutable buffers to the underlying genuine `ArrayBuffer` whose contents it encapsulates.
The methods the shim installs onto `ArrayBuffer.prototype` discriminate on brand membership: they treat the receiver as immutable when it is in the WeakMap, and as a genuine ArrayBuffer otherwise (the amplifier-with-this-fallthrough pattern).
This way, one set of methods on the shared `ArrayBuffer.prototype` correctly handles both genuine and emulated buffers.

## The Shim

The shim copies the lib layer's `immutableArrayBufferLibProperties` record onto `ArrayBuffer.prototype` via `defineProperties` and `getOwnPropertyDescriptors`.
This adds the proposed methods (`transferToImmutable`, `sliceToImmutable`) and accessor (`immutable`), and overwrites the genuine `slice`, `resize`, `transfer`, and `transferToFixedLength` methods with versions that discriminate on brand membership.
For genuine ArrayBuffers, the overwritten methods delegate to the captured genuine method and behave identically to before.
For emulated immutable buffers, the methods either return the appropriate immutable behaviour (for `slice`) or throw the appropriate "cannot mutate" `TypeError` (for the mutators).

A warning fires if the shim is about to overwrite a property of `ArrayBuffer.prototype` that was not already expected to be overwritten.
The four genuine mutator-method overwrites (`slice`, `resize`, `transfer`, `transferToFixedLength`) are on a static expected-overwrite list and do not trigger the warning; any other overwrite indicates a platform that has independently shipped part of the proposal's surface, which the shim author should investigate.

## Caveats

The *Immutable ArrayBuffer* shim falls short of the proposal in the following ways
- The lib layer and shim rely on the underlying platform having either `structuredClone` or `ArrayBuffer.prototype.transfer`.
However, Node <= 16 has neither.
Node 17 introduces `structuredClone` and Node 21 introduces `ArrayBuffer.prototype.transfer`.
Without either, the lib layer and shim fail to initialize.
- The shim's emulated immutable buffers are not real `ArrayBuffer` exotic objects.
If they were, the shim would not be able to protect them from being written.
Even though they implement the full proposed `ArrayBuffer` API, they cannot be plug-compatible: they cannot be used as the backing stores of `DataView`s or `TypedArray`s.
Perhaps follow-on shims might modify `DataView` and `TypedArray` to emulate that as well, but that is hard and beyond the ambition of this lib + shim.
- Unlike genuine `ArrayBuffer` or `SharedArrayBuffer` exotic objects, the shim's emulated immutable buffers cannot be cloned or transfered between JS threads.
- Even after the *Immutable ArrayBuffer* proposal is implemented by the platform, the current code will still replace it with the shim implementation, in accord with shim best practices.
See https://github.com/endojs/endo/pull/2311#discussion_r1632607527 .
It will require a later manual step to delete the shim, after manual analysis of the compat implications.
- This is a plain *JavaScript* lib + shim, not by itself a *Hardened JavaScript* polyfill/shim.
Thus, the objects and function it creates are not hardened by this lib/shim itself.
Rather, the ses-shim is expected to import these, and then treat the resulting objects as if they were additional primordials, to be hardened during `lockdown`'s harden phase.

## Purposeful Violation (no longer applies)

Earlier versions of this package set `[Symbol.toStringTag]` to `'ImmutableArrayBuffer'` on the intermediate prototype of emulated immutable buffers.
The rationale: Node's [concordance](https://github.com/concordancejs/concordance/blob/791d2a89b40eb13f2c889ac270dd8be190cf8073/lib/describe.js#L36) (used by ava for diagnostic output) sniffs the result of `toString()` to decide whether it can do `Buffer.from` on the object, which only works on genuine `ArrayBuffer` exotic objects.
The intermediate prototype's `[Symbol.toStringTag]` override prevented concordance from misidentifying an emulated immutable buffer as a genuine `ArrayBuffer`.

The redesign that drops the intermediate prototype also retires this violation.
Emulated immutable buffers now directly inherit from `ArrayBuffer.prototype`, so `Object.prototype.toString.call(immuAB)` returns `'[object ArrayBuffer]'`.
Concordance will sniff `'ArrayBuffer'` for both genuine and emulated buffers, and will treat both as ones it can `Buffer.from`.
For genuine buffers this is correct; for emulated immutable buffers it triggers a `TypeError` because they are not actual exotic objects, which concordance handles the same as any other unrenderable value.
Callers that need to distinguish emulated immutable buffers from genuine ones should use the `immutable` accessor (or `isBufferImmutable` for the pre-shim case), which is the canonical brand check.
