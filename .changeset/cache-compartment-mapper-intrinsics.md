---
'@endo/compartment-mapper': patch
---

The import hooks, the CommonJS export wrapper, and the read powers from `makeReadPowers` no longer depend on the global `URL`, `Promise`, `Proxy`, `Map`, or `Set` after the module initializes, so a host that later replaces those globals does not disturb loading through these paths.
Other paths, including `mapNodeModules`, still consult the current globals.
