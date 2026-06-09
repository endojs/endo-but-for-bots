---
'@endo/immutable-arraybuffer': minor
'ses': minor
'@endo/pass-style': patch
---

Drop the immutable-ArrayBuffer pseudo-prototype.

Emulated immutable `ArrayBuffer`s produced by
`@endo/immutable-arraybuffer` now inherit directly from
`ArrayBuffer.prototype` rather than from an intermediate prototype.
`Object.getPrototypeOf(immuAB) === ArrayBuffer.prototype` for both
emulated immutable and genuine buffers; the brand check is the new
`immutable` accessor on `ArrayBuffer.prototype` (or the
`isBufferImmutable` free function, preserved for pre-shim callers).

`Object.prototype.toString.call(immuAB)` now returns
`'[object ArrayBuffer]'` instead of `'[object ImmutableArrayBuffer]'`.
Callers that distinguished emulated immutable buffers by toStringTag
should switch to the `immutable` accessor.

The package's public exports narrow to `isBufferImmutable` only.
The free-function call shape (`sliceBufferToImmutable`,
`optTransferBufferToImmutable`) is no longer part of the package's
module-export surface; callers migrate to the shim's method form
(`buf.sliceToImmutable(...)`, `buf.transferToImmutable(...)`).

`ses` drops the `%ImmutableArrayBufferPrototype%` permits entry, which
no longer has a referent. The three permits lines inside
`%ArrayBufferPrototype%` that declare the shim-installed methods
(`transferToImmutable`, `sliceToImmutable`, `immutable`) stay as-is.

`@endo/pass-style`'s `byteArray` brand check no longer routes through
an intermediate prototype; observable behaviour is unchanged.
