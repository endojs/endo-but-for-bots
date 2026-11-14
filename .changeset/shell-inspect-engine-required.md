---
'@endo/exo-shell': minor
'@endo/agent-tools': minor
---

**Breaking:** `Shell.inspect()` now reports a required `engine: 'host' | 'sandbox' | 'environment'`.
`'environment'` marks a shell that delegates execution to an environment runner; it is reported only, and `makeShell` refuses a policy that names it.
Every `Shell` or `ShellToolCapability` implementation, including mocks, must now return `engine` from `inspect()`.
