---
'@endo/daemon': minor
---

Add `EndoDirectory.readOnly()`, which mints a read-only `ReadableNameHub` view of a directory.
The view exposes only the readable surface (`help`, `has`, `list`, `lookup`, `maybeLookup`) and withholds every mutator.
A less-trusted holder's malformed arguments are rejected at the attenuation boundary by the guarded `ReadableNameHub` exo, before they reach the backing directory.
Attenuation is shallow: a looked-up nested directory is returned live and writable, so a holder that needs a recursively read-only surface must re-attenuate results itself.
Repeated calls on the same directory return the same view rather than spawning a new worker each time.
