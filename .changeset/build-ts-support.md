---
'@endo/eventual-send': patch
'@endo/patterns': patch
---

Author `E` in `@endo/eventual-send` (`src/E.ts`) and the pattern matchers in `@endo/patterns` (`src/patterns/patternMatchers.ts`) as TypeScript with erasable type syntax only.
The package entrypoints, exports, and runtime behavior are unchanged.
When the packages are packed with `yarn pack:all`, ts-node-pack erases the types and rewrites relative `.ts` specifiers, so the published tarballs contain `.js` only.
The helper types from the removed `src/patterns/types.ts` now live in `patternMatchers.ts`; they were never exported from either package.

This is a patch for consumers of the published tarballs, which are the supported way to install these packages.
Loading them from source is different.
A workspace link now needs a Node.js version that strips types by default (22.18 or later, or 23.6 or later), or a type-stripping hook.
An install from a git checkout puts `.ts` files under `node_modules`, where Node.js refuses to strip types, so that kind of install no longer works.
