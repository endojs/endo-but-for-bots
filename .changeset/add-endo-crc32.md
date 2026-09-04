---
'@endo/crc32': major
'@endo/zip': patch
---

Adds `@endo/crc32`, a hardened, byte-oriented IEEE CRC-32 implementation. The
`crc32` function supports whole-buffer checksums, byte ranges read without
allocating a slice, and incremental checksums continued from a previous result.
It accepts a genuine or emulated single-byte view, rejects a multi-byte view
(`Uint16Array`, `Float64Array`, ...) or a lookalike, and throws rather than
returning a wrong checksum for out-of-contract input.

`@endo/zip` now depends on `@endo/crc32` at runtime: its readers and writers use
the shared CRC-32 implementation, with no change to archive checksum behavior
for genuine byte-view content.

The extraction also fixes a latent bug reachable through `@endo/zip`'s public
surface (`ZipWriter.write` and the reader), both typed to accept a `Uint8Array`:
the old private helper indexed any argument and returned a number, so a
multi-byte view or a `DataView` produced a wrong checksum that made the archive
fail its own CRC integrity check. The shared validating `crc32` now throws a
`TypeError` (a multi-byte view, or a lookalike declaring a `.length` but no
`.at`) or a `RangeError` (a `DataView`, or a lookalike with no usable `.length`)
instead. Genuine byte-view callers — the archive readers and writers — are
unaffected.
