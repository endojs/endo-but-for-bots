---
'@endo/ocapn-noise': major
---

Separate transport registration from listening.

`addTransport(transport)` now registers only the outbound dial adapter.
Call `await network.listen(transport, options)` to bind an inbound listener and publish its hints.
Close the returned listener before removing its transport.
TCP and WebSocket bind options now belong to `network.listen` instead of their transport constructors.
