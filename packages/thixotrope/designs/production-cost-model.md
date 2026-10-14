# Production cost model: proposals from five days of operation

Status: Proposed; nothing in this note is implemented.
Tiers 1 and 2 come from reading the code at the head of #1220 against an operator's report.
None of them has been prototyped or measured, and each names the test that would show it works.
Tier 3 is a set of **unexplored and unvalidated protocol ideas**.
They are recorded so they are not lost, not selected for implementation.

## Source

An operator ran Thixotrope from this branch as the default runtime of a hosted chat application
from 2026-10-04 to 2026-10-09: one supervisor process, 67 persistent workers, one person's use.
Their report, dated 2026-10-09 and kept outside this repository, measured the live state directory.
It concludes that the durability design is sound and that the cost model leaks.
The deployed checkouts are not in this repository, so every reference below is to #1220's code,
and the report's line numbers do not apply.

What the report measured:

- `hub.json` was 11.5 MB: 34,335 ref rows (9.1 MB) and 68 sessions (2.4 MB).
  It was replaced about once a second, and the supervisor wrote 2.95 TB in five days.
- The hub's own counters: 115,872 deliveries averaging 2.4 s, 283 wakes averaging 40 s, and 234
  snapshots averaging 6.7 s.
- 31,543 of the ref rows had a `transient:native:` origin.
  26,691 of them were settled answers that only routes in durable workers' `answersOwed` kept
  alive.
- SIGTERM ended the supervisor with `Ironhorse state directory is not owned` and exit 255.
- A restart replayed 14 of 66 workers before the control socket listened.
  One never-idle worker had 3,744 journal entries past its snapshot and replayed for over 30
  minutes.
- A guest's endowment of 73 powers crossed in frames of about 650 bytes, at about 1.5 deliveries a
  second for over 20 minutes, each delivery rewriting much of a 15 MB vat heap.
- A cancelled turn left the chat's guest refusing every later program.
- The host could not tell a slow supervisor from a dead one.

The operator fixed two things in their own checkout that this branch does not carry.
Retiring a session there breaks other sessions' routes toward it and releases the rows nothing
else pins (their bd-1991; see 2.4).
A cancel there frees the guest at once (their bd-1992, in the host application).

## How the report holds up against this branch

| Report section                                    | Against #1220                                         | Proposals     |
| ------------------------------------------------- | ----------------------------------------------------- | ------------- |
| 1. The hub persists its whole table per mutation  | Confirmed, and worse: two whole writes per frame sent | 1.1, 1.2, 2.1 |
| 2. Durable workers never release their answers    | Outcome confirmed; the cause is different (1.7)       | 2.4, 3.1–3.5  |
| 3. Shutdown mutates the hub after the lease       | Order is already right here; likely lease loss        | 1.5           |
| 4. A throttled supervisor is worse than a hot one | Operational consequence of 1, 2 and 9                 | —             |
| 5. Boot replays before it listens                 | Confirmed; also a whole-journal read per frame        | 1.3, 2.2, 2.3 |
| 6. A cancelled program latches the chat           | Host application                                      | 3.6, outside  |
| 7. No host deadline or visible waiting step       | Host application; no warming status here either      | 2.2, outside  |
| 8. Smaller things                                 | Two confirmed; the session count is not a leak        | 1.6, 1.7, 3.5 |
| 9. The endowment write loop                       | Confirmed per crank, though not as a whole-file write | 1.4, 2.5      |

## Tier 1: local fixes

These change no state format and no protocol.

### 1.1 Batch the hub outbox's writes

`persist()` in `src/net/hub.js` serializes every ref row, session, publication, gift and gift waiter
through `serializeHubState`.
It then replaces `hub.json` through `writeTextAtomic`: write, fsync, rename, fsync the directory.
It defers only while `deliveryDepth` is above zero.
`flushOutbox` persists once when it gives a frame its delivery sequence, and once after it shifts
the accepted frame off the queue.
A delivery that sends k frames therefore costs 1 + 2k whole-table writes.

Proposed: stop persisting after each shift.
The removal of an accepted frame can ride on the next frame's sequence assignment, and one persist
after the loop records the last removals.
A delivery that sends k frames then costs about k + 2 whole writes instead of 1 + 2k.
This only halves the cost; 2.1 is the real fix, after which a persist appends a few rows.

Each sequence is still durable before the frame carrying it leaves.
Destinations already drop duplicates by hub sequence (`durable-worker-transport.js`,
`durable-netlayer.js`).
A crash between sending and the persisted shift therefore resends frames the destination discards,
which is the contract the existing comment in `flushOutbox` already states.

Not proposed: giving the whole queue its sequences up front, with one persist.
`attachSession` moves only frames with no sequence, never attempted, behind the withdrawals it
constructs, so a queued listen reaches the exporter after the withdrawal that creates its answer.
A frame given a sequence but never handed to `send` would lose that freedom.
Whether any queued frame can depend on a later withdrawal has not been worked out.

Tests: in `test/hub-outbox.test.js`, count `setState` calls per flush, and check that sequences
stay stable across a restart between send and shift; extend `test/local-delivery.test.js`
likewise.

### 1.2 Batch session retirement and index pins

`retireSessionInternal` does not raise `deliveryDepth`.
Each `maybeReleaseRef` that sends a gc frame therefore goes through the outbox, and its whole-table
writes, on its own.
`isPinned` scans every publication, gift, gift waiter, and every route of every session, for each
row it is asked about.
Retiring a session with n rows among m routes therefore costs O(n·m).

Proposed: run the body of `retireSessionInternal` inside `deliveryDepth`, then persist once and
flush the affected outboxes, as `deliver` does.
Keep a `refId → pin count` index, updated wherever routes, publications, gifts and gift waiters
change, and make `isPinned` a lookup.
Build the index from the tables at restore.

Risk: a missed update makes a pinned row look free.
Tests: in `test/hub.test.js`, near "released holdings shrink the tables", retiring a session with
many rows writes once.
Under `test/randomized-delivery.test.js`, the index agrees with a full scan after every step.

### 1.3 Count the worker journal in memory

The worker store's `journalLength()` in `src/store/store-fs.js` reads and splits the whole
`journal.jsonl` on every call.
`durable-worker-transport.js` calls it for every frame it writes to a worker, `daemon.js` calls it
for every worker at start, and `inspectWorkers` calls it for every worker on every `status`.
A busy worker's journal therefore costs a read proportional to its length on every frame, which is
quadratic over the worker's life, and it slows `status` as well.

Proposed: keep `{ base, count }` per worker store in memory.
Set it at the first read, after torn-tail repair, and advance it in `appendJournal` and
`truncateJournal`.
The store has a single owner under the lease, so no other writer can make the count stale.

Tests: extend `test/daemon-journal-recovery.test.js`, and add a store test that counts file reads
per appended frame.

### 1.4 Stop committing the Ironhorse heap per crank

`src/ironhorse/ironhorse-engine.js` delivers a frame as two `eval` requests: the dispatch, then
`thixotropeTakeOutbound()`.
After each crank, `rust/thixotrope-ironhorse-worker/src/main.rs` runs a full `collect_garbage()`
and then `checkpoint_to_store`.
That is one SQLite transaction per eval, under WAL with `synchronous=FULL`.
A checkpoint writes dirty pages and extents, not the whole file.
But collection marks every side-table section dirty (`snapshot_dirt.mark_all()` in
`rust/engine/ironhorse-vm/src/interp/gc.rs`).
So every commit re-encodes each section, and rewrites each one whose digest changed.

None of this buys Thixotrope durability.
The engine's header says each incarnation uses a private writable copy.
Recovery always starts at the snapshot paired with the transport's journal cut, and the copy is
deleted when the incarnation terminates.
The journal and deterministic replay already carry everything since the last image.

Proposed:

- Add an optional `commit: false` field to the worker's `eval` request, and send it for
  deliveries.
- Have `close` checkpoint before it closes the store.
  Today `close` does not, which is safe only because every crank already committed.
  `snapshot()` closes, copies and relaunches, so this keeps images complete.
- Leave `snapshot()` otherwise unchanged.

The worker's request format is private to this package; this is not a protocol change in the
sense of Tier 3.
Outbound frames still come only from a durably journaled inbound frame.
After a crash, replay regenerates them, and the hub's watermark drops the duplicates, as it does
after a crash today.

What it gives up: the worker's promise that no result escapes a crank that failed to commit.
A storage fault would surface at snapshot or close, and recovery would replay from the last image.
Collection still runs after every crank; 2.5 covers that.

Tests: a Rust test in `rust/endo/tests/ironhorse_store_worker.rs` that evaluates without commits,
closes, reopens and finds the state.
In `test/ironhorse/reliability.js`, kill a vat after several uncommitted deliveries and check
that replay sends no duplicate frames past the hub.

### 1.5 Close the hub before the lease, and keep the lease holder alive

On this branch, the daemon's `close` runs `stopDaemon` before it releases the lease.
`stopDaemon` awaits `nativeAdapters.shutdown()`, whose terminations resolve only after each
adapter's `onExit` has run, and `onExit` catches its own errors.
So in an orderly stop, `forgetSession` runs under the lease, and the report's ordering diagnosis
does not reproduce here.

What likely happened instead is lease loss.
The lease is held by a child process, `thixotrope-ironhorse-worker --lock-state`, which has no
signal handling.
Under systemd's default `KillMode=control-group`, SIGTERM reaches the supervisor, the lock holder,
the vats and the forked adapters together.
The lock holder exits, so ownership is gone before shutdown begins.
Adapter exits then drive `forgetSession` into `persist()`, which the store's ownership guard
refuses.
This is inferred from the code and the report's stack trace; the exit 255 path was not reproduced.

Proposed:

- Add `hub.close()`: a final `persist()`, then a closed flag.
  After it, `persist`, `flushOutbox`, `dispatchBytes`, `retireSession` and `forgetSession` do
  nothing, and `attachSession` throws.
  Nothing unpersisted is ever sent.
  The next start's sweep redoes any transient retirement that was skipped.
  Durable sources re-send any frame a closed hub dropped, since its watermark never advanced.
- In `stopDaemon`, close the hub after the native adapters, transient clients and worker
  transports have stopped, and before the endpoint and netlayer shut down.
  The lease is released after that, as today.
- In `--lock-state` mode, have the lock holder ignore SIGTERM and SIGINT, and exit only when its
  stdin closes, which `release()` already arranges.
- Advise operators to run the supervisor under `KillMode=mixed`, so only the main process receives
  SIGTERM.

Tests: in `test/daemon-shutdown.test.js`, an adapter that exits after `shutdown()` resolves
neither throws nor writes after release.
A restart on the same store then has no `transient:` sessions.
A variant in which ownership is lost before shutdown rejects once with `/not owned/`, and nothing
escapes uncaught.
In `test/hub.test.js`, a closed hub neither persists nor sends.

### 1.6 Name vat processes after their workers

`durable-worker-transport.js` already passes a `debugName` built from the worker's debug label and
id to the engine's `start`.
The Ironhorse engine ignores it.
Each incarnation lives in `incarnations/vat-XXXXXX/`, and its process arguments name only that
path, so the operator had to search heaps to find a chat's vat.

Proposed: use a sanitized `debugName` (`[A-Za-z0-9._-]`, at most about 40 characters) in the
incarnation directory prefix, as in `vat-<label>-XXXXXX`.
Optionally, also set `argv0` through the process powers.
`worker-engine.js` already requires that `debugName` be for diagnostics only, and nothing would
look a vat up by it.

Test: `test/ironhorse/supervisor.js` asserts the directory name.

### 1.7 Correct what misleads

- `packages/thixotrope/README.md` says production worker peers retain their normal import
  collection behavior.
  Under Ironhorse they do not.
  The realm has no `WeakRef` or `FinalizationRegistry`, so `makeFinalizingMap` in
  `packages/ocapn/src/captp/finalize.js` falls back to a strong map.
  `slotCollectedHook` in `packages/ocapn/src/client/ocapn.js` then never runs, and no worker sends
  `op:gc-answers` or `op:gc-exports`.
  The only place `enableImportCollection: false` is set is the replay test double
  (`src/core/peer-replay-engine.js`).
  That is why the report named the wrong cause for the right outcome.
- `inspectReachability` and the start sweep for stale `transient:` sessions in
  `src/core/daemon.js` read the persisted hub state through `store.getHubState()`, re-parsing
  `hub.json` each time.
  Have them read the live hub's tables.
  With 2.1 they would otherwise also have to apply the journal.

## Tier 2: structural changes

These change a state format or the start sequence, but no protocol.

### 2.1 Journal the hub, with snapshots

Partitioning the hub's state by session does not fit.
Refs are 9.1 of the 11.5 MB, and refs are shared across sessions.
31,543 of 34,335 rows had one origin, so per-session files would put most of the table in one
file.
A journal makes each write proportional to what changed.

Design:

- Replace the `dirty` flag with touch sets.
  `touchRef(refId)` and `touchSession(key)` record what changed; a touched session also records
  which `answersOwed` and `ourExports` positions changed and which queue operations ran.
  `touchGlobal(kind, key)` covers publications, gifts and gift waiters.
- An entry upserts the current value of each touched key, or deletes it.
  Touching too much is harmless; touching too little loses state.
  The `withRollback` undo stays correct, because an undone key serializes its restored value.
- `persist()` keeps its call sites and its early returns.
  It appends one entry of changes with `appendTextDurable` (append, then fsync) instead of
  rewriting the table.
- Queue changes are recorded as operations: push, shift and sequence assignment.
  When `attachSession` reorders a queue, the whole queue is written.
- Layout: `hub.json` becomes the snapshot, `{ version: 3, cut, ... }`.
  `hub.journal.jsonl` holds a `{ base }` header and the entries.
  This is the shape the worker stores already use: `journal.jsonl`, with the cut in
  `meta.snapshot`.
- The store gains `appendHubJournal(entry)` and `compactHub(state)`.
  `compactHub` writes the snapshot and then truncates the journal, in the order worker sleep uses.
  `getHubState()` returns the snapshot with the journal applied, so callers and tests keep working.
- Recovery loads the snapshot, applies entries from `cut` in order, drops a torn final line, and
  rebuilds `facing` from `ourExports` as `src/net/hub-state.js` does today.
  No send ever follows a torn line, because the append is fsynced before `persist()` returns.
  Its source re-delivers the frame, because the hub's processed watermark never committed.
- Compact when the journal's bytes exceed the larger of 1 MiB and the snapshot's size.
  That bounds total writes at about twice the journal.
  Also compact once at start, after restore and before any session attaches.
- Migration: bump `STATE_VERSION` in `src/net/hub-state.js` from 2 to 3.
  Read version 2 as a snapshot with cut 0; `assertRecordVersion` in
  `src/store/versioned-record.js` currently accepts only an exact match.
  Compacting at start means an older build then refuses the directory, rather than silently
  missing journal entries.

The durability contract does not change.
`persist()` stays synchronous and is called where it is today: before every `session.send` and
after every delivery.
Only its cost changes, from the whole table to the touched rows.

Risks:

- A missed touch site silently loses state on restart; the checking store below is the guard.
- Compaction is still a synchronous whole-table write.
  It could later move off the delivery path, since the journal already holds everything.
- A detached durable peer with a long queue needs queue operations, not whole-queue writes.
  Otherwise the journal grows quadratically.

Tests:

- A checking store that replays snapshot plus journal after every append, and deep-compares the
  result with `serializeHubState` of the live hub.
  Run it under `test/hub.test.js` and `test/randomized-delivery.test.js`.
- In `test/hub.test.js`, extend "restarts from its tables mid-session" to cover snapshot plus
  suffix, journal only, a torn tail, and version 2 to 3.
- In `test/delivery-storage-failures.test.js`, compact in the middle of a backlog.

### 2.2 Listen before warming, and report warming

`makeThixotropeDaemon` seats sessions and starts the peer netlayer.
It then wakes every worker whose journal is longer than its snapshot cut, all at once in one
`Promise.all`, and only then sends start notices.
The supervisor then evaluates the registry, serves the workspaces and the clock, provides the
control socket last and resolves `readyKit`.
A control connection accepted earlier waits on `readyKit`, so a booting supervisor looks the same
as a dead one.
`status` exists only on a selected workspace.

Proposed:

- Warm workers in the background, through a pool of bounded concurrency (`warmConcurrency`, 2 to
  4).
  Take the shortest journal suffix first, and workers that need a start notice before the rest.
- A frame for a worker the pool has not reached wakes it on demand, ahead of the pool.
  No new queue is needed: frames already wait behind a wake in the transport's serial queue, and
  the hub's watermark suppresses replayed frames.
- Keep an `awaitWarm` option, default true, so tests that expect warm workers when start returns
  keep passing; the supervisor passes false.
- Expose `daemon.warming()`, returning `{ total, warmed, failed, active }`, where each `active`
  entry gives a worker's id, debug label and suffix length.
- Record and report a background failure other than a guest halt, and route it to the stop
  request, rather than aborting a start that is already listening.
- Until `readyKit` resolves, have the control connection's `status()` and `help()` answer at once
  with `{ phase: 'starting' | 'warming' | 'ready', warming }`.
  Every other method still waits for `readyKit`.
- Add a daemon-wide `status` that needs no workspace.
- Optionally, open a host listener that answers only `status` while state is restored, the
  `serveFallback` shape.
  It must close before start notices, so that the control adapter can bind its socket.

Risks: callers and tests that assume every suffix replayed when start returns.
Background failures must stay visible.

Tests:

- In `test/daemon-journal-recovery.test.js`, with a gated engine: start returns while one replay
  is blocked, and the concurrency bound holds.
  A frame to a warming worker is delivered in order, and a background failure is reported.
- In `test/local-control.test.js`, `status` answers while a replay is blocked.

### 2.3 Snapshot awake workers on a cadence

`sleepInternal` in `src/core/durable-worker-transport.js` is the only place that takes a worker's
image, records `{ ref, cut }` and truncates the journal.
It runs on the idle timer, on an explicit sleep, or at shutdown.
A worker that never idles never snapshots, so its journal, and every restart's replay, grows
without bound.

Proposed: factor the image-taking part of `sleepInternal` into a checkpoint that leaves the worker
awake.
Enqueue it after a delivery once either threshold is crossed, with a minimum spacing between
checkpoints:

- `deliveredUpTo - cut` passes `snapshotEveryDeliveries` (about 256), or
- the oldest unsnapshotted entry is older than `snapshotEveryMs` (about ten minutes).

Both engines can take an image while awake.
Ironhorse closes, copies and relaunches.
The XS worker continues after `snapshot-ok`.
Outbound numbering stays continuous if `seenOutbound` is folded into `outboundBase`, as sleep does
now.

Cost: an Ironhorse image is proportional to the heap; the report's snapshots averaged 6.7 s.
The thresholds should amortize that.
An alternative trigger is journal bytes reaching some multiple of the image's size.

Test: in `test/durable-worker-session.test.js`, a cadence snapshot advances `cut`, truncates the
journal and leaves the worker awake.
A crash afterwards replays without gaps or duplicates.

### 2.4 Break routes toward a retired session

`retireSessionInternal` turns the retired session's rows into tombstones.
It leaves other sessions' `answersOwed` routes pointing at them, and `isPinned` counts those routes
as roots.
That is why the start sweep that forgets stale `transient:` sessions took the report's sessions
from 68 to 67 but left refs at 34,261.
A later frame naming such a position fails in `getLocalAnswerValue`.
From a local session, `frameError` drops that frame with a log line rather than breaking it.

The operator's fix (their bd-1991, whose patch we have not seen) breaks every other session's
`{ ref }` route toward a retired session with a stated reason.
In the same pass, it releases the rows nothing else pins.
Their start sweep also forgets transient origins that survive only in refs.

Proposed: port it after reading their patch; with 1.2's pin index, the pass is linear.
A worker that later uses such an answer then sees a break instead of a silently dropped frame,
which is the intent.
This bounds what a retired session leaves behind.
It does not bound live growth while the session lives; that is 3.1.

### 2.5 Measure, then narrow, what an Ironhorse commit writes

With 1.4, commits move to snapshot and close.
A commit still re-encodes every side-table section after a collection, though, because collection
marks them all dirty.
First measure a heap shaped like an OCapN peer's with
`rust/endo/ironhorse-store-sqlite/tests/store_bench.rs`.
Candidates, depending on what the measurement shows:

- mark only the sections a collection actually changed;
- collect on a cadence keyed to the heap's crank counter rather than after every crank, and always
  before close and snapshot.

Collection timing must remain a function of journaled input, so that replay reproduces it.

## Tier 3: protocol ideas (unexplored and unvalidated)

> **Unexplored and unvalidated.**
> Everything in this tier changes a protocol: what OCapN peers send each other, what the host and
> a worker exchange, or what the hub's routes mean.
> None has been prototyped, reviewed against the OCapN specification, or tested.
> Each records the reasoning that suggested it and the hazards already visible, so a later design
> can start from it or reject it.
> None is a decision.

### 3.1 The asker retires settled answers

The problem: durable workers never send `op:gc-answers` (1.7).
Every worker-to-adapter call therefore leaves one answer row on the adapter's side and one
`answersOwed` route on the worker's session, for the life of the state.
The rows come from `allocateAnswerRoute` in `src/net/hub.js`, and adapters attach as
`durable: false` sessions under `transient:native:` keys (`src/native/adapters.js`).
The hub cannot release on settlement by itself.
A route holds a reference, `done` or a break, never a data value, and the worker may still
pipeline to the answer or pass it on.

The idea: an OCapN client option, say `retireSettledAnswers`, under which the asker drops a remote
answer once it settles and tells the peer.
It would act on a protocol event rather than on a finalizer, so it would not depend on garbage
collection.

- Settlement runs while an inbound fulfill or break is processed (`ref-kit.js`).
  Its timing is therefore a function of journaled input.
- After settlement, `HandledPromise` forwards new sends to the resolution, and `makeRemoteAnswer`
  clears its target.
  New sends no longer name the answer position.
  Sends pipelined earlier are already ahead of the gc frame in the session's order.
- Retired positions would be batched into one `op:gc-answers` per turn, so the hub persists once
  per batch.
- A resolver import is used once.
  After `fulfill` or `break`, the asker could drop it with `op:gc-exports`, once it has counted
  the uses still pending per slot.

Hazards already visible:

- Passing a settled answer as an argument.
  The grant tracker keeps it as `remote:answer`, so after the drop `provideRemoteAnswerPosition`
  would throw.
  The client would have to forget the grant, which the tracker cannot do today, so that the
  promise is re-exported as a fresh local promise.
- A worker replaying under a new bundle would emit frames its first life did not; see 3.2.

Unknowns:

- Whether this conforms to OCapN, and interoperates with other implementations.
- Whether third-party handoffs or pipelining name an answer position after settlement in cases not
  listed here.
- The effect on `src/core/vat-reachability.js`, which treats routes as `answer` edges.

What would begin to validate it:

- In `packages/ocapn/test/gc.test.js`, N calls with finalizer collection disabled return the
  peer's answer table to its starting size.
- Pipelining before settlement still works (`packages/ocapn/test/pipeline.test.js`).
- In Thixotrope, the hub's ref count and total routes are the same after 5 calls as after 50
  worker-to-adapter calls, across a restart under Ironhorse.

### 3.2 Per-worker feature flags and a journaled features envelope

`init` is delivered only to a worker that has no snapshot, and the worker bundle's module runs only
then.
A worker restored from a snapshot therefore keeps its old OCapN client forever.
A worker without a snapshot replays from `init` under whatever bundle is current.
If 3.1 shipped in the bundle, such a worker would emit gc frames its first life did not.
That would shift `outboundBase + seenOutbound` against the hub's watermark, and the hub would drop
or duplicate the wrong frames.

The idea:

- Record protocol features in the worker's meta when it is created, and carry them in the `init`
  envelope, never deriving them from the bundle version.
- For later changes, a journaled `{ t: 'features' }` envelope would switch a feature at a known
  cut, so that replay switches at the same point.

Unknown: whether a heap's hardened client objects can honor a switch without new code in the heap.
That is 3.6.

### 3.3 The hub rewrites a settled answer's route

The idea, as a mitigation for heaps that cannot change (3.6): the hub already sees a settlement
arrive at the resolver it registered on the answer row.
It could rewrite the asker's route:

- a break becomes `{ local: null, reason }`;
- a reference V becomes `{ local: V }`, so later traffic goes straight to V;
- a data value needs a new kind of route that holds the value.

This would free the adapter's answer rows and tables without changing workers.

Hazards:

- Message order can change when V lives on a third session.
- A route that carries data is new hub state.
- One route per call remains, so growth stays unbounded without 3.1.

### 3.4 Engine-delivered collection

General `op:gc-exports`, for presences a guest may still reach, needs to know when the guest
dropped them.
The Ironhorse realm exposes no weak references.
`src/core/vat-reachability.js` reads only hub tables, at the granularity of whole vats.

The idea:

- The host journals a `{ t: 'gc' }` envelope at a cut: at a snapshot, or every K deliveries.
- The worker forces a full collection and reports which imports died.
- The peer sends the corresponding gc frames.

This is SwingSet's "bring out your dead" pattern.
[Host-managed resources](host-managed-resources.md) reaches the same shape for native resources'
collection hooks.

Needs:

- an Ironhorse primitive for weak imports, or a collector report of dead import slots;
- an argument that the verdict depends only on the journal.

### 3.5 Release non-durable sessions' state early

The idea: a `transient:` session cannot resume, so the hub could treat its state more
aggressively.
For example, it could not persist rows whose origin is `transient:`, and restore routes to them as
breaks.

Hazards:

- A live transient client may still pipeline to, or pass, a settled answer, so release on
  settlement alone is wrong even here.
- Durable resolvers listening on such rows must still be persisted, so the start sweep can break
  them.

This case is already bounded.
Transient clients run in Node through `makeOcapn` with import collection on, so they do send
`op:gc-answers`, and `close()` clears their routes.

The report's "68 sessions persisted, 0 on disk" is a different matter, and not a leak.
`sessions/` holds only network peers' resume tokens.
The 68 hub sessions were 67 workers and the `endpoint`.

### 3.6 Upgrade code already in heaps

Neither 3.1 nor the host application's guest fix (report section 6) reaches existing heaps.
The code lives in the heap, and per the report the application's `openGuest` never reinstalls.
[Vat replacement](vat-replacement.md) explores replacing a vat while preserving its exports.
It is the only recorded path that would reach a latched guest or an old OCapN client without
recreating the worker.

### 3.7 The Ironhorse live heap as the recovery baseline

The idea:

- Write `{ cut, outboundBase, hubDelivery }` into the heap's SQLite metadata, in the same
  transaction as a commit.
- Commit on a delivery or time cadence, and truncate the journal at each commit.
- Recover from the live heap when its cut is at least the image's.

Images would become rare, and whole-heap copies (the report's 6.7 s snapshots) would give way to
commits proportional to what changed.

Hazards:

- It reverses the engine's stated rule that recovery always starts at the snapshot paired with the
  journal cut.
  It therefore needs the distributed-transaction argument the current design avoids.
- A torn or corrupt live heap must be detected, with a fallback to the image.

## Outside this package

The report's guest, host and wire modules belong to the hosted application, not this repository.

- Report section 6: a cancel must free the guest's single `execution` at once, with a cancellation
  record per turn (their bd-1992).
  Chats whose heaps hold the old guest need 3.6, or a new chat.
- Report section 7: give each phase of opening a session a deadline, and show a waiting step
  (their bd-1989).
  2.2 gives the host something to show.
- Report section 9: send the endowment packet as one message, not as frames of 32 tokens or 8
  refs.
  The transport already has a deferred-source path and a 16 MB ceiling.
  With 1.4, a frame no longer costs a heap commit, but each frame is still a delivery.
- Back off when retrying a supervisor that is starting (their bd-1993).

## Suggested order

1. 1.4 and 1.1: the two per-step write multipliers, both local and testable.
2. 1.3, 1.2, 1.5, 1.6 and 1.7.
3. 2.3 and 2.2; then 2.1, a format change to version 3; 2.4 after reading the operator's patch;
   2.5 after measuring.
4. Tier 3 only after a design review, and 3.2 before 3.1 if 3.1 is pursued.

Until 1.4 lands and the application sends endowments in one message, the operator's guidance
stands: give a Thixotrope chat one or two powers, not the root set.
