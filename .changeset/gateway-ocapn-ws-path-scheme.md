---
'@endo/gateway': minor
---

Add the OCapN WebSocket path scheme to `@endo/gateway` (feature 8 of
`designs/gateway-package.md`). `src/ocapn-ws.js` names the canonical
`/ocapn-cbor-np` path (CBOR codec, Noise Protocol network), accepts the
legacy `/ocapn` as a compatibility alias, and exposes
`matchOcapnWebSocketPath` (the router predicate that decomposes a path
into its protocol/codec/network triple and reserves sibling slots such as
`/ocapn-syrups-tcp` and `/ocapn-cbor-tls`), `parseOcapnWebSocketPath` (the
strict variant), and `ocapnWebSocketConnectionHint` (which builds the OCapN
locator hint `wss:host=<host>;path=/ocapn-cbor-np;np`). This is the
path-naming half of feature 8; the live WebSocket listener and the Noise
frame relay land with the rest of the network surface in a later phase.
