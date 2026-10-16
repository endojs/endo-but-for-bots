---
'@endo/ocapn': minor
'@endo/thixotrope': patch
'@endo/goblin-chat': patch
'@endo/ocapn-iroh': patch
---

`@endo/ocapn` core no longer runs the `op:start-session` handshake. The
handshake moves to a network adapter, `makeStartSessionNetwork` from
`@endo/ocapn/netlayer/start-session`, which connect-style netlayers
(`tcp-testing-only`, WebSocket, iroh, the thixotrope durable netlayer)
compose. A network factory now receives `SessionHandlers`
(`adoptSession`) instead of `NetlayerHandlers`. The `captpVersion` option
moves from `makeOcapn` to the adapter. `makeOcapn` refuses a
`connect`-only network at construction. A `provideSession` that resolves
`undefined` now rejects instead of falling back to a plaintext hello. The
wire is unchanged.
