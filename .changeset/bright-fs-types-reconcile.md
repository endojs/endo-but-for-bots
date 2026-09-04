---
'@endo/platform': major
---

The extended filesystem types now match and enforce the runtime capability
interfaces more precisely.

- Rename `Qid.path` to `Qid.pathId`, which matches the field populated by the
  implementation.
- Update `DirectoryEntry` producers so `kind` and `qid.type` are correlated,
  and update `FsBackend.qidFor` implementations to return a `Qid` for the
  requested kind.
- Narrow `Directory.lookup` and `lookupStep` from `any` to `Directory | File`.
  Callers that need the node kind must narrow the result or use
  `ResolvedNode` for a lookup paired with `getQid`.
- File guards now declare every method and reject undeclared methods during
  construction.

The trailing options arguments that the implementations ignore are now
optional, so callers may omit them while existing calls that provide them
continue to work.
