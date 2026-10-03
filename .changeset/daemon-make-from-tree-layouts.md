---
'@endo/daemon': minor
'@endo/spaces-util': minor
---

`EndoHost.makeFromTree` now runs `node_modules` trees as well as archive-shaped trees.
A new `layout` option selects `'archive'`, `'node-modules-with-map'` (a pre-generated `compartment-map.json` whose locations are under the tree root), or `'node-modules-scan'` (a root `package.json` with `node_modules` in situ), and defaults to `'detect'`.
A new `entry` option names a module within the root package for `'node-modules-scan'`, bypassing its `"."` export.
The daemon captures a `node_modules` tree into archive bytes at each incarnation and runs them with the worker's `makeArchive` method, so Node and XS workers receive only archive bytes.
A package reached through more than one in-root link in a mount loads as one compartment, and a link out of the mount root is refused as an unsupported layout.
A tree that matches no layout, including a Yarn Plug'n'Play install, is rejected before anything is formulated.
`getFormula` on a `make-from-tree` formula reports its requested layout, the kind of tree it holds (`snapshot` or `mount`), and the layout its current incarnation ran as.
The `@endo/spaces-util` formula view lists those properties, and the `entry` a formula was made with, for `make-from-tree`.
