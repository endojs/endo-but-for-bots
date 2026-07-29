---
'ses': patch
'@endo/module-source': minor
'@endo/compartment-mapper': patch
---

Fix star-export cycles involving renamed reexports, preserving module namespace key order and reporting unresolved reexports during linking instead of exposing phantom exports.

Additionally, enforce ECMA-262 temporal-dead-zone semantics for cross-module reads through a module namespace import during cycle evaluation, for both the `export *` and `export { y } from` reexport forms.
SES now raises `ReferenceError` for cross-module reads of `const` and `let` bindings during a cycle's temporal dead zone. `var` bindings continue to read `undefined`.

`@endo/compartment-mapper` now requires this release of `@endo/module-source`. Rebuild existing `pre-mjs-json` archives when upgrading: their embedded functor source retains the previous initialization order.

Resolves endojs/endo#59.
