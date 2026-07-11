---
'@endo/pass-style': patch
---

Deprecate `@endo/pass-style`'s plain type re-export of `Checker`, per the
inter-package plain re-exports design (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543). This is a sibling
slice to the `@endo/far` stage-1 pass in endojs/endo-but-for-bots#590, requested
by @erights on endojs/endo-but-for-bots#660.

`@endo/pass-style` plain-re-exports the `Checker` type from
`@endo/common/ident-checker.js` (`export type { Checker } from
'@endo/common/ident-checker.js'`) without renaming or adding value. That
re-export now carries an `@deprecated` JSDoc tag pointing at `@endo/common`, and
the two in-repository importers of `Checker` via `@endo/pass-style`
(`src/passStyle-helpers.js` and `src/types.test-d.ts`) are repointed onto
`@endo/common/ident-checker.js` directly. `@endo/pass-style` already depends on
`@endo/common`, so no workspace dependency is added.

This is the non-breaking first stage: the re-export still exists, so any importer
outside this repository keeps working. No runtime binding changes; only
`@endo/pass-style` takes a patch for the added deprecation notice. The follow-up
stage removes the now-unreferenced re-export under a major version bump.
