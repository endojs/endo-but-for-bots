# Architecture review AR-NET: the hub, the network layers and the stores

Unit: AR-NET of the core architecture review. Scope: `packages/thixotrope/src/net/**` and
`packages/thixotrope/src/store/**` with their tests; read-only. Started 2026-11-18T12:07:16Z.

Evidence labels: **[read]** I read the code at the cited lines; **[measured]** a script counted it
(scratch scripts outside the repository; method given in place); **[inferred]** my reasoning from
what I read. `pkg/` is `packages/thixotrope/`, `H/` is `packages/thixotrope-harness/`. The surveys
`H/designs/spike-dataref/survey-ocapn-hub.md` (S2) and `survey-engine.md` were reused, not repeated;
where this review relies on S2 it says so, and S2's statements that I re-read against the code
(sections 2, 3.2, 4.1, 4.2, 7) hold at this snapshot.

---

## 1. Summary (one page)

The area is about 6,100 lines of source (`net/` 4,858, `store/` 1,219) [measured: `wc -l`].
`hub.js` alone is 2,803 lines. Its dependency direction is clean: the hub imports only
`@endo/*` packages, `describe-error.js` and its own state codec; transports, identity, clock,
store and dialing are injected [measured: import graph]. Most of the complexity is not in the
routing core but around it: how a session's outbox behaves, gifts, diagnostics, and three
encodings of "what kind of session is this".

**The three things most worth changing**

1. **Make retirement one commit** (AR-NET-1). `retireSessionInternal` sends and commits partial
   results (resolver breaks, then GC frames) before it rewrites answer routes and marks the session
   retired. A crash in between leaves a bumped epoch with `retired: false`, and the peer startup
   reconciliation then skips the session for good. The fix is about ten lines: hold
   `deliveryDepth` across the body, commit once, then flush.
2. **One model of session kind, and the outbox modes that follow from it** (AR-NET-3). Today a
   session's class is a key prefix (14 `startsWith`/template sites in 4 files), seven attach flags
   with five coupling rules, and three outbox loops (111 lines). Production uses four combinations.
   A session kind chosen by the embedder would replace all three. This is also the natural seam for
   splitting `hub.js` (AR-NET-8).
3. **Stop using the persisted hub state as an interface** (AR-NET-2). Vat GC
   (`core/vat-reachability.js`) parses the hub's serialized tables from the store. Meanwhile
   `hub.inspect()`, documented as "the reachability graph for vat-level GC", is called only by
   tests. Any change to the row format, including the open part of C-2 that M3/M4 must make
   (CC-051, CC-060), therefore has to change vat GC in lockstep.

**The three things most worth keeping**

1. **The non-reifying hub with a rollback ledger** (`withRollback`, `pkg/src/net/hub.js:332-351`).
   Decode, route and encode either all happen or leave no rows. Nothing promise-shaped lives in the
   supervisor. Every injected power is explicit.
2. **`hub-log-store.js`**: a precisely specified write-ahead log with a torn-tail rule, recovery
   from every prefix, and migration. It is tested exhaustively (every byte prefix, faults at every
   write) and by `hub-crash-consistency.test.js` (SIGKILL at random commit points). It is the
   right machinery to reuse for peer session records (AR-NET-6).
3. **The layered netlayer**: `durable-netlayer.js` (versioned envelope, sequence and acceptance
   watermarks, retire handshake) over a stateless `unix-netlayer.js` (fragment framing,
   private-directory and path-length checks), with every platform power injected. The protocol is
   small and its states are explicit.

Counts: 3 major, 9 moderate and 6 minor findings. One major is PLAUSIBLE (crash timing, not
reproduced).

---

## 2. Map of the area

### 2.1 Modules

| module | lines | job | imported by (src) | direct tests |
|---|---|---|---|---|
| `net/hub.js` | 2,803 | OCapN forwarding node: c-lists, answer routes, outboxes, gifts, retirement, diagnostics | `core/daemon.js` | 12 files |
| `net/hub-state.js` | 166 | hub tables to one plain record and back (version 2) | `net/hub.js` | 1 |
| `net/peer-sessions.js` | 588 | OCapN handshake both ways, hub binding of netlayer connections, durable session records (`resumption`) | `core/daemon.js` | 0 (daemon-level only) |
| `net/durable-netlayer.js` | 580 | resumable logical connections over a base transport: envelope v2, seq/ack, retire | `control/supervisor.js` | 7 |
| `net/unix-netlayer.js` | 251 | private Unix socket transport, 1 MiB fragments | `control/supervisor.js` | 2 |
| `net/pipe-network.js` | 255 | handshake-free OCapN network for a host-worker duct, derived identities | `net/in-process-session.js`, `core/worker-peer.js`, `platform/node/adapter-process-entry.js`, `control/local-control.js` | 6 |
| `net/in-process-session.js` | 121 | an in-process OCapN client whose one session is a hub session (endpoint, transient client) | `core/daemon.js`, `net/transient-hub-client.js` | 0 |
| `net/transient-hub-client.js` | 94 | disposable host observer | `core/daemon.js` | 1 |
| `store/store.js` | 120 | types: `ThixotropeStore`, `WorkerStore`, `SessionStore` | 8 modules | 1 |
| `store/store-fs.js` | 346 | filesystem store: worker meta/tables/journal, session records, bundles, hub state (log or file) | `control/supervisor.js` | 28 |
| `store/hub-log-store.js` | 509 | hub state as image plus delta log | `store/store-fs.js` | 1 |
| `store/store-memory.js` | 128 | in-memory store for tests | none in src | 12 |
| `store/store-validators.js` | 62 | worker id, session token and digest shapes | peer-sessions, store-fs, store-memory | 0 |
| `store/versioned-record.js` | 24 | the one version check | hub-state, ironhorse-runtime, supervisor, installation-index | 0 |
| `store/sync-string-atom.js`, `file-sync-string-atom.js` | 30 | a durable string slot | control | 1 |

Direction [measured: grep of `from '...'` per file]: `net/` imports `store/` types and validators,
`platform/` types, `random-id.js` and `describe-error.js`. It imports nothing from `core/`, `control/`,
`native/` or `mail/`, and `store/` imports nothing from `net/`. There are no cycles. The one
dependency against the grain runs the other way: `core/vat-reachability.js` reads `net`'s
persisted format (AR-NET-2).

### 2.2 `hub.js` by job [read; line ranges]

| lines | job | size |
|---|---|---|
| 1-160 | header, `HubStore` type, in-memory default store, `makeGcFrameTest` | 160 |
| 161-308 | options, row/route/session typedefs, the five tables | 148 |
| 310-351 | rollback ledger | 42 |
| 353-447 | GC counting and outbound GC batching, inbound drains | 95 |
| 449-565 | cost counters | 117 |
| 567-699 | persist, session provisioning, `remoteSessionKey`, restore | 133 |
| 701-901 | rows, tokens, pins and release | 201 |
| 903-1131 | per-session codec kit (the table-backed reference kit) and facing positions | 229 |
| 1133-1337 | outbox: sequences, `dispatchBytes`, `flushOutbox` (three modes), `sendMessage` | 205 |
| 1339-1502 | resolver settlement, break to sender, outbound gift withdrawals | 164 |
| 1504-1786 | bootstrap: `fetch`, `deposit-gift`, `withdraw-gift` | 283 |
| 1788-2211 | routing: `resolveTarget`, `forwardToRow`, `handleMessage`, `frameError` | 424 |
| 2213-2338 | retirement | 126 |
| 2340-2803 | public API (`attachSession` alone 202) | 464 |

Grouped by concern: the routing core (rows, kits, routing, settlement, fetch) is about 1,200 lines.
Third-party gifts in both roles (provideHandoff, withdrawals, deposit/withdraw, dial bookkeeping)
are about 460. Outbox modes and delivery batching are about 400. Process-local diagnostics are
about 235. Retirement is 126 [read; counted by range].

### 2.3 Session kinds in production [read]

| who | key | attach options | outbox path |
|---|---|---|---|
| worker (`core/daemon.js:272`) | worker id | `send`, `sendBatch`, `durable`, `requireAcceptance`, `deferCleanup` | batch (`sendsInBatches`) |
| native adapter (`native/adapters.js:211`) | `transient:native:<hex>` | `discardOnRestart`, `coalesceInbound`, `onAbort` | disposable |
| transient client (`net/transient-hub-client.js:64`) | `transient:<hex>` | same as adapter | disposable |
| endpoint (`core/daemon.js:765`) | `endpoint` | none (`durable: false`) | single frame |
| remote peer (`net/peer-sessions.js:62`) | `peer:<token>`, `handoff:<hex>` | `durable` (from the prefix), `requireAcceptance` (from a resume token), `remote`, `onAbort`, `identity` | single frame with acceptance |
| remote peer without a resume token | `transient:<hex>` | `remote` | single frame; **tests only** (production always wraps the Unix layer in the durable netlayer, `control/supervisor.js:449-468`) |

---

## 3. Findings, in severity order

### AR-NET-1 (major, Q5, PLAUSIBLE): retirement commits and sends in pieces, and a crash between pieces is never completed

- **Where**: `pkg/src/net/hub.js:2223-2338` (`retireSessionInternal`), `:2268-2280` (resolver breaks
  via `settleToResolver`), `:2286-2294` (`withGcBatch`, flushed at `:410-416`), `:2304-2337`
  (answer routes, `retired = true`, the final `persist()`); `:2663-2675` (`retireSession` with
  `expectedEpoch`); `pkg/src/core/daemon.js:806-811` (startup reconciliation of retired peers).
- **What** [read]: on the public path `deliveryDepth` is 0. Each `settleToResolver` and each GC
  batch flush goes through `sendMessage` -> `dispatchBytes` -> `flushOutbox`, which calls
  `persist()` and then sends (`:1222`, `:1263`, `:1287`). So the epoch bump and the tombstones are
  committed, and frames are on the wire (for a worker, fsynced into its journal), before the
  answer-route rewrite and `session.retired = true` are committed at `:2337`.
- **Failure** [inferred]: SIGKILL after a GC flush and before `:2337`. On restart the state has the
  new epoch, `retired: false`, and the routes into the retiree are still pinned. For a peer, the
  daemon calls `retireSession(key, meta.hubEpoch)` with the old epoch (`daemon.js:810`). The epoch
  check at `hub.js:2666-2672` sees a mismatch, only persists, and returns. The remaining cleanup
  (routes to tombstones, the `retired` flag) never runs. The comment at `:2295-2303` says these
  routes otherwise "persisted for good". For a worker retired by `onFatal`, the startup call has no
  epoch, so the retirement runs again and bumps the epoch a second time. That second bump is
  harmless but not intended (`local-delivery.test.js` "does not advance the epoch twice" covers
  the commit-failure case, not this crash point).
- **Smallest fix**: run the body of `retireSessionInternal` with `deliveryDepth += 1` (as
  `deliverFrame` and `flushPendingWithdraws` do), then `persist()` once, then flush every outbox.
  This is the "commit before wire" rule the module header states for deliveries.
- **Size**: about 10 lines in 1 file, plus one crash test in `_hub-crash-child.mjs` (kill between
  flush and final commit).
- **Risk**: the order of frames toward other sessions within one retirement is unchanged. Only
  the commit point moves. Tests: `hub.test.js` (three retirement tests), `local-delivery.test.js`,
  `hub-gc-batch.test.js`, `hub-crash-consistency.test.js`.

### AR-NET-2 (major, Q1/Q4): vat GC reads the hub's persisted format; `hub.inspect()` is unused

- **Where**: `pkg/src/core/vat-reachability.js:25,53-140` reads `hubState.publications`, `.refs[*]`
  (`origin`, `dead`, `resolver`, `backing`, `flavor`, `position`, `refcounts`, `listeners`),
  `.sessions[*].durable`, `.sessions[*].answersOwed` and `.gifts`. `pkg/src/core/daemon.js:954`
  passes `store.getHubState()`, and `:816-818` reads `store.getHubState().sessions` for the stale
  transient sweep. `pkg/src/net/hub.js:2779-2800` defines `inspect()`.
- **Evidence**: `hub.inspect` has 0 uses in `src` and 4 in tests [measured: grep]. The two models
  also disagree. `inspect` omits listeners, answer routes, gifts and durability, while
  vat-reachability counts listeners as strong edges ("Active listeners are strong callback
  obligations") [read].
- **Why it matters**: the serialized record becomes an undeclared contract between
  `net/hub-state.js` and `core/`. The open part of C-2 (per-row dirty tracking; M3's CC-051 and
  M4's CC-060, which m0-results says "change the same row format and are to be one core change")
  must also change vat GC. Every collection reads the last committed state rather than the live
  tables, and with the log store that is a full `JSON.parse(stateText(image))` of the image
  (`hub-log-store.js:457-460`) [read].
- **Smallest fix**: grow `hub.inspect()` into the graph vat-reachability needs (rows with origin,
  holders, listeners, answer-route pins, gifts, publication roots, session durability) as plain
  data. Pass that to `inspectVatReachability` and delete its parsing of the state. Read the stale
  transient keys from a hub method (`hub.sessionKeys()`), not from the store.
- **Size**: about 80 lines in 3 files (`hub.js`, `vat-reachability.js`, `daemon.js`).
- **Risk**: vat GC decisions. Covered by `vat-reachability.test.js` (301 lines) and the
  `daemon.test.js` sweep test. Run both before and after with the same fixtures.

### AR-NET-3 (major, Q3/Q4): the session's kind is encoded three ways, and the outbox has three loops

- **Where**: key prefixes at `hub.js:674,682,2405`, `peer-sessions.js:71,99,106,384,393,494,572`,
  `daemon.js:810,818`, `native/adapters.js` (14 sites in 4 files) [measured: grep]. Attach flags and
  their five `Fail` coupling rules at `hub.js:2383-2423`. The outbox at `hub.js:1135-1313`:
  `discardOnRestart` (`:1217-1250`), batch (`:1251-1280`) and single-frame (`:1281-1305`), each with
  its own commit and acceptance rules.
- **Evidence** [read]: seven attach options (`durable`, `requireAcceptance`, `deferCleanup`,
  `discardOnRestart`, `remote`, `sendBatch`, `coalesceInbound`). Production uses four combinations
  (table 2.3). One more exists only for tests. `durable` is computed from the key prefix in
  `peer-sessions.js:70-71`, so the prefix and the flag carry the same fact. The design
  (`designs/thixotrope.md` glossary, "session") defines durable versus transient sessions by owner
  and the `transient:` prefix. It also lists the endpoint as a durable session, but the endpoint
  attaches with `durable: false` (`daemon.js:765`). The code adds the names "ephemeral session"
  (`hub.js:69`), "disposable observer" (`:2360`) and "legacy ephemeral adapters" (`:1295`; no such
  adapters exist: adapters are disposable observers).
- **Smallest fix**: one `kind` per attach, `'journal'` (worker), `'observer'` (adapter, transient
  client), `'peer'` (resumable remote) or `'local'` (endpoint), each mapped once to its outbox
  strategy and abort policy. `flushOutbox` then dispatches on the kind. Peer-sessions, adapters and
  the daemon pass a kind instead of computing flags from prefixes. Prefix checks remain only where
  a key is parsed from storage (the stale-transient sweep), and that can become a persisted `kind`
  in the session row. This follows the owner's principle of passing objects, not names.
- **Size**: about 150-200 lines in 5 files (`hub.js`, `peer-sessions.js`, `daemon.js`,
  `native/adapters.js`, `transient-hub-client.js`). Also a state version 3 if the kind is persisted.
- **Risk**: outbox ordering and replay identity. Covered by `hub-outbox.test.js`,
  `hub-disposable-outbox.test.js`, `hub-coalesce.test.js`, `hub-gc-batch.test.js`,
  `local-delivery.test.js`, `hub-crash-consistency.test.js`. These tests already name each mode's
  contract, so they can be kept unchanged as the oracle.

### AR-NET-4 (moderate, Q2/Q5): session private keys are persisted twice, and re-appended to the hub log at every commit that touches the session

- **Where**: `hub.js:2424-2431` (identity with `selfPrivateKey` hex in the session row),
  `hub-state.js:67` (serialized with the row); `peer-sessions.js:126-137` (`selfPrivateKeyB64` in the
  session record, plus `pendingPrivateKeyB64` at `:191`).
- **Evidence** [measured]: a scratch hub over `makeHubLogStore` and in-memory files, one peer session
  with a 32-byte key, 200 `introduce` calls toward it. That gave 201 log appends, 200 copies of the
  key's hex in the log, and 435,075 log characters. The append size grew from 738 to 3,718
  characters, because the session entry (with `ourExports`) is rewritten whole at each delta. This
  is the open part of C-2, and here it carries the key with it. The state directory is 0700
  (`control/supervisor.js:224`), so this is not an exposure today [read]. But the key's copies are
  bounded only by compaction, and the same key is also in `sessions/<token>/meta.json`.
- **Smallest fix**: move `identity` out of the session row into its own top-level table
  (`identities`), written when it changes, so `deltaOf` emits it once. Better still, give the hub
  the signing key at attach from the session record (the hub already receives it there) and do not
  persist it in the hub at all.
- **Size**: about 20 lines (`hub.js`, `hub-state.js`), state version 3.
- **Risk**: gift signing after restart. Covered by `remote-delivery.test.js`,
  `remote-process-delivery.test.js` and the hub gift tests (`hub.test.js` "interrupted gift
  redemptions").

### AR-NET-5 (moderate, Q5): retired peer sessions are retained forever, in four places

- **Where**: `peer-sessions.js:567-573` (`onEnd` marks the record retired; nothing deletes it; the
  store has no `deleteSession`, `store.js:105-120`); `hub.js:2223` (retire, not forget, for `peer:`
  and `handoff:` keys; only `transient:` keys are forgotten at `peer-sessions.js:384-388`);
  `durable-netlayer.js:113-121` (`sessions`, `retired` never pruned; only `restore`'s failure path
  deletes, `:358`); `durable-netlayer.js:553` and `daemon.js:806-811` (every start restores and
  re-retires every token ever recorded).
- **Evidence** [measured]: 100 peer sessions attached, each introduced one reference and retired,
  added 100 retired session entries and 28,700 characters (287 each) to a 38,619-character state.
  Every commit stringifies them (`imageOf`, `hub-log-store.js:132-153`). [read] A `retire` or
  `hello` greeting carrying a fresh well-formed token creates a permanent record
  (`durable-netlayer.js:413-421,439-445`). The peer must be able to reach the private socket
  directory, which limits this to the same user.
- **Smallest fix**: after `retirementConfirmed`, delete the session directory and `forgetSession` the
  hub key. Keep only a compact tombstone set of retired tokens (one line each, so a re-presented
  retired token is still refused, as the envelope comment requires). Prune the netlayer maps at
  retirement.
- **Size**: about 40 lines in 4 files (`store-fs.js`, `store-memory.js`, `peer-sessions.js`,
  `durable-netlayer.js`).
- **Risk**: the "never reuse a retired identity" rule. Covered by `durable-sessions.test.js`,
  `remote-delivery.test.js` and `unix-delivery.test.js` retire cases. Add one test that a retired
  token presented after a restart is answered `retired`.

### AR-NET-6 (moderate, Q2/Q5): peer frames and watermarks are persisted twice, and each record is a whole-document rewrite

- **Where**: `peer-sessions.js:506-566` (`recordOutbound`, `recordAck`, `recordInbound`,
  `recordProcessed`: each `setMeta` of the whole record); `store-fs.js:89-90` (`writeTextAtomic`:
  write, fsync, rename, directory fsync, `platform/node/sync-files.js:40-58`);
  `durable-netlayer.js:314-331,475-493`.
- **Evidence** [read]: an outbound peer frame is first a hex entry in the hub queue (in the hub
  log), then a base64 entry in `meta.frames` until acknowledged. An inbound frame is a base64 entry
  in `meta.inbox`. The hub's `processedUpTo` and the record's `processedSeq` are two watermarks for
  the same progress, and `queueSequences` and `hubDelivery` are two for the hub's delivery
  identity. A frame pair costs four whole-record rewrites (outbound, ack, inbound, processed), each
  a full atomic replace. [inferred] While a peer is away, `write` keeps accepting
  (`durable-netlayer.js:315`, true unless destroyed), so the k-th queued frame rewrites k frames:
  O(n^2) bytes for a backlog of n. Not measured.
- **Smallest fix**: keep the session record as an image plus an append log. Reuse
  `makeHubLogStore`'s format, or factor its delta and recovery core into a shared "record log"
  that both use. Appends then follow the change. Folding the record into the hub's own commit
  (one fsync for routing and inbox progress) is the larger, better step. It would remove one of
  each pair of watermarks.
- **Size**: about 60 lines for the reuse (a generic record log over `SyncFilePowers`). The fold is a
  larger change across `peer-sessions.js`, `durable-netlayer.js` and `hub.js`.
- **Risk**: exactly-once delivery across crashes. Covered by `randomized-delivery.test.js`,
  `delivery-storage-failures.test.js` (syscall faults) and `remote-process-delivery.test.js`.

### AR-NET-7 (moderate, Q3): one hub store would do; there are six implementations

- **Where**: `store-fs.js:248-313` (`hubStore: 'log' | 'file'`, `refuseHubLog` on every get and set
  in file mode); `hub.js:124-133` (`makeMemoryHubStore`, the hub's default);
  `store-memory.js:99-102`; `pkg/scripts/mail-hub-log.mjs` (85 lines) and `mail-hub-sqlite.mjs`
  (114), with `pkg/test/mail-hub-log.test.js`, `mail-hub-sqlite.test.js` and a fixture (218 lines)
  in the core suite; the adapter from `ThixotropeStore` to `HubStore` at `daemon.js:219-227`.
- **Evidence** [read, measured]: file mode is one-way. The log store migrates `hub.json` and then
  file mode refuses the directory (`store-fs.js:263-268`). The only users of `'file'` are
  `H/test/serve.test.js:283`, `H/test/template/*` and the perf harness's comparison switch
  [measured: grep]. Its header describes the scripts as a "Disposable benchmark experiment, not a
  production store format" (`mail-hub-log.mjs:2`). `ThixotropeStore.getHubState/setHubState/
  hubStoreStats` re-expresses `HubStore.getState/setState/stats`, and the daemon wraps one into
  the other.
- **Smallest fix**: delete file mode. Keep the one-way migration read of a legacy `hub.json` in
  `hub-log-store.js`. Move the two mail experiments to the harness or delete them (their findings
  are recorded). Let `makeFsStore` expose the `HubStore` object itself (`store.hubStore`) and pass
  it to the hub unchanged.
- **Size**: about -250 lines across 6 files, plus the harness's 3 references.
- **Risk**: `hub-crash-consistency.test.js` runs both stores, so drop the file arm.
  `hub-log-store.test.js` keeps the migration test. The harness perf baseline for `hub.json`
  comparisons goes away (J-9337 already notes those tools must read through the store).

### AR-NET-8 (moderate, Q1): `hub.js` does seven jobs; its seams are already visible

- **Where**: the job table in 2.2.
- **Evidence** [read]: the routing core is about 1,200 of 2,803 lines. Gifts (about 460), outbox
  modes (about 400), diagnostics (about 235) and retirement (126) share the closure only through
  the five tables, `dirty`, `persist`, `sendMessage` and `deliveryDepth`. `attachSession` (202
  lines) mixes option validation, identity encoding, withdrawal ordering, the `deliverFrame` and
  `deliverBatch` sinks, and inbound coalescing.
- **Smallest fix**: after AR-NET-3, move the pieces into modules that take a small context
  (`{ tables, persist, sendMessage, markDirty }`): `hub-outbox.js` (session kinds, sequences,
  flush), `hub-gifts.js` (deposit, withdraw, provideHandoff, pending withdrawals, dial
  bookkeeping), and `hub-stats.js` (cost and GC counters as a wrapper around the injected store
  and `send`, out of the routing code). The core keeps rows, kits, routing and retirement, at
  about 1,500 lines.
- **Size**: a mechanical move of about 1,100 lines into 3 new files. Small semantic risk.
- **Risk**: closure-shared mutable state (`deliveryDepth`, `gcCause`, `measuring`) becomes explicit
  context. The 12 hub test files cover the behaviour. `stats()` output shape is consumed by the
  harness perf tools, so keep it.

### AR-NET-9 (moderate, Q2): repeated code inside the area and against `@endo/ocapn`

- **Evidence** [measured: a duplicate-block finder over normalized 6-line windows of `src/`; read]:
  - `peer-sessions.js:265-282` and `:307-324`: identical handshake verification (read, type,
    version, location signature). `:178-187` and `:334-343`: the same `op:start-session` writer.
    Both re-implement `@endo/ocapn`'s `client/handshake.js` (`sendHandshake` at line 27, the check at
    line 178).
  - `hub.js:1465-1479`, `:1543-1555`, `:2268-2280`: "for each resolver row, skip dead, settle it"
    three times. `:1769-1775` and `:2061-2067`: add a gift waiter twice. `:1944-1962` and
    `:2003-2022`: the same `resolveTarget` triage. The "present" test for `answerPosition` and
    `resolveMeDesc` (not `false`, not `undefined`) is written 8 times [measured: grep]. The refId
    format is built at `:722-724` and rebuilt by hand at `:1461`.
  - `pipe-network.js:80-101` (`derivePipeResumption`) repeats `:126-145` (`makePipeNetwork`'s
    identity, session id and peer signature).
  - The connection wrapper `{ netlayer, isOutgoing, isDestroyed, write, end }` appears twice
    (`peer-sessions.js:206-232`, `durable-netlayer.js:373-389`).
  - `store-fs.js:189-219`: `appendJournal` and `appendJournalEntries` duplicate setup, but not
    failure handling (AR-NET-12).
  - The retirement doc comment appears three times (`hub.js:2213-2221`, `:2651-2662`, and
    `forgetSession`).
- **Smallest fix**: `verifyStartSession(message)` and `writeStartSession(keyPair, location)`
  helpers, or call the ocapn helpers directly. Add `breakResolvers(refIds, reason)`,
  `addGiftWaiter`, `isPresent`, `refIdOf(origin, epoch, backing, position)`, and one
  `deriveDuctIdentities`. Make `appendJournal(entry)` call `appendJournalEntries([entry])`.
- **Size**: about -120 lines in 4 files.
- **Risk**: low. Behaviour-preserving extractions, covered by the existing hub, delivery and
  journal tests.

### AR-NET-10 (moderate, Q5): an inbound `op:abort` half-detaches the session

- **Where**: `hub.js:2166-2170` against `frameError` at `:2185-2211`.
- **Evidence** [read]: on `op:abort` the hub only sets `session.attached = false`. It neither calls
  `onAbort` (which for a peer ends the connection, `peer-sessions.js:77`) nor commits. Inbound
  frames on the same sink are still processed (`deliverFrame` does not check `attached`). Outbound
  frames now queue (durable) or break (others) until a reattach, which for a peer comes only with a
  new connection while the old one stays open [inferred].
- **Smallest fix**: handle a received abort like a bad frame without sending one: detach, call
  `onAbort`, and log.
- **Size**: about 10 lines in 1 file.
- **Risk**: peer close semantics. Add a test in `remote-delivery.test.js` where a peer sends
  `op:abort`.

### AR-NET-11 (moderate, Q5, PLAUSIBLE): a failed single append to a worker journal is not repaired before the next one

- **Where**: `store-fs.js:189-198` against `:199-219`.
- **Evidence** [read]: `appendJournalEntries` resets `journalCounted` and `journalRepaired` when
  the append throws, because "some leading lines may be durable and the last one torn".
  `appendJournal` does not, so a later `appendJournal` appends after a torn fragment. The result is
  a damaged middle line. `readJournalFile` drops only a torn final line (`:147-152`), and
  `readJournal`'s `JSON.parse` (`:224`) then throws. `durable-worker-transport.js:851` uses
  `appendJournal` for single frames. Whether a second append follows a failed one depends on the
  transport after the throw: M1b QC advisory 3 (in C-20) says it wedges until a restart, which
  would avoid this. Not reproduced.
- **Smallest fix**: implement `appendJournal(entry)` as `appendJournalEntries([entry])`.
- **Size**: about 5 lines in 1 file. A fault test with `_memory-sync-files.js` (torn append, then a
  second append, then `readJournal`).
- **Risk**: none beyond the store. Covered by `worker-store-journal.test.js`.

### AR-NET-12 (moderate, Q4): names that mean several things, and things with several names

- **Evidence** [read]:
  - "session" names three things: a hub session (`hub.js:285`), a durable-netlayer logical
    connection keyed by token (`durable-netlayer.js:113`, `sessions`) and a stored session record
    (`store.js:85`, `SessionStore`). Inside `hub.js`, `session` is a `SessionState` almost
    everywhere but a session key string in `publish`, `introduce` and `publishHeld`
    (`:2590,2607,2637`).
  - Delivery identity has at least seven names: `sequenceNumber` (inbound), `processedUpTo`,
    `deliverySequence` and `sequence` (send), `queueSequences` and `nextDelivery` (outbox),
    `hubSequence` and `hubDelivery` (transport and record), and `recvSeq`, `sendSeq`, `ackSeq`,
    `processedSeq` and `n` in the netlayer.
  - One c-list is kept as two inverse maps with unrelated names: `session.ourExports`
    (position -> refId, the hub's exports toward the session) and `row.facing` (session ->
    position). `refcounts` holds the same key set as `facing`. The header calls these "c-lists",
    the design "per-session reference tables", and the code "rows" and "tables".
  - The endpoint and every transient client take their identity from the pipe network with
    `role: 'worker'` and `workerId: id` (`in-process-session.js:50-54`). Their location is a
    `thixotrope-pipe` location, while their network says `thixotrope-transient`
    (`transient-hub-client.js:32`).
  - Session class: "durable", "transient", "ephemeral", "disposable observer" (AR-NET-3).
- **Smallest fix**: a short glossary in the hub header that matches `designs/thixotrope.md` (c-list
  = `ourExports` plus `facing`). Rename `at.session` to `at.origin` in the public API. Use one name,
  "delivery number", for the outbox identity across hub, transport and record. Rename the
  netlayer's `sessions` to `logicals` and add `deriveInProcessIdentity(id)` to `pipe-network.js`.
- **Size**: about 60 lines of renames in 5 files, plus the harness's calls of `publish` (tests).
- **Risk**: low (renames). Public API renames need the harness's `hub.publish` test calls updated.

### AR-NET-13 (moderate, Q2): frames for disposable sessions still enter the persisted state (C-1), and the smallest fix is in the serializer

- **Where**: `hub.js:1188-1209`, `:1217-1225`; `hub-state.js:64-65`.
- **Evidence**: this is S2 section 3.2 item 4 and C-1, confirmed [read]. A disposable session's
  frame is pushed onto `queue`, committed (`persist()` at `:1222`), and only then spliced. Its
  removal is committed lazily. Disposable sessions are forgotten at startup (design; `daemon.js:816`),
  so the committed bytes are never used. Unlike S2's change 3, which reworks `dispatchBytes` and
  `flushOutbox`, the fix can be one line in the serializer.
- **Smallest fix**: `queue: session.discardOnRestart ? [] : [...session.queue]` (and the same for
  `queueSequences`) in `serializeHubState`. The routing effects still commit before the send,
  which is all the disposable contract needs (`hub.js:2360-2363`).
- **Size**: 3 lines in 1 file.
- **Risk**: `hub-disposable-outbox.test.js` ("restart discards stale observer output"). The
  harness's C-1 probe (J-0164) would then find no frames at rest or in transit.

### AR-NET-14 (minor, Q3): dead code and compatibility paths for states that cannot occur

- **Evidence**:
  - `const gcBatching = true` (`hub.js:390`) and its branch (`:398`) [read].
  - `restoreHubState`'s fallbacks (`?? '1'`, `?? 0`, `queueSequences` derived from indexes,
    `hub-state.js:107-148`). Version 2 and every field were introduced together in `05d039c9f6`
    (2026-10-20), and `assertRecordVersion` refuses anything else, so no accepted record lacks
    them [measured: `git log -S`, `git show`].
  - `remoteSessionKey`'s scan for "import aliases written before these routes were unified"
    (`hub.js:663-683`). That alias test also arrived in `05d039c9f6` [measured]. The scan is
    O(sessions) per gift and per import.
  - The `'resume'` envelope case (`durable-netlayer.js:427`). Its sender was removed in
    `8218c5cb70` (2026-09-08) [measured].
  - `hubHandlers.resumeSession` that only throws (`peer-sessions.js:398-400`), and
    `restoreSession`'s unused `_handlers` (`:476`).
  - `getPeerDurability` (tests only), `hub.publish` (17 test uses, 0 in src), `hub.inspect` (see
    AR-NET-2), `hub.inboundWatermark` (1 test use, 0 in src) [measured: grep].
  - The optional `appendJournalEntries` (`store.js:71`) is implemented by both stores, so the
    per-entry fallback at `core/durable-worker-transport.js:884-889` is dead [read].
  - Version 1 session records are silently treated as absent (`peer-sessions.js:453-454`). The
    next `onHello` with that token then fails "already used" instead of saying why [read].
- **Smallest fix**: delete the above. Make `appendJournalEntries` required. Use
  `assertRecordVersion` for session records.
- **Size**: about -80 lines in 5 files.
- **Risk**: low. Tests of `publish` move to `publishHeld` or `introduce`, and the "legacy import
  alias" test is deleted with its path.

### AR-NET-15 (minor, Q5): process-local tables that grow with every transient session

- **Where**: `hub.js:362-376` (`gcCounts`, keyed by session key and by the cause
  `` `retired ${sessionKey}` ``, never pruned; `forgetSession` at `:2690-2697` drops the session and
  its codec kit but not its counters); `peer-sessions.js:230` (an entry per restored connection,
  including retired ones that never close).
- **Evidence** [read]: one adapter incarnation or transient client adds at least two keys, so a
  long-running daemon accumulates them without bound. `status().gc` then reports every session
  ever seen in this process.
- **Smallest fix**: aggregate GC counters by session class (`worker`, `observer`, `peer`, `local`;
  AR-NET-3), or fold a forgotten session's counters into an "others" bucket at `forgetSession`.
- **Size**: about 15 lines.
- **Risk**: the harness perf tools that read `gcCounts` by session (`H/perf/hub.perf.mjs`).

### AR-NET-16 (minor, Q5): no ceiling on a logical message anywhere on the peer path

- **Where**: `unix-netlayer.js:11` ("Bound each physical fragment, not the already-admitted logical
  message"), `:152-176`. The hub has none either (S2 section 6).
- **Evidence** [read]: a peer can send any number of continuation fragments, and the netlayer
  buffers them all before `handleMessageData`. The durable netlayer then records the payload in
  the session record, and the hub decodes it. This is the remote-peer form of C-25.
- **Smallest fix**: a `maxMessageLength` option (default, for example, 8 MiB as for the control
  socket) checked as fragments accumulate. Exceeding it drops the connection.
- **Size**: about 8 lines and one test in `unix-netlayer.test.js`.
- **Risk**: a legitimate peer message above the bound. None is known (Noise caps at 65,519, S2).

### AR-NET-17 (minor, Q1): `peer-sessions.js` holds two jobs, and `ThixotropeStore` four

- **Where**: `peer-sessions.js:38-401` (handshake and hub binding) and `:403-574` (the session
  record, `resumption`: 170 lines of record keeping with no OCapN in it); `store.js:96-117` (hub
  state, worker stores, session records, bundles behind one interface).
- **Smallest fix**: move `resumption` to `store/session-records.js` (it implements
  `SessionResumptionPower`, whose type lives in `durable-netlayer.js`). After AR-NET-7 the hub
  store is a separate object anyway.
- **Size**: a move of about 180 lines and 2 imports.
- **Risk**: none (a move). It also gives the record logic its first direct tests.

### AR-NET-18 (minor, Q5): untested surfaces

- **Evidence** [measured: importers in `test/`]: `peer-sessions.js` (588 lines) and
  `in-process-session.js` have no direct tests. They are exercised through daemon-level tests
  (`durable-sessions`, `remote-delivery`, `unix-delivery`). No test kills the hub inside a
  retirement (AR-NET-1), sends `op:abort` from a peer (AR-NET-10), or tears an `appendJournal`
  (AR-NET-11). `durable-netlayer.test.js` has one test; the netlayer's protocol cases are covered
  by `remote-delivery.test.js` and `randomized-delivery.test.js` instead.
- **Smallest fix**: the three tests named in AR-NET-1, -10 and -11, and handshake-verification unit
  tests once AR-NET-9 extracts the helpers.
- **Size**: about 150 lines of tests.
- **Risk**: none.

---

## 4. What is good and should be kept

- **Dependency direction** [measured]: `net/` and `store/` never import `core/`, `control/`,
  `native/` or `mail/`. All platform access is through injected powers (`SyncFilePowers`,
  `SocketPowers`, `TimerPowers`, `RandomPowers`, `now`). The hub has no clock, file or socket of
  its own.
- **The rollback ledger and tokens** (`hub.js:310-351,776-820`): every decode and encode runs under
  `withRollback`, so a failed frame leaves no rows, refcounts or routes. Tokens are inert
  `Far('HubRef')` objects with a WeakMap of their info, so nothing in the hub is promise-shaped.
- **"Tables before wire"**, stated at the top of the file and enforced in `deliverFrame`
  (`:2470-2508`) and the outbox loops, with `hub-crash-consistency.test.js` proving it under
  SIGKILL for both stores. AR-NET-1 is the one path that does not yet follow it.
- **`hub-log-store.js`**: a documented format, recovery rule and compaction rule; refusal
  instead of guessing on damage; exhaustive prefix and fault tests. Entry order is preserved, so
  restore order (which retirement iterates) is stable.
- **The durable netlayer protocol**: a small, explicit state machine (`hello`/`welcome`/`f`/`ack`/
  `retire`/`retired`/`bye`) with checked sequence arithmetic and a retire handshake that survives
  crashes, kept separate from the byte transport.
- **Validation before filesystem use** (`store-validators.js`): tokens and digests from the network
  are shape-checked before they become paths. The Unix netlayer checks socket directory privacy and
  `sockaddr_un` length (`unix-netlayer.js:24-49`).
- **`versioned-record.js`**: one version check with two clear refusals, already shared by four
  record kinds. Session records should join it (AR-NET-14).

---

## 5. Not covered

- The Rust engine and worker, the durable worker transport and the in-vat peer
  (`core/durable-worker-transport.js`, `core/worker-peer*.js`), apart from the two call sites cited.
  `survey-engine.md` was skimmed for context, not re-checked.
- `core/vat-reachability.js` and `core/daemon.js` beyond their use of the hub. The `mail/` package's
  use of publications.
- Throughput: the only measurements here are the two scratch runs in AR-NET-4 and AR-NET-5
  (in-memory files, no fsync). AR-NET-6's O(n^2) is inferred, not measured.
- Running any test suite (none was run; findings marked PLAUSIBLE were not reproduced).
- Third-party gift correctness against the OCapN draft (signature chains, `handoff-count` replay)
  beyond reading the code paths. `usedGiftHandoffs` grows per session until retirement and was not
  sized.
- The harness's own use of these modules (its review comes later).

Ended 2026-11-18 (see the journal entry J-9952 for the closing time).
