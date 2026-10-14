# Production cost model: proposals from five days of operation

Status: Proposed; nothing in this note is implemented.
A first draft listed every change an operator's report suggested; a review on 2026-10-14 triaged
them against their complexity and three decisions recorded below.
Each kept proposal names the test that would show it works.

## Source

An operator ran Thixotrope from this branch as the default runtime of a hosted chat application
from 2026-10-04 to 2026-10-09: one supervisor process, 67 persistent workers, one person's use.
Their report, dated 2026-10-09 and kept outside this repository, measured the live state directory.
It concludes that the durability design is sound and that the cost model leaks.
The deployed checkouts are not in this repository, so every reference below is to this branch's
code, and the report's line numbers do not apply.

What the report measured:

- `hub.json` was 11.5 MB: 34,335 ref rows (9.1 MB) and 68 sessions (2.4 MB).
  It was replaced about once a second, and the supervisor wrote 2.95 TB in five days.
- The hub's own counters: 115,872 deliveries averaging 2.4 s, 283 wakes averaging 40 s, and 234
  snapshots averaging 6.7 s.
- 31,543 of the ref rows had a `transient:native:` origin.
  26,691 of them were settled answers that only routes in durable workers' `answersOwed` kept
  alive, about 6,300 new rows a day.
- SIGTERM ended the supervisor with `Ironhorse state directory is not owned` and exit 255.
- A restart replayed 14 of 66 workers before the control socket listened.
  One never-idle worker had 3,744 journal entries past its snapshot and replayed for over 30
  minutes.
- A guest's endowment of 73 powers crossed in frames of about 650 bytes, at about 1.5 deliveries a
  second for over 20 minutes, each delivery committing the vat's heap.
- A cancelled turn left the chat's guest refusing every later program.
- The host could not tell a slow supervisor from a dead one.

The operator fixed two things in their own checkout that this branch does not carry.
Retiring a session there breaks other sessions' routes toward it and releases the rows nothing
else pins (their bd-1991; see 2.4).
A cancel there frees the guest at once (their bd-1992, in the host application).

## Decisions from the review

1. **A gc frame means a collection.**
   `op:gc-answers` and `op:gc-exports` are sent only when the collector has dropped the import.
   Sending them at settlement, or on any other protocol event, was proposed and rejected: only
   collection proves that no holder remains, since a settled answer can still be passed as an
   argument.
2. **Collection under Ironhorse comes from the engine.**
   A parallel effort is adding `WeakRef` and `FinalizationRegistry` to the Ironhorse realm.
   With them, the OCapN client's existing finalizer sends the gc frames, and this package needs no
   protocol work of its own; section 3 records what it needs from that effort.
3. **No backward compatibility.**
   Nothing runs this branch in production.
   State-format migrations, upgrade paths for code already in heaps, and per-worker feature flags
   drop out of every proposal.

## Snapshots, journal and replay

Several proposals rest on how a worker recovers, so the shape is stated once here.

Both engines take whole-heap images: Ironhorse closes, hashes and copies its SQLite file and
relaunches (the report's 6.7 s average); the XS worker writes a heap image.
The transport therefore does not snapshot per delivery.
It appends every inbound frame to the worker's `journal.jsonl` and fsyncs it before delivery.
Only when the worker goes idle (`sleepInternal` in `src/core/durable-worker-transport.js`) does it
take an image, record `{ ref, cut }` and truncate the journal.
Recovery restores the image and re-delivers the journal entries past `cut`.
That re-delivery is replay.

Two consequences follow.
Replay must be deterministic: the same journal must yield the same outbound frames, because the
hub drops replayed output by frame number (`outboundBase + seenOutbound`).
And the Ironhorse incarnation's `heap.sqlite` is not the recovery path:
`src/ironhorse/ironhorse-engine.js` says recovery always starts at the image paired with the
journal cut, and deletes the incarnation's copy when it ends.
Until 1.1 the worker nonetheless committed to that copy after every crank.

## How the problems chain

```
§2 c-list grows ──► hub.json 11.5 MB ──► whole table written ~3× per delivery ──► 16 MB/s
                                                                                     │
§9 heap committed per crank × ~1800 endowment frames ──► 35 GB in 33 min ────────────┤
                                                                                     ▼
                                                   operator's CPU and IO brake ──► 15 min boot
§5 a never-idle worker never snapshots ──► 3,744-entry replay (independent of the rest)
```

Two unbounded growths and one wasted write explain nearly everything.
The whole-table write hurts because the table was bloated; bound the table and it is affordable.
That ordering decides the triage below.

## Triage

| #    | Proposal                              | Verdict                               |
| ---- | ------------------------------------- | ------------------------------------- |
| 1.1  | No Ironhorse commit per crank         | Done                                  |
| 1.2  | Count the worker journal in memory    | Done                                  |
| 1.3  | Keep the lease holder alive           | Done                                  |
| 1.4  | Name vat directories after workers    | Done                                  |
| 1.5  | Correct the README                    | Done                                  |
| 2.1  | Snapshot awake workers                | Done, with one threshold              |
| 2.2  | Answer `status` before ready          | Deferred, beside D.5                  |
| 2.3  | Break routes toward a retired session | Done                                  |
| 2.4  | Measure what a commit writes          | Measure when convenient               |
| 3    | Collection under Ironhorse            | Requirements on the parallel effort   |
| D.1  | Fewer hub writes per flush            | Deferred: moot if the table is small  |
| D.2  | Batch retirement; index pins          | Deferred: retirement is rare          |
| D.3  | `hub.close()`                         | Deferred: until 1.3 fails to fix it   |
| D.4  | Hub journal with snapshots            | Deferred: only if the table stays big |
| D.5  | Warm workers in the background        | Deferred: 2.1 shortens boot           |
| R    | Rejected                              | Recorded with reasons                 |

The operator's other findings need no change here.
Section 4 of the report (the brake) is an operational consequence of §1, §2 and §9.
The "68 sessions persisted, 0 on disk" item is not a leak: `sessions/` holds only network peers'
resume tokens, and the 68 hub sessions were 67 workers and the `endpoint`.

## 1. Local fixes

### 1.1 Stop committing the Ironhorse heap per crank

`src/ironhorse/ironhorse-engine.js` delivers a frame as two `eval` requests: the dispatch, then
`thixotropeTakeOutbound()`.
After each crank, `rust/thixotrope-ironhorse-worker/src/main.rs` runs a full `collect_garbage()`
and then `checkpoint_to_store`: one SQLite transaction per eval, under WAL with
`synchronous=FULL`.
A checkpoint writes dirty pages and extents, not the whole file, but collection marks every
side-table section dirty (`snapshot_dirt.mark_all()` in the interpreter's `gc.rs`), so every
commit re-encodes each section and rewrites each one whose digest changed.

None of this buys durability; see the replay section above.

Done, in a simpler shape than first proposed, and in Thixotrope's own worker binary rather than
the engine.
The worker no longer checkpoints after a crank; it checkpoints once in `close_heap`, before it
closes the file, which the host's `close` and therefore `snapshot()` reach.
No request field was added: this package is the worker's only consumer, and nothing reads the
incarnation's file for recovery.
Outbound frames still come only from a journaled inbound frame, and after a crash replay
regenerates them and the hub's watermark drops the duplicates, as before.
What it gives up: the worker's promise that no result escapes a crank that failed to commit; a
storage fault now surfaces at snapshot or close instead.
Collection still runs after every crank, and must: section 3 depends on its timing.

A worker test evaluates several cranks, shows the store's epoch unchanged until `close_heap`, and
reopens the file to find their state.
The existing Ironhorse suites cover crash-then-replay.

### 1.2 Count the worker journal in memory

The worker store's `journalLength()` in `src/store/store-fs.js` reads and splits the whole
`journal.jsonl` on every call.
`durable-worker-transport.js` calls it for every frame it writes to a worker, `daemon.js` for every
worker at start, and `inspectWorkers` for every worker on every `status`.
A busy worker's journal therefore costs a read proportional to its length on every frame.

Done: the worker store keeps the journal's base and count in memory, set by the first read (after
torn-tail repair) or by any rewrite, and advanced only once an append is durable.
`journalLength()` reads the file only before anything has been counted; `readJournal` and
`truncateJournal` still read it, once per wake and once per sleep.
`makeFsStore` now hands out one store per worker, so the transport, the start sweep and
`inspectWorkers` share the count, and `deleteWorker` forgets it.
The store has one owner under the lease, so nothing else can make the count stale.

`test/worker-store-journal.test.js` counts file reads across fifty appends and lengths, checks
absolute indices across truncation, a successor process's agreement, a torn tail left out and
repaired, and the forgotten store after deletion.

### 1.3 Keep the lease holder alive through shutdown

On this branch the daemon's `close` runs `stopDaemon` before it releases the lease, and
`stopDaemon` awaits the native adapters' shutdown, whose terminations resolve only after each
adapter's `onExit` has run with its errors caught.
In an orderly stop, `forgetSession` runs under the lease, so the report's ordering diagnosis does
not reproduce here.

What likely happened is lease loss.
The lease is held by a child process, `thixotrope-ironhorse-worker --lock-state`, which has no
signal handling.
Under systemd's default `KillMode=control-group`, SIGTERM reaches the supervisor, the lock holder,
the vats and the adapters together.
The lock holder exits, ownership is gone before shutdown begins, and the adapters' exits then drive
`forgetSession` into a `persist()` the store's ownership guard refuses.
This is inferred from the code and the report's stack trace; the exit was not reproduced.

Done: the helper now ignores SIGTERM, SIGINT and SIGHUP and exits only when its stdin closes,
which `release()` already arranges.
The binary forbids unsafe code and its dependencies offer no safe signal API, so the host spawns
it through `sh -c 'trap "" TERM INT HUP; exec "$0" "$@"'`; dispositions set to ignore survive
`exec`.
Operators should still run the supervisor under `KillMode=mixed`.

The test in `test/ironhorse/reliability.js` sends the helper all three signals, finds it alive and
the lease still refused to a competitor, then releases and finds it gone.
If a crash still reproduces, D.3 is the next step.

### 1.4 Name vat directories after their workers

`durable-worker-transport.js` passes a `debugName` built from the worker's label and id to the
engine's `start`; the Ironhorse engine ignores it, and each incarnation lives in
`incarnations/vat-XXXXXX/`.
The operator had to search heaps to find a chat's vat.

Done: the directory is `vat-<slug>-XXXXXX`, where the slug is the debug name reduced to
`[A-Za-z0-9._-]` and at most 40 characters, so `app:chat(fd6a3854)` lives in
`vat-app-chat-fd6a3854-XXXXXX` and the heap path in `ps` names it too.
`worker-engine.js` already requires that `debugName` be diagnostic only.

The test in `test/ironhorse/reliability.js` starts a worker and asserts the directory name.

### 1.5 Correct the README

`packages/thixotrope/README.md` says production worker peers retain their normal import collection
behavior.
Under Ironhorse today they do not: the realm has no `WeakRef` or `FinalizationRegistry`, so
`makeFinalizingMap` in `packages/ocapn/src/captp/finalize.js` falls back to a strong map, and
`slotCollectedHook` in `packages/ocapn/src/client/ocapn.js` never runs.
The only place `enableImportCollection: false` is set is the replay test double
(`src/core/peer-replay-engine.js`), which is why the report named the wrong cause for the right
outcome.
Done: the README now says what is true today and points at section 3 for what changes it.

## 2. Structural changes

### 2.1 Snapshot awake workers

`sleepInternal` is the only place that takes a worker's image and truncates its journal, and it
runs only on the idle timer, an explicit sleep, or shutdown.
A worker that never idles never snapshots, so its journal, and every restart's replay, grows
without bound.

Done: sleep is now a checkpoint, which leaves the worker awake, followed by termination, and a
delivery queues a checkpoint once `deliveredUpTo - cut` reaches `snapshotEveryDeliveries`.
The checkpoint runs behind the deliveries already queued, as a sleep would, so a burst takes one
snapshot that covers the whole burst.
The supervisor's default is 256; the daemon and the transport take the option, and resident
(ephemeral) workers are exempt, as they are from idle sleep.
One threshold: a worker with slow traffic has a short journal anyway, so no time trigger is
needed.
Both engines can take an image while awake: Ironhorse closes, copies and relaunches; the XS worker
continues after `snapshot-ok`.
`seenOutbound` folds into `outboundBase` as at sleep, so numbering runs on.

Cost: an image is proportional to the heap, so the threshold amortizes the report's 6.7 s.

Tests, in `test/durable-worker-session.test.js`: against an engine double, the cadence, the
continued numbering, a crash that replays only past the cut, and one snapshot per burst; through
the hub with the snapshotting replay engine, a never-idle worker's journal staying within the
cadence and recovery from the awake snapshot.

### 2.2 Answer `status` before the supervisor is ready

Deferred, beside D.5.
The control socket is served last, after the workers warm, so during a warm there is no socket to
answer: a client gets `ECONNREFUSED`, which is what the operator's host retried 360 times a minute.
Answering during the warm would take a second, temporary host listener, opened under the lease
before restore and closed before the control adapter binds, with warm progress plumbed out of the
daemon: sixty to eighty lines and a second listener lifecycle.
With 2.1, a restart replays at most the cadence per worker, so the window that listener would
cover shrinks from the operator's fifteen minutes to seconds.
The host should treat `ECONNREFUSED` as a supervisor that is starting and back off (their
bd-1993), which it needs for a dead supervisor anyway.

### 2.3 Break routes toward a retired session

`retireSessionInternal` in `src/net/hub.js` turns the retired session's rows into tombstones but
leaves other sessions' `answersOwed` routes pointing at them, and `isPinned` counts those routes as
roots.
That is why the start sweep that forgets stale `transient:` sessions took the report's sessions
from 68 to 67 but left refs at 34,261.
A later frame naming such a position fails in `getLocalAnswerValue`; from a local session,
`frameError` drops it with a log line rather than breaking it.

The operator's fix (bd-1991; patch not yet read) breaks every other session's `{ ref }` route
toward a retired session with a stated reason and releases the rows nothing else pins.
This stays right with section 3 in place: an asker whose answer is broken drops the promise, the
collector then releases the route.

Done: ported from #1444 and #1445 as the author's own commit, with the hunk unchanged.
Left out: the boot-sweep extension and the test that heal tombstones an earlier build left, since
nothing runs this branch in production and retirement now leaves none; and the `test.failing` for
growth while the answerer lives, which section 3 covers.
The comment and test now name the cause recorded in 1.5.

### 2.4 Measure what an Ironhorse commit writes

With 1.1, commits move to snapshot and close, but a commit still re-encodes every side-table
section after a collection.
Measure a heap shaped like an OCapN peer's with
`rust/endo/ironhorse-store-sqlite/tests/store_bench.rs` before deciding whether to narrow what a
collection marks dirty.
Collection timing itself is not a tuning knob here; section 3 says why.

## 3. Collection under Ironhorse

The §2 growth is the OCapN client's import collection not running under Ironhorse (1.5).
A parallel effort is adding `WeakRef` and `FinalizationRegistry` to the realm.
Once it lands, a durable worker's import table becomes weak, a dropped answer promise is collected,
`slotCollectedHook` sends `op:gc-answers`, and the hub releases the row and the route.
`packages/ocapn/test/gc.test.js` ("op:gc-answers is sent when answer promise is garbage
collected") shows this path working in Node.

What this package needs from that effort, stated as requirements rather than design:

- **Collection at a journaled point.**
  Today the worker collects after every successful crank, which is a function of the inbound
  journal alone.
  Keep it so; a collection keyed to wall time or memory pressure would make replay emit different
  gc frames and shift the outbound numbering the hub depends on.
- **Finalization within the crank that collects.**
  Finalizer callbacks must run before the delivery's outbound is taken, so the gc frame belongs to
  a determinate delivery, and before an image is taken, so a restored worker does not fire them
  again.
  [Host-managed resources](host-managed-resources.md) reaches the same requirement for native
  resources' collection hooks.
- **Nothing else pins a settled answer.**
  Verify that the OCapN client and the worker peer hold a settled answer promise only through the
  import table, as the Node test implies.

Tests, once the engine work lands:

- In `test/peer-replay-gc.test.js` style: a sleep, wake and replay produces frames identical to the
  first life, gc frames included.
- In `test/hub.test.js`, near "released holdings return gc to the origin and shrink the tables": the
  hub's ref count and total routes are the same after 5 worker-to-adapter calls as after 50, under
  Ironhorse and across a restart.
- `test/resource-answer-gc.test.js` extended to the native adapter path.

Open: the report also counted 5,384 export tombstones held by workers.
Exports are released by the importer's `op:gc-exports`, so whether these clear under the same
mechanism depends on who imports them; check after the engine work lands.

## Deferred

- **D.1 Fewer hub writes per flush.**
  `flushOutbox` persists once when it gives a frame its sequence and once after it shifts the frame
  off, so a delivery sending k frames costs 1 + 2k whole-table writes.
  Dropping the per-shift persist would make that about k + 2.
  Not worth doing while the table is small; and giving the whole queue sequences up front is
  unsafe, since `attachSession` relies on never-sent frames having none.
- **D.2 Batch retirement; index pins.**
  `retireSessionInternal` does not raise `deliveryDepth`, and `isPinned` scans every route of every
  session per row, so retirement is O(n·m) in writes and CPU.
  Retirement is rare, and bd-1991's "one linear pass" may already cover it.
  A pin-count index is a new invariant across about ten mutation sites; build it only if retirement
  is measured to matter.
- **D.3 `hub.close()`.**
  A closed flag after which `persist`, `flushOutbox`, `dispatchBytes`, `retireSession` and
  `forgetSession` do nothing.
  Safe (nothing unpersisted is ever sent; the next start redoes skipped retirements) but defensive;
  wait for 1.3 to fail to fix the shutdown crash.
- **D.4 Hub journal with snapshots.**
  Replace `dirty` with touch sets, append row-level changes to `hub.journal.jsonl`, compact to
  `hub.json` on a size trigger and at start.
  The largest proposal here: 36 or more touch sites, a new store API, compaction, and a checking
  store to catch a missed site.
  It makes growth cheap without bounding it.
  Build it only if, with section 3 in place, the table is measured to stay large.
  Partitioning by session does not fit: refs are shared, and 92% of the rows had one origin.
- **D.5 Warm workers in the background.**
  A bounded pool, an `awaitWarm` option, a warming report, and a start that returns before every
  replay finishes.
  It changes the start contract; 2.1 bounds every suffix, which removes most of the motivation.
  2.2, a `status` that answers during the warm, waits here with it: both serve a window 2.1 made
  short.

## Rejected

Recorded so the reasoning is not lost; none is to be built.

- **Retire answers at settlement.**
  The asker would send `op:gc-answers` when an answer settles.
  Rejected by decision 1: settlement does not prove the asker holds nothing, since the settled
  promise can still be passed.
- **Per-worker protocol feature flags, and a journaled features envelope.**
  Protection for workers created under an older bundle.
  Moot by decision 3.
- **The hub rewrites a settled answer's route**, and **vat replacement for code already in heaps.**
  Mitigations for heaps that cannot take new code.
  Moot by decision 3; [vat replacement](vat-replacement.md) remains a general design topic.
- **Release non-durable sessions' state early.**
  A live transient client may still pipeline to or pass a settled answer, so release at settlement
  is wrong here too, and transient clients run in Node with collection on, so the case is already
  bounded.
- **The live Ironhorse heap as the recovery baseline.**
  Would pair `{ cut, outboundBase, hubDelivery }` with each heap commit and recover from the live
  heap.
  It reverses the engine's rule that recovery starts at the image, and needs the distributed
  transaction between heap and hub that the current design avoids.

## Outside this package

The report's guest, host and wire modules belong to the hosted application.

- A cancel must free the guest's single `execution` at once, with a cancellation record per turn
  (their bd-1992).
- Give each phase of opening a session a deadline, and show a waiting step (their bd-1989); 2.2
  gives the host something to show.
- Send the endowment packet as one message, not frames of 32 tokens or 8 refs.
  With 1.1 a frame no longer commits the heap, so the report's 20 minutes become seconds, but each
  frame is still a delivery.
- Back off when retrying a supervisor that is starting (their bd-1993), and read `ECONNREFUSED`
  on the control socket as that: the socket is served last (2.2).

## First batch

Done: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1 and 2.3; 2.2 is deferred beside D.5.
Each removes work, closes an unbounded growth, or corrects a statement; only 2.1 adds a tunable,
and none adds a state format.
Section 3's tests follow the engine work.

1.1 makes each endowment frame cheap, but each is still a delivery; until the application sends
the packet as one message, the operator's guidance stands: give a Thixotrope chat one or two
powers, not the root set.
