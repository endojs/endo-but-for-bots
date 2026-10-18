# Fine-grained colocated mail latency

Measured on 18 October 2026 using disposable state, the colocated mailbox experiment, incremental
entry subscriptions, and batched hub head sequences.
The running user's workspace and normal native worker were left unchanged.
The run used Node 22.21.1 on macOS arm64.

![Fine-grained colocated mail sunburst](mail-latency-colocated.svg)

The updated figure uses the median elapsed-time trial of seven combined-operation sends:
**364.448 ms**, down from **417.969 ms** in seven fresh baseline sends (**12.8%**).
It ends when both send acceptance and a pushed inbox state are available to the service.
It excludes HTTP, browser rendering, and physical screen presentation.
Every trial is retained in the [combined raw trace](mail-latency-colocated.trace.jsonl) and
[baseline raw trace](mail-latency-colocated-before-combined.trace.jsonl).
The [combined derived data](mail-latency-colocated.json),
[baseline derived data](mail-latency-colocated-before-combined.json), and
[baseline chart](mail-latency-colocated-before-combined.svg) permit direct inspection.
These are small sequential samples, not estimates of tail latency.

## Combined operation and finalizers

The new native `deliver` operation executes dispatch and its promise jobs, then the existing
collection and finalizer cascade, then extracts outbound frames with a separate crank budget.
Finalizer callbacks and their promise jobs finish before extraction, so their messages travel in
that delivery's returned batch.
There is no collection after extraction.
The trusted bootstrap outbox holds JSON-parsed frame data; extraction cannot invoke guest getters
or register finalizers, and its unregistered bridge temporaries can be reclaimed next crank.
The two source units still compile and execute separately inside one native request.

The ready record advertises `deliver-v1`.
The host retains its original two-request schedule for pinned older workers, preserving their
replay behavior and runtime compatibility checks.
No heap-profile mismatch is bypassed to run these experiments.
The combined binary and its timing-only build ran only against disposable state.

Tests cover finalizer-generated messages, cleanup promise jobs, six-round finalizer cascades,
checkpoint/restore without duplicate output, endless-cascade refusal, extraction budget exhaustion,
and combined versus legacy handshake selection across snapshot/relaunch.
All 17 Rust tests and six selected native integration/recovery tests pass, including settled-answer
reclamation and SIGKILL recovery at output and snapshot boundaries.
The seven runtime-limit tests, package typecheck, and changed-file formatting checks also pass.
Changed source/test ESLint reports zero errors.

## Where the time went

| Exclusive wall-time category | Separate dispatch/drain | Combined delivery |
| --- | ---: | ---: |
| VM only | 228.667 ms | 193.958 ms |
| Filesystem only | 161.041 ms | 163.073 ms |
| Filesystem and VM concurrently | 21.363 ms | 0.391 ms |
| Explicit host JS only | 1.967 ms | 2.179 ms |
| Explicit host JS and VM concurrently | 0.204 ms | 0.000 ms |
| Other / unmeasured | 4.728 ms | 4.846 ms |
| Total | 417.969 ms | 364.448 ms |

These categories partition wall time and can be summed.
The following diagnostic totals overlap and must not be added to that table:

| Diagnostic | Separate dispatch/drain | Combined delivery |
| --- | ---: | ---: |
| Dispatch GC, including finalizer cascade sweeps | 110.353 ms / 4 rounds | 113.480 ms / 4 rounds |
| Post-extraction GC | 62.879 ms / 3 rounds | 0 ms / 0 rounds |
| Execution and promise jobs, excluding extraction | 71.392 ms | 75.785 ms |
| Finalizer callbacks | 2.184 ms / 2 rounds | 2.226 ms / 2 rounds |
| Outbound extraction execution | 1.084 ms | 0.739 ms |
| Compilation / relinking, including extraction | 2.342 ms | 2.120 ms |
| Hub state replacements | 173.432 ms / 18 writes | 154.596 ms / 16 writes |
| Worker journal appends | 8.887 ms / 2 appends | 8.771 ms / 2 appends |

The removed collection accounts for 62.879 ms of VM phase time in the selected baseline interval,
but some previously overlapped filesystem work.
The complete wall saving is 53.522 ms; concurrent work and changed scheduling prevent treating
removed phase time as an equal end-to-end saving.
The host persistence implementation has not changed in this experiment.
The lower selected hub-write count is an observed result, not a separate batching implementation.

The baseline interval contains two dispatch evaluations and three extraction evaluations;
the combined interval contains two native delivery requests.
Intervals can include work already queued at their start or end during a request.
These are interval counts, not a claim that every send intrinsically needs that many requests.
Collector rounds and finalizer callback rounds are measured separately.
Their elapsed times are not CPU samples.

## Remaining costs

The combined causal stages are 135.760 ms resolving the contact, 228.658 ms sending and awaiting its
response, and 0.029 ms of bridge completion.
The baseline stages were 170.600 ms and 247.344 ms, plus 0.026 ms of bridge completion.
The web service still calls `E(contacts).get(name)` before `E(book).send(contact, content)`.
The pushed contact stream already supplies those references.
A subsequent change should capture the reference at recipient selection and send an opaque
selection token, as the UI already does for included values.
That would remove this extra remote lookup; its end-to-end saving still needs measurement.

Persistence remains dominated by synchronization rather than JSON encoding.
The selected combined send includes 16 hub file fsyncs, 16 directory fsyncs, and two journal fsyncs.
The combined VM still spends 113.480 ms in four dispatch/cascade collector rounds.
The existing plan for batched durable delivery ownership remains relevant.
The provisional 50–100 ms target is not met.

## Samples and measurement limits

Fresh baseline samples were 405, 411, 418, 410, 421, 428, and 437 ms.
Combined samples were 364, 1,611, 353, 363, 364, 366, and 376 ms.
The 1,611 ms combined trial recorded 77 worker deliveries and 20 hub writes;
the others recorded two or three deliveries and 16 writes.
All samples reported zero worker wakes and zero snapshots.
The extra activity is retained and remains unclassified; the median improvement does not fix
this tail-latency problem.

A separate seven-send calibration with the combined binary and host instrumentation, but without
native phase timing, had a **367.356 ms** median.
Samples were 366, 369, 1,626, 366, 373, 367, and 367 ms.
The outlier again recorded 77 deliveries, this time with 21 hub writes, zero wakes, and no snapshots.
Every calibration result is retained in the combined trace header.
The 2.908 ms median difference is within run-to-run variation; it does not prove zero timing cost.
An earlier unchanged-worker calibration already had a 2,741 ms / 73-delivery outlier, recorded in
commit `037747586`; excess activity therefore predates this combined operation.

## Collection and reproduction

The opt-in loader measures hub table serialization, JSON serialization, UI projection, and the two
send stages without editing production modules on disk.
The benchmark's own filesystem powers record open, write, fsync, rename, close, and scratch removal.
The timing-only native worker records compilation, execution/jobs, extraction, each collector
round, and each finalizer callback round, without changing collector behavior.
Worker, timing patch, and binary hashes are recorded in each raw trace header.

Node and worker events use high-resolution epoch timestamps; worker phase durations use a monotonic
clock anchored to epoch time at each phase start.
Every phase in the selected before and after trials matched a host request.
The largest selected request-envelope overruns were 0.303 ms before and 0.264 ms after.
Across all seven trials per variant, there were no unmatched phases; maximum overruns were
0.320 ms before and 0.274 ms after.
Interpret sub-millisecond differences cautiously.
The analyzer partitions at every event boundary and gives concurrent work its own sector.
Its leaves sum to the complete interval; 4.846 ms of the combined interval remains outside explicit
filesystem, VM, and host spans.

From the package directory, with the new native runtime and guest bundles built:

```sh
python3 scripts/build-mail-profile-worker.py /tmp/mail-phase-worker
THIX_MAIL_PROFILE=/tmp/mail-profile.json \
THIX_MAIL_PROFILE_WORKER=/tmp/mail-phase-worker \
THIX_MAIL_TRIALS=7 \
node --import ./scripts/profile-mail-loader.mjs scripts/measure-mail.mjs colocated
python3 scripts/mail-profile-sunburst.py /tmp/mail-profile.json /tmp/mail-profile-chart
```

The build helper temporarily applies the exact-source timing patch, builds and copies the profiling
worker, and restores source and the normal binary in a `finally` block.
It refuses a changed source hash rather than applying its zero-context patch to different code.
Set `THIXOTROPE_IRONHORSE_WORKER` to the matching normal binary if using a separate build path.
Omit `THIX_MAIL_PROFILE_WORKER` for calibration without native timing.
Run captures sequentially so they do not compete for storage.
The saved baseline uses the original pinned binary and its timing patch from commit `037747586`.

The analyzer accepts JSON or saved JSONL and selects the median trial by default.
Use `--trial N` to inspect another trial or `--segments` to retain every wall-partition segment.
Regenerating from the saved traces reproduces the SVG and summary.
The visibility metric is sampled after awaiting acceptance and is an upper bound on push arrival
when the inbox callback arrives before the send response.
Delivery counters are sampled through a subsequent status call and can extend slightly beyond that
endpoint; the native phase chart is clipped to the endpoint itself.
