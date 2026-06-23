---
'@endo/pass-style': major
'@endo/bytes': major
'@endo/hex': minor
'@endo/utf8': major
'@endo/ascii': major
'@endo/patterns': patch
'@endo/marshal': patch
'@endo/ocapn': patch
---

Narrow the `byteArray` pass style to plain frozen `Uint8Array` only; move immutable byte-array utilities to `@endo/pass-style`; extract UTF-8 transcoding to new `@endo/utf8` package; add new `@endo/ascii` package for ASCII transcoding.

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
`@endo/bytes` now concerns only mutable `Uint8Array` helpers:
`concat.js`, `equals.js`, and `compare.js`.
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

`@endo/ascii` is a new package providing ASCII transcoding using plain
charCode arithmetic, without relying on `TextEncoder` or `TextDecoder`
(which do not support the `"ascii"` encoding label).
It mirrors the shape of `@endo/utf8` with three focused sub-path exports:
`encodeAscii` (string to `Uint8Array`), `decodeAscii` (bytes to string,
lenient), and `strictDecodeAscii` (bytes to string, throwing on values
outside the ASCII range).

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
from `@endo/pass-style` under the new names; replaced ASCII encoding
wrappers with direct calls to `@endo/ascii`.
