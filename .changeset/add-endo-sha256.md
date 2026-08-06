---
'@endo/sha256': minor
'@endo/chat': patch
'@endo/platform': patch
---

Add `@endo/sha256`, a platform-neutral synchronous SHA-256 package for
`Uint8Array` values.
It selects Node crypto, a browser-safe JavaScript implementation, or the
binary-safe XS host hashing interface by condition.

Use `@endo/sha256` in `@endo/chat` and `@endo/platform` to avoid static
`node:crypto` imports in their XS bundle paths.
