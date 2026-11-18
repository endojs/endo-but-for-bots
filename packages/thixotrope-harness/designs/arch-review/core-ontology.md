# Architecture review AR-ONTO: ontological consistency of the Thixotrope core

Unit: AR-ONTO (question 4, across the whole of `packages/thixotrope`, JavaScript side).
Started 2026-11-18T12:07:18Z; the end time is in the journal entry J-9964.
Read-only review of a snapshot of the harness branch. No source, test or config file was changed.

Sources compared: the design `designs/thixotrope.md` (called DESIGN; its own "Vocabulary" table
is at lines 73-105), `packages/thixotrope/README.md` (README), and in the harness
`designs/architecture.md` (ARCH) and `CORE-CHANGES.md` (CC, whose "Terms" section is at lines
14-36). Code paths are relative to `packages/thixotrope/` unless they start with `packages/`.

How each claim was established: **[read]** I read the code or text at that place; **[measured]**
a script counted it; **[inferred]** a conclusion drawn from what was read and not checked by
running anything. The counts come from a `grep -ioE '\bTERM'` script run outside the repository
over `src/` plus the root `*.js` files (src), `test/` (test), README, DESIGN, and ARCH together
with CC (harness). A count is the number of occurrences of the term, not the number of distinct
meanings, and short terms also match longer words (`ref` matches `refcount`). Read the counts as
a guide to scale only.

---

## 1. What is good and should be kept

- **DESIGN has a vocabulary table, and the code follows most of it** [read]. "Durable" always
  means "survives a supervisor restart". "Retire" always means "end for good, leaving
  tombstones". "Allocation key", "installation", "grant" and "provided", "registration", "spec",
  "facet", "lifecycle" and "keeper" are used as DESIGN defines them, in identifiers as well as in
  prose. Few packages have this, and it made this review possible.
- **The hub's internal model is consistent** [read, measured]. In `src/net/hub.js` and
  `src/net/hub-state.js`, a *row* is always a reference row keyed by `refId`, a *position* is
  always one session's index into its c-list (103 uses of `position` in `hub.js`, only one of
  `slot`), and *origin*, *backing*, *flavor* and *facing* each have one meaning. The 50-line
  header of `hub.js` matches the code.
- **"Retire" and "forget" are kept apart, and the difference is real** [read]. `retireSession`
  bumps the session's epoch and tombstones its rows but keeps its record. `forgetSession`
  (`hub.js:2690-2697`) does that and also deletes the record, for a key that will never be used
  again. `forgetWorker` and `retireWorkerNow` in `src/core/daemon.js:516-557` follow the same
  split. Keep both words.
- **The native-resource contract speaks one language** [read]. `src/native/contract.js`,
  `adapter-kit.js`, `manager-kit.js`, DESIGN lines 291-323 and the resources under `resources/`
  all use `bind(key, spec, epoch)`, `unbind(key)`, `restore(...)`, "registration", "handle",
  "facet" and "lifecycle" in the same senses.
- **Versioned records refuse what they cannot read, and say why** [read]. Every persisted
  record that carries a version goes through `assertRecordVersion`
  (`src/store/versioned-record.js`), and the refusal messages name the record.

---

## 2. Vocabulary table: the names in use for each concept

Columns: the DESIGN name; the names the code uses (identifiers, file names, error text, persisted
fields); the names in README and the harness documents; and where the uses diverge. Counts are in
the order src / test / README / DESIGN / harness [measured].

| concept | DESIGN | code | README, ARCH, CC | divergence |
|---|---|---|---|---|
| guest heap with an identity | **vat** (line 79): "one guest heap … run by a worker" | **worker** for the durable identity: `workerId` (309 uses), `WorkerMeta`, `workers/<id>/`, `createWorker`, `listWorkerIds`, `status().workers`. **vat** in `collectVats`, `inspectVatReachability`, and prose. Measured: 1,087 identifier tokens containing "worker" in 37 files, against 229 containing "vat". | README: "Workers are sleepy", "Workers have no names" (the worker is the vat). ARCH and CC: vat. | Code and README use "worker" for what DESIGN calls the vat (AR-ONTO-4). |
| the process that runs a vat | worker process, **incarnation** (line 101) | `WorkerIncarnation` (`src/core/worker-engine.js:31-48`), `incarnation` in `durable-worker-transport.js`, `workerProcess` | "worker process" in ARCH fact 7 | "Incarnation" is also used for the session epoch (AR-ONTO-1). |
| hub session | **session** (line 80); durable and transient sessions | `sessionKey`, `SessionState`, `attachSession`, `retireSession`. Key namespace: the bare `workerId`, `'endpoint'`, `peer:<token>`, `handoff:<…>`, `transient:<hex>`, `transient:native:<hex>` (`peer-sessions.js:99,106`, `daemon.js:147,1040`, `native/adapters.js:138`) | "hub session" (README 3) | "Session" is also a netlayer peer session record (`SessionStore`, `sessions/<token>/`, `listSessionTokens`), a terminal session (`TerminalSession`, `src/platform/terminal.js:12`), the record file `worker-session-records.js`, and in the harness an agent conversation ("session vat", 35 uses in ARCH). See AR-ONTO-14. |
| transient session | **transient session** (line 80) | "transient session" (5), "ephemeral session" (2), "disposable observer" (5), `discardOnRestart` (14) | README 1 | Five names for one thing (AR-ONTO-9). |
| the host's own reifying session | **host endpoint** (9 uses in DESIGN) | `ENDPOINT_SESSION = 'endpoint'`, `ENDPOINT_ID = 'e'.repeat(32)` (a pseudo-worker), "the endpoint" (25), `makeWorkerSessionRecords` | "endpoint session" (README 1). The harness's `Endpoint` is an adapter-side turn object (ARCH 484-485). | "Host endpoint" is never written in code (0 uses). It is modelled as a worker (AR-ONTO-5). |
| a reference in the hub | reference row, position (lines 34, 120) | `row` (197 uses in `hub.js`), `refId`, `position`, persisted as `refs` | README and `daemon.js:41` say "slot-rewriting hub" and "c-list tables" | The hub rewrites positions, not slots (AR-ONTO-7). |
| export slot of the endpoint's OCapN client | "export slots" (line 247) | `slot` strings `o+N`, `p+N`, `a-N` (`worker-session-records.js:228-283`, `daemon.js:342-354`) | none | "Slot" also means a heap slot, a staging slot and an atom slot (AR-ONTO-7). |
| reference counting and release | "release of an export drops that export's record" | `refcounts`, `mentionsIn`, `onExportReleased`, `gc-exports` | ARCH: "OCapN GC frames" | Consistent. |
| supervisor process | supervisor (17), daemon (18), host (71) | `control/supervisor.js` ("the local supervisor: the process …"), `core/daemon.js` (`ThixotropeDaemon`, a component inside it) | README: "A thixotrope daemon is a simpler cousin of the Endo daemon"; "primary daemon" (README 321) | Three words for the process and for its restart (AR-ONTO-13). |
| restart | "daemon startup", "host restart" | "daemon start(up)" 12, "supervisor restart" 7, "host restart" 6 | README: 9 / 2 / 1 | Same event, three names (AR-ONTO-13). |
| host resource | **resource** (line 82) | `makeResource`, `retireResource`, `provideResource`, `ResourceBinding`, resource names `worker-facade`, `worker-controller`, `native-adapter`, `control-admin`, `installer`, `installation-index`, `mail-introductions` | "host resource" (README 3), "system resource" (README 2) | "Resource" is also half of "native resource", which is a different concept (AR-ONTO-8). |
| native resource | **native resource** (line 83): manager plus adapter | installation kind `'native'` (`control/registry.js:14`), directory `resources/`, `locateNativeResource` | ARCH: "native resource" (agent-host, workspace, containers) | It is an installation, not a resource. |
| adapter launcher | **launcher** (line 103) | resource name `'native-adapter'` (`daemon.js:725`), `Far('NativeAdapterLauncher')` (`native/adapters.js:120`), the manager-kit power `adapters` (`native/manager-kit.js:36`) | none | Three names. The persisted one is `native-adapter` (AR-ONTO-8). |
| adapter | **adapter** (line 85): "the only sense of the word" | `makeAdapter`, `adapter-kit.js`, `adapter-keeper.js`. Other senses: netlayer "adapters" (`hub.js:1293-1295`), "resource adapter" (`daemon.js:260`) | DESIGN itself says "CLI and UI adapters" at line 452 | The rule is broken at 4 sites (AR-ONTO-17). |
| manager | **manager** (line 84) | `makeManager`, `manager-kit.js`, `manager.js`; "manager vat" (9), "manager kit" (4) | consistent | Consistent. |
| registration identity | the `epoch` of a registration (line 308); "generation" (lines 285, 298) | `epoch` (bigint, `native/adapter-kit.js:58`, `manager-kit.js:121`) | none | "Epoch" names three different counters (AR-ONTO-2). |
| worker input log | journal | `appendJournal`, `journal.jsonl`, `journalCranks`, snapshot `cut` (also written `journalLength` and `index`) | CC: "worker journal" | The cut has three names (`store.js:56-61` against `durable-worker-transport.js:936`). |
| hub persistence | "host routing state and journals" | `hub-image.json` plus `hub-log.jsonl` (`store/hub-log-store.js`), `hub.json` (the file store) | CC line 22: "persists them to `hub.json`" (out of date) | AR-ONTO-15. |
| heap image | "sleep image", "heap image" | `snapshot` (`{ ref, cut }`), `releaseSnapshot`, `checkpointInternal`; "image" for the SQLite copy and the hub base | survey-engine.md: "engine checkpoint" and "host image" | The three words cover two things: the snapshot, which is the artifact plus its record, and the checkpoint, which is the operation. "Image" is a third word for both. A minor issue. |
| one evaluation in a vat | "execution step" (lines 148, 179, 183), "crank" (2) | `crank` (131): the frames delivered together plus job drain; "delivery" is used for a frame in one place and for a crank in another | CC: "Crank (delivery)"; ARCH: crank (136) | AR-ONTO-6. |
| wire unit | frame, message | `frame` (406), "duct message" (3), "message" (369, often meaning a mailbox record) | consistent | DESIGN reserves "message" for a mailbox record (line 94). The code uses it for both. A minor issue. |
| workspace | **workspace** (line 88): one user's vat | `Workspace` (the host record), `Far('Workspace')` (the guest root), `WORKSPACE_VERSION` and `workspace.json` (state-wide) | ARCH section 3.4: the harness "workspace" native resource (per-session directories) | AR-ONTO-14, AR-ONTO-19. |
| installed code | installation; application or native resource | `InstallationKind = 'application' \| 'native'`, debug labels `app:` and `native:`, CLI `install` and `install-native` | README: "app" | Consistent apart from `app`/`application`. |
| end of life | retire, revoke (invitations only), release, collect | `retireSession`, `forgetSession`, `retireWorkerNow`, `forgetWorker`, `retireResource`, `revokeInvitation`, `collectVats`, `releaseSnapshot`, `clearStartNotice` with `withdrawStartNotice` | consistent | "Collect" has two senses (AR-ONTO-20). "Retired" has two senses for a vat (AR-ONTO-3). |
| failed vat | quarantine (4) | `meta.failure`, `WorkerHaltError`, "given up", `onFatal`, "quarantined" (22) | ARCH: halt, given up, lost | Consistent in code. The harness adds "lost". |
| publication key | **swissnum** (line 92) | `swissnum` in `hub.js` (22); `secret` in the `daemon.js` API (28): `publish(value, secret)`, `unpublish(secret)`, `lookup(secret)`; "locator" (`daemon.js:1023-1024`) | DESIGN 495: "removes the locator" | AR-ONTO-10. |
| sturdy reference | "OCapN sturdy reference" | `makeSturdyRef`, `makeSturdyRefDetails`, "sturdy ref" | consistent | Consistent. |
| durable, ephemeral, transient | durable vat or session; ephemeral vat, subscription or module; transient session or client | `durable` flag, `ephemeral` meta and subscription flag, `ephemeral.js`; "ephemeral session" at 2 sites | consistent | The hub's two uses of "ephemeral session" break the split (AR-ONTO-9). "Persistent" appears only in "orthogonally persistent". |
| what a resource is bound to | "bound to a worker, a key, both or neither" | `ResourceBinding { workerId?, key? }`. "Binding" also names an adapter's live object for a registration (`adapter-kit.js`) and the workspace's evaluation bindings (`supervisor.js` header). | none | AR-ONTO-18. |
| start notification | `started()`, "start notice" | `startNotify` (persisted), `notifyOnStart`, `setStartNotice`, `clearStartNotice` and `withdrawStartNotice` | README: "startup notification" | Two verbs for the same withdrawal. A minor issue. |

---

## 3. Findings

### AR-ONTO-1 (major, question 4b) "Incarnation" names two lifetimes, and DESIGN defines it by the wrong one

- **Where.**
  - DESIGN line 101 defines an incarnation as "One process of a worker or an adapter … references
    into it break with it".
  - The code uses "incarnation" for a worker process: `src/core/worker-engine.js:31-48` (the
    `WorkerIncarnation` typedef) and `durable-worker-transport.js:83, 109, 336-343, 949`.
    References into a worker process do *not* break when it ends: sleep ends the incarnation, and
    the session and its rows stay.
  - The code also uses "incarnation" for the hub-session epoch, whose end *does* break
    references: `hub.js:47` ("the retired incarnation's rows"), `hub.js:2214` and `hub.js:2652`
    ("Permanently drop a session's incarnation: its epoch bumps"), `hub.js:2660`,
    `peer-sessions.js:405` and `peer-sessions.js:570`.
- **Evidence.** [read] Waking a sleeping vat starts a new `WorkerIncarnation` with the same
  session key and epoch (`daemon.js:240-294`). Only `retireSession` bumps the epoch.
- **Why it misleads.** A reader who takes DESIGN's definition concludes that a vat's sleep breaks
  references into it. A reader who takes the hub's comments concludes that an adapter restart is
  a new epoch of the same session. Neither is true. Each adapter process gets a fresh `transient:`
  key, and an epoch bump happens only on retirement. The harness relies on the true model (ARCH
  D-5).
- **Which is right.** The code's worker sense. An adapter incarnation breaks references because
  its transient session is forgotten, not because it is an incarnation.
- **Fix.**
  - Change DESIGN line 101 to read: "incarnation: one process of a worker or an adapter. A
    worker's references survive it. An adapter's break with it, because its transient session is
    forgotten."
  - In the five hub and peer comments, write "epoch" where they now say "incarnation".
- **Size.** About 8 lines in 3 files. Comments and documentation only.
- **Risk.** None: no code changes.

### AR-ONTO-2 (moderate, question 4b) "Epoch" names three unrelated counters, and DESIGN adds "generation"

- **Where.** [read]
  1. The hub-session epoch: `hub.js:45, 720-731`. It is persisted as `epoch` on every session and
     every row (`hub-state.js:43, 56`) and inside every `refId` (`${origin}#${epoch}:…`). It is
     also persisted as `hubEpoch` in the netlayer session record (`peer-sessions.js:130, 190, 572`).
  2. The registration epoch: a bigint that a manager vat keeps in its heap
     (`native/manager-kit.js:121`, `adapter-kit.js:58`).
  3. The answer epoch: `answerEpoch` in the endpoint's tables record. It counts daemon processes
     so that the endpoint's question positions are partitioned between them
     (`worker-session-records.js:428-430`).
  4. There is also `opGeneration` in the worker transport (`durable-worker-transport.js:296`).
  5. DESIGN uses "generation" for (1) at line 285 and for (2) at line 298, and
     `manager-kit.js:14` does the same for (2).
- **Fix.** Do not rename the persisted fields. Always qualify the word in prose: "session
  epoch", "registration epoch", "answer epoch". Replace "generation" at DESIGN 285 and 298 and at
  `manager-kit.js:14` (3 sites). Add the three qualified terms to the glossary.
- **Persisted formats.** Hub `epoch`, the `refId` format, `hubEpoch`, `answerEpoch`, and the
  manager-heap `epoch`. The manager-heap epoch lives in a guest closure, so renaming it needs a
  bump of `WORKSPACE_VERSION` and fresh state. Do not rename any of them.
- **Size.** About 6 lines. **Risk.** None.

### AR-ONTO-3 (major, question 4b) "Retired" covers both a quarantined vat and a vat that is gone, and callers cannot tell which

- **Where.** [read]
  - A quarantined vat keeps its store, its journal and its `failure`, but its session is retired:
    `daemon.js:263` (`onFatal: () => hub.retireSession(workerId)`) and `daemon.js:288-289`.
  - A retired vat loses its store and its session: `forgetWorker`, `daemon.js:516-520`.
  - An ended adapter incarnation has its transient session forgotten (`native/adapters.js:156`).
  - All three reach callers with the same text, "ocapn hub: the target session has been retired"
    (`hub.js:1842, 2278, 2306`). A fourth text, "Remote session has been retired"
    (`hub.js:2624`), reports the same state through another path.
- **Evidence.** [read] The harness matches the exact string (`guest/lib/retired.js:25`). ARCH
  D-17 instructs session code to tell a restart apart from a lost vat by *who* broke the call,
  because the text cannot do it. This is candidate C-18 seen from the vocabulary side: the hub's
  session-level verb "retire" implements two vat-level states.
- **Fix.** Give the break a reason that names the vat-level state: `quarantined`, `retired` or
  `ended` (an adapter incarnation). Keep the current text as a prefix so that today's matchers
  still match. Use one text where the code now has two.
- **Size** [inferred]. `retireSession` and `forgetSession` take a reason; about 30 lines in
  `hub.js` and `daemon.js`, plus the tests that assert the text (`grep -rl 'has been retired'
  test` finds them).
- **Risk.** The harness's exact match, which keeping the prefix avoids.

### AR-ONTO-4 (moderate, questions 4a and 4c) The vat is called "worker" in code and README, and "vat" in DESIGN

- **Where.**
  - DESIGN line 79 says a vat is the heap and a worker runs it.
  - The code names the vat's durable identity "worker" throughout [measured]: 1,087 tokens in 37
    files, against 229 for "vat". The public daemon API mixes the two: `createWorker`,
    `getWorker`, `listWorkerIds` and `inspectWorkers` beside `collectVats` and
    `inspectReachability`.
  - One object carries both names within a few lines [read]. `control/workspaces.js:278-292` has
    `const vat = await daemon.createWorker(…)` and then `const worker = …` for the same value.
    `control/registry.js:249` has `entry.workerId = … E(vat).getId()`.
  - README lines 22-40 use "worker" for the vat.
- **Which should win.** Renaming the code costs about a thousand sites and several persisted
  names: `workerId` in `workspace.json` and in the installation index, the `workers/`
  directory, and `status().workers`, which the harness performance helpers read through their own
  `workers()` accessors (9 files under `packages/thixotrope-harness/perf/` [measured]; that they
  read this field is [inferred]). Fix the definitions instead.
- **Fix.**
  - In DESIGN and the glossary, write: "worker: the host's record and machinery for one vat (id,
    store, journal, transport), named by its `workerId`; its processes are worker incarnations."
  - Keep "vat" for the guest-side concept, and say in one sentence that a vat's `workerId` is its
    identity.
  - Rename the two local variables at `workspaces.js:278` and `registry.js:249`.
- **Size.** About 6 lines of documentation and 4 lines of code.
- **Risk.** None.

### AR-ONTO-5 (moderate, question 4c) The host endpoint is modelled as a pseudo-worker, and its records are named for workers

- **Where.** [read and measured]
  - `daemon.js:144-147` gives the endpoint a worker id, `'e'.repeat(32)`. It has a `WorkerStore`
    on disk at `workers/eeee…/` (layout in `store/store-fs.js:23-27`).
  - Eight sites in `daemon.js` special-case that id: lines 333, 370, 372, 737, 764, 788, 955
    and 1004.
  - `core/worker-session-records.js` defines `makeWorkerSessionRecords`, but its own header (line
    36) calls the records "Endpoint session records".
  - Its connection-to-`workerId` WeakMap (line 79) gets exactly one entry, from the only call of
    `registerWorkerConnection` (`daemon.js:370`).
  - `WorkerStore.getTablesRecord` and `setTablesRecord`, and `tables.json` beside every worker,
    are used only for the endpoint (all 7 uses are in `worker-session-records.js` and `daemon.js`
    lines 955 and 1004). `store.js:9-13` admits this.
  - The `WorkerStore` documentation (`store.js:56-61`) is out of date. It still says "CapTP tables
    record", "bootstrap slot" and `journalLength`, where the field is `snapshot.cut`.
- **Which is right.** DESIGN: the endpoint is a session of the host's, not a worker.
- **Fix, smallest step.**
  - Rename the module to `endpoint-records.js` (`makeEndpointRecords`, `registerEndpointConnection`)
    and drop the one-entry WeakMap.
  - Correct `store.js:56-61`.
  - These are not persisted names: about 40 lines in 5 files with tests.
- **Fix, larger step** (flag only). Give the store an endpoint record of its own in place of the
  pseudo-worker. That moves persisted state (`workers/eeee…/tables.json`) and needs a one-way
  migration.
- **Risk.** `test/worker-session-records.test.js` and `test/worker-session-restart.test.js` cover
  the module. Four test files hard-code `'e'.repeat(32)`.

### AR-ONTO-6 (moderate, question 4b) "Delivery" means a frame in one setting and a crank in another

- **Where.** [read]
  - `control/measured-engine.js:20-23, 58-60` count one delivery per crank ("One crank, however
    many frames it carries: one delivery"). So `status().timings.delivery` and
    `status().deliveryHistogram` count cranks.
  - `snapshotEveryDeliveries` counts journal entries, GC frames included
    (`durable-worker-transport.js:803-808`).
  - `maxDeliveryAttempts` counts crashes at one journal index.
  - DESIGN calls a crank an "execution step" (lines 148, 179, 183), a phrase the code never uses.
    CC's term "Crank (delivery)" merges the two.
- **Why it misleads** [inferred]. ARCH's "every 256 deliveries" cadence and the "delivery
  histogram" in the performance budgets count different things. Since CC-015, a crank can carry
  up to 64 GC frames beside its ordinary frame, so the two numbers can differ by that factor.
- **Fix.**
  - Define "delivery: one journal frame handed to the engine" and "crank: one engine evaluation,
    one or more deliveries and the job drain".
  - Rename the measured engine's metric to `crank`, and add `crankHistogram` with
    `deliveryHistogram` kept as an alias for one release, because the harness reads it.
  - Replace "execution step" in DESIGN with "crank" (3 sites).
- **Size.** About 15 lines in 3 files.
- **Risk.** Harness performance parsers. The control-socket status tests.

### AR-ONTO-7 (moderate, question 4b) "Slot" has four meanings, and the hub is described as rewriting slots

- **Where.** [read]
  1. A heap slot: `THIXOTROPE_SLOT_CEILING`, `ironhorse-limits.js`.
  2. An OCapN client slot string, `o+N`, `p+N` or `a-N`, used to key the endpoint's persisted
     export records (`worker-session-records.js:187-283`, `daemon.js:342-354`).
  3. A staging slot: the name of a `globalThis` symbol in `core/evaluate-source.js:31-55`, passed
     as the `slot` option by 3 callers.
  4. DESIGN's `SyncStringAtom` slot (line 481).
- Meanwhile the `daemon.js:41` header and README line 15 call the hub "slot-rewriting". The hub
  itself rewrites *positions* [measured]: 103 uses of `position` in `hub.js`, 1 use of `slot`.
- **Fix.**
  - Change "slot-rewriting" to "position-rewriting" (2 sites).
  - Rename the staging option `slot` to `stagingKey` (3 callers and the typedef, about 8 lines).
  - Keep "heap slot", and "slot" in the OCapN client's own sense, which is that package's word.
- **Persisted formats.** The export-record keys (`o+N`) and the staging symbol names, which live
  in vat heaps. Rename only the option, not the symbol strings.
- **Risk.** Low. The callers are internal.

### AR-ONTO-8 (moderate, question 4b) "Resource" names two unrelated kinds, and the launcher has three names

- **Where.** [read]
  - DESIGN line 82: a host resource is a factory registered at the endpoint (`makeResource`, 7
    names at `daemon.js:724-728` and in the supervisor).
  - DESIGN line 83: a native resource is an installation (kind `'native'`,
    `control/registry.js:14`), whose manager and adapter are not host resources. Only its
    launcher is one.
  - The launcher is registered as `'native-adapter'` (`daemon.js:725`), shown as
    `Far('NativeAdapterLauncher')` (`native/adapters.js:120`), and passed to the manager kit as
    the power `adapters` (`native/manager-kit.js:36`). DESIGN calls it "launcher" (line 103).
- **Why it misleads** [inferred]. "Retiring a worker retires every resource bound to it"
  (DESIGN 251) reads as if it covered native resources installed in that worker. It covers only
  host resources. A native resource's installation is removed through the registry.
- **Fix.**
  - In prose, always write "host resource" for the first sense (README already does, 3 sites).
    DESIGN line 82 should open with "host resource".
  - Add a glossary line: "a native resource is an installation kind, not a host resource".
- **Persisted formats** (flag, do not rename casually). The resource name `native-adapter` is
  stored in every launcher's endpoint export record (`{ kind: 'resource', name, binding }`).
  The manager-kit power name `adapters` lives in manager vat heaps, so renaming it needs a
  `WORKSPACE_VERSION` bump.
- **Size.** About 5 documentation lines.

### AR-ONTO-9 (moderate, question 4a) The transient session has five names, and one of them ("disposable observer") is applied to sessions that are not observers

- **Where.** [read and measured]
  - "transient session": 5 uses.
  - "ephemeral session": `hub.js:69`, `hub.js:2682`, `peer-sessions.js:68`.
  - "disposable observer": `hub.js:63, 1230-1241, 2360-2409`.
  - `discardOnRestart`: 14 uses in src and 14 in test.
  - "Each native incarnation is an ephemeral session": `native/adapters.js:25`.
- **Why it misleads.** Native adapter sessions are attached with `discardOnRestart: true`
  (`native/adapters.js:211-215`) and are therefore "disposable observers" in the hub's
  vocabulary. Yet they issue commands to vats: HTTP requests and clock firings. The hub's
  `Fail` message says "disposable observer requires a unique transient session", which an adapter
  author will not recognise as their own case.
- **Fix.**
  - Use "transient session" in every comment and error text (about 10 sites).
  - Rename `discardOnRestart` to `transient` (28 sites, none persisted), or keep the flag and
    change only its documentation.
- **Risk.** Low. `test/hub*.test.js` covers it.

### AR-ONTO-10 (minor, question 4a) The publication key is called swissnum, secret and locator

- **Where.** [read and measured]
  - `hub.js` uses `swissnum` (22 uses; `publish(swissnum, …)` at line 2592).
  - The daemon API, which wraps it, uses `secret` (28 uses in `daemon.js`): `publish(value,
    secret)` at 1025, `unpublish(secret)` at 1033, `lookup(secret)`, `makeSturdyRefDetails(secret)`.
    `store.js:31` calls `startNotify` a "publication secret".
  - "Locator" names the publication at `daemon.js:1023-1024`, `mail/introductions.js:44-45` and
    DESIGN line 495. In the OCapN client, "locator" is the peer's own swissnum table
    (`core/worker-peer.js:97`, `platform/node/adapter-process-entry.js:49`).
  - Several swissnums are not secret: `shell`, `root`, and `workspace-<workerId>` (`workspaces.js:292`).
- **Fix.**
  - Rename the parameter to `swissnum` in the `ThixotropeDaemon` typedef and implementation
    (about 10 lines).
  - Reserve "locator" for a peer's own table and change the 3 prose sites.
- **Risk.** None for persisted state.

### AR-ONTO-11 (moderate, questions 4c and 3) The ephemeral worker is a second, unused model of a disposable resource adapter

- **Where.** [read]
  - DESIGN line 79 still defines an "ephemeral vat or worker".
  - `daemon.js:664-690` offers `createEphemeralWorker` on the guest-visible worker controller,
    which every workspace holds as `vats` (`workspaces.js:289-290`).
  - `daemon.js:257-262` justifies its `resident` flag by "a resource adapter that sleeps".
  - Startup and shutdown paths for it: `daemon.js:729-783` and `daemon.js:1100-1104`.
- **Evidence** [measured]. No caller in `src/`, `resources/` or the harness. One test uses it,
  `test/adapter-keeper.test.js`.
- **Which is right.** DESIGN lines 274-278 explain why a disposable adapter must be a Node
  process and not a vat. Native resources replaced this mechanism. "Adapter" in
  `daemon.js:260` is the older sense of the word (see AR-ONTO-17).
- **Fix.** Remove `createEphemeralWorker` and the `ephemeral` meta path, keeping the startup
  discard of any `ephemeral: true` meta for one `WORKSPACE_VERSION`. Remove the DESIGN clause.
- **Size.** About 70 lines in 2 files plus one test.
- **Risk.** The method is on a guest-visible interface. A vat in an existing state directory
  could call it, so removal is an interface change that belongs with a version bump.
- This is also a question-3 finding. It is listed here because DESIGN's vocabulary keeps the
  concept alive.

### AR-ONTO-12 (minor, question 4c) The mailbox has a second placement that DESIGN does not have

- **Where.** [read]
  - DESIGN line 88 provides the mailbox "in a vat of its own".
  - The code also supports `mailboxPlacement: 'workspace'`, persisted in `workspace.json` and
    checked at `supervisor.js:383-395`. In that mode the mailbox is evaluated into the workspace
    vat under `globalThis.workspaceMailbox` (`workspaces.js:354-369`).
- **Evidence** [measured]. The only caller is `test/workspaces.test.js:50`.
- **Fix.** Remove the mode if no state directory in use has it. Otherwise document it in DESIGN
  as a compatibility placement.
- **Size.** About 40 lines.
- **Risk.** A state directory created in that mode would be refused, and should be.

### AR-ONTO-13 (moderate, question 4b) "Daemon", "supervisor" and "host" for the process and its restart

- **Where.**
  - In code, `ThixotropeDaemon` (`core/daemon.js`) is a component that `control/supervisor.js`
    composes. The supervisor's header (lines 2-29) calls the supervisor "the process that owns a
    Thixotrope state directory".
  - The prose uses three names for one restart [measured]: "daemon start(up)" (src 12, test 10,
    README 9, DESIGN 3), "supervisor restart" (7, 3, 2, 0) and "host restart" (6, 6, 1, 3).
  - DESIGN and README give ownership to "the daemon's" hub, registry, clock and control socket
    (DESIGN lines 88-89, 389). Those are composed in the supervisor, not in the daemon object.
  - README line 5 uses "a thixotrope daemon" for the whole system. README line 321 says "The
    primary daemon".
- **Why it misleads** [inferred]. A reader looks for the registry and the clock in `daemon.js`
  and finds neither. The harness, rightly, says "supervisor" for the process, as in "SIGKILL the
  supervisor".
- **Fix.** Glossary entries:
  - "supervisor: the process, and its composition root";
  - "daemon: the `ThixotropeDaemon` object inside it (hub, workers, endpoint)";
  - "host: everything trusted outside the vats";
  - "restart: a supervisor restart".
  Then reword the prose over time. No code identifier needs to change.
- **Size.** About 20 prose sites.

### AR-ONTO-14 (moderate, question 4b, across both packages) Session, workspace, endpoint and lease mean different things in the core and in the harness

- **Where.** [read]

  | word | core sense | harness sense (ARCH) |
  |---|---|---|
  | session | a hub session, a protocol relationship | an agent conversation and its "session vat" (35 uses) |
  | workspace | a user's vat with an inventory | the native resource of per-session directories (section 3.4) |
  | endpoint | the host endpoint session (`ENDPOINT_SESSION`) | the adapter-side `Endpoint` with `holdTurn` (lines 484-485) |
  | lease | the state-directory engine lease | the turn lease of D-5 |
  | turn | a JavaScript turn | an agent turn |

  The core itself also uses "session" for a terminal (`TerminalSession`), although DESIGN line 80
  says a session is "never a socket".
- **Where a reader is misled.** `guest/lib/retired.js` in the harness matches "the target session
  has been retired". In that text, "session" is a hub session, never a harness session, yet the
  code that matches it lives in the session vat.
- **Fix.**
  - In harness documents and comments, write "hub session" whenever the core sense is meant.
  - Prefer "conversation" or keep "session" only for the harness sense.
  - Rename `TerminalSession` to `TerminalConnection` in the core (10 sites, not persisted).
  - The glossary in section 4 qualifies each word.
- **Size.** Documentation, plus about 10 core lines.

### AR-ONTO-15 (minor, question 4c) Terms and comments that describe the system before CC-022 and CC-025

- **Where.** [read]
  - CC "Terms" lines 18-22 still say that a crank "runs a full garbage collection" and that the
    hub "persists them to `hub.json`". Collection has been on the allocation schedule since
    CC-022, and the hub store has been a log over an image since CC-025.
  - `durable-worker-transport.js:102` says "the full collection that ends every crank".
  - `worker-engine.js:38` says `deliverBatch` runs "one collection".
  - `ironhorse-limits.js:23` is correct.
- **Fix.** Four lines. **Risk.** None.

### AR-ONTO-16 (minor, question 4a) The files of the in-vat bootstrap are named for XS but serve Ironhorse

- **Where.** [read]
  - `scripts/bundle-ironhorse-worker.mjs:57-65` bundles `src/core/worker-peer-xs.js` into
    `dist-ironhorse/worker-peer.js`, which the supervisor boots (`supervisor.js:245-247`).
  - The module's header still says it runs in "the XS machine by the `thixotrope-xs-worker`
    binary".
  - `xs-engine.js` lives under `src/ironhorse/`.
- **Fix.** Rename the module to `worker-bootstrap.js`, correct its header, and move `xs-engine.js`
  beside the other engine seams.
- **Risk** (flag). If the bundle embeds the module's path, the boot bundle bytes change. That
  changes the runtime identity, and existing state directories are refused (CC, "Runtime
  identity"). Check the bundle bytes before and after. A header-only change has the same effect,
  because comments are part of the bundle bytes [inferred].
- **Size.** About 6 lines in 4 files.

### AR-ONTO-17 (minor, question 4a) DESIGN's rule "adapter has one sense" is broken at four places

- **Where.** [read] DESIGN line 452 ("CLI and UI adapters"); `hub.js:1293-1295` (netlayer
  "adapters", including "Legacy ephemeral adapters"); `daemon.js:260` ("resource adapter").
- **Fix.** Write "renderers" at DESIGN 452, "transports" in `hub.js`, and remove the sentence in
  `daemon.js` (or the method, AR-ONTO-11).
- **Size.** 4 lines.

### AR-ONTO-18 (minor, question 4b) "Binding" and "key" each name several things

- **"Binding"** [read] names:
  - the persisted `ResourceBinding { workerId?, key? }` (`daemon.js:84-93`, stored in every
    resource export record);
  - an adapter's live object for one registration (`native/adapter-kit.js:56`);
  - a workspace's evaluation bindings (`supervisor.js:19-20`).
- **"Key"** names a resource-binding key, a registration key, an allocation key, a session key,
  an inventory key and a journal header key.
- **Fix.** Use the qualified forms in prose: "resource binding", "adapter binding", "registration
  key". No rename. The field `binding` in export records is persisted.

### AR-ONTO-19 (minor, question 4d) The state-wide version is called the workspace version

- **Where.** [read]
  - `WORKSPACE_VERSION = 21` (`supervisor.js:113`) gates every guest closure the supervisor ships:
    the registry, clock, control socket, mailbox and address book.
  - It is checked as "workspace metadata" (`supervisor.js:377-381`) and stored in `workspace.json`
    (`supervisor.js:253`), which also holds the table of every workspace and the mailbox
    placement.
  - Workspaces have been a table since version 11, so the name describes one row of what it
    gates.
- **Fix.** Rename the constant and the message to "state version" or "guest closure version".
- **Persisted formats** (flag). The file name `workspace.json` would need a migration. Leave it,
  and say in its documentation that it is the state directory's metadata.

### AR-ONTO-20 (minor, question 4b) "Collect" names both heap garbage collection and vat collection

- **Where.** [read]
  - DESIGN line 191: "collection between completed cranks" (the engine).
  - DESIGN line 533 and `collectVats`: retiring vats that the host's graph cannot reach.
  - ARCH uses the first sense (48 uses).
- **Fix.** Use "garbage collection" for the engine sense and "vat collection" for the host's.
  Add both to the glossary.

---

## 4. Persisted names that a rename would touch (question 4d: flag only)

None of these should be renamed without a version bump and a stated migration. [read]

| name | where it is stored | concept |
|---|---|---|
| `workerId`; `workers/<id>/` | `workspace.json` workspace table, installation index, store layout | the vat's identity |
| `meta.json` fields `ephemeral`, `failure`, `crash`, `snapshot.{ref,cut}`, `startNotify`, `allocationKey`, `outboundBase`, `hubDelivery` | `workers/<id>/meta.json` | per-vat host state |
| `tables.json` with `exports` (keyed `o+N`/`p+N`), `answerEpoch` | `workers/eeee…/` only | the endpoint's records (AR-ONTO-5) |
| hub `refs.{origin,epoch,position,backing,flavor,…}`, `sessions.{epoch,ourExports,processedUpTo,…}`, the `refId` format `origin#epoch:…` | `hub-image.json`, `hub-log.jsonl` | the hub's tables |
| session keys: bare `workerId`, `endpoint`, `peer:`, `handoff:`, `transient:`, `transient:native:` | inside every `refId` and the session table | session kinds |
| `hubSessionKey`, `hubEpoch` | `sessions/<token>/meta.json` | the netlayer peer session record |
| resource names `native-adapter`, `worker-facade`, `worker-controller`, `control-admin`, `installer`, `installation-index`, `mail-introductions`; field `binding` | endpoint export records | host resources |
| `version`, `mailboxPlacement`, `workspaces` | `workspace.json` | state metadata (AR-ONTO-19) |
| registration `epoch`, the manager-kit power `adapters`, staging symbol names `thixotrope.*Source` | guest heaps (closures frozen at first evaluation) | need a `WORKSPACE_VERSION` bump |
| `status().workers`, `deliveryHistogram`, `timings.delivery` | the control-socket API, read by the harness performance scripts | AR-ONTO-4, AR-ONTO-6 |

---

## 5. Proposed glossary (38 terms) for both packages

The word that wins is in bold. Words in brackets are synonyms to avoid.

1. **vat**: one guest heap behind one OCapN endpoint, with a durable identity, its `workerId`.
2. **worker**: the host's record and machinery for one vat (store, journal, transport). In code
   identifiers, "worker" denotes the vat.
3. **incarnation**: one process of a worker or of an adapter. A worker's references survive it.
   An adapter's break with it. [not: session epoch]
4. **sleep / wake**: the end and start of a worker incarnation, which a guest cannot observe.
5. **crank**: one engine evaluation, made of one or more deliveries and the drain of the job
   queue; metered by the crank budget. [not: execution step, delivery]
6. **delivery**: one journal frame handed to the engine within a crank.
7. **frame**: one OCapN wire message between a session and the hub. [not: message, duct message]
8. **journal**: a worker's durable log of inbound frames, cut at its snapshot.
9. **snapshot**: the engine's heap artifact plus its record `{ ref, cut }`. **Checkpoint** is the
   act of making one and truncating the journal. [not: image, for the vat]
10. **hub**: the supervisor's OCapN router. It holds tables, never values. [not: router]
11. **hub state**: the hub's tables, stored as a hub image plus a hub log of deltas.
12. **hub session**: one protocol relationship in the hub, named by a session key. Never a socket
    and never a terminal.
13. **session key**: a hub session's name: a `workerId`, `endpoint`, `peer:…`, `handoff:…` or
    `transient:…`.
14. **durable session**: a hub session that queues frames while detached and survives restart.
15. **transient session**: a hub session under a `transient:` key, discarded at startup.
    [not: ephemeral session, disposable observer]
16. **session epoch**: the counter that retirement bumps, so that a successor under the same key
    never meets old rows. [not: incarnation, generation]
17. **reference row** (row): the hub's record of one exported object or promise, keyed by
    `refId`.
18. **position**: one session's index for a row (its c-list entry). [not: slot, for the hub]
19. **tombstone**: a dead row that keeps holders' positions breaking loudly until released.
20. **host endpoint**: the daemon's one reifying session, which hosts host resources and
    administration. [not: pseudo-worker]
21. **supervisor**: the process that owns a state directory, and its composition root.
22. **daemon**: the `ThixotropeDaemon` object inside the supervisor (hub, workers, endpoint).
23. **host**: everything trusted outside the vats.
24. **restart**: a supervisor restart. [not: daemon restart, host restart]
25. **host resource**: a capability made by a factory registered at the host endpoint and bound
    by a resource binding `{ workerId?, key? }`.
26. **native resource**: an installation kind made of `durable.js` and `ephemeral.js`. It is not
    a host resource.
27. **manager**: the durable half of a native resource, run in a **manager vat** and built with
    the **manager kit**.
28. **adapter**: the ephemeral half of a native resource: one Node process per incarnation. No
    other sense.
29. **launcher**: the host resource that starts a manager's adapter processes; it is registered
    as `native-adapter`.
30. **registration**: one desired entry under a registration key, with its **spec**, its
    **registration epoch** and the **handle** a caller holds. The adapter's live object for it is
    its **adapter binding**.
31. **installation**: a name in the registry for an application or a native resource.
32. **workspace**: one user's vat, with its inventory and address book. (The harness's
    per-session directories need another name.)
33. **publication**: a swissnum-to-reference mapping in the hub; a retention root. Its key is
    the **swissnum**. [not: secret, locator]
34. **sturdy reference**: a node location plus a swissnum.
35. **quarantine**: a vat whose `failure` is recorded, after a **halt** or after being **given
    up**. Its hub session is retired and its store is kept.
36. **retire / forget**: to end a session, vat, host resource or incarnation for good, leaving
    tombstones. To forget is to retire and also delete the record, for a key that is never reused.
37. **garbage collection / vat collection**: the engine reclaiming heap between cranks, and the
    host retiring vats it cannot reach.
38. **durable / ephemeral / transient**: durable survives restart. Ephemeral describes a vat,
    subscription or module that is discarded by design. Transient is reserved for sessions and
    clients.

---

## 6. Not covered

- The Rust engine and worker vocabulary (`rust/**`), apart from what the JavaScript side shows.
- The terms used only in the mail UI (`src/web`, `src/platform/browser`), apart from "adapter"
  and "session".
- Whether test names match the behaviour they test. That belongs to the per-area units.
- The harness package's own code, which gets its own review. Only ARCH and CC were compared.
