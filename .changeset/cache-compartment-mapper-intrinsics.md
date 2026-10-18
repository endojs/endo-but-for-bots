---
'@endo/compartment-mapper': patch
---

Compartment Mapper now captures the `URL`, `Function`, `Promise`, `Proxy`,
and `Set` intrinsics when its modules initialize, so replacing those globals
afterward no longer changes module location resolution, the fallback file URL
conversions of `makeReadPowers` without a `url` power, or the CommonJS export
wrapper.
