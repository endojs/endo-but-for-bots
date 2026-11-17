---
'@endo/daemon': major
---

Add `EndoDirectory.readOnly()`, which mints a read-only `ReadableNameHub` view of a directory.
Attenuation is shallow: a looked-up nested directory is returned live and writable, so a holder that needs a recursively read-only surface must re-attenuate results itself.
The method is added to the exported `DirectoryInterface` guard as an unconditional method.
This is a breaking change to a published interface guard: an out-of-tree exo built with `makeExo('X', DirectoryInterface, behavior)` that lacks a `readOnly` method now fails at construction time, not merely on invocation.
Agent exos (`EndoGuest`/`EndoHost`) do not yet carry it, so `E(host).readOnly()` rejects today.
