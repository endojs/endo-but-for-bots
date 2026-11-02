---
'@endo/daemon': minor
---

- Changed: `provideGitClone` now takes `(destMount, petName, { endpoint, identity, origin })` and returns `{ git, remote }`, storing the `Git` under `petName` and optionally the `GitRemote` under `origin.petName`. It replaces the one-argument `provideGitClone({ destMount, endpoint, identity })` form, which no release has shipped, so `minor` covers it. The `origin` remote is now fetch-only unless the caller grants push in `origin.allowedDirections`. The new `GitCloneOriginOptions` type describes `origin`.
- The destination mount must be empty and is assumed exclusive to the clone. A failed clone removes what it created and can be retried into the same mount.
- On the XS manager, whose supervisor supplies no host Git tools, `provideGitClone` throws before anything is cloned.
- The XS manager's directory removal no longer follows symbolic links.
