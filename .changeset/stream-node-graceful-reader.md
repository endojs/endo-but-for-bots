---
'@endo/stream-node': minor
---

Add `@endo/stream-node/graceful-reader.js`, exporting `makeGracefulReader` and
`defaultGracefulCodes`. `makeGracefulReader` wraps a `Reader` so an abrupt
underlying teardown — a destroyed Node.js socket rejecting a pending read with
`ERR_STREAM_PREMATURE_CLOSE` — surfaces as a clean end-of-stream
(`{ done: true }`) instead of a rejection the consumer must catch. The set of
error `code` values treated as an orderly end is configurable via the
`gracefulCodes` option, defaulting to `defaultGracefulCodes`. Extracted from
`@endo/ocapn-noise`'s TCP transport so other transports can reuse it.
