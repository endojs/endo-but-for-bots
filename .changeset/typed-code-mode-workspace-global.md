---
'@endo/agent-tools': minor
'@endo/platform': minor
---

Print the code-mode `workspace` declaration from the checked
`@endo/platform/fs/extended` TypeScript source rather than from its runtime
interface guards, and add workspace seam helpers that pair a backing with its
matching descriptor.

`@endo/platform/fs/extended/types.ts` now describes what the `wrapBackend`
exos actually implement. Two corrections are visible to callers:

- `Qid.path` never existed on any value the implementation produced; the field
  is `pathId`. Code reading `qid.path` was reading `undefined`.
- `Directory.makeDirectory`, `mkdir`, `materialise`, `File.open`,
  `OpenFile.fsync`, and `Xattrs.set` no longer declare the trailing options
  argument their implementations accept and discard. The guards accept it as
  an optional argument, so existing callers that pass one still work.

The composed namespace now marks each mount listing as a directory, and
nullable birth times are represented as `bigint | null` in `NodeAttrs`.
`OpenFile.lock` is non-blocking: conflicting requests fail immediately with
`EAGAIN`, so the public `LockOpts` surface no longer advertises a `wait` flag.

`NodeKind`, `NodeStat`, and `WatchEvent` now live in `types.ts` and are
re-exported from `backend-types.ts`, so both import paths keep working.
`LockOpts` moved to `types.ts`, where the `OpenFile.lock` surface it describes
lives; it is now reachable from `@endo/platform/fs/extended` rather than from
`@endo/platform/fs/extended/backend-types.js`.
