---
'@endo/ocapn': patch
---

Adopt `@endo/cbor` for the CBOR codec's primitive layer (phase 2 of
`designs/cbor-codec.md`). The module-level head, byte/text-string, tag, float,
simple-value, and bignum helpers in `src/cbor/{encode,decode}.js` are replaced by
imports from `@endo/cbor`; the `CborWriter` / `CborReader` classes, their
`OcapnWriter` / `OcapnReader` interface, structure tracking, record labels,
`peekTypeHint`, the byte-string immutability conversion, and the diagnostic
notation codec are unchanged.

Encoder output is byte-for-byte identical for every value the writer accepts.
Two observable changes come with the strictness `@endo/cbor` brings, both the
design's intended tightening:

- On read, the decoder now rejects non-canonical encodings the previous
  hand-rolled reader tolerated: non-minimal heads, non-minimal bignum payloads,
  indefinite lengths, and float16. The `name` + byte-offset diagnostics are
  preserved.
- On write, an argument of the wrong type is now rejected rather than coerced:
  `writeBoolean` and `writeFloat64` previously accepted any value and emitted
  `true` / a NaN pattern for it, turning a caller's type error into a
  well-formed message carrying the wrong value.

Writer and reader error messages are reworded, since they now come from
`@endo/cbor`.
