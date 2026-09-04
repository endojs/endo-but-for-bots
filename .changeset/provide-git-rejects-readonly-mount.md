---
'@endo/daemon': patch
---

`provideGit` now rejects a writable Git request (the default, or
`allowHistoryRewrite: true`) over a read-only backing mount, mirroring the
existing `provideShell` rejection; a caller that intends a read-only Git
capability opts in with `readOnly: true`.
