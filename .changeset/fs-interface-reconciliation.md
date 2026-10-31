---
'@endo/platform': major
'@endo/exo-git': major
'@endo/daemon': minor
'@endo/agent-tools': minor
---

`SnapshotTree` from `@endo/platform/fs/lite` now requires `followNameChanges()`, which returns a reader that ends immediately because a snapshot never changes.
A third-party `SnapshotTree` implementation must add this method to satisfy `SnapshotTreeInterface` and the `SnapshotTree` type.
The same requirement applies to the snapshot a `@endo/exo-git` worktree's `snapshot()` returns.

`EndoMount.makeFile(path, content?)` in `@endo/daemon` now resolves to the created `EndoMountFile` instead of `undefined`.
It also accepts a `ReadableBlob` as initial content, and it rejects a `ReadableTree` before touching the filesystem; use `write(path, tree)` to materialize a directory.
The daemon's content-addressed `EndoReadableTree` gains `followNameChanges()` with the same immediately-ending behavior.

The `@endo/agent-tools` code-mode declarations expose these signatures to code-mode programs.
