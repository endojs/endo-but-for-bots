---
'@endo/init': patch
---

Deprecate `@endo/init`'s inter-package plain re-exports, per the inter-package
plain re-exports design (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543).

`@endo/init`'s entry points (`index.js`, `debug.js`, `debug-async-hooks.js`, and
`pre.js`) each plain-re-export the `@endo/lockdown` surface
(`export * from '@endo/lockdown/commit.js'` and the `commit-debug.js` /
`@endo/lockdown` variants) without renaming or adding value. Each such re-export
now carries an `@deprecated` JSDoc tag pointing at `@endo/lockdown`. No
in-repository importer imports a name through `@endo/init` (every importer uses
the bare side-effect form `import '@endo/init'`), so this slice is
deprecate-only: there is nothing to repoint. The deprecation is scoped to
importing names through `@endo/init`; the package's value is the lockdown side
effect of importing it, which is preserved and left undeprecated.

This is the non-breaking first stage: the re-exports still exist, so any importer
that has not yet been repointed (including importers outside this repository)
keeps working. No name's runtime binding changes, so no consumer package is
version-bumped; only `@endo/init` takes a patch for the added deprecation
notices. The follow-up stage removes the now-unreferenced re-exports under a
major version bump.
