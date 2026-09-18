---
'@endo/daemon': minor
---

Add `EndoDirectory.readOnly()`, which mints a read-only `ReadableNameHub` view of a directory.
Attenuation is shallow: a looked-up nested directory is returned live and writable, so a holder that needs a recursively read-only surface must re-attenuate results itself.
