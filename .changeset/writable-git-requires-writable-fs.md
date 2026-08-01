---
'@endo/daemon': patch
'@endo/agentry': patch
---

`provideGit` now rejects a writable Git request (the default, or
`allowHistoryRewrite: true`) over a read-only backing mount, mirroring the
existing `provideShell` rejection; a caller that intends a read-only Git
capability opts in with `readOnly: true`. `@endo/agentry`'s code-mode
provisioning spec now rejects `fs: 'readOnly'` combined with a writable Git
mode (`readWrite` or `historyRewrite`), since writable Git necessarily writes
the same working tree at the OS level and a read-only filesystem grant cannot
bound that.
