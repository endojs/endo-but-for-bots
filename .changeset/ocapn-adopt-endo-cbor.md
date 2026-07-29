---
'@endo/ocapn': patch
---

Adopt `@endo/cbor` for the CBOR codec's primitive layer (phase 2 of
`designs/cbor-codec.md`). The module-level head, byte/text-string, tag, float,
simple-value, and bignum helpers in `src/cbor/{encode,decode}.js` are replaced by
imports from `@endo/cbor`; the `CborWriter` / `CborReader` classes, their
`OcapnWriter` / `OcapnReader` interface, structure tracking, record labels,
`peekTypeHint`, the byte-string immutability conversion, and the diagnostic
notation codec are unchanged. Encoder output is byte-for-byte identical. The one
observable change is on read: `@endo/cbor`'s readers are strict, so the decoder
now rejects non-minimal heads and non-minimal bignum payloads that the previous
hand-rolled reader tolerated (the design's intended tightening); the `name` +
byte-offset diagnostics are preserved.
