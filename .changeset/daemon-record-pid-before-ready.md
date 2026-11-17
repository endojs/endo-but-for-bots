---
'@endo/daemon': patch
---

The daemon now records `endo.pid` before signaling that it is ready, so a
`stop()` issued as soon as `start()` resolves reliably finds and stops the
daemon instead of leaving it running.
