---
'@endo/pass-style': major
'@endo/bytes': major
'@endo/hex': minor
'@endo/utf8': major
'@endo/patterns': patch
'@endo/marshal': patch
'@endo/ocapn': patch
---

Narrow the `byteArray` pass style to plain frozen `Uint8Array` only; move immutable byte-array utilities to `@endo/pass-style`; extract UTF-8 transcoding to new `@endo/utf8` package.

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
`@endo/bytes` also removes `from-string.js` (`bytesFromText`) and
`to-string.js` (`bytesToText`); UTF-8 transcoding moves to the new
`@endo/utf8` package.
`@endo/bytes` now concerns only mutable `Uint8Array` helpers that are
not format-specific: `concat.js`, `equals.js`, and `compare.js`.
The `@endo/immutable-arraybuffer` dependency is also removed from
`@endo/bytes` as it was only required by `to-immutable.js`.

`@endo/utf8` is a new package providing UTF-8 transcoding via the web
`TextEncoder` and `TextDecoder` APIs, captured once at module load for
SES hardening.
It mirrors the shape of `@endo/hex` and `@endo/base64` with three
focused sub-path exports:
`encodeUtf8` (string to `Uint8Array`), `decodeUtf8` (bytes to string,
lenient), and `strictDecodeUtf8` (bytes to string, fatal on malformed
sequences).

`@endo/pass-style` gains three additional sub-path exports for UTF-8
transcoding that are aware of the byteArray passable form:
- `@endo/pass-style/encode-utf8.js` exports `encodeUtf8(s)`: encodes a
  string as a passable `byteArray` (frozen `Uint8Array` over immutable
  `ArrayBuffer`).
- `@endo/pass-style/decode-utf8.js` exports `decodeUtf8(input)`:
  decodes a byteArray passable or any `ArrayBufferView` to a string,
  substituting U+FFFD for malformed sequences.
- `@endo/pass-style/strict-decode-utf8.js` exports
  `strictDecodeUtf8(input)`: decodes a byteArray passable or any
  `ArrayBufferView` to a string, throwing on malformed sequences.

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
  `ReadonlyArray<ArrayBufferView | ArrayBufferLike>`.
  A `@endo/bytes/compare.js` module exports `compareBytes`, which
  compares any two byte inputs lexicographically without a copy.
  `bytesFromText` and `bytesToText` move to `@endo/utf8` (see below).

- `@endo/utf8`: new package.
  `encodeUtf8` (formerly `bytesFromText`) encodes a string as UTF-8
  bytes.
  `decodeUtf8` (formerly `bytesToText` without options) decodes bytes to
  a string, substituting U+FFFD for malformed sequences.
  `strictDecodeUtf8` (formerly `bytesToText({ fatal: true })`) decodes
  bytes to a string, throwing on malformed sequences.
  All three accept `ArrayBufferView | ArrayBufferLike`; the two decode
  variants handle immutable-backed `Uint8Array` values by detecting
  `ArrayBuffer.prototype.immutable` and copying to a mutable buffer only
  when `TextDecoder.decode` requires it.

- `@endo/pass-style/concat-bytes.js`: `concatBytes` now delegates the
  accumulation loop to `@endo/bytes/concat.js`; `@endo/bytes` is added
  as a runtime dependency of `@endo/pass-style`.
  No dependency cycle exists: `@endo/bytes` carries `@endo/pass-style`
  only as a devDependency (test-only).

- `@endo/ocapn`: removed `fromBytes` casts in `compareImmutableArrayBuffers`
  (now delegates to `@endo/bytes/compare.js`), `toHex` (now calls
  `encodeHex` directly), `decodeBytestringLabel` (now uses
  `strictDecodeUtf8` from `@endo/utf8`), `ocapNSignatureToBytes`
  (concatBytes accepts both forms), `makeSessionId` (compareBytes +
  concatBytes accept both forms), and `base32Encode` (for-of iteration
  works on immutable views).
  The `giftId` type in `HandoffGive` and `deposit-gift` is narrowed
  from `ArrayBufferView | ArrayBufferLike` to `Uint8Array`.
  All callers of `bytesFromText` / `bytesToText` updated to use
  `encodeUtf8` / `strictDecodeUtf8` from `@endo/utf8`.
