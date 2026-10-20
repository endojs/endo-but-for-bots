---
'@endo/ocapn-noise': minor
---

Add `makeTcpCborTransport` to `@endo/ocapn-noise/transport/tcp`: a TCP
transport that frames each Noise handshake and ciphertext message as one
definite-length CBOR byte string (`@endo/cbor-frame`), with declared lengths
capped before allocation. It registers under the scheme `tcp+cbor`, distinct
from the netstring `tcp` transport, so both can be registered on one network
without either being mistaken for the other on the wire.
