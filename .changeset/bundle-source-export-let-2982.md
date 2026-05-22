---
'@endo/module-source': patch
---

Fix reassignment of top-level `export let`, `export var`, and
`export function` bindings in `nestedEvaluate`-format bundles.
Previously `export let X = 1; X = 2;` produced a bundle whose `X`
export was observably stuck at the initial value; the bundled `X`
now tracks every reassignment, including compound assignment,
prefix and postfix `++` / `--`, destructuring
(`({ X } = obj)`, `[X] = arr`), and `for-of` / `for-in` loop
rebinding.
