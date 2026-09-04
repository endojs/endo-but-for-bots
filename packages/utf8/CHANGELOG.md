# Change Log

## 1.0.0

### Major Changes

Initial release.
Portable UTF-8 transcoding via the web `TextEncoder` and `TextDecoder`
APIs, captured once at module load for SES hardening.
Exports `encodeUtf8`, `decodeUtf8`, and `strictDecodeUtf8` as focused
sub-path modules mirroring the shape of `@endo/hex` and `@endo/base64`.
