---
'@endo/exo-shell': minor
'@endo/agent-tools': minor
---

**Breaking:** `Shell.inspect()` now reports a required `engine: 'host' | 'sandbox' | 'environment'`.
`'environment'` marks a shell that delegates execution to an environment runner; it is reported only, and `makeShell` refuses a policy that names it.
The `inspect()` return guard requires `engine`, so every `Shell` exo implementation, mock, and `ShellToolCapability` implementation must now return it.
This is a `minor` bump because both packages are pre-1.0, where a minor is the breaking level, and `@endo/exo-shell` (0.0.0) has not yet had a release.
