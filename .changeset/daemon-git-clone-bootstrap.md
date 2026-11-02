---
'@endo/daemon': minor
---

- `provideGitClone` now takes `(destMount, petName, { endpoint, identity, origin })` and returns `{ git, remote }`, storing the `Git` under `petName` and optionally the `GitRemote` under `origin.petName`; the one-object form never shipped in a release. The `origin` remote is fetch-only unless the caller grants push. A failed clone can be retried into the same mount. Cloning is unavailable on XS and is refused before anything is cloned.
- Alternate `FilePowers` implementations must now provide `renameNoReplace`, `supportsRenameNoReplace`, `removeEmptyDirectory`, and `entryIdentity`.
