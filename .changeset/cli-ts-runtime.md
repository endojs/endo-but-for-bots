---
'@endo/cli': major
'@endo/daemon': major
---

BREAKING: `@endo/cli` and `@endo/daemon` now require Node.js `^22.18.0 || >=23.6.0`, the versions that strip TypeScript types by default, and declare that range in `engines.node`.
`endo` exits with an error when Node.js cannot strip types.
