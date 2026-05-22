---
'@endo/module-source': patch
---

Fix reassignment of top-level exported `export let`, `export var`, and
`export function` bindings in `nestedEvaluate`-format bundles. Previously
the module-source transform softened the declaration's local name to
`$c_NAME` but left every reassignment site referencing the original
`NAME`, which is not in scope in a raw `nestedEvaluate` bundle (the SES
compartment case had concealed the gap via the `moduleLexicals` scope
proxy's set-trap, which a bundle does not have). The bundled `X` export
of `export let X = 1; X = 2;` was observably stuck at the initial value
and the local read sites threw `ReferenceError` (suppressed at the
top-level by SES's lexical fallback to `undefined`).

The transform now does a single up-front rename sweep over the program
to redirect every read and write of a live exported binding to the
softened local, and instruments each reassignment (assignment and
`++`/`--`) with a `$h_live.NAME(...)` publish call so the live cell is
updated in both the bundle and SES compartment consumers.
