---
'@endo/eventual-send': patch
'@endo/patterns': patch
---

Author `E` in `@endo/eventual-send` (`src/E.ts`) and the pattern matchers in
`@endo/patterns` (`src/patterns/patternMatchers.ts`) as TypeScript with
erasable type syntax only. The package entrypoints and exports are
unchanged. When the packages are packed with `yarn pack:all`, ts-node-pack
erases the types and rewrites relative `.ts` specifiers, so the published
tarballs contain `.js` only. The helper types from the removed
`src/patterns/types.ts` now live in `patternMatchers.ts`; they were never
exported from either package.

Installing these packages from a git checkout or a workspace link, rather than
from the published tarball, puts `.ts` files under `node_modules`. Node.js
refuses to strip types there, so that kind of install is not supported.
