---
'@endo/familiar': minor
---

Consolidate the daemon `stop` and `purge` menu actions onto a single CapTP-driven `daemon-control.cjs` bundle.
The Electron main process previously spawned `endo-cli.cjs` once per lifecycle verb (`runEndoCommand(['stop'])`, `runEndoCommand(['purge'])`), pulling roughly 20% of the daemon's transitive deps a second time through the bundled CLI.
The new helper takes a single argv verb (`stop`, `purge`, `restart`), boots `@endo/init` in its own subprocess, and dispatches through `@endo/daemon`'s `stop` / `purge` / `restart` exports, which send `E(bootstrap).terminate()` over the daemon's Unix-socket harbinger bootstrap.
Reviewable material for `endojs/endo-but-for-bots#231` G8; the followup that drops `endo-cli.cjs` from the production runtime path entirely will land separately.
