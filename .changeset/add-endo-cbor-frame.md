---
'@endo/cbor-frame': minor
---

Add `@endo/cbor-frame` package providing length-prefixed byte-string framing
using the CBOR major-type-2 (byte string) head grammar per RFC 8949,
mandatorily wrapped in CBOR tag 24 (Encoded CBOR data item).
Exports `makeCborFrameReader(input, opts)` and `makeCborFrameWriter(output, opts)`
with the same diagnostic-surface (`name`, `maxMessageLength`) and writer
shape (`chunked`) conventions as `@endo/netstring`.

This is a framing primitive, not a CBOR codec.
It implements just enough of CBOR to read and write a byte-string head;
consumers carrying structured CBOR encode or decode the payload bytes
themselves with whatever CBOR codec they prefer.
