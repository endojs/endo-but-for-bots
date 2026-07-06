---
'@endo/platform': minor
'@endo/agentry': minor
'@endo/preact-container': minor
---

Migrate the `exports` maps to `.js`-suffixed subpath keys, matching the
convention `@endo/daemon`, `@endo/exo`, and `@endo/marshal` already follow. The
extensionless keys are replaced, so importers must now spell the extension:

- `@endo/platform`: `./fs.js`, `./fs/lite.js`, `./fs/lite/types.js`,
  `./fs/node.js`, `./fs/extended.js`, `./proc.js`, `./exo-fs.js` (the
  `./fs/extended/*` wildcard is unchanged).
- `@endo/agentry`: `./harness.js`, `./define-agent.js`, `./execute.js`,
  `./eval.js`.
- `@endo/preact-container`: `./renderer.js`, `./compartment.js`.

This is a breaking change to the packages' public subpath surface. All
in-repo consumers are migrated in the same change, and the
`@endo/jsdoc-import-extensions` lint rule now enforces the `.js` suffix on these
subpaths in JSDoc `@import` tags.
