---
'@endo/eslint-plugin': minor
---

Add the `@endo/no-nonrelative-ts-import` rule, enabled in the `internal` config.
It forbids `.ts`, `.mts`, and `.cts` import specifiers on non-relative paths.
Node.js cannot resolve `.ts` under `node_modules`, so cross-package imports must go through a package's published `.js` entrypoint.
