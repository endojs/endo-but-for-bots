---
'@endo/exo-stream': patch
---

`iterateReader`, `iterateBytesReader`, `iterateWriter`, and
`iterateBytesWriter` no longer leak an unhandled rejection when the stream
fails (for example, the peer disconnects) after the consumer stops pulling,
whether before the iterator's first pull or after any number of pulls.
A consumer that does pull still observes the rejection.
