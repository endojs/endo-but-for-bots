---
'@endo/captp': patch
---

Deprecate `@endo/captp`'s plain re-exports and repoint every in-repository
consumer at the packages that originally export those names, per the
inter-package plain re-exports design (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543). This is a sibling
slice to the `@endo/far` stage-1 pass in endojs/endo-but-for-bots#590.

`@endo/captp` plain-re-exports `Nat` (from `@endo/nat`), the entire `@endo/marshal`
surface (`export * from '@endo/marshal'`, which transitively includes the
`@endo/pass-style` names marshal itself re-exports), and `E` (from
`@endo/eventual-send`), without renaming or adding value. Each such re-export now
carries an `@deprecated` JSDoc tag pointing at the originating package, and the
in-repository importers of `E` via `@endo/captp` now import it from
`@endo/eventual-send` directly.

This is the non-breaking first stage: the re-exports still exist, so any importer
that has not yet been repointed (including importers outside this repository)
keeps working. No name's runtime binding changes, so no consumer package is
version-bumped; only `@endo/captp` takes a patch for the added deprecation
notices. The follow-up stage removes the now-unreferenced re-exports under a
major version bump.
