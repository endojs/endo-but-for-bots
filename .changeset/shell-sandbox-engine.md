---
'@endo/exo-shell': minor
---

A `Shell` can now run its commands inside an `@endo/sandbox` slice.
`host.provideShell(mount, name, { ...policy, engine: 'sandbox', sandbox: factory })` mints a shell whose children see only the mount (at `/work`), read-only system directories, and no network.
Where the factory reports no usable backend, `provideShell` rejects rather than falling back to the host.
A sandboxed shell stays sandboxed across a daemon restart.
`@endo/exo-shell/engine-cases.js` publishes the engine conformance table.
