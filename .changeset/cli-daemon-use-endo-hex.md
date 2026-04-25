---
'@endo/cli': patch
'@endo/daemon': patch
---

Hex formatting of random bytes and SHA-512 digests now goes through `@endo/hex`'s `encodeHex` instead of Node's `Buffer.toString('hex')`.
