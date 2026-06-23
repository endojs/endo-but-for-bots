# Change Log

## 1.0.0

### Major Changes

Initial release.
Portable ASCII transcoding without relying on `TextEncoder` or
`TextDecoder` (which do not support the `"ascii"` encoding label).
Exports `encodeAscii`, `decodeAscii`, and `strictDecodeAscii` as
focused sub-path modules mirroring the shape of `@endo/utf8`.
