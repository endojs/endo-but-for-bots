---
'@endo/agent-tools': major
'@endo/daemon': major
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
freeze/thaw boundary. `@endo/exo-http-client`'s `HttpResponse.stream()` is part
of this break: it now emits `Uint8Array` chunks instead of base64 frames.

Upgrade note: `iterateBytesReader`'s option `stringLengthLimit` was renamed to
`byteLengthLimit`, and its unit changed from base64 characters to raw bytes. A
caller that renames the key mechanically keeps a ~33%-too-large bound; a caller
that leaves the old key in place silently reverts to the default 100 KB frame
cap (there is no compile-time error), which rejects large chunks at runtime.
Update the key and recompute the limit in bytes.
