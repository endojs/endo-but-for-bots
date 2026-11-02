---
'@endo/daemon': minor
---

- New: `provideGitClone(destMount, petName, { endpoint, identity, origin })` clones a repository into an empty mount, stores the `Git` under `petName`, and returns `{ git, remote }`. A failed clone can be retried into the same mount. It is not available on the XS manager.
- Behavior change: the clone's `origin` remote is fetch-only unless the caller grants push in `origin.allowedDirections`.
