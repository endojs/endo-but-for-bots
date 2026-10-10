---
'@endo/compartment-mapper': patch
---

`makeFunctorFromMap` and `makeScriptFromMap` (the `functor-lite.js` and `script-lite.js` entry points) now honor the `syncModuleTransforms` option.
Previously it was silently ignored.
Bundles from `makeBundle` now use the same generated runtime as the lite entry points; the emitted text differs slightly, but behavior is unchanged.
