---
'@endo/stream': minor
---

Add `@endo/stream/auto-buffer`, a one-way _auto buffer_ whose storage grows
automatically to retain every produced value until the sink consumes it, with
no backpressure. Its `makeAutoBuffer()` factory provides a fire-and-forget
producer spring and an async iterator sink, including normal and error terminal
operations. The complementary bounded _ring buffer_ is intentionally left for a
separate, synchronous module.
