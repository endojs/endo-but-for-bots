---
'@endo/daemon': minor
---

- New `provideGitClone(destMount, petName, { endpoint, identity, origin })` returns `{ git, remote }`, storing the `Git` under `petName` and optionally the `GitRemote` under `origin.petName`. The `origin` remote is fetch-only unless the caller grants push. The destination mount must be empty and is assumed exclusive to the clone; a failed clone removes what it created and can be retried into the same mount.
- Cloning is unavailable on the XS manager and is refused before anything is cloned.
