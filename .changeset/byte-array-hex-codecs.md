---
'@endo/marshal': minor
---

A `byteArray` (a plain frozen `Uint8Array` backed by an immutable
`ArrayBuffer`) is now serializable through the capdata, smallcaps,
encode-passable, and marshal-justin codecs.

- **capdata**: byteArray encodes as `{"@qclass":"byteArray","data":"<hex>"}`.
- **smallcaps**: byteArray encodes as `"*<hex>"`. The reserved `*` prefix is
  now assigned to byteArray.
- **encode-passable**: byteArray encodes as
  `a<encodeBigInt(byteLength)>:<hex>`.  The Elias-delta length prefix gives
  shortlex ordering (matching `compareRank`) with no arbitrary size cap, and
  every character in the body is safe inside both `legacyOrdered` and
  `compactOrdered` array framings.
- **marshal-justin**: renders byteArray as
  `frozenBytes(decodeHex("<hex>"))`.

Hex conversion uses `@endo/hex` (`encodeHex` / `decodeHex`), and the decoded
`Uint8Array` is converted into a passable byteArray with
`@endo/immutable-arraybuffer`'s `frozenBytes`.

Syrup already supported this value; no change required there.

Deploy sequencing: producers should not emit byteArrays until decoders are
upgraded.  Older decoders reject the new encodings (unknown `@qclass`,
unknown smallcaps prefix, unknown encode-passable prefix); consumers must
ship the new decoder before producers begin emitting byteArray values.
