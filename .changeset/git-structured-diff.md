---
'@endo/exo-git': major
'@endo/git': major
'@endo/agent-tools': major
'@endo/agentry': patch
---

`Git.diff(options?)` now returns a structured `GitDiff` (`{ files }`, one record per changed file) instead of porcelain text.
Each file record names its `oldPath` / `newPath` as mount-relative strings, matching `status()`, rather than `EndoMountEntry` values.
A diff larger than the 1 MiB subprocess buffer fails rather than truncating.

Migration: callers that want the old porcelain string should call the new `Git.diffText(options?)`, which takes the same options.
Custom `GitBackend` implementations must now return `GitDiff` from `diff` and implement the new required `diffText` method.

The `diff` agent tool and the code-mode `git` declarations report the structured shape, which breaks consumers of the tool's text output; the code-mode declarations also advertise `diffText`.
The agentry conflict-rebase eval compares patches through `diffText`.
