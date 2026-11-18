# Architecture review AR-CTRL: supervisor, control plane, native resources, platform, entry points

Unit AR-CTRL of the core architecture review. Scope: `packages/thixotrope/src/control/**`,
`src/native/**`, `src/platform/**`, `bin/**`, `scripts/**`, the package entry files and
`package.json` exports; the three core native resources (`resources/clock`, `resources/control`,
`resources/http`) and the harness's one (`packages/thixotrope-harness/resources/agent-host`) were
read as users of the manager and adapter kits. Read-only review of the snapshot at `3f67a8e505`.
Paths below are relative to `packages/thixotrope/` unless they start with `packages/`.

Evidence marks: **[read]** I read the code; **[measured]** a script or grep counted it;
**[inferred]** a conclusion from reading that no test or run confirmed.

Started 2026-11-18T12:07:17Z; ended at the time in the commit (see "Time" at the end).

## Summary

**Change these three first.**

1. **Split `serveThixotrope`** (AR-CTRL-1). It is one 940-line closure
   (`src/control/supervisor.js:182-1122`). It holds 15 `let` bindings that several parts change,
   the configuration parsing, the whole administration facet (about 330 lines), the install
   orchestration, a second control-socket server and the shutdown sequence. Each harness core
   change to the control plane went through it.
2. **Stop shipping guest code under a hand-bumped version** (AR-CTRL-3). Twelve host functions
   are shipped into vats by `Function.prototype.toString()`. The only thing that keeps an old
   state directory from running new guest code is a person remembering to bump
   `WORKSPACE_VERSION`, which has 21 versions and a 40-line comment recording them. No test fails
   when someone forgets. A digest golden is a small fix.
3. **Pick one control-socket server** (AR-CTRL-2). The control socket is served two ways: as a
   native resource (213 lines across `resources/control`, plus `replaceUnhealthy` and C-4) and as a
   host fallback that repeats the listener code line for line. At least share the listener; better,
   let the host serve it, which also closes C-4.

**Keep these three.**

1. **The platform port boundary.** No module outside `src/platform/node/` imports a `node:`
   module [measured: grep, 0 files]. Core takes the members of `PlatformPowers` it names
   (`src/platform/powers.js`), and the record is a convenience for entry points only. Two small
   leaks remain: `node/powers.js` reads `THIXOTROPE_TRACE` from `process.env` rather than through
   the environment power (AR-CTRL-9), and the supervisor finds the default worker binary from
   `import.meta.url`, which assumes the repository layout.
2. **The manager and adapter kits** (`src/native/manager-kit.js`, `adapter-kit.js`). Their
   contract is clear: epochs name registrations, a resolved spec is adopted, desired state is
   withdrawn before the unbind, a handle acts only on its own generation, and an incarnation whose
   unbind is uncertain is retired. Each option has a real user [measured]: `same` 3 resources,
   `replaces` 2, `decorate` 2, `resolve` 1. Every core resource's ephemeral half is 79-105 lines.
   What is missing is a "service" shape (AR-CTRL-5), not a simplification.
3. **The registry vat with a host index beside it** (`src/control/registry.js`,
   `installation-index.js`, `installer.js`). Installing is one async function whose continuation
   is durable, so its "phases" need no record. Every host call is idempotent under the allocation
   key. The host keeps a repair path that does not run through the vat being repaired. Tests
   cover it, including a quarantined registry (`test/native-install.test.js`). Small shared helpers
   go with it and are worth keeping: `serial-queue.js`, `in-flight.js` (`makeInFlight`,
   `makeFirstFailure`), `describe-error.js`, `random-id.js`, `names.js` and `settleWithin`.
   `test/shipped-factories.test.js`, which checks that shipped factories are whole, is a good
   guard.

## Map of the area

Sizes are source lines [measured: `wc -l`]. Arrows point from importer to imported module
[measured: an import-graph script over `src`, `bin`, `scripts`, `resources` and the entry files].

| module | lines | job | imported by (non-test) |
|---|---|---|---|
| `src/control/supervisor.js` | 1,123 | composition root, config, administration facet, install requests, fallback control socket, shutdown | `bin/thix.js`, `index.js`, `supervisor.js`, `scripts/measure-mail.mjs`; 13 test files |
| `src/control/registry.js` | 527 | installation driver; **shipped into the registry vat** | supervisor |
| `src/control/workspaces.js` | 415 | workspace table, open/create, hand out/take back daemon-wide values, address book, mailbox placement | supervisor |
| `src/control/builtins.js` | 219 | `provide` rule for built-ins; ships clock, control, mailbox | supervisor, workspaces (type) |
| `src/control/local-control.js` | 173 | OCapN over a framed Unix socket; client `connectLocalControl` | supervisor, `resources/control/ephemeral.js`, `src/tui/*` (4), scripts (2) |
| `src/control/installer.js` | 166 | host `installer` resource: allocate, stage, installNativeModule, retire | supervisor |
| `src/control/installation-index.js` | 162 | host's durable copy of the registry | supervisor |
| `src/control/workspace-client.js` | 114 | client-side mail and clock commands | `bin`, `src/tui/mailbox-view.js` |
| `src/control/inventory-view-lifetime.js` | 91 | ephemeral inventory subscription per connection | supervisor |
| `src/control/measured-engine.js` | 90 | engine wrapper: timings and crank histogram | supervisor |
| `src/control/workspace-access.js` | 89 | **shipped into each workspace vat** | workspaces |
| `src/control/names.js` | 31 | name validators | registry, index, workspaces, supervisor, `src/guest/prelude.js` |
| `src/native/manager-kit.js` | 308 | `makeManager`; **shipped into manager vats** | installer |
| `src/native/adapters.js` | 296 | host launcher of adapter processes, exit backoff, retirement | `src/core/daemon.js` |
| `src/native/adapter-kit.js` | 155 | `makeAdapter`; runs in the adapter process | `native-adapter.js` |
| `src/native/contract.js` | 105 | types only | resources |
| `src/native/manager.js` | 63 | `makeNativeManager`; **shipped** | installer |
| `src/native/locate-resource.js` | 45 | find `durable.js`/`ephemeral.js` | supervisor |
| `src/adapter-keeper.js` | 61 | keeper of one incarnation; **shipped** | installer |
| `src/platform/*.js` (15 ports) | 642 | port typedefs and portable factories | everywhere |
| `src/platform/node/*.js` (11) | 1,273 | Node implementations, including `mail-ui-server.js` (215) | `node-powers.js`, bin, resources, scripts |
| `src/platform/browser/*.js` (3) | 374 | mail UI host and editor | web build |
| `bin/thix.js` | 234 | command line | (bin) |
| `scripts/*` (15) | 2,154 | bundlers (2), demo (1), mail UI (1), mail profiling research (11) | package.json names 4 |
| entry files (6) | 40 | thunks | |

Directory-level dependencies worth noticing [measured]: `src/control -> resources` (2 edges,
`builtins.js` imports the clock and control durable modules to ship them), `resources -> src/control`
(1, the control adapter imports `local-control.js`), `src/guest -> src/control` (1, `names.js`),
`src/platform/node -> src/net` (1, `adapter-process-entry.js` imports `pipe-network.js`),
`src/platform/node -> src/web` (2) and `src/platform/browser -> src/web` (3). The last three point
from the platform layer up into application layers (AR-CTRL-11, AR-CTRL-14).

The harness reaches the core through `@endo/thixotrope/guest.js` (92 type imports),
`node-powers.js` (6), `local-control.js` (5), `native-adapter.js` (2) and `supervisor.js` (1).
It also reaches past the entry files to `src/core/evaluate-source.js` (3),
`src/platform/node/adapter-process-entry.js` (2, as a path) and `src/guest/prelude.js` (1)
[measured]. Nothing in the repository imports the main entry `@endo/thixotrope`; one demo
script imports `../index.js` [measured].

## Findings

Severity: **major** costs correctness, safety or a large share of future work; **moderate**;
**minor**. Q = the review question answered (1 architecture, 2 repetition, 3 excess paths,
4 ontology, 5 other).

### AR-CTRL-1 (major; Q1, Q5) `serveThixotrope` is one 940-line closure with state that several parts change

- Where: `src/control/supervisor.js:182-1122`. The administration methods are at `659-989`, the
  fallback server at `997-1059` and shutdown at `1087-1121`.
- What: one function does every job. It parses the environment (`141-167`), builds the engine and
  store, takes the host's metadata through a side effect of the daemon's `validateState` callback
  (`369-411` assigns the outer `config` and `index`), makes the registry, workspaces and built-ins,
  defines both admin method sets and the per-connection facet, serves a second control socket and
  runs shutdown. The function's lexical scope holds 15 `let` bindings [measured]. These include
  `config`, `index`, `daemon`, `registry`, `clockFacet`, `controlFacet`, `fallbackListener`,
  `makeConnectionFacet`, `requested`, `peerNetlayer` and `closing`. Several are assigned late and
  read by closures defined earlier: `makeConnectionFacet` is used by `control-admin` (`424-434`)
  before it exists, which is why `readyKit` exists. That ordering is stated only in comments
  [read].
- Evidence: [read] the whole file. Of the harness's 25 logged core changes, CC-011, CC-014,
  CC-020, CC-024 and CC-025 touched this file (`packages/thixotrope-harness/CORE-CHANGES.md`
  summary table).
- Fix: move code without changing behaviour. (a) Put `readSupervisorConfig(environment, options)`
  in its own module (see AR-CTRL-13). (b) Put the administration in `admin.js`:
  `makeAdministration({ daemon, workspaces, registry, index, store, bundler, ... })` returning
  `{ daemonMethods, makeConnectionFacet }`. (c) Serve the control socket from `local-control.js`
  (AR-CTRL-2). (d) Leave composition and shutdown in `supervisor.js`. Have `validateState` return
  `{ config, index }` instead of assigning outer bindings, if the daemon can pass a value through.
- Size: about 450 lines moved into 2 new files, about 40 changed; no behaviour change.
- Risk: low to moderate. The ordering of `readyKit` and `makeConnectionFacet` must survive.
  Covered by the 13 test files that start a supervisor and by the Ironhorse lane
  (`test/ironhorse/supervisor.js`).

### AR-CTRL-2 (moderate; Q2, Q3) The control socket is served two ways, and the listener is written twice

- Where: the native resource, `resources/control/durable.js` (108 lines) and `ephemeral.js:45-100`,
  shipped by `src/control/builtins.js:200-209` and provided with `replaceUnhealthy`
  (`src/control/supervisor.js:1061-1064`). The host fallback is `serveFallback`
  (`src/control/supervisor.js:997-1059`), and the error path that switches to it is at `1065-1085`.
- What: both copies do the same steps. They listen with mode 0600, keep a connection set, and on
  `EADDRINUSE` probe, remove and listen again. Each connection gets
  `makeLocalControl(..., 'worker', facet)` and the facet is closed when the session ends; on
  close, every connection's writer is returned. The two copies differ only in where the facet
  comes from: `E(spec.admin).connect()` in one, `makeConnectionFacet()` in the other.
  The native path also adds an extra process and a hub hop to every admin frame [inferred]. It is
  the cause of C-4: the socket path is kept in a vat heap
  (`packages/thixotrope-harness/designs/m0-results.md` C-4). It also needs the `replaceUnhealthy`
  option, which only this built-in uses [measured: 1 caller].
- Evidence: [measured] a duplicate-window finder (normalized 4-line windows) found the matching
  blocks at `supervisor.js:1033-1054` and `resources/control/ephemeral.js:76-95`. Across the
  scope these were the only exact duplicates; the other repetition is semantic (AR-CTRL-12).
- Fix, smallest: add
  `serveLocalControl({ sockets, random, log }, path, { connect, mode })` to
  `src/control/local-control.js` and call it from both places (−45 lines). Fix, larger (the
  owner's decision): have the host always serve the socket. That deletes `resources/control`,
  `shipControl`, `replaceUnhealthy` and the `controlFacet` branches, closes C-4, and bumps
  `WORKSPACE_VERSION`. The design's reason for the resource is that "the operator's authority
  stays host code and works while vats are broken". The host listener already provides that.
- Size: smallest 2 files, about 60 lines; larger about 300 lines removed across 5 files.
- Risk: the smallest fix is low; `test/native-install.test.js` covers both paths, including
  "control socket served by the host". The larger fix changes the state layout (version bump) and
  any harness test that inspects the `control` installation.

### AR-CTRL-3 (major; Q5) Guest code shipped by source is guarded by a hand-bumped version

- Where: `src/control/supervisor.js:74-113` (`WORKSPACE_VERSION = 21`, with a changelog comment),
  `src/control/builtins.js:17-20` and `src/control/workspaces.js:51-54` ("a change to it is a
  `WORKSPACE_VERSION` bump"). Shipping sites: `builtins.js:188,204,214`, `supervisor.js:523`,
  `workspaces.js:143-146,312,323,361` and `installer.js:140-141`. That is 12 `toString()` uses in
  `src/control` [measured].
- What: the version check is what refuses a state directory whose vats hold older guest closures
  than this build ships. The version is a constant a person must bump whenever any of about 12
  shipped functions changes, including indirect changes such as `makeObservableMap`, `makeManager`
  or `makeAdapterKeeper`, which live in other directories. `test/shipped-factories.test.js` checks
  that each factory is whole; nothing checks that the version moved [read]. Missing a bump causes
  exactly what the comment says the version prevents: new host code running against old guest
  code in an existing state directory [inferred].
- Fix: add a golden test that computes sha256 over the concatenated `toString()` of the shipped
  factories and asserts it together with `WORKSPACE_VERSION` (both pinned in the test). A change
  then fails until both are updated. Another option: record the digest in `workspace.json` and
  refuse on mismatch, which removes the constant altogether. Move the 40-line history comment to
  the README or the CORE-CHANGES record.
- Size: about 30 lines of test, plus the comment move.
- Risk: none at run time. The golden fails on every shipped-source edit, which is the point;
  formatting-only edits fail it too.

### AR-CTRL-4 (moderate; Q3, Q4) `stop()` does not stop, and `stopped` means two things

- Where: `src/control/supervisor.js:282-287` (`stopKit`, `requestStop`), `662-665` (`stop`),
  `1087-1110` (`close`); callers `bin/thix.js:60-61`,
  `packages/thixotrope-harness/scripts/serve.mjs:687-688` and `test/ironhorse/alarm-crash.js:37`.
- What: the admin `stop()` only resolves `stopped`. The supervisor keeps serving until the
  embedding caller calls `close()`, so every caller must repeat `await stopped; await close()`
  (3 of 3 callers do [measured]). On the other path, `close()` also resolves `stopped` at its end.
  So `stopped` means "stop requested" or "closed", depending on how it was reached. Between
  `stop()` and the caller's `close()`, `requested` is still false: connections, installs and
  evaluations are still accepted [read].
- Fix: let `stop` schedule `close()` (it is already idempotent through `closing ??=`). Resolve
  `stopped` only when the close finishes, and rename it `closed`. Callers keep calling `close()`,
  which returns the same promise.
- Size: about 10 lines in 1 file; callers unchanged.
- Risk: low. The harness's `close` wrapper writes its serve record after `supervisor.close()` and
  keeps working. Covered by the `stop` command tests in the Ironhorse lane.

### AR-CTRL-5 (moderate; Q4, Q1) The native contract has no "service" shape and no configuration; the harness works around both

- Where: core `src/native/manager-kit.js:139-146,200-306` (the keeper fetches the adapter root;
  the kit exposes only `register`, `keys` and `lifecycle`), `src/native/contract.js:40`
  (`make(powers: {})`) and `src/platform/node/adapter-process-entry.js:41` (`make(harden({}))`).
  Harness `packages/thixotrope-harness/resources/agent-host/durable.js:12-16,78-82,197-201` and
  `ephemeral.js:20-55`.
- What: the kit models passive registrations (key, spec, binding: an alarm, a port). The
  harness's agent host is a service: its manager needs the adapter's root. It registers one key
  with `same: () => true` and a spec that carries a manager-owned `sink`, and the adapter's `bind`
  calls `E(sink).attach(ops)` to hand its root back. The registration protocol thus stands in for
  "give me the adapter". In addition, an adapter receives no configuration, so the harness finds
  its implementation by walking four directories up from the core's `adapter-process-entry.js`
  (`argv[1]`) to a sibling package. Its own comment says making this an install-time setting
  "needs `installNative` to carry a configuration" (J-0221). Two consequences follow. The design's
  sentence "the adapter holds mechanism and no memory of who asked" does not describe the one
  resource the harness has. And the design's terms registration and spec do not fit it
  (`designs/thixotrope.md` glossary, lines 84-86 and 102) [read].
- Fix: (a) Add `provideAdapter()` to the kit: `keeper.provide()` run under the kit's queue,
  documented in `contract.js` as the service shape. The harness then drops `SERVICE_KEY`, the
  sink's `attach` and the retry in `withOps`. (b) Let `installNative(name, directory, config)`
  carry a passable record that the launcher passes to the ephemeral `make(config)`. If that is not
  wanted, remove the always-empty `powers` parameter from the contract so the gap is visible.
- Size: core about 30 lines in 3 files; the harness saves about 40 lines.
- Risk: `manager-kit.js` is shipped, so the change needs a `WORKSPACE_VERSION` bump (AR-CTRL-3).
  Covered by `test/manager-kit.test.js` and the harness's `test/adapter/*`.

### AR-CTRL-6 (moderate; Q2) Three framings for byte streams; one is base64 inside JSON

- Where: `src/control/local-control.js:41-97` (4-byte big-endian length, 8 MiB cap, no
  continuation); `src/net/unix-netlayer.js:98-175` (4-byte big-endian length with a continuation
  flag, 1 MiB per frame); `src/platform/node/adapter-processes.js:96,110` and
  `adapter-process-entry.js:20,25` (Node IPC `{ frame: base64 }`).
- What: two hand-written incremental length-prefix readers work over the same `SocketConnection`
  port, with different limits and different handling of large messages. Endo already has
  `@endo/netstring`, which `@endo/daemon` uses. The cost of the IPC framing (about 1.33 N bytes
  and 4 copies per frame) is measured in
  `packages/thixotrope-harness/designs/spike-dataref/survey-ocapn-hub.md` section 3 and not
  repeated here. I checked that survey's line references against this snapshot
  (`adapters.js` about line 211, `adapter-processes.js:92-110`); they hold.
- Fix: one `makeFramedReader/Writer(socket, { maxFrame, continuation })` in `src/net` used by
  both socket users. Replacing the IPC channel with a length-prefixed binary pipe is the
  survey's proposal and belongs to the data-reference work.
- Size: about 60 lines removed, 1 new module.
- Risk: moderate. The local admin wire format changes only if the limits are unified; old
  clients of a newer supervisor would break. Covered by `test/local-control.test.js` and
  `test/unix-netlayer.test.js`.

### AR-CTRL-7 (moderate; Q2, Q3) The repair path for a quarantined registry is spread over three files

- Where: `src/control/supervisor.js:550-555` (`assertRegistry`), `639-654` (`listInstallations`
  projection), `804-848` (`remove`, which includes the `control` guard twice, at `812-815` and
  `832-835`); `src/control/workspaces.js:219-249` (`removeInstallationsOf`, whose retire-and-forget
  loop at `240-248` repeats `supervisor.js:836-844`); `src/control/builtins.js:91-96`.
- What: keeping a host index so that the host can act without the registry vat is a good design
  (see Keep 3). But the choice between registry and index is made separately at each use: 13
  `registryHealthy` references across 3 files [measured]. The listing record has three
  hand-written projections: `registry.js:509-524`, `supervisor.js:639-654` and the record written
  at `registry.js:193-221`.
- Fix: a host-side `makeInstallations({ registry, registryHealthy, index, daemon, serialized })`
  with `list()`, `remove(name, workspace)` and `removeAllOf(workspace)`, deciding the path once.
  Add one `describeInstallation(entry)` shared by the registry (shipped, so it would be defined
  inside it and reused by the host through the index record) and the fallback.
- Size: about 60 lines fewer, 1 new module, 3 files touched.
- Risk: low. `test/native-install.test.js` covers "a quarantined registry vat leaves the host
  serving from its index", and `test/workspaces.test.js` covers a gone workspace vat.

### AR-CTRL-8 (moderate; Q3) Compatibility and test-only branches in the launcher

- Where: `src/native/adapters.js:134-137` (a launcher with no bundle digest: "installed before
  its ephemeral module was bundled"), and the `owner === undefined` branches at `127`, `175`,
  `183`, `188-189` and `236`.
- What: bundles were introduced at workspace version 9 (`supervisor.js:88-90`), and
  `assertRecordVersion` refuses every other version (`src/store/versioned-record.js:14-23`).
  A launcher binding without a key therefore cannot come from a directory this build serves
  [inferred: assumes the daemon validates the workspace metadata before any launcher is used].
  The ownerless launcher is created only by tests (`test/native-adapter.test.js:158,446`); the one
  production caller always binds `workerId` (`src/control/installer.js:117`) [measured].
- Fix: delete the legacy message, and make `workerId` required in the binding (tests pass one).
  The five `owner !== undefined` guards then disappear.
- Size: about 15 lines in 1 file, plus 2 test call sites.
- Risk: low. `test/native-adapter.test.js` needs the binding.

### AR-CTRL-9 (moderate; Q3, Q5) Configuration arrives five ways

- Where: options of `serveThixotrope` (`supervisor.js:173,185-192`: `engine`, `idleSleepMs`,
  `snapshotEveryDeliveries`, `maxDeliveryAttempts`, `crashRetryDelayMs`, `mailboxPlacement`);
  `EnvironmentPowers` (14 distinct `THIXOTROPE_*` names, read in `supervisor.js:141-167,240` and
  `src/ironhorse/ironhorse-limits.js:140-150` [measured]); `process.env` read directly
  (`THIXOTROPE_TRACE`, `src/platform/node/powers.js:85`, 40 lines before it builds the
  environment power that should carry it); persisted per state directory (`workspace.json`
  `mailboxPlacement`, `runtime.json` collection limits); and hard-coded values (three 1,000 ms
  shutdown graces at `supervisor.js:313,324,331`; a 30 s adapter startup timeout at
  `node/adapter-processes.js:22`; `QUICK_EXIT_MS` 10 s; a worker binary path assumed relative to
  the repository at `supervisor.js:241-244`).
- What: `maxDeliveryAttempts` may come from the option or the environment, and the environment is
  validated only when the option is omitted. Passing `engine` silently skips the Ironhorse limits
  and drops `status().ironhorse` (`232`, `692`). The harness passes some settings as options and
  the rest through an environment allowlist (`packages/thixotrope-harness/scripts/serve.mjs:
  578-605`) [read].
- Fix: one `readSupervisorConfig(environment, options)` that returns a frozen record, validates
  every source, and is reported whole in `status()`. Read `THIXOTROPE_TRACE` through the
  environment power.
- Size: about 60 lines, 3 files.
- Risk: low; a setting that is now validated may refuse a value it used to ignore.

### AR-CTRL-10 (minor; Q3, Q4) Two mailbox placements, one used only by a test

- Where: `src/control/workspaces.js:354-373`, `src/control/supervisor.js:382-395,487`;
  `test/workspaces.test.js:50,110`.
- What: the mailbox is either a built-in application installation (`separate`, the default) or a
  global in the workspace vat (`workspace`). The setting is persisted, checked three times, and
  cannot be changed for an existing directory. Neither `bin` nor the harness passes it [measured].
  The design glossary describes only the separate form ("a mailbox provided to it in a vat of its
  own").
- Fix: remove the `workspace` placement, or make it the only one. Either way the option, the
  three checks and one branch go.
- Size: about 40 lines, 2 files and 1 test.
- Risk: a directory created with `workspace` placement would be refused; the only such
  directories are test fixtures.

### AR-CTRL-11 (minor; Q1) Mail UI concerns in the administration and the platform layer

- Where: `supervisor.js:887-894` (`getMailUiToken`, a `Symbol.for` global in the workspace vat),
  `896-911` (`getInventory`, `adopt`), `438-447` (the `mail-introductions` resource written
  inline); `src/platform/node/mail-ui-server.js` (215 lines), `src/platform/browser/*` (374 lines).
- What: `getMailUiToken` is used only by `scripts/mail-ui.mjs` and a test, `getInventory` only by
  two mail scripts, and `adopt` only by the mail UI and its tests [measured]. The platform
  directories, which the README describes as host ports, import `src/web` (5 edges) and so depend
  on an application.
- Fix: move `mail-ui-server.js` and `browser/` under `src/web/node` and `src/web/browser`. Move
  the three mail-UI methods onto a facet reached from the address book or the inventory, not the
  root administration.
- Size: about 5 files moved; about 30 lines in supervisor.
- Risk: low; mail UI tests (`test/mail-ui.test.js`).

### AR-CTRL-12 (minor; Q2) Small repetitions in the control plane

All [measured] by grep:

- "Has this vat failed?" is written as `daemon.inspectWorkers().find(w => w.workerId === id)
  ?.failure` at 4 sites (`supervisor.js:507-509`, `workspaces.js:282-284,307-309`,
  `builtins.js:111-114`). "Does it exist?" is `daemon.listWorkerIds().includes(id)` at 6 sites,
  each building a fresh array. `kept()` (`supervisor.js:657-658`) does this once per
  allocating vat.
  Fix: `daemon.workerFailure(id)` and `daemon.hasWorker(id)`.
- `shipClock` and `shipControl` (`builtins.js:184-209`) differ only in a name and a function.
  Fix: `shipNative(name, make)`.
- The pattern "ask the vat for `globalThis.X`, else `evaluateSource` the factory" appears at 5
  sites (`supervisor.js:518`, `workspaces.js:124,319`, `installer.js:73,125`). Fix: one helper.
- The 103-byte Unix socket path limit is in `supervisor.js:119` and `src/net/unix-netlayer.js:34`.
  The string `'control.sock'` builds the socket path in 7 files across the two packages,
  4 of them in the harness or in scripts. Fix: export the constant and a
  `controlSocketPath(paths, statePath)`.
- `resources/clock/ephemeral.js:14` repeats `MAX_TIMER_DELAY_MS` (`src/platform/timers.js:13`).
- `makeSerialQueue` repeats `@endo/daemon`'s `serial-jobs.js`. Keep it: it has to be shippable
  by source and is in the guest prelude.
- Size: about 50 lines in total, 6 files. Risk: low.

### AR-CTRL-13 (minor; Q1) Directories do not say where code runs

- Where: `src/native/` holds code shipped into vats (`manager-kit.js`, `manager.js`), code for
  the adapter process (`adapter-kit.js`) and host code (`adapters.js`, `locate-resource.js`).
  `src/adapter-keeper.js` (shipped) sits at the `src` root. `src/control/registry.js` and
  `workspace-access.js` are shipped from a host directory.
  `src/platform/node/adapter-process-entry.js` imports `src/net/pipe-network.js`, and it calls
  `makeNodePowers()` whole to use three powers.
- What: code shipped by source must be whole (prelude only, no module-level bindings), and only
  a comment in each file says so. The protocol between manager and adapter is described in prose
  three times (`contract.js:44-65`, `manager-kit.js:22-30`, `adapter-kit.js:17-28`), and a fourth
  time in the design.
- Fix: put every shipped factory under `src/shipped/` (or use a `.shipped.js` suffix), and have
  `test/shipped-factories.test.js` enumerate that directory instead of a hand list. Keep the
  protocol text in `contract.js` only.
- Size: about 6 file moves and import updates. Risk: low; the moves change `toString()` output
  only if the files' text changes.

### AR-CTRL-14 (minor; Q4) Pipe vocabulary: `workerId` and `role` name other things

- Where: `src/control/local-control.js:43-44` (`workerId: 'local-admin-v1'`, role `'host'` for
  the client and `'worker'` for the supervisor-side listener); `supervisor.js:1021`;
  `resources/control/ephemeral.js:62`; `adapter-process-entry.js:18-19`; `src/net/pipe-network.js`
  (`isInitiator: role === 'host'`).
- What: in the pipe network, `workerId` means the pipe's name and `role` means which end
  initiates. The admin client is the "host" and the supervisor is a "worker". The design's
  glossary has worker, host and vat as distinct terms [read].
- Fix: rename the options to `{ name, initiator }`. Keep the seed strings
  (`${NETWORK_ID}:${role}:${workerId}`) byte for byte so identities do not change.
- Size: about 15 lines, 5 files. Risk: none if the seeds are kept. No pipe-network test exists
  of its own; `test/local-control.test.js` and the worker-peer tests cover it indirectly.

### AR-CTRL-15 (minor; Q4) Administration verbs and shapes that differ without reason

- Where: `supervisor.js:717-744` against `756-794`, and `874-911`.
- What: `install` answers the registry's list entry, while `installNative` answers
  `{ name, directory, digest }`. An application request carries `digest` and `bundleDigest` with
  the same value (`731-736`). `keep` (replace, name checked) and `adopt` (put if free, name not
  checked) are two ways to put a value into the inventory. The `help` text lists `status` as
  daemon-wide, but `status` is a workspace method (`660-661` against `682`).
  `bundler.bundle` returns a `digest` that every caller ignores (`supervisor.js:766`,
  `bin/thix.js:177`; the comment at `bin/thix.js:175-176` says the supervisor recomputes it)
  [measured].
- Fix: one result shape for both installs; drop the duplicate field; check the name in `adopt`;
  drop `digest` from `bundle`.
- Size: about 20 lines. Risk: callers that read the `installNative` result (`bin`, the harness
  provisioning scripts) need the new shape.

### AR-CTRL-16 (minor; Q5) Bounded-by-process growth and an unbounded failure string

- Where: `src/native/adapters.js:58-61` (`retiredOwners` grows by one per retired vat for the
  life of the process, as its comment says); `supervisor.js:934-937` (views of an adapter that
  died stay listed until stop, as its comment says); `src/native/manager.js:60`
  (`error: String(error)`, kept in the manager vat's heap forever).
- What: the first two are acknowledged and bounded by the vats one process retires. The third is
  the only failure text in the area not cut by `describeError` (512 characters), which the
  prelude provides.
- Fix: use `describeError` in `manager.js`. Optionally, drop a `retiredOwners` entry once the
  daemon has forgotten the worker.
- Size: 1 line, plus a version bump (shipped). Risk: none.

### AR-CTRL-17 (minor; Q3) The public surface is wider than its users

- Where: `index.js` (8 exports), `package.json` `exports` (6 subpaths), `package.json`
  `private: true` together with `publishConfig.access: public`.
- What: `index.js` exports `makeXsEngine`, `makeDurableNetLayer`, `makeFsStore`,
  `inspectIronhorseStore` and `makeThixotropeDaemon`, and re-exports `serveThixotrope` and
  `connectLocalControl`, which also have subpaths of their own. That gives two import paths for
  each. No package imports the main entry [measured]. The harness's real needs that are not
  exported are `evaluateSource` (3 deep imports) and the path of `adapter-process-entry.js`
  (AR-CTRL-5).
- Fix: decide the supported surface (supervisor, client, Node powers, adapter kit, guest
  types). Export `evaluateSource` if the harness's use is supported. Drop the duplicate
  re-exports, or drop the subpaths.
- Size: under 20 lines. Risk: the demo script and in-package tests import `../index.js`.

### AR-CTRL-18 (minor; Q2) `bin/thix.js` keeps its command names in five lists

- Where: `bin/thix.js:38-45`, `67-91`, `122-134`, `210-216` and the usage text at `227`.
- What: adding a command means editing three or four lists, and the lists already disagree in
  form: the second mixes `includes` with ten `===` comparisons.
- Fix: one table of `{ daemonWide, json, run }` per command, with the usage text derived from it.
- Size: about 80 lines rewritten in 1 file. Risk: low; CLI tests in the Ironhorse lane.

### AR-CTRL-19 (minor; Q5) Research tooling in the package's `scripts/`

- Where: `scripts/` holds 15 files and 2,154 lines. Eleven of them (about 1,600 lines) are mail
  profiling tools: two `.patch` files against `rust/engine/ironhorse-vm`, three Python scripts,
  and `mail-profile*`, `mail-hub-*`, `mail-vm-detail*`, `measure-mail` and
  `profile-mail-loader`. `package.json` names 4 scripts [measured].
- What: the patches will drift from the engine; the published `files` list excludes `scripts`,
  so these are repository-only.
- Fix: move them to a `designs/` or `tools/` directory with the study that used them, or delete
  them and leave a journal pointer.
- Size: file moves. Risk: none.

## What I did not cover

- `src/core/**`, `src/net/**` (apart from the framing comparison in AR-CTRL-6), `src/store/**`,
  `src/ironhorse/**`, `src/mail/**`, `src/web/**` and `src/tui/**`: other units.
  `src/guest/prelude.js` only as the list of names shipped code may use.
- The Rust worker and engine.
- `resources/http/**` beyond its use of the kit options; `resources/clock/**` beyond its use of
  the kit options and its timer limit.
- Test quality across the 25,000 test lines: I checked only that the paths named in "Risk" are
  covered by the tests named, by reading test titles and grep, without running them.
- `src/platform/node/files.js`, `sync-files.js`, `sockets.js`, `terminal.js` and `line-reader.js`
  were skimmed, not read line by line. The async and sync file powers are twins with different
  method sets (`makeDirectory` takes `mode` only in the async one). The supervisor writes its two
  host records through different twins: `workspace.json` by `files.writeTextAtomic`, and
  `installations.json` by a sync atom that asserts the store lease, which the first does not
  [read]. Not developed into a finding.
- No supervisor was started; no measurement here depends on a run.

## Time

Started 2026-11-18T12:07:17Z. The end time is recorded in journal entry J-9958.
