---
'@endo/platform': minor
'@endo/exo-git': minor
'@endo/git': patch
---

Add lossless and latest-root followers to `Git`. Each follower starts with the
current commit snapshot, carries an immutable filesystem and complete-tree
identity, observes in-band Git mutations immediately, and reconciles external
HEAD advancement through the native backend's polling watcher seam.

The lossless follower expands externally observed fast-forward ranges into
ordered commit transitions. The latest follower coalesces undrained updates and
exposes skipped commits through its revision jump. Read-only Git facets retain
both observation methods without gaining mutation authority.
