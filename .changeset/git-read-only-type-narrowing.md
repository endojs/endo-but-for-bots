---
'@endo/daemon': minor
'@endo/exo-git': patch
---

`EndoHost.provideGit(mount, name, { readOnly: true })` now returns the
read-only Git facet even over a writable mount, and is typed as
`ReadOnlyEndoGit`. The `git` formula records `readOnly: true`, so the
capability stays read-only after reincarnation and ignores
`allowHistoryRewrite`. Previously the option only skipped the
read-only-mount check, and a writable mount still produced a writable Git.
A `GitProvisionOptions` value chosen at runtime now types as the full
`EndoGit` union. The `readOnly()` help text names the methods the read-only
facet omits.
