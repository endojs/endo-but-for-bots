---
'@endo/compartment-mapper': patch
---

Compartment Mapper now captures the `URL`, `Promise`, `Proxy`, `Map`, and `Set` intrinsics when its modules initialize, so replacing those globals afterward no longer changes module location resolution, import hook construction, the fallback file URL conversions of `makeReadPowers` without a `url` power, or the CommonJS export wrapper.
