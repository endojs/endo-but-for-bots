---
'@endo/exo-unzip': minor
---

Add `@endo/exo-unzip` (`unzip(bytes) -> ReadableTree`).
This is the read-side of the in-memory ZIP adapter previously
named `@endo/exo-zip` and exported as `makeExoZip`; the new
package keeps the implementation and renames the entry point to
the plain English verb per the maintainer's directive on PR #160.
The companion write-side `zip(tree) -> bytes` lives in
`@endo/exo-zip`.
Path-segment validation now sources from the new shared
`@endo/zip/path.js` rather than a per-package copy.
A blob's `stream()` yields immutable `Uint8Array` chunks
directly (the byte-stream method carries bytes, not base64
strings), so a consumer simply concatenates the chunks to
recover the blob's bytes — no `decodeBase64` step and no
interior-padding constraint.
