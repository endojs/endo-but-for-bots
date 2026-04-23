---
'@endo/syrup-frame': patch
---

- New package `@endo/syrup-frame`: a sibling of `@endo/netstring` that
  drops the trailing `,` separator, so each framed payload on the wire
  is literally a Syrup byte-string record (`<length>:<payload>`).
- Provides `makeSyrupFrameReader` and `makeSyrupFrameWriter` with the
  same shape as the netstring equivalents, including the `chunked`
  zero-copy writer mode.
- Not yet wired into any OCapN netlayer — intended for use by a future
  `tcp+syrup-frame` netlayer under a distinct network identifier.
