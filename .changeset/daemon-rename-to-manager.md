---
'@endo/daemon': minor
---

Rename the JavaScript orchestration layer from "daemon" to "manager", matching
the Rust `endor` supervisor's existing vocabulary. The source modules
`daemon.js`, `daemon-*-powers.js`, and `bus-daemon-*.js` are now `manager.js`,
`manager-*-powers.js`, and `bus-manager-*.js`. The `Daemon*` and `Daemonic*`
identifiers become `Manager*` (`makeDaemon` is now `makeManager`,
`DaemonicPowers` is now `ManagerPowers`, `DaemonCore` is now `ManagerCore`,
`makeDaemonDatabase` is now `makeManagerDatabase`, and so on), and the worker
startup powers `MignonicPowers` become `WorkerPowers`. The manager/worker
CapTP facet tag changes from `EndoDaemonFacetForWorker` to
`EndoManagerFacetForWorker` on both ends together. No deprecated aliases are
kept. The npm package name `@endo/daemon`, the `endo`/`endod` binaries, the
`ENDO_DAEMON_PATH` environment variable, and the on-disk state format are
unchanged.
