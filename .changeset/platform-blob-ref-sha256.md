---
'@endo/platform': minor
---

`BlobRef` now content-addresses through `@endo/sha256` instead of importing
`node:crypto` directly. The recorded hash is unchanged byte for byte, but
`@endo/platform/fs/extended` no longer needs a `node:crypto` alias shim to
bundle for a browser or for XS.
