---
'@endo/exo-shell': minor
'@endo/daemon': minor
'@endo/agent-tools': minor
'@endo/host-spawner': minor
'@endo/sandbox': minor
---

A `Shell` can now run its commands inside an `@endo/sandbox` slice.
`host.provideShell(mount, name, { ...policy, engine: 'sandbox', sandbox: factory })` mints a shell whose children see only the mount (at `/work`), read-only system directories, and no network.
Where the factory reports no usable backend, `provideShell` rejects rather than falling back to the host.
The engine is formula-owned, so a sandboxed shell stays sandboxed across restart, and a persisted formula naming an unknown engine refuses to reincarnate.
Without `engine`, a policy means `'host'`, so existing shells reconstitute unchanged.
`Shell.inspect()` now reports `engine: 'host' | 'sandbox' | 'environment'`, where `'environment'` marks a shell that delegates execution to an environment runner.
A `ShellToolCapability` implementation must now return `engine` from `inspect()`.
`@endo/host-spawner` now owns the one slice-to-`Spawner` adapter, `makeSandboxSpawner`, which `@endo/sandbox/spawner.js` re-exports; a kill it did not request, and any containment failure, now rejects `wait()` and `kill()` instead of being reported as a signal exit.
`@endo/exo-shell/engine-cases.js` publishes the engine conformance table.
The bwrap driver no longer signals a process group whose leader it has reaped unless it can prove the group is still the slice's.
