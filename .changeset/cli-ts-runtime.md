---
'@endo/cli': major
'@endo/daemon': major
---

BREAKING: `@endo/cli` and `@endo/daemon` now require Node.js 22 or later, the minimum that `amaro` supports, and declare `engines.node >=22`.
`endo` exits with an error on older versions of Node.js.
Both packages are private, so this bump records the dropped Node.js versions in the changelog and publishes nothing.

`.ts` source modules now load at runtime through the `amaro` type-stripping hook (`amaro/strip`).
The `endo` command registers the hook, and the daemon adds it to the daemon and worker processes it forks.
`amaro` is a new runtime dependency of both packages.
