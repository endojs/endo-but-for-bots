# Feasibility critique of architecture.md and milestones.md

Reviewer: sceptical feasibility pass, 2026-11-16. Paths are relative to
`/Users/xyz/Development/endo-thixotrope-harness` (HEAD `48d6f3e08b`); `pkg/` = `packages/thixotrope/`.
New measurements were taken for this review with the shipped release worker
(`target/release/thixotrope-ironhorse-worker`, built 2026-11-16 11:05) using
`scratchpad/thix/critique/probe.mjs` (a copy of `survey/perf-engine.mjs` with new probes; it ran
under `pkg/tmp/cq`, which was deleted afterwards). Each probe ran in a fresh vat at the default limits.
Guesses are marked [inferred].

## 0. Verdict

The overall shape is right: vats as the system of record, Node adapters as the data path, no token
through a vat, secrets only in the adapter, one vat per session. But the plan rests on one wrong
premise that touches every milestone. It assumes that once CORE-1 makes the JS `TextDecoder` linear,
256 k-character frames can enter a vat. Measurement says otherwise. Under the default 10 M-computron
crank budget, decoding alone halts the vat at roughly 64-98 KB per frame, even with a linear JS
decoder. Three causes stack up: the inbound base64 decode is also pure JS, the UTF-8 decode is
metered per byte, and the halt is a permanent quarantine. Section 1 lists the consequences: the
submission limit, `roundFinal`, tool-call arguments, `startRound` appends, tool output measured in
UTF-16 units, the W0.1 tests, and the M0/M2 acceptance tests that cannot pass as written.

Below that, there are six more blocking items: the viewer fan-out from the factory vat, outbound
frame bounds, the restart race in the acceptance tests, one physically impossible acceptance test,
an unrealistic `exec.sends100` budget, and ownership overlaps between parallel milestones that the
plan calls disjoint. Most of the rest holds up (section 2).

---

## 1. Blocking findings

### B-1. CORE-1 as specified cannot give 256 k-char (or even 64 k) safe frames; inbound bytes are metered twice in JS

Evidence:

- Inbound frames reach the guest as `{t:'f', b64}` and are decoded with `decodeBase64`
  (`pkg/src/core/worker-peer-xs.js:79`, the module the Ironhorse boot bundles at
  `pkg/scripts/bundle-ironhorse-worker.mjs:66-72`). `@endo/base64` uses native
  `Uint8Array.fromBase64` only if it exists (`packages/base64/src/decode.js:153-157`). **In a vat it
  does not.** Probe: `typeof Uint8Array.fromBase64` gives `undefined`, while
  `typeof Uint8Array.prototype.toBase64` gives `function`. So every inbound byte goes through
  `jsDecodeBase64` (`packages/base64/src/decode.js:35-80`), a per-character JS loop. The VM does
  implement the static method (`rust/engine/ironhorse-vm/src/interp/boot.rs:800-808`, tested in
  `rust/engine/ironhorse-vm/tests/es2024_intrinsics.rs:266-274`), and SES permits it
  (`packages/ses/src/permits.js:1341`). Something between VM boot and the vat compartment loses it
  [inferred: a static-method install defect; not traced].
- Then each Syrup string is decoded by the polyfill `TextDecoder` (`packages/ocapn/src/syrup/decode.js:28,146`).
- Measured in a fresh vat, default budget, each step alone, with no other work in the crank:

| step (in-vat JS) | 64 KiB | 96 KiB | 128 KiB | 192 KiB | 256 KiB |
|---|---|---|---|---|---|
| `jsDecodeBase64`-equivalent loop over the base64 of N bytes | ok | ok | **MeterAbort** | MeterAbort | MeterAbort |
| linear UTF-8 decode (array of code units, `String.fromCharCode.apply` per 4,096, `join`) | ok | **MeterAbort** | MeterAbort | MeterAbort | MeterAbort (1 MiB too) |

  That works out to roughly 75-100 computrons per byte for base64 and 100-150 per byte for UTF-8.
  A frame of N bytes therefore costs about 175-250 N computrons before the guest does any work, so
  **after a JS CORE-1 the safe inbound frame is about 32 KB**, and probably 40-55 KB at the very
  edge.
- Splitting the text into several strings does not help: an array of 8 strings of 4,096 chars
  (32 k total) **MeterAborted** today. 2 x 4,096 passed in 1.4 s. The ceiling is per frame (the
  architecture's fact 2 is right on this point).
- `survey/perf-engine3.log`: 64 KB, 256 KB and 512 KB string arguments all ended in **MeterAbort**,
  not HeapExhausted. The meter is the binding limit, not only the heap.

What is wrong in the plan:

- architecture §1.1 CORE-1 and §9 "Max frame into any vat 256 k chars (if M0 shows linear decode)";
  milestone W0.1 test "frames of 1 k..1 M chars into a vat do not halt"; M0 acceptance 1 (256 k
  echoed); M0 perf rows "`frames.inbound` 256 k: no halt". None of these can pass with a JS-only
  decoder at the default budget.
- "Deferred: native Rust TextDecoder" (milestones M0) must not be deferred, unless the budget is
  raised instead.

Fix options, which can be combined. M0 should choose with numbers:

1. Make `Uint8Array.fromBase64` reach the vat (an engine or boot defect; the native code already
   exists). This removes the base64 half of the cost.
2. Native `TextDecoder` (a Rust intrinsic, or have `TextDecoder.decode` call a native
   string-from-UTF-8). This removes the other half. It is a core change: flag it as CORE-1 proper.
3. Raise `THIXOTROPE_CRANK_BUDGET` daemon-wide, for example to 100-200 M. This is configuration only
   (pkg README 712-748: may change in either direction; lower only after a clean shutdown). A
   600 k-iteration loop costs about 80 ms of wall time at 10 M [inferred from
   `perf-engine3.log` loop timings], so a 10-20x budget still stops a runaway `exec` within about
   1-2 s. It also raises the "about 250 sends per crank" MeterAbort ceiling. The plan treats this
   only as a fallback for S3 (milestones M0 "Fit risk"). It should be the first lever, measured in S1.
4. Whatever the outcome, define every frame bound in **encoded UTF-8 bytes**, not characters or
   UTF-16 units. See B-2.

### B-2. Several protocol messages exceed any feasible inbound bound

At an assumed safe bound of about 32 KB per inbound frame (B-1), these protocol messages are
oversized:

- **Submission 200,000 chars** (§9, open decision 1, M2 acceptance "200 k-char submission
  accepted"). This is 6x over even after CORE-1. A large submission must be staged: the adapter
  keeps it as a blob, and the vat gets a handle plus a bounded preview, delivered in chunks of at
  most the bound, one crank each.
- **`roundFinal({ message, toolCalls, nativeContext, usage })`** (§4.1). The message alone may be up
  to 131,072 bytes (§5). Tool-call arguments are model-written (for example an `exec` body or a
  file to write), and `nativeContext` (thinking signatures, Codex encrypted reasoning) is opaque and
  can be tens of KB. All of it lands in one frame, so the vat is quarantined, and the quarantine is
  permanent for the conversation's system of record. The plan needs a rule: the adapter sends text
  as bounded deltas through `progress` (deltas, not cumulative text; §4.3 does not say which), and
  `roundFinal` carries only bounded fields. Oversized tool arguments or native context stay in the
  adapter as handles, or the round is failed with a recorded reason.
- **Tool output limit 32,768 UTF-16 units** (§9, R4-100). 32,768 units of CJK or emoji text is
  about 98 KB of UTF-8, and its base64 (131 k chars) alone MeterAborted in the probe. Cut in bytes
  at the adapter or callee, or lower the unit limit, and record the spec deviation in the journal.
- **History or context pages of 32-48 k chars** are outbound and fine (B-3), but `getTurnContent`
  and `Blob.read` answers flowing into a vat must stay under the inbound bound.

### B-3. Outbound frames from a vat also halt; the plan bounds only inbound

Probe: a vat returning `'x'.repeat(n)` worked at 15 k, 30 k and 60 k chars (127-170 ms) and
**killed the vat at 250 k and 1 M** (session retired). Outbound encoding is cheap per byte
(`toBase64` is native; `TextEncoder` is a linear JS loop, `rust/endo/xsnap/src/polyfills.js:22-70`),
but it is metered too. The plan has messages a vat emits that can exceed this:

- `startRound({ append: [records] })` (§4.5) after a round with several parallel tool results:
  8 x 32 k is about 256 k, so the **session vat** halts while sending it.
- archive `BlobStore.put` (§5: "<= 32 k chars" but §3.3 says "<= 64 k chars per call"; the sections
  disagree). If several puts are sent in one crank, they share that crank's budget.
- `listSessions` with many rows, watch snapshots: bounded at 64 k by budget; fine if enforced.

Required: a per-crank outbound byte budget in guest code (rule 12.8). `append` must be split across
cranks or replaced by a path that does not route bulk text through the session vat (see A-6).

### B-4. Viewer fan-out from durable vats leaks dead viewers and will quarantine the factory

§3.1: `watchSessions(viewer)` makes the **factory vat** push `E.sendOnly(viewer).update(diff)`
itself, and M4/M12 add `watchAccounts` and inventory watches with the same shape. Browser viewers
reach the vat as adapter-reexported CapTP presences. A `sendOnly` gives no feedback when the viewer
is gone, whether the tab closed, the page reloaded, or the adapter restarted. After a restart the
adapter's exports are tombstones, and sends to them "break" with no reply
(`pkg/src/net/hub.js:1917-1931`). So every reload adds a viewer that is never removed. Each send
costs about 4.6 ms of guest time, and about 250-500 sends in one crank MeterAborts
(tooling.md 4.5). A few hundred reloads turn a single row change into a quarantine of the
**factory**, which is the harness root.

D-8 already does this correctly for session events: the vat sends one `publish` to an adapter-side
`LiveChannel`, and fan-out happens in Node. Apply the same pattern to the session list, accounts,
and Home: the factory sends one coalesced `sendOnly` per crank to an adapter-side channel, and the
gateway fans out to sockets and drops them on WebSocket close. If a durable vat must hold viewers
at all, give them leases that expire and are dropped on `started()`.

### B-5. Restart acceptance tests conflict with how startup wakes workers

`pkg/src/core/daemon.js:826-847`: at startup every worker whose journal is longer than its last
snapshot cut is **woken and replayed**, whatever the application wants. A session vat is
checkpointed only at idle sleep (30 s, `pkg/src/control/supervisor.js:141`), every 256 deliveries,
or shutdown. Therefore:

- M1 acceptance 7 ("idle sessions created in the test were not woken") and M1 perf
  `restart.serving ... woken session vats = 1` fail unless the test waits at least 30 s of idleness,
  or calls `sleep()` on those vats, before SIGKILL. Spare-pool vats still being created in the
  background are also woken. The test must control this, or count only vats with a snapshot.
- D-5 itself is sound. Tombstoning the retired adapter session sends no frames to holders, only
  breaks to pending listens (`hub.js:1921-1949`), so idle vats that hold adapter references are not
  woken. The claim "0 idle session vats woken" holds only for vats that were checkpointed.

A related race (advisory, A-3): the `rowChanged` sendOnly that marks a row `working` can still sit in
the hub outbox when the factory runs `started()`. The factory then misses that session.

### B-6. M1 acceptance 4 is impossible as written

"Each `exec` sleeps 1 s; round < 1.6 s". `sleep(ms)` is the clock resource, and
`clock.after(0n)` already costs about 989 ms p50 from a vat (native.md §0.2; clock round trip
through the clock manager vat and its adapter). `sleep(1000)` therefore takes about 2 s, and the
round takes at least 2 s even if the two calls run fully in parallel. Use a tool whose delay lives in
the adapter (a scripted or fake tool), or assert overlap ("round < 1.6 x a single call") instead of
an absolute time.

### B-7. `exec.sends100 <= 2 s` ignores answered-send deliveries

M5 perf. If the exec body awaits 100 `E()` answers, each answer comes back as a **separate
delivery** to the exec vat (tooling.md 4.5: 100 answered sends per crank ran at 10 events/s, which
is 1,994 deliveries for 2,000). That is about 100 x 65 ms = 6.5 s, not 2 s. Budget about 7-8 s, or
measure `sendOnly` separately.

### B-8. "Disjoint" parallel milestones are not disjoint

Files that parallel milestones must edit but that no milestone in the group owns:

- **{M3, M4, M5}**: M3 "Owns `H/ui/` (all of it ...)" while M4 owns `ui/src/{secrets,accounts}` and
  M5 owns `ui/src/{presets,mentions}`. M4 and M5 UI work also has nothing to mount into until M3's
  shell exists. Both M4 (backend objects) and M5 (preset snapshot) must change
  `createSession` in `guest/factory/factory.js` (M1-owned, not shared). M5's prompt composition
  needs `guest/session/prompt.js` (M2-owned).
- **{M6, M8, M9, M11}**:
  - M6 cancel-stops-environment (R4-7) and emergency-stop holds, M8 compaction at round
    boundaries, and M9 mail-started turns all edit `guest/session/turn.js` and queue/holds
    (M1/M2-owned).
  - M8 compaction "on its context cache" edits `resources/agent-host/context-cache.js` (M1-owned).
  - M11's speech view taps `live-channel.js` (M1-owned) and adds `/audio` to `gateway/` (M3-owned).
- **{M7, M10, M12}**: M12 takes over `scripts/provision.mjs`, while M10 (asset listener port) and M7
  (egress proxy) need provisioning steps.
- Not listed as shared at all: `H/package.json` (dependencies), `H/perf/_harness.mjs` (M3 needs a
  WS/CapTP client, M6 the fake runtime), `H/JOURNAL.md`.

Fix: list the hook points explicitly. Give `turn.js` and `context-cache.js` plug-in tables (like
`tool-table.js`), list `provision.mjs` steps as an append-only table, and make M3's UI shell plus
`features.js` a prerequisite merged before M4 and M5 start their UI units.

Operational corollary (also blocking for parallel execution): integration tests and perf checks
must not run concurrently. architecture §10 and §11.2 and tooling.md 2.1 say so, the timeout flakes
were measured, and each run's state is 140-600 MB on a 21 GB disk. Parallel subagents therefore need
a PM-held lock for integration and perf runs, or the budgets will be noise.

---

## 2. Claims checked and found correct

| Plan claim | Verified at |
|---|---|
| Crank about 65 ms; full GC after every crank | `rust/thixotrope-ironhorse-worker/src/main.rs:185-190,241-265`; tooling.md 4.2 |
| Quadratic decoder `out += String.fromCharCode` | `rust/endo/xsnap/src/polyfills.js:156,159` |
| Staging in 1,024-char chunks | `pkg/src/core/evaluate-source.js:32` |
| Crank budget 10 M | `pkg/src/ironhorse/ironhorse-limits.js:45-51` |
| Adapter calls reject at restart with "target session has been retired" | `pkg/src/net/hub.js:1892-1950` (break at :1940-1945); stale transient sessions forgotten before workers wake, `pkg/src/core/daemon.js:825` |
| `WORKSPACE_VERSION = 21`; XS refused | `pkg/src/control/supervisor.js:112,203-204` |
| Prelude globals | `pkg/src/guest/prelude.js:43-64` (includes `makeSerialQueue`) |
| Worker controller and facade, `getEvaluator` guest-to-guest | `pkg/src/core/daemon.js:602-651` |
| A spec may carry a foreign remotable | `pkg/resources/http/durable.js:85-91` (handler) and `ephemeral.js:70-71` |
| A reference returned to its exporting session resolves to its local object (D-8 LiveChannel round trip works) | `pkg/src/net/hub.js:804-812` |
| Guests have `Compartment`; nested compartment globals persist across deliveries | probe: `new Compartment` gives `6`, then `c.evaluate('x')` in a later delivery gives `5` |
| No `console` in vats | probe: `typeof console` gives `undefined` |
| Adapter dies with the supervisor (no orphan holding the gateway port) | `pkg/src/platform/node/adapter-process-entry.js:22`; `adapter-processes.js:83-88` |
| Start notices bounded at 10 s | `pkg/src/core/daemon.js:136,875` |
| `Uint8Array` not passable host to vat | `survey/perf-engine3.log` ("OcapnMessageUnion: write failed") |

The intent-before-effect argument in §4.3 is sound. The inbound journal is written before delivery,
the hub commits a crank's outbound before forwarding, and replay output is deduplicated. A record
made in the crank that emits a call is therefore durable before the call can have any effect. The
`dispatching()` handshake gives a clean "before dispatch" versus "outcome unknown" split. One
conservative case should be documented: a crash after `Dispatched` is recorded but before the
adapter received the answer is reported as outcome-unknown, even though no HTTP request was sent.

---

## 3. Restart story (P-14, R4-66) — achievable, with three gaps

1. **Rejection arrives before recovery.** `hub.forgetSession` breaks pending adapter answers
   (`daemon.js:825`) before the start notices run (`daemon.js:850-875`). A shell `runCommand` or any
   other adapter tool call in flight will therefore settle as a rejection inside the session vat
   before `recoverAfterRestart()`. A Fae-style turn engine treats that as an ordinary tool error,
   records `ToolResult{failed}`, and if it was the last result, calls `startRound` on a tombstoned
   Endpoint. The plan must classify the "target session has been retired" rejection as
   *outcome unknown, stop the turn* in the tool and round paths, not as a tool failure. The only
   discriminator is the error text (`hub.js:1944`). This incompatibility belongs in the journal.
2. **Stale index row** (see B-5): make recovery lazy as well. On the first `watch`, `enqueueOnce` or
   `getCurrentTurn` after a restart, a session with a non-terminal turn should detect that it is
   stale, for example from an adapter-incarnation number stamped on every adapter-to-vat message and
   held by the factory, or from its LiveChannel being a tombstone, and run the same recovery.
3. **The exec vat outlives the turn.** §4.4 already ignores late results by turn generation, which
   is correct. Retiring an exec vat on timeout or cancel (§6) also throws away the persistent scope
   that M1 acceptance 8 is meant to keep. Decide whether cancel should keep the scope, and record
   the decision.

---

## 4. Performance budgets against the baseline

| Budget | Assessment |
|---|---|
| `turn.start` <= 300 ms, <= 3 deliveries | **Borderline.** The submit crank sends about 4 frames (answer, publish, rowChanged, startRound). The hub costs 1 + 2k whole-file `hub.json` writes per delivery (`pkg/designs/production-cost-model.md:341-347`), about 9 fsynced rewrites, plus the `dispatching` crank. Expect 250-350 ms on an idle machine, getting worse as `hub.json` grows. Delivery count 3 is right (enqueue, dispatching, startRound answer). |
| `queue.enqueue` <= 150 ms | Borderline for the same reason, because enqueue may also start a turn. |
| `exec.trivial` <= 250 ms | Tight. Arming and cancelling a deadline through the clock per call adds clock-manager cranks plus about 1 s of latency per arm. Arm one deadline per turn instead of per call, or race the call against the turn deadline. |
| `exec.sends100` <= 2 s | **Wrong** (B-7). |
| `session.list` 100 rows <= 200 ms | Plausible but untested. Marshalling 100 rows with 100 remotables in one crank is many sends' worth of guest work. Measure early, with paging. |
| CORE-1 64 k <= 150 ms; 256 k no halt | **256 k is infeasible** with JS decode (B-1). 64 k is at or over the meter edge. |
| `install` 300 k bundle <= 30 s | Likely over without CORE-1b: about 300 deliveries of about 1 k at 120-230 ms each (tooling.md 4.6), which is 40-60 s. CORE-1b is effectively required. |
| `restart.serving` 50 sessions x 300 turns (M2) | Building the fixture is the problem. 15,000 turns at 3 or more deliveries each is over 45,000 deliveries through one host thread, at least tens of minutes, plus about 1-2 GB of state while running. Not feasible as a per-milestone check in one sitting. Generate the state with bulk in-vat import (one crank per 100 turns) or keep a fixture template. |
| Live delta 0 deliveries, <= 5 ms | Correct by construction (in-process). |
| Audio 0 deliveries | Correct by construction (separate `/audio` WebSocket route in the same process). |

**A whole perf dimension is missing: shared-state growth.** All the budgets assume a constant
65 ms crank. Two shared costs grow with the system:

- `hub.json` is rewritten whole, with fsync, 1 + 2k times per delivery (`hub.js:354-364`). In
  production it reached 11.5 MB (`production-cost-model.md:19-20`). Every Turn, QueueEntry, Receipt,
  Preset and Session exo passed to the gateway, and every viewer, is a hub row until the importer's
  GC releases it. The gateway re-exports to the browser over CapTP, so the adapter's imports drop
  only if browser-side CapTP GC drops them [inferred]. Add perf gates for "`hub.json` bytes and ms
  per delivery after 1,000 turns with a UI attached" and "after 50 sessions".
- **Daemon-wide throughput.** All journal fsyncs and hub writes run on the supervisor's single Node
  thread, about 15 ms host time per delivery (tooling.md 4.2), which caps the whole daemon at
  roughly 60-70 deliveries per second [inferred]. The factory vat is also a single 15/s funnel for
  every session's `rowChanged`: 10 busy sessions emitting one per crank exceed it, and its queue
  grows without bound. Coalescing must be by transition (activity changed, counts changed), not
  "at most one per crank". Add a check with N concurrent sessions.

---

## 5. Is M1 the smallest slice? Are work units one-sitting sized?

M1 is not the smallest slice. It contains the spare pool (D-4), the context cache with page pull
(D-9), the exec vat with Compartment, deadline race, quarantine handling and re-create, late-join
fold, `watchSessions`, provisioning, and a two-mode SIGKILL suite. Suggested split:

- **M1a:** one session vat, scripted provider, streamed deltas via LiveChannel, one tool that is not
  exec (an adapter echo), FIFO queue, SIGKILL before and after dispatch. Vats created without a pool.
  The full context is sent each round while it is small (no cache pull).
- **M1b:** exec vat and persistent scope, spare pool, context cache rebuild, second-subscriber fold.

Work units that are too large for one subagent in one sitting:

- W1.2 (attach pattern, backends, LiveChannel with fold, context cache, scripted provider, handshake)
- W1.3 (whole session vat)
- W2.1 (two providers, SSE, retry, timeouts)
- W3.3 (porting the whole Floot UI; `floot-component.js` alone has about 750 lines of audio at
  l.2019-2774)
- W6.3 (container runner with hardening and the fake runtime)
- W11.4 (audio route and client audio)
- W12.4 (Home, spaces and widgets)

Split each of these into two or three units.

Integration iteration cost also limits what fits in one sitting. Each integration test pays the
supervisor cold start (32 s), workspace creation (12 s), `install-native` (about 13 s), the factory
install (40-60 s without CORE-1b), vat creation (4.4 s each), and the 30 s idle wait from B-5.
M1's "under 3 minutes" for the slice file is unlikely. architecture §10 says "per file" and
milestones say "per test"; they disagree. Add an M0 spike for a cached, pre-provisioned state
template copied per test, and check whether state dirs are path-independent (socket path,
`runtime/` copies) [inferred].

---

## 6. Advisory

- **A-1. Adapter code identity.** The installation identity is the bundle digest pair
  (native.md §1.2). With the UI bundled into the agent-host adapter (D-12) and providers in the same
  bundle, every UI or parser fix is a reinstall, which breaks every Secret, Backend, Blob and Route
  reference (D-13). The owner would lose sessions on every adapter fix until M13. Keep `durable.js`
  thin and stable, and have `ephemeral.js` load its implementation and UI assets at run time from a
  configured, versioned directory. It is unconfined Node, so a dynamic `import()` of a file path
  works. Treat that directory as trusted operator input. Record the trade-off (code no longer pinned
  by digest).
- **A-2. No live upgrade of session code.** Each guest bug fix forces a choice between keeping
  sessions on old code and losing them. Move a data-only `exportState`/`importState` for session
  records into M2, so M13 is only automation.
- **A-3.** The race between `rowChanged` and `started()` (B-5). Recovery must also be lazy (section 3.2).
- **A-4. Quarantined exec vats keep their state** (18 MB or more each) until `facade.retire()`. The
  session must retire them explicitly. `collectVats` should not be relied on.
- **A-5. Exec compute ceiling.** About 600 k simple iterations per crank at the default budget, so
  ordinary model code (parsing a large tool result, sorting 100 k items) kills the scope and its
  bindings. This is weaker than Endo's exec. Raising the crank budget (B-1 option 3) helps here too.
  Journal it as a fit cost.
- **A-6. Duplicate context truth.** The vat projects records while the adapter caches the
  projection, and compaction is planned in the adapter. Two implementations must agree byte for
  byte, or the `baseLength` check fires and pages are pulled. Consider making the adapter's cache
  the only context projection, with the vat sending record handles, and having the adapter write
  archive chunks from its cache. That turns D-10's 64 or more `put` cranks per 256 turns into 1-2
  deliveries. Archiving by having the vat push 2 M chars at 32 k per crank is 64 or more cranks,
  about 5-8 s of a blocked session queue.
- **A-7. Archive may be premature.** Measured: 20 M chars in a heap does not slow cranks
  (tooling.md 4.4), and 256 MiB of chunk arena holds roughly 60-80 M chars [inferred from 3.3 B/char
  on disk]. Measure the snapshot copy time at 20-50 M chars before building blob archiving in M2. If
  the measurement allows, move the archive to M13.
- **A-8. Blob durability.** If `Blob` handles are minted by the manager vat (D-3), each `put` is
  session to manager to adapter to manager to session (2 manager cranks plus 1 session crank). If
  they are adapter objects, they are tombstones after restart and archived turns become unreachable.
  §3.3 does not say which. The handle must be manager-minted, and the file fsynced before the handle
  is answered.
- **A-9.** `TextDecoder` options. Syrup constructs `new TextDecoder('utf-8', { fatal: true })`
  (`packages/ocapn/src/syrup/decode.js:28`). W0.1 says "invalid sequences to U+FFFD", but the new
  decoder should honour `fatal` (throw), or Syrup silently accepts malformed strings that a Node peer
  would reject.
- **A-10.** `progress(partialText)` checkpoints must be deltas and must replace a single partial
  record. If the text is cumulative, the frame grows into B-2's limit within a long reply.
- **A-11. Single blast radius.** Gateway, providers, live channels, secrets, blobs and speech share
  one Node process. A crash drops every socket and stream and every context cache, so each active
  session pulls its context pages again at once. Supervise speech engine child processes, and
  catch errors per connection.
- **A-12.** §3.3 says Blob put is at most 64 k; §5 and §9 say at most 32 k. Pick one, in bytes.
- **A-13.** Deadlines through `clock.after` without cancel leave an alarm that wakes the session
  vat later, one delivery each. Use `arm()` and cancel.
- **A-14.** native.md §4 lists `Uint8Array.fromBase64` among the absent globals. That is correct in
  a vat (confirmed here), but the engine implements it, so making it available is a cheap fix that
  belongs with CORE-1 (B-1 option 1).

## 7. Reproducing the new measurements

`scratchpad/thix/critique/probe.mjs` (final variant: base64 and UTF-8 decode at 96 k, 128 k and
192 k). Run it from `packages/thixotrope`:
`node <scratchpad>/thix/critique/probe.mjs | grep '^{'`. It creates and deletes `tmp/cq`.

Earlier variants, whose results are quoted above, probed the following:

- globals and `Compartment`;
- inbound arrays of 8 x 4,096, 32 x 4,096 and 8 x 8,192 (all MeterAbort);
- 2 x 4,096 (ok, 1.4 s), 4 x 2,048 (ok) and a single 4,096 (ok);
- outbound single strings of 15 k, 30 k and 60 k (ok) and of 250 k and 1 M (vat killed);
- base64 and UTF-8 decode at 64 k (ok) and at 256 k and 1 M (MeterAbort).
