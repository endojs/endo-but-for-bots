---
'@endo/platform': minor
---

Add `makeTreeReadPowers(tree, { root, canonicalSegments })` as `@endo/platform/fs/tree-read-powers`: compartment-mapper `ReadPowers` over a `ReadableTree` (pass a `Mount` as `mount.readOnly()` or `await mount.snapshot()`) under a synthetic `file:` root, refusing `.`, `..`, separator, NUL, and control-character segments (raw or percent-encoded) before any lookup. Empty segments collapse, as Node's `fs` reads them.
