---
'@endo/ascii': minor
---

Add `decodeAscii`, the strict inverse of `encodeAscii`: it decodes bytes to
text one code unit per byte and hard-fails on the first byte outside the
admitted 7-bit range `0x00`–`0x7f`. Like `encodeAscii` it is pure JavaScript —
no `TextDecoder`, no `node:` imports, no host globals — so it runs under XS
exactly as under Node.js and browsers, and it is the strict counterpart the
`TextDecoder` label `'ascii'` is not (that label aliases to `windows-1252` per
the WHATWG Encoding Standard, so `fatal: true` never fires on bytes
`0x80`–`0xff`). Available from the package entry and the new `./decode.js`
subpath.
