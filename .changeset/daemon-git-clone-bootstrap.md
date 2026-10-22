---
'@endo/daemon': major
---

`EndoHost.provideGitClone` now takes `(destMount, petName, options)`, the same argument order as `provideGit` and `provideGitRemote`, and the one-object form is removed.
`petName` names the cloned `Git`.
A new `options.origin` record carries the `origin` remote's policy (`allowedDirections`, `fetchRefspecs`, `pushRefspecs`, `allowedBranches`, `defaultPullRef`, `allowForcePush`, `allowTags`, `allowDelete`) and an optional `petName` for the remote.
The remote's name, URL, credential and transport come from the endpoint and cannot be set on `origin`.
The `origin` remote now defaults to fetch-only, like `provideGitRemote`; the previous hardcoded fetch and push over `refs/heads/*` is gone, so a host that pushes must opt in, for example with `{ allowedDirections: ['fetch', 'push'], allowedBranches: ['refs/heads/agent/*'] }`.
An `origin` policy that `provideGitRemote` would reject is rejected before the clone starts.
Both names are stored only after the whole clone succeeds.
If any step fails after the destination is found empty, the destination is emptied before the error is rethrown, so the caller can retry into the same mount.

Migration: replace `provideGitClone({ destMount, endpoint, identity })` with `provideGitClone(destMount, petName, { endpoint, identity, origin })`, and pass the push policy the old default granted as `origin` if the caller pushes.
