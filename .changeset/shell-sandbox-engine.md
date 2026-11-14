---
'@endo/exo-shell': minor
'@endo/daemon': minor
'@endo/host-spawner': minor
'@endo/sandbox': minor
---

A `Shell` can now run its commands inside an `@endo/sandbox` slice.
`host.provideShell(mount, name, { ...policy, engine: 'sandbox', sandbox: factory })` mints a shell whose children see only the mount (at `/work`), read-only system directories, and no network.
Where the factory reports no usable backend, `provideShell` rejects rather than falling back to the host.
A sandboxed shell stays sandboxed across a daemon restart.
`@endo/exo-shell/engine-cases.js` publishes the engine conformance table.
`@endo/host-spawner` adds `makeSandboxSpawner` at `@endo/host-spawner/src/sandbox-spawner.js`; `@endo/sandbox/spawner.js` re-exports it and is deprecated.
`@endo/host-spawner` renames `SpawnerOpts` to `SpawnerOptions`, keeping `SpawnerOpts` as a deprecated alias.
**Behavior change:** a sandbox spawner's `wait()` and `kill()` now reject on a kill the caller did not request and on any containment failure, where they previously reported a signal exit.
