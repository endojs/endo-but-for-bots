---
'@endo/daemon': minor
---

Withhold the `@endo` special name from non-root (child) hosts. A host created by
`provideHost` no longer carries `@endo`, so `E(child).lookup('@endo')` — and
thus `E(await child.lookup('@endo')).host()`, which returned the root
principal — now fails outright rather than handing a delegated child
full-authority access to the root host. The root host keeps a working `@endo`.

This closes issue #1128 (ambient `@endo` made every child host a full-authority
peer of the root) and is the trust boundary the `@secrets` confinement depended
on. The guard is applied at host realization: `specialNames` is recomputed from
the host formula every time a host is realized and is never persisted, so this
also fixes already-persisted child host formulas — those formulated before this
release incarnate without `@endo` — with no migration.
