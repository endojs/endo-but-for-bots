# Ironhorse performance in ordinary Thixotrope workloads

The November release measurements used worker `367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25`, the allocation GC policy and a 50-million-computron crank budget. The mail release benchmark has four clients, eight recipient sessions and a paged operator inbox. A completed post includes the recipient's scripted turn and dismissal of its reply. [Mail contract, section 10](m9-interfaces.md#10-performance-fixed-windows-perf_window_scale-scales-them)

## Where to start on the current mail workload

**Profile mark traversal and the work done for each reclaimed slot.** A November 20 capture ran the three stock 60 s prefix phases on the same daemon as a 15 s four-client traffic window. It used the guest sources from `69997bd0c5`, the normal allocation schedule and a locally built phase-timing worker. All 46 posts completed and were dismissed in 16.357 s (2.812/s). Every factory reply matched exactly one native request. Seven of the 46 collected, each in two rounds. The other 39 did no collection.

| Median collecting reply, by total collector time | First round | Follow-up after finalizers |
|---|---:|---:|
| Whole collection | 195.900 ms | 68.741 ms |
| Mark slot and side-table edges | 71.000 ms | 62.192 ms |
| Sweep slots and run reclaim hooks | 115.644 ms | 2.195 ms |
| Enumerate roots | 0.139 ms | 0.065 ms |
| Compact chunks | 1.372 ms | 1.112 ms |
| Late side-table pruning | 4.490 ms | 0.113 ms |
| Slots reclaimed | 158,359 | 2,106 |
| Slots marked / edges visited | 89,448 / 146,986 | 89,457 / 146,994 |

These are two rounds of the *same* selected reply. Both scanned a capacity of 732,334 slots and gathered 919 roots. Across all seven collecting replies, the first sweep cost 97–120 ms, compared with 2.2–3.2 ms on the follow-up. The sweep timer includes dead-slot table cleanup. The CC-133 experiment below times all reclaim work on both sides and tests a bulk cleanup of those tables. Both rounds traced almost the same live graph, which also makes mark traversal a candidate for reducing recurring work. Collection time over the window totaled 3.175 s in factory row changes, 1.840 s in factory replies and 1.837 s in factory sends. The crank that triggers collection can pay for earlier allocations. [Slot sweep](../../../rust/engine/ironhorse-vm/src/value.rs) · [Reclaim hooks and early/late table pruning](../../../rust/engine/ironhorse-vm/src/interp/gc_tables.rs) · [Mark and compaction](../../../rust/engine/ironhorse-vm/src/gc.rs)

**Trace the previous recipient crank when an acknowledgment is slow.** Across 101 instrumented operator sends, median ACK was 140.378 ms when neither the factory nor the recipient collected (39 sends), 226.705 ms with confirmed recipient collection only (29), 336.739 ms with factory collection only (7), and 364.314 ms with both (24). In two other sends the recipient collection crossed a timing boundary and could not be placed precisely. For the overall median send (210.613 ms), a previously running recipient crank occupied the first 81 ms and the factory did no collection. The factory's send, the recipient's delivery, the factory row update and the returned receipt still followed. Each measured ACK ends at the caller's receipt. Observer timings are diagnostic. The uninstrumented 60 s release median for this source was 216.441 ms. [Release and workload comparison](../JOURNAL.md#j-12552-2026-11-20-wxf-exact-sizing-comparisons-and-full-factory-result)

**Measure the host separately.** During those 46 traffic posts, the hub handled 687 inbound delivery calls and 1,390 frames. Its synchronous delivery time totaled 7.947 s, including 5.127 s in 939 persistence calls and 2.551 s in 1,194 send calls. Serialization accounted for 0.297 s inside persistence. The log recorded 890 appends and five compactions. These timers include nested work, and worker and hub activity can overlap. For host-side improvements, time the log delta computation and the write inside the storage call before changing either one. [Hub counters](../../thixotrope/src/net/hub.js) · [Hub log store](../../thixotrope/src/store/hub-log-store.js)

The compact phase record includes both worker and bundle digests, the exact counters, the timing boundaries and the capture hashes. Both local branches are retained in the harness Git repository. Run this from its root to read the record and inspect the workload overlay.

```sh
git show 59369d4afee4:rust/engine/benches/results/thixotrope-warm-factory-gc.json
git show --stat 419e73c1b471
```

## Collections in the four-delivery forwarding path

All 71 forwards in a pinned-worker trace took four causal vat deliveries from sender round
final to recipient provider request. The fourth was the recipient's permission to dispatch
round zero. It durably distinguishes a turn interrupted before dispatch from one whose
provider outcome is unknown. The sender's receipt and the recipient's eventual reply can
consume queue time independently. Counting every worker delivery between the two clocks
would mix that traffic with the four prerequisites.

On this workload the median rose from 203 ms for 25 forwards with no collection in those
cranks to 447.5 ms for the 46 with at least one. Median guest execution was highest in
the recipient's delivery (46.42 ms) and the sender's round final (32.45 ms). The
factory post had only 11.63 ms of median guest execution, yet its 15 collecting
cranks spent 220.15 ms median in collection. For an engine experiment, inspect allocations
in the preceding cranks of the same vat, then compare the collector frequency, conditional
cost, endpoint median and p95 on the full warmed sequence. The host queue observer
independently matched all 142 transitions between the sender, factory and recipient.
[Forwarding trace and cohort sizes](../JOURNAL.md#j-12568-2026-11-20-m9-four-deliveries-on-the-pinned-forwarding-path)

Asking a child shows a similar split. The parent's tool-call to result overhead excludes
the child's own live turn. Across 55 asks on the guarded delegation-class guest, 24 had no
collection in the factory ask, child delivery, factory reply post or parent receipt.
Their median overhead was 171.5 ms. The other 31 measured 387 ms.
In the spawn prefix, the spare's session initialization averaged 731.8 ms of host crank
time across 12 spawns, including 326.4 ms guest execution and 379.5 ms collection.
Time the creation of the spare and its user-specific initialization separately when
testing an optimization. The per-ask and per-spawn observations are available locally
at `45e764f2eb:packages/thixotrope-harness/designs/subagent-performance/`.
[Subagent control and candidate](../JOURNAL.md#j-12569-2026-11-20-m9-delegation-classes-and-forwarded-mail-candidates)

## A return trip the application could remove

The automatic reply to a completed package sent a checked `Outbox.post` and discarded both the answer and any rejection. On this one path, `E.sendOnly(mail).post(...)` sends the same ordered reply with its body, attachments and postmark, without allocating an answer route back to the recipient. An application refusal is still handled by the receiving method. Unexpected receiver rejections use the ordinary one-way receiver diagnostic. Operator sends and the model's send/reply tools still need and receive their receipts. [Package settlement](../guest/session/inbox.js) · [Mail contract](m9-interfaces.md#31-factory-vat-guestfactorypost-officejs-operator-mailjs-subagentsjs)

On the pinned worker, the immediately preceding full run recorded 216.441 ms ACK and 168 completed posts in 61.282 s (2.741/s). The one-way automatic reply recorded 160.827 ms and 196 in 61.059 s (3.210/s) in the same unscaled benchmark, including the final dismissal drain. Fresh hub growth was 0.968×. Session-to-session delivery was 359 ms against 300 ms. Both runs used the same factory code. This is one full run per revision; the measured difference includes run-to-run variation. For other mail operations, first establish whether any caller consumes a result or depends on its failure before considering a one-way send. [Release measurements](../JOURNAL.md#j-12553-2026-11-20-wxf-pinned-worker-meets-ack-and-throughput-together)

## Earlier factory and startup measurements

| Observation | Workload and evidence | What to investigate |
|---|---|---|
| Collection delayed a ready acknowledgment | In a short trace on the earlier factory, 13 of 14 warm sends collected during the factory's list-row update. The same 14 cranks had medians of 251 ms host wall, 220 ms native collection and 14 ms guest execution. [J-1458](../JOURNAL.md#j-1458-2026-11-19-wxf-factory-collection-during-ordinary-mail-receipts) | Allocating in one crank can make a later crank pay for collection. Correlate the worker reply with the receipt that was waiting and inspect the preceding cranks. |
| Reply handling repeatedly paid for full collections | In a 15 s diagnostic on the released mail implementation, 45 completed posts took 16.435 s including drain. Across 45 factory reply cranks, host wall totaled 6.624 s, native collection 4.969 s and guest execution 0.837 s. Nineteen cranks collected twice each. The median **combined** collection time for those 19 was 257 ms. The other 26 performed no collection. | Profile the first collection and the follow-up after finalizer notification separately. Inspect the cost of scanning the slot arena as well as tracing live objects. |
| Guard construction can dominate creation | In the paired pinned-session diagnostic, preparing the same interface guards while the spare was built moved the session's make crank from 699 to 313 ms. Guest execution fell from 308 to 132 ms and collection from 365 to 162 ms. The isolated candidate's full voice startup median was 977 ms across 13 launches (950 ms target). [J-12112](../JOURNAL.md#j-12112-2026-11-19-candidate-creation-and-environment-confirmation) | Measure allocation from constructing guarded objects. Compare reusing the class with constructing it on every invocation, while preserving the method guards and each instance's private state. Also measure spare preparation. |

The method-level traces used temporary host instrumentation. For each factory or session delivery, they recorded the vat identity, method names and the host's request and completion timestamps. The worker's `timing: true` reply covers compilation, guest execution, collection, notification and extraction. Join a reply only when exactly one request for the same vat lies inside that host delivery. Group collecting and non-collecting cranks separately. Record phase totals across the same sample and preserve the distinct count of collection rounds.

The full mail benchmark and the instrumented diagnostics use different windows. Under the same release implementation the full exclusive benchmark recorded 146.447 ms median acknowledgment and 2.670 completed posts/s. A trace of one recipient or one vat cannot establish aggregate throughput. Different vats can execute at the same time. [Full mail measurements](../JOURNAL.md#j-12549-2026-11-19-wxf-fresh-mail-growth-baseline)

The four-window comparison of single-recipient delivery identifies a shared bottleneck. Taking the union of the matched host-delivery intervals for the single factory vat covered 99.55–99.62% of each traffic window, including its final drain. In the two candidate windows, 328 and 314 factory cranks occupied 16.772 and 16.775 s. Of those totals, collection accounted for 8.718 and 9.106 s, and guest execution for 3.280 and 3.189 s. The factory handled 104 and 100 session-row updates for 52 and 50 completed posts. This makes factory wall time per completed post a useful comparison even when load is spread over eight recipients. [Matched workload and delivery rates](../JOURNAL.md#j-1478-2026-11-19-wxf-single-recipient-mail-comparison)

The two 60 s fresh-daemon runs at the end of the factory comparison also show the collection cadence. All 118 collecting factory cranks on the control and all 133 on the candidate ran two rounds. The median gap between collecting cranks was nine factory deliveries on each side. Record both the collection trigger and work in each round when evaluating a change to the VM. [Factory comparison](../JOURNAL.md#j-12552-2026-11-20-wxf-exact-sizing-comparisons-and-full-factory-result)

## Measuring comparable collections

The October `measure-mail.mjs colocated` study first measured these phases on a single core-mail send. Of 67.411 ms in GC, marking took 34.638 ms, sweeping and its reclaim hooks 14.811 ms, and chunk compaction 13.991 ms. Its first sweep reclaimed 36,577 slots and its second reclaimed 568. Both spent about 17 ms marking. Promise-job drains accounted for 53.545 ms of the initial 59.299 ms execution interval across 51 reactions, including their handlers. That worker collected after every successful crank. CC-132 reused the five VM instrumentation hunks and adapted the worker scopes to the allocation schedule. [October core-mail measurements, raw traces and profiler](../../thixotrope/designs/mail-vm-detail.md)

- Follow `sweep_and_notify` across every round and intervening notification. Record whether the slot threshold, chunk threshold or crank interval fired. The stock `collectUs` sums all rounds. [Worker schedule and clocks](../../../rust/thixotrope-ironhorse-worker/src/main.rs)
- Record the live graph and arena capacity as separate quantities. An earlier factory capture had median 83,242 allocated slots at the end of its collecting reply deliveries, after outbound extraction, in an arena with capacity 676,688. The post-extraction count includes new allocations made there. Measure root enumeration, marking, reclaim hooks and chunk remapping at their own boundaries. [Roots](../../../rust/engine/ironhorse-vm/src/interp/roots.rs) · [VM collector](../../../rust/engine/ironhorse-vm/src/interp/gc.rs)
- Compare different amounts of garbage against the same retained graph. Include a small-dead-set case and count all work that moves between phases. Check finalizer order, reclaimed state and replayed frames before measuring a real mail turn. The worker drains finalizers before taking outbound frames. [Collection and replay constraints](../CORE-CHANGES.md#cc-022-2026-11-17-ironhorse-worker---collect-garbage-on-an-allocation-schedule)

## Read the hub and the worker meters separately

In two 60 s traffic windows, each completed post produced about nine outbound frames from the factory. Native outbound extraction took 2.05 and 1.87 ms per completed post. After the worker had answered, the host's synchronous JSON parse and outbound batch callback took 63.33 and 55.88 ms per post. These sums cover all matched factory cranks (1,081 and 1,214, for 172 and 193 posts). The callback decodes base64, assigns sequence numbers and hands the batch to the hub. The trace does not separate those operations or time individual storage writes. Profile that callback before optimizing the native extraction bridge for small mail. The earlier core experiment already carries all frames of a crank in one transaction. [Engine boundary](../../thixotrope/src/ironhorse/ironhorse-engine.js) · [Durable transport](../../thixotrope/src/core/durable-worker-transport.js) · [Crank transfer batching](../../thixotrope/designs/mail-durable-transfer-batching.md)

The hub image and write-ahead log describe persisted hub storage. In the first three full mail comparisons, fresh-state growth was 0.605×, 1.101× and 2.103×. In the third run the starting log was only seven records past compaction. Its physical log ended 261,565 bytes larger after 325 posts, while its image grew 38,691 bytes. Compare each component at both ends, including the number of natural compactions and pending log records. For a VM collection question, use per-worker slot, chunk and timing measurements instead. [Full mail baseline](../JOURNAL.md#j-12549-2026-11-19-wxf-fresh-mail-growth-baseline) · [Single-recipient follow-up](../JOURNAL.md#j-1478-2026-11-19-wxf-single-recipient-mail-comparison)

## Local collector and worker experiments

**Batch cleanup of dead owners.** The CC-133 prototype records reclaimed slot indices while the arena performs its usual sweep. Before collecting live chunk references, it filters the 22 early side tables once using the existing bulk retain rules. The same set drives late pruning at its original point. This keeps the free-list insertion order, per-reference decrements and the partial collector’s behavior. Read the prototype with `git show 08d3b7a17b` on `codex/mail-batch-early-gc`. [Early and late side-table inventory](../../../rust/engine/ironhorse-vm/src/interp/gc_tables.rs)

On three independently rebuilt retained/discarded object heaps, baseline → candidate first-collection times were 3.252 → 1.609 ms, 12.835 → 5.997 ms and 52.446 → 24.704 ms at capacities of 31,107, 121,107 and 481,107 slots. Immediate repeat times changed by 0.7–2.1%. With exactly one dead slot among 8,192 live arrays, the candidate was slower, from 0.887 to 0.953 ms. Each value averages two within-run medians in baseline/candidate/candidate/baseline order, with 21 samples per run. All 81 targeted engine checks and six ordinary worker replay, metering and finalizer checks passed.

The same warmed 15 s traffic workload on the profiled CC-133 worker produced the following comparison. Each side used the same guest revision, client count, session setup and clock boundaries. The candidate sweep clock includes the full bulk cleanup call.

| Warmed traffic at guest `69997bd0c5` | Stock collector with profiling | Batched cleanup with profiling |
|---|---:|---:|
| Completed and dismissed posts / elapsed | 46 / 16.357 s | 59 / 16.302 s |
| Throughput | 2.812/s | 3.619/s |
| Factory replies collecting twice / replies measured | 7 / 46 | 11 / 59 |
| Median collecting reply, all collection rounds | 264.640 ms | 140.211 ms |
| First sweep including cleanup, on the selected reply | 115.644 ms | 8.082 ms |
| Second sweep including cleanup, on the same reply | 2.195 ms | 1.122 ms |
| Reclaimed slots, first round | 158,359 | 150,306 |

Across every collecting reply, the measured first sweeps were 97.239–119.934 ms on the baseline and 6.552–8.082 ms on the candidate. First-round marking still took 64.383–73.534 ms and 60.089–73.954 ms respectively. The selected first rounds had similar capacity (732,334 and 732,014 slots), with 89,448 and 80,803 marked slots. The faster worker completed more work during the fixed-duration prefix. Read the paired measurements, binary provenance and test records in the local harness repository with the following command.

```sh
git show codex/mail-batch-early-gc:rust/engine/benches/results/thixotrope-batch-early-sweep.json
```

**Full run on the uninstrumented worker.** The same `e4dafe639d` guest, stock windows and eight-recipient driver ran to completion on both workers. Both benchmark processes exited 0. The release uses the pinned worker. The experimental worker was built from a clean target and its binary digest and absence of profiling probes were verified.

| Full release workload | Pinned worker | CC-133 research worker |
|---|---:|---:|
| Operator ACK median (sends) | 160.827 ms (102) | 198.865 ms (133) |
| Operator ACK p95 | 469.584 ms | 325.706 ms |
| Completed posts / elapsed | 196 / 61.059 s | 244 / 61.060 s |
| Completed posts per second | 3.2100 | 3.9960 |
| Session-to-session median (strict target 300 ms) | 359 ms | 318 ms |
| Inbox p95 upper bound (limit 550 ms) | 500 ms | 300 ms |
| Fresh hub ratio (attachment posts) | 0.968× (375) | 1.027× (487) |

The research worker completed 48 more posts in almost the same time. Median operator ACK rose while p95 fell. Both medians met the 200 ms ACK target. These are individual full runs under different host loads. The phase comparison identifies the specific collector work that became cheaper. Review the small-reclamation tradeoff alongside the warm throughput gain. The final source, test results and both benchmark records are preserved at `7f3ac522cbfc` on the local research branch.

**Reuse mark traversal storage.** In `collect_full`, a visited slot's outgoing edges are gathered before the mutable mark step. Local commit `59dabaf09a` reuses one vector and drains it in the same order. The buffer stays alive until collection returns, so a wide node can determine its peak capacity. The change leaves the collection schedule, finalizer order and slot sweep order intact. The branch `codex/mail-gc-edge-scratch` is available in the harness Git repository. [Collector source](../../../rust/engine/ironhorse-vm/src/gc.rs) · [Existing heap benchmark](../../../rust/engine/ironhorse-snapshot/tests/gc_bench.rs)

The optimized benchmark ran baseline, candidate, candidate, baseline, with 21 independently rebuilt object graphs per heap size per run. Each graph retains a collection of two-property objects and drops an equally large collection. Values are the mean of the two within-run medians for each side. These microbenchmarks shared the host. They overlapped part of the later class-only release benchmark’s acknowledgment window, which limits cross-run attribution.

| Slot capacity | First full collection, baseline → candidate | Immediate repeat, baseline → candidate |
|---:|---:|---:|
| 31,107 | 3.276 → 3.056 ms | 1.061 → 0.832 ms |
| 121,107 | 12.718 → 12.014 ms | 3.819 → 2.987 ms |
| 481,107 | 51.972 → 48.422 ms | 15.183 → 11.626 ms |

The synthetic first collection improved 5.5–6.8%, and immediate repeats improved 21.6–23.4%. Peak process RSS ranges overlapped at about 553–556 MiB across the whole benchmark. All 48 targeted graph, checkpoint, weak-reference and finalization tests passed. A mail worker's second sweep follows guest finalizers, so the immediate-repeat percentage cannot be applied to those mail cranks.

An exclusive end-to-end comparison kept the harness at `ecc7171aa2`. It built both research workers with the same offline release compiler and path and ran the existing mail benchmark with 15 s windows and a fresh fixture for each worker. Runtime configurations differed only in the worker digest. Both runs used the release JS bundles, four clients, eight recipients and the final dismissal drain.

| Ordinary mail on the research worker | Baseline | Mark-buffer reuse |
|---|---:|---:|
| Operator ACK median (sample count) | 143.499 ms (25) | 146.422 ms (26) |
| Operator ACK p95 | 560.666 ms | 376.909 ms |
| Completed posts / elapsed | 51 / 16.318 s | 50 / 16.376 s |
| Completed posts per second | 3.1254 | 3.0532 |

The candidate completed one fewer post. The synthetic collector gain did not translate into better median acknowledgment or completed throughput in this pair. The tail comparison has only 25 and 26 observations. The separate fresh-growth row measured 0.338× and 1.757× from different compaction positions, yielding benchmark exits 0 and 1. The release worker remains pinned. The local baseline binary began with SHA-256 `a9944cfec92c` and the candidate with `62c58b84ee78`. The baseline worker and engine sources match the pinned build, while the research binaries embed a different build path.

**Observe individual sweeps.** Local worker commit `3646bd8307` adds `timing.gcRounds` to timing-enabled deliveries. Each item gives `collectUs` and `notifyUs`; a null notification duration means the round ran no notification pass. It uses the clock readings that already produce the totals. An ordinary delivery allocates no vector storage for these fields. The bounded host test produced the same ordered frames for timed and untimed delivery. Two fresh worker processes also agreed under both the allocation and every-crank policies. The per-round figures summed to the existing collection and notification totals. The diagnostic is available on the local branch `codex/thix-worker-sweep-timing` (CC-131), independently of the mark-buffer experiment (CC-130). Read either patch with `git show 3646bd8307` or `git show 59dabaf09a` in the harness checkout. [Worker delivery and finalizer code](../../../rust/thixotrope-ironhorse-worker/src/main.rs)

## Reproducing the workload

In each isolated core checkout, this runs the existing collector benchmark used above. Build the baseline and candidate first, then time the two resulting executables in counterbalanced order under the same machine reservation.

```sh
RUST_MIN_STACK=33554432 cargo test --offline --release -p ironhorse-snapshot \
  --test gc_bench -- gc_cost_across_heap_sizes --ignored --nocapture --test-threads=1
```

For a repeatable starting point in the harness package, `corepack yarn exec node perf/crank.perf.mjs` measures direct-worker boot and session costs. The mid/late variants exercise larger sessions. `corepack yarn exec node perf/mail.perf.mjs` runs the release workload. Use the documented pinned worker, dependencies and a short `THIX_HARNESS_TMP` path. Keep the native worker timing, host request-to-reply time, outbound processing and end-to-end receipt time as separate measurements. [Worker benchmark](../perf/_crank.mjs) · [Run and fixture conventions](process.md)

## Byte costs depend on who reads the data

For bulk data that a vat forwards untouched, the reference prototype sent about 230 bytes per hop into the first vat at payload sizes from 1 KiB to 64 MiB. Its three-hop vat journals grew by 0.7–0.9 KB. The hub still wrote 30–36 KB of bookkeeping for the three hops. The producer wrote the payload and the consumer read it. This points to hub row writes for forwarding, and to the VM's inbound byte handling when a vat actually reads a page. The ordinary mail trace used small messages and still incurred repeated collections without attachments. [Data-reference measurements and engine options](spike-data-references.md#31-on-the-shared-benchmark)

There is also a smaller byte cost inside a vat. The harness uses `TextEncoder.encode(text).length` to count exact UTF-8 bytes in strings and record keys. Ironhorse already calculates that length, then encodes the data and creates a guest byte array. Count-only callers discard that array. A guest-side experiment returned the length directly for short ASCII strings after a regular-expression test. Although its Unicode boundary tests passed, the measured 60 s traffic window fell from 179 posts in 62.141 s (2.881/s) to 165 in 61.592 s (2.679/s). Across all factory cranks, guest execution rose from 64.69 to 88.43 ms per completed post. Host load also rose. The experiment was set aside. A native count-only operation would need separate workload measurements, the existing input metering and the unpaired-surrogate rules. [Harness byte accounting](../guest/lib/bounded.js) · [Ironhorse UTF-8 implementation](../../../rust/engine/ironhorse-vm/src/interp/natives/utf8.rs)
