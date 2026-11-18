# M0 results: what the groundwork established

Milestone M0 (groundwork) of `milestones.md`. Build commits `0d35cbd569..7fa1a7057a`; PM follow-ups
`3f2b90954e..6677f92fcc` (merge of upstream PR 1667, golden re-pin, tooling fixes, restart
re-validation). Every number below comes from `JOURNAL.md`; the entry ids are given with each.
Measurements are from one Apple M3 Max with other agents running (load average 1.4-6.3 unless
stated). Unless stated, the release worker is `c2f65dbe...` (built from `d0fd6b1138`; the PR merge
rebuilt it byte-identically) and the crank budget is 50 M. Paths: `pkg/` = `packages/thixotrope/`,
`H/` = `packages/thixotrope-harness/`.

Pages: 1 settings and margins; 2 inbound cost, measured causes; 3 changes outside the harness,
commit by commit; 4 decisions confirmed and how the mechanisms behave; 5 crashes, halts and restart
after PR 1667; 6 core-change candidates and their status; 7 performance so far; 8 not done.

Pages 3 and 6 are kept current after M0: they also list the core changes and candidates that M1a,
M1b and the core work after M1b produced (C-16..C-21; engine, worker and core commits up to
`87e13507b5`). `../CORE-CHANGES.md` is the record of every change outside the harness (CC-001..CC-025,
with the accounting of each commit); page 3 is its commit-by-commit summary. The release worker was
`7cda4467...` from `9828522485` and is `367e78ad...` since `f0ff5e098b` (CC-022); the boot fingerprint
`6c864841...` has not moved since `0a4bdb3826`. M1a's and M1b's own measurements are in
`milestones.md` (outcome tables) and `JOURNAL.md` (J-0200..J-0398, J-9100..J-9216, J-9300..J-9399).

---

## 1. Settings chosen and their margins

All harness settings live in `H/config/defaults.js` (`limits`). Guest code cannot import that file
(bundles read only `guest/`); M1a copies the values into `guest/lib/limits.js` and a unit test keeps
the copy equal. The core keeps one copy of its own: `pkg/src/core/evaluate-source.js`
`STAGING_FRAME_BYTES`, kept equal to `frameBytes` by `H/test/limits.test.js` (J-0122, J-0197).

| setting | value | what bounds it (measured) | margin | entries |
|---|---|---|---|---|
| `frameBytes` (string content of one message into or out of a vat, UTF-8 bytes) | 24,576 | One inbound message halts the vat above 94,208 bytes (smallest halt 98,304, `HeapExhausted`) at 50 M, identical on a fresh vat and on a vat whose key table is full; at 10 M the meter halts first at 51,200 / 53,248. Inbound latency at 24,576 is 311.8 ms median against a 357 ms budget (floor 57 + 300). | 3.8 x below the 50 M halt; exactly 2 x below the 10 M halt (lowering the daemon budget below 50 M needs a re-run). Latency 0.87 x of budget: a larger frame misses the latency budget, which is why it was not raised. | J-0141, J-0144, J-0190, J-0193, J-0194 |
| `crankOutBytes` (all messages one crank sends) | 196,608 (8 frames) | Outbound is cheap: 8 x 16 KiB in one crank 191-202 ms, 8 x 64 KiB 553-576 ms, single strings up to 4 MiB pass at every budget; the 8 MiB failures were the control socket's `MAX_FRAME` (`pkg/src/control/local-control.js:15`), not the vat. | far below any halt; each message is still another vat's inbound frame, so `frameBytes` still bounds each one | J-0142 |
| `inlineBytes` (larger text fields become Blobs) | 8,192 | not measured; plan value. A field of 8 KB costs about 80 ms of inbound decode (about 10 us per byte, J-0193). | n/a | J-0144 |
| crank budget (`THIXOTROPE_CRANK_BUDGET`, daemon-wide) | 50,000,000 | Runaway loop ends in 242-271 ms at 50 M (100-104 ms at 10 M, 458-473 at 100 M). Above 50 M the send and frame ceilings are the heap, so 100 M buys nothing. | runaway 4 x inside the 1 s budget | J-0143, J-0193 |
| `sendsPerCrank` (guest rule) | 100 | Answered sends halt at 250 per crank on an empty vat (every budget) and at 300 on a used vat (`HeapExhausted`, 50 M); `sendOnly` halts at 450 (10 M) / 600 (50 M). | 2.5 x below the smallest answered halt | J-0143, J-0194 |
| `execSourceBytes` | 262,144, **a staged size** | One message of program source halts the vat (`HeapExhausted` at 150 k, 262 k and 400 k). Staged in `frameBytes` chunks and evaluated in one crank: 262 k in 11 frames, 3.9 s, evaluating crank 175 ms; 400 k in 6.0 s, crank 234 ms. | evaluating crank uses a few % of the budget; staging time is the cost | J-0146, J-0195 |
| `vatKeyNames` | 57,000 | Distinct property names a vat can still intern after boot (57,075 measured; 54,378 after a 250 k staged program). Names are never released; exhaustion is a catchable `RangeError`, not a halt (J-0333): the exec vat answers `exhausted` and is retired (M1b QC, J-0390). | a design rule, not a tunable (page 6, C-6) | J-0191, J-0333, J-0390 |
| slot ceiling (`THIXOTROPE_SLOT_CEILING`, daemon-wide; M1b QC) | 4,000,000 (Thixotrope default 1,000,000) | A vat's live heap plus everything one crank allocates (collection only between cranks, C-7). A spare session vat's slot capacity (high-water mark) is about 280,000; at 1,000,000 a 100-call round halted it (`HeapExhausted`), at 4,000,000 100 and 256 calls pass. | 256-call rounds pass; the margin shrinks as a session's live heap grows (`history.heap`, J-0395) | J-0362, J-0392, J-0395 |
| `maxDeliveryAttempts` (`THIXOTROPE_MAX_DELIVERY_ATTEMPTS`) | 5 (upstream default) | Bound 5 gives a vat up after about 15 s of doubling waits at best; a restart with one vat crashing on every replay served after 35.8 / 68.5 / 36.4 s. Bound 2 served after 7.6-9.0 s but gives a vat up about 1 s after its first crash, irreversibly. | owner to confirm (architecture open decision 16) | J-9023, J-9046, J-9051 |

`scripts/serve.mjs` sets the crank budget, the attempt bound and (since M1b QC) the slot ceiling for every serve path (CLI,
`serveHarness`, template helper, perf harness), refuses to lower the budget unless the last
shutdown was clean, and validates the bound as `thix serve` does (2..100) (J-0133, J-9023).

---

## 2. Inbound cost: the measured causes

The plan (architecture fact 2 as written before M0) blamed the pure-JS base64 loop and the
quadratic polyfill `TextDecoder`, and guessed that `Uint8Array.fromBase64` was lost by a VM
static-install defect. M0 found:

1. **`fromBase64` was dropped by `@endo/immutable-arraybuffer`'s shim, not by the VM** (J-0100). The
   shim replaces the eleven TypedArray globals with emulated constructors that copied only `name`,
   `prototype` and `BYTES_PER_ELEMENT`, so `@endo/base64` captured `undefined`. Fixed in `b10254b252`.
   Native base64 then saved only 5-8 % of inbound time (J-0102): base64 was never the dominant cost.
2. **The polyfill `TextDecoder` was quadratic and halted at 16,384 ASCII characters** (J-0110). Native
   UTF-8 (`1d44da02d0`, `54a42f5eec`) decodes and encodes 1 M characters in 4-7 ms, about 0.25
   computron per byte. Inbound still halted between 49 and 98 KB and cost about 230 ms per 1,000
   characters (J-0112): the codec was not the dominant cost either. Outbound stopped being a ceiling.
3. **The dominant cost was SES `harden` of each inbound frame's bytes** (J-0140, corrected by J-0190).
   `pkg/src/net/pipe-network.js` `deliver` hardens `{ done: false, value: bytes }`; `harden` calls
   `Object.getOwnPropertyDescriptors` on the `Uint8Array`, and that engine native resolved every index
   with `to_property_id`, which interned the index as a name (one name per frame byte, permanently)
   and stored the result as named slots. Each computed key also re-walked every intrinsic name in
   `install_pending_intrinsics`. J-0140 named per-index `getOwnPropertyDescriptor` and is wrong on
   that point; J-0190 measured the split. Fixed in `d0fd6b1138`: `harden(new Uint8Array(16384))`
   2,646 -> 118 ms, 24,576 bytes 3,830 -> 174 ms, no names consumed; computrons unchanged.
4. **What remains is per byte and on the heap** (J-0190, J-0194): `harden` still allocates one
   descriptor object per frame byte. Inbound costs about 10 us per byte at steady state (24 KiB in
   312 ms including the 57 ms floor; 16 / 32 / 48 / 64 KiB in 255 / 451 / 640 / 829 ms) and one
   message above about 94 KB halts with `HeapExhausted` at 50 M. Candidate C-5.
5. **A full key table used to wedge a vat silently** (J-0191): Syrup's record decode threw
   `property key space exhausted` after the crank returned, the vat's OCapN pump ended its session,
   and later frames were dropped while the host saw no failure. Fixed in `63927edaba`: the crank now
   throws, the vat halts visibly, and pending callers get the retired text. The table itself remains
   a hard per-vat budget (C-6).

Consequences carried into the design: `frameBytes` stays 24,576; every program source and every
text over `inlineBytes` is staged; no data-dependent record keys may reach a vat.

---

## 3. Changes outside the harness, commit by commit

This is the list an upstream reviewer needs. Harness-only commits are not listed.

| commit | package | change | reason |
|---|---|---|---|
| `0d35cbd569` | root | `yarn.lock` entry for `@endo/thixotrope-harness` | register the private harness package in the workspace |
| `4180c69f2b` | root | `eslint.config.js` spreads `makeHarnessLintConfigs(...)` (6 lines) | the repository has one flat ESLint config, so the guest rules (`H/lint/guest-rules.js`) hook in there (J-0131) |
| `b10254b252` | `@endo/immutable-arraybuffer` (+ changeset) | emulated TypedArray constructors copy every other own static of the genuine constructor | the shim hid `Uint8Array.fromBase64`/`fromHex` from vats (and would on Node 25+ and browsers with the base64 proposal) (J-0100) |
| `e0f06cbb6d` | `ironhorse-vm` tests, `pkg` Ironhorse scenarios | pin the native base64 statics through the real SES boot; a vat decodes 192 KiB in one crank | regression test for `b10254b252` (J-0100, J-0101) |
| `1d44da02d0` | `ironhorse-vm` | three Ironhorse-only statics on `%Uint8Array%`: `decodeUtf8(bytes, fatal) -> { text, consumed }`, `encodeUtf8(text)`, `encodeUtf8Into(text, bytes) -> { read, written }`; listed in `INTRINSIC_KEY_ORDER` | linear native UTF-8 for the boot polyfill; a static (removed once) rather than a global (bound into every compartment). Moves the boot fingerprint (J-0111) |
| `54a42f5eec` | `rust/endo/xsnap/src/polyfills.js` | `TextDecoder`/`TextEncoder` capture and delete the natives before any guest runs; `{fatal}` throws `TypeError`, `{stream}` carries a tail; leading BOM stripped once unless `ignoreBOM`; XS keeps the old classes (path not executed on XS) | the quadratic decoder halted at 16 k characters (J-0110, J-0111) |
| `c786909c1e` | `pkg` Ironhorse lane | `test/ironhorse/text-codec.js` (7 tests) | split sequences, fatal decoding, 1 M random code points round trip (J-0114) |
| `b27ed72bda` | `pkg/src/core/evaluate-source.js` (+ unit test) | staging chunk = `STAGING_FRAME_BYTES / 3` = 8,192 UTF-16 units (was 1,024), surrogate-safe; `chunkChars` option | install of a 300 k bundle took 50 s at 1 KiB chunks (CORE-1b, J-0120, J-0122) |
| `d0fd6b1138` | `ironhorse-vm`, `ironhorse-snapshot` side-table ledger | `getOwnPropertyDescriptors` (ordinary and Proxy) keeps indices as `ReadKey::Index` in the result's index store; each environment caches the sizes at which nothing was left to bind and skips the intrinsic walk while they are unchanged (cache not persisted) | the dominant inbound cost and the name leak (J-0190); no format bump needed (J-9001) |
| `5a73049032` | `@endo/ocapn` (+ changeset) | both Syrup decoders are `{ fatal: true, ignoreBOM: true }` | a string, selector or label starting with U+FEFF did not round-trip, on Node already and in vats after `54a42f5eec` (J-0113, J-0192) |
| `63927edaba` | `pkg` `net/pipe-network.js`, `core/worker-peer.js`, `core/worker-peer-xs.js`; lane test `test/ironhorse/key-space.js` | the pipe reports `onClose`; the worker peer latches a session end and the crank throws, so the worker halts | a vat whose OCapN session ended (key-table exhaustion in Syrup decode) stayed neither halted nor answering (J-0191) |
| `3f2b90954e` | merge of upstream PR 1667 (`6a7cdc5e15..a96d4e20f4`) | crash classification (`WorkerCrashError`), a persisted crash count with doubling retries, startup that waits out a crashing vat, `standDown()`, snapshot-retry cadence, `THIXOTROPE_MAX_DELIVERY_ATTEMPTS` | upstream; merged without conflict with `63927edaba` (J-9040) |
| `042171c094` | `pkg` `package.json`, `index.js`, new `supervisor.js`, `local-control.js`, README | export `serveThixotrope` and `connectLocalControl` (subpaths and main entry); their 52-module graph imports no `node:` builtin | the harness's public surface (architecture D-1) was reachable only by relative path (J-0132, J-9022) |
| `0a4bdb3826` | `ironhorse-snapshot` test fixtures | re-pin the three snapshot goldens (3-run procedure: plain, deterministic-math, plain) | `1d44da02d0` moved the boot fingerprint without re-pinning (J-9000..J-9002) |
| `9828522485` | `ironhorse-vm` (+ tests `index_attribute_matrix.rs`, `ironhorse-snapshot/tests/index_attributes_carry.rs`) | `GET_LOCAL` and the with/eval read return a value without the binding's attribute bits (as XS `mxPushSlot`); the `push` fast path, `array_item_set` and the ordinary index store create elements with flag 0; `Interp::push` debug-asserts that no pushed value carries attribute bits | C-16: `const x = {}; a.push(x); a.splice(0, 1)` threw "C: xsSet ?: not writable"; a `const` local's read-only flag rode onto the stack and into new elements (J-9100, J-9101). Boot fingerprint, snapshot goldens and golden computrons unchanged; the worker binary changed (`c2f65dbe...` -> `7cda4467...`) |
| `d6f4e38b9b` | `pkg` Ironhorse lane | `test/ironhorse/element-attributes.js` | lane regression for C-16 through the real worker (66 scenarios since) |
| `18c8f633ee` | `pkg` `net/hub.js`, `core/daemon.js`, `control/supervisor.js` | the hub counts OCapN GC frames by session and direction; `status()` has a `gc` field | measuring C-17 (J-9120) |
| `f8bf23c62d` | `pkg` `core/durable-worker-transport.js`, `ironhorse/ironhorse-engine.js`, `core/worker-engine.js`, `net/hub.js`, `core/daemon.js`, `control/measured-engine.js` (+ `test/worker-gc-cranks.test.js`) | a GC frame toward a worker is journaled with `gc: true` and not delivered alone; a run of them enters with the next ordinary frame, in order and before it, or alone once 64 have gathered (`GC_FRAMES_PER_CRANK`); crank boundaries are a pure function of the journal (`journalCranks`), so replay delivers the same cranks; Ironhorse `deliverBatch` runs a crank's frames as one evaluation, one drain and one collection; the startup sweep resumes only workers owed a crank; the hub releases a retired session's rows in one batch per destination | C-17: GC bursts from adapters cost one full crank per frame (turn start p99 3.3-4.6 s) and woke every idle session at the first restart after setup (J-9120..J-9122) |
| `a46f505035` | `pkg` `core/daemon.js` | a worker row's `journalLength` is its delivery frontier; new `heldFrames`, `wakes`, `cranks` | held GC frames read as "unsnapshotted" to every existing caller (J-9122, J-9123) |
| `2b273930ab` | `pkg` lane fixtures `test/ironhorse/_fixture.js`, `process-daemon.mjs` | fault injectors treat a `deliverBatch` that contains the target frame as that frame's crank | after `f8bf23c62d` their faults never fired (lane 62/66, then 66/66) (J-9126) |
| `7efa7fb3e4` | `pkg` `net/hub.js`, `core/daemon.js` | hub cost counters per inbound delivery (`status().hub`) (CC-018) | measure C-20 before changing it (J-9210) |
| `1f1194059b`, `6be1bd3403`, `a3a2b58da5` | `pkg` `net/hub.js`, `core/durable-worker-transport.js` | one hub commit per inbound GC burst; one journal fsync per worker flush (CC-019) | a GC frame cost 16.7 ms of supervisor time (C-20; 6.6-7.0 ms after, J-9211..J-9213) |
| `b45da47b93` | `pkg` `control/measured-engine.js`, `core/daemon.js` | `status().deliveryHistogram`, a crank wall-time histogram (CC-020) | `concurrency.10` needs crank p95 (J-0365) |
| `d4241fa77a` | `pkg` test | `measured-engine.test.js` type-checks (CC-021) | `lint:types` failed on CC-020's test (J-0396) |
| `3db48394c9`, `f0ff5e098b` | `rust/thixotrope-ironhorse-worker` | collect on an allocation schedule (slot growth 131,072, chunk growth 16 MiB, every 32nd crank) and before the image at close, instead of after every crank; `timing` replies (CC-022) | C-7: a trivial delivery cost 17-126 ms of collection, growing with the vat (J-9300, J-9303). Worker `7cda4467...` -> `367e78ad...`; boot fingerprint, bundles and goldens unchanged |
| `4d6a84e86f`, `2657c03f53`, `4a42dc711c` | `pkg` `ironhorse/ironhorse-limits.js`, `-runtime.js`, `-engine.js`, README, lane tests | `gcPolicy`, `gcSlotAllowance`, `gcChunkAllowance`, `gcCrankInterval` from `THIXOTROPE_GC_*`, recorded in `runtime.json`, fixed per state directory; lane tests per schedule (CC-023) | a replay must collect after the same cranks (J-9301, J-9302; lane 69/69) |
| `a71e5272b5`, `87e13507b5` | `pkg` `net/hub.js`, `store/*`, `core/daemon.js` | `status().hub` `persistChars`, `store`, `persistRuns` (CC-024) | size C-2's commits; estimate group commit (J-9330, J-9334) |
| `72ef46f905` | `pkg` `store/hub-log-store.js` (new), `store/store-fs.js`, `control/supervisor.js`, `ironhorse/ironhorse-runtime.js`, tests | the hub's state is a write-ahead log of deltas over an image, one durable append per commit; `THIXOTROPE_HUB_STORE=file` keeps `hub.json`; one-way migration (CC-025) | C-2: a commit rewrote the whole `hub.json` (9.8-10.7 ms, 121-337 KB); after 5.5-6.6 ms, 14-46 KB (J-9330, J-9333) |

Any engine wrapper that intercepts `deliver` must also intercept `deliverBatch` (or drop it, which
makes the transport deliver frame by frame) since `f8bf23c62d` (J-9126).

Every boot change (`b10254b252`, `1d44da02d0`, `54a42f5eec`, `63927edaba`) changes the boot digest,
so existing Ironhorse state directories are refused cleanly with `BootLayoutMismatch` (J-9001). Any
later change that adds natives or edits `INTRINSIC_KEY_ORDER` must re-pin the goldens in the same
commit by the 3-run procedure (J-9002).

---

## 4. Decisions confirmed, and how the mechanisms behave

**D-7 attach pattern (spike S2, J-0160, J-0161; re-run J-9043).** All four parts pass, before and
after the PR merge.
- The native's `bind` awaits `E(spec.sink).attach(opsFacet)`, so when the manager's reconcile returns
  the facet is fresh. `open()` retries once through `manager.register()` (same key,
  `same: () => true`) when the facet it holds is retired. Copy the fixture
  `H/test/spikes/fixtures/attach/{durable,ephemeral}.js`.
- First `open()` 0.9-1.2 s (it builds the adapter process); later calls are ordinary.
- After SIGKILL and restart a call pending into the adapter breaks with exactly "ocapn hub: the
  target session has been retired", and the break is delivered **during startup, before the
  supervisor reports serving** (vat journal 493 -> 630-633 by serving, no growth after).
- Restore re-attaches a new incarnation 62-68 ms after serving with no caller; a call on the old
  endpoint breaks with the retired text; reopen takes 278-307 ms.
- One vat object passed six ways maps to one presence in the adapter (`WeakMap` identity) within an
  incarnation, so channels can be keyed by a session presence (D-8).
- No adapter process survives a supervisor SIGKILL (adapters exit on IPC disconnect).
- Costs: vat -> adapter -> vat 70-76 ms per answered call; adapter -> vat -> adapter 75-80 ms;
  control client -> adapter 20-25 ms; adapter -> adapter hop through the hub 25 ms (S4, J-0163).

**Registration specs may carry consumer-vat remotables (S7, J-0162, J-9043).** A listener exported by
an application vat was restored to every new adapter after clean and SIGKILL restarts.
`pkg/src/native/contract.js` says specs hold only the manager's own remotables; the behaviour is
broader and the harness relies on it (`serveGateway`'s operator).

**Intent before effect (S9, J-0165, J-9044).** Over 24 SIGKILLs at 0-600 ms after a crank that records
an intent and sends to an adapter, and 4 kills on first sight of the effect: no effect ran twice and
none ran without its record (M0 run: ran once 15, recorded but not run 8, record missing 1; PR re-run:
16 / 6 / 2). Of the runs whose effect executed, 6 of 15 (M0) and 5 of 16 (re-run) saw the retired
break instead of the answer: a retired break does not mean "not run".

**D-4 spare pool (S6, J-0183..J-0185, J-9045).**
- A spare is `E(vats).createWorker(label)` (135-152 ms; allocates only, the vat boots with its first
  message), the session program staged by `evaluateSource` (246,422 ASCII characters in 13 messages of
  24,576), and one evaluating crank (229-268 ms) whose completion value is a `SpareMaker` kept in the
  inventory.
- Creation 6,449 ms median after `d0fd6b1138` (14,380 ms before). Four lanes in parallel: 50 spares in
  108.7 s (171.8 s before).
- Disk 17.3 MB per sleeping spare; 120-136 MB resident while awake; the process exits when it sleeps.
- A take is one `E(maker).make(config)` on a sleeping, checkpointed spare: 170.6 ms median (156.5 ms
  after restarts); the taken vat holds 63 MB resident.
- Restarts with 0 / 10 / 50 sleeping spares serve in 4.42-5.32 / 4.64-5.19 / 5.26-5.33 s and wake none.
- CORE-3 (booted-image templates) is not needed.

**S5 async generators (J-0147).** A suspended async generator and `Array.fromAsync` persist across
deliveries and across a clean restart in the shipped worker; `pkg/README.md` is stale on this. Not
tested: restart by replay after SIGKILL. Guest rule 12.4 is relaxed accordingly.

**S8 state template (J-0180..J-0182, J-9045).** State directories are path-independent in practice:
only the control-socket resource's manager heap names the path, and every start replaces it. A copy
(APFS clone, 87-351 ms for 158 MB) serves in 5.1-6.3 s, survives kill -9, and runs beside another
copy. The socket path `tmp/<6 chars>/control.sock` is 98 bytes in this checkout against a 104-byte
limit.

**S4 adapter hops (J-0163, J-0164).** Payload size does not matter up to 16 KiB; each hop rewrites
`hub.json` about 2.6 times; adapter-to-adapter `sendOnly` events reach about 82 per second, a vat's
batched `sendOnly` 236 per second.

---

## 5. Crashes, halts and restart after PR 1667

From J-9040..J-9051 (`perf/crash.perf.mjs`).

- **Halts** (`MeterAbort`, `HeapExhausted`, key-table exhaustion, the session-ended throw of
  `63927edaba`): the worker answers `op:fatal`, the engine raises `WorkerHaltError`, the vat is
  quarantined at once, not counted, not retried (`pkg/src/core/durable-worker-transport.js:427-436`).
- **Crashes** (`WorkerCrashError`): a worker killed by a signal the host did not send, or a missed
  60 s request deadline (watchdog). Retried after 1, 2, 4, 8 s ... (doubling, capped at 60 s); given
  up after `maxDeliveryAttempts` crashes in a row without progress. A watchdog-missing vat is given up
  after at least 5 x 60 + 15 = 315 s.
- **Not counted:** a worker's status exit (including a Rust panic), a crash while snapshotting, and
  any death after `close()` called `standDown()`. The harness SIGKILLs only the supervisor pid, so its
  test kills are never counted: no vat was given up across about 35 SIGKILL restarts (J-9041).
- **Progress is judged by the frame a crash interrupted**, so a crash at a later replay frame
  restarts the count while the waits keep doubling: with bound 5 the vat was killed 6-7 times and
  given up after 32-64 s, not 15 s (J-9047).
- **Startup waits for every crashing vat**, in parallel, before the control socket opens and before the
  start notices that restore adapters (gateway included) run (`pkg/src/core/daemon.js:853-922`,
  `pkg/src/control/supervisor.js:1043`). Nothing of the harness is reachable meanwhile. Bound 5: served
  after 35.8 / 68.5 / 36.4 s; bound 2: 7.6 / 9.0 / 8.0 s; healthy restart with 10 sleeping vats
  4.6-5.8 s, no vat woken (J-9046, J-9050).
- **What callers see:** a halted vat and a given-up vat break callers with the same retired text, the
  same text as an adapter break at restart. Live, a pending guest-to-guest call breaks 51-799 ms after
  the failure. **A guest call pending into a vat that is given up during startup never breaks** (6 of 6
  cases, still pending after 30 s; root cause not determined; C-10) (J-9048).
- **A given-up vat afterwards:** `status()` shows `failure: "crashed 5 times without progress, last
  while replaying journal frame N: ..."`, its journal and snapshot kept; `retire()` succeeds in 88 ms
  and frees its disk (state 364 -> 298 MB); a replacement vat works. There is no reinstate (J-9049).

The design consequences are in architecture sections 2 (D-17), 4.4, 6 and 11.

---

## 6. Core-change candidates and their status

For the PM and the core owner. "Cost if left alone" is what the harness pays, already reflected in
the architecture. Status: **open** (not made), **closed** (made; commit given), **partly** (made in
part; the rest stays open). C-1..C-15 came from M0, C-16..C-20 from M1a and its hardening
(J-0271, J-0276, J-0277, J-0290, J-9100..J-9127, J-9154); C-21 from the M1b QC (J-0392). The C-7 and
C-2 work after M1b is J-9300..J-9307 and J-9330..J-9337; its integration and the long-session
measurements are J-9380..J-9399. M2 (W2.9, J-9400..J-9439) re-read C-1, C-2, C-7 and C-21 against
the record archive and added C-22 and C-23. The M2 review and close-out (J-9440..J-9499) added
C-24 (the cadence snapshot behind `checkpoint.stall`) and C-25 (a frame over `frameBytes` reaches
a vat), and changed nothing outside the harness (`CORE-CHANGES.md`, accounting check for M2).

| id | candidate | status | evidence | cost to the harness if left alone |
|---|---|---|---|---|
| C-1 | `hub.json` holds frames bound for transient (`discardOnRestart`) sessions in clear (hex): `flushOutbox` persists before splicing the queue | open; M2 keeps every secret out of it by design: a value crosses the control socket and hub only as a sealed box (D-6), and `m2-secrets` (acceptance 7) found no encoding of either key value anywhere under a daemon's state directory after replace, revoke and a clean stop (J-9402) | J-0164: marker in 1,001 of 1,020 versions during 1 KiB hops; none at rest | No secret, token or provider payload may cross the hub, not even adapter to adapter; everything secret stays in the agent-host process (D-6). Write amplification on every frame. |
| C-2 | Whole-file `hub.json` rewrite with fsync, about 2.6 times per answered hop, on the supervisor's single thread | **partly**; M2's record archive keeps a session's hub row bounded (about 10 KB and 211 entries at 200 to 5,000 turns, against 516 KB and 10,012 entries without it; hub time per turn flat at 259-283 ms, J-9404), so the row-rewrite cost no longer grows with a session's length; the per-commit cost itself is unchanged (`72ef46f905`, CC-025: a write-ahead log of deltas, one append per commit; per persist 9.8-10.7 -> 5.5-6.6 ms, 121-337 -> 14-46 KB, J-9333); open: a session row is rewritten whole per delta, every row is stringified at each commit, no group commit (J-9334, J-9335); `hub.growth` still misses (J-9380..J-9399); M2 close-out (J-9497): 0.77 MB after 1,000 turns and 1.37 MB at 20 sessions pass, 50 sessions projected 3.26 MB and 1.37 x fresh ms per delivery (fail), `concurrency.10` turn start 3.2 x single; M3's CC-051 and M4's CC-060 change the same row format and are to be one core change | J-0163: 5,379 rewrites for 2,000 hops; file 43 KB -> 630-690 KB under load, 110 KB at rest | About 12 ms of host time per frame; adapter-to-adapter traffic about 80 frames/s daemon-wide [inferred]; streams must stay inside one adapter process; throughput and `hub.growth` budgets at risk under many sessions. |
| C-3 | Restart replays every unsnapshotted journal suffix, and each crash adds to it | open | J-0166: 12.6 -> 26.1 s over 24 SIGKILLs (idle sleep 1 h); J-9044: 11.0 -> 18.2 s; M1a: a session awake at the kill serves in 8.8-9.3 s, asleep in 5.1-5.6 s (J-9190) | Tests and production must checkpoint idle vats quickly (`idleSleepMs` 2,000 in tests); the healthy-restart budget holds only for checkpointed vats. |
| C-4 | The control-socket path is kept in a vat heap (`pkg/resources/control/durable.js:77-90`) and re-registered at each start | open | J-0181 | A running state directory must never be copied (the copy's adapter could touch the original's socket); templates are built at a throwaway path. Harmless otherwise. |
| C-5 | SES `harden` of each inbound frame allocates one descriptor object per byte | open | J-0190, J-0194: about 10 us per byte; halt above 94 KB at 50 M; M1a cold create 5.9-6.2 s for a 143-157 KB program (J-0281, J-9192) | `frameBytes` stays 24,576; every large text is a Blob; program sources are staged: install 11.6 s per 300 KB, cold session create at its 6 s budget, `vat.evaluateProgram` 150 k 2.2-2.3 s (over its 2 s target). Fix: the pipe does not harden bytes it owns, or a native harden of TypedArrays. |
| C-6 | Each vat's 16-bit name table is permanent: about 57,000 names after boot, never released; and exhaustion is a catchable `RangeError` ("property key space exhausted"), so the vat neither halts nor is retired | open; the exec vat is covered in the harness (M1b QC `b124f5ed09`: `exhausted` answer, scope retired) | J-0191; M1a acceptance 9; J-0333 (a 60,000-key exec left a degraded vat: new names fail, calls 928-951 ms against 84); J-0390 | One data-dependent record can permanently degrade a session vat, which then fails every new name without halting. The harness forbids data-dependent record keys (guest rule 12.10), the gateway refuses records with undeclared keys (section 7), and the exec vat answers `exhausted` and is retired (model code that swallows the error is not seen). Fix: make exhaustion a halt in the engine (`interp/property/keys.rs:56`, `interp/link.rs:1272`). |
| C-7 | A full GC after every crank (`rust/thixotrope-ironhorse-worker/src/main.rs:185-190,240-265`), and none inside one | **closed** for the per-crank collection; with M2's record archive the session vat's live heap no longer grows with length, so per-turn time is flat from 200 to 5,000 turns (713.7 against 732 ms, per delivery 71-75 ms, J-9404) and the remaining growth is in the adapter (J-0491) (`3db48394c9`, `f0ff5e098b`, `4d6a84e86f`, `4a42dc711c`; CC-022, CC-023: an allocation schedule; a trivial delivery 17-126 -> 0.5-0.6 ms, `turn.start` flat at 170-188 ms over 1,000 turns, J-9303; 121-152 ms up to 1,000 turns and 233 ms at 4,000, p95 1.4 s from collections of a 1.1 M-slot heap, J-9383); open: a collection still marks the whole live heap, so its amortized share of a real turn grows with what a vat keeps and per-turn time still grows with session length (0.75 -> 2.71 s per turn from 300 to 4,000 turns, J-9388); the "none inside one" half is C-21 | ping floor 55-57 ms, about 44 ms of engine time per delivery (J-0193); M1a: 60-80 ms per vat hop, which set turn start at 573 ms before ports were held (J-0272) | Each delivery costs about 56 ms; one vat handles about 15-18 deliveries per second; each answer of an answered send is a delivery (100 answered sends 9.4-10.6 s, J-0143), which puts `exec.sends` (100 answered <= 8 s) at risk. A GC-only crank (64 held frames) still pays it (J-9127 (2)). The collection is O(live heap) per crank, so a session's per-turn time grows with its length (0.69 -> 2.46 s per turn over 1,000 turns, J-0370); and with no collection inside a crank, the heap ceiling bounds live heap plus one crank's allocation (C-21). |
| C-8 | Startup waits for every crashing vat before opening the control socket and running start notices | open | J-9046, J-9051; M1a `restart.crashingSession` 20.4-20.6 s at bound 5 (J-0280, J-9125, J-9192) | One vat crashing on every replay makes the whole harness unreachable for 20-64 s (bound 5) or at least 315 s (watchdog). The restart budget with a crashing vat cannot be met (section 11 keeps the target, marked). Fix: serve first and retry crashing vats in the background. |
| C-9 | Crash progress is judged by the interrupted frame, not by completed deliveries | open | J-9047 | Give-up time is a floor of 15 s, not a bound; under jittered external kills the startup wait grows towards journal length x bound x 60 s. |
| C-10 | A guest-to-guest call pending into a vat given up during startup never breaks | open; M1a's held ports add one exposure | J-9048 (reproducer `perf/crash.perf.mjs` phases a/b); J-9154 | Recovery must never wait on a guest call's settlement after a restart. Since ports are held, the decision for a turn killed before `dispatching` waits for a reopen through the manager vat (contract 7.1 case 2): if that vat was given up during startup the turn stays `running` until `Turn.cancel()`. |
| C-11 | No reinstate for a given-up vat (clear `failure`, keep the journal) | open | J-9049, J-9051 | A session vat that crashes repeatedly is lost with its transcript (still on disk, unusable). Conflicts with "transcript content is never deleted". |
| C-12 | `HostAllocationFailed` is sent as `fatal` and recorded as a halt; an allocation abort (SIGABRT) counts as a crash | open | J-9040 | A host-side allocation failure quarantines a vat at once although the worker asks for a restore. Rare. |
| C-13 | `STAGING_FRAME_BYTES` is a second copy of `frameBytes` in core, and no caller passes `chunkChars` | open | J-0122 | Changing `frameBytes` needs a core commit; `test/limits.test.js` guards the equality. |
| C-14 | Documentation: `pkg/README.md` says async-generator suspensions do not persist (they do, J-0147); `pkg/src/native/contract.js` forbids foreign remotables in specs (they work, J-0162); `thix status` does not report the attempt bound | open | J-0147, J-0162, J-9023 | Misleads builders; no runtime cost. |
| C-15 | Polyfill corners: `TextEncoder.encode(Symbol())` does not throw; the XS path of `polyfills.js` and the XS `fromBase64` switch were not executed; `ironhorse-262` cannot build here (`xs-oracle` sources absent) | open | J-0197, J-0114 | None for the Ironhorse-only harness. |
| C-16 | Ironhorse VM: an element pushed onto an array from a `const` local came out non-writable, so `splice`/`shift` on it threw "C: xsSet ?: not writable" | **closed** (`9828522485`, lane `d6f4e38b9b`) | J-0271 (acceptance 4 ran one message three times), J-9100..J-9102: `GET_LOCAL` pushed the binding's `XS_DONT_SET_FLAG` with the value; 42/552 source x store pairs failed before, none after | None now. The harness workarounds (the `Set`-based queue, J-0292's no-in-place-move rewrites) are no longer needed for correctness and stay as they are. Old state directories are refused (the worker digest changed), so no damaged element carries forward. |
| C-17 | OCapN GC frames were vat deliveries: one full crank per frame, and a frame for a sleeping vat woke it | **closed** (`f8bf23c62d`, `a46f505035`; counters `18c8f633ee`) | J-0276, J-0277, J-0294; J-9120..J-9125: turn start p99 3,274 -> 433 ms, session cranks per turn 6.55 -> 4.01, idle sessions woken at the first restart 10 -> 0 | Semantics now: a vat's memory held only by references a peer dropped is reclaimed at its next ordinary crank (or after 64 GC frames), not at once; an idle vat keeps up to 64 held frames across sleeps (3-6 per idle session measured); the crank boundary rule is part of the replay contract. What remains is C-20 and the open parts listed in J-9127: GC-only cranks keep the full collection, XS has no `deliverBatch`, held frames are not flushed at a sleep. |
| C-18 | The only signal of "the callee's session is gone" is an ordinary `Error` whose message is the hub's text | open | J-0290: a model-chosen argument quoted in a tool error faked a restart until `isRetiredBreak` became an exact match | The harness decides restart versus tool failure by an exact string (`guest/lib/retired.js`) and must keep adapter tools from rejecting with that text. Fix: a typed break (an error kind or a distinct rejection class from the hub). |
| C-19 | A vat is never told that an adapter incarnation it holds references into has died, unless it has a call pending into it | open | J-9154; contract 7.1 | Held ports make the session tell "in flight at the restart" from "claimed after it" by comparing two clocks (`TurnStarted.at` against the ports' `since`); the first turn after an unannounced restart pays a reopen (A, break, B, C; 777-989 ms end to end against about 250 ms, J-9190). Fix: an incarnation number on every adapter presence, or a hub query "has this presence's session restarted", answered locally. |
| C-20 | Each incoming GC frame costs the supervisor a whole-`hub.json` persist and a durable journal append (fsync) per outgoing frame | **partly** (per-commit cost lowered by C-2's log store, CC-025; `7efa7fb3e4`..`a3a2b58da5`, J-9210..J-9216: inbound GC batching per turn for native adapters and transient clients, outbound batching for worker sessions, one journal fsync per flush; a GC frame 16.7 -> 6.6-7.0 ms of host time, turn.start p99 under 1 s); open: frames from the in-process endpoint and releases toward it are still one commit each (J-9216 (a), (b)); a thrown append (ENOSPC) can wedge the worker transport until a restart (M1b QC advisory 3) | J-9127 (1): a 78-frame burst cost 2.2 s with 5 session cranks; `turn.delta.client` p95 564 ms during a 39-frame burst on a path that never enters a vat; J-9191 | GC bursts from adapters (and from the M3 gateway) delay every hub-crossing message, including control-client and gateway traffic, by up to 1-2 s. Fix (J-9127 (a)): one table pass and one `persist()` per run of incoming GC frames from one session, one fsync per flush to a worker journal; measure first with a hub timer. |
| C-21 | The slot ceiling (`THIXOTROPE_SLOT_CEILING`, default 1,000,000) bounds a vat's live heap plus all one crank allocates, and the engine never collects inside a crank | open; no longer on the session's growth path in M2: with the record archive a session vat's slot capacity is flat (0.41 M grown, 1.07 M when built by `importState`, at 200 to 5,000 turns, 10-27 % of 4,000,000; J-0461, J-9404, J-9405); the import path's per-chunk crank sets an imported session's high-water; the harness serves at 4,000,000 (M1b QC `e2e41a2915`); since CC-022 a crank may also start with up to 131,072 slots of uncollected growth (J-9304); engine proposal J-9305 (a kept list for `WeakRef`, a proved safe point between promise jobs, a deterministic trigger there); a 5,000-turn session's slot capacity is 1.91 M (48 % of 4,000,000; live 1.41 M), on course to pass the ceiling at about 10,000-11,000 turns (J-9389) | J-0362, J-0368, J-0392: a 100-call round halted a session vat (slot capacity about 280,000 when made) at 1,000,000 and passes at 4,000,000; a 1,000-turn session halted in its first context page crank | The heaviest crank a vat can be sent sets how much it may keep: a session has a size at which ordinary cranks no longer fit (`history.heap`, J-0395), and a raised ceiling only moves that size. Fix: a collection inside a crank under allocation pressure, or a per-crank allocation allowance separate from the live heap. |
| C-22 | Pattern checks in a vat cost milliseconds per record: `mustMatch` of one transcript record against its kind's shape about 6 ms, an `M.or` of the eight record shapes about 9 ms | open | M2 close-out (J-9497): import 7.1 turns/s of tool turns over a 60 s window; `disk.session` 41.7 MB for an imported 300-turn session (41.1 MB its snapshot); the 5,000-turn template takes 8 min to build (J-9464). J-0481 (W2.7): `importState` 22.4 -> 13.2 ms per record with a structural guard, 7.1 ms without the per-kind check; J-9404: an imported session's slot capacity 1.07 M against 0.41 M grown | Import is bounded at 7-13 turns/s (30,000 turns take 39 min) and a live turn pays about 50 ms of checks; the import's per-chunk crank raises a session's heap high-water and its snapshot (41.7 against 24.6 MB). Fix: a native or compiled matcher for passable records, or a cheaper copy-on-check for records already checked by their producer. |
| C-23 | A Node client's presence for a remote object can be collected while the remote side still exports it; the next message carrying that object yields a new presence, so presence identity does not hold across calls unless the client keeps a strong reference | open | J-9403: the agent host's model catalogue cache, keyed by the Backend presence in a WeakMap, read the provider's catalogue twice 5.5 s apart for the same Backend; `AH/index.js` keys each backend's provider state the same way | Any adapter cache keyed by a presence in a WeakMap is lost at a collection (the catalogue now holds its keys strongly, bounded); a scripted backend's provider state can restart between sessions. Fix: keep an imported presence's identity while the export lives (a per-session import table that is not weak), or document that adapters must hold what they key on. |
| C-24 | The durable worker transport queues a snapshot once 256 deliveries have passed since the last one (`snapshotEveryDeliveries`), whether or not a turn is in progress; it runs behind the queued deliveries and holds the next ones for its whole duration | open (M2-FIX, J-9494; proposed: defer a due snapshot until no delivery has been queued for about 50 ms, forced at 4 x the cadence; about 30 lines in `durable-worker-transport.js` plus a test) | J-9408, J-9462: the slow turn of each 100-turn window is the one that holds the engine snapshot (0.7-5.2 s for the session vat's 34 MB heap under load); no seal crank among them | `checkpoint.stall` p99 misses 1 s (2-6 s); a turn of about 9 deliveries meets one every 28 turns. Raising `--snapshot-every` only moves the miss out of a window and lengthens replay. |
| C-25 | A frame over `frameBytes` addressed to a vat is journaled and delivered; only the receiving vat's guard refuses it, and above about 94 KB it halts the vat (C-5) | open (M2-R2, J-9489 ruling 4; the same change as M5's request CC-070) | J-9407: a 100 KiB string sent to `startTurn` through the admin path is refused by the session vat's guard, after delivery | The M2 too-big probe "refused before sending" stays a known failure; any caller that can reach a vat can make it decode a large frame, and one above the halt point quarantines it. Fix: the hub (or the worker transport) refuses an inbound frame over a configured ceiling before journaling it. |


---

## 7. Performance so far

"Budget" is the M0 (or architecture section 11) budget; a check fails above 1.25 x. Commit is the
row's tag (`-dirty` = spike files only differed); all at 50 M unless stated.

| check | budget | measured | verdict | commit, load | entry |
|---|---|---|---|---|---|
| native base64 decode 192 KiB in one crank (W0.1) | one crank at 10 M | 124 ms wall (JS decoder: 128 KiB MeterAbort) | pass | `0d35cbd569`, 10 M, 2.1-2.4 | J-0101 |
| native UTF-8 decode/encode 1 M characters | one crank | 4-7 ms (JS decoder: 16 k HeapExhausted) | pass | `40258c0fdf` + codec, 10 M, 4.2-4.4 | J-0110 |
| `test:ironhorse` lane | all pass | 65/65 (55 original + base64 scenario + 7 text-codec + 2 key-space), 16-22 min | pass | `d0fd6b1138` / `8edc8a4ecf`, 2.0-4.2 | J-0196, J-9042 |
| `ironhorse-vm` + `ironhorse-snapshot` suites, both math providers | all pass | 1,362 + 724 passed, 0 failed | pass | `3e8753a903`, 2.7-4.0 | J-9003 |
| `frames.halt` | `frameBytes` <= half the halt point | halt 94,208 / 98,304 (fresh and used vat); 2 x `frameBytes` passes on both | pass | `ac25998a8d-dirty`, 1.4-3.2 | J-0194 |
| acceptance: 200 frames in and out | no halt | in median 349 ms, out 68 ms, no halt | pass | `ac25998a8d-dirty`, 1.8 | J-0194 |
| `frames.inbound` at 24,576 | <= floor + 300 ms (357) | 311.8 ms (p95 362.8), first 518 ms; n=20 re-runs 330-347 | pass (0.87 x); before `d0fd6b1138` 867 ms, fail 2.37 x | `ac25998a8d-dirty`, 3.0-4.2; `03356c1d3b` | J-0145, J-0193, J-9024 |
| `frames.outbound` at 24,576 | same | 68.7 ms (n=20: 77-83) | pass | same | J-0193, J-9024 |
| `vat.evaluateProgram` 150 k (staged) | <= 2 s, no MeterAbort | 2,320 ms (staging 2,197 + crank 123); n=1 re-runs 2,206 / 2,305 | pass under the 1.25 x rule (1.10-1.16 x); over the nominal 2 s because of C-5; before 8,636 ms | same | J-0193, J-9024 |
| `loop.runaway` | <= 1 s | 242 ms | pass | same | J-0193 |
| install of a 300 k factory bundle (CORE-1b) | <= 30 s | 11.6 s ASCII, 14.0 s for 478 KB mixed text (1 KiB chunks: 50.3 s; 8 K chunks before `d0fd6b1138`: 19.8 s) | pass (0.39 x) | `50e071c64b`, 2.2-2.4 | J-0120, J-0193 |
| `vat.spareTake` wake + `make()` | <= 500 ms | 170.6 ms; after restarts 156.5 ms | pass | `9655151542`, 2.6-4.9 | J-9045 (M0: J-0184) |
| `vat.spareCreate` (246 k program) | none in M0; architecture "session create without pool <= 6 s" | 6,449 ms (before `d0fd6b1138`: 14,380) | 1.07 x of the 6 s target: within the rule, over nominal | `9655151542` | J-9045, J-0183 |
| `template.start` copy + start to serving | <= 20 s | 5,572.9 ms (M0 6,335-6,354) | pass | `9655151542` | J-9045, J-0182 |
| restart, 0 / 10 / 50 sleeping spares | <= 15 s, 0 woken | 4.42-5.32 / 4.64-5.19 / 5.26-5.33 s, 0 woken | pass | `9655151542` | J-9045 |
| `crash.restart.healthy` 10 sleeping vats | <= 15 s | 4.6-5.8 s, 0 woken | pass | `9655151542`, 1.9-13 | J-9050 |
| `crash.restart.bound5` one vat crashing on every replay | <= 15 s | 35.8 / 68.5 / 36.4 s | **fail** (2.4-4.6 x); C-8, C-9 | `8edc8a4ecf-dirty`, `9655151542`, 2.3-4.5 | J-9046 |
| `crash.restart.bound2` | <= 15 s | 7.6 / 9.0 / 8.0 s | pass | same | J-9046 |
| S9 restart after SIGKILL, unsnapshotted (idle 1 h) | none | median 14.6 s, 11.0 -> 18.2 s over 24 kills (M0 18.7 s, 12.6 -> 26.1) | recorded (C-3) | `9655151542`, 3.6-6.3 | J-9044, J-0166 |
| S2 round trips | none | vat->adapter->vat 70.2 ms; adapter-timed 74.7 ms; control->adapter 20.3 ms | recorded | `9655151542`, 2.6-4.0 | J-9043 |
| S4 adapter-to-adapter hop / push | none | 25 ms per hop; 82 events/s adapter to adapter; 236 events/s from a vat | recorded (C-2) | `f2564a075d-dirty`, 2.8-4.3 | J-0163 |
| answered sends per crank, used vat | rule 100 | halt 300 (`HeapExhausted`) | pass (2.5 x) | `ac25998a8d-dirty` | J-0194 |
| `serve.parentGone` (supervisor child after CLI SIGKILL) | none | stopped 1.7 s later, record clean | recorded | `03356c1d3b`, 2.2-2.8 | J-9021 |
| skeleton: bundle a 2-module guest / run-lock take / handoff | none | 1.4 ms / 5 ms / 257 ms (500 ms poll) | recorded | `1dccac467c-dirty`, 5.8-6.2 | J-0134 |
| disk per sleeping spare | architecture <= 25 MB per idle session | 17.3 MB | pass | `9655151542` | J-9045 |

---

## 8. Not done in M0

- Async-generator persistence after a SIGKILL restart (replay path) is not tested (J-0147).
- The XS side of the polyfill change is not executed; test262 parity (`ironhorse-262`) was not re-run
  (J-0111, J-0114, J-0197).
- The root cause of C-10 is not determined (J-9048).
- `H/test/spikes/_crash.js` spawned the supervisor child without the parent pipe (J-9025); fixed in
  M1a (`efb8a288c1`, J-9174), not re-run since.
- `perf/install.perf.mjs`, `test/limits.test.js` and `test/spikes/s6.test.js` import
  `pkg/src/core/evaluate-source.js` by relative path on purpose (core internals measured) (J-9022).
- A shutdown error the core swallows inside `supervisor.close()` cannot be seen by `serve.mjs`
  (J-9021).
- Session-program size was measured only for a generated 246 k program; M1a measured the real
  one (`session.program`, `milestones.md` M1a outcome).
