---
'@endo/daemon': minor
---

Add `EndoDirectory.readOnly()`, which mints a read-only `ReadableNameHub` view of a directory.
Attenuation is shallow: a looked-up nested directory is returned live and writable, so a holder that needs a recursively read-only surface must re-attenuate results itself.
The method is added to the exported `DirectoryInterface` guard as an unconditional method, so an out-of-tree exo built with `makeExo('X', DirectoryInterface, behavior)` must now implement `readOnly`; agent exos (`EndoGuest`/`EndoHost`) do not yet carry it, so `E(host).readOnly()` rejects today.
