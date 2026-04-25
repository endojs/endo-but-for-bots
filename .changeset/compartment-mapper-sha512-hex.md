---
'@endo/compartment-mapper': minor
'@endo/bundle-source': patch
---

`@endo/compartment-mapper` adds a new `./sha512-hex.js` entry point exporting `makeComputeSha512`, which uses `@endo/hex` to format the SHA-512 digest.
`makeReadPowers`/`makeReadNowPowers` accept an optional `computeSha512` parameter that overrides the legacy `Buffer.toString('hex')` fallback.

`node-powers.js` itself does not import `@endo/hex`, so test scaffolding that loads `'ses'` directly and runs `lockdown()` later remains compatible.

`@endo/bundle-source` (`cache.js`, `src/script.js`, `src/zip-base64.js`) now passes `computeSha512: makeComputeSha512(crypto)` so bundling uses the shared `@endo/hex` formatter and dispatches to the native `Uint8Array.prototype.toHex` intrinsic when available.
