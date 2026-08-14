---
'@endo/daemon': patch
---

Adopt `@endo/cbor` for the CBOR codec primitives in `src/envelope.js` (phase 4
of `designs/cbor-codec.md`). The hand-rolled head, integer, byte-string, and
text-string write and read helpers — the third in-repo copy of the same
canonical head grammar — are replaced by imports from `@endo/cbor`
(`writeArrayHeader` / `writeInt` / `writeByteString` / `writeTextString` over
`makeCborWriter`, and `readArrayHeader` / `readInt` / `readByteString` /
`readTextString` over `makeCborReader`). The envelope framing
(`encodeEnvelope` / `decodeEnvelope` / `encodeFrame` / `decodeFrame` /
`readFrameFromStream` / `writeFrameToStream`) and the
`[handle, verb, payload, nonce]` protocol shape are unchanged. Encoder output is
byte-for-byte identical, verified against the frozen base across every
argument-width boundary. The one observable change is on read: `@endo/cbor`'s
readers are strict, so the decoder now rejects non-minimal heads that the
previous tolerant reader accepted (the design's intended tightening); the Rust
peer writes canonical heads, so no live traffic exercises it.
