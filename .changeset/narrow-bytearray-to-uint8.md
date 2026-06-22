---
'@endo/pass-style': major
'@endo/bytes': major
'@endo/hex': minor
'@endo/patterns': patch
'@endo/marshal': patch
'@endo/ocapn': patch
---

Narrow the `byteArray` pass style to plain frozen `Uint8Array` only; move immutable byte-array utilities to `@endo/pass-style`.

The `byteArray` pass-style brand check previously accepted both raw
immutable `ArrayBuffer` values and plain frozen `Uint8Array` values
backed by an immutable `ArrayBuffer`.
It now accepts only the latter shape: a plain frozen `Uint8Array` whose
backing buffer is a plain frozen immutable `ArrayBuffer`.
Raw immutable `ArrayBuffer` values are no longer recognised as
`byteArray`; the `ByteArray` TypeScript alias is now `Uint8Array` (was
`ArrayBuffer`).

`@endo/pass-style` gains three new subpath exports for working with
passable byte arrays:

- `@endo/pass-style/to-bytes.js` exports `toBytes(view)`: wraps a
  mutable `Uint8Array` in a hardened frozen `Uint8Array` backed by an
  immutable `ArrayBuffer`, producing a `byteArray`-passable value.
  (Replaces `@endo/bytes/to-immutable.js` and `bytesToImmutable`.)
- `@endo/pass-style/from-bytes.js` exports `fromBytes(buffer)`: copies
  a passable byte array into a fresh mutable `Uint8Array` for use with
  APIs that reject immutable backing buffers.
  (Replaces `@endo/bytes/from-immutable.js` and `bytesFromImmutable`.)
- `@endo/pass-style/concat-bytes.js` exports `concatBytes(buffers)`:
  concatenates a list of passable byte arrays into a single new passable
  byte array.
  (Replaces `@endo/bytes/concat-immutables.js` and `concatImmutables`.)

`@endo/bytes` removes its three immutable-related modules
(`to-immutable.js`, `from-immutable.js`, `concat-immutables.js`) and
the corresponding exports from `package.json`.
`@endo/bytes` now concerns only mutable `Uint8Array` helpers
(`concat.js`, `equals.js`, `from-string.js`, `to-string.js`).
The `@endo/immutable-arraybuffer` dependency is also removed from
`@endo/bytes` as it was only required by `to-immutable.js`.

`@endo/marshal`: the byteArray rank-compare's `ArrayBuffer.prototype`
dispatch arm becomes dead code and is removed; values arrive as
`Uint8Array` and are read via the integer-indexed protocol directly.

`@endo/patterns`: the `byteArray` matcher's `TypeFromPattern` and
`getMatcherKind` types resolve to `Uint8Array` (was `ArrayBuffer`).

`@endo/ocapn`: updated all callers of the moved functions to import
from `@endo/pass-style` under the new names.

In a follow-up round (CHANGES_REQUESTED review 4542047082), read-only
byte-array operations in `@endo/bytes`, `@endo/hex`, `@endo/pass-style`,
and `@endo/ocapn` were generalized to accept both the frozen
`Uint8Array`-over-immutable-`ArrayBuffer` byteArray passable form and
plain mutable `Uint8Array` values, without expensive intermediate copies:

- `@endo/hex`: `encodeHex` and `jsEncodeHex` now accept
  `ArrayBufferView | ArrayBufferLike` directly.  The native
  `toHex`-dispatch path is used only for plain `Uint8Array` inputs to
  avoid feeding shim-proxy wrappers to native C++ code; all other
  inputs fall through to the JS polyfill, which reads via indexed
  access and works on immutable buffers without a copy.

- `@endo/bytes`: `concatBytes` now accepts
  `ReadonlyArray<ArrayBufferView | ArrayBufferLike>`.  `bytesToText` now
  accepts `ArrayBufferView | ArrayBufferLike`, detects immutable backing
  buffers via the `ArrayBuffer.prototype.immutable` accessor, and copies
  only when `TextDecoder.decode` would otherwise reject the input.  A
  new `@endo/bytes/compare.js` module exports `compareBytes`, which
  compares any two byte inputs lexicographically without a copy.

- `@endo/pass-style/concat-bytes.js`: `concatBytes` now delegates the
  accumulation loop to `@endo/bytes/concat.js`; `@endo/bytes` is added
  as a runtime dependency of `@endo/pass-style`.  No dependency cycle
  exists: `@endo/bytes` carries `@endo/pass-style` only as a
  devDependency (test-only).

- `@endo/ocapn`: removed `fromBytes` casts in `compareImmutableArrayBuffers`
  (now delegates to `@endo/bytes/compare.js`), `toHex` (now calls
  `encodeHex` directly), `decodeBytestringLabel` (now uses
  `bytesToText`), `ocapNSignatureToBytes` (concatBytes accepts both
  forms), `makeSessionId` (compareBytes + concatBytes accept both forms),
  and `base32Encode` (for-of iteration works on immutable views).
  The `giftId` type in `HandoffGive` and `deposit-gift` is narrowed
  from `ArrayBufferView | ArrayBufferLike` to `Uint8Array`.
