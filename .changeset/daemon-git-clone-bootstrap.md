---
'@endo/daemon': major
---

Migration: replace `provideGitClone({ destMount, endpoint, identity })` with `provideGitClone(destMount, petName, { endpoint, identity, origin })`; the result is now `{ git, remote }`.

`petName` names the cloned `Git`, and `origin.petName` optionally names its `GitRemote`.
The endpoint supplies the URL, credential, and transport, while the remote is named `origin`.
The `origin` remote defaults to fetch-only; callers that push must opt in, for example with `{ allowedDirections: ['fetch', 'push'], allowedBranches: ['refs/heads/agent/*'] }`.
A failed clone can be retried into the same mount.
