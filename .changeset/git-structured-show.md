---
'@endo/exo-git': major
'@endo/git': major
'@endo/agent-tools': minor
---

`Git.show(ref)` now returns a structured `GitShow` — `{ commit, parents,
diff }`, with the `GitCommit` record, the parent object ids in order, and the
`GitDiff` of the commit's changes against its first parent (the empty tree
for a root commit) — instead of porcelain text. The ref is peeled to a
commit, so an annotated tag shows its commit and a tree or blob is rejected.
The porcelain rendering moves to the new `Git.showText(ref)` sibling, which
still renders any object, including a blob such as `HEAD:README.md`.

The native backend computes the structured diff with the same pinned,
hardened two-rendering path as `Git.diff`, and finds the empty tree through
git so SHA-256 repositories work.

The `show` agent tool and the code-mode `git` declarations report the
structured shape; the code-mode declarations also advertise `showText`.
