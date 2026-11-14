---
'@endo/exo-shell': minor
'@endo/daemon': minor
'@endo/host-spawner': minor
'@endo/sandbox': minor
---

A `Shell` can now run its commands inside an `@endo/sandbox` slice.
`host.provideShell(mount, name, { ...policy, engine: 'sandbox', sandbox: factory })` mints a shell whose children see only the mount (at `/work`), read-only system directories, and no network.
Where the factory reports no usable backend, `provideShell` rejects rather than falling back to the host.
The engine is formula-owned, so a sandboxed shell stays sandboxed across restart, and a persisted formula naming an unknown engine refuses to reincarnate.
Without `engine`, a policy means `'host'`, so existing shells reconstitute unchanged.
`@endo/host-spawner` adds `makeSandboxSpawner`, whose only entry point is `@endo/host-spawner/src/sandbox-spawner.js`; `@endo/sandbox/spawner.js` re-exports it and is deprecated.
**Behavior change:** a sandbox spawner's `wait()` and `kill()` now reject on a kill the caller did not request and on any containment failure, where they previously reported a signal exit.
`@endo/host-spawner` renames its `SpawnerOpts` type to `SpawnerOptions` (adding `timeoutMs` and `maxOutputBytes`), keeping `SpawnerOpts` as a deprecated alias.
`@endo/exo-shell` declares `Spawner`, `ProcessLike`, and `SpawnerOptions` structurally, so it has no dependency on the private `@endo/host-spawner`.
`@endo/exo-shell/engine-cases.js` publishes the engine conformance table.
The bwrap driver no longer signals a process group whose leader it has reaped unless it can prove the group is still the slice's.
