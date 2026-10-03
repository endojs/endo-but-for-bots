---
'@endo/platform': minor
---

Add `makeTreeReadPowers(tree, { root, canonical })` as `@endo/platform/fs/tree-read-powers`: compartment-mapper `ReadPowers` over a `ReadableTree` or `Mount` under a synthetic `file:` root, refusing `..`, empty, separator, and NUL segments (raw or percent-encoded) before any lookup.
