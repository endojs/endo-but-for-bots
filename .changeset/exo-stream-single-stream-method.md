---
'@endo/9p-server': major
'@endo/agent-tools': major
'@endo/daemon': major
'@endo/endo-fs-asset-server': major
'@endo/endo-fs-exec': major
'@endo/exo-git': major
'@endo/exo-http-client': major
'@endo/exo-stream': major
'@endo/exo-unzip': major
'@endo/exo-zip': major
'@endo/git': major
'@endo/platform': major
'@endo/space-file-explorer': major
'@endo/spaces-util': major
---

Use `stream()` as the sole Exo stream protocol method, including for byte
readers and writers.

This is a breaking wire and API change. Byte-stream capabilities no longer
provide the former bytes-only `streamBase64()` method. Producers and consumers
must call `stream()` or use the `@endo/exo-stream` bytes adapters, which now
carry passable immutable byte arrays directly (not base64 strings) and own the
freeze/thaw boundary. `@endo/exo-http-client`'s `HttpResponse` is part of this
break: its body reader is renamed from `stream()` to `body()` and now emits
`Uint8Array` chunks instead of base64 frames. The rename keeps the generic
`stream()` protocol method name for byte readers/writers unambiguous — an
`HttpResponse` is a whole-value response whose `body()` returns a
`PassableBytesReader`, not itself a stream node — so the readable-blob
discriminator no longer needs an `HttpResponse`-specific exclusion clause.

`@endo/9p-server`, `@endo/endo-fs-asset-server`, and `@endo/endo-fs-exec` bump
`major`: each exports an entry point whose accepted-collaborator contract broke
incompatibly (`serveConnection({ filesystem })`, `makeTreeRequestHandler({ tree
})`, and `drainBytesReader`'s reader ref all now drive `stream()` on the
caller-supplied readers), so a downstream caller passing its own
`streamBase64`-era capability breaks on upgrade. `@endo/space-file-explorer` is
already `major` for the structurally identical call-site adaptation.

Upgrade note (readers): `iterateBytesReader`'s option `stringLengthLimit` was
renamed to `byteLengthLimit`, and its unit changed from base64 characters to raw
bytes. A caller that renames the key mechanically keeps a ~33%-too-large bound; a
caller that leaves the old key in place silently reverts to the default 100 KB
frame cap (there is no compile-time error), which rejects large chunks at
runtime. Update the key and recompute the limit in bytes.

Upgrade note (writers): `bytesWriterFromIterator` gains the same
`byteLengthLimit` option, but its default is deliberately asymmetric — omitted,
the write frame size is unbounded (`Number.MAX_SAFE_INTEGER`), whereas the reader
falls back to the 100 KB cap. The writer now also validates every received frame
against `M.byteArray()`: a responder that previously accepted whatever a peer
pushed will reject a non-bytes (e.g. stale base64 string) frame at runtime.

Upgrade note (accepted-source contract): `Directory.write()` / `copyInto` /
`stageTree` and the mount-child probe no longer accept "any source advertising a
byte-stream method". A blob source must now pass the newly required export
`looksLikeReadableBlob` (`@endo/platform/fs/lite`): it must carry `stream`
**paired** with one of `text` (a whole-value read), `getInfo` (a
content-addressed blob), or `readReturnPattern` (a raw `PassableBytesReader`). A
custom blob source that renames its only method to `stream()` and nothing else is
now rejected at runtime with `Expected a ReadableBlob source`.

Performance note: carrying immutable byte arrays directly (rather than base64
strings) makes the wire payload ~1.5x larger and several times slower on Node 22
than the retired base64 framing, pending a compact `byteArray` marshal path. See
`@endo/exo-stream`'s `NEWS.md` and `DESIGN.md` for the measured figures.
