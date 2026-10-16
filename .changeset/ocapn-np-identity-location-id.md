---
'@endo/ocapn': minor
---

Key `.np` session identity on `(network, designator)`.
`locationToLocationId` now reads the network as `network ?? transport` (via the newly exported `locationNetworkId` helper in `@endo/ocapn/client/util`) and omits hints for the identity-keyed `np` network, so one authenticated Noise peer keeps a single location ID (and a single session) however its published hints change.
Location IDs change only for `np` peers and are in-memory session keys that are never persisted, so the change is not breaking; other netlayers keep their sorted-hints location IDs.
