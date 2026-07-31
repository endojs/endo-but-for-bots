---
'@endo/daemon': patch
---

Migrate persisted host formulas that predate the required `registry` field (added in the `EndoRegistry` capability release) on daemon startup, rather than failing to incarnate them. Each pre-existing host is upgraded in place with a fresh registry formula pointed at the daemon's default registry URL, so `@registry` resolves the same way it does for a freshly formulated host.
