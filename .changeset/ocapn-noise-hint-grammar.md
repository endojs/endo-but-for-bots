---
'@endo/ocapn-noise': minor
---

Add `@endo/ocapn-noise/hints`, which parses and renders `<transport>+<codec>`
connection hints such as `tcp+cbor:[::1]:3469` and
`wss+cbor:minion.town:443/.well-known/ocapn-cbor-np`.
TCP values are a `host:port` authority with IPv6 literals bracketed, and
WebSocket values are `host:port/path` with a required path.
The transports do not publish these hints yet.
