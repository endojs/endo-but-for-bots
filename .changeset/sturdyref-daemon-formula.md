---
'@endo/daemon': minor
---

The daemon can mint a SturdyRef for a formula without incarnating it.
`makeFormulaSturdyRefKit({ provide })` returns `sturdyRefForFormula(id)`, which
records only the formula identifier, and a closely held `formulaIdOf(ref)`.
Enlivening the ref (`enliven` from `@endo/sturdyref`) incarnates the formula
through `provide`, reusing an existing incarnation. The daemon core exposes
both functions.
