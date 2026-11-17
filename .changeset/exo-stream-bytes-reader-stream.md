---
'@endo/exo-stream': minor
'@endo/platform': patch
---

Bytes readers made with `bytesReaderFromIterator` now also offer `stream()`,
which yields each chunk as a passable byte array. Initiators can read them with
`iterateReader` instead of `iterateBytesReader`. `streamBase64()` stays for
compatibility and is slated for deprecation. Under the immutable-ArrayBuffer
shim, copy each chunk with `thawedBytes` before passing it to `Uint8Array#set`
or `TextDecoder#decode`.

The `withCachedReads` background cache populate in `@endo/platform` now reads
through `stream()`.
