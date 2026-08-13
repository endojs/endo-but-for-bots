---
'@endo/ocapn': minor
---

Enforce 7-bit ASCII on both directions of the swissnum string codec, routing
`encodeSwissnum` and the hub's `swissnumHex` through `@endo/ascii`'s
`encodeAscii`, and `decodeSwissnum` through the new `decodeAscii`.

This tightens validation on public surface, so it is a behavior change rather
than a pure refactor:

- The hub API (`publish`/`publishHeld`/`unpublish`) previously accepted any
  string swissnum and silently UTF-8-encoded it; a non-ASCII string swissnum now
  throws a `RangeError`.
- `decodeSwissnum` previously leaned on `TextDecoder('ascii', { fatal: true })`,
  which per the WHATWG Encoding Standard aliases `'ascii'` to `windows-1252` and
  so silently mis-decoded wire bytes `0x80`–`0xff` instead of rejecting them; it
  now rejects them.
- The client-side `encodeSwissnum` already rejected non-ASCII input; its thrown
  error changes type and message (generic `Error` → `RangeError`).

Raw-bytes swissnums still ride the wire verbatim, preserving the byte identity
of ASCII swissnums.
