---
'@endo/platform': minor
---

Add streaming tree clone to `@endo/platform`'s extended filesystem
(`designs/endo-app-sharing.md`, Pillar 3c). `cloneTree(source, dest)` ships a
whole source tree to a destination as **one ordered frame stream** —
`(path, kind, content)` in depth-first order — and recreates it under a
destination `Directory`, rather than a client-driven pipelined walk that pays a
round-trip per node. `streamTree(sourceRoot, { buffer })` exposes the producer
half (a single `PassableReader<CloneFrame>`) and `writeTreeStream(destRoot,
reader)` the consumer half; the frame stream carries no per-blob hash (integrity
is the transport's job) and large files stream as chunk frames so no whole file
is buffered. Exported from `@endo/platform/fs/extended`.
