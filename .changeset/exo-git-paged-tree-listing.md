---
'@endo/exo-git': minor
'@endo/git': minor
---

`Git.filesystemAt(ref)` now pages its directory listings. The `GitBackend` contract gains an optional `streamLsTree(treeOid)` that yields one parsed tree entry at a time, and `Directory.list()` reads through it, so `Cursor.read(limit)` on a tree with hundreds of thousands of entries holds one page instead of the whole listing. A listing that path resolution already cached is replayed rather than listed again, and a backend without `streamLsTree` keeps the previous whole-array behavior.

`@endo/git`'s native backend implements `streamLsTree`, and its tree parser now accepts the 64-hex object IDs of a SHA-256-format repository (`git init --object-format=sha256`), so `filesystemAt` reads such a repository and reports the full 256-bit object ID as the QID `pathId`.
