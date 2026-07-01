---
'@endo/eslint-plugin': minor
---

Add a `@endo/jsdoc-import-extensions` rule that requires a file extension on
relative module specifiers in JSDoc `@import` tags, wired into the `imports`
config alongside `import/extensions`. The `import` plugin only inspects real
`import`/`export`/`require` statements, so an extensionless specifier inside a
JSDoc `@import { … } from '…'` comment (for example `'../types'` instead of
`'../types.js'`) slipped past `import/extensions: 'always'`. The new rule closes
that gap for the JSDoc surface, mirroring the same policy: relative specifiers
must carry an extension.

The rule also enforces `.js` on `@endo/*` package subpaths in JSDoc `@import`
tags, but only where the target package's `exports` map offers just the
`.js`-suffixed key (resolved from disk, so a not-yet-migrated `@endo/*` package
that still publishes an extensionless subpath key is never flagged). Non-`@endo`
bare packages stay exempt (the `ignorePackages` half). Real `import`/`export`
statements for the same subpaths are already policed by `import/no-unresolved`;
this rule adds the JSDoc-only coverage the resolution-based rules cannot reach.
