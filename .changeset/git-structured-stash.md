---
'@endo/agent-tools': minor
'@endo/exo-git': major
'@endo/git': major
---

Change `Git.stashList()` to return structured stash records and
`Git.stashShow(index?)` to return a structured `GitDiff`. Add
`Git.stashListText()` and `Git.stashShowText(index?)` for callers that need
Git's porcelain list lines or patch output.
