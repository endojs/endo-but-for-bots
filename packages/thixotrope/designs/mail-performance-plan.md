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
removal with the next frame's sequence commit, followed by a final removal commit.
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
The subsequent [fine-grained capture](mail-latency-colocated.md) partitions a fresh 419 ms send and
identifies a 173 ms remote contact lookup that can be replaced with the already pushed reference.

## Validation of the first changes

The six nearest regression suites pass 48 tests in each of the three SES configurations.
They cover incremental values, rename and deletion, shared subscribers, reconnection, partial setup
failure, replay identity, gift ordering, and durable storage refusal.
The clean workspace declaration build, package typecheck, and all 14 type-contract projects pass.
Package source and test ESLint reports no errors.
The documentation build still reports the existing 102 errors and 190 warnings elsewhere in the
monorepo; no new Thixotrope documentation error was identified.
