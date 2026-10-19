# Mail performance implementation plan

Status: implementation and experiments in progress.

Preserve the existing durability and replay guarantees while reducing amplification at each layer.
Use 50 ms typical and 100 ms p99 local visibility as provisional engineering targets, not measured
claims or a change to the send acceptance contract.

1. Replace mail UI invalidation and full remote rereads with ordered initial state and incremental
   object subscription payloads.
   Maintain one projection per service and fan it out to browser subscribers.
   Resolve message values and local names from pushed references, without per-message RPCs.
   Measure reads, upstream subscriptions, and deliveries as history and browser counts increase.
2. Reduce durable hub commits without changing disk-before-wire ordering or replay identity.
   First combine queued frame and delivery-sequence persistence where safe.
   Test crashes and failed commits before considering transaction or append-log storage.
   Measure commit count and filesystem time separately from serialization.
3. Make the mailbox workspace-owned with the workspace's lifetime.
   Preserve existing mailbox references and history while developing the migration strategy.
   Compare identical split-vat and colocated workloads, including accepted and visible latency.
4. Measure and reduce runtime evaluation, outbound-drain, and full-GC overhead.
   Compare isolated execution with end-to-end traffic before changing collection policy.
5. Repeat end-to-end measurements on fresh and existing durable workspaces with increasing history,
   simultaneous subscribers, and message rates.
   Report typical and tail latency, commits, bytes, RPCs, and worker activity.
   Validate restart, replay, disconnect, rename, deletion, and adoption behavior.

The [subscription note](mail-ui-subscriptions.md) records the initial desired behavior and baseline.
Worker CPU times overlap host work and must remain separate from elapsed-time breakdowns.
Experiments must use isolated state rather than replacing the running user's mailbox.
No storage-sync guarantees will be relaxed merely to improve a benchmark.

## First implementation

Observable maps now have an explicit value-granting `subscribeEntries` endpoint.
It pushes an initial reset and coalesces subsequent per-key changes while a listener is busy.
Mailbox inbox and outbox expose these streams without granting the mailbox itself to the browser.
The host bridge maintains state from four entry streams plus contact-status streams and shares one
projection across browser subscribers.
Message values and names are resolved locally from these pushed references.
Old durable interfaces use the shared legacy bridge; this does not upgrade their stored code.
The workspace metadata version is unchanged because these optional interfaces are backward compatible.

Outbox flushing commits an attached frame together with its sequence and combines accepted-prefix
removal with the next frame's sequence commit.
Ordinary adapters retain a final removal commit; journaled worker adapters now piggyback the
accepted tail on the next necessary commit, as described in the durable transfer experiment.
The incoming delivery commit also includes the first sequence for every attached destination with
queued work, avoiding a separate file replacement before forwarding.
Only the head is assigned early; unattempted tails retain the ordering needed for gift withdrawals.
It retains the existing durable ownership and replay boundaries.
Regression tests cover before-wire failure, final-commit failure and replay, and gift ordering.

The browser still receives complete projected views, and rebuilding those views is linear in history.
Incremental browser patches, message pagination, existing-object migration, transactional storage,
mailbox co-location in production, and runtime changes remain subsequent work.

## Reproducing measurements

Build the native runtime and Ironhorse guest bundles before running the benchmark from the package
directory with `node scripts/measure-mail.mjs push` or `node scripts/measure-mail.mjs colocated`.
Each command owns a temporary daemon and workspace, seeds three value-bearing messages, and measures
three text-only self-sends before closing the daemon and removing its state.
Run modes sequentially in separate processes to avoid cross-workspace reference-reclamation traffic.
Idle and snapshot thresholds are set beyond the bounded experiment; each trial reports snapshots.
The benchmark reports send acceptance, first pushed inbox visibility, worker deliveries, hub rewrite
count, and time inside hub file replacements.
The visibility metric requires both send acceptance and a pushed inbox state containing the message.
It is sampled after awaiting acceptance, so it is an upper bound on the callback arrival time if the
inbox push arrives before the send response.
It excludes HTTP, browser rendering, and screen presentation.
The delivery counter is sampled through a subsequent status call, so its interval can extend slightly
beyond the visibility timestamp.
An optional `legacy` mode takes an absolute path to a legacy service module for comparison.
Comparing hub implementations also requires loading the corresponding hub source; the script alone
does not revert the hub.
Three samples are exploratory measurements and cannot establish p99 latency.

## Next persistence boundary

The entry-stream experiments remove most reads, but tens of hub commits remain per mail.
The next design should carry worker outbound batches through the hub and receiving adapter journal
as durable batches, rather than independently committing each protocol frame and acknowledgement.
Evaluate a transactional delivery ledger or append log with grouped commits at those boundaries.
Track the touched destinations so a delivery need not scan every session in a large daemon.
Persist frame bytes and replay identities before exposing any batch to its destination.
Retire sender ownership only after the receiving batch is durably accepted.
Test a crash at every ownership transition and replay the same identities after restart.

Several exploratory trials have extra worker activity and multi-second latency despite no periodic
snapshots and far fewer hub writes.
Classify that activity, including recovery and reference reclamation, before claiming a tail-latency
improvement or attributing the remainder solely to VM garbage collection.

## Exploratory results, 18 October 2026

All six variants ran in separate disposable daemons, sequentially, using the original native worker.
The [complete results](mail-performance-results.json) retain every sample and the method details.
The following medians summarize three sends per variant; they are not tail-latency estimates.

| Variant | Accepted + inbox ready | Hub rewrites | Time in hub file replacements |
| --- | ---: | ---: | ---: |
| Original bridge and hub | 7,253 ms | 495 | 4,729 ms |
| Pushed entries, original hub | 1,017 ms | 57 | 540 ms |
| Pushed entries, outbox batching alone | 977 ms | 57 | 554 ms |
| Pushed entries, batched head sequences | 806 ms | 36 | 354 ms |
| Colocated mailbox, outbox batching alone | 513 ms | 27 | 262 ms |
| Colocated mailbox, batched head sequences | 423 ms | 18 | 174 ms |

The outbox-only change reduced commits in the multi-frame regression test but did not reduce the
measured mail write count; including head sequences in the incoming commit did.
The final colocated samples were 416, 423, and 427 ms, with 16, 18, and 18 hub rewrites.
An earlier colocated variant had an 8,160 ms outlier with 304 writes and extra worker activity.
The original bridge had a 19,182 ms outlier, and the pushed-head variant had a 2,099 ms outlier.
All of those samples remain in the results rather than being discarded as warm-up.
The provisional 50–100 ms target is not met.
The subsequent [fine-grained capture](mail-latency-colocated.md) compares fresh 418 ms and 364 ms sends after combining native dispatch and outbound extraction.
It retains a 1,611 ms outlier and identifies the remaining remote contact lookup as avoidable.

## Validation of the first changes

The six nearest regression suites pass 48 tests in each of the three SES configurations.
They cover incremental values, rename and deletion, shared subscribers, reconnection, partial setup
failure, replay identity, gift ordering, and durable storage refusal.
The clean workspace declaration build, package typecheck, and all 14 type-contract projects pass.
Package source and test ESLint reports no errors.
The documentation build still reports the existing 102 errors and 190 warnings elsewhere in the
monorepo; no new Thixotrope documentation error was identified.

## Combined native delivery experiment

The worker now advertises `deliver-v1` and accepts one request that dispatches, runs promise jobs,
collects and completes finalizer cascades, then extracts outbound with a distinct budget.
It omits the post-extraction collection; the trusted JSON-only outbox cannot register finalizers.
Older pinned workers retain their original delivery path.

Seven fresh instrumented sends per variant reduced the median from 417.969 ms to 364.448 ms (12.8%).
The selected baseline spent 62.879 ms in three extraction collections; the new path has none.
Four dispatch/cascade sweeps remain, and finalizer-generated frames are included before replying.
The [updated sunburst and complete samples](mail-latency-colocated.md) separate concurrent work and
retain a 1,611 ms / 77-delivery outlier, so this does not establish improved tail latency.
Native unit and host integration tests cover finalization, budgets, restore, and legacy selection.
The next proposals remain direct recipient references, grouped durable ownership commits, and
classification of excess protocol activity; the 50–100 ms target remains unmet.

## Reference selection and append-log experiments

The UI now sends a captured recipient token instead of resolving its display name for every mail.
A fresh nine-send comparison reduced the median from 362.057 ms to 228.682 ms and ordinary hub
commits from 16 to ten.
An opt-in disposable full-snapshot append log reached 181.643 ms with the same ten commits, by
avoiding directory synchronization on each steady-state append.
The first noisy reference run and all outliers remain in the
[strategy comparison](mail-optimization-strategies.md), with raw traces and sunbursts.
The append-log format is benchmark-only and has not been enabled for existing workspaces.

Protocol tags identify a control outlier with 67 `gc-answers` and seven `gc-exports` frames,
193 hub writes, and 80 native collector rounds.
The next experiment should batch GC lists in both client and hub, rather than expanding each
collected reference into a separately journaled native crank.
Preserve call ordering, reference deltas, durable ownership, and replay identities in that design.
The trigger that initiates reclamation bursts still needs tracing.

## Ordered GC batching

The client now coalesces consecutive GC notices, and the hub preserves lists through routing.
Ordinary messages and changes of GC kind remain ordering barriers.
A deterministic 130-position replay fixture becomes three bounded frames and retains exact deltas.
Native finalizer and SIGKILL recovery checks pass with a separately built updated guest bundle.

In five-send GC-stress runs, client-only batching retained a 3.364-second / 122-delivery burst.
Client plus hub batching reduced the largest observed sample to 712 ms / 20 deliveries.
The final combined guest/log repeat measured a 196 ms median and a 627 ms maximum.
These forced-collection samples are not comparable to unstressed medians or estimates of p99.
The [GC-batching note](mail-gc-batching.md) retains the initial candidate, final repeat, raw traces,
and sunbursts, including the less favorable repeat outlier.
Next investigate durable commit grouping, full-heap GC cost, and instruction attribution in guest
execution; do not relax finalizer behavior or disk-before-delivery ordering to meet a target.


## Completed-crank transfer batching

The [durable transfer experiment](mail-durable-transfer-batching.md) carries each native crank's
existing output array through the transport into one hub transaction, retaining individual replay IDs.
It also defers final outbox cleanup for journaled worker receivers until the next necessary commit.
The fresh seven-send sample median falls from 216.919 ms to 185.444 ms with atomic hub persistence;
steady hub commits fall from ten to six, with one receiving journal append remaining.
The experimental append log reduces the combined median further to 156.608 ms.
These unstressed trials are separate from the previous forced-GC experiment and do not establish
improved tail latency.

The implementation keeps existing guest execution, finalizer behavior, persisted formats, and
receiving journal cadence.
Replay and failure tests cover the new transaction grouping and deferred accepted tail.
Receiver-side journal batching is deferred: the selected path has only one append, so a new batch
record format or partial-append recovery mechanism would add complexity without saving a write.
Future proposals should state their expected saved operations and measured benefit alongside their
additional state, interfaces, formats, and failure cases.


## Disposable observers and storage backends

The [observer outbox experiment](mail-observer-outbox.md) identifies four remaining hub commits as
progress records for a disposable, nonresumable native observer.
An explicit discard-on-restart policy retains commit-before-publication and ends ambiguous observer
delivery, while keeping progress in memory until the next necessary commit.
It applies to unique transient clients and native adapter sessions; worker and resumable peer
outboxes retain their existing replay behavior.

The fresh atomic-store median falls from 190.458 ms to 145.162 ms, with two steady hub commits and
one journal append instead of six hub commits and an append.
The disposable append log reaches 132.561 ms and SQLite WAL with FULL synchronization and macOS
fullfsync reaches 136.389 ms.
An initial 122.868 ms SQLite result is excluded as a durability-equivalent comparison because it
omitted the separate fullfsync setting that matches Node/libuv's requested sync strength on Darwin.
Neither storage prototype is promoted into the normal daemon.

The retained runtime policy reaches three host durability commits without a new persisted format.
A shared transactional hub/inbox store could remove the remaining approximately 4 ms journal sync,
but adds transaction and recovery coupling; it is deferred in favor of the much larger remaining
VM execution and collector costs.

## Detailed native phase evidence

The [isolated VM profiling experiment](mail-vm-detail.md) keeps production sources unchanged and
subdivides the 156 ms median sample into per-round GC phases and initial script versus promise jobs.
The initial script takes 5.7 ms and 51 reaction jobs take 53.5 ms.
Two GC rounds take 67.4 ms, primarily marking (34.6 ms), sweeping (14.8 ms), and chunk compaction
(14.0 ms); roots, weak/ephemeron processing, and side-ledger work are small in this sample.
The two collector rounds traverse nearly the same live graph but reclaim different garbage.
No GC schedule change is justified by that observation alone.
Fine tracing has no detectable overall median increase in this small same-source enabled/disabled
comparison; subgroup noise prevents a tight overhead bound.
Native builtin versus interpreter time inside promise handlers remains unpartitioned.
