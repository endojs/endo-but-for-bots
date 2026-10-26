---
'@endo/exo-git': major
'@endo/git': major
'@endo/agent-tools': minor
---

`Git.diff(options?)` now returns a structured `GitDiff` — `{ files }`, one
record per changed file with `status`, mount-relative `oldPath` / `newPath`,
numeric `oldMode` / `newMode`, and `hunks` of `{ kind, text }` lines — instead
of porcelain text. The porcelain rendering moves to the new
`Git.diffText(options?)` sibling, which takes the same options. A binary file
carries `binary` and no hunks; an unmerged path has status `unmerged` and no
hunks, since its three-way hunks do not fit the two-sided shape.

The native backend derives the structure from two renderings of one
comparison (`--raw -z` for exact paths, modes, and statuses; the patch for
hunks) and pins rename detection, uncolored output, and short submodule
rendering so repository diff configuration cannot desynchronize them. A diff
larger than the subprocess buffer fails rather than truncating.

The `diff` agent tool and the code-mode `git` declarations report the
structured shape; the code-mode declarations also advertise `diffText`.
