---
'@endo/ascii': major
---

Add `@endo/ascii`, a platform-neutral transcoder between ASCII text and bytes,
one byte per code unit. Its `encodeAscii` and `decodeAscii` functions assert
every value is in the admitted 7-bit range `0x00`–`0x7f`, hard-failing on the
first that is not. Both functions are available from the package entry, and
from the `./encode.js` and `./decode.js` subpaths respectively.
`decodeAscii` accepts both genuine and emulated frozen `Uint8Array` values.

This initial release is intentionally `major`: it establishes the stable
public API for the package rather than publishing an intermediate pre-1.0
surface.

The package is pure JavaScript, with no `TextEncoder`, `TextDecoder`, `node:`
imports, or host globals, so it runs under XS exactly as under Node.js and
browsers. `encodeAscii` replaces ad hoc encoders that truncate rather than
reject non-ASCII code units. `decodeAscii` is the strict counterpart the
`TextDecoder` label `'ascii'` is not: the
[WHATWG Encoding Standard](https://encoding.spec.whatwg.org/#names-and-labels)
aliases that label to `windows-1252`, so `fatal: true` never fires on bytes
`0x80`–`0xff`.
