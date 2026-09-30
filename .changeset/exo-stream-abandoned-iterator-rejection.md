---
'@endo/exo-stream': patch
---

`iterateReader`, `iterateBytesReader`, `iterateWriter`, and
`iterateBytesWriter` no longer leak an unhandled rejection when the stream
fails (for example, the peer disconnects) before the iterator's first pull.
A consumer that does pull still observes the rejection.
