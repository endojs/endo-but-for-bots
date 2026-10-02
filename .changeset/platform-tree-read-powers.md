---
'@endo/platform': minor
---

Add `makeTreeReadPowers(tree, { root, canonical })` to `@endo/platform/fs`: compartment-mapper `ReadPowers` over a `ReadableTree` or `Mount` under a synthetic `file:` root, refusing `..`, empty, and percent-encoded separator segments before any lookup.
