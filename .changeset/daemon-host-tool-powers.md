---
'@endo/daemon': minor
---

The git backend and the host spawner now reach the daemon core as
`DaemonicPowers.hostTools` rather than as static imports of `@endo/git` and
`@endo/host-spawner`, the way `better-sqlite3` already reached it as an
injected `Database`. Every Node supervisor supplies them, so their behavior is
unchanged. A supervisor that omits the group (the XS one, which has no host
process to spawn into) now gets `git` and `shell` formulas that refuse with a
diagnosis, where previously the daemon core could not be bundled for it at all.

This is what lets `bundle-bus-daemon-rust-xs.mjs` generate `daemon_bootstrap.js`
again.
