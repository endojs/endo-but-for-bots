---
'@endo/agent-tools': minor
'@endo/exo-git': major
'@endo/git': major
---

Change `Git.rebase()` to return a structured `GitRebaseResult` reporting a
completed rebase with its replayed commits, a conflicted stop with the
stopped commit and authority-bearing conflict entries, an abort, or a
conflict-free stop, and add `Git.rebaseText()` on the rewriter facet for
callers that need Git's porcelain output. `GitRemote.pull` with the
`rebase` strategy now rejects when the rebase stops.
