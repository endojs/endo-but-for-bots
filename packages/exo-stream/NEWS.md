User-visible changes in `@endo/exo-stream`:

- **Breaking:** Passable byte readers and writers now use the generic `stream()`
  method and carry immutable byte arrays directly. The bytes-specific adapters
  freeze mutable chunks on send and thaw received chunks for local use. Carrying
  bytes directly costs more on the wire than the retired base64 transitional
  representation — the current hex marshal encoding is ≈1.5× larger and measured
  ≈4.5× slower on Node 22 — pending a compact byteArray marshal path; see
  `DESIGN.md` § Bytes Transport Decision.
