---
'@endo/goblin-chat': patch
---

Encode swissnum strings through `@endo/ascii`'s `encodeAscii` rather than an
ad-hoc `charCodeAt` copy. A swissnum is ASCII by construction, so a stray
non-ASCII code unit is now a hard `RangeError` at the point of encoding instead
of being silently masked down to a stray byte and mangled on the wire. Both the
host-side URI formatter (`swissStringToBytes`) and the Guile-interop client's
`?swiss=…` hint path share this one canonical, 7-bit-asserted encoder; the
raw base64url swissnum path is unchanged.
