---
'@endo/platform': minor
'@endo/daemon': major
'@endo/git': patch
'@endo/exo-git': patch
'@endo/agent-tools': patch
---

Replace the content-addressed blob range-I/O surface with a composable
range-*attenuation* surface (`range` / `textRange`) that returns a further
readable blob rather than a special value
(designs/readableblob-range-attenuation.md).

Retired public surface (`@endo/platform`): the guard bundles
`rangeReadMethodGuards` and `rangeReadConvenienceMethodGuards`, the interfaces
`ReadableBlobRangeInterface` / `ReadableBlobRangeReadInterface`, and the TS
types `ReadableBlobRange` / `ReadableBlobRangeRead` are removed in favour of the
single `RichReadableBlobInterface` (tag `'RichReadableBlob'`) built from
`rangeAttenuationMethodGuards`, and a new public factory `makeBlobRangeMethods`
(exported from `@endo/platform/fs`) builds a producer's `range` / `textRange`
methods. Correspondingly the cap methods `fetch`,
`rangeRead`, and `rangeReadText` are removed from `LocalBlob`, `BlobRef`, the
daemon `EndoBlob` / `EndoMountFile`, and the `@endo/git` `GitBlob`;
`@endo/exo-git` re-aliases `ReadableBlob` to `RichReadableBlob`; and
`@endo/agent-tools` drops the generated `GitReadableBlobRange` declarations.
`streamBase64` is added to `BlobRefInterface` (the extended layer now streams
the whole value through `streamBase64` rather than the retired `fetch` /
`PassableBytesReader` pair).

Migration:

- `blob.fetch(offset, length)` -> `blob.range(start, end)`. **This is a
  semantics change, not just a rename:** `fetch` took a `length`; `range` takes
  a half-open upper bound `end` (`[start, end)`), and returns a readable blob,
  not a `PassableBytesReader`. Read `blob.range(start, end)` with the ordinary
  whole-value accessors (`text` / `json` / `streamBase64`). `end` is optional —
  omit it (`range(start)`) to read from `start` to end-of-content.
- `blob.rangeReadText(startLine, endLine)` -> `blob.textRange(startLine,
  endLine)` (same half-open line interval; now returns a readable blob).
- `blob.rangeRead(offset, length)` -> `blob.range(offset, offset + length)`
  followed by a whole-value read of the result.

`text()` / `json()` decode a selection's bytes as UTF-8 under one normative
byte-order-mark rule across every producer and every read path: a U+FEFF is
stripped only when it is the first code point of the whole content (a read whose
selection begins at absolute offset `0`); a U+FEFF at any interior offset,
including one that begins a derived window, is preserved as literal content. So
decoding is position-independent — a window's text is the exact slice of the
whole value's text — and `range(0n, size).text() === text()` holds on every
producer, including a window that begins on an interior U+FEFF.

Hardening of the same surface: windowed reads on the daemon and content-store
`readFileRange` powers now loop to EOF instead of clamping from `stat().size` or
stopping on the first short read, so a procfs/sysfs/FIFO source can no longer
mint a false empty content address (shared helper exported at
`@endo/platform/fs/node/read-file-window`). The content-addressed read cache
(`cacheBackedRead` / `withCachedReads`) now drains a remote blob under a fixed
per-frame bound (never derived from the sender-advertised size) and verifies the
streamed bytes against the advertised `{ size, hash }` before caching, rejecting
a forged content address rather than poisoning the store. Derived daemon
`EndoBlob` range caps are tagged `EndoBlob range`, dropping the parent-SHA-256
prefix that previously leaked 32 bits of the parent content address over CapTP.
Git- and XS-backed derived streams now reuse one native source stream for the
entire selection instead of spawning or materializing the whole object once per
48 KiB window. Window powers return copied bytes with fresh backing buffers, so
a range-attenuated consumer cannot retain an allocation containing bytes outside
its granted interval.
