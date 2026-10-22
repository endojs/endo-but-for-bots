---
'@endo/eslint-plugin': minor
---

The `internal` and `flat/internal` configs now reject explicit `any` as an error: `jsdoc/reject-any-type` for JSDoc types, including the `*` spelling and an `any` nested inside another type, and `@typescript-eslint/no-explicit-any` for TypeScript syntax.
These configs are for the Endo monorepo itself, which exempts the files that predate the rule through a baseline that may only shrink.
The `recommended`, `strict`, and `style` configs that other projects extend are unchanged.
