---
'@endo/daemon': major
---

Rename the JavaScript orchestration layer from "daemon" to "manager", matching the Rust `endor` supervisor's existing vocabulary.
The source modules `daemon.js`, `daemon-*-powers.js`, and `bus-daemon-*.js` are now `manager.js`, `manager-*-powers.js`, and `bus-manager-*.js`.
The `Daemon*` and `Daemonic*` identifiers become `Manager*`: `makeDaemon` is now `makeManager`, `DaemonicPowers` is now `ManagerPowers`, `DaemonCore` is now `ManagerCore`, and `makeDaemonDatabase` is now `makeManagerDatabase`.
The worker startup powers `MignonicPowers` become `WorkerPowers`.
The `./src/interfaces.js` exports `DaemonFacetForWorkerInterface` and `WorkerFacetForDaemonInterface` become `ManagerFacetForWorkerInterface` and `WorkerFacetForManagerInterface`.
The `Daemon*` and `Daemonic*` types in `src/types.d.ts` follow suit, among them `DaemonDatabase` (now `ManagerDatabase`), `DaemonicPersistencePowers` (now `ManagerPersistencePowers`), `DaemonicControlPowers` (now `ManagerControlPowers`), `DaemonWorkerFacet` (now `ManagerWorkerFacet`), `WorkerDaemonFacet` (now `WorkerManagerFacet`), and `DaemonCoreExternal` (now `ManagerCoreExternal`); the `workerDaemonFacet` field of a started worker is now `workerManagerFacet`.
The manager/worker CapTP interface tags change on both sides: `EndoDaemonFacetForWorker` becomes `EndoManagerFacetForWorker`, and `EndoWorkerFacetForDaemon` becomes `EndoWorkerFacetForManager`.
The npm package name `@endo/daemon`, the `endo`/`endod` binaries, the `ENDO_DAEMON_PATH` environment variable, and the on-disk state format are unchanged.

Migration: no deprecated aliases are kept, so this is a breaking change.
Import `@endo/daemon/src/manager-node-powers.js` in place of the `@endo/daemon/src/daemon-node-powers.js` subpath, and rename uses of the identifiers above.
A manager and worker built from different sides of this change will not interoperate, because both interface tags changed together.
The module `src/bus-xs-daemon-polyfills.js` and the script `scripts/bundle-bus-daemon-rust-xs.mjs` keep their names.
