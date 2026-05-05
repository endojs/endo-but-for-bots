---
'@endo/syrups': patch
---

- New package `@endo/syrups`: a sibling of `@endo/netstring` that
  drops the trailing `,` separator, so each framed payload on the wire
  is literally a Syrup byte-string record (`<length>:<payload>`).
- Provides `makeSyrupsReader` and `makeSyrupsWriter` with the
  same shape as the netstring equivalents, including the `chunked`
  zero-copy writer mode.
- Not yet wired into any OCapN netlayer.
  Intended for use by a future `tcp+syrups` netlayer under a distinct
  network identifier.
