---
'@endo/eventual-send': patch
'@endo/patterns': patch
---

`E` (`src/E.ts`) and the pattern matchers (`src/patterns/patternMatchers.ts`) are now authored as TypeScript with erasable type syntax only.
The published packages still contain only `.js`, with the same entrypoints, exports, and runtime behavior.

Loading these packages from source instead of from the registry now requires Node.js type stripping, which is on by default in `^22.18.0 || >=23.6.0`.
An install from a git checkout no longer works, because Node.js does not strip types under `node_modules`.
