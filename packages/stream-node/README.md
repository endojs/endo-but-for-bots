# Endo / Node Stream Adapters

This package provides `makeNodeReader` and `makeNodeWriter` adapters that adapt Node.js Reader and Writer to Endo's async iterable streams.

It also provides `makeGracefulReader`, which wraps a reader so that an abrupt underlying teardown (a destroyed socket rejecting a pending read with `ERR_STREAM_PREMATURE_CLOSE`) surfaces as a clean end-of-stream (`{ done: true }`) rather than a rejection. The set of error `code` values treated as an orderly end is configurable via the `gracefulCodes` option (defaulting to `defaultGracefulCodes`).
