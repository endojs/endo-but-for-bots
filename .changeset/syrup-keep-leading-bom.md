---
'@endo/ocapn': patch
---

Syrup strings, selectors and record labels that begin with U+FEFF now keep that character when decoded. Each value is decoded by its own `TextDecoder` call, and a WHATWG decoder without `ignoreBOM` strips a leading U+FEFF from its input, so such a passable string did not round-trip. Both Syrup decoders are now built with `{ fatal: true, ignoreBOM: true }`.
