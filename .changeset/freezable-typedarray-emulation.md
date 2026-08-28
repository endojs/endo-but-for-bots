---
'@endo/immutable-arraybuffer': minor
'ses': patch
---

Add freezable TypedArray and DataView emulation for immutable-ArrayBuffer-backed views.

After loading `@endo/immutable-arraybuffer/shim.js`, constructing a TypedArray
from an emulated immutable `ArrayBuffer` produces an emulated freezable wrapper
whose mutator methods (`copyWithin`, `fill`, `reverse`, `set`, `sort`) throw
`TypeError`, whose `buffer` getter returns the immutable wrapper rather than
the underlying genuine buffer, and which can be frozen via `Object.freeze`.
The wrapper inherits directly from `T.prototype` with no intermediate prototype.

The genuine-buffer constructor path (passing a regular mutable `ArrayBuffer`)
is unchanged: the result is a normal writable TypedArray view.

Constructing a `DataView` from an emulated immutable `ArrayBuffer` now produces
an emulated wrapper with native constructor range semantics, read accessors,
`DataView` branding, and direct `DataView.prototype` inheritance. Its write
methods throw `TypeError`, and the wrapper can be frozen with `Object.freeze`
or `harden`. Construction over a genuine mutable buffer remains writable.

`ses`: the permits walk accepts the shim-installed `%TypedArrayPrototype%`
slots without complaint; no new permit rows are required.

Consumers distinguish a genuine view from the shim's ordinary emulated wrapper
with `ArrayBuffer.isView`: the emulated wrapper reports `false` and a genuine
view reports `true`. Consumers combine that result with the shape checks their
contracts require. The shim does not publish a separate emulated-view brand.

The shim also repairs the emulated wrapper's `[Symbol.toStringTag]`: it replaces
the genuine `this`-sensitive `%TypedArrayPrototype%[Symbol.toStringTag]` getter
with a wrapper that amplifies an emulated wrapper to its hidden genuine
TypedArray, so `Object.prototype.toString.call(emulatedView)` now reads
`'[object Uint8Array]'` — matching a genuine view — instead of
`'[object Object]'`. This is a getter-wrapper fix, not a `[Symbol.toStringTag]`
data property (the wrapper still carries no own tag), so the getter and
`Object.prototype.toString` agree. `[Symbol.toStringTag]` is therefore not an
emulated-vs-genuine distinguisher; consumers use `ArrayBuffer.isView`. A brand
check that captures this getter after the shim
installs (e.g. `@endo/harden`'s `isTypedArray`) will classify an emulated wrapper
as a TypedArray and route it through the `freezeTypedArray` path, which is benign
(the wrapper has no own integer-indexed properties, so it freezes without
throwing in either capture order).
