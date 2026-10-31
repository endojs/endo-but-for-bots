---
'@endo/daemon': patch
---

Snapshot live mounts before importing packages in daemon workers, retaining the
snapshot only for the resulting caplet's lifetime.
