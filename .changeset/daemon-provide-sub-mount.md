---
'@endo/daemon': minor
---

Add the `EndoHost.provideSubMount(mountName, subpath, newName, options?)` method and `DaemonCore.formulateSubMount` formula, minting a persistent `mount` rooted at a subdirectory of an existing mount and naming it in the caller's pet store. The child gets its own confinement root (a sub-mount at `/project/src` cannot reach `/project/.env` via `..`), the `subpath` is clamped at the parent root with a defense-in-depth `realpath` symlink-escape check, and the parent is recorded in the child formula so the child is cancelled together with its parent. Read-only attenuation is monotonic: a sub-mount of a read-only parent is read-only regardless of `options.readOnly`.
