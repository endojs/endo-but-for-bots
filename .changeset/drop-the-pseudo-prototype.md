---
'@endo/immutable-arraybuffer': minor
'ses': minor
'@endo/pass-style': patch
---

Drop the immutable-ArrayBuffer pseudo-prototype.

`@endo/immutable-arraybuffer` collapses its intermediate
`ImmutableArrayBufferInternalPrototype` onto `ArrayBuffer.prototype`
directly. Emulated immutable buffers now share their prototype with
genuine `ArrayBuffer` exotic objects; the brand discrimination happens
via a `WeakMap` consulted by the methods installed on the (now shared)
prototype. The shim's installed methods use the
amplifier-with-this-fallthrough pattern: they dispatch to the captured
genuine method when invoked on a genuine `ArrayBuffer`, and to the
immutable-aware path when invoked on an emulated immutable buffer.

The package's public exports narrow to `isBufferImmutable` only.
The free-function call shape (`sliceBufferToImmutable`,
`optTransferBufferToImmutable`) is no longer part of the package's
module-export surface, since the shim's method form
(`buf.sliceToImmutable(...)`, `buf.transferToImmutable(...)`) supersedes
it. Callers that imported those free functions migrate to the shim's
method shape.

The lib file is renamed from `immutable-arraybuffer-pony.js` to
`immutable-arraybuffer-lib.js`; the README's *Purposeful Violation*
section is annotated as no-longer-applies (the `[Symbol.toStringTag]
= 'ImmutableArrayBuffer'` override is removed; emulated immutables
now read as `'[object ArrayBuffer]'` under `Object.prototype.toString`).

`ses` drops the `%ImmutableArrayBufferPrototype%` permits entry and
the throwaway-instance prototype walk in `get-anonymous-intrinsics.js`
that sampled it. With no intermediate prototype to permit or sample,
both artifacts are inert and removed. The three lines inside
`%ArrayBufferPrototype%` that name the shim-installed methods
(`transferToImmutable`, `sliceToImmutable`, `immutable`) stay as-is:
those methods still live on the genuine prototype after the redesign.

`@endo/pass-style`'s `byteArray.js` simplifies its brand check
accordingly: the `adaptImmutableArrayBuffer` indirection that
discovered the intermediate prototype is gone, and the structural
prototype-identity check names `ArrayBuffer.prototype` directly. The
helper's observable behaviour is unchanged.
