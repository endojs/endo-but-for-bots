User-visible changes in `@endo/exo-stream`:

- **Breaking:** Passable byte readers and writers now use the generic `stream()`
  method and carry immutable byte arrays directly. The bytes-specific adapters
  freeze mutable chunks on send and thaw received chunks for local use.
