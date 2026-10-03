---
'@endo/platform': minor
---

Add `makeTreeReadPowers(tree, { root, canonical })` as `@endo/platform/fs/tree-read-powers`: compartment-mapper `ReadPowers` over a `ReadableTree` (pass a `Mount` as `mount.readOnly()` or `await mount.snapshot()`) under a synthetic `file:` root, refusing `..`, empty, separator, and NUL segments (raw or percent-encoded) before any lookup.
