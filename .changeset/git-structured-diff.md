---
'@endo/exo-git': major
'@endo/git': major
'@endo/agent-tools': major
'@endo/agentry': patch
---

`Git.diff(options?)` now returns a structured `GitDiff` — `{ files }`, one
record per changed file with `status`, mount-relative `oldPath` / `newPath`,
numeric `oldMode` / `newMode`, and `hunks` of `{ kind, text }` lines — instead
of porcelain text. A binary file carries `binary` and no hunks; an unmerged
path has status `unmerged` and no hunks. A diff larger than the subprocess
buffer fails rather than truncating.

Migration: callers that want the old porcelain string should call the new
`Git.diffText(options?)`, which takes the same options. Custom `GitBackend`
implementations must now return `GitDiff` from `diff` and implement the new
required `diffText` method.

The `diff` agent tool and the code-mode `git` declarations report the
structured shape, which breaks consumers of the tool's text output; the
code-mode declarations also advertise `diffText`. The agentry
conflict-rebase eval compares patches through `diffText`.
