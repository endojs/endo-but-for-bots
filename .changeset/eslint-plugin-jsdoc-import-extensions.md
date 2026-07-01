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
must carry an extension, and bare-package specifiers stay exempt (the
`ignorePackages` half).
