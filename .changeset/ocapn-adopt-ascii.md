---
'@endo/ocapn': major
---

Swissnums represented as strings must now be 7-bit ASCII. Pass a `Uint8Array`
or immutable bytes instead when a secret contains arbitrary bytes; raw-byte
swissnums still ride the wire verbatim.

This is a `major` release because it rejects previously accepted string inputs
and changes the error contract of a public client helper.

- The hub API (`publish`/`publishHeld`/`unpublish`) previously accepted any
  string swissnum and silently UTF-8-encoded it; a non-ASCII string swissnum now
  throws a `RangeError`. To revoke a publication persisted under the old
  behavior, pass the UTF-8 bytes of its former string swissnum to `unpublish`.
- `decodeSwissnum` now rejects wire bytes `0x80`–`0xff` instead of silently
  decoding them as `windows-1252` characters.
- Sturdyref readers preserve a non-ASCII secret as raw bytes instead of
  mis-decoding it as `windows-1252` text, so arbitrary-byte secrets can reach
  byte-keyed locators unchanged.
- The client-side `encodeSwissnum` already rejected non-ASCII input; its thrown
  error changes type and message (generic `Error` -> `RangeError`), and a
  non-string argument now throws `TypeError` instead of being coerced.
- `publish`, `publishHeld`, and `unpublish` now declare their existing support
  for immutable `ArrayBufferLike` swissnums in addition to `Uint8Array`.

Handoff session keys continue to accept the full Unicode permitted in peer
locations; the new swissnum validation does not apply to those location keys.
