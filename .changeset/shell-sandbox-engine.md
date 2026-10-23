---
'@endo/exo-shell': minor
'@endo/daemon': minor
'@endo/agent-tools': patch
---

A `Shell` can now run its commands inside an `@endo/sandbox` slice. `host.provideShell(mount, name, { ...policy, engine: 'sandbox', sandbox: factory })` mints a shell whose children see only the mount (at `/work`), read-only system directories, and no network. Where the factory reports no usable backend, `provideShell` rejects rather than falling back to the host. The engine is formula-owned, so a sandboxed shell stays sandboxed across restart, and `Shell.inspect()` now reports it as `engine: 'host' | 'sandbox'`. Without `engine`, a policy means `'host'`, so existing shells reconstitute unchanged.
