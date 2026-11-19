# Architecture: the Endo daemon harness on Thixotrope

Status: plan for M6 onward. M0 (groundwork), M1a (the headless session slice), M1b (exec scope,
staging, context cache, pool, list feed) and M2 (real providers, secrets, the full queue, the record
archive, delete, export; done with open items, `milestones.md` M2) are built; so are M3 (chat UI
and gateway), M4 (Secrets manager and subscription pools) and M5 (presets, prompt composition,
object and exec tools, grants, mentions), integrated across lanes and closed by X-CLOSE (M3 and M4
done with open items, M5 done; J-10060..J-10064); and so are two core changes after M1b: the
allocation collection schedule (CORE-11, C-7) and the hub write-ahead log (CORE-12, C-2). Steps 1-3
of the harness review (`arch-review/harness.md` section 8; J-10130..J-10254) then restructured the
built code without changing behaviour except where a row names it; the "as built after step 3"
paragraphs below (4.7-4.9, D-6, D-8, D-18) and the glossary (section 14) describe the result. M0's
measurements are summarised in `m0-results.md` (which also keeps the core-change candidates current),
M1a's and M1b's in `milestones.md` (outcome tables); all are recorded in `../JOURNAL.md` (M0:
J-0100..J-0198, J-9000..J-9051; M1a: J-0200..J-0296, J-9100..J-9200; M1b: J-0300..J-0398,
J-9210..J-9216, J-9360..J-9370; core work and its integration: J-9300..J-9337, J-9380..J-9393;
M2: J-0400..J-0499, J-9400..J-9499).
`../CORE-CHANGES.md` records every change outside the harness. The facts, core changes, limits, turn
sequence and budgets below are the measured ones.
Inputs: the six survey reports in `survey/` (core, native, apps, tooling, reuse,
spec-digest), the feasibility and coverage reviews `review-feasibility.md` and `review-coverage.md` with the
probe `survey/feasibility-probe.mjs`, spec Part I sections 1, 4 and 10, Appendix A.4 and
Appendix F of `endo-harness-spec.md` (called SPEC). Thixotrope paths are relative to the root of
the harness checkout (called T). `pkg/` = `packages/thixotrope/`.
Endo reference paths are read from T's object store with `git -C T show 1315bef86:<path>`
(never from the Endo checkout, never from T's pre-move `packages/floot/src`).
Guesses are marked [inferred]. Decisions are numbered D-1.. so milestones and the journal can cite them.

---

## 0. The facts that shape everything

Measured in the survey (tooling.md section 4, native.md section 0, reuse.md section 3.2, the
feasibility probe) and in M0 (`m0-results.md`; journal entry ids in brackets), and confirmed in code.
Numbers are for the release worker at the harness crank budget of 50 M.

1. **A durable crank costs tens of ms of host work, one at a time per vat; the collection no longer
   dominates it.** Until `f0ff5e098b` the worker ran a full collection after every crank, so a
   trivial delivery cost 17 ms on a new session vat and 126 ms after 1,000 turns (C-7, J-9300).
   Since CC-022 it collects only when the live heap grew by 131,072 slots or 16 MiB, every 32nd
   crank, and before the image at close (`gcPolicy` `allocation`, fixed per state directory,
   CC-023): the worker's own time for a trivial delivery is 0.5-0.6 ms at every session length, a
   `getInfo()` round trip from the control client through the hub 37 ms (81 before), and the rest of
   a crank is the host's journal append, hub commit and transport (J-9303, J-9333). A crank that
   collects pays it then: 56-189 ms for a collection that finds 130,000 garbage slots. Finalizers
   (and the OCapN `gc-*` frames they send) run at the next collection, up to 32 cranks later or in
   the first crank after a wake. Pipelining gains nothing
   (8 pipelined inbound frames cost what 8 separate calls cost, J-0142). An answered `E()` costs a
   second delivery when the answer comes back (100 answered sends from one crank take 9.4-10.6 s
   until every answer is back, J-0143); `E.sendOnly` does not. vat -> adapter -> vat costs 70-76 ms
   per answered call; an adapter hop through the hub with no vat 20-25 ms (J-0161, J-9043). OCapN GC
   frames (`op:gc-exports`, `op:gc-answers`) do not cost a crank of their own since `f8bf23c62d`
   (C-17): they wait in the vat's journal and enter with its next ordinary frame (section 4.6).
2. **Every byte of a message into a vat is hardened, and one message above about 94 KB halts the vat
   for good.** The pipe hardens each inbound frame's bytes (`pkg/src/net/pipe-network.js` `deliver`);
   SES `harden` allocates one descriptor object per byte. Inbound costs about 10 us per byte at steady
   state (24 KiB in 312 ms including the floor; 16 / 32 / 48 / 64 KiB in 255 / 451 / 640 / 829 ms), and
   a single message halts with `HeapExhausted` above 94,208 bytes at 50 M, on a fresh vat and on a vat
   whose name table is full alike; at 10 M the meter halts first at about 51 KB (J-0190, J-0193,
   J-0194). The ceiling is per message, not per string: 8 or 32 strings halt within 1 KB of one string
   (J-0141). Base64 and UTF-8 decoding are native since M0 and cost almost nothing (J-0101, J-0110);
   the cost the plan first blamed on them was the engine interning one property name per frame byte
   inside `harden`, fixed in core (`d0fd6b1138`, J-0190; `m0-results.md` page 2). **Outbound is cheap**:
   a vat returns 4 MiB in one answer, and 8 x 64 KiB `sendOnly` in one crank take about 560 ms; the
   only outbound wall found is the control socket's 8 MiB frame (`pkg/src/control/local-control.js:15`)
   (J-0142). A message one vat sends to another is that vat's inbound frame.
3. **A crank is bounded by the crank budget and the heap ceilings; going over quarantines the vat for
   good** (`pkg/src/ironhorse/ironhorse-limits.js:45-51`). The harness runs at 50 M computrons
   (`config/defaults.js`, chosen by S1): a runaway loop ends in about 240-270 ms; above 50 M the heap
   halts first, so a larger budget buys nothing (J-0143). The budget is daemon-wide
   (`THIXOTROPE_CRANK_BUDGET`) and may be lowered only after a clean shutdown (`scripts/serve.mjs`
   refuses otherwise). Answered sends halt at 250 per crank on a fresh vat and 300 on a used one
   (`HeapExhausted`); `sendOnly` at 600 (J-0143, J-0194). **The heap ceiling bounds a vat's live heap
   plus everything one crank allocates** (M1b QC, J-0392): the engine collects garbage only between
   cranks (C-21), and since CC-022 a crank may also start with up to 131,072 slots (and 16 MiB) of
   uncollected growth (J-9304); a crank that would take more slots than the slot ceiling halts. At Thixotrope's
   default ceiling (1,000,000 slots of 24 bytes) a session vat (a spare's slot capacity, the
   high-water mark of live heap plus its largest crank, is about 280,000) halted while recording a
   round of 100 tool calls (several thousand slots per call in one crank) and a
   1,000-turn session in its first context page crank. The harness serves with 4,000,000
   (`config/defaults.js` `slotCeiling`, set by `scripts/serve.mjs`); a vat's live heap grows with what
   it keeps (records, Blob presences), so a session has a size at which ordinary cranks no longer fit
   (measured by `history.heap`, `perf/history.perf.mjs`).
4. **Each vat has a permanent table of about 57,000 property names** (J-0191). Every fresh record key
   a vat ever receives or creates takes one for the vat's life (54,378 remain after a 250 k program);
   when they run out the engine throws a **catchable** `RangeError` ("property key space exhausted",
   J-0333): the vat does not halt, and every later new name fails while known names work (calls about
   11 x slower). A record with 1,500 fresh keys also costs about 700 ms to decode. No data-dependent
   record key may cross into a vat (rule 12.10); the exec vat, where model data lands on purpose,
   answers `exhausted` and is retired (section 6, M1b QC J-0390). Making exhaustion a halt is engine
   work (C-6).
5. **Answers owed by the host or an adapter break after a restart; guest-to-guest promises survive
   with one exception.** At startup the hub forgets stale transient sessions
   (`pkg/src/core/daemon.js:825`) and breaks every pending answer they owed with "ocapn hub: the target
   session has been retired" (`pkg/src/net/hub.js:1932-1947`; also :1522, :1968); each break is a
   delivery that wakes the waiting vat, and it is delivered **during startup, before the supervisor
   reports serving** (S2, J-0160, J-9043). The error text is the only discriminator, and it is also
   what every caller of a halted or given-up vat sees (fact 7). Sends to objects of a retired session
   break silently for `E.sendOnly` (tombstoned rows, `hub.js:1917-1931`). The exception: a
   guest-to-guest call pending into a vat that is given up during startup never breaks (J-9048, core
   candidate C-10). A vat that has **no** call pending into a dead adapter incarnation is told nothing:
   its references into that incarnation are tombstones it finds only when it next uses them (J-9154,
   core candidate C-19); section 4.4 says how a session tells that case from a turn in flight.
6. **Startup replays every worker whose journal runs past its last snapshot**
   (`pkg/src/core/daemon.js:826-847`), independent of the application. Vats checkpoint at idle sleep
   (default 30 s, configurable as `idleSleepMs`, `pkg/src/control/supervisor.js:141`), every 256
   deliveries, or clean shutdown. A checkpointed sleeping vat costs startup about 1-17 ms and is not
   woken (healthy restart with 50 sleeping vats 5.3 s, J-9045); an unsnapshotted suffix is replayed,
   and repeated crashes make it grow (restart 11 -> 18 s over 24 SIGKILLs with idle sleep 1 h, J-9044,
   J-0166).
7. **A vat whose worker crashes is retried; one that halts is not** (upstream PR 1667, J-9040). A halt
   (`MeterAbort`, `HeapExhausted`, name-table exhaustion) quarantines the vat at once. A crash (a
   signal the host did not send, or a missed 60 s watchdog) is retried after 1, 2, 4, 8 ... s (capped
   at 60 s) and given up after `maxDeliveryAttempts` (5) crashes in a row without progress; a given-up
   vat is final, like a halted one (no reinstate, C-11). A starting supervisor waits for every crashing
   vat to be retried to one end or the other **before** it opens the control socket and runs the start
   notices that restore adapters (`daemon.js:853-922`), so nothing of the harness is reachable
   meanwhile: 36-69 s with one such vat at bound 5 (J-9046, J-9047). Section 2 D-17 states what the
   harness does about it.
8. **Guests have no clock, randomness, timers, URL, fetch, console, WeakRef, and cannot pass bytes**
   (`Uint8Array` is not passable over OCapN in this build). The clock resource costs about 1 s per
   alarm (`clock.after(0n)` p50 989 ms from the workspace, native.md section 0.2). Creating a worker
   takes about 140 ms but the vat boots with its first message (about 3.5 s), and shipping a program
   costs the inbound per-byte price: a vat loaded with a 246 KB program costs 6.4 s (J-9045). A
   sleeping vat takes about 17 MB of disk; an awake one 120-136 MB resident while loading and about
   63 MB after waking from its snapshot; its process exits when it sleeps (J-0183, J-0184). There is no
   live code upgrade (`pkg/src/control/supervisor.js:112` `WORKSPACE_VERSION = 21`).
9. **The hub commits its state before every frame it sends, about 1.25 times per inbound delivery
   and 21-27 times per turn**, and every exo exported across the gateway is a row in it. Until
   `72ef46f905` a commit rewrote `hub.json` whole with two fsyncs (9.8-10.7 ms, 121-337 KB, J-0163,
   J-9330); since CC-025 it is one durable append of the changed table entries to `hub-log.jsonl`
   over `hub-image.json` (5.5-6.6 ms, 14-46 KB; compaction at 1 MiB of log; J-9333). A changed session
   row is still rewritten whole and every row is stringified at each commit, so the cost still grows
   with the hub's state (`hub.growth` 1.40 x fresh after 50 sessions, J-9333; C-2's rest, J-9335). All
   journal and hub writes run on the supervisor's single Node thread: adapter-to-adapter events
   reached about 82 per second with the whole-file store, a vat's batched `sendOnly` events 236 per
   second (J-0163; not re-measured). Frames bound for an adapter are written to the hub's log in clear
   (hex) while queued, until the next compaction (J-0164, J-9337, core candidate C-1), so nothing
   secret may cross the hub.
10. **State directories are path-independent** (S8, J-0180): a cleanly stopped state copied to a new
    path serves there. Only the control-socket resource's heap names the old path until the next
    start replaces it, so a running state must never be copied (J-0181).

Everything below follows from one rule derived from these: **vats are the system of record and the
decision makers; Node adapters are the data path.** A vat sees a coarse, small, already-parsed message
at most a few times per second per session. Token streams, audio, bytes, SSE parsing, context
projection, large text, secrets and files never pass through a vat; a vat holds handles to them.

---

## 1. Where the code lives

**D-1. A new package `packages/thixotrope-harness` in T** (npm name `@endo/thixotrope-harness`,
private). Nothing harness-specific goes into `packages/thixotrope`. The harness consumes Thixotrope
through its public surface: `thix install`, `thix install-native`, the supervisor and the control
socket (`@endo/thixotrope/supervisor.js` `serveThixotrope` and `@endo/thixotrope/local-control.js`
`connectLocalControl`, exported by `042171c094`), the prelude globals
(`pkg/src/guest/prelude.js:43-64`), `@endo/thixotrope/native-adapter.js` `makeAdapter`, and the
worker-controller (`vats`) resource (`pkg/src/core/daemon.js:602-651`). The only deliberate reach into
core internals is `pkg/src/core/evaluate-source.js` from tests and perf checks that measure it.

Layout (each milestone owns named subtrees; see milestones.md):

```
packages/thixotrope-harness/
  package.json, README.md, JOURNAL.md            # JOURNAL.md is the running fit/perf journal
  guest/                     # confined code that runs in Ironhorse vats; prelude globals only
    lib/                     # copied-and-adapted pure Endo modules (turn engine, records, queue...)
    factory/                 # the harness root + factory vat (installed with `thix install`)
    session/                 # the per-session vat program (sent as source by the factory)
    exec/                    # the per-session exec-scope vat program
  resources/                 # Thixotrope native resources
    agent-host/              # durable.js (thin) + ephemeral.js (thin loader) + impl/ (loaded at run time, D-14)
    workspace/               # per-session directories, git, publishing / asset server
    containers/              # rootless Podman runner, egress proxy (fake runtime for tests)
  ui/                        # browser client (Preact), built with esbuild into impl/ assets
  bin/harness.js             # admin CLI (attach-only, control socket)
  scripts/                   # bundle-guest.mjs, provision.mjs + provision-steps.js, serve.mjs, run-lock.mjs
  config/defaults.js         # harness limit settings (section 9); Node side only
  lint/guest-rules.js        # ESLint rules for guest/ (hooked into the root eslint.config.js)
  test/                      # unit (Node), adapter (Node), integration (real Ironhorse) tests
  test/template/             # state-template helper for integration tests and perf (section 10)
  test/spikes/               # M0 spikes S1-S9 (gated, THIX_HARNESS_SPIKES=1)
  test/fixtures/             # scripted provider scripts, SSE recordings, fake binaries
  perf/                      # <feature>.perf.mjs + _harness.mjs (section 11)
  tmp/                       # git-ignored state for tests and perf (short paths, 0700)
```

Guest modules read `E, Far, harden, makeExo, M, mustMatch, Fail, q, makePromiseKit,
makeSerialQueue ...` from `globalThis` (the `GuestGlobals` pattern, `pkg/guest.js`) and are
bundled by `scripts/bundle-guest.mjs` with compartment-mapper `makeBundle`. Pure Endo modules are
**copied and adapted into `guest/lib/`** (header comment: source path at 1315bef86), not imported
as workspace dependencies, because `makeBundle` would bundle second copies of `@endo/*` libraries
that the prelude already provides (reuse.md section 4). Node-side code imports Endo packages normally.

### 1.1 Changes outside the harness package (each in its own commits)

What landed in M0, M1a, M1b and the core work after M1b, where, and why. `../CORE-CHANGES.md` is the
record (CC-001..CC-025, every commit accounted for); `m0-results.md` page 3 is its commit-by-commit
summary and page 6 lists every core-change candidate (C-1..C-25) with its status.

| id | change as landed | where (commit) | why |
|---|---|---|---|
| **CORE-1a** | `@endo/immutable-arraybuffer`'s emulated TypedArray constructors copy every other own static of the genuine constructor, so `Uint8Array.fromBase64`/`fromHex` reach vats and `@endo/base64` takes the native path. The plan's guess (a VM static-install defect in `boot.rs`) was wrong: the VM installs them, the shim hid them (J-0100). | `packages/immutable-arraybuffer/src/lib.js` (`b10254b252`); regression tests `rust/engine/ironhorse-vm/tests/ses_boot_intrinsics.rs`, `pkg/test/ironhorse/scenarios.js` (`e0f06cbb6d`) | Native base64; it saved only 5-8 % of inbound time (J-0102). |
| **CORE-1** | Three Ironhorse-only statics on `%Uint8Array%`: `decodeUtf8(bytes, fatal) -> { text, consumed }`, `encodeUtf8(text)`, `encodeUtf8Into(text, bytes) -> { read, written }`; the boot polyfill captures and deletes them before any guest runs; `TextDecoder` honours `{fatal}` and `{stream}` and strips a leading BOM unless `ignoreBOM`; `TextEncoder` uses the natives; XS keeps its old classes. | `rust/engine/ironhorse-vm` natives (`1d44da02d0`), `rust/endo/xsnap/src/polyfills.js` (`54a42f5eec`), lane test `pkg/test/ironhorse/text-codec.js` (`c786909c1e`) | The polyfill decoder was quadratic and halted at 16 k characters; outbound 250 k killed a vat (J-0110, J-0111). |
| **CORE-1b** | `evaluateSource` stages in chunks of `STAGING_FRAME_BYTES / 3` = 8,192 UTF-16 units (was 1,024), surrogate-safe, with a `chunkChars` option no caller passes yet. `STAGING_FRAME_BYTES` = 24,576 is a copy of `frameBytes`; `test/limits.test.js` keeps them equal. | `pkg/src/core/evaluate-source.js` (`b27ed72bda`) | Install of a 300 k bundle took 50 s (J-0120, J-0122). |
| **CORE-4** | `getOwnPropertyDescriptors` keeps array indices as index keys (no interned names); each environment skips the intrinsic catch-up walk while nothing changed (a cache, not persisted). | `rust/engine/ironhorse-vm` (`d0fd6b1138`) | The dominant inbound cost: `harden` of each frame's bytes interned one name per byte; 24 KiB harden 3,830 -> 174 ms (J-0190). |
| **CORE-5** | Both Syrup decoders are `{ fatal: true, ignoreBOM: true }`. | `packages/ocapn/src/syrup/{decode,codec}.js` (`5a73049032`) | A leading U+FEFF did not round-trip (J-0113, J-0192). |
| **CORE-6** | A worker whose OCapN session to the host ended throws in the crank, so it halts visibly. | `pkg/src/net/pipe-network.js`, `pkg/src/core/worker-peer{,-xs}.js`, lane test `test/ironhorse/key-space.js` (`63927edaba`) | A vat whose name table ran out stopped answering without halting (J-0191). |
| **CORE-7** | Export `serveThixotrope` and `connectLocalControl`. | `pkg/package.json`, `pkg/index.js`, `pkg/supervisor.js`, `pkg/local-control.js` (`042171c094`) | D-1's public surface (J-0132, J-9022). |
| upstream | PR 1667, "bound a vat's crash loop": crash classification, persisted crash count with doubling retries, startup that waits out a crashing vat, `standDown()`, `THIXOTROPE_MAX_DELIVERY_ATTEMPTS`. | merge `3f2b90954e` | Not ours; merged without conflict with CORE-6 (J-9040). Semantics: fact 7, D-17. |
| tests | Snapshot goldens re-pinned for CORE-1's boot statics. | `rust/engine/ironhorse-snapshot/tests` (`0a4bdb3826`) | `1d44da02d0` moved the boot fingerprint without re-pinning (J-9000). |
| **CORE-8** (C-16) | `GET_LOCAL` and the with/eval read return a value without the binding's attribute bits; the stores that create an element give it flag 0; a debug assertion at `Interp::push`. No boot, golden or metering change; the worker binary is `7cda4467...`. | `rust/engine/ironhorse-vm` (`9828522485`); lane scenario `pkg/test/ironhorse/element-attributes.js` (`d6f4e38b9b`) | An element pushed from a `const` local was non-writable, so `splice` threw in the session queue (J-0271, J-9100, J-9101). |
| **CORE-9** (C-17) | GC frames toward a worker are journaled (`gc: true`) and enter with the worker's next ordinary frame, or alone after 64; crank boundaries follow from the journal; Ironhorse `deliverBatch`; the startup sweep resumes only workers owed a crank; a retired session's rows are released in one batch per destination; worker rows report the delivery frontier and `heldFrames`, `wakes`, `cranks`; the hub counts GC frames by session (`status().gc`). | `pkg/src/core/durable-worker-transport.js`, `pkg/src/ironhorse/ironhorse-engine.js`, `pkg/src/net/hub.js`, `pkg/src/core/daemon.js` (`18c8f633ee`, `f8bf23c62d`, `a46f505035`); lane fixtures (`2b273930ab`) | GC bursts cost one full crank per frame and woke idle sessions at restart (J-0276, J-0277, J-9120..J-9125). |
| **CORE-10** (C-20) | Hub cost counters per inbound delivery (`status().hub`); one hub commit per inbound GC burst and one journal fsync per worker flush; a crank wall-time histogram (`status().deliveryHistogram`). | `pkg/src/net/hub.js`, `pkg/src/core/durable-worker-transport.js`, `pkg/src/core/daemon.js` (`7efa7fb3e4`, `1f1194059b`, `6be1bd3403`, `a3a2b58da5`, `b45da47b93`, `d4241fa77a`; CC-018..CC-021) | A GC frame cost 16.7 ms of supervisor time; 6.6-7.0 ms after (J-9210..J-9216). |
| **CORE-11** (C-7) | The worker collects on an allocation schedule (live slots +131,072, chunk footprint +16 MiB, every 32nd crank, and before the image at close) instead of after every crank; `THIXOTROPE_GC_POLICY` (`allocation` default, `every-crank`) and the three allowances, recorded in `runtime.json`, fixed per state directory. Worker `367e78ad...`; boot fingerprint, bundles and goldens unchanged. | `rust/thixotrope-ironhorse-worker/src/main.rs` (`3db48394c9`, `f0ff5e098b`), `pkg/src/ironhorse/*` and lane tests (`4d6a84e86f`, `2657c03f53`, `4a42dc711c`; CC-022, CC-023) | A trivial delivery cost 17-126 ms of collection, growing with the vat; after 0.5-0.6 ms (J-9300, J-9303). Finalizers run up to 32 cranks later (J-9306). |
| **CORE-12** (C-2) | The hub's state is a write-ahead log of deltas over an image (`hub-image.json`, `hub-log.jsonl`), one durable append per commit; `THIXOTROPE_HUB_STORE=file` keeps `hub.json`; migration one way; `status().hub` persist sizes, store counters and persist runs. | `pkg/src/store/hub-log-store.js`, `store-fs.js`, `control/supervisor.js`, `net/hub.js` (`a71e5272b5`, `72ef46f905`, `87e13507b5`; CC-024, CC-025) | A commit rewrote the whole `hub.json` (9.8-10.7 ms, 121-337 KB); after 5.5-6.6 ms, 14-46 KB (J-9330, J-9333). |
| CORE-2 | Kit `operate(fn)` verb. | - | **Not needed**: S2 confirmed D-7 (J-0160). |
| CORE-3 | Booted-image templates for fast vat creation. | - | **Not needed**: S6 confirmed D-4 (J-0184). |

Outside `pkg/` and the engine the harness also added one hook to the root `eslint.config.js`
(`4180c69f2b`, the guest lint rules) and its `yarn.lock` entry (`0d35cbd569`).

**Configuration, not core: the crank budget and the crash bound.** The serve wrapper
(`scripts/serve.mjs`) sets `THIXOTROPE_CRANK_BUDGET` (50 M, chosen by S1, J-0143) and
`THIXOTROPE_MAX_DELIVERY_ATTEMPTS` (5, D-17) from `config/defaults.js` on every serve path. The budget
may be lowered only after a clean shutdown; the wrapper refuses otherwise (J-0133). It also sets the
slot ceiling (4,000,000) and passes the host's `THIXOTROPE_GC_*` and `THIXOTROPE_HUB_STORE` through
(the harness serves the core defaults, `allocation` and `log`, unless a caller sets them; J-9380);
test templates key on any of them that is set, since a state directory refuses a change of slot
ceiling downwards, of collection schedule at all, and the file store refuses a log directory.

Changing the boot bundle or the worker's boot natives changes the boot digest, so existing state
directories are refused cleanly with `BootLayoutMismatch` (J-9001). Acceptable: nothing is in
production; every builder uses fresh state or a template rebuilt for the current digest (the template
key includes it). A change that adds natives or edits `INTRINSIC_KEY_ORDER` re-pins the snapshot
goldens in the same commit: run the ignored `regenerate_persistence_identities` plain, then with
`--features ironhorse-vm/deterministic-math`, then plain again, and check the last run changes nothing
(J-9002).

---

## 2. Processes, vats and where state lives

```
 browser (UI, CapTP over WebSocket, audio over a second WS route)
    |  https origin (reverse proxy out of scope; adapter binds loopback, trusts configured proxies)
    v
 agent-host ADAPTER (Node, unconfined, one process)          workspace ADAPTER      containers ADAPTER
   gateway: HTTP shell + WS CapTP + auth + CSP + frame guard   dirs, git, asset HTTP   podman / fake, egress
   gateway-local services: Live, Content, Composer
   providers: HTTP+SSE, parsing, context projection cache, pools, timers
   secrets backend (encrypted file), sign-in secret
   channels (session events, session list, accounts, home), turn fold
   blob store (staged large text, partial text, native context), speech engines (child processes)
    |  OCapN through the hub (each arrow into a vat = 1 durable crank)
    v
 agent-host MANAGER vat     workspace MANAGER vat     containers MANAGER vat
   (registrations, Secret/Backend/Blob exos, last-served records, refusal marks, start listener)
    ^
 factory VAT (harness root, operator object, session index, presets, settings, vat pool, operator inbox)
    |  owns
 session VAT x N (one per session and per subagent)  --- exec VAT x N (one per session, lazy)
```

**D-2. Engine: Ironhorse only.** The supervisor requires `acquireStore`, which XS lacks
(`pkg/src/control/supervisor.js:203-204`); the XS worker does not build here (missing `c/moddable`).

**D-3. State placement.**

| State | Lives in | Why |
|---|---|---|
| Session index (rows: title, activity, backend, model, effort, counts) | factory vat heap | list without waking session vats |
| Presets (built-in table + user presets, revision counter), voice preferences, spaces, settings, operator inventory | factory vat heap | small, shared across devices, orthogonally persistent |
| Session record (resolved backend and model fixed at creation), preset snapshot, composed system prompt, queue, receipts, turn records, current turn state, usage, network policy, label map, inbox | session vat heap | one conversation's system of record; one vat per session isolates quarantine and load |
| Any text field larger than `inlineBytes` (message bodies, tool arguments and results, partial text, submissions), opaque native context (signed thinking, encrypted reasoning) | blob files in the agent-host adapter's directory, fsynced before their handle enters a vat; the vat holds a manager-minted `Blob` handle plus a bounded preview | keeps every frame small (fact 2) and the vat heap and snapshots small |
| Model-written code's persistent scope (`globalThis` bindings) | exec vat heap | runaway code quarantines only the exec vat (section 6) |
| Secret values, sign-in secret, OAuth tokens, the secrets audit log | agent-host adapter's encrypted file (key file outside the state dir) | heaps and journals are plaintext on disk; no secret may enter any vat or transit the hub in clear |
| Secret, Backend, Blob, Route, Environment handle objects | the relevant manager vat | durable identities the vats hold; values stay adapter-side |
| Provider stream state, SSE parser, per-session context projection cache, live turn fold, channels, WebSocket connections, timers, speech engine processes, model catalogue cache | agent-host adapter memory | ephemeral by nature; lost at restart by contract (R4-67) |
| Pool refusal marks, last-served records (R4-63 says durable; at most 256, keyed by the Session object in a manager-vat Map) | agent-host manager vat, updated by coalesced `E.sendOnly` from the adapter (at most once per refusal or member change) | must survive restart; tiny |
| Session workspace files, git repositories, home volumes | workspace adapter's directory tree / container runtime | files; the vat holds a `Workspace` object |

**D-4. One durable vat per session, plus a lazily created exec vat; a factory-held spare pool hides
creation cost.** A vat is the unit of quarantine and of serial execution. One harness vat for all
sessions would serialize every session's cranks and one bad input would kill every session.
Confirmed by spike S6 (J-0183..J-0185, J-9045). Cost of a cold session vat: `E(vats).createWorker`
(about 140 ms; the vat boots with its first message), the session program staged by
`evaluateSource`, and one evaluating crank; 6.4 s for a 246 KB program, of which staging is about
10 us per byte (fact 2) and the boot about 3.5 s [inferred from install times]. Disk 17.3 MB per
sleeping vat. **The session program bundle is therefore bounded**, first to 200 KB, since M5 to
240,000 bytes (M5 O-1) and since the cross-lane seam unit WX.1 to 270,336 bytes
(`limits.sessionProgramBytes`, owner question G-1, the PM's default until the owner rules; about
+1.2 s of cold create, hidden by the spare pool; `bundle-guest.mjs` reports the size; section 11
`session.program`; 212,484 after step 3 of the harness review, J-10250; 233,126 after WX.1),
which keeps a cold create near the 6 s budget. The
factory keeps `poolSize` (default 2) spare session vats already loaded with the session program and 1
spare exec vat, refilled in the background after each take with up to 4 creations in parallel (four
lanes scale almost linearly: 50 spares in 108.7 s), so `createSession` costs a wake plus one
`make(config)` call: 157-176 ms measured. A spare is the `SpareMaker` that the evaluating crank returns,
kept in the factory's heap. The factory stages an ASCII bundle in `frameBytes`-unit chunks and anything
else in `frameBytes / 3`-unit chunks (the `evaluateSource` default) (J-0186). Spares are discarded when
the program digest changes. Idle session vats sleep, and a checkpointed sleeping vat is not woken at
startup. The pool exposes `whenSettled()` so tests can wait for refills before a SIGKILL (fact 6).

**D-5. Dormant after restart; sessions recover themselves (owner's decision, G-01).** No session vat
registers a start notice, and nothing wakes idle sessions at startup. A session learns about a
restart only from its own pending calls:

- **Turn lease.** Every running turn holds one answered call `E(endpoint).holdTurn(turnHandle)` that
  the adapter settles only when the session ends the turn (`E.sendOnly(endpoint).releaseTurn(...)`).
  A restart breaks the lease (fact 5), and that break is a delivery that wakes the session, which then
  runs `recoverAfterRestart()` (section 4.4). The break arrives during startup, before the daemon
  serves (S2), so a session with a turn in flight is awake and recovered when serving begins. Cost: 1
  extra delivery per turn.
- **Ports per adapter incarnation.** The session opens its ports (`E(backend).open(host)` ->
  `TurnPorts`: endpoint, publisher, tools, `since`) once, in `make`, and holds them across turns; it
  drops them when they prove dead (a retired break from the lease, an adapter tool or an answered
  outside publish) and opens again at its next claim. An idle session therefore still holds the dead
  incarnation's ports after a restart (it is not woken, and nothing tells it, fact 5); its next claim
  finds out from the lease break and reopens (section 4.4).
- **GC from dead peers does not wake anyone.** At startup the hub forgets the dead adapter and
  client sessions and releases what they imported; those GC frames wait in each exporting vat's
  journal (section 4.6). In M1a's restart checks no idle session vat was woken in any run, the first
  restart after setup included (J-9123, J-9125).
- **Any adapter call on the turn path** (round dispatch handshake, `runCommand`, blob reads) that
  rejects with the retired text is classified `outcome-unknown` and routed to the same idempotent
  recovery; it is never recorded as an ordinary tool failure, and the session never calls a
  tombstoned Endpoint after it (feasibility section 3.1).
- **Calls into guest vats are not restart signals.** A retired break from a guest vat (the exec vat,
  a child session) means that vat is lost (halted or given up, D-17), never "restart". And a guest call
  pending into a vat that is given up during startup may never settle (fact 5), so recovery abandons
  every guest call the turn held open instead of waiting for it (section 4.4).

The factory's only start listener (registered on the agent-host manager, whose `lifecycle.started()`
runs at every start) refreshes the factory's channel publishers, restarts pool refills and completes
factory-owned work interrupted by the restart: a half-made session creation is completed if its vat was
made and rolled back otherwise, so nothing half-made is listed (R4-6, R4-65), and
interrupted deletes are completed (R4-9). Recovery therefore never depends on the factory's index rows
being current (coverage 22, feasibility A-3). Idle sessions stay asleep until a message reaches them;
mail that arrived before the restart is handled when the session is next woken. This departs from
R4-65's "every session resumes serving its inbox at once" (owner decision, journal J-0015).

**D-17. Crashes, halts and a waiting startup (upstream PR 1667; J-9040..J-9051).**

- **Two kinds of vat failure.** A *halt* (`MeterAbort`, `HeapExhausted`, name-table exhaustion, a
  session-ended throw) quarantines the vat at once; nothing retries it. A *crash* (its worker is killed
  by a signal the supervisor did not send, or misses the 60 s request watchdog) is retried by the
  supervisor after 1, 2, 4, 8 ... s (doubling, capped at 60 s), replaying the journal; frames that
  arrive meanwhile queue. After `maxDeliveryAttempts` crashes in a row without progress the vat is
  *given up*: its failure is recorded and it is treated exactly as a halted vat. The count is kept in
  the vat's metadata, so a restart continues it. A status exit (including a worker panic), a crash
  while snapshotting, and anything after `close()` began (`standDown()`) are not counted.
- **The harness bound is 5** (`limits.maxDeliveryAttempts`, the upstream default; open decision 16).
  Bound 2 would bring a crashing restart to 7.6-9.0 s but gives a vat up about one second after its
  first crash, and a give-up is final; each step above 5 adds 16, 32, then 60 s of startup wait.
  Progress is judged by the frame a crash interrupted, so under jittered kills the give-up comes after
  32-64 s, not 15 s (J-9047, core candidate C-9).
- **Our own kills are not crashes of a vat.** The harness SIGKILLs only the supervisor process; the
  count lives in the supervisor, so a test SIGKILL never counts against a vat (J-9041). Never kill the
  process group in tests: that would kill workers before the supervisor.
- **Startup waits.** A starting supervisor waits for every vat that crashes while its journal is
  replayed to be retried to one end or the other, in parallel, before it opens the control socket and
  before the start notices restore any adapter (gateway included) (`pkg/src/core/daemon.js:853-922`).
  During that wait nothing of the harness listens: the browser sees connection refused (31-64 s with one
  such vat at bound 5; at least 315 s for a vat that misses the watchdog on every replay). The browser
  client treats a refused connection as "server starting" and retries with backoff (section 7); the
  restart budget is a healthy-restart budget, with the crashing case recorded against a target that
  depends on a core change (section 11; C-8).
- **What callers see.** Every caller of a halted or given-up vat gets "ocapn hub: the target session
  has been retired", the same text as an adapter break at restart. A session therefore reads the text
  by *who* broke: an adapter object on the turn path means restart (D-5); a guest vat means that vat is
  lost. A lost exec vat is retired and replaced (section 6). A lost session vat is a lost session: its
  journal stays on disk but there is no reinstate operation (core candidate C-11, open decision 17). The
  factory marks its row `lost` when a call into it breaks with the retired text (a session vat is a
guest vat, so that text never means a restart there), keeps
  it listed (transcripts are never deleted by the harness), and frees it only through `deleteSession`
  (M2), which retires the vat. `status()` through an operator path shows the `failure` text when the
  reason matters (J-9049).

---

## 3. Object model (object-passing style)

Rules (Appendix F.1, spec-digest section 6): factories return objects; per-item operations are on the
item; authority is passed as objects at construction; strings only for F.2 reasons (a)-(e). Interface
sketches below are the contract builders implement; method sets grow per milestone. All are `makeExo`
with `M.interface` guards that bound every string and array (sizes in section 9). **A guard does not
protect a vat from an oversize frame or from fresh record keys** (decoding happens before the guard
runs), so every path into a vat is also bounded on the sending side (section 9, rules 12.5 and 12.10).
The guards and method names of every object that crosses between M1a's units are written once, in
`guest/lib/interfaces.js`, with who calls what in which crank in `m1a-interfaces.md` (M1a W1a.0).

### 3.1 Factory vat

```js
// Installed once: thix install STATE harness guest/factory/main.js \
//   host=agentHostAdmin workspace=harnessWorkspace containers=harnessContainers vats=vats
make({ host, workspace, containers, vats }) -> HarnessRoot

HarnessRoot            // inventory label 'harness'; operator-only via control socket
  getOperator() -> Operator
  configure(settingsRecord) -> settings       // workload limits, pool size, defaults (section 9)
  status() -> { sessions, pool: { spareSessions, spareExec, refilling }, version }
  exportState() / importState(data)           // data-only, M2 (A-2): session records, queue, presets

Operator               // the ONE object the gateway publishes (F.1 #10)
  getFactory() -> SessionFactory
  getSecrets() -> SecretsAdmin                // agent-host manager facet; never returns values
  getAccounts() -> Accounts                   // M4
  getVoice() -> VoiceServices                 // M11
  getHome() -> Home                           // M12: operator inbox, inventory view (minimal inventory in M5)

SessionFactory
  createSession({ title?, preset?: Preset, backend?: Backend, modelId?: string, reasoningEffort?: string,
                  systemPrompt?: string, networkPolicy?, userInitiated?, spoken? }) -> Session
                  // option names follow A.4 (SPEC:1551); `model` is rejected (R4-6).
                  // The resolved backend and model are stored at creation; a later change of the
                  // factory default does not move an existing session (R4-22).
  listSessions({ after?, limit? }) -> { rows: [SessionRow], rev, next? }   // pages of <= 50 rows
  sessionListFeed() -> { rev }                // viewers subscribe in the gateway (D-8); no viewer objects here
  findSession(key) -> Session                 // only for page reload (F.2 d)
  deleteSession(session) -> undefined         // factory-level authority takes the object
  listBackends() -> [Backend]; listModels(backend?) -> [ModelRow]
  // presets (M5, as built): Operator.getPresets() -> PresetCatalog { list, configuration, create,
  //   defaultPreset }; configuration() is A.4's getPresetConfiguration (guards/factory.js)

SessionRow = { session, key, title, activity, state: Lifecycle, backendTitle, modelId, effort,
               messageCount, queuedCount }      // state carries D-17's `lost`
Preset     // exo in the factory vat; record holds { label, value } endowments (F.1 #4)
  describe() -> record ; snapshot() -> frozen PresetSnapshot (data + object references)
```

The factory keeps `sessions: Map<Session, Row>` and `byKey: Map<string, Session>` (key = `s<counter>`).
Each session holds a per-session **`RowReporter`** facet (not the factory) that can only update that
session's row: `E.sendOnly(rowReporter).changed(patch)`, sent **only on a row-visible transition**
(activity, title, message count at turn settle, queued count), not once per crank. The factory pushes
one coalesced `E.sendOnly(listPublisher).publish({ rev, diff })` per crank that changed rows to an
adapter-side channel (D-8); it never holds browser viewers (feasibility B-4). After a restart the old
publisher is a tombstone; the factory's start listener obtains a new one. Viewers detect gaps by
`rev` and re-read `listSessions`.

### 3.2 Session vat

```js
// Session program `guest/session/main.js`, delivered to a spare vat; make() called once.
make({ config, services: SessionServices, rowReporter }) -> { session: Session, internal: SessionInternal }

SessionServices        // per-session, attenuated; built by the factory, never contains admin facets
  backend: Backend                 // this session's backend only; open(host) -> TurnPorts (D-5)
  host: SessionHostFacet           // manager-minted for this session: liveChannel() -> LivePublisher,
                                   //   content() (Blob reads by handle only)
  workspace?: Workspace, shell?: Shell, envControl?: EnvironmentControl   // M6, per session
  execVat: ExecHandle              // from the factory pool: scope() -> { scope: ExecScope, deadlineMs },
                                   //   retire(scope); ExecScope: run, abandon, inspect; no evaluate,
                                   //   no notifyOnStart

Session
  getInfo() -> record ; rename(title)
  watch() -> { snapshot, rev }      // settled page + queue + execution + usage + current turn record;
                                    //   viewers subscribe to live events in the gateway (D-8)
  enqueueOnce(submission, requestId, at) -> Receipt   // called by the gateway's Composer (D-12);
                                    //   submission = { text } (<= inlineBytes) or { blob, preview, bytes };
                                    //   requestId is an idempotency key (e); `at` stamped by the gateway
  getSubmissionReceipt(requestId) -> Receipt | undefined
  listPending() -> { entries: [{ entry: QueueEntry, key, preview, state }], hold }
  startTurn(input) -> Turn          // refused with the R4-10 text while a turn is active
  getCurrentTurn() -> { input, turn: Turn, history } | undefined      // reload re-attach (R4-62)
  getHistoryPage(cursor?) -> { turns: [TurnRecordPreview], nextCursor }   // cursor is text (d)
  // content of a turn too big for its page (F.1 #15), as built: Turn.getContent(),
  //   History.turnContent(session, turnId), SessionInternal.blobPage(cursor?)
  getUsage() -> totals ; getAccount(refresh?) -> accounts (M4)
  emergencyStop() / resume()                                          // shell presets (M6)
  getNetworkPolicy() / requestNetworkPolicyChange(...)                // M7

QueueEntry   edit(submission) ; cancel() -> boolean ; sendNow() ; describe()   // key kept for reload (d)
Turn         getStatus() ; cancel() ; whenFinished() ; resolve(note)  // acknowledge outcome-unknown while idle
```

`SessionInternal` (held only by the factory): `rowSnapshot()`, `deleteSelf()`, `deliverMail(package)`
(M9), `exportState()`, `importState(chunk)`.

### 3.3 Agent-host native resource (manager vat facets)

```js
AgentHostAdmin (facet installed as 'agentHostAdmin'; held only by the factory)
  serveGateway({ port, operator, publicOrigin, trustedProxies }) -> Registration
                                              // operator remotable in the spec (allowed:
                                              //   pkg/resources/http/durable.js:85-91 keeps a foreign handler)
  makeBackend({ kind, label, keyGrant?, pool?, options }) -> Backend   // kind: 'scripted'|'openrouter'|'anthropic'|'claude-pool'|'codex-pool'
  forSession(session) -> SessionHostFacet     // minted per session; given only to that session's vat
  listPublisher() -> ChannelPublisher          // session list, accounts, home (adapter-side, D-8)
  onStart(listener) -> Registration            // the factory registers; called from lifecycle.started()
  getSecrets() -> SecretsAdmin
  speech() -> VoiceServices (M11)

Backend          describe() ; listModels() ; open(host) -> TurnPorts     // { endpoint, publisher, tools, since };
                                                                         //   Endpoint is adapter-side (transient)
Endpoint         holdTurn(turnHandle) -> settles at turn end (lease, D-5) ; releaseTurn(turnHandle)
                 startRound(roundRequest)  (sendOnly) ; cancelRound()   ; revoke() (subscription backends, R4-49)
                 armDeadline({ opId, ms }) / disarm(opId)  (sendOnly; adapter timers, section 8)
                 blobWriter() -> BlobWriter   // for the exec vat's large results (section 6)
TurnSink         (session-vat exo passed in startRound) dispatching(round) ; progress({ partial: Blob, tail })
                 roundFinal(RoundResult) ; roundFailed(reason) ; deadline(opId)
ContextSource    (session-vat exo passed in startRound) page(cursor) -> { records, next }   // records only, no projection
SecretsAdmin     list() ; create({ label, description }) -> Secret ; openWriter() -> SecretWriter (adapter-local)
Secret           describe() ; makeReadGrant() -> ReadGrant ; revoke() ; delete() ; audit(limit)
SecretWriter     replace(secret, value | sealedBox, expectedGeneration)  // adapter-local; values never in a vat;
                                              //   resolves secret -> entry by rights amplification inside the
                                              //   resource (manager WeakMap), never by a public entryRef
Blob             describe() -> { bytes, preview }   // manager-minted handle; content read through Content
BlobWriter       append(piece) -> undefined ; close() -> Blob             // adapter-local, answered per piece
ChannelPublisher publish({ rev, events }) ; SessionHostFacet.liveChannel() -> LivePublisher (same shape)
```

**D-6. Secrets never enter a vat or the hub in clear.** The secret store (values, generation,
revoked flag, audit) is the adapter's encrypted file; the wrapping key is a separate 0600 file
outside the state directory (default `~/.config/thixotrope-harness/secrets.key`, path from
configuration), fixing W-4 in part. The manager vat's `Secret` exo holds an entry reference that only
the resource can map (a manager-side WeakMap from `Secret` to entry, consulted by the adapter through
its attach sink). Values are written through `SecretWriter`, an adapter-local object: from the browser
the call stays inside the gateway process; from the CLI the value is sealed to the adapter's X25519
public key (`node:crypto`) before it crosses the control socket and hub. Provider code reads values
in-process at each round (R4-82). As built (M3), the sign-in secret is not an entry in that store:
it is its own file, `<state>/agent-host/gateway/signin.enc`, under the same wrapping key
(`AH/gateway/signin.js`; `m3-interfaces.md`).

As built in M2 (W2.3, W2.9): the store is `<state>/agent-host/secrets.enc` (AES-256-GCM, fresh
nonce per write, temp file, fsync, rename); the audit log is a separate append-only file of sealed
lines beside it (`secrets-audit.log`, bounded at about 20,000 lines), because rewriting the encrypted
file per read cost about 12 ms against the 1 ms `secrets.read` budget (a SIGKILL can lose the newest
audit lines, never a value). The adapter's X25519 key is derived from the wrapping key, so it is
stored nowhere. The manager vat holds `Secret`, `ReadGrant` and `SecretsAdmin` exos and maps them to
store keys only in WeakMaps; an API `Backend` holds a `ReadGrant`, and the adapter reads the value
through the grant at every round (one sink call per grant per incarnation, then a local read of
0.02 ms). The operations are built lazily, so an incarnation that never meets a secret creates no key
file. The daemon-level check (acceptance 7, `m2-secrets`) replaces a key with a sealed box, revokes
it, and greps the whole state directory (heaps, snapshots, journals, the hub image and log, blobs,
the archive) for every encoding of both values after a clean stop: no hit, the control text found.
After the M2 security review (M2-FIX, J-9486, J-9487): a missing key file is created whole (temp,
fsync, link, directory fsync) and concurrent first loads share one read; a torn last audit line is
cut at load, so a power loss or full disk loses only that line; `SecretsAdmin.list` pages by
creation serial; the Secret and audit bounds are `limits.secretsMax` (1,024) and
`limits.auditKeepEvents`. Providers and the catalogue refuse a base URL that is not `https:` or
`http:` to a loopback host, or carries user info, a query or a fragment; a key over 8,192 bytes
fails the round before any request; a round's streamed body is bounded at 64 MiB
(`limits.roundStreamBytes`); a request timeout is at least 1 s. Open: the origin binding of a
Secret's key, and per-purpose subkeys.

As built after M4 and the cross-lane integration (XA, X-FIX): `SecretWriter.replace` from any hub
caller takes only a `SealedBox`; a plain value is refused with `secretFailed("INVALID_SECRET_BYTES")`,
which never quotes it. A page writes through the gateway's own in-process writer (`replaceLocal`,
offered first in `GatewayPowers.extras` and returned by `GatewayContext.secretWriter()`); the bridge
refuses that writer as an argument toward any vat (rule `gatewayObject`). M4 adds the catalogue,
`setDescription` (audited), the audit reader (pages to 1,000) and the subscription pools: pools
hang off `SecretsAdmin.subscriptions()` (D-M4-1) as manager-vat `Backend`s whose members are
Secrets; tokens, renewal (write-ahead, generation-conditioned, single-flight per member), member
selection, refusal marks and account readings live in the agent-host process, and the vat side is
a few handles. The adapter caches each pool's state and re-reads it when the manager pushes
`poolsChanged()` (retirement waits for that answer), with a 600 s re-read as the safety net.

As built after step 3 of the harness review (J-10230, J-10231, J-10233): one **wrapping key**
object per adapter incarnation, `makeWrappingKey({ keyFile, stateDir })` in
`AH/secrets/wrapping-key.js`, made in `AH/index.js` and passed to the secret store and the
sealing keys; a failed key load is retried at the next use instead of kept until restart (the
row's behaviour change; the sign-in file keeps its own retrying cache). Atomic file writes go
through `AH/files.js` (`writeFileAtomic`, `writeFileAtomicSync`, `syncDirectory`), each writer
keeping its own step order and fsync choices (the blob store's split write and the sign-in file
still write for themselves). Tests and perf checks give a supervisor its key file as
`secretsKeyFile`; nothing sets the key variable process-wide.

**D-15. Blob handles are manager-minted and pre-minted.** The adapter keeps a stock of minted, empty
`Blob` handles (minted 32 at a time with one manager crank through its attach sink); it writes and
fsyncs a file and binds it to a stock handle **before** passing that handle into any vat (feasibility
A-8). Hot paths therefore cost no manager crank. Within one adapter incarnation the adapter maps
handle presence to file in a WeakMap; after a restart it resolves handles in batches
(`E(sink).resolveBlobs([blob])`, one manager crank per batch). Handles never bound to a file are
discarded by the manager at the next start. Blobs are deleted when their session is deleted (M2).

### 3.4 Workspace and containers native resources (M6, M10)

```js
WorkspaceService   createWorkspace({ session-scoped options }) -> Workspace
Workspace          git() -> Git ; readOnlyGit() -> Git ; files() -> Dir ; publish() -> Route ; release()
Git                listBranches(), createBranch(name), switch(name), rename, delete, status(), diff(opts),
                   log(opts), stage(paths), commit(message), merge(name, {ffOnly}), stash(), trackingStatus()
Route              url() ; revoke() ; describe()
ContainerService   createEnvironment(recipe, { workspace }) -> { shell: Shell, control: EnvironmentControl }
Shell              runCommand(argv, { timeoutMs, cwd, stdin?: Blob }) -> ToolResult ; inspect()
EnvironmentControl stop() ; emergencyStop() ; resume() ; setNetworkPolicy(policy) ; retire()
```

**D-16. Containers are lazy desired state.** A container registration means "this environment may
run", not "keep it running". The containers adapter's `restore` re-binds registrations without
starting containers (`restore` re-binds every desired registration at every start,
`pkg/src/native/manager-kit.js:148-160`; native.md section 1 gap (c)); a container starts on the first
`runCommand` and stops after `envIdleStopMs` (default 15 min) without commands. A stop that fails is
retried by the manager at the next adapter start instead of quarantining the session (improves on
G-31 / R4-81). Restart cost is therefore independent of how many sessions have environments.

**D-7. One-shot and streaming operations use the attach pattern, no kit change.** Each native
resource registers one service key whose spec carries a manager-owned `attach` sink. The adapter's
`bind` calls `E(spec.sink).attach(opsFacet)`; the manager forwards `open()`-style calls to the current
`opsFacet` and returns adapter-side objects (Endpoint, SecretWriter, BlobWriter, publishers, Shell
ops) that the caller then uses directly, so the manager vat is on the path once per turn or per
object, not per operation. After a restart those references are tombstones; calls break; callers
re-`open()`. **Confirmed by spike S2** (J-0160, re-run after the PR merge J-9043): (a) a durable vat
holds and calls a transient-session reference; (b) a call pending into it breaks after SIGKILL and
restart with exactly the retired text, delivered during startup; (c) restore re-attaches a new
incarnation 62-68 ms after serving, with no caller; (d) the adapter sees one stable presence for one
vat object within an incarnation (`WeakMap` identity), so channels can be keyed by it (D-8). The
pattern to copy is the fixture `test/spikes/fixtures/attach/{durable,ephemeral}.js`: `bind` awaits
`E(spec.sink).attach(ops)`, so a manager reconcile that returns has a fresh facet, and `open()` retries
once through `manager.register()` (same key, `same: () => true`) when the facet it holds is retired.
Costs: first `open()` 0.9-1.2 s (it builds the adapter process); vat -> adapter -> vat 70-76 ms per
answered call; reopen after restart 278-307 ms. No adapter process outlives a supervisor SIGKILL.
Spike S7 (J-0162) confirmed that a registration spec may carry a consumer vat's remotable (the
operator handler of `serveGateway`, sinks) across clean and SIGKILL restarts, although
`pkg/src/native/contract.js` says specs hold only the manager's own remotables. CORE-2 is not needed.

**D-14. Thin installed modules, implementation loaded at run time.** An installation's identity is
its bundle digest pair (native.md section 1.2), and a reinstall breaks every reference into its
manager vat (Secrets, Backends, Blobs, Routes). Therefore `durable.js` is small and changes rarely,
and `ephemeral.js` is a loader that `import()`s its implementation and the UI assets from a
configured, operator-owned directory (`implDir`, mode 0700, path fixed at install). A provider, parser,
gateway or UI fix is a file change plus a daemon restart, not a reinstall. Cost: the implementation is
no longer pinned by digest; the directory is trusted operator input (journal).

---

## 4. How a turn runs

The session vat drives the loop (it decides and records); the agent-host adapter does the heavy text
work (it projects context, calls the provider and streams). The loop body is Fae's `runAgenticTurn`
(`fae/src/turn-engine.js`, 86 lines, callback-only) copied into `guest/lib/turn-engine.js`, with
per-session runtime parts (`guest/session/runtime-parts.js`; each part's value may carry `hooks`
{ `onClaim`, `beforeRound`, `onCancel`, `onSettle`, `onRecover`, `nextTurn` } and `tools`; the
static `turn-hooks.js` lists were deleted in step 3 of the harness review) so later milestones plug
in without editing `turn.js`.

### 4.1 Sequence for one turn

The crank-by-crank contract is `m1a-interfaces.md` section 6; this is its outline. The session holds
its `TurnPorts` (endpoint, live publisher, adapter tools, `since`) from its creation-time open
across turns (D-5), so a turn start does not pass through the manager vat.

```
browser --E(composer).submit(session, text, reqId)--> gateway (adapter): stage text > inlineBytes
   as a Blob; E(session).enqueueOnce(submission, reqId, at)                 [crank A: receipt + queue entry;
                                                                          if idle and not held: claim = remove
                                                                          entry AND record TurnStarted{input, at}
                                                                          (atomic); RowReporter change; ONE
                                                                          publish (turn-start, phase, pending);
                                                                          E(endpoint).holdTurn(t) (lease);
                                                                          E.sendOnly(endpoint).startRound(req0)
                                                                          on the held ports]
agent-host adapter: project the provider request from its context cache + req0.append; then
   E(turnSink).dispatching(0) and WAIT for the answer                   [crank C: record Dispatched]
   then send HTTP; parse SSE in Node; every delta -> session channel (in-process) -> WS clients
   every 10 s or 16 KiB of new text: stage the partial text so far as a Blob;
   E.sendOnly(turnSink).progress({ partial, tail })                    [crank per checkpoint; replaces the
                                                                          single partial record]
   end of round: stage oversize fields; E.sendOnly(turnSink).roundFinal({ message, toolCalls,
   nativeContext: Blob, usage, at })                                     [crank D: record round; record all
                                                                          intents (one record, <= maxCallsPerRound);
                                                                          publish tool_call events; issue the first
                                                                          callWindow calls]
tool results: one crank per result; record it, publish tool_result, issue the next waiting call
after the last result of the round: E.sendOnly(endpoint).startRound(reqN)   [same crank as the last result]
... final round without tool calls -> record TurnSettled, usage; RowReporter change;
    E.sendOnly(endpoint).releaseTurn(t); if the queue has a waiting entry and no hold: claim it and
    start it on the held ports IN THE SAME CRANK; one publish carries
    [final, usage, end, turn-start, phase, pending]                       [lease answer: 1 more delivery]
```

Without held ports (the creation-time open has not answered yet, or the last ports proved dead) the
claim sends `E(backend).open(host)` instead (crank A'), and the turn starts when the open answers
(crank B); this hop through the manager vat cost about 300 ms per turn while every turn opened its
ports (J-0272).

Turn start costs 2 session deliveries before the HTTP request (A, C), with no manager crank. A plain
turn costs 4 session deliveries (A, C, D, the lease answer). A round costs 1 (final) + one per tool
result + one per progress checkpoint. GC frames from peers add no crank (section 4.6). Measured with
the scripted backend: turn start median 255 ms (budget 350; 573 ms while ports were opened per
turn), p95 288-293 ms, 2 frames into the session before the request. The tail is GC bursts' host
cost (section 4.6, C-20): p99 0.46-3.0 s across four runs of 150-200 turns (J-9124, J-9191).

**Calls per round (coverage 18).** At most `maxCallsPerRound` (default 64) tool calls of one round
are run; extras get the error result "Too many tool calls in one round (N); only the first 64 were
run." (R4-45 style). At most `callWindow` (default 16) are in flight; each result crank issues the
next waiting call. No crank therefore sends more than about `callWindow` + 3 messages.

### 4.2 Streamed deltas without a durable commit per token

**D-8. Channels live in the agent-host adapter; no durable vat holds a browser viewer.** A channel is
an adapter-side object with two facets: a **publisher** (held by exactly one vat) and a
**subscriber** side reached only through the gateway-local `Live` service. Kinds: one per session
(events of its turns and queue), one for the session list, later accounts and home. The adapter
assigns a sequence number to every event, keeps the fold of the current turn (Fae `reply-fold.js`
copied to the adapter), fans out to WebSocket subscribers in Node and drops a subscriber when its
socket closes. Text deltas are published in-process by the provider code (zero durable deliveries per
token). Events that originate in a vat (turn start, tool_call, tool_result, phase, usage, final, end,
abort, queue changes, row diffs) are sent with one `E.sendOnly(publisher).publish({ rev, events })`
per crank, batched, at most 64 events and `frameBytes`. Order is natural: the adapter publishes a
round's deltas before it sends `roundFinal`, and the vat publishes tool events only after receiving it.

Viewing: the browser calls `E(session).watch()` for the durable snapshot and `rev`, then
`E(live).subscribe(session, rev)` on the gateway's `Live` service, which keys the session channel by
the session presence (S2 (d)), sends the current-turn fold, then live events. A gap in `rev` makes the
client re-watch. Late joiners and reloads get the same view (P-09).

Staleness after a restart: the publisher comes with the held ports (same incarnation as the
Endpoint), so inside a turn `sendOnly` is safe; a stale publisher shows up as a broken lease, and
what was published on it since the restart is lost (viewers see a rev gap and re-watch). Outside a
turn (queue edits, renames) the session publishes with an answered `E(publisher).publish(...)`; a
break drops the held ports and makes it obtain a fresh publisher with
`E(services.host).liveChannel()` and publish again. These are rare, so the extra delivery does not
matter. The chain of outside publishes waiting for an answer has no bound yet (`guest/session/live.js`
`outsideTail`, J-9172; M1b W1b.0). The factory refreshes its list publisher in its start listener.

The channel delivers a session's vat batches in `rev` order (a late older batch is held for, a
duplicate dropped, a missing rev given up after 1 s or a full window); a subscriber is dropped over
4,096 queued deliveries or 2 MiB, and a session has at most 32 subscribers (`config/defaults.js`
`channelLimits`; `m1a-interfaces.md` section 3.2; J-9170..J-9172). Measured in the adapter process,
where the gateway subscribes, a delta reaches a waiting subscriber 0.15-0.18 ms after its publish
(budget 5 ms); a control client through the hub sees 17-18 ms (J-9173, J-9124).

As built after step 3 (J-10232): the session channel and the list channel use one subscriber,
`AH/channel-subscriber.js` (`makeSubscriber`: its queue and bounds; `slowestOf`;
`makeRevReorder`: the rev hold, duplicate drop and give-up; one injectable default timer).
`channels.js` and `list-channel.js` keep only what each kind adds (the session channel's turn fold
and held deltas). Wire shapes, bounds and `ordering()` are unchanged; the session channel's
`closes()` counts by close-reason key like the list channel. A later feed (M11 voice, M12 home)
builds on `makeSubscriber` and `makeRevReorder`; it does not write a third queue.

### 4.3 What is recorded before and after each step (intent before effect)

The heap is made durable by image + journal replay, and the hub commits a crank's outbound frames
before forwarding them (core.md 1.2-1.3; README 875-884). Therefore **state written to the heap in the
same crank that emits an outbound call is durably recorded before the call can have any effect**: if
the daemon dies, replay regenerates the crank (and its heap record) and the hub drops the duplicate
output. M0 spike S9 confirmed this for a call to a transient adapter session (coverage 17; J-0165,
J-9044): over 24 SIGKILLs at 0-600 ms after the crank, no effect ran twice and none ran without its
record; a third of the effects that did run were answered with the retired break, so a retired break
never means "not run".

| Step | Recorded in the crank that... | Record |
|---|---|---|
| Turn start | claims the queue entry | `TurnStarted { turnId, input, at }`; the entry is **removed in the same crank** (atomic claim; no `dispatching` or `interrupted` entry state can exist) |
| First dispatch | receives `dispatching(0)` (adapter awaits the answer before HTTP) | `Dispatched { turnId, round: 0 }` |
| Partial text | receives `progress` | replaces the single `Partial { round, blob, tail }` record |
| Round result | receives `roundFinal` | `RoundSettled { message (inline or Blob), toolCalls, nativeContext: Blob, usage, servedBy }` |
| Tool intents | same crank as round result, before issuing calls | one `ToolIntents { [{ opId: turnId/round/ordinal, name, args (JSON text, inline or Blob; never a record, rule 12.10) }] }` |
| Tool result | receives each answer | `ToolResult { opId, result (inline or Blob, cut to the tool limit), failed }` |
| Compaction | `beforeRound` hook decides (M8) | `CompactionStarted { boundary }` before the summary round; `Compaction { summary, boundary }` after |
| Turn end | receives final round / cancel / failure | `TurnSettled { status, error?, usage }` |

A refusal found in the claim crank itself (backend revoked, session stopped, deadline) writes no
`TurnStarted`: the entry stays queued with the `refused` hold ("Not sent: ...", A.4 SPEC:1624). A
failure after the claim closes the turn as failed with its input visible; it is never re-queued.
A crash after `Dispatched` is recorded but before the adapter received the answer is reported as
outcome-unknown although no HTTP request was sent (conservative, documented).

### 4.4 Restart with a turn in flight (P-14, R4-66)

`recoverAfterRestart()` is idempotent and runs on the first retired break the session receives from an
adapter object (D-5: the lease, or any adapter call on the turn path); a retired break from a guest vat
is not a restart signal (D-17). The lease break is delivered during startup replay, before the daemon
serves, so recovery normally runs before any client can connect.

**In flight at the restart, or claimed after it?** Because ports are held (D-5), a lease break before
`Dispatched` has two possible meanings: the turn was in flight when the adapter died, or the session
was idle across the restart and has just claimed a turn on ports that were already dead (nothing
reached any adapter). Nothing in the vat orders the claim against the restart except time, so the
session opens fresh ports and compares the turn's claim time (`TurnStarted.at`, the caller's clock)
with their `since` (the adapter incarnation's start): claimed earlier -> recovered as below
(`interrupted`); claimed later -> the same round 0 goes to the fresh ports and the turn runs once.
Both misclassifications are safe because nothing was dispatched (the adapter sends no request before
`dispatching(0) = true`): a clock stepping back sends an in-flight turn to the provider once; a claim
in the ~65 ms between serving and the adapter's re-attach, or a `startTurn` without `at`, closes a
turn that was not in flight as `interrupted`. After `Dispatched` recovery runs in the crank of the
break, with no reopen. The case table, crank by crank, is `m1a-interfaces.md` section 7.1; core
candidate C-19 (a typed restart notice) would remove the clock comparison. In M1a's restart tests
(20 SIGKILLs at kill delays 0-4,000 ms, J-9190) every turn read its final state at the first read
after serving, and no provider request or tool run happened twice.

It inspects the current turn:

- no `Dispatched` record: close it "Interrupted before dispatch; no backend execution was started."
  The input stays in the transcript, marked interrupted; nothing is re-queued (the entry was removed at
  claim); like Endo, a never-dispatched turn is left out of later context (R4-32), so the user resends it.
- `Dispatched` recorded: mark the turn `outcome-unknown`; every tool intent without a result gets
  "Tool outcome unknown; do not automatically retry."; never re-send.
- in-flight work that survives the restart is stopped or abandoned: child asks are cancelled with
  `E.sendOnly(childTurn).cancel()` and recorded (each child also recovers its own turn through its own
  lease, so a parent's ask settles as failed, R4-67); a pending exec call is abandoned by turn
  generation (its late result is ignored; the exec vat is not retired). Recovery never waits for a
  guest call to settle: a call pending into a vat that was given up during startup never breaks
  (J-9048, core candidate C-10). The next exec call finds out instead: a call into a lost exec vat
  breaks at once with the retired text, and the session then retires the handle and takes a fresh
  vat (section 6).
- a crash of the session vat's own worker during the restart is retried by the supervisor (D-17);
  recovery runs when its replay completes. If the session vat is given up, the session is lost (D-17)
  and nothing in it runs.
- if the queue is non-empty, hold it `restart` (A.4 text, SPEC:1621; R4-56).
- report the row change.

Costs after a restart: a turn whose decision waits for the reopen (no `Dispatched`) settles when the
manager's restore has re-attached the adapter and the open answers, which in M1a was always before
the first client read (1.5 s after connecting). The first turn of a session that was idle across the
restart pays the reopen (A, the break, B, C): 0.78-0.99 s from submit to completion against about
0.3 s for an ordinary one-chunk turn (J-9190).

The turn is acknowledged with `turn.resolve(note)` while idle; the next context includes the
outcome-unknown turn and its "Tool outcome unknown" texts (R4-32). **Builders must not follow
reuse.md:353** ("an interrupted provider call must be recorded and re-issued by the guest"): it
contradicts R4-66.

### 4.5 Context building: records in the vat, projection in the adapter

**D-9. The vat owns the records; the adapter owns the only projection.** The session vat sends
records, never projected text. `startRound({ turnSink, contextSource, base: { count, epoch },
append: [records], tools, options })` carries the records added since the last round (small: large
fields are Blob handles). The adapter keeps one context cache per session (record list + loaded blob
text + provider-format projection). If its `{count, epoch}` differs from `base` (adapter restarted,
cache evicted, first round), it pulls records from `E(contextSource).page(cursor)` (pages of at most
`contextPageBytes`, 4 frames, outbound from the vat to Node only, M1b decision 16.4; a page reads only
its own records, M1b QC) starting at the latest `Compaction` boundary, resolves blob
handles in batches, and rebuilds. Projection logic (Fae `journal-transcript.js`,
`context-transcript.js`, `transcript-records.js`) runs once, in Node, so there is no second
implementation to keep in byte-for-byte agreement (feasibility A-6). Native context is replayed from
its Blob, so a rebuild after a restart replays faithfully (R4-31).

Since M2 (D-18 in section 5) the records before `RoundRequest.base.archive.sealedTo` are in the
record archive, not in the vat: the adapter's cache holds the sealed part as the persisted
projection (`context.jsonl`) and pages from the vat only from `sealedTo`; a seal moves the base
with no vat crank. Providers (M2: OpenRouter and Anthropic, streamed, behind `AH/providers/round.js`)
read the projection, the key through the backend's grant, and the system prompt; they publish
deltas in-process (0 vat deliveries per delta, `provider.overhead` 0.5-0.6 ms median), retry only
while nothing was delivered (R4-74), and never put a provider body into a failure text (R4-79): a
provider is ordinary Node code beside the channels, and the vat sees one `roundFinal` or
`roundFailed` per round. The model catalogue (R4-104) is a per-Backend cache in the adapter; it
holds its Backend presences strongly (bounded) because a presence collected between calls comes
back as a new object (J-9403). Since step 3 the providers sit under one shell and one kind table
(section 4.9).

Compaction (P-36, M8): the vat decides from the previous usage reading (R4-34) and records
`CompactionStarted` before a tool-less summary round; the adapter plans the retained tail on its cache
and returns the summary as an ordinary round result; the vat records `Compaction`. A restart during
compaction is an ordinary outcome-unknown round. Unknown outcomes stay in the retained context (R4-35).

### 4.6 OCapN GC frames (core change CORE-9, C-17)

A peer that drops an import sends `op:gc-exports` (or `op:gc-answers` for answers) to the exporter.
Adapters coalesce per microtask, but a Node peer's finalizers run across many tasks, so a burst is
still 100-280 small frames over a second or two; every GC frame into a session vat in M1a was a
release by a native adapter's transient session (the agent host or the control adapter) of what the
session handed it per turn (Turn, TurnSink, receipts) (J-9120, J-9121). Since `f8bf23c62d`:

- A GC frame toward a worker is journaled (`gc: true`) and **not delivered on its own**. A run of
  them enters the worker in the same crank as the next ordinary frame, before it and in order, or
  alone once 64 have gathered. Frames are only ever delayed, never reordered, so nothing is released
  early. On Ironhorse such a crank is one evaluation, one drain, one collection (`deliverBatch`).
- **A GC frame never wakes a sleeping vat.** An idle vat keeps up to 64 held frames (3-6 per idle
  session measured) and the memory they would free until its next ordinary frame. The startup sweep
  wakes only workers owed a crank; forgotten transient sessions' releases are journaled, not
  delivered.
- **The crank boundary rule is part of the replay contract** (`journalCranks`), so a replay after a
  kill delivers the same cranks and regenerates the same outbound frames.
- Worker status rows report `journalLength` as the delivery frontier ("asleep and checkpointed" is
  still `snapshot.cut >= journalLength`) plus `heldFrames`, `wakes` and `cranks`; `status().gc` counts
  GC frames by session. A wake is best read from `wakes`.
- An engine wrapper that intercepts `deliver` must also intercept `deliverBatch`, or drop it.
- **When a vat's own GC frames leave** (CORE-11, since `f0ff5e098b`): a vat's finalizers run at its
  next collection, not in the crank that dropped the reference: up to 32 cranks later, at the first
  crank after a wake (close sweeps before the image and leaves the cleanups pending), or sooner when
  it allocated 131,072 slots or 16 MiB. Hub answer and export rows a vat releases therefore live
  longer (at most 12 owed answer rows over 80 calls in the lane scenario, 2 before; J-9301). Tests
  must not expect a release in the crank that freed its target.

Effect: session cranks per one-chunk turn 6.55 -> 4.01; idle sessions woken at the first restart
after setup 10 -> 0 (J-9123..J-9125, J-9192). The host side was the rest (C-20): each incoming GC
frame cost the supervisor a whole-`hub.json` persist and an fsync'd journal append per outgoing frame,
and a 161-frame burst held one turn start for 4.0 s (J-9127, J-9191, J-9195). CORE-10 commits once per
inbound burst and fsyncs once per worker flush (16.7 -> 6.6-7.0 ms per GC frame, J-9211..J-9213), and
CORE-12 makes each commit an append (GC ms per frame 2.2 -> 1.8, `hub.gcBurst.turnStart` median 143 ->
105 ms, p99 442 -> 373 ms, J-9333). Frames from the in-process endpoint and releases toward it are
still one commit each (J-9216). Fewer exports per turn would shrink bursts, but a long-lived viewer
(the M3 gateway) makes the same pattern.

### 4.7 The turn runner as built (step 3, HR-SYN-4; J-10206..J-10208, J-10240)

`guest/session/session.js` `makeSession` builds the session from parts, all made once, in this
order: the runtime (4.8), the delete **fence** `{ close, closed }` (one per session; `deleteSelf`
closes it before `beginDelete`), the record archive and its `ContextSource`, then the runner. The
runner (`turn.js` `makeTurnRunner`, 1,266 lines, was 1,553) keeps the turn's own life: claim,
settle, cancel, tool calls, rounds, the engine callbacks, the sink and `Turn` exos, the lease and
round sends. The other jobs are modules the runner is given or makes:

| module | job |
|---|---|
| `outbox.js` | the crank's events, one publish per crank (4.1) |
| `usage.js` over `guest/lib/usage-counts.js` | round and session usage; counts add by named key (`m2-interfaces.md` 12) |
| `ports.js` | the held `TurnPorts`, reopen after a retired break, the `since` comparison (4.4) |
| `turn-index.js` | `TurnInfo` by id, the retained `Turn` handles |
| `turn-import.js` | `importState` of turns |
| `recovery.js` `makeRecovery` | `recoverAfterRestart`, one per session with its own generation |
| `archive.js` | seals and the kept turns; `unresolved` only through `keepUnresolved`, `unresolvedInfo`, `resolve` |
| `turn-types.js` | shared JSDoc types only (`ActiveTurn`, `TurnInfo`, `RoundCalls`, `ToolIntent`); not bundled |

The runner answers no `archive`, `deleting`, `turnHandle` or `isLive` any more; export takes the
archive and the fence from `session.js`. Records, their order, the claim and settle sequences, the
publish points and every send are those of the old runner: a golden trace of every vat call in
delivery order (`test/unit/turn-runner-golden.test.js`, digest `eed428b3...`) and the fence-order
test are equal on the old and new guest. The history page and the archive's `History` share one
preview rule, `guest/lib/record-preview.js` (HR-SYN-28, J-10205, J-10235).

### 4.8 The session's extension mechanism: runtime parts (step 3, HR-SYN-15; J-10209, J-10245)

A per-session job joins the session as a **runtime part** in `guest/session/runtime-parts.js`, and
only so (the static `turn-hooks.js` tables, the module `WeakMap`s keyed by session objects,
`runtime.session` and `part(name)` are gone). A part is `{ name, make(runtime) }`; `make` runs once
in `makeSession`, synchronously, sends and awaits nothing, and answers the part's value: its own
members plus optional `hooks` and `tools`. Hooks are synchronous and run in table order in the
crank named: `onClaim(turn, item)` (claim crank, after `TurnStarted`), `beforeRound(turn)` (the
crank that sends `startRound`), `onCancel(turn)`, `onSettle(turn)` (after `TurnSettled`),
`onRecover(turn)` (recovery step 6, each part's guarded) and `nextTurn()` (a turn source, asked when
idle; the first that answers wins). A hook gets a frozen `HookTurn { active, round, append, emit }`:
records go into this crank's record log and events into this crank's outbox, so a hook adds no
delivery. `tools` is a `ToolSource`, asked every round after the static table under
`toolSetFor`'s name rules. The table is `powers, inspector, grants, exec, packages`; the order is
behaviour (recovery: exec, then packages). Adding a part (M6 `workspace`, M8 `compaction`, M9
`inbox` and `subagents`) is one name in `PartName` and `requiredParts`, one getter, one entry in
`runtimeParts`. What a part may and may not hold is the module's header and `step3-plan.md` 2; the
main limits are: no module-level state, no `await` inside a hook, no ports kept past their turn, no
state that must survive export or a restart.

### 4.9 The provider seam (step 3, HR-SYN-3 (a), HR-SYN-17; J-10220..J-10224, J-10247, J-10248)

Every backend kind answers the Endpoint with one `Provider` made by `AH/providers/shell.js`
`makeProviderShell({ timers, runRound })`: `startRound(req, channel, prepare, owner)`,
`cancelRound(turn)`, `releaseTurn(turn)`, one round control per turn (`round.js`
`makeRoundControl`). The two API kinds are `providers/api.js` `makeApiProvider(wire)` with a
per-vendor `wire` record (`anthropicWire`, `openRouterWire`); the pools (`subscriptions/provider.js`)
and the scripted double use the same shell (the scripted double keeps its own round source, plan
item (b)). `providers/kinds.js` holds `backendKinds`, one `BackendKind` entry per `BackendSpec.kind`
(`makeProvider`, `tools`, `unexpectedFailure`, `catalog`, optional `readModels` and
`acceptsModelId`), and `kindOf(spec)` is the only match of `spec.kind` in the provider code. The
pools' own kind table, `providerOfKind` and `poolKinds` (`guest/lib/subscription-texts.js`), stays
as the pools' table: reading `kindOf` from `subscriptions/` would make an import cycle. The model
catalogue and the pool catalogue share `providers/catalog-core.js` (`makeCatalogOwner`,
`makeOwnerTable`, `readJson`, `boundedJson`) with their bounds as parameters (16 MB and
`4 * maxBackends` owners; 8 MB and `2 * maxMembers`). `providers/event-log.js` holds the event
log. Behaviour change named by the row: an API or pool round without `prepare` is refused
(`PREPARE_REQUIRED`) before any key, credential or request. The requests sent are byte-equal before
and after (wire goldens `test/fixtures/provider-wire-golden.json`, `pool-wire-golden.json`). A new
kind adds one entry to `backendKinds` (and, only if it is a pool kind, one line to the pools'
table).

---

## 5. Keeping transcripts from slowing cranks and snapshots

Measured: 20 M characters of strings in a heap move crank latency only from 64 to 66 ms, but grow the
snapshot by about 3.3 bytes per character and the state directory roughly doubles while running
(tooling.md 4.4). The chunk ceiling (256 MiB, max 512 MiB) is a hard wall that quarantines.

**D-10. Small records in the vat; large text in blobs from the moment it arrives.**

- Any text field over `inlineBytes` is a Blob plus a preview (section 9), staged by whoever produced
  it (gateway for submissions, provider code for model output, the callee for tool results, the exec
  vat through a `BlobWriter` for large exec results). Content is never deleted (R4-64); session delete
  releases its blobs.
- A settled turn is therefore a few KB in the vat. 10,000 turns are tens of MB of heap, below the
  chunk wall, but not necessarily below the **slot** ceiling. Until CORE-11 every crank paid a full
  collection of the live heap (C-7): M1b measured per-turn time rising from 0.69 to 2.46 s over 1,000
  turns (J-0370). With the allocation schedule a crank no longer pays it, but a collection still
  marks the whole live heap (about 0.4 ms per 1,000 live slots), so per-turn time still grows,
  slower: 0.75 s at 300 turns, 1.7 s at 2,000, 2.7 s at 4,000 (J-9383, J-9388); the live heap grows
  about 270 slots and the slot capacity about 230 slots per turn (1.14 M live, 1.55 M capacity at
  4,000 turns, J-9389). The session vat's slot capacity per 100 turns is `history.grow` (J-0395) and
  per session length `crank.heap`.
  **D-18 (M2, D-M2-1). The record archive: settled turns leave the vat heap.** The numbers said
  so (J-9383: at 5,000 turns a 114 MB snapshot, 556 ms collections, 3.2 s per turn, a 180 s
  context rebuild, a 516 KB hub row), so M2 built it (`m2-interfaces.md` 4). The session vat keeps
  128-159 settled turns (`archiveKeepTurns` 128, segments of `archiveSegmentTurns` 32; R4-106's
  256/256 defaults were re-stated, J-0403); in the settle crank, when more are kept, it records the
  seal's intent and sends `ArchivePort.seal` with the range's fingerprint; the agent-host adapter
  writes the segment file (`.part`, fsync, rename, directory fsync, chained SHA-256 digest) before
  it answers, and the vat drops the records only in the crank of a matching answer, so a SIGKILL
  anywhere loses or duplicates nothing. As built after the M2 review (M2-FIX, J-9485): no code but
  session delete unlinks a segment file. Validation against the vat's `ArchiveState` keeps the
  vat's chain, every file the manifest marks acknowledged and every file that chains forward from
  the vat's state; only a file at an ordinal the vat's chain fixes with another digest is an
  orphan, and it is renamed `<name>.orphan` and removed with the session. Whether a state is stale
  comes from the persisted acknowledged chain, never from adapter memory (eviction or a restart
  once let a stale page delete an acknowledged segment, J-9445). An unreadable file is kept and
  counted, a damaged same-name file is kept as `.bad`, and an answered seal the vat never applied
  stays on disk until the vat seals that ordinal again (at most one file per crash). The vat keeps an index of `SegmentEntry` ranges and
  one chained digest, not a handle per segment (every handle a vat holds is a hub row entry). The
  adapter keeps, per session, the segments, `context.jsonl` (the persisted projection of sealed
  turns) and `mirror.jsonl` (the kept records); a context rebuild reads them plus one vat page, and
  `History`/`SealedText` serve archived pages and contents with no vat crank. Sealed turns' blob
  handles are let go, so the hub row stays bounded. Measured (J-0461, J-9404): from 200 to 5,000
  turns the session vat's slot capacity, snapshot size and time, per-delivery time, hub time per
  turn and hub row are flat (0.96-1.01 x), the context rebuild is 85-359 ms (was 4-180 s) and an
  archived history page 40-55 ms. What still grows with the session is adapter-side: the
  per-round projection copies the whole sealed transcript (7.5 ms per prepare at 5,000 turns, 52
  ms at 30,000, J-0491) until M8 compaction bounds it, and the archive's disk (about 2.3 KB of
  segment and 1.5 KB of `context.jsonl` per archived turn). A session built by `importState` keeps
  a larger slot capacity than a grown one (1.07 M against 0.41 M slots: the import cranks' high
  water, J-9405). The M2 close-out's exclusive pass (J-9496) repeated the flatness at 1,000 and
  5,000 turns (0.95-1.07 x; one hub-row character ratio 1.39 x at 1,000 with an answer owed at the
  read). The turn path's remaining stall is not the archive: the core's worker transport takes
  its cadence snapshot (every 256 deliveries) between a busy turn's deliveries, so the turn that
  crosses the count waits for the whole snapshot (`checkpoint.stall` p99 1.0-1.4 s against 1 s;
  core candidate C-24, J-9494). As built after step 3 (J-10231, J-10235): segments (`.part`,
  removed on error), the manifest (no directory fsync: rebuilt from the segments), `context.jsonl`
  and `mirror.jsonl` (caches, no fsync) are written through `AH/files.js` with those sequences
  unchanged, and the archive's `History` previews a turn with the vat's own rule
  (`guest/lib/record-preview.js`), so an archived page and a kept page agree. `makeArchiveStore`
  is still one 1,240-line closure (theme T7 of `arch-review/harness.md` 4; outside step 3).
- History pages are 32 turns and at most `frameBytes`; a turn larger than that returns a summary with
  refs (as built: `Turn.getContent()`, or `History.turnContent` for an archived turn). The browser
  reads blob content through the gateway's `Content`
  service in-process (0 vat deliveries; one manager crank to resolve handles after a restart).
- Guest code never builds strings with `+=` in loops; it uses arrays and `join` (lint check in
  `guest/` and the "too big" perf probes).

---

## 6. Confinement

**D-11. Model-written code runs in a per-session exec vat, in one persistent Compartment.** The exec
vat is created lazily on the first `exec` call (from the spare pool). It holds one `Compartment` whose
global object persists across calls and restarts (Appendix F.1 #5: `globalThis.x = 5` survives;
probe confirmed nested compartment globals persist across deliveries). Endowments: `E`, `harden`,
`sleep(ms)` (an adapter timer passed per call), `console` (a bounded per-call log returned with the
result, W-13), and `powers`, a **live** read facet over the session's label map (`get(label)`,
`list()`), not a copy (coverage 34). No `Date`, `Math.random`, `import`, filesystem. Each call is
wrapped as an async function body so top-level `await` and `return` work; top-level `const`/`let`
are per call, `globalThis.name = v` persists. The R4-26 guest prompt text ("each call is a fresh
function body") is rewritten to describe the persistent scope (M5; journal).

The source travels inline when it is at most `inlineBytes`; above that the exec vat reads it from its
Blob in pages of at most `frameBytes` (one answered page per crank), joins them and evaluates in one
crank. A source never travels in one message above `frameBytes`: one message of 150 k or more halts
the receiving vat (S3, J-0195). `execSourceBytes` (262,144) is the bound on the staged source: S3
staged and evaluated 262 k in 3.9 s (11 frames; evaluating crank 175 ms) and 400 k in 6.0 s; above it
the call fails with "exec source too large (N bytes; limit L)". A result over `inlineBytes` is cut to
the tool limit (R4-46) inside the exec vat and written in pieces of at most `frameBytes / 2` to the
`BlobWriter` passed with the call, one answered piece per crank.

Lifetimes:

- **Synchronous runaway** exceeds the crank budget and halts the exec vat (`MeterAbort`, never
  retried, D-17); at 50 M it ends in about 240-270 ms. The session sees its pending call break with the
  retired text (from a guest vat this means the vat is lost, never a restart), records the scope loss,
  **retires the lost vat explicitly** through `ExecHandle.retire()` (about 17 MB each; `retire()` also
  cancels any retry the supervisor still owes it) and takes a fresh one on the next call. The session
  cannot tell a halt from a crash give-up (both break with the same text, and the worker facade does
  not expose the recorded `failure`; only the operator's `status()` does), so the tool result does not
  claim a cause it cannot see (J-9051): "exec scope terminated: the exec vat stopped (it exceeded the
  per-step compute budget or its worker failed repeatedly); bindings from earlier calls are gone". The
  compute ceiling per crank is about 600 k simple iterations at
  10 M computrons and about five times that at 50 M [inferred] (journal: weaker than Endo's exec).
- **A crashing exec worker** (killed, or missing the 60 s watchdog) is retried by the supervisor
  (D-17); the call stays pending meanwhile, so the execution deadline below still bounds it: a call that
  misses the watchdog every time is retired by the deadline during its second attempt.
- **Asynchronous runaway or hang** is bounded by `execDeadlineMs` (default 120 s, fixing G-18; a
  departure from R4-48, open decision 10): the session arms an adapter timer
  (`E.sendOnly(endpoint).armDeadline`) in the crank that issues the call; on `deadline(opId)` it
  records the timeout and retires the exec vat (the only way to stop it).
- **Cancel does not retire the exec vat** (R4-49: a running tool is not interrupted). The session
  settles the call `execAbandoned` and sends `ExecScope.abandon()` (sendOnly, before any later
  `run`; also from recovery), which ends the call in the exec vat: the next call runs at once in the
  same scope (M1b QC, J-0391). If the exec vat is still busy when the next exec call arrives anyway
  (an `abandon` was lost), it answers `{ busy }`, the session retires it and tells the model "the
  previous exec call was still running; the scope was reset". Every scope loss is stated in the tool
  result and journaled when first seen.
- **A call's end is a fence** (M1b QC, J-0391): a call ends when its body's promise settles or it is
  abandoned. Each call gets its own `sleep`; a sleep asked for after the call ended sends nothing
  and never settles, so code the model leaves running (`(async () => { for (;;) await sleep(0);
  })(); return 1`) stops at its next sleep (sleeps already in flight still answer: one more step at
  most) instead of keeping the vat cranking; nothing else in M1b reaches outside the vat. M5's
  `powers` must keep this: a facet per call that goes dead with it, or the deadline no longer bounds
  asynchronous work.
- **Name-table exhaustion** (fact 4) answers `{ status: 'exhausted' }`; the session records
  "exec scope terminated: the exec vat ran out of property names ..." and retires the vat (J-0390).
  Model code that catches and swallows the RangeError is not seen until a later call meets it.

W-6 is fixed: the exec scope shares no worker with tokens.

Tools other than `exec` are exos in the session vat that call capabilities. Their outputs are bounded
by the callee **per field** so the serialised result stays valid JSON under the tool limit (fixing
G-19): `runCommand` returns `{ exit, stdout, stderr, truncated }` where stdout and stderr are each cut
(with the R4-46 marker inside the field) so the whole JSON fits 32,768 units; `readSources` and
`askSubagent` budget their fields the same way. Granted tools are remotables with `describe()` and
`execute(args)` (P-65); built-in names are protected.

As built in M5 (and the cross-lane integration): sessions take their authority from presets
(built-in and user presets, revision compare-and-set, endowments snapshotted at creation, prompts
composed and frozen at creation); a session holds one label map (`list`, `lookup`, `store`,
`remove`, at most 256 labels) and the exec vat gets a per-call `powers` facet over it that dies with
the call. No answer from an object the session did not mint enters a session vat: the exec vat's
`inspect` calls such objects and answers a bounded, rendered result (D-M5-2). Model code reaches
other vats' objects only through a per-call membrane (D-M5-3: 12,288 bytes, 32 keys per record,
depth 32; tagged values keep their tag; only data and this call's wrappers may be sent or stored,
a hand-built remotable is refused). Granted tools are discovered every round; adapter tools that
carry a description (`accountStatus`) reach the model through one generic tool-table entry, and a
static name is never shadowed. Guards live in a chain of modules (`guest/lib/guards/base.js` <
`session.js` < `factory.js` < `interfaces.js`), each entry in the module of the lowest program that
reads it; bundles at X-CLOSE: session 214,690 of 240,000 bytes, exec 63,826 of 120,000. The cost
that shows in every M5 perf miss is about 7-15 ms per handle crossing into or out of a vat.

Reachability: neither a session vat nor an exec vat can reach `AgentHostAdmin`, `SecretsAdmin`, any
`Secret` admin or value, the factory, the gateway or another session's facets. M4 tests this with
`thix reachability` from both vats (coverage 28).

Native adapters are unconfined Node with the daemon user's authority (native.md section 5); only the
operator can install them. They correspond to the spec's unconfined caplets; the durable halves and
all harness vats are confined. One agent-host process holds gateway, providers, channels, secrets,
blobs and speech: a crash drops every socket, stream and context cache at once. Mitigations: errors
are caught per connection and per round; speech engines run as supervised child processes; context
caches rebuild lazily per session (journal: blast radius).

---

## 7. Browser client, transport and auth

**D-12. The gateway is part of the agent-host adapter and speaks CapTP over WebSocket.**

- Registration: `host.serveGateway({ port, operator, publicOrigin, trustedProxies })`; the adapter
  binds `127.0.0.1:<port>` (the reverse proxy and TLS are out of scope). Any non-upgrade GET returns
  the app shell; static assets are served from `implDir` (D-14) with correct content types and a
  strict CSP (W-15). WebSocket upgrade on `/ws` only; Origin must equal `publicOrigin` (W-1).
- Protocol: `@endo/captp`, each message UTF-8 JSON in one WebSocket binary frame (as built in M3,
  `m3-interfaces.md` 2 and its decision 5; a text frame closes the socket; the server is the adapter's own, `AH/gateway/server.js`, with no
  `ws` dependency since step 3, J-10234). The bootstrap offers only `fetch(secret)`; a correct
  secret returns `{ operator, live, content, composer }`: the `Operator` presence imported from the
  factory vat plus three gateway-local services (`Live` subscriptions, `Content` blob reads, `Composer`
  submissions and queue edits that stage large text). The browser keeps the secret in the URL fragment
  and sends it only inside the WebSocket.
- **Failed sign-in limiter (W-8):** +1,000 ms per failure (R6-76), keyed by client address. When the
  socket peer is in `trustedProxies` the client address is the right-most `X-Forwarded-For` entry not
  in `trustedProxies`; otherwise the socket peer. A global ceiling (default 20 failures per minute)
  bounds guessing through many addresses.
- **Frame guard:** the CapTP bridge measures every call it forwards to a vat (sum of string bytes,
  estimated as UTF-16 units x 3) and refuses one over `frameBytes` with "message too large; use the
  composer" before it reaches the hub. Max WS message 1 MiB.
- **Key guard:** the bridge also refuses a call whose arguments contain a record with a key outside
  one vocabulary, the union of every key the harness's interfaces and shapes name
  (`AH/gateway/vocabulary.js`, `guard.js`; `m3-interfaces.md` 4.4), with "unexpected field". As
  built this is weaker than a per-method check: any known key may be sent to any method. It is the
  right trade (the vat's name budget is spent once, on a fixed set), but a reader must not assume
  the method's own shape was checked before the exo guard;
  every fresh record key a vat receives costs it one of its about 57,000 names for life, and running
  out leaves the session failing every new name for good (fact 4; a catchable error, not a halt). An exo guard cannot protect the vat from either: decoding
  happens before the guard runs.
- Objects the adapter owns (`Live`, `Content`, `Composer`, `SecretWriter`, audio streams) are local
  exports of the same process, so their traffic never leaves the adapter; a returned own export
  resolves to the local object (`pkg/src/net/hub.js:804-812`).
- Audio uses a second WebSocket route `/audio` authenticated by a short-lived capability token minted
  by `VoiceServices.openAudio()` (binary frames, never CapTP JSON), with inactivity timeouts (M11).
- UI: copy and adapt `space-floot` (presentational Preact) and `chat/floot-component.js` +
  `floot-*.js` helpers from 1315bef86, replacing pet-name lookups with `Operator` methods and
  `watch()` pulls with `Live` subscriptions; extract client audio (l.2019-2774) into `ui/src/voice/`.

Restart: sockets drop; the client shows the reconnect overlay (0, 1, 2, 5, 10, 30 s backoff, then every
30 s), rebuilds from `watch` snapshots, re-subscribes and re-attaches a running turn through
`getCurrentTurn` (R4-62). A refused connection means "server starting": while a crashing vat holds
startup (D-17) nothing listens for 30 s to several minutes, so the overlay says "Server starting..."
and keeps retrying; no server-side page is needed.

As built (M3, then the cross-lane integration): the bootstrap's `fetch(secret)` answers
`GatewayPowers`: the factory's `Operator` passed through and this incarnation's `Live`, `Content`,
`Composer` and `History`, plus `extras` from extensions (the page's secret writer first). The
bridge is pass-through CapTP (D-M3-1): every call is checked on its encoded form before decoding
(frame bytes, record keys against a vocabulary built from the interface tables listed in
`guest/lib/vocabulary-tables.js` (HR-SYN-7: an explicit list, no glob; a failing table fails the
bind), method names (rule 4a), depth, page-made objects, calls in flight, exports
and answers per connection, 4,096 each). Extensions and UI features are directory registries
(`AH/gateway/extensions/`, `ui/src/<feature>/feature.js`), so M4 and M5 added panels, chips, the
preset editor and `@` mentions without editing M3 files. Measured (X-CLOSE): sign-in 0.5 ms, guard
0.11 ms per 24 KB call, a session call 23 ms, a delta fan-out to 5 clients 2 ms with no vat
delivery; a viewer's presences still grow its vats' hub rows (`ui.hubGrowth` 1.91 x, CC-051 +
CC-060 requested).

**D-13. Native reinstall indirection.** D-14 makes reinstalls rare. When one is needed, objects minted
by the old manager vat (Secrets, Backends, Blobs, Routes) break; sessions receive their
`SessionServices` from the factory, which can rebuild and push them (`SessionInternal.importState` path
in M13). During development builders use fresh state directories.

---

## 8. Time, ids and randomness

- Ids are counters in the owning vat: session key `s<n>`, turn id `t<n>`, op id `t<n>/r<round>/c<ordinal>`,
  queue entry key `q<n>`. No randomness needed in vats.
- Unguessable tokens (sign-in secret, asset path tokens, audio tokens) are minted in adapters
  (`node:crypto`).
- Time is data: every adapter-to-vat message carries `at` (ms), including `enqueueOnce`, which only the
  gateway's Composer calls, so the submission window check (24 h window, 5 min skew, R4-98) always has
  a fresh time (coverage 13). The session keeps `lastKnownTime` for other uses.
- **Interactive timers are adapter timers**, not the clock resource (about 1 s per alarm, fact 8):
  exec deadlines, `sleep` in exec, turn deadline, subagent ask timeouts. They die with the adapter, which
  is correct because the turn they belong to dies too. The clock resource is used only for durable
  alarms that must outlive a restart (none planned before M9's mail backlog timers [inferred]); when
  used, it is `arm()` with cancel, one alarm per owner, never `after()` without cancel (feasibility A-13).

---

## 9. Limits that protect vats

Every vat-facing input and output has a bound enforced **on the sending side** (adapter, gateway, or
the vat's own message builders) and again by the exo guard. Sizes are **UTF-8 bytes** unless stated;
guest code estimates a string's bytes as UTF-16 units x 3 (no per-character loop).

**Where the values live.** The measured settings are in `config/defaults.js` (`limits`, with the
evidence in comments; `m0-results.md` page 1 gives the margins). Node code imports that file. Guest code
cannot (bundles read only `guest/`): `guest/lib/limits.js` holds a copy and a unit test keeps it equal
to `config/defaults.js`. The core's `STAGING_FRAME_BYTES` (`pkg/src/core/evaluate-source.js`) is a
third copy of `frameBytes`, kept equal by `test/limits.test.js`; changing `frameBytes` is a core commit
too. The other rows below are design settings, kept in the module that enforces them.

| Bound | Value (file) | Measured basis | Spec default it replaces |
|---|---|---|---|
| `frameBytes`: string content of one message into or out of a vat | 24,576 (`config/defaults.js`) | one inbound message halts above 94,208 at 50 M, on fresh and full vats; 24,576 inbound in 312 ms (budget 357) (J-0193, J-0194). The plan's target of 196,608 is unreachable while `harden` costs per byte (C-5). | n/a |
| `crankOutBytes`: all messages sent in one crank | 196,608 = 8 frames (`config/defaults.js`) | 8 x 64 KiB `sendOnly` in one crank 553-576 ms, no halt (J-0142) | n/a |
| `inlineBytes`: larger text fields are Blobs | 8,192 (`config/defaults.js`) | plan value; about 80 ms of inbound per field at this size | n/a |
| `vatKeyNames`: distinct record keys a vat may ever receive or create | 57,000 per vat, for life (`config/defaults.js`) | 57,075 after boot, 54,378 after a 250 k program; exhaustion is a catchable RangeError, not a halt (J-0191, J-0333); the exec vat answers `exhausted` and is retired (J-0390) | n/a |
| Slot ceiling (`THIXOTROPE_SLOT_CEILING`, daemon-wide): live heap plus one crank's allocation | 4,000,000 slots of 24 bytes (`config/defaults.js` `slotCeiling`, set by `scripts/serve.mjs`; Thixotrope's default is 1,000,000) | a 100-call round halted a session vat at 1,000,000 and passes at 4,000,000; 256-call rounds pass (J-0362, J-0392) | n/a |
| Vat frame ceiling (`THIXOTROPE_VAT_FRAME_BYTES`, daemon-wide; core CC-027): one encoded frame the hub forwards into a vat | 65,536 bytes (`config/defaults.js` `vatFrameBytes`, set by `scripts/serve.mjs` at a crank budget of 50 M or more; Thixotrope's default is 32,768) | `frameBytes` bounds string content only: an import chunk of short turns encodes to 40,040 bytes; the halt at 50 M is 94,208 (J-0194, J-10125) | n/a |
| Progress checkpoint writes per round | at most `progressWriteFactor` (3) x the text so far; superseded checkpoints deleted once the session answers it kept the newer one | 1 MiB reply: 34 MB written before, 3.6 MB after (J-0313, J-0393) | n/a |
| Eventual sends per crank (guest code rule) | 100 (`config/defaults.js` `sendsPerCrank`) | answered sends halt at 250 (fresh vat) / 300 (used vat); `sendOnly` at 600 (J-0143, J-0194) | n/a |
| Exec source, **staged** in `frameBytes` pages then evaluated in one crank | 262,144 (`config/defaults.js` `execSourceBytes`) | 262 k staged in 3.9 s, evaluating crank 175 ms; one message of 150 k halts (J-0195) | none |
| Crank budget (`THIXOTROPE_CRANK_BUDGET`, daemon-wide) | 50,000,000 (`config/defaults.js` `crankBudget`, set by `scripts/serve.mjs`) | runaway ends in 242-271 ms; 100 M buys nothing (J-0143) | n/a |
| Crashes in a row before a vat is given up (`THIXOTROPE_MAX_DELIVERY_ATTEMPTS`) | 5 (`config/defaults.js` `maxDeliveryAttempts`, set by `scripts/serve.mjs`) | D-17; J-9046, J-9051 | n/a |
| Session program bundle | 270,336 bytes since WX.1 (`limits.sessionProgramBytes`, owner question G-1's default; 240,000 since M5, 200 KB before; checked by `bundle-guest.mjs` output and the `session.program` perf row; the factory's program store keeps at least as much) | cold session vat 6.4 s for a 246 KB program (J-9045) | n/a |
| Staging chunk for program sources | `frameBytes` units for ASCII, `frameBytes / 3` units otherwise | `evaluateSource` default 8,192 units (J-0186) | n/a |
| previews (messages / tool calls and results) | 1,024 / 256 | | n/a |
| Message string (submission, through the Composer) | 200,000 characters (staged as a Blob; the limit is WS message size and context, not frame cost) | | 100,000,000 (R4-97) - lower; open decision 1 |
| Tool output into the model | 32,768 UTF-16 units with the R4-46 marker, per-field for structured results; staged as a Blob when over `inlineBytes` | | same (R4-100) |
| Tool arguments into a vat | the model's JSON arguments travel as one string (inline or Blob), never as a record (`vatKeyNames`) | J-0191 | n/a |
| Container output per stream (adapter) | 64 KiB, then per-field budget | | same (R3-47) |
| Tool calls per round / in flight | 64 / 16 | | none - open decision 11 |
| Live publish batch from a vat | 64 events and `frameBytes` | | n/a |
| History page | 32 turns and `frameBytes` | | 32 turns |
| Context page to adapter, session list page | `contextPageBytes` (98,304) and 512 records, to the adapter only (M1b decision 16.4); 50 rows | | n/a |
| Exec deadline | 120 s; compute bound = crank budget | | none (G-18; R4-48) - open decision 10 |
| Turn wall-clock deadline | off (configurable) | | none (R4-48; G-06) |
| Queue | 100 waiting; at most 4,096 receipts, pruned by age (24 h) at each `enqueueOnce`, none holding an exo | J-9152 | same (R4-98) |
| Settled turns | a record each (kept for life, R4-64); a `Turn` exo is minted when a page or receipt hands it out, and only the 32 most recently handed out are kept (`retainedTurnHandles`); clients compare turns by `turnId` | after 1,000 turns 32 live `Turn`s (1,000 before) (J-9152) | n/a |
| Live subscribers (adapter, `channelLimits`) | 4,096 queued deliveries or 2 MiB per subscriber; 32 subscribers per session; reorder window 32 batches / 4,096 deliveries / 1,000 ms | J-9170..J-9172 | n/a |
| Held GC frames per vat (core, `GC_FRAMES_PER_CRANK`) | 64, then delivered alone in one crank | J-9122 | n/a |

---

## 10. Test strategy

- **Scripted fake model provider (no credentials).** Backend kind `scripted` in the agent-host
  adapter takes a script as data: rounds of `{ chunks: [text], chunkDelayMs, toolCalls: [{name, args}],
  usage, error?, stall?: 'untilCancel' }`. A scripted **adapter tool** `echo({ text, delayMs, bytes })`
  whose delay lives in the adapter is used for parallelism and size tests. `test/fixtures/fake-provider-server.mjs`
  is a local HTTP server that speaks the four wire formats (Anthropic Messages SSE, OpenRouter chat
  completions streamed, OpenAI Responses SSE, Claude subscription Messages SSE) from recorded fixtures,
  including 429 with rate-limit headers, 401, 5xx, overload and mid-stream disconnect.
- **Fake container runtime** (`resources/containers/runtime-fake.js`): runs allowlisted argv as
  child processes in the session directory under a scratch HOME with the same result shape, timeouts
  and output caps. Real Podman steps are tagged `[real-podman]`.
- **Fake speech** (`fake-stt`, `fake-tts`, plus hanging variants for timeout tests). `[real-moonshine]`,
  `[real-piper]` steps are tagged.
- **Layers.**
  1. Unit (Node, `ses-ava` lockdown): `guest/lib` and `guest/session` logic with in-memory fakes;
     ported Endo tests (reuse.md section 5). Fast; run often.
  2. Adapter (Node): providers against the fake server, secrets backend, blob store, channels,
     gateway auth and frame guard, fake container runtime, git via the real `git` binary.
  3. Integration (real Ironhorse supervisor, ava `test.serial`, gated by `THIX_HARNESS_INTEGRATION=1`):
     end-to-end turns, SIGKILL of the supervisor and restart. Every file starts from a
     **pre-provisioned state template** (spike S8 proved state directories path-independent, J-0180)
     through the helper `test/template/index.js`:
     - `ensureTemplate({ id, provision, crankBudget })` finds or builds a cached template
       `tmp/t<key>`: a supervisor serves a throwaway `tmp/b<pid>`, workspace `w` is created, the
       caller's `provision(context)` runs with `context.client` (a control client on `w`) and
       `context.connect()`, the supervisor stops cleanly and the directory is renamed. The key covers the
       worker binary, the boot bundles, `WORKSPACE_VERSION`, the crank budget, `TEMPLATE_VERSION`,
       `id`, the slot ceiling and any `THIXOTROPE_GC_*` or `THIXOTROPE_HUB_STORE` that is set, so a
       template is rebuilt whenever any of them changes. M1a passes its
       `scripts/provision-steps.js` as `provision` with its own `id` (for example `m1a`).
     - `startFromTemplate(template, { t, idleSleepMs = 2000, root })` clones it (APFS clone, about
       0.1-0.35 s for 160 MB) to a new `tmp/<6 chars>` and starts the supervisor child; it returns
       `{ root, client, pid(), timings, connect({ workspace }), kill(), stop(), restart(), cleanup(),
       stderrTail() }`. `kill()` is a real SIGKILL of the supervisor process only (never its group, so
       no vat crash is counted, D-17); `restart()` serves the same copy again; `cleanup()` runs from
       `t.teardown`: stop, kill strays, delete the copy (`KEEP_STATE=1` keeps it).
     - `takeIntegrationLock(test, label)` holds the run lock for the whole file; `integrationEnabled` is
       true under `THIX_HARNESS_INTEGRATION=1` or `THIX_HARNESS_SPIKES=1`; `removeTemplates()` deletes
       every cached template; `copyState`, `connect`, `processesUnder` and `killStrays` are exported for
       perf and spikes.
     Integration state uses `idleSleepMs: 2000` so idle vats checkpoint quickly (fact 6), and tests wait
     for checkpoint and `pool.whenSettled()` before a SIGKILL. A template start costs 5.6 s against
     about 35 s for a cold provision (J-9045). The control socket path
     `tmp/<6 chars>/control.sock` is 98 bytes in this checkout against a 104-byte limit: keep 6-character
     names directly under `tmp/`, or pass a shorter `root` (J-0182). Never copy a running state
     (J-0181). Budget: **each integration file** under 5 minutes; at most 300 MB of state.
  4. Browser (Playwright from `packages/exo-playwright` or the built-in browser pane) against a local
     gateway with the scripted backend: reconnect, reload, phone width, voice with synthetic audio.
- **Supervisor process.** Every serve (the `scripts/serve.mjs` CLI, `serveHarness()`, the template
  helper, the perf harness) runs the supervisor in a child process started by `spawnSupervisorChild`,
  with only the allowlisted environment (which includes `THIXOTROPE_SLOT_CEILING`,
  `THIXOTROPE_GC_*` and `THIXOTROPE_HUB_STORE`) plus `THIXOTROPE_CRANK_BUDGET` and
  `THIXOTROPE_MAX_DELIVERY_ATTEMPTS`; the child refuses to serve from any other environment. It holds a
  pipe from its parent on fd 3 and closes the supervisor cleanly when the parent dies, even by SIGKILL
  (J-9021). Its record is `<state>/harness-serve.json`.
- **Run lock.** Integration tests, spikes, perf checks and the Ironhorse lane run under the run lock
  (`scripts/run-lock.mjs`): a machine-wide pool of slots under `<THIX_HARNESS_HOME>/run-lock/`
  (default 4); perf checks take every slot (designs/process.md section 2). Each slot's record holds a
  random generation id, the taker's pid and start time and the workload's pid and start time; the lock
  is held while either is alive (a reused pid with another start time counts as dead); a new lock is
  hard-linked into place fully written; a stale generation is deleted only by the holder of that
  generation's break token. A command run under the lock sees `THIX_HARNESS_RUN_LOCK=<generation>`
  and nested takers in it pass through (J-9020). Parallel builders wait on it; the PM holds it for
  milestone sign-off runs. Never run the full T suite concurrently with integration tests (tooling.md
  2.1).
- **Gates and their variables.** `THIX_HARNESS_INTEGRATION=1` enables integration files;
  `THIX_HARNESS_SPIKES=1` enables `test/spikes/` (each spike takes the lock itself; per-spike knobs such
  as `S1_BUDGETS`, `S1_PARTS`, `S6_COUNTS` are documented in each file); `THIXOTROPE_IRONHORSE_WORKER`
  overrides the worker binary (default `target/release/thixotrope-ironhorse-worker`); `KEEP_STATE=1`
  keeps state; `SPIKE_OUT` / `PERF_OUT` append JSON lines to a file. Without the gates `corepack yarn
  test` runs the unit lane only.
- Acceptance tests check observable behaviour through the public API, the browser or the network.
  Implementation counts (resident records, wake counters, journal contents) are perf/gate checks.

---

## 11. Performance-check method and budgets

**Method** (adapted from tooling.md section 5):

1. Scripts `packages/thixotrope-harness/perf/<feature>.perf.mjs`, sharing `perf/_harness.mjs`:
   `runPerf(feature, fn)` takes the run lock and sets the exit code; `provision()` starts state in
   `tmp/pf<pid>` through the template helper's supervisor child (fresh by default, or the cached base
   template with `provision({ template: true })` or `PERF_TEMPLATE=1`, which saves about 17 s) and emits
   `<feature>.provision`; `stats`, `single`, `timed`, `emit`, `hubJsonBytes`, `du`, `workerRss`, and
   deliveries from `status().timings` deltas. Existing scripts: `frames`, `install`, `crash`
   (`FRAMES_N`, `LOOP_N`, `INSTALL_N`, `CRASH_*` shorten them). A CapTP WebSocket client is added with
   the gateway (M3).
2. Run under the run lock, one at a time, release worker, fresh bundles, never alongside tests:
   `cd packages/thixotrope-harness && node perf/<feature>.perf.mjs` (the script takes the lock itself;
   `corepack yarn perf` runs every script in turn). State is removed in `finally` (`KEEP_STATE=1` keeps
   it). Perf state is served with `IDLE_MS` (default 1 h, so nothing sleeps mid-measurement) unless the
   check is about sleeping or restart, which sets 2,000 ms.
3. Output: one JSON line per metric:
   `{"metric":"<feature>.<op>","unit":"ms","n","median","p95","p99","max","deliveries":{"count","perOp"},"hubJsonBytes","snapshot":{...},"budget":{"median","p95","deliveriesPerOp"},"pass","commit","workerSha256","crankBudget","loadAvg"}`.
   Exit 1 when a median exceeds 1.25 x budget or deliveries per op exceed the budget. At least 200
   samples for latencies, 5 runs for start/restart.
4. Every feature that moves data into a vat has a "too big" probe (string bytes, list length, sends
   per crank, calls per round) proving the sending-side bound fires before the vat would halt.
5. Results go into `JOURNAL.md` with the commit and the load average.
6. Bulk fixtures (hundreds of sessions or thousands of turns) are built with `importState` (one crank
   per `frameBytes` of records), never by running turns.

**Budgets** (M3 Max class machine; deliveries = durable vat deliveries). The evidence column
gives what M0 and M1a measured where it bears on a budget (M1a's full table is in `milestones.md`,
M1a outcome); `m0-results.md` page 7 has every check. A budget
marked **depends on C-n** is not reachable until that core candidate (`m0-results.md` page 6) is
fixed: the check is run and recorded, a miss is journaled against C-n, and it does not block a
milestone by itself.

| Metric | Budget | Evidence (M0, M1a) |
|---|---|---|
| `frames.inbound` / `frames.outbound` at `frameBytes` | no halt; <= 300 ms over the ping floor | 312 / 69 ms with a 57 ms floor: pass (J-0193) |
| `frames.halt` (S1) | `frameBytes` <= half the halt point on fresh and used vats | 94,208 / 98,304 at 50 M: pass (J-0194) |
| `vat.evaluateProgram` 150 k source, staged | <= 2 s; no MeterAbort; **depends on C-5** | 2.2-2.3 s, 95 % of it staging (J-0193, J-9024) |
| `loop.runaway` at the crank budget | <= 1 s | 242 ms (J-0193) |
| Turn start: submit accepted to provider request sent (scripted backend) | median <= 350 ms; <= 3 deliveries | M1a: 255 ms, 2 frames, p99 0.5-3.0 s from GC bursts (C-20); 573 ms while ports were opened per turn (J-0272, J-9191). After CORE-11/12: 105 ms, p99 428 ms, 2 deliveries; on a long session 121-152 ms up to 1,000 turns, 233 ms (p95 1.4 s) at 4,000 (J-9382, J-9383) |
| Live delta: provider chunk in adapter to WS frame out | median <= 5 ms; 0 deliveries per delta | M1a: 0.17-0.18 ms to an in-process subscriber; 18 ms through a control client (J-9173, J-9191) |
| Deliveries per model round | <= 1 + ceil(round seconds / 10) + tool results | |
| Tool intents per round | in the round-final delivery, 0 extra | |
| Turn lease | 1 delivery per turn | M1a: a plain turn is 4 session deliveries including the lease answer (J-9191) |
| `exec` trivial call (session -> exec vat -> session) | median <= 250 ms | vat -> adapter -> vat 70-76 ms per answered call (J-9043); M1b 179 ms, after CORE-11 53 ms (J-9382) |
| `exec` first call in a session (spare exec vat) | <= 750 ms | a spare take is 157-176 ms (J-9045); was 1.5 s; M1b 541 ms, now 285-298 ms (J-9382) |
| `exec` 100 answered sends / 100 `sendOnly` | <= 8 s / <= 1 s | S1 from a probe vat: 100 answered 9.4-10.6 s until all answers were back, 100 `sendOnly` 490-513 ms (J-0143, before CORE-4); exec vat: 7.0 s (J-9368) -> 1.3-1.4 s after CORE-11 (J-9382); `sendOnly` not measurable until M5's `powers` |
| Session create with spare pool / without | <= 750 ms / <= 6 s; without **depends on C-5** | take 157-176 ms (was 1.5 s); cold 6.4 s for a 246 KB program (J-9045); M1a cold 6.14 s for the 157 KB session program (J-9192); M1b with the pool 1.2 s (miss), after CORE-11/12 849-864 ms (pass under 1.25 x), cold 4.5 s (J-9382) |
| `session.program` session program bundle size | <= 270,336 bytes since WX.1 (240,000 until then, 200 KB until M5) | M1a: 157,493 bytes (J-9192); after step 3 of the review 212,484 (J-10250); after WX.1 233,126 |
| Session list, 100 sessions | <= 200 ms per 50-row page; 0 session vats woken | |
| Session watch snapshot, 1,000-turn session | <= 300 ms; <= `frameBytes` | |
| History page (32 turns) | <= 300 ms; **depends on C-5** or W2.5's record bound | M1a: 0.77 ms in Node with the structural guard (18 ms strict) (J-9153); in a vat 568-596 ms at 22 turns of 7 records, 869 ms on a 1,000-turn session: the page crank's own marshalling (J-9382, J-9383, J-9387) |
| Queue enqueue while a turn runs, round trip from the browser | median <= 150 ms | |
| Concurrent: 10 sessions streaming with tool rounds at once | per-session turn start <= 2 x single; crank p95 <= 200 ms; row push <= 500 ms; **depends on C-2** (the rest) | M1b 3.6 x / 500 ms / 372 ms; after CORE-11/12 6.5 x (728 vs 112 ms) / 500 ms / 189 ms: 24.6 s of a 30 s hub window are commits (J-9382, J-9386) |
| Daemon throughput: deliveries per second at saturation | recorded; journal if < 50/s | adapter-to-adapter 82 events/s; a vat's batched `sendOnly` 236/s (J-0163, C-2) |
| Hub state after 1,000 turns with a UI attached / after 50 sessions | <= 2 MB; ms per delivery <= 1.25 x fresh; **depends on C-2** (the rest) | 43 KB -> 630-690 KB during 2,000 hops, 110 KB at rest (J-0163); log store: image plus log up to 1.35 MB, 1.36-1.40 x fresh (J-9333, J-9382) |
| Checkpoint stall: turn latency while a busy session vat snapshots | p99 <= 1 s | |
| Restart to serving, 50 idle sessions (checkpointed), no vat crashing | <= 15 s; 0 idle session vats woken | 4.4-5.8 s with 0-50 sleeping vats, 0 woken (J-9045, J-9050); M1a 10 idle + 1 in flight: 6.1-9.7 s, only the in-flight session woken, 5 of 5 runs (J-9192); after CORE-11/12 3.3-6.9 s (median 4.1 s), healthy 10 sleeping vats 2.7-3.0 s (J-9382) |
| Restart to serving with one session vat crashing on every replay (bound 5) | <= 15 s; recorded; **depends on C-8, C-9** | 35.8 / 68.5 / 36.4 s (J-9046); M1a session vat 20.3-20.5 s, plain vat 35.7 s (J-9192); now session vat 18.2-18.4 s, plain vat 66.2 s (J-9382, J-9390) |
| Restart to serving after SIGKILL with unsnapshotted vats | recorded; **depends on C-3** for growth | 11.0 -> 18.2 s over 24 kills with idle sleep 1 h (J-9044); M1a one awake session 8.8-9.3 s, asleep 5.1-5.6 s (J-9190) |
| Restart with 20 sessions that have environments | <= 15 s; 0 containers started | |
| Clean shutdown, 50 sessions | <= 5 s | small state closes in 1.9 s (J-0147) |
| Disk per idle session (session vat only / with exec vat) | <= 25 MB / <= 50 MB | 17.3 MB per sleeping vat (J-9045) |
| Session vat snapshot with 10,000 turns | <= 1 s; decides whether M13 builds an archive | already 1.29 s and 114 MB at 5,000 turns (J-9384) |
| Long session (one session, 5,000 turns of a tool round and two staged native contexts) | recorded; turn start, history page and context rebuild budgets apply at every length | per turn 0.84 s (50) -> 3.2 s (5,000); turn start 121 -> 271 ms (p95 1.8 s); history page 0.54 -> 2.0 s; context rebuild 1.3 -> 180 s; slot capacity 13 -> 48 % of 4,000,000; the session's hub row 516 KB (J-9383..J-9389) |
| Secret read per round | in-process, <= 1 ms, 0 deliveries | |
| Container `runCommand(['true'])` harness overhead over runtime | <= 150 ms | |
| git `status` on 10 k-file repo through the capability | <= 1 s | |
| Asset request first byte | <= 20 ms; 0 deliveries | |
| Audio frame path | 0 deliveries; STT partial <= 300 ms after 0.5 s of new audio (real engine) | |
| TTS first audio after first sentence (warm) | <= 1 s (real engine) | |
| Factory install of the bundled program, up to 300 k characters | <= 15 s (was 30 s) | 11.6 s ASCII, 14.0 s for 478 KB of mixed text (J-0193) |
| `template.start` copy + start to serving | <= 10 s (was 20 s) | 5.6 s (J-9045) |
| OCapN GC burst: turn start while a peer releases 100+ objects | median <= 350 ms; p99 recorded, <= 1 s **depends on C-20** | M1a: median 248 ms, p99 0.52 s, max 4.0 s with 6 session cranks (J-9192); now 106 ms, p99 293 ms (J-9382) |

---

## 12. Guest coding rules (enforced in review)

1. No `Date`, `Math.random`, `setTimeout`, `console`, dynamic `import`, `WeakRef` in `guest/`.
2. No string `+=` in loops; no unbounded `slice` chains; build with arrays and `join`.
3. No more than 100 eventual sends per crank (`sendsPerCrank`; answered sends halt at 250-300);
   fan-out to many receivers is an adapter's job.
4. Suspended async generators and `Array.fromAsync` may span deliveries and clean restarts (spike S5,
   J-0147; `pkg/README.md` is stale on this), but they are retained state and need a bound or a delete
   path like any other (rule 6). Their survival of a SIGKILL replay is untested; do not hold turn state
   only in one.
5. Every exo method guard bounds string length and array size; every message builder checks
   `frameBytes` and `crankOutBytes` (estimate: units x 3) and splits or stages before sending.
   **No single message over `frameBytes`**, in either direction: an outbound message from one vat is
   another vat's inbound frame, and one inbound message above about 94 KB halts the receiver for good.
6. Objects, not ids, except F.2 (a)-(e); every retained collection has a bound or a delete path
   (owner's PR 1248 rule: bound retained state, not lifetime counts).
7. Durable vats never hold browser viewers or other per-connection objects; they publish to an
   adapter channel.
8. A retired break from an adapter object on the turn path means "restart": route it to recovery,
   never record it as a tool failure. A retired break from a guest vat (exec vat, child session) means
   that vat is lost (halted or given up, D-17): retire its handle and state the loss. After a restart,
   never wait for a guest call to settle; abandon it by generation (J-9048). Test with
   `isRetiredBreak(error)` (matches the hub text, `pkg/src/net/hub.js:1947`), kept in one helper
   (`guest/lib/retired.js`).
9. Code shipped into vats is frozen there: keep vat programs thin, state as plain records, so
   `exportState`/`importState` (M2) can move it to a new program version. The session program bundle
   stays at or below `limits.sessionProgramBytes` (270,336 bytes since WX.1, owner question G-1's
   default; 240,000 since M5; 200 KB before): every spare vat pays about 10 us per byte to load it
   (D-4).
10. **No data-dependent record keys crossing into a vat, and none created inside one.** Every distinct
    property name a vat ever receives or creates takes one of its about 57,000 names for life
    (`vatKeyNames`, fact 4). Keys of records sent to or built in a vat come from a fixed vocabulary
    (the interface shapes in `guest/lib/interfaces.js`). Data-keyed collections cross as arrays of
    `[key, value]` pairs and are kept inside the vat as `Map`s built there; JSON from models, providers
    or tools crosses as a string. Adapters and the gateway enforce the same on their side (section 7
    key guard).
11. **Staged sources.** Program source and any text larger than `frameBytes` reach a vat in chunks of
    at most `frameBytes` bytes (`frameBytes` units for ASCII, `frameBytes / 3` units otherwise) and are
    joined and evaluated (or recorded) inside the vat; text larger than `inlineBytes` is a Blob, read in
    pages when a vat needs it. Never send a source in one message.
12. **Bound a crank by what it builds, not only by its bytes** (M1b QC, J-0392). One crank's
    allocation plus the vat's live heap must fit the slot ceiling (fact 3; nothing is collected
    inside a crank): count the records, events, guard checks and sends one crank can produce from
    one input (a round of `maxCallsPerMessage` calls, a page of `pageRecords` records) and keep the
    worst case tested (`m1b-qc.test.js`); page or spread work whose size the input chooses. Never
    copy a growing collection in a crank that needs only part of it (`RecordLog.at`, not `since`).
13. **An endowment that reaches outside a vat is per call and dies with the call** (M1b QC, J-0391):
    exec's `sleep` today, M5's `powers` facets next, so model code cannot outlive its call.

---

## 13. Open decisions (need the owner; the default in brackets is what builders implement meanwhile)

1. Submission message limit 200 k characters instead of the spec's 100 M (R4-97 is [default]).
   [200 k]
2. Dormant-after-restart (D-5) replaces R4-65's eager inbox resumption: inbox mail received before a
   restart waits until the session's next wake. [dormant]
3. Transcripts at rest (W-16, G-33): unencrypted heaps and blobs in a 0700 state directory, or encrypt
   blobs; retention policy. [0700, retain until session delete]
4. Secrets wrapping key custody: key file outside the state dir (D-6, W-4 partly fixed: same-user
   adapters can read it) now; macOS Keychain / systemd credentials later? [key file]
5. `full-control` preset (W-3): which attenuated operator facet does it get? [not built until decided;
   network `off` by default when built]
6. Upgrade policy: data-only `exportState`/`importState` exists from M2; automated upgrade in M13, or
   fresh state per release until the harness stabilises? [M13]
7. Occasional items P-59 (workflows), P-60 (Android), P-62 (daemon-to-daemon peers), P-63 (other
   spaces): build after M13, or drop? Parity is not complete until this is ruled on. [after M13]
8. Codex reset-credit redeem (R4-86, wire format never exercised): build behind a flag or defer. [defer]
9. Per-session disk cost (two vats, about 36 MB) with about 21 GB free: session count cap (G-13)?
   [cap 200 sessions, configurable]
10. Exec deadline 120 s (fixes G-18, departs from R4-48) and turn deadline off (R4-48, G-06). [as stated]
11. Tool calls per round capped at 64 (no spec bound). [64]
12. G-05: retry Claude subscription overload (529) like Codex (R4-75) while nothing was delivered,
    departing from R4-76. [retry]
13. Compaction window from configuration for Claude and the Anthropic API so compaction can fire
    (fixes G-04/G-05, departs from R4-37). [configured window]
14. G-10 spending limits, G-11 voice preset pinning a model that may leave the catalogue (fall back to
    the factory default with a warning), G-15 date in the prompt, G-26 backend for agent-built apps.
    [none / fall back and warn / no date / none]
15. Crank budget raised daemon-wide to 50 M (S1 chose it, J-0143: runaway ends in about 0.27 s; 100 M
    buys nothing). [50 M]
16. Crash bound `THIXOTROPE_MAX_DELIVERY_ATTEMPTS` (D-17): 5 keeps a vat through about 15-60 s of host
    trouble but holds startup 31-64 s when one vat crashes on every replay; 2 serves in under 10 s but
    gives a vat up about 1 s after its first crash, for good. [5]
17. A session vat given up after repeated crashes is lost with no reinstate operation in core (C-11),
    which conflicts with keeping transcripts. Ask the core owner for a reinstate operation (clear
    `failure`, keep the journal), and meanwhile keep the lost session listed and its state on disk until
    the operator deletes it? [ask core; keep listed]
18. BOM handling: Syrup now keeps a leading U+FEFF (`5a73049032`), and the Ironhorse `TextDecoder`
    strips a leading BOM unless `ignoreBOM`, as the Encoding Standard requires (J-0111, J-0113,
    J-0192). [as built]

---

## 14. Glossary

The harness's words (HR-SYN-30), from `arch-review/harness-ontology.md` section 5 as reconciled in
`arch-review/harness.md` section 6 with the core's glossary (`arch-review/core-ontology.md`
section 5), plus the step 3 structure (4.7-4.9). Bold is the word to use; brackets name words to
avoid in that sense. Persisted and wire names (`sealedTo`, `epoch` in `context.jsonl`, `label`,
`members`, tool argument names, `SealedText`) are not renamed: the glossary fixes what they mean.
Words shared with the core keep the core's sense and are defined there: vat, worker, incarnation,
crank, delivery, frame, journal, snapshot ("heap snapshot" in harness prose), hub, hub session,
session epoch, host, host endpoint, native resource, manager, adapter, launcher, registration,
installation, workspace, retire and forget, durable, ephemeral and transient.

**Places and parts**

1. **harness**: the server in this package: factory, session and exec vats and the agent-host
   native resource. [not: Floot, Familiar]
2. **Familiar** is the browser client; **Floot** the persona the model is told it is. Neither
   names a component.
3. **operator**: the owner, who holds `Operator`.
4. **factory**: the installed vat with the session index, presets, inventory and spare pool.
5. **session**: one agent conversation, one session vat. The core's sense is written **hub
   session**. [not, in code: conversation, chat]
6. **session vat**, **exec vat**, **spare**: a session's program vat; its lazily made vat for model
   code; a vat preloaded with a program and kept by the factory.
7. **exec scope**: the exec vat's persistent bindings, reached through `ExecHandle.scope()`.
8. **agent host**: the agent-host manager vat plus its adapter (one Node process per **adapter
   incarnation**); its facets are `AgentHostAdmin` and a session's **session host facet**.
9. **gateway**: the HTTP and WebSocket server in the agent-host adapter; the **bridge** is its
   CapTP side, with the frame guard and the key guard.
10. **start count**: how many times the factory's start listener ran (`guest/factory/starts.js`).
    [not: epoch]
11. **listener handle**: what `onStart` answers. [not: Registration, the core's word]

**Turns**

12. **turn**: one input processed from claim to settle.
13. **round**: one model request and the tool calls it asks for. [not: step, tool round]
14. **attempt**: one try of a round's request by a provider module or one pool member.
15. **turn generation**: the counter that makes late answers of an abandoned turn ignored.
16. **turn endpoint** (`Endpoint`): the adapter's object for one session's turns. [not: endpoint,
    the core's host endpoint]
17. **turn lease**: the answered `holdTurn` call whose break signals a restart. [not: lease alone;
    `ExecLease` is now `ExecScopeInfo`]
18. **ports** (`TurnPorts`): what `Backend.open(host)` answers: turn endpoint, publisher, tools,
    `since` and the adapter services added since M1b.
19. **sink**: a vat-side object an adapter reports into (`TurnSink`, `AgentHostSink`).
20. **retired break**: a call rejected with the hub's retired text; from an adapter object it means
    restart, from a guest vat that the vat is **lost**.
21. **turn runner**: `turn.js` `makeTurnRunner`, the turn's own life (4.7).
22. **runtime part**: a per-session job in `runtime-parts.js` with optional **hooks** (called with
    a **hook turn**, `HookTurn`) and `tools` (4.8). [not: turn hook table]
23. **delete fence**: the session's one `{ close, closed }` that stops claims once delete begins.
24. **outbox**: the events of one crank, published once (4.1).

**Records and streams**

25. **turn record**: one entry of the session's **record log** (`TurnRecord`).
26. **transcript record**: one entry of the projection's output, the format providers read.
    "Transcript" means this format only.
27. **context projection**: turn records to transcript records, in the adapter, per round; its
    per-session copy is the **context cache**, whose compaction counter is the **context epoch**
    (not the core's session epoch).
28. **native context**: a round's opaque provider payload (signed thinking, encrypted reasoning),
    carried as `providerContext`.
29. **archive** (verb and noun): whole settled turns moved from the record log into **segments**.
    [not: seal; "seal" means encryption]
30. **archived ref**: the `{ key }` stand-in for a blob inside archived records.
31. **history page**: a page of turns, from the vat or, for archived turns, the adapter's
    `History`; both preview a turn with one **record preview** rule (`record-preview.js`).
32. **live event**: what a session publishes for viewers, plus the adapter's **delta** and
    **snapshot event**; the **fold** makes a view of them.
33. **live delivery**: one numbered live event in a batch. [not: delivery alone, the core's]
34. **channel**, **publisher**, **subscription**, **watch**: the adapter's stream; the vat's handle
    to publish on it; a viewer's handle to read it; the snapshot read (`Session.watch`). The
    subscription plan is written **subscription plan**.

**Input**

35. **submission**, **request id**, **receipt**: what a client sends, its idempotency key, and the
    session's answer to it.
36. **queue entry**: a waiting submission ("queued message" to the user); a **hold** stops the
    queue. [not: pending row, waiting entry, queue item]
37. **Composer** (the gateway service) and **composer** (the input box); a **draft** is its
    unsent text.

**Backends and secrets**

38. **backend**: a manager-vat `Backend` of one **backend kind** (`scripted`, `openrouter`,
    `anthropic`, `claude-pool`, `codex-pool`; `providers/kinds.js`).
39. **provider**: the vendor behind a kind; its code is a **provider module**, run under the one
    **provider shell** (4.9). [not: a backend]
40. **pool** and **member**: a subscription backend and its entry for one login, with its
    **credential** (the Secret's JSON) and its **account reading**.
41. **Secret**, **read grant**, **SecretWriter**, **sealed box**: a stored secret, the right to read
    it, the adapter-local writer, and a value sealed to the adapter's public key.
42. **store key** `k<n>`, **blob file key** `b<n>`, **archive key** `h<n>`, **history cursor**
    `h<n>`, **API key**: five keys; the two `h<n>` are different things.
43. **wrapping key**: the one key behind the secret store, the audit log, the sign-in file and the
    sealed boxes; one object per adapter incarnation (D-6).
44. **sign-in secret**: the gateway's password, in its own file (`signin.enc`).

**Objects, tools and presets**

45. **label**: a session's name for an object (its petname); **title**: a display name; **pool
    name** and **built-in id** for the two keyed uses. [not: label as display name or key]
46. **attachment**, **package**, **endowment**: an object sent with a label; one message's
    attachments, open for its turn (not M9's mail package); an object a preset gives a session.
47. **inventory**: the operator's labelled objects.
48. **powers**: the per-call object model code receives, and `GatewayPowers`. [not: an options
    bag, which is **options** or **deps**]
49. **tool**, by **site**: adapter tool, granted tool, object tools, exec tool; a **tool grant**
    gives a session a granted tool.
50. **preset**, **preset snapshot**, **preset template**, **state template**: a session recipe; its
    frozen copy in a session; a built-in recipe to start from; a prepared state directory for
    tests and perf. [not: template alone]
