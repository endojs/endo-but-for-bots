---
'@endo/check-bundle': minor
---

`computeSha512` now uses `@endo/hex`'s `encodeHex` to format hash digests instead of `Buffer.toString('hex')`.
