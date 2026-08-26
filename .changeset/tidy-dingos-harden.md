---
'@endo/harden': patch
'ses': patch
---

Reject hardening TypedArrays backed by resizable or growable buffers on runtimes where native `Object.preventExtensions` incorrectly accepts them.
