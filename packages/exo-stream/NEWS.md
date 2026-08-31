User-visible changes in `@endo/exo-stream`:

- **Breaking:** Passable byte readers and writers now use the generic `stream()`
  method. The bytes-specific adapters continue to encode chunks as base64
  because CapTP currently hex-encodes passable byte arrays.
