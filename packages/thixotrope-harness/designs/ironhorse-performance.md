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

These are two rounds of the *same* selected reply. Both scanned a capacity of 732,334 slots and gathered 919 roots. Across all seven collecting replies, the first sweep cost 97–120 ms, compared with 2.2–3.2 ms on the follow-up. The sweep timer includes dead-slot table cleanup. Instrument that cleanup separately from scanning and freeing slots. Both rounds traced almost the same live graph, which also makes mark traversal a candidate for reducing recurring work. Collection time over the window totaled 3.175 s in factory row changes, 1.840 s in factory replies and 1.837 s in factory sends. The crank that triggers collection can pay for earlier allocations. [Slot sweep](../../../rust/engine/ironhorse-vm/src/value.rs) · [Reclaim hooks and early/late table pruning](../../../rust/engine/ironhorse-vm/src/interp/gc_tables.rs) · [Mark and compaction](../../../rust/engine/ironhorse-vm/src/gc.rs)

**Trace the previous recipient crank when an acknowledgment is slow.** Across 101 instrumented operator sends, median ACK was 140.378 ms when neither the factory nor the recipient collected (39 sends), 226.705 ms with confirmed recipient collection only (29), 336.739 ms with factory collection only (7), and 364.314 ms with both (24). In two other sends the recipient collection crossed a timing boundary and could not be placed precisely. For the overall median send (210.613 ms), a previously running recipient crank occupied the first 81 ms and the factory did no collection. The factory's send, the recipient's delivery, the factory row update and the returned receipt still followed. Each measured ACK ends at the caller's receipt. Observer timings are diagnostic. The uninstrumented 60 s release median for this source was 216.441 ms. [Release and workload comparison](../JOURNAL.md#j-12552-2026-11-20-wxf-exact-sizing-comparisons-and-full-factory-result)

**Measure the host separately.** During those 46 traffic posts, the hub handled 687 inbound delivery calls and 1,390 frames. Its synchronous delivery time totaled 7.947 s, including 5.127 s in 939 persistence calls and 2.551 s in 1,194 send calls. Serialization accounted for 0.297 s inside persistence. The log recorded 890 appends and five compactions. These timers include nested work, and worker and hub activity can overlap. For host-side improvements, time the log delta computation and the write inside the storage call before changing either one. [Hub counters](../../thixotrope/src/net/hub.js) · [Hub log store](../../thixotrope/src/store/hub-log-store.js)

The compact phase record includes both worker and bundle digests, the exact counters, the timing boundaries and the capture hashes. Both local branches are retained in the harness Git repository. Run this from its root to read the record and inspect the workload overlay.

```sh
git show 59369d4afee4:rust/engine/benches/results/thixotrope-warm-factory-gc.json
git show --stat 419e73c1b471
```

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

## A collector profile that would distinguish the costs

The older core `measure-mail.mjs colocated` study already splits two sweeps on one median send. Of 67.411 ms in GC, marking took 34.638 ms, slot sweeping and its reclaim hooks 14.811 ms, and chunk compaction 13.991 ms. The first sweep reclaimed 36,577 slots and the second reclaimed 568, yet both spent about 17 ms marking. Promise-job drains accounted for 53.545 ms of the initial 59.299 ms execution interval across 51 reactions, including the work those handlers performed. This was a core-mail send on an earlier worker. Collect the same phase breakdown on today's four-client harness before ranking VM changes by those percentages. Its saved traces, analysis script and opt-in Rust timing patch are already in the repository. The five VM source files instrumented by that patch match this release, and the VM hunks pass a dry-run apply. The older worker collected after each successful crank; adapting its integration to the current allocation schedule keeps that difference explicit. [Core mail phase measurements and reproduction](../../thixotrope/designs/mail-vm-detail.md)

In the 19 collecting reply cranks the factory had a median of 83,242 allocated slots at the end of the worker delivery, after outbound extraction, with arena capacity 676,688 throughout. This counter includes allocations made during extraction. This is a reason to measure work proportional to capacity separately from work proportional to reachable edges. The existing aggregate timer cannot tell which dominates. Root enumeration also walks function rows for lazy getter anchors. Measure the number of rows scanned and resulting roots before interpreting the mark time. [Root enumeration](../../../rust/engine/ironhorse-vm/src/interp/roots.rs)

1. Start at `sweep_and_notify`. For a timing-enabled delivery, record why the schedule fired (slot growth, chunk growth, crank interval, or multiple conditions). Record the per-round collection time, post-notification work and number of rounds. Today `collectUs` accumulates every collection in the crank. [Worker schedule and delivery timers](../../../rust/thixotrope-ironhorse-worker/src/main.rs)
2. Split `Interp::collect_garbage` into root enumeration, mark and ephemeron closure, dead-slot sweep, live chunk offset gathering and remapping, side-table cleanup and post-collection accounting. Record live slots before and after, arena capacity, edges visited and whether any offsets moved. The sweep and live chunk gathering traverse the arena's capacity. The offset rewrite runs when a remap exists. [VM collection entry point](../../../rust/engine/ironhorse-vm/src/interp/gc.rs) · [Collector](../../../rust/engine/ironhorse-vm/src/gc.rs) · [Slot arena](../../../rust/engine/ironhorse-vm/src/value.rs)
3. Compare heaps with the same live graph and different prior high-water marks, then compare graphs with similar capacity and different numbers of outgoing edges. Preserve root and finalizer order and the persisted collection schedule. Check reclamation, replayed outbound frames, worker latency and complete mail throughput. The worker drains finalizers before taking outbound frames, and recovery must emit the same frames at the same journal sequence numbers. [Existing design and replay constraints, CC-022/023](../CORE-CHANGES.md#cc-022-2026-11-17-ironhorse-worker---collect-garbage-on-an-allocation-schedule)

## Read the hub and the worker meters separately

In two 60 s traffic windows, each completed post produced about nine outbound frames from the factory. Native outbound extraction took 2.05 and 1.87 ms per completed post. After the worker had answered, the host's synchronous JSON parse and outbound batch callback took 63.33 and 55.88 ms per post. These sums cover all matched factory cranks (1,081 and 1,214, for 172 and 193 posts). The callback decodes base64, assigns sequence numbers and hands the batch to the hub. The trace does not separate those operations or time individual storage writes. Profile that callback before optimizing the native extraction bridge for small mail. The earlier core experiment already carries all frames of a crank in one transaction. [Engine boundary](../../thixotrope/src/ironhorse/ironhorse-engine.js) · [Durable transport](../../thixotrope/src/core/durable-worker-transport.js) · [Crank transfer batching](../../thixotrope/designs/mail-durable-transfer-batching.md)

The hub image and write-ahead log describe persisted hub storage. In three full mail runs, the fresh-state growth ratios were 0.605×, 1.101× and 2.103×. In the last run the starting log was only seven records past compaction. Its physical log ended 261,565 bytes larger after 325 posts, while its image grew 38,691 bytes. Compare each component at both ends, including the number of natural compactions and pending log records. For a VM collection question, use per-worker slot, chunk and timing measurements instead. [Full mail baseline](../JOURNAL.md#j-12549-2026-11-19-wxf-fresh-mail-growth-baseline) · [Single-recipient follow-up](../JOURNAL.md#j-1478-2026-11-19-wxf-single-recipient-mail-comparison)

## Two local implementation experiments

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
