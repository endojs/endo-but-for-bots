---
'@endo/platform': minor
'@endo/daemon': minor
---

Split the portable tree guards into lookup-only and enumerable capability
layers. Existing readable trees retain their full source-compatible surface,
while registries and other non-enumerable hubs can now withhold `list` authority
structurally with `LookupTreeInterface`.

Expose the npm registry at every daemon host's `@registry` name as that
directory-tree capability on both Node and Endor. Package metadata remains
lazy, exact-version leaves retain integrity-checked CAS behavior, and the old
method-call registry remains available only through an explicit compatibility
adapter.
