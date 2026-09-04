# @endo/ascii

`@endo/ascii` encodes ASCII text to bytes, one byte per code unit, and asserts
that every code unit is in the admitted 7-bit range `0x00`–`0x7f`.

```js
import { encodeAscii } from '@endo/ascii';

const bytes = encodeAscii('abc'); // Uint8Array [ 0x61, 0x62, 0x63 ]
encodeAscii('café'); // throws RangeError: the é is 0xe9
```

It is pure JavaScript — no `TextEncoder`, no `node:` imports, no host globals —
so it imports and runs under XS (`xst`) exactly as it does under Node.js and
browsers. That makes it the XS-floor replacement for the ad-hoc
`Uint8Array.from(text, ch => ch.charCodeAt(0))` helper that XS bundles reach for
because XS lacks `TextEncoder`: unlike that helper, `encodeAscii` **rejects** a
non-ASCII code unit rather than silently truncating it to its low byte.

## Scope

This is the narrow primitive for protocol text that is ASCII by construction,
where a stray non-ASCII code unit is a bug to surface rather than to mangle. It
does not decode, and it is deliberately not a general Unicode transcoder:
callers that need to encode arbitrary text as UTF-8 want a different tool. The
optional second argument names the string in the thrown diagnostic.
