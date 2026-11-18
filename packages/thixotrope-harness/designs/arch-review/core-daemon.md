# Architecture review AR-CORE: daemon, worker transport, session records, engine glue, guest

Unit AR-CORE of the core architecture review. Read-only: no source, test or config file was
changed. Base: branch `claude/thix-arch` at `3f67a8e505`. `pkg` is `packages/thixotrope`.
Started 2026-11-18T12:07:17Z, ended at the time in the journal entry J-9955.

Each claim is marked **[read]** (I read the code), **[measured]** (a grep or script counted it) or
**[inferred]** (reasoning, not executed). No test was run.

---

## Summary (one page)

The area is about 5,400 lines of source in 26 files [measured], with about 6,800 lines of tests on
its core modules [measured]. Dependencies mostly point the right way: `core` imports nothing from
`control`, there is no import cycle in scope, and only two edges point upward (`core/daemon.js`
imports `native/adapters.js`; `guest/prelude.js` imports `control/names.js`) [read]. The
durability discipline is sound and well documented. The structural cost sits in two closures of
over 800 lines each and in a vat life cycle that no single module owns.

**The three things most worth changing**

1. **Give the vat life cycle one owner and one state machine (AR-CORE-1).** The life cycle is
   spread over about ten flags in the transport (`destroyed`, `standingDown`, `givenUp`,
   `incarnation`, `retry`, `stalled`, `retriesArmed`, `checkpointQueued`, ...), the daemon's
   `workers` map, `meta.failure` on disk and the hub's retired-session flag. "Given up" is tested in
   seven places across two files, and the daemon's startup loop repeats the transport's retry
   policy. Open candidates C-8, C-10 and C-11 (startup waits for crashing vats, no break for a
   call into a given-up vat, no reinstate) all need edits on both sides of that split.
2. **Split `buildDaemon` and stop the daemon and engine glue from reading other modules' private
   formats (AR-CORE-7, AR-CORE-8).** `buildDaemon` is one 936-line closure with about twelve jobs.
   `vat-reachability.js` walks the hub's persisted tables field by field. `ironhorse-runtime.js`
   knows the store's file names: CC-025 had to edit it when the hub became a log.
3. **Name each concept once and give each wire shape one definition (AR-CORE-3, -4, -5).**
   - "crash" names three things and "retire" names two (deleting a vat, quarantining its session).
   - The design's vat/worker split is "worker" for everything in code: 264 occurrences of "worker"
     against 13 of "vat" in `daemon.js`.
   - The Ironhorse guest entry is a file named and documented for XS (`worker-peer-xs.js`).
   - The duct envelope (`{t:'f', b64}`) is hand-coded at 18 sites in 4 files, and OCapN slot
     strings are parsed by hand at 11 sites, although `@endo/ocapn` has `parseSlot`.

**The three things most worth keeping**

1. **The transport's replay contract**: journal before the duct; crank boundaries as a pure
   function of the journal (`journalCranks`); a sequence number for each outbound frame that the
   hub's watermark deduplicates. It is small, its comments say exactly what replay depends on, and
   `durable-worker-session`, `worker-gc-cranks` and `daemon-journal-recovery` test it.
2. **The failure taxonomy and crash-loop policy**: halt (`WorkerHaltError`, deterministic,
   quarantine), crash (`WorkerCrashError`, counted, retried with backoff) and the host's own
   trouble (never counted). `durable-worker-crash-loop.test.js` has 26 tests whose titles read as
   the policy's specification [measured].
3. **The Ironhorse runtime pinning** (`ironhorse-runtime.js`). It pins the worker and bootstrap
   digests, requires heap ceilings that only rise and a collection schedule that is fixed, runs
   private checked copies of the worker and bootstrap, and holds a kernel lease. It refuses any
   mismatch with a message that says what to do. Also keep the small shared modules
   (`serial-queue`, `in-flight`, `random-id`, `describe-error`, `is-remotable`). Each is
   single-purpose, and none re-implements a shared Endo package: `makeSerialJobs` is private to
   `@endo/daemon`, and `@endo/stream`'s `makeQueue` is a different primitive [read].

---

## Map of the area

Sizes in lines [measured, `wc -l`]. "Imported by" counts source importers outside the file; test
counts are files under `pkg/test` [measured, grep].

| module | lines | job | imports (in package) | imported by |
|---|---|---|---|---|
| `src/core/daemon.js` | 1,209 | composition root and kernel: hub, worker table, endpoint session, resources, start notices, retirement, startup and shutdown, transient clients, bundle sweep, reachability | hub, peer-sessions, in-process-session, transient-hub-client, durable-worker-transport, worker-session-records, vat-reachability, native/adapters, in-flight, random-id, platform logging/timers | control/supervisor, builtins, workspaces, installer, `index.js`; 27 tests |
| `src/core/durable-worker-transport.js` | 1,016 | one vat's journal, crank batching, wake/sleep/checkpoint, crash counting and retry, retire | serial-queue, worker-engine, worker-crash-error | daemon only; 6 tests |
| `src/core/worker-session-records.js` | 504 | durable export and resolver records of the endpoint session; resource instances | none | daemon, vat-reachability; 2 tests |
| `src/core/vat-reachability.js` | 201 | the vat graph from hub state, roots, collectible vats | worker-session-records, `@noble/hashes` | daemon; 1 test |
| `src/core/peer-replay-engine.js` | 201 | in-process engine doubles (no snapshot / log snapshot) | worker-peer | no source importer; 29 tests |
| `src/core/worker-peer.js` | 134 | the vat side: OCapN client, shell facet, compartment with the prelude | guest/prelude, net/pipe-network | daemon (type), replay engines, worker-peer-xs |
| `src/core/worker-peer-xs.js` | 140 | the bootstrap entry bundled into **both** engines' workers: duct dispatch, `thixotropeTakeOutbound` latch | worker-peer, platform/logging | `scripts/bundle-xs-worker.mjs`, `scripts/bundle-ironhorse-worker.mjs:59` |
| `src/core/evaluate-source.js` | 76 | staged transfer of large source into a vat | none | control (3 files) |
| `src/core/worker-engine.js` | 59 | `WorkerEngine` and `WorkerIncarnation` types; `WorkerHaltError` | none | 7 source files |
| `src/core/worker-crash-error.js` | 21 | `WorkerCrashError` | none | 4 source files |
| `src/ironhorse/ironhorse-engine.js` | 482 | Ironhorse `WorkerEngine`: process, NDJSON request/reply, image copy, crank | ironhorse-runtime, ironhorse-limits, core errors, platform/timers | supervisor, `index.js` |
| `src/ironhorse/ironhorse-runtime.js` | 332 | lease helper, `runtime.json` manifest, private runtime copies | ironhorse-limits, store/versioned-record | ironhorse-engine |
| `src/ironhorse/ironhorse-limits.js` | 152 | limit parsing and canonical form | none | engine, runtime, supervisor |
| `src/ironhorse/xs-engine.js` | 214 | XS `WorkerEngine` (does not build here; architecture.md D-2) | core errors | `index.js`; 3 tests that skip |
| `src/ironhorse/inspect-ironhorse.js` | 41 | offline read of `runtime.json` and worker meta | none | `index.js`, demo script |
| `src/ironhorse/demo-*-vats.js` | 58 | demo sources | none | demo script, tests |
| `src/guest/prelude.js`, `guest.js` | 74 | the guest globals record and its type | control/names, small shared modules | worker-peer |
| `src/observable-map.js` | 299 | observable string-keyed map (shipped by source) | none | mail, control |
| `src/serial-queue.js`, `in-flight.js`, `random-id.js`, `describe-error.js`, `is-remotable.js` | 161 | small shared helpers | none | 3 to 8 source files each |
| `src/adapter-keeper.js` | 61 | a manager's hold on one adapter incarnation (shipped by source) | serial-queue | control/installer |

### The life cycle of a vat, and who owns each step [read]

| step | where | state touched |
|---|---|---|
| create | `daemon.allocateWorker` (566) then `provideWorkerSession` (240) builds a transport; the first frame wakes it and sends `init` (`ensureAwake`, transport 645-651) | daemon `workers`, meta (`debugLabel`, `ephemeral`, `allocationKey`) |
| deliver | hub `send`/`sendBatch` then `write`/`writeBatch` (transport 836, 865): journal, then `afterAppend` (757) queues a crank | journal, `held`, `heldStart`, `deliveredUpTo` |
| snapshot | cadence check in `afterAppend` (802-822) then `checkpointInternal` (910); Ironhorse closes the worker, hashes and copies the file, then relaunches it (ironhorse-engine 466-476) | meta `snapshot`, `outboundBase`, `hubDelivery`; journal truncation |
| sleep | idle timer (284), admin `sleep`, daemon `shutdown` (1099-1108) | `incarnation` |
| wake | `ensureAwake` (579) on a frame, admin `wake` (693), startup sweep in the **daemon** (867-914) | `incarnation`, `seenOutbound`, `stalled` |
| crash | `abandonIncarnation` (503), `noteCrash` (447), `armRetry` (387), `standDown` (717) | `stalled`, `retry`, `retriesArmed`, meta `crash` |
| halt or quarantine | `abandonIncarnation` and `noteCrash` write meta `failure`, then `onFatal` calls `hub.retireSession` (daemon 263); also daemon 288-289 at attach, transport 586-595 at wake | `givenUp`, meta `failure`, hub session retired |
| retire | `daemon.retireWorkerNow` (523) calls `transport.retire` (1000), then `forgetWorker` (516), then resource retirement, then native adapters | daemon `workers`, store, hub session, endpoint records |
| ephemeral discard | daemon startup (735-784), **bypassing the transport**: it releases the image itself | store, hub session |

What is engine-neutral and what assumes Ironhorse [read]:

- The transport and the daemon are neutral apart from three things. GC batching assumes
  `deliverBatch` (the fallback delivers the batch frame by frame). `acquireStore`, which the
  supervisor requires, is Ironhorse-only. The guest entry's `thixotropeTakeOutbound` latch assumes
  a bootstrap that defines it.
- `evaluate-source.js` is in `core` but its frame limit comes from an Ironhorse measurement.
- The XS engine lacks `acquireStore`, `deliverBatch` and `onOutboundBatch`, and does not build
  here.

Formats and who knows them [measured]:

- Journal entry `{ b64, hubSequence?, gc? }`: the transport only, which is good. Its typedef is at
  transport line 35.
- Duct envelope `{ t: 'init' | 'f', ... }`: 18 sites in 4 files with no shared definition
  (AR-CORE-5).
- Ironhorse request/reply (`deliver`, `eval`, `close`, `ready`, `result`, `error`, `fatal`):
  `ironhorse-engine.js` only, which is good.
- Hub persisted state: also read by `vat-reachability.js` and `daemon.js` (AR-CORE-8).

### Checks of the earlier surveys

- `survey-engine.md`:
  - Findings 3 and 4 hold at this base: the snapshot does close, hash, copy and relaunch
    (ironhorse-engine 466-476), and a journal entry holds the whole frame as base64 (transport
    738-747) [read].
  - Section 6 is right that the worker accepts a `timing` flag (`main.rs:842`). The JavaScript
    side never sets it (ironhorse-engine 413-418), so the option is unused from this side
    [measured].
  - Section 5.3 left open whether `globalThis.crypto` is reachable on Ironhorse. See AR-CORE-12.
- `survey-ocapn-hub.md` rows 70-71 (worker session attach flags, journal entry shape) match the
  code [read].

---

## Findings, by severity

### AR-CORE-1 (major; questions 1, 3, 4): the vat life cycle has no single owner or state machine

- **Where.**
  - Transport flags: `pkg/src/core/durable-worker-transport.js:200-243`.
  - "Given up" tests: transport 236, 586-595, 837, 866; daemon 288-289, 879, 895.
  - `onFatal` called at transport 478, 512 and 592.
  - Startup retry loop: `pkg/src/core/daemon.js:887-911`.
  - Ephemeral discard outside the transport: daemon 767-784.
- **What.** The life cycle (asleep, waking, awake, retry owed, given up, retiring, retired) is
  implicit in combinations of about ten mutable variables, one on-disk field (`meta.failure`)
  mirrored by an in-memory one (`givenUp`), and the daemon's `workers` map.
  - The transport has a recovery path for the mirror disagreeing (586-595: "On record without this
    transport knowing").
  - The daemon re-implements part of the transport's crash policy in its startup sweep: it
    classifies `WorkerHaltError` against `meta.failure`, `WorkerCrashError` against
    `maxDeliveryAttempts`, and loops on `wake`.
  - The ephemeral discard at startup releases the image itself, which is a third copy of the
    release logic (transport 942, 1009; daemon 773).
- **Evidence** [read, measured]:
  - The `failure` check appears 7 times in 2 files.
  - Image release appears 3 times in 2 files.
  - Open candidates that change this machine: C-8 (daemon loop), C-10 (break calls into a
    given-up vat), C-11 (reinstate: clear `failure` and also reset `givenUp`, the hub session and
    `stalled`), C-24 (cadence snapshot timing). Each touches both modules.
- **Smallest change.** Keep the policy and make it explicit:
  - The transport holds one `state` variable with a `transition(from, to)` helper that asserts
    the legal edges.
  - It exposes `state()`, `resume()` (the startup loop, moved from daemon 887-911) and
    `discard()` (the ephemeral path, using its own image release).
  - `givenUp` becomes `state === 'given-up'`. `write` and `writeBatch` read that state, not meta.
  - The daemon asks the transport and no longer reads `meta.failure`.
- **Size.** About 150-250 lines in 2 files, mostly moved.
- **Risk.** A transition missed in the rewrite. The safety net is strong:
  `durable-worker-crash-loop.test.js` (26 tests), `daemon-journal-recovery.test.js` and
  `durable-worker-session.test.js`. Do it before building C-11.

### AR-CORE-2 (moderate; question 5): a failed retirement that is retried skips its own cleanup

- **Where.** `pkg/src/core/durable-worker-transport.js:1000-1013`;
  `pkg/src/core/daemon.js:523-538`.
- **What.**
  - `retire()` sets `destroyed = true` before its queued work runs. If `terminate` or
    `releaseSnapshot` throws, the daemon puts the entry back so that "a caller ... retr[ies] the
    retirement" (daemon 530-533).
  - The retry calls `transport.retire()` again, which returns at once because `destroyed` is
    already true. The daemon then forgets the store. The image whose release failed is never
    released, because the record naming it has just been deleted.
  - Between the two calls, the "still listed" worker refuses every frame (`write` returns false on
    `destroyed`).
  - The comment promises a retry that the code cannot perform.
- **Evidence.** [read; inferred, not executed] No test injects a failure into `transport.retire`.
  The retirement fault test in `daemon-journal-recovery.test.js:144-191` injects one into the
  hub commit instead [read].
- **Smallest change.** Keep the retire promise, or set `destroyed` only after the queued work
  succeeds, so that a second `retire()` repeats the failed step. Add one test with an engine
  whose `releaseSnapshot` throws once.
- **Size.** About 10 lines in 1 file, plus a test of about 40 lines.
- **Risk.** Low. The retire paths in `daemon.test.js` and `collectVats` cover the success case.

### AR-CORE-3 (moderate; question 4): one word for several things, and the design's vat/worker split is lost

- **Where and what** [read, measured]:
  - **crash** has three meanings:
    - `WorkerCrashError`, a process that died unexplained.
    - `transport.crash()` (transport 988-995), documented as "Simulate worker-process death" but
      used by `stopDaemon` (daemon 850) as the real way to stop every incarnation.
    - `daemon.crash()` (daemon 1115), stop without snapshots, which the supervisor calls on a
      fatal path (`control/supervisor.js:1118`).
  - **retire** has two meanings: delete a vat for good (`transport.retire`, `retireWorkerNow`),
    and `hub.retireSession` on a halt (daemon 263), which quarantines a vat that stays listed and
    stored. `retireResource` and the keeper's `retire` are a third and fourth use, each sensible
    on its own.
  - **The quarantined state** has five names: `failure` (meta), `givenUp` (memory), "quarantined"
    (log text), "fatal" (`onFatal`) and "halt" (the error that usually causes it). The design
    says "quarantines the vat" (`designs/thixotrope.md:182`).
  - **vat and worker**:
    - The design's vocabulary separates a vat (one guest heap), the worker that runs it, and an
      incarnation (one process).
    - The code says worker for the vat: 264 occurrences of `worker*` against 13 of `vat*` in
      `daemon.js`, and 111 against 0 in the transport.
    - The same id is a `workerId` in `inspectVatReachability` and in `collectVats`, which returns
      "vats".
  - **The endpoint is a pseudo-worker.**
    - `ENDPOINT_ID = 'e'.repeat(32)` (daemon 146) is a valid worker id, stored under
      `workers/`. So every enumeration must filter it out: daemon 737 and 788.
    - `inspect-ironhorse.js:30` does not filter it, and lists the endpoint as a worker.
    - The records module is named `makeWorkerSessionRecords`, with `registerWorkerConnection` and
      `restoreWorker`, but the endpoint is its only user (`resumedByWorkerId` has one key).
- **Smallest change.**
  - Rename `transport.crash` to `terminate` and fix its comment.
  - Rename `hub.retireSession` on the fatal path to a quarantine verb, or document the two senses
    in the glossary.
  - Settle "quarantine" as the one word, with `failure` as its recorded reason.
  - Rename the records module to endpoint records and drop its per-worker maps (AR-CORE-13).
  - Add glossary rows to the design for crank, journal, cut, image (or snapshot: pick one; the
    design says "sleep image", the code `snapshot`) and quarantine.
  - Renaming worker to vat in identifiers is a large, low-value change. Instead, state in the
    design that `workerId` names the vat.
- **Size.** Renames about 60 sites in 6 files. The glossary is about 10 lines.
- **Risk.** Mechanical. `daemon.crash` is used by the supervisor and by tests, so keep that name
  or alias it.

### AR-CORE-4 (moderate; questions 1, 3, 4): the Ironhorse guest entry is named and documented as XS, and the XS engine is presented as supported

- **Where.**
  - `pkg/src/core/worker-peer-xs.js:1-21`, whose header says "evaluated inside the XS machine by
    the `thixotrope-xs-worker` binary".
  - `pkg/scripts/bundle-ironhorse-worker.mjs:59` bundles that same file for Ironhorse.
  - `pkg/src/ironhorse/xs-engine.js` lives in the `ironhorse` directory and is exported from
    `pkg/index.js:11`.
  - `designs/thixotrope.md` ("Ironhorse and XS implement this interface").
- **What.**
  - The one bootstrap that every production vat runs carries the name of the engine that does not
    build here (architecture.md D-2).
  - The XS engine lacks `acquireStore`, which the supervisor requires, and lacks `deliverBatch`
    and `onOutboundBatch`. So it cannot run the daemon as composed.
  - Its 3 test files skip when the binary is absent [measured].
  - `test:xs` is `exit 0` (`pkg/package.json:44`) [read].
- **Smallest change.**
  - Rename `worker-peer-xs.js` to an engine-neutral name (for example `worker-bootstrap.js`) and
    rewrite its header for both engines.
  - Move `xs-engine.js` to `src/xs/`, or delete it with its skip-only tests.
  - Change the design table to "Ironhorse implements this interface; an XS engine exists but is
    not composed".
- **Size.** 1 rename, 2 script paths, about 15 lines of documentation. Deleting XS removes about
  820 lines: 214 of source and 610 of skip-only tests [measured].
- **Risk.** The bundle scripts' paths. The Ironhorse lane catches a wrong bundle at once.

### AR-CORE-5 (moderate; question 2): wire shapes hand-coded at many sites, including one that `@endo/ocapn` already provides

- **Where.**
  - Duct envelope: transport 531, 553-561, 618, 650; `peer-replay-engine.js` 62-87;
    `worker-peer-xs.js` 108-133; `ironhorse-engine.js` 443, 458.
  - Slot strings: `daemon.js:345-354`; `worker-session-records.js:239, 282-283, 317, 436, 445,
    456, 466`; `vat-reachability.js:68`.
- **What and evidence** [measured]:
  - The `{ t: 'init' | 'f' }` envelope appears at 18 sites in 4 files. `WorkerEngine` types it as
    `Record<string, unknown>`.
  - The transport decodes outbound envelopes on two paths with different validation:
    `processOutboundEnvelope` (527-540) uses `Fail` and does not check that `b64` is a string; the
    batch closure (615-630) uses `makeError` and does check it.
  - OCapN slot strings (`o+N`, `p+N`, `a-N`, `o-N`, `+0`) are parsed with `slot[0]`,
    `slot.slice(2)` and `startsWith` at 11 sites. `@endo/ocapn` has `parseSlot` and `makeSlot` in
    `packages/ocapn/src/captp/pairwise.js:34-52`, but its `exports` map does not publish them.
- **Smallest change.**
  - Add a `duct.js` with typed `initEnvelope`, `frameEnvelope` and `decodeFrameEnvelope`, used by
    all 4 files and by one outbound path in the transport.
  - Export `parseSlot` and `makeSlot` from `@endo/ocapn` (for example `./client/util`), or add a
    5-line local `slot.js`.
- **Size.** About 80 lines across 6 files, plus 1 export line in `ocapn`.
- **Risk.** Low. Replay determinism is unaffected, since the bytes do not change.
  `worker-peer.test.js` and `durable-worker-session.test.js` cover the paths.

### AR-CORE-6 (moderate; question 3): optional seams with one used path each, so production and the test doubles take different paths

- **Where.**
  - Transport `writeBatch` 884-895 (`appendJournalEntries` optional).
  - `deliverCrank` 550-564 (three paths).
  - `onFrame` required and `onFrames` optional (144-148, 527-540 against 612-630).
  - `ironhorse-engine.js:291, 362-364, 409-428` (`combinedDelivery`).
  - `releaseSnapshot` optional, checked at 3 sites.
  - `hubStoreStats` optional (daemon 224-226).
- **What and evidence** [measured, read]:
  - Both stores implement `appendJournalEntries` (`store-fs.js:199`, `store-memory.js:47`), so
    the per-entry fallback has no source user.
  - Production Ironhorse always offers `deliverBatch` and `onOutboundBatch`. Neither replay double
    offers them, and 29 test files import the doubles. So the bulk of daemon tests run the
    frame-by-frame crank path and the single-frame outbound path, which production never takes.
    The batch paths are covered only by `worker-gc-cranks.test.js` (a model engine) and the
    Ironhorse lane.
  - The worker always advertises `deliver-v1` (`rust/thixotrope-ironhorse-worker/src/main.rs:778`;
    also the stand-in fixture). The two-`eval` path for a worker without it has no test.
- **Smallest change.**
  - Make `appendJournalEntries`, `deliverBatch` and `onOutboundBatch` required: the doubles
    implement them as loops, about 15 lines.
  - Drop `onFrame` and `processOutboundEnvelope`.
  - Either delete the `combinedDelivery` branch, or keep it only while a state directory made
    before `deliver-v1` must still open, and then give it a stand-in test.
- **Size.** About 60 lines removed in 3 source files and about 15 added to the doubles.
- **Risk.** The `WorkerEngine` contract says an engine "either always offers [deliverBatch] or
  never does", and the journals of old double-engine runs exist only in tests. Lane tests in
  `test/ironhorse/_fixture.js:144-155` wrap `deliverBatch` optionally and need the same edit.

### AR-CORE-7 (moderate; questions 1, 2): `buildDaemon` is one 936-line closure with about twelve jobs, and it knows native-resource details

- **Where.** `pkg/src/core/daemon.js:183-1118`. Notable points:
  - Endpoint bootstrap introduction written 3 times: 422-433, 694-701, 1063-1068.
  - `logging.sub('thixotrope', 'daemon')` made inline 5 times (545, 709, 779, 908, 928) beside a
    separate verbose-only `log` (205-211).
  - `sweepBundles` (1001-1018) reads endpoint export records for `'native-adapter'` and takes the
    binding key as a bundle digest.
- **What.**
  - The jobs: hub wiring, worker table, endpoint session, resource registry and binding
    canonicalization, start notices, retirement, allocation, the 8-step startup sequence,
    shutdown, transient clients, bundle sweep, reachability and collection.
  - Order dependencies are stated in comments but enforced only by line order. Examples: "Seat the
    endpoint's recorded exports before accepting any retained hub output" (762), and "named before
    this one can seat any of its own" (813).
  - `store.provideWorkerStore(id).getMeta()` is called 15 and 17 times [measured].
  - Callers in `control` test membership as `daemon.listWorkerIds().includes(id)` at 6 sites
    [measured], which sorts an array per test.
  - Also: `makeThixotropeDaemon.inspectWorkers` reads `options.store` (1179), bypassing the
    ownership guard built at 1137-1154. The `ThixotropeDaemon` typedef's lines for `inspectHub`
    and `inspectGc` are interleaved (127-132) [read].
- **Smallest change.** Behaviour-neutral moves:
  - A `worker-table.js` with `provideWorkerSession`, `allocateWorker`, `retireWorkerNow`,
    `forgetWorker` and the ephemeral discard.
  - A `start-notices.js` with set, withdraw, deliver-at-start and exit notice.
  - One `importBootstrapOf(sessionKey)` helper.
  - One `daemonLog` constant.
  - Move `sweepBundles` into `native/adapters.js`, which owns the launcher key.
  - Add `hasWorker(id)`.
  - The startup sequence stays in `buildDaemon` as a numbered list of calls.
- **Size.** About 400 lines moved into 2 to 3 new files. About 30 lines change.
- **Risk.** Low, with no behaviour change. 27 test files import the daemon.

### AR-CORE-8 (moderate; question 1): other modules' private persisted formats read outside their owners

- **Where.**
  - `pkg/src/core/vat-reachability.js:51-150` reads `hubState.refs`, `sessions[*].answersOwed`,
    `gifts`, `giftWaiters`, `publications`, and the row fields `origin`, `backing`, `flavor`,
    `refcounts`, `listeners`, `dead`, `resolver`. It also hard-codes the strings `'endpoint'` and
    `'worker-facade'`.
  - `daemon.js:816-818` reads hub session keys for the `transient:` prefix.
  - `pkg/src/ironhorse/ironhorse-runtime.js:262-277` checks for the store's `hub.json`,
    `hub-image.json` and `workers/`.
  - `pkg/src/ironhorse/inspect-ironhorse.js:27-36` reads `workers/<id>/meta.json` directly.
- **Evidence.**
  - [measured] CC-025 (`72ef46f905`, the hub log) had to edit `ironhorse-runtime.js` to learn
    `hub-image.json`: an engine module changed for a store-format change.
  - [read] `vat-reachability.test.js` (301 lines) builds hub-state literals by hand, so a hub
    schema change can leave reachability silently wrong while its tests still pass.
- **Smallest change.**
  - The hub exports `reachabilityEdges()` (holders, targets, kinds, roots) and `sessionKeys()`.
    The reachability module consumes those edges.
  - The store exports `hasState()` for the runtime's "unversioned state" check, and
    `listWorkers()` with meta for inspection.
- **Size.** About 150 lines across hub, store, reachability and runtime.
- **Risk.** Moderate. Reachability decides `collectVats`, which deletes vats. Keep the existing
  tests, and add one that builds state through a real hub.

### AR-CORE-9 (moderate; question 5): worker meta is a shared, uncached bag that two modules read-modify-write, read from disk per frame

- **Where.**
  - Writers: daemon 451-471 and 586-594; transport 367-377, 463, 510, 934-939.
  - Readers on the hot path: transport `write` 837 and `writeBatch` 866.
  - Keyed allocation scans every worker's meta: daemon 575-583.
  - `pkg/src/store/store-fs.js:60-65, 186`: `getMeta` is `exists` plus `readText` plus
    `JSON.parse`, with no cache.
- **What.**
  - One record mixes identity (`debugLabel`, `ephemeral`, `allocationKey`), daemon policy
    (`startNotify`), checkpoint (`snapshot`, `outboundBase`, `hubDelivery`) and life cycle
    (`crash`, `failure`).
  - Each writer spreads `{ ...store.getMeta(), ... }`. That is safe only because all writes are
    synchronous in one process, and nothing states this.
  - Every frame toward a vat costs a synchronous file read and parse to learn whether `failure` is
    set, which the transport already knows as `givenUp`.
- **Evidence.** `getMeta()` is called 17 times in the daemon and 11 in the transport
  [measured]. The per-frame cost is 2 syscalls plus a parse [inferred]. It was not measured; the
  hub-commit costs of C-2 and C-20 dominate today.
- **Smallest change.**
  - The transport answers `write` from its own state (AR-CORE-1).
  - The fs worker store caches meta in memory: it is the only writer within a process.
  - The daemon keeps an in-memory `allocationKey` to id index.
  - Later, split identity (write-once) from checkpoint and life-cycle records.
- **Size.** About 30 lines for the cache and index.
- **Risk.** Low. The store tests (`worker-store-journal.test.js`) and the crash-loop tests that
  inject meta-write failures cover the paths.

### AR-CORE-10 (minor; questions 1, 2): `evaluate-source.js` in `core` knows the Ironhorse frame cost and its callers' names

- **Where.** `pkg/src/core/evaluate-source.js:5-21, 40-44`.
- **What.**
  - `STAGING_FRAME_BYTES` is an Ironhorse measurement: spike S1 of M0. It is a second copy of the
    harness's `frameBytes`, already filed as C-13.
  - The `slot` option is typed as a union of three names that belong to `control` and `mail`
    callers.
  - Its only importers are the 3 `control` files [measured].
- **Smallest change.**
  - Move the module to `control/`.
  - Type `slot` as a `thixotrope.`-prefixed string.
  - Take the frame bound from the engine's limits, which closes C-13.
- **Size.** About 20 lines in 4 files.
- **Risk.** Low. `evaluate-source.test.js` covers it.

### AR-CORE-11 (minor; question 3): test doubles, demos and misplaced modules in `src`

- **Where.**
  - `pkg/src/core/peer-replay-engine.js`: 0 source importers, 29 test importers [measured].
  - `pkg/src/ironhorse/demo-counter-vats.js` and `demo-promise-vats.js` serve scripts and tests
    only.
  - `pkg/src/ironhorse/ironhorse-runtime.js:27-28`: `hashFile` is a one-line re-export of
    `hashes.sha256File`.
  - `pkg/src/adapter-keeper.js` is a native manager's shipped factory at the `src` root.
  - `pkg/src/guest/prelude.js:13` imports `control/names.js`, an upward edge.
- **Smallest change.**
  - Move the doubles to `test/_peer-replay-engine.js` and the demos beside the demo script.
  - Inline `hashFile`.
  - Move the keeper to `native/`.
  - Move the two name validators to a neutral `src/names.js` that both `guest` and `control`
    import.
- **Size.** Moves only, in about 35 import lines.
- **Risk.** None beyond paths.

### AR-CORE-12 (minor; question 5): error-handling corners

- **Where and what.**
  - `durable-worker-transport.js:510`: the halt branch of `abandonIncarnation` calls
    `store.setMeta` unguarded. A store fault there replaces the halt with the store error, and
    `onFatal` is skipped. `noteCrash` guards the same write (462-471) [read]. The next wake
    recovers through 586-595, so the effect is a mislabelled error, not a lost quarantine
    [inferred].
  - `worker-engine.js:59`: `WorkerHaltError` is not hardened and lives in the types module, while
    `WorkerCrashError` has its own hardened module [read]. Put both in one `worker-errors.js`.
  - `worker-peer-xs.js:39, 48-49`: the entry captures `globalThis.crypto` at load. The Ironhorse
    boot bundle has no `crypto` (0 occurrences in `dist-ironhorse/boot.js` [measured]). So any
    in-vat `randomBytes` call fails with a `TypeError` about `getRandomValues` of `undefined`, not
    a named refusal [inferred]. Whether OCapN calls it inside a vat (gifts, keys) was not checked.
    This is the open question of survey-engine 5.3. Replace it with an explicit
    `randomBytes: () => Fail\`no entropy in a vat\`` where `crypto` is absent.
- **Size.** About 15 lines.
- **Risk.** Low.

### AR-CORE-13 (minor; questions 2, 3): the endpoint records are generic over workers, and repeat key and tombstone logic

- **Where.** `pkg/src/core/worker-session-records.js`:
  - Maps keyed by worker: 79, 87.
  - `retireResourcesWhere` loops over them: 182.
  - Three tombstones: `unrestorablePromise` 115-122, `SessionInternalTombstone` 218,
    `UnrestorableExport` 439.
  - The key is made by `JSON.stringify` at 142 and compared again at 384-388.
  - Daemon `canonicalBinding` (489-508) exists so that these strings match.
- **What.**
  - The module serves one session (AR-CORE-3), but keeps per-worker maps and a connection-to-worker
    WeakMap.
  - Resource identity is a JSON string whose stability depends on the field order that
    `canonicalBinding` produces.
  - Each export or resolver event rewrites the whole tables record (`updateTables` 131-136). That
    is O(records) per event, and it is the "endpoint commits per frame" part of C-20 [read].
- **Smallest change.**
  - Specialise the module to the endpoint and drop the two maps.
  - Make one `resourceKey(name, binding)` that canonicalises inside the module, so the daemon's
    `canonicalBinding` only validates.
  - Use one tombstone factory.
  - Leave the per-event rewrite to C-20's fix.
- **Size.** About 60 lines in 2 files.
- **Risk.** Low. `worker-session-records.test.js` (6 tests) and `resource-answer-gc.test.js`
  cover it.

### Smaller notes, not findings

- `collectVats` (daemon 1074-1091) recomputes the whole reachability graph before every
  retirement. That is O(vats × graph), which is fine at today's sizes and a correct choice for
  safety [read].
- `shutdown` puts vats to sleep one at a time (1099-1108). Shutdown time grows with the number of
  awake vats. That may be deliberate (memory), but nothing says so [read].
- `observable-map.js` is clean: bounded coalescing, at most one notification outstanding per
  listener, and a reverse index. Keep it [read].

---

## What I did not cover

- The hub (`src/net/**`), the store (`src/store/**`), `control`, `native`, `mail`, `web` and
  `tui`, except where the daemon calls them. Other units review those.
- The Rust worker and engine, beyond confirming the `deliver-v1` and `timing` facts above.
- Whether OCapN calls `randomBytes` inside a vat (AR-CORE-12).
- The test suites' content beyond titles and the import counts above. No test was run, and
  AR-CORE-2's failure path is reasoned, not reproduced.
- Performance. No number here is new. The meta-read cost in AR-CORE-9 is inferred.
- Literal duplicate blocks: a 5-line-window scan of the 26 files found only the option lists
  repeated in `ironhorse-engine.js:59-79` [measured]. The repetition in this area is structural
  (the same rule written in a different shape), which is what AR-CORE-1, -5, -7 and -13 report.
