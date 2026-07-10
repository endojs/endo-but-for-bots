---
'@endo/marshal': patch
---

Deprecate `@endo/marshal`'s plain re-exports of the `@endo/pass-style` surface
and repoint every in-repository consumer at `@endo/pass-style`, per the
inter-package plain re-exports design (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543). This is a sibling
slice to the `@endo/far` stage-1 pass in endojs/endo-but-for-bots#590.

`@endo/marshal` plain-re-exports the whole `@endo/pass-style` value surface
(`export * from '@endo/pass-style'`) plus `deeplyFulfilled`, without renaming or
adding value. Each such re-export now carries an `@deprecated` JSDoc tag pointing
at `@endo/pass-style`, and every in-repository importer of a pass-style-origin
name (`Far`, `Remotable`, `passStyleOf`, `makeTagged`, `isPassable`, the
`Passable` type, and so on) now imports it from `@endo/pass-style` directly.

This is the non-breaking first stage: the re-exports still exist, so any importer
that has not yet been repointed (including importers outside this repository)
keeps working. No name's runtime binding changes, so no consumer package is
version-bumped; only `@endo/marshal` takes a patch for the added deprecation
notices. The follow-up stage removes the now-unreferenced re-exports under a
major version bump.
