---
'@endo/platform': major
'@endo/exo-git': minor
'@endo/daemon': minor
'@endo/agent-tools': patch
---

The portable `@endo/platform/fs/lite` contracts now carry the rest of the
filesystem method catalog. `Directory` gains `subView(path)`, a confined view
rooted at `path`, and `makeFile(path, initial?)`, which accepts UTF-8 text or a
`ReadableBlob` and returns the new file's `File` capability. `SnapshotTree`
gains `subView(path)` and `followNameChanges()`, which returns a reader that
ends immediately because a snapshot never changes. These methods are required
by `DirectoryInterface` and `SnapshotTreeInterface`, so a third-party
`Directory` or `SnapshotTree` implementation must add them to keep type-checking
and to construct under the guards.

`@endo/exo-git` re-exports the `Directory` type, so its git worktree type
inherits the new methods.

`EndoMount.makeFile` in `@endo/daemon` now returns the created
`EndoMountFile` instead of `undefined` and also accepts a `ReadableBlob` as
initial content. It rejects a `ReadableTree` source before touching the
filesystem; use `write(path, tree)` to materialize a directory. The daemon's
content-addressed `EndoReadableTree` gains `subView` and `followNameChanges`.

The generated `@endo/agent-tools` code-mode declarations reflect these types.
