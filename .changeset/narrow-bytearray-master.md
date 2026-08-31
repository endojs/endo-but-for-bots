---
'@endo/base64': patch
'@endo/bytes': major
'@endo/harden': patch
'@endo/hex': patch
'@endo/marshal': minor
'@endo/ocapn': patch
'@endo/pass-style': major
'@endo/patterns': patch
---

Narrow the `byteArray` pass style to a plain, hardened, whole-buffer
`Uint8Array` backed by an immutable `ArrayBuffer`. Raw immutable
`ArrayBuffer` values are no longer byteArray passables, and the public
`ByteArray` type is now `Uint8Array`.

Add immutable byte helpers to `@endo/immutable-arraybuffer` and adapt
`@endo/bytes`, `@endo/base64`, and `@endo/hex` to read both genuine views and
the immutable-arraybuffer emulation correctly. The existing
`bytesToImmutable` and `bytesFromImmutable` entry points remain as compatibility
adapters, but now produce and consume the narrowed shape.

Add byteArray encodings to capdata, smallcaps, encode-passable, and
marshal-justin, and update rank comparison, pattern matcher types, hardening,
and OCapN's Syrup and cryptographic byte boundaries for `Uint8Array`.

Deploy decoders before producers: older decoders reject the new byteArray
encodings, so producers must not emit byteArray values until consumers have
upgraded.
