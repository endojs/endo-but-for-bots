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

The `[Symbol.toStringTag]` slot is preserved as an own property on each
emulated immutable buffer (not on the shared prototype), so
`Object.prototype.toString.call(immuAB)` continues to return
`'[object ImmutableArrayBuffer]'` (as in master) while genuine
ArrayBuffers continue to read as `'[object ArrayBuffer]'`. This keeps
`concordance` (and any other downstream consumer that sniffs the
toStringTag to decide whether the value is a genuine exotic) from
misrouting an emulated immutable through `Buffer.from`, which throws
because the emulated immutable is not an exotic object.

The package's public exports remain `isBufferImmutable`,
`sliceBufferToImmutable`, and `optTransferBufferToImmutable` from
`index.js`. Narrowing the exports surface to `isBufferImmutable` only
(the destination state envisioned in the design) is the premise-2
follow-up PR and is out of scope here, since the bytes-side consumer
that still uses the two free functions has not yet migrated to the
shim's method form.

`ses` drops the `%ImmutableArrayBufferPrototype%` permits entry, which
no longer has a referent. The three permits lines inside
`%ArrayBufferPrototype%` that declare the shim-installed methods
(`transferToImmutable`, `sliceToImmutable`, `immutable`) stay as-is.

`@endo/pass-style`'s `byteArray` brand check no longer routes through
an intermediate prototype; observable behaviour is unchanged.
