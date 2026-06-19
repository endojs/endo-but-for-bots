---
'@endo/pass-style': major
'@endo/bytes': major
'@endo/patterns': patch
'@endo/marshal': patch
'@endo/ocapn': patch
---

Narrow the `byteArray` pass style to plain frozen `Uint8Array` only.

The `byteArray` pass-style brand check previously accepted both raw
immutable `ArrayBuffer` values and plain frozen `Uint8Array` values
backed by an immutable `ArrayBuffer`. It now accepts only the latter
shape: a plain frozen `Uint8Array` whose backing buffer is a plain
frozen immutable `ArrayBuffer`. Raw immutable `ArrayBuffer` values
are no longer recognised as `byteArray`; the `ByteArray` TypeScript
alias is now `Uint8Array` (was `ArrayBuffer`).

`@endo/bytes`: `bytesToImmutable(view)` now wraps the immutable
`ArrayBuffer` produced by `sliceToImmutable` in a fresh frozen
`Uint8Array` before hardening; the return type is now `Uint8Array`
(was `ArrayBuffer`). `bytesFromImmutable` accepts the new shape
(`ArrayBufferView`) in addition to the prior `ArrayBufferLike`.
`concatImmutables` returns a `Uint8Array` rather than an
`ArrayBuffer`, and accepts either shape on input.

`@endo/marshal`: the byteArray rank-compare's `ArrayBuffer.prototype`
dispatch arm becomes dead code and is removed; values arrive as
`Uint8Array` and are read via the integer-indexed protocol directly.

`@endo/patterns`: the `byteArray` matcher's `TypeFromPattern` and
`getMatcherKind` types resolve to `Uint8Array` (was `ArrayBuffer`).

`@endo/ocapn`: the syrup `writeBytestring` types widen to accept
`ArrayBufferView | ArrayBufferLike`; the byteArray-shaped branded
client types (`SessionId`, `SwissNum`, `PublicKeyId`) change from
`ArrayBufferLike & {_brand}` to `Uint8Array & {_brand}`.
