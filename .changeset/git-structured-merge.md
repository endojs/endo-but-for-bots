---
'@endo/agent-tools': minor
'@endo/exo-git': major
'@endo/git': major
---

Change `Git.merge()` to return a structured `GitMergeResult`, including
authority-bearing conflict entries and index-stage object ids, and add
`Git.mergeText()` for callers that need Git's porcelain output.
