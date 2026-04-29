---
'@endo/compartment-mapper': patch
---

`makeReadPowers` and `makeReadNowPowers` now derive `computeSha512` from the `crypto` argument using `@endo/hex` to format the SHA-512 digest, replacing the previous `Buffer.toString('hex')` formatter.
Callers continue to pass the Node `crypto` module directly; no API change is required.
