---
'@endo/agent-tools': major
'@endo/daemon': major
'@endo/exo-git': major
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
provide the former bytes-only method. Producers and consumers must call
`stream()` or use the `@endo/exo-stream` bytes adapters, which now carry
passable immutable byte arrays directly and own the freeze/thaw boundary.
