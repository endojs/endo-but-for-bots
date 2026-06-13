---
'ses': patch
---

Fix a star-export cycle defect where a module reached more than once via `export *` and a renaming reexport with a different exported name (`export { y as x } from ...`) raised a spurious `SyntaxError: ... does not provide an export named 'X'` (latterly `TypeError: notify is not a function`).
The reexport wire-up now installs a deferred forwarding notifier that resolves through the upstream's notifier table on first subscription, so cyclic star-export fixed-points converge.

Additionally, enforce ECMA-262 temporal-dead-zone semantics for cross-module reads through a module namespace import during cycle evaluation, for both the `export *` and `export { y } from` reexport forms.
Previously, when the importing side of a cycle observed the upstream's binding through a namespace import (`r.y`) while the upstream's body was still on the evaluation stack and the binding's declaration had not yet been evaluated, the read returned the uninitialized slot value instead of raising; SES now matches Node.js's reference behavior and raises `ReferenceError` for `const` and `let` bindings during the TDZ window, while `var` bindings continue to read `undefined` because the hoisting preamble pre-initializes them before any downstream observation.

Resolves endojs/endo#59.
