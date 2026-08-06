---
'@endo/cli': minor
---

`endo run`, `endo make`, and `endo archive` now accept TypeScript sources in the
application being confined. `.ts`, `.mts`, and `.cts` files are type-stripped and
archived as JavaScript. Type-directed syntax such as enums, namespaces, and
parameter properties is not supported. This applies to application sources;
TypeScript dependencies under `node_modules` must still be built for publication.
