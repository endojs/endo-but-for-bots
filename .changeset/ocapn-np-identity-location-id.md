---
'@endo/ocapn': minor
---

Key `.np` session identity on `(network, designator)`. `locationToLocationId`
now reads the network as `network ?? transport` and omits hints for the
identity-keyed `np` network, so one authenticated Noise peer keeps a single
location ID (and a single session) however its published hints change. Legacy
netlayers keep their sorted-hints location IDs. The new `locationNetworkId`
helper names the migration rule, and the WebSocket netlayer now declares
`network` alongside its legacy `transport`.
