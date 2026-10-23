---
'@endo/daemon': major
'@endo/git': patch
'@endo/sandbox': patch
'@endo/floot': patch
---

`EndoHost.provideGitClone` now takes `(destMount, petName, options)`, the same argument order as `provideGit` and `provideGitRemote`, and the one-object form is removed.
`petName` names the cloned `Git`.
The endpoint supplies the URL, credential and transport, and the clone always names its remote `origin`.
A new `options.origin` record carries that remote's policy (`allowedDirections`, `fetchRefspecs`, `pushRefspecs`, `allowedBranches`, `defaultPullRef`, `allowForcePush`, `allowTags`, `allowDelete`) and an optional `petName`, a single pet name, under which to store the remote, which must differ from `petName`.
The `origin` remote now defaults to fetch-only, like `provideGitRemote`; the previous hardcoded fetch and push over `refs/heads/*` is gone, so a host that pushes must opt in, for example with `{ allowedDirections: ['fetch', 'push'], allowedBranches: ['refs/heads/agent/*'] }`.
An `origin` policy that `provideGitRemote` would reject is rejected before the clone starts.
Both names are stored only after the whole clone succeeds.
A clone that fails removes only what it created, so the caller can retry into the same mount, and anything another holder of the mount wrote meanwhile is kept, including an entry that replaced one the clone published.
Publishing a cloned entry never replaces an entry that appeared at its name.
A name that `origin.petName` replaced is restored if the clone then fails, unless the name was rebound meanwhile.

Migration: replace `provideGitClone({ destMount, endpoint, identity })` with `provideGitClone(destMount, petName, { endpoint, identity, origin })`, and pass the push policy the old default granted as `origin` if the caller pushes.

Aborted, timed-out and output-limited Git clone, fetch and push operations over HTTPS, with or without a credential, now terminate every Git process they started, escalating from `SIGTERM` to `SIGKILL` after a grace period, so they settle instead of hanging on a transport helper.

Cancelling or disposing a bwrap sandbox slice no longer leaves sandbox processes running when the cancellation arrives while the slice is still starting.

Floot's setup instructions use the new `provideGitClone` form.
