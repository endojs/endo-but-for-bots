---
'ses': patch
---

Under XS, the `Compartment` adapter installed by `ses` now supports `load()` for shim compartments, delegating to the shim module loader as `import()` and `importNow()` already do. This lets `@endo/compartment-mapper` walk a module graph on XS without executing it, as it does to capture and archive applications. A native compartment (`__native__: true`) still has no `load()`, and calling it throws a `TypeError`.
