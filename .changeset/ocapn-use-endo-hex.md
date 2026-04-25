---
'@endo/ocapn': minor
---

`packages/ocapn/src/client/util.js`'s `toHex` now uses `@endo/hex`'s `encodeHex` instead of `Buffer.from(...).toString('hex')`.  Removes the dependency on Node's `Buffer`, dispatches to the native `Uint8Array.prototype.toHex` intrinsic when available, and shares one hex implementation with the rest of the Endo packages.
