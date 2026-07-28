---
'@endo/eslint-plugin': minor
---

The `style` preset now enforces `jsdoc/check-tag-names` as an error instead of
the inherited warning. Consumers of `plugin:@endo/style` (and the `strict`
preset that extends it) will see lint errors on JSDoc block tags the plugin's
typescript-flavor tag set does not recognize, such as the TSDoc-only `@remarks`.
Rewrite the offending comment to use a recognized tag or a plain description.
