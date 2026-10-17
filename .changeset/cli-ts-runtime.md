---
'@endo/cli': minor
'@endo/daemon': minor
---

Load `.ts` source modules at runtime through the `amaro` type-stripping hook
(`amaro/strip`), which the `endo` command and the daemon and worker processes
it forks register at startup. `amaro` is a new runtime dependency of both
packages, and both now declare `engines.node >=22`, the minimum `amaro`
supports; `endo` exits with an error on older versions of Node.js.
