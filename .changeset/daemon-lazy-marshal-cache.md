---
'@endo/daemon': patch
---

Load persisted marshal bodies on demand and release resolved copy data from
daemon caches. Preserve formula metadata, capability identity, lifecycle
contexts, and all durable journal records even when formula collection is off.
