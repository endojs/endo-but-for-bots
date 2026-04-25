# @endo/hex News

## 0.1.0

Initial release of `@endo/hex` — a hex encode/decode ponyfill that
dispatches to the TC39 `Uint8Array.prototype.toHex` and
`Uint8Array.fromHex` intrinsics when available, and falls through to a
portable pure-JavaScript implementation otherwise.

`encodeHex(bytes)` and `decodeHex(string)` are the module's public
surface.
`decodeHex` throws on odd-length input and on any character outside
`[0-9a-fA-F]`, matching the TC39 specification.
