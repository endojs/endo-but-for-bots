---
'@endo/spaces-util': patch
---

Deprecate `@endo/spaces-util`'s plain re-export of `assertValidLocator` and
repoint every in-repository consumer at `@endo/daemon/locator.js`, per the
inter-package plain re-exports design (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543). This is a sibling
slice to the `@endo/far` stage-1 pass in endojs/endo-but-for-bots#590, requested
by @erights on endojs/endo-but-for-bots#660.

`@endo/spaces-util` plain-re-exports `assertValidLocator` from
`@endo/daemon/locator.js` (`export { assertValidLocator } from
'@endo/daemon/locator.js'` in `src/locator.js`) without renaming or adding value.
That re-export now carries an `@deprecated` JSDoc tag pointing at
`@endo/daemon/locator.js`, and the sole in-repository importer of
`assertValidLocator` via `@endo/spaces-util` (`packages/chat/add-space-modal.js`)
is repointed onto `@endo/daemon/locator.js` directly. `@endo/chat` already depends
on `@endo/daemon`, so no workspace dependency is added.

This is the non-breaking first stage: the re-export still exists, so any importer
that has not yet been repointed (including importers outside this repository)
keeps working. No name's runtime binding changes, so no consumer package is
version-bumped; only `@endo/spaces-util` takes a patch for the added deprecation
notice. The follow-up stage removes the now-unreferenced re-export under a major
version bump.
