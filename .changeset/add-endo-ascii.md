---
'@endo/ascii': minor
'@endo/sha256': patch
---

Add `@endo/ascii`, a platform-neutral encoder that turns ASCII text into bytes,
one byte per code unit, and asserts every code unit is in the admitted 7-bit
range `0x00`–`0x7f`, hard-failing on the first that is not. It is pure
JavaScript — no `TextEncoder`, no `node:` imports, no host globals — so it runs
under XS exactly as under Node.js and browsers, and it is the XS-floor
replacement for the ad-hoc `Uint8Array.from(text, ch => ch.charCodeAt(0))`
helper that truncates rather than rejects non-ASCII code units.

`@endo/sha256`'s XS spot check now encodes its vectors with `@endo/ascii`
instead of a local copy of that helper.
