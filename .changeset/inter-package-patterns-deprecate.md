---
'@endo/patterns': patch
---

Deprecate `@endo/patterns`'s plain type re-export of `FullCompare`, per the
inter-package plain re-exports design (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543). This is a sibling
slice to the `@endo/far` stage-1 pass in endojs/endo-but-for-bots#590.

`@endo/patterns` plain-re-exports the `FullCompare` type from `@endo/marshal`
(`export type { FullCompare } from '@endo/marshal'`) without renaming or adding
value. That re-export now carries an `@deprecated` JSDoc tag pointing at
`@endo/marshal`. There are no in-repository importers of `FullCompare` via
`@endo/patterns`, so this slice is deprecate-only (no repointing).

This is the non-breaking first stage: the re-export still exists, so any importer
outside this repository keeps working. No runtime binding changes; only
`@endo/patterns` takes a patch for the added deprecation notice. The follow-up
stage removes the now-unreferenced re-export under a major version bump.
