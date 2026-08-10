---
'@endo/platform': minor
---

`glob`'s `**` no longer recurses through symbolic links to directories.

Recursion of unbounded depth crossing links makes the walk cover the link graph rather than the tree. In a workspace checkout, where every `node_modules/@endo/*` entry links back into the repository, that graph enumerates the transitive dependency closure of every package by every distinct route to it. Measured on the Endo repo, `packages/chat/**/*.js` reaches 22 directories as a tree and over nine million paths as a graph — and because glob must collect the whole result set before it can sort and yield the first batch, `GLOB_MAX_RESULTS` could not rescue it. The call did not return.

A link is still reported as an entry when the pattern ends there, so nothing disappears from a listing; only the descent through it stops. A segment that names a path (`node_modules/@endo/*/src/**`) still follows a link, being bounded by the pattern's own depth. The new `followSymlinks` option restores the sweep. This is ripgrep's rule, and `followSymlinks` is its `-L`.
