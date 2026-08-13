# @endo/ascii

`@endo/ascii` transcodes between ASCII text and bytes, one byte per code unit,
and asserts in both directions that every value is in the admitted 7-bit range
`0x00`–`0x7f`.

```js
import { encodeAscii, decodeAscii } from '@endo/ascii';

const bytes = encodeAscii('abc'); // Uint8Array [ 0x61, 0x62, 0x63 ]
encodeAscii('café'); // throws RangeError: the é is 0xe9

decodeAscii(Uint8Array.of(0x61, 0x62, 0x63)); // 'abc'
decodeAscii(Uint8Array.of(0x80)); // throws RangeError: 0x80 is past 0x7f
```

`decodeAscii` is the strict inverse of `encodeAscii`, and the counterpart the
`TextDecoder` label `'ascii'` is not: per the WHATWG Encoding Standard that
label is an alias for `windows-1252`, so `new TextDecoder('ascii', { fatal:
true })` silently maps bytes `0x80`–`0xff` to Latin-1/windows-1252 characters
rather than throwing.

It is pure JavaScript — no `TextEncoder`, no `TextDecoder`, no `node:` imports,
and no host globals — so it imports and runs under XS (`xst`) exactly as it does
under Node.js and browsers. That makes it the XS-floor replacement for the ad-hoc
`Uint8Array.from(text, ch => ch.charCodeAt(0))` helper that XS bundles reach for
because XS lacks `TextEncoder`: unlike that helper, `encodeAscii` **rejects** a
non-ASCII code unit rather than silently truncating it to its low byte.

## Scope

This is the narrow primitive for protocol text that is ASCII by construction,
where a stray non-ASCII value is a bug to surface rather than to mangle. It is
deliberately not a general Unicode transcoder: callers that need to encode or
decode arbitrary text as UTF-8 want a different tool. The optional second
argument names the string or bytes in the thrown diagnostic.

The package entry exports both functions. The `./encode.js` and `./decode.js`
subpaths expose the individual directions.
