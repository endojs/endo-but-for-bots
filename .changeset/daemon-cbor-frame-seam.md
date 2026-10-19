---
'@endo/daemon': minor
---

The daemon's private socket now accepts clients framed with either
`@endo/netstring` or `@endo/cbor-frame`.
Each connection's framing is classified from its first byte (a netstring
length digit or the cbor-frame tag-24 prefix), and the daemon mirrors the
client's framing on its replies; the `endor` supervisor bridge does the same.
`connection.js` gains `makeFramedCapTP(framing, ...)` and `makeSniffingCapTP`;
`makeNetstringCapTP` is now an alias for `makeFramedCapTP('netstring', ...)`.
Every initiator still sends netstrings, so the wire is unchanged for existing
peers.
