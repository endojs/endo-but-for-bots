---
'@endo/platform': minor
---

Add `makeTreeReadPowers(tree, { root, canonicalSegments })` as `@endo/platform/fs/tree-read-powers`: compartment-mapper `ReadPowers` over a `ReadableTree` under a synthetic `file:` root, refusing `.`, `..`, separator, NUL, and control-character segments (raw or percent-encoded) before any lookup. Empty segments collapse, as Node's `fs` reads them. The read powers do not check that the tree is read-only: a caller holding a `Mount` must pass `mount.readOnly()` or `await mount.snapshot()`.
