---
'@endo/compartment-mapper': major
---

Rename the `search` export to `searchCompartmentDescriptor`. The name now
states what the function seeks — the nearest enclosing compartment
descriptor (`package.json`) for a module — and no longer collides
conceptually with the compartment mapper's upward walk
(`walkToCompartmentRoot`), which climbs to the nearest *named* ancestor.
The behavior is unchanged; only the exported name differs.
