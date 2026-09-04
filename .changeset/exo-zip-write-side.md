---
'@endo/exo-zip': minor
---

`@endo/exo-zip` now hosts the write-side of the readable-tree <->
ZIP adapter pair: `zip(tree) -> Promise<Uint8Array>` walks a
`ReadableTree` exo (local or borne over CapTP) and serializes its
blobs into in-memory ZIP archive bytes.
The previous read-side implementation under this name has moved to
the new `@endo/exo-unzip` package and is exported as `unzip(bytes)`.
Entries are emitted with `STORE` compression, matching the
constraint of `@endo/zip`'s `ZipWriter`.
The walker drains each blob's `stream()` — which yields immutable
`Uint8Array` chunks directly — and concatenates them into the
blob's bytes, with no base64 decode step.
