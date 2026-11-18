# Build milestones: the Endo harness on Thixotrope

Companion to `architecture.md` (decisions D-1..D-16, core changes CORE-1a/1/1b, settings in its
section 9, budgets in its section 11). All code is written in
`/Users/xyz/Development/endo-thixotrope-harness` on branch `claude/thixotrope-harness`.
`H/` = `packages/thixotrope-harness/`. `pkg/` = `packages/thixotrope/`. `AH/` =
`H/resources/agent-host/impl/` (the run-time-loaded implementation, D-14).
Endo reference files are read with `git -C <T> show 1315bef86:<path>`. Spec items are cited as
SPEC:<line> in `endo-harness-spec.md`. M0 and M1a are done: what M0 measured and changed is in
`m0-results.md` (which also keeps every core-change candidate's status), M1a's outcome table is in its
section below, and decisions or budgets changed because of them are listed in "Changes after M0 and
M1a" at the end of this file.

## Conventions for every milestone

- **Ownership.** Each milestone owns the paths listed. Milestones that run in parallel own disjoint
  paths. Shared files are of two kinds:
  - **Hook tables** (append-only: a milestone adds registration lines or table entries, never edits
    another milestone's entries; the PM resolves trivial merges). Each is created by the milestone
    named in brackets:
    `H/guest/session/tool-table.js` [M1a], `H/guest/session/turn-hooks.js` [M1a] (`beforeRound`,
    `onCancel`, `onSettle`, `turnSources`, `recoverySteps`), `H/guest/session/holds-table.js` [M2],
    `H/guest/factory/services.js` [M1a] (per-session `SessionServices` builders),
    `H/guest/factory/session-options.js` [M1a] (`createSession` option resolvers),
    `AH/index.js` [M1a] (implementation registrations), `AH/channel-taps.js` [M1a],
    `AH/projection-hooks.js` [M1b], `AH/gateway/routes.js` [M3 W3.0], `H/ui/src/features.js`
    [M3 W3.0], `H/scripts/provision-steps.js` [M1a].
  - **PM-merged files**: `H/package.json`, `H/perf/_harness.mjs`, `H/JOURNAL.md`. Builders append;
    the PM merges. Journal entry numbers are pre-allocated per milestone so parallel builders never
    collide: M0 J-0100.., M1a J-0200.., M1b J-0300.., M2 J-0400.., M3 J-0500.., M4 J-0600..,
    M5 J-0700.., M6 J-0800.., M7 J-0900.., M8 J-1000.., M9 J-1100.., M10 J-1200.., M11 J-1300..,
    M12 J-1400.., M13 J-1500.., PM J-9000...
  - **Ownership transfers** (sequential only): `H/guest/session/prompt.js` M2 -> M5;
    `H/scripts/provision.mjs` runner M1a -> M12 (the steps table stays append-only for everyone).
- **Run lock.** Integration tests, spikes, perf checks and the Ironhorse lane run only under
  `H/scripts/run-lock.mjs` (architecture section 10); integration files take it with
  `takeIntegrationLock(test, label)`, perf scripts through `runPerf`, anything else with
  `node scripts/run-lock.mjs --label L -- <command>`. Parallel builders wait for it; never run two
  Ironhorse workloads at once.
- **Integration gate.** Integration files are skipped unless `THIX_HARNESS_INTEGRATION=1`; they start
  from the state template (`H/test/template/index.js`, architecture section 10) with `idleSleepMs`
  2,000, and kill only the supervisor process (`state.kill()`).
- **Done means:** unit + adapter tests pass; the milestone's integration files pass alone, each in
  under 5 minutes with the state template (M0 S8); every listed perf check has been run and its JSON
  lines pasted into `H/JOURNAL.md` with commit, crank budget and load average; at least one journal
  entry on fit; temporary state deleted; commits are incremental (at least one per work unit; core
  changes in their own commits).
- **Work units** are sized for one subagent in one sitting (roughly one focused day).
- **External software** is always behind an adapter with a fake. Steps needing the real thing are
  tagged `[real-podman]`, `[real-git]` (the Mac has git; always available), `[real-moonshine]`,
  `[real-piper]`, `[real-provider]` (needs credentials; owner-run only), `[real-browser]`.
- **Perf budgets** are medians unless stated; failing at > 1.25x budget blocks the milestone and is
  escalated to the PM with a journal entry. Bulk fixtures are built with `importState`, not by
  running turns.
- **Acceptance tests are observable behaviour** (public API, browser, network, fake-provider and
  fake-tool logs). Implementation counts (wake counters, record counts, deliveries) are perf/gate
  checks.

## Order and parallelism

```
M0 -> M1a -> M1b -> M2 -> { M3 | M4 | M5 }      (M3 W3.0 merged before any M4/M5 UI unit starts)
M5 -> { M6 | M8 | M9 } ;  { M3, M4 } -> M11 (parallel with M6, M8, M9)
M6 -> { M7 | M10 } ;  { M3, M4, M5 } -> M12 (parallel with M7, M10) ;  everything -> M13
```

Parallel groups: **{M3, M4, M5}**, then **{M6, M8, M9, M11}**, then **{M7, M10, M12}**. The ownership
check at the end lists every file and hook point each group touches.

---

## M0. Groundwork: frame cost, package skeleton, fit spikes

**Status: done.** Build commits `0d35cbd569..7fa1a7057a`; PM follow-ups `3f2b90954e..6677f92fcc`
(upstream PR 1667 merged, snapshot goldens re-pinned, run lock and serve fixes, perf through the
template helper, restart re-validated). Journal J-0100..J-0198 and J-9000..J-9051; summary in
`m0-results.md`. The work-unit table below is kept as the record of what M0 was asked to do; the
outcome follows it.

**Goal.** Make a vat survive the messages the harness needs, choose the frame and crank-budget
settings with numbers, and prove the Thixotrope mechanisms the architecture rests on, before any
harness code depends on them.

- **P / R:** none (enabling). Settles core.md section 11 checks 1, 5, 6 and native.md first tasks 1-2.
- **Depends on:** nothing.
- **Owns:** `rust/engine/ironhorse-vm/src/interp/boot.rs` and the boot path for CORE-1a, the new
  native in `rust/engine/ironhorse-vm` and `rust/endo/xsnap/src/polyfills.js` (CORE-1),
  `pkg/src/core/evaluate-source.js` (CORE-1b), `pkg/test/ironhorse/text-codec.js` (new),
  `H/package.json`, `H/README.md`, `H/JOURNAL.md`, `H/scripts/{bundle-guest,run-lock,serve}.mjs`,
  `H/perf/_harness.mjs`, `H/perf/frames.perf.mjs`, `H/test/spikes/`, `H/test/template/`,
  `H/lint/guest-rules.js` guest rules (hooked into the root `eslint.config.js`; the repository has no
  per-package `.eslintrc`), root workspace registration of `H`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W0.1 CORE-1a | VM boot / vat compartment path; rebuild worker | trace why `typeof Uint8Array.fromBase64` is `undefined` in a vat while the VM installs it (`boot.rs:800-808`); fix so `packages/base64/src/decode.js:86` captures the native at load | vat probe: `typeof Uint8Array.fromBase64 === 'function'`; base64 of 192 KiB decodes in one crank at 10 M |
| W0.2 CORE-1 | native `decodeUtf8`/`encodeUtf8Into` in `rust/engine/ironhorse-vm`; `polyfills.js:20-160` wrappers | `TextDecoder.decode` calls the native; `{stream:true}` carries an incomplete tail in JS; `{fatal:true}` throws `TypeError` on malformed input, else U+FFFD; `TextEncoder` uses the native encoder; rebuild `pkg/dist-ironhorse` | new `pkg/test/ironhorse/text-codec.js`: split `e2 82 \| ac` gives `€`; fatal throws on `c3 28`; 1 M random code points round-trip; `test:ironhorse` lane still 55/55 (run serially, under the run lock) |
| W0.3 CORE-1b | `pkg/src/core/evaluate-source.js:32` | staging chunk = `frameBytes / 3` characters (from S1), surrogate-safe as now | install of a 300 k bundle; existing install tests |
| W0.4 skeleton | `H/package.json`, `H/scripts/{bundle-guest,run-lock,serve}.mjs`, `H/perf/_harness.mjs`, `H/JOURNAL.md` (from journal-seed.md), lint rules | `bundle-guest` turns `H/guest/<prog>/main.js` into one source string with prelude names as globals (no bundled `@endo/*`); lint forbids `Date`, `Math.random`, `setTimeout`, string `+=` in loops in `H/guest/`; `serve.mjs` sets the env allowlist and `THIXOTROPE_CRANK_BUDGET`, refuses to lower the budget unless the last shutdown was clean; `run-lock.mjs` (O_EXCL, pid, stale break); `_harness.mjs` from `survey/baseline.mjs` plus `provision()`, `idleSleepMs`, `hubJsonBytes()` | unit: a guest importing `@endo/patterns` fails lint; bundle has no copy of `@endo/patterns`; two lock takers serialise |
| W0.5 spikes A | `H/test/spikes/{s1,s3,s5}.test.js` | **S1** frame halt points in and out, single string and 8-32 strings per message, several messages per crank, sends per crank, runaway-loop wall time, each with and without CORE-1a/CORE-1 and at crank budgets 10 M / 50 M / 100 M; output sets `frameBytes`, `crankOutBytes` and the crank budget. **S3** evaluate a 150 k and 400 k program source in a fresh vat in one message at the chosen settings (sets `execSourceBytes`). **S5** does a suspended async generator persist across a delivery and a restart in the shipped worker | each spike asserts its finding and prints JSON lines; verdicts are journal entries |
| W0.6 spikes B | `H/test/spikes/{s2,s4,s7,s9}.test.js` | **S2** attach pattern: (a) a durable vat holds and calls a transient adapter object, (b) the call breaks with the retired text after restart, (c) restore re-attaches, (d) the adapter sees one stable presence for one vat object within an incarnation. **S4** adapter-to-adapter hop cost and whether `hub.json` ever holds frame payloads bound for transient sessions. **S7** a registration spec carrying a foreign remotable survives restart. **S9** SIGKILL right after a vat crank that records an intent and sends a call to an adapter object: after restart the record exists and the adapter ran the call at most once (intent-before-effect, coverage 17) | as above |
| W0.7 spikes C | `H/test/spikes/{s6,s8}.test.js`, `H/test/template/` | **S6** spare-vat pool: create, sleep, take, wake, first `make()` cost and disk per vat. **S8** state template: provision once, clean shutdown, copy the directory per test under a new short path; check path independence (socket path, `runtime/` copies); measure copy + start | as above; template helper used by every later integration file |

**Acceptance tests**
1. With the settings S1 chose, 200 messages of `frameBytes` each are sent into a vat and 200 out of
   it with no halt, and S1 records a halt point of at least 2 x `frameBytes`.
2. A Syrup string with malformed UTF-8 is refused by a Node peer and by a vat alike (fatal decoding).
3. `test:ironhorse` passes 55/55 with the new boot bundle (gate).
4. Spikes S1-S9 have a recorded verdict in `JOURNAL.md`; D-7 (attach) and D-4 (spare pool) are
   confirmed or the fallback (CORE-2 / CORE-3) is raised to the PM.

**Perf checks**
| check | budget |
|---|---|
| `frames.halt` per configuration (S1) | recorded; chosen `frameBytes` <= half the halt point |
| `frames.inbound` / `frames.outbound` at `frameBytes` | <= 300 ms over the ping floor |
| `vat.evaluateProgram` 150 k source | <= 2 s, no MeterAbort |
| `vat.spareTake` wake + `make()` | <= 500 ms |
| install of a 300 k factory bundle (CORE-1b) | <= 30 s |
| `loop.runaway` wall time until MeterAbort at the chosen budget | <= 1 s |
| `template.start` copy + start to serving | <= 20 s |

**Outcome.**

| item | result | entries |
|---|---|---|
| Acceptance 1 (200 frames in and out; halt point >= 2 x `frameBytes`) | pass: 200 x 24,576 in (median 349 ms) and out (68 ms); halt at 94,208-98,304 on fresh and used vats | J-0194 |
| Acceptance 2 (malformed UTF-8 refused by Node and vats) | pass: fatal decoding in both Syrup decoders and the vat polyfill; a crafted-frame vat test was not written | J-0192, J-0197 |
| Acceptance 3 (`test:ironhorse` gate) | pass: 65/65 (55 original + 1 base64 scenario + 7 text-codec + 2 key-space), re-run after the PR merge | J-0196, J-9042 |
| Acceptance 4 (spike verdicts) | S1 settings chosen (J-0141..J-0144, J-0194); S2 D-7 confirmed, CORE-2 not needed (J-0160); S3 sources must be staged (J-0146, J-0195); S4 hop 25 ms, `hub.json` holds transient frames in clear (J-0163, J-0164); S5 async generators persist (J-0147); S6 D-4 confirmed, CORE-3 not needed (J-0183..J-0185); S7 foreign remotables in specs survive (J-0162); S8 templates work (J-0180..J-0182); S9 intent before effect holds (J-0165) | |
| Perf table | all pass; `vat.evaluateProgram` 2.2-2.3 s passes under the 1.25 x rule only (staging cost, C-5) | `m0-results.md` page 7 |
| W0.1 CORE-1a | landed in `@endo/immutable-arraybuffer`, not in `boot.rs` (the shim hid the statics) | J-0100 |
| W0.3 CORE-1b | the staging chunk is 8,192 units (`frameBytes / 3`); install 300 k in 11.6 s | J-0120, J-0193 |
| Core changes beyond the plan | CORE-4 engine `getOwnPropertyDescriptors` index keys (`d0fd6b1138`), CORE-5 Syrup BOM (`5a73049032`), CORE-6 halt on session end (`63927edaba`), CORE-7 exports (`042171c094`) | architecture 1.1 |
| Open | the core-change candidates C-1..C-15 | `m0-results.md` page 6 |

**Deferred:** nothing from M0's scope; CORE-2 and CORE-3 are not needed.

---

## M1a. Headless session slice (smallest end-to-end)

**Status: done.** Build commits `6e3b8692f7..91458e17b5` (W1a.0..W1a.7 and the QC fixes); hardening
`a88ecbf159..58e7b572c1` (adapter channels and tooling, ports held per adapter incarnation, settled
turns as records, the C-16 engine fix `9828522485` and the C-17 core change `f8bf23c62d`, integration
fixes). Journal J-0200..J-0296, J-9100..J-9127, J-9150..J-9157, J-9170..J-9174, J-9190..J-9200. The
work-unit table below is kept as the record of what M1a was asked to do; the outcome follows it.
Where the contract changed after the build (ports per incarnation, records for settled turns),
`m1a-interfaces.md` is current and the rows below are historical.

**Goal.** One session vat, a scripted fake backend and an adapter tool: submit a message, stream
events to a subscriber, run one parallel tool round, kill and restart, and find the session,
transcript and queue intact with the in-flight turn marked outcome-unknown and nothing sent twice.

- **P:** P-03 (factory API, no UI), P-08 (single round loop, parallel calls), P-09 (one subscriber),
  P-10 (FIFO only), P-13 (records), P-14, P-21.
- **R:** R3-23, R3-24, R3-25, R3-26, R4-1, R4-2, R4-3, R4-6 (title, preset, backend, `modelId`;
  creating/ready), R4-10, R4-40, R4-43, R4-44, R4-45, R4-50, R4-52, R4-54, R4-60, R4-65 (as amended
  by D-5), R4-66, R4-67.
- **Depends on:** M0.
- **Owns:** `H/guest/lib/{interfaces,limits,turn-engine,reply-fold,transcript-records,bounded,retired}.js`,
  `H/designs/m1a-interfaces.md`,
  `H/guest/session/{main,session,turn,turn-hooks,queue,records,live,recovery,tool-table}.js`,
  `H/guest/factory/{main,root,factory,services,session-options,rows}.js`,
  `H/resources/agent-host/{durable,ephemeral}.js`, `AH/{index,attach,endpoint,channels,channel-taps,live-service,composer,timers}.js`,
  `AH/providers/scripted.js`, `AH/tools/echo.js`, `H/scripts/{provision.mjs,provision-steps.js}`,
  `H/test/{unit,adapter,integration}/m1a-*`, `H/test/fixtures/scripts/`,
  `H/perf/{turn,restart,session}.perf.mjs`.

**Note for builders.** reuse.md:353 says an interrupted provider call should be re-issued; do not:
R4-66 and architecture section 4.4 forbid it. Read `m0-results.md` first: in particular the frame
ceiling (no single message over `frameBytes`), the per-vat name table (no data-dependent record keys,
architecture rule 12.10), staged sources (rule 12.11), and crashes versus halts (D-17).

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W1a.0 interface contract | `H/guest/lib/interfaces.js`, `H/guest/lib/limits.js`, `H/designs/m1a-interfaces.md`, `H/test/unit/m1a-interfaces.test.js` | One subagent, first, alone. `interfaces.js` exports the `M.interface` guards and method names of every object that crosses between M1a's units, in object-passing style (objects as arguments, strings only for F.2 reasons): `Session`, `SessionInternal`, `Turn`, `QueueEntry` and `Receipt`, `Endpoint`, `TurnSink`, `ContextSource` (shape only; built in M1b), `Live` and `Composer`, the channel `Publisher` and `Subscriber` facets, the tool-table entry (`describe()`, `execute(args)`), `SessionServices`, `SessionHostFacet`, `RowReporter`, `AgentHostAdmin` and `Backend` (M1a subset of architecture 3.3), `HarnessRoot`, `Operator`, `SessionFactory`, `SpareMaker` (shape only; M1b), and the record shapes of architecture 4.3 (`TurnStarted`, `Dispatched`, `Partial`, `RoundSettled`, `ToolIntents`, `ToolResult`, `TurnSettled`) and of `SessionRow`. Every string and array in a guard is bounded from `limits.js`; every record shape is a closed `M.splitRecord` with a fixed key vocabulary (rule 12.10); tool arguments are JSON text. `limits.js` is the guest copy of `config/defaults.js` `limits` (frameBytes, crankOutBytes, inlineBytes, sendsPerCrank, execSourceBytes, previews, queue bounds, calls per round and window). `m1a-interfaces.md` says, for each method: who calls it (vat, adapter, gateway, test), in which crank of the turn sequence (architecture 4.1), answered or `sendOnly`, the largest message it can carry in bytes, and what a retired break from it means (restart or vat lost). | unit: every guard accepts a sample and refuses an unbounded string, an oversize array and an unknown record key; `limits.js` equals `config/defaults.js` `limits` for every shared name |
| W1a.1 guest lib | `H/guest/lib/{turn-engine,reply-fold,transcript-records,bounded,retired}.js` copied from `fae/src/turn-engine.js`, `fae/session/reply-fold.js`, `hosted-agent/src/transcript-records.js` (subset); `bounded.js` (byte estimate units x 3, frame and crank-out checks, chunking of a text into `frameBytes` pieces); `retired.js` (`isRetiredBreak`) | prelude globals only; injected ids and times; imports `limits.js` and `interfaces.js`, never edits them | ported `fae/test/turn-engine.test.js`, `reply-fold.test.js`, `transcript-records.test.js` (Node, ses-ava); chunking keeps surrogate pairs |
| W1a.2 agent-host manager + attach | `durable.js`, `ephemeral.js` loader (D-14), `AH/{index,attach,endpoint}.js`, `AH/providers/scripted.js`, `AH/tools/echo.js`, `AH/timers.js` | attach pattern exactly as the S2 fixture (`H/test/spikes/fixtures/attach/`: `bind` awaits `attach`; `open()` retries once through `register` when its facet is retired); `AgentHostAdmin.makeBackend({kind:'scripted', script})`, `forSession`, `onStart`; Endpoint with `holdTurn`/`releaseTurn` lease, `startRound`, `cancelRound`, `armDeadline`/`disarm`; `dispatching()` handshake before round 0; scripted provider (chunks with delays, tool calls, usage, errors, stall-until-cancel); `echo` adapter tool with `delayMs` and output size; tool-call arguments passed to the vat as JSON text; any message to a vat over `frameBytes` fails the round with "round output exceeds this build's frame limit" (no staging until M1b) | adapter tests with a fake vat sink: handshake order, lease settles at release, oversize refused before sending, no record built from model JSON |
| W1a.3 channels | `AH/{channels,channel-taps,live-service,composer}.js` | session channel with publisher/subscriber facets (D-8), seq numbers, current-turn fold, subscriber dropped on close; `Live.subscribe(session, rev)`; `Composer.submit(session, text, requestId)` stamping `at` (no staging yet: text over `inlineBytes` refused); both reachable for tests through `AgentHostAdmin.live()` / `.composer()` (operator only) | adapter tests: fold equals replay; dropped subscriber; publish batch order |
| W1a.4 session vat: turn | `H/guest/session/{main,session,turn,turn-hooks,records,live,tool-table}.js` | `Session`, `Turn`, records of section 4.3, atomic claim, lease, publish batching (sendOnly in a turn, answered outside), `watch()`, tool table with `echo`, results in call order, R4-43/R4-45 texts, round limit; data-keyed state in `Map`s only | unit tests with in-memory fakes: intent before result, call order, round limit, claim removes the entry |
| W1a.5 session vat: queue + recovery | `H/guest/session/{queue,recovery}.js` | FIFO queue (`enqueueOnce` with receipt per request id, minimal), `restart` hold, `recoverAfterRestart()` (section 4.4) triggered by `isRetiredBreak` on the lease or any adapter call on the turn path, never by a guest-vat break; abandons guest calls by generation instead of awaiting them; `startTurn` refusal text R4-10 | unit: every recovery case; a retired break on a tool call never becomes a tool failure; recovery completes while a guest call stays pending forever |
| W1a.6 factory + provisioning | `H/guest/factory/*`, `H/scripts/provision*.{mjs,js}` | `HarnessRoot`, `Operator.getFactory`, `createSession({title, preset, backend, modelId})` with the built-in preset `chat-only`; sessions created directly (no pool yet): `E(vats).createWorker`, the session bundle staged in `frameBytes`-unit chunks (ASCII) or `frameBytes / 3` (otherwise), one evaluating crank, then `make(config)`; `listSessions` paged, `findSession(key)`, per-session `RowReporter` (row-visible transitions only); a row becomes `lost` when a call into its session breaks with the retired text (D-17); start listener (pool none yet; completes or rolls back interrupted creations); provisioning steps table: `install-native agentHost`, `inventory.set('vats', vats)` in the workspace vat, `install harness ... grants`; `provision-steps.js` is also the `provision` of an `ensureTemplate({ id: 'm1a' })` template | integration: provision on a fresh state dir; re-running is a no-op; the bundle-size check |
| W1a.7 slice tests + perf | `H/test/integration/m1a-slice.test.js`, `H/perf/{turn,restart,session}.perf.mjs` | the acceptance list below, from the `m1a` template with `idleSleepMs: 2000`, SIGKILL through `state.kill()` | acceptance 1-10 |

**Order and parallelism inside M1a.** W1a.0 runs first, alone (one subagent); nothing else starts
until its contract is committed. Then **W1a.1, W1a.2 and W1a.3 run in parallel**, then **W1a.4, W1a.5
and W1a.6 run in parallel** (W1a.6 needs W1a.2's resource for its integration test, not for its unit
tests), then W1a.7. Each unit owns exactly the files in its row; the sets are disjoint. No unit edits
`interfaces.js` or `limits.js`: a unit that needs a contract change stops and asks the PM, who amends
W1a.0's files in one commit and tells the other units. `turn-hooks.js` and `tool-table.js` are created
by W1a.4; `services.js`, `session-options.js` and `provision-steps.js` by W1a.6; later milestones
append to them (hook tables).

**Acceptance tests (observable)**
1. Provision a fresh state directory; `createSession({title:'t', preset: chatOnly, backend: scripted})`
   returns a Session; `listSessions` shows it `ready`, activity `passive`. `createSession({model:'x'})`
   is rejected (R4-6).
2. Submit "hi" through the Composer: a subscriber gets the snapshot, then `phase`, at least 3
   `delta`, `final`, `usage`, `end`.
3. A round with two `echo` calls of `delayMs: 1000`: the round takes less than 1.6 x a round with one
   such call; the history page shows one intent record before both results, results in call order.
4. Submit while a turn runs: the message waits and runs next (FIFO). `startTurn` while a turn is
   active fails with "Session already has an active turn; observe or cancel it first" (R4-10).
5. Stall-until-cancel script: SIGKILL after `Dispatched`, restart: as soon as the daemon serves,
   session, transcript and queue are there and the turn is already `outcome-unknown` (the lease break
   is delivered during startup); the fake provider received exactly one request; a queued message is
   held `restart` with the A.4 text; `turn.resolve(note)` works while idle.
6. SIGKILL before `dispatching()` was answered: the turn is closed "Interrupted before dispatch; no
   backend execution was started."; the user message appears **once** in history; sending a new
   message releases the hold and does not resend the old one (coverage 10).
7. SIGKILL while an `echo` call is in flight: after restart its result reads "Tool outcome unknown; do
   not automatically retry.", the turn is outcome-unknown, no further round was requested, and the
   echo log shows the call ran at most once.
8. Frame limit: a scripted reply of 64 KiB, and an `echo` result of 64 KiB, each fail the turn with the
   recorded reason "round output exceeds this build's frame limit" before any message reaches the vat;
   the session then runs a normal turn (it was not halted).
9. Record keys: a scripted tool call whose JSON arguments carry 2,000 distinct keys reaches `echo`
   intact, is recorded as text, and the session then runs 3 more turns.
10. Crashing session vat at restart (bound 2 through `--max-delivery-attempts 2`, to keep the test
    short): SIGKILL with session A awake and unsnapshotted, then kill A's worker each time it appears
    (the killer of `perf/crash.perf.mjs`). The daemon serves after A is given up; the factory and
    session B answer; a call on A rejects with the retired text and does not hang; `listSessions` shows
    A `lost`. No other vat was given up.

**Perf checks**
| check | budget |
|---|---|
| `turn.start` submit to scripted provider request | <= 350 ms; <= 3 deliveries |
| `turn.delta` adapter chunk to subscriber | <= 5 ms; 0 deliveries per delta |
| `turn.round` deliveries per round with 2 tool calls | <= 3, plus 1 lease delivery per turn |
| `session.program` size of the bundled session program | <= 200 KB (record the bytes) |
| `session.createCold` `createSession` without a pool | <= 6 s (6.4 s for a 246 KB program in M0, J-9045; depends on C-5) |
| `install.factory` provisioning install of the factory bundle | <= 15 s |
| `restart.serving` 10 checkpointed idle sessions + 1 in flight | <= 10 s; woken session vats = 1 (gate) |
| `restart.crashingSession` as acceptance 10 with bound 5 | recorded; target 15 s depends on C-8, C-9 (M0: 36-69 s) |
| too-big probes: 64 KiB round output; 300 k-char echo output; 2,000-key tool arguments | refused / cut in the callee / kept as text; no vat halt; the session answers afterwards |

**Fit risk:** awkward. The loop maps well onto vats; the risks are the live-channel ordering across
hub and process, relying on the retired text as the restart signal (it also means "vat lost" from a
guest vat), and the cold session create cost while there is no pool.

**Deferred:** exec, spare pool, staging, context cache, list feed (M1b); real providers and the full
queue (M2); UI (M3).

**Outcome.** Release worker `7cda4467...`, crank budget 50 M, Apple M3 Max with other agents
running. "Before" is the M1a build (J-0270..J-0293, worker `c2f65dbe...`); "after" is
`2ea74a02f8`..`ddcdfc68e3` (J-9190..J-9192). Verdicts use the 1.25 x rule.

| item | before | after | verdict | entries |
|---|---|---|---|---|
| Acceptance 1-4, 8, 9, QC 1 (`m1a-slice`) | 6/6 | 6/6; acceptance 1 also checks `createdAt` | pass | J-0284, J-0295, J-9190 |
| Acceptance 5-7 (`m1a-slice-restart`) | 3/3, one kill each | 3/3, then 20/20 at kill delays 0, 100, 500, 1,500, 4,000 ms (5, 6, 7 and the held-ports case 3, five each); no provider request or tool run twice | pass | J-0284, J-9190 |
| Acceptance 10 (`m1a-slice-crash`) | 1/1, served 6.1 s | 1/1, served 6.0 s | pass | J-0284, J-9190 |
| Provisioning (`m1a-provision`) | 1/1 | 1/1 | pass | J-0295, J-9190 |
| `turn.start` (budget 350 ms; 3 frames) | median 573-575 ms, p99 5.7-10.4 s; 4 frames | median 255 ms (two runs of 200), p95 288-293, p99 1.9-3.0 s; 2 frames | **pass** (0.73 x); p99 tail is C-20 | J-0272, J-0293, J-9191 |
| `turn.delta` (5 ms; 0 deliveries) | 18 ms through a control client (wrong place) | 0.17-0.18 ms in the adapter process; 0 deliveries | pass | J-0274, J-9173, J-9191 |
| `turn.delta.client` (no budget) | 18 ms, p95 2.7-3.0 s in GC bursts | 18 ms, p95 0.74-1.8 s in GC bursts | recorded; C-20 | J-0274, J-9191 |
| `turn.round` (3) / `turn.lease` (1) | 3 / 1 (a plain turn 5 deliver frames) | 3 / 1 (a plain turn 4 deliver frames) | pass | J-0273, J-9191, J-9193 |
| too-big probes | pass (keys2000 11.1 s in a burst) | pass (0.7 / 0.8 / 1.2 s) | pass | J-0278, J-9191 |
| `session.program` (200 KB) | 142,994 bytes | 157,493 bytes, ASCII, 7 pieces | pass (0.79 x) | J-0281, J-9192 |
| `session.createCold` (6 s) | 5,890 ms | 6,138 ms (6.03-6.18 s) | pass under the rule (1.02 x); depends on C-5 | J-0281, J-9192 |
| `install.factory` (15 s) | 5,725 ms | 5,950 ms | pass | J-0281, J-9192 |
| `restart.serving` (10 s; woken session vats = 1) | median 6.7 s; gate failed in run 1 of every invocation (11 woken) | median 6.2 s (6.1-9.7); gate 5/5 (wakes) | pass | J-0276, J-0294, J-9125, J-9192 |
| `restart.crashingSession` (15 s; depends on C-8, C-9) | 20.5 s | 20.4 s | **miss** (1.36 x), recorded | J-0280, J-9192 |
| `gc.burst.turnStart` / `gc.restart` (C-17, new) | p99 3.3 s; 10 idle sessions woken at the first restart | p99 0.52 s (max 4.0 s with 6 session cranks); 0 woken in 5 of 5 runs | pass | J-9120, J-9123, J-9192 |
| `crash.restart.*` (M0 rows, 15 s) | bound 5 35.8-68.5 s; bound 2 7.6-9.0 s; healthy 4.6-5.8 s | bound 5 35.7 s; bound 2 5.5 s; healthy 4.6-4.9 s | bound 5 **miss** (C-8, C-9); others pass | J-9046, J-9192 |
| `test:ironhorse` lane | 65/65 | 66/66 (worker and core unchanged since) | pass | J-9102, J-9126 |
| Unit lane | 275 passed | 313 passed, 23 skipped | pass | J-0295, J-9190 |

Fit (J-9194): the turn loop, intent before effect and restart recovery fit vats well; holding ports
across turns is awkward (a clock comparison stands in for a restart notice, C-19); GC traffic was a
poor fit until CORE-9 and still costs host time per frame (C-20). Remaining performance risks:
J-9195..J-9200.

---

## M1b. Exec scope, staging, context cache, pool, list feed

**Status: done, with recorded perf misses for the PM to rule on.** Build commits
`3df16eafd4..4efd2d795c` (W1b.0..W1b.6, the C-20 core change `7efa7fb3e4..a3a2b58da5`, the delivery
histogram `b45da47b93`); QC fixes `d4241fa77a..e48dffe8f7` plus the documentation commits that follow it. Journal J-0300..J-0370, J-0390..J-0398,
J-9210..J-9216. Acceptance 1-12 pass in real vats except acceptance 9's delete, which needs M2's
`deleteSession` and moves to M2 (acceptance 13). Four budgets still miss (`session.create` with the
pool, `concurrency.10` turn start and crank p95, `history.page`, `context.rebuild`: see the outcome);
they are kept, not re-based, and name the core candidate each depends on. The work-unit table below
is the record of what M1b was asked to do; where the contract changed (QC: `ExecScope.abandon`,
`exhausted`, answered `TurnSink.progress`), `m1b-interfaces.md` is current.

**Goal.** Complete the headless core's structure: the confined persistent `exec` scope, large text
staged as blobs, the adapter-owned context projection, the spare-vat pool, the session list feed, and
the first multi-session performance checks.

- **P:** P-09 (late join), P-16 (basic exec), P-03 (list feed), P-13 (large content).
- **R:** R3-29, R3-41, R3-42, R4-31, R4-46, R4-63, R4-100.
- **Depends on:** M1a (done; read its outcome table and the "Changes after" rows first).
- **Owns:** `H/guest/exec/`, `H/guest/session/tools/exec.js`, `H/guest/session/{context-source,staging}.js`,
  `H/guest/lib/tool-output.js` (from `fae/session/tool-output.js`), `H/guest/factory/{pool,list-feed}.js`,
  `AH/{blobs,content,context-cache,projection,projection-hooks}.js`, `H/designs/m1b-interfaces.md`,
  `H/test/*/m1b-*`, `H/perf/{exec,pool,concurrency,hub,history}.perf.mjs`; for W1b.0 only:
  `H/guest/lib/{interfaces,limits}.js`, `H/designs/m1a-interfaces.md`, `H/guest/session/live.js`
  (the outside-publish bound).

**What M1a leaves for builders to know.** Ports are held per adapter incarnation and opened in
`make` (contract 6.1, 7.1): a spare's `make()` sends the creation-time open, which the manager
answers only after the factory's `bindSession` (the pool must keep that order). A turn start is one
crank on held ports; a claim after an unannounced restart reopens (case 3). GC frames ride the next
ordinary crank and never wake a vat (architecture 4.6), so do not count journal growth as wakes:
read the worker row's `wakes`. Settled turns are records; only 32 `Turn` handles are kept
(compare by `turnId`). `createSession` takes `at` (the caller's clock). Guest bundles are ASCII
(escaped by the bundler). Integration files run one per invocation or through
`corepack yarn test:integration`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W1b.0 interface contract | `H/guest/lib/{interfaces,limits}.js`, `H/designs/m1b-interfaces.md` (new; `m1a-interfaces.md` stays the M1a contract and gets only corrections), `H/test/unit/m1b-interfaces.test.js`, `H/guest/session/live.js` | One subagent, first, alone, as W1a.0. Guards and method lists for every object that crosses between M1b's units: `Blob`, `BlobWriter`, `Content`, the staged-submission and staged-field shapes (`{ blob, preview, bytes }`), `ContextSource.page` (records only), `ExecHandle` (run, retire), the exec vat's `ExecScope` (run, busy answer), `SpareMaker` (completed from its M1a shape), `SessionListFeed` and its publisher, the `PoolStatus`/`whenSettled()` shape, `ToolOutput` cut rules (R4-46). For each method: caller, crank of the turn sequence (`m1a-interfaces.md` 6), answered or `sendOnly`, largest message in bytes, what a retired break means (adapter: restart; exec vat or spare: that vat is lost). Carried from M1a (J-9172, J-9150): an optional close `reason` on `LiveBatch`; a bound on the chain of outside-a-turn publishes in `live.js` (`outsideTail`: keep at most one batch's worth pending and drop the oldest, so a `liveChannel()` that never settles cannot grow it); the text of the blank-submission refusal once the PM rules on it. | unit: every guard accepts a sample and refuses an unbounded string, an oversize array and an unknown key; `limits.js` equals `config/defaults.js`; a `liveChannel()` that never settles leaves at most the bound of outside batches pending |
| W1b.1 blobs + staging | `AH/{blobs,content}.js`, `H/guest/session/staging.js`, Composer staging | D-15 pre-minted handles, fsync before handing out; `BlobWriter`; `Content.read(blob, offset, length)` in-process; staging of submissions, model messages, tool args, tool results and native context over `inlineBytes`; progress as `{partial: Blob, tail}` replacing one record | adapter: handle never handed out before fsync; resolve after restart; unit: partial record replaced |
| W1b.2 context cache | `AH/{context-cache,projection,projection-hooks}.js`, `H/guest/session/context-source.js` | D-9: records in, projection in Node; `{count, epoch}` check; page pull from the latest compaction boundary; batched blob resolve; native context replayed from blob; a reopen after an unannounced restart (contract 7.1 case 3) re-sends round 0 with `base` unchanged, so the cache rebuild must not count `TurnStarted` twice | adapter: rebuild equals incremental; a round 0 sent twice to two incarnations projects once; integration: rebuild after restart |
| W1b.3 exec vat | `H/guest/exec/main.js` | one persistent `Compartment`; async-body wrapper; endowments `E, harden, sleep, console(bounded), powers` (empty live facet until M5); `{busy}` answer while a call runs; large results cut (R4-46) and written to the passed `BlobWriter` in pieces of at most `frameBytes / 2`; a source over `inlineBytes` read from its Blob in pages of at most `frameBytes`, joined and evaluated in one crank (never one message: S3); `execSourceBytes` refusal; no data-keyed records leave the vat (`console` lines and results are text) | unit (Node Compartment) |
| W1b.4 exec tool | `H/guest/session/tools/exec.js` | `exec` in the tool table; adapter deadline armed with the call; a retired break from the exec vat (halt or crash give-up, D-17; indistinguishable from inside) -> the neutral terminated result of architecture section 6 + explicit `retire()`; deadline -> timeout result + retire (this also bounds a worker that misses the watchdog and is being retried); cancel abandons by generation (no retire); busy at next call -> retire + "the previous exec call was still running; the scope was reset"; after a restart the pending exec call is abandoned, never awaited (J-9048) | integration |
| W1b.5 pool + list feed | `H/guest/factory/{pool,list-feed}.js` | spare pool (D-4) with `whenSettled()`: spares made as in S6 (`createWorker`, staged bundle, evaluating crank returning a `SpareMaker`), refilled with up to 4 creations in parallel; a take is `make(config)` then `bindSession`, in that order (the creation-time open waits for the bind); `ExecHandle` (run, retire); session list channel (one publish per crank of row changes, `rev`, delivered in rev order as the session channel); `sessionListFeed()`; publisher refreshed in the start listener; calls-per-round cap and window in `turn.js` via `turn-hooks.js` settings | integration |
| W1b.6 tests + perf | `H/test/integration/m1b-*.test.js`, `H/perf/{exec,pool,concurrency,hub,history}.perf.mjs` | acceptance below; perf rows below, including the vat row for history pages that M1a measured only in Node (J-9153, J-9155) | acceptance 1-12 |

**Order and parallelism inside M1b.** W1b.0 first, alone; then W1b.1, W1b.3 and W1b.5 in parallel;
then W1b.2 and W1b.4 in parallel (W1b.2 needs W1b.1's blobs, W1b.4 needs W1b.3's vat and W1b.5's
`ExecHandle`); then W1b.6. No unit edits W1b.0's files; a unit that needs a contract change stops and
asks the PM, as in M1a.

**Acceptance tests (observable)**
1. A second subscriber attached mid-turn receives a fold equal to the events so far, then the same live
   events.
2. An `exec` returning 100,000 characters is cut to 32,768 units with the exact R4-46 marker, without
   splitting a surrogate pair; the fake provider receives exactly that text in the next round.
3. `globalThis.x = 5` in one `exec`; `return x` in the next turn after a restart returns 5. Cancel a
   turn during a 30 s `exec` sleep; in the next turn `return x` still returns 5 (scope kept).
4. `while(true){}` yields "exec scope terminated: ..."; the session keeps working; the next call has a
   fresh scope.
5. An `exec` that awaits forever with `execDeadlineMs` set to 5 s yields the timeout result and the
   scope-reset text.
6. A round with 100 `echo` calls: 64 run, 36 get the too-many-calls text; the session keeps working.
7. A 1 MiB scripted reply and a 300 KiB `exec` body: the transcript content is complete through
   `getTurnContent` / `Content`, the next round's provider request contains the full reply; an `exec`
   body over `execSourceBytes` gets the "exec source too large" result.
8. After a daemon restart, the next turn of a 200-turn session rebuilds the context cache; the fake
   provider receives the same context as before the restart, including the scripted native context.
   The same holds when the session was idle across the restart (its first claim goes to dead ports
   and is re-sent to fresh ones, contract 7.1 case 3): the provider receives that turn once.
9. Two list-feed subscribers see create, rename and delete within 500 ms; a closed subscriber is
   dropped and costs no further work.
10. SIGKILL during a 30 s `exec` sleep, restart: the turn is outcome-unknown and recovery did not wait
    for the exec call; the next turn's `exec` works and, when the exec vat survived, still sees
    `globalThis` bindings from before.
11. An exec vat whose worker is killed on every attempt while a call runs (live, no restart): the
    call ends with the terminated result after the bound is spent, the lost exec vat is retired, and
    the next `exec` gets a fresh scope.
12. A session created from a spare (`createSession` with the pool) runs its first turn on ports
    opened by its `make()`; a SIGKILL right after the take and a restart leave the session listed
    once and its first turn runs once.

**Perf checks**
| check | budget |
|---|---|
| `exec.trivial` | <= 250 ms |
| `exec.first` (spare exec vat) | <= 750 ms (spare take 157-176 ms in M0) |
| `exec.sends` 100 answered / 100 `sendOnly` from one body | <= 8 s / <= 1 s; no MeterAbort (M0 probe: 9.4-10.6 s / 0.5 s; answered depends on C-7) |
| `session.create` with spare pool / without | <= 750 ms / <= 6 s (without: depends on C-5; M1a 5.9-6.2 s for a 157 KB program, no margin) |
| `pool.refill` 2 spares after 2 takes, 4 lanes | recorded (M0: 6.4 s per spare, 50 in 108.7 s) |
| `context.rebuild` 1,000-turn session after restart | <= 5 s before the request is sent |
| `history.page` 32 turns of 8 records, in a vat | <= 300 ms (Node: 0.77 ms after the structural guard, J-9153) |
| `concurrency.10` 10 sessions streaming with tool rounds | per-session turn start <= 2 x single; crank p95 <= 200 ms; row push <= 500 ms; GC frames per session per turn recorded |
| `hub.growth` `hub.json` bytes and ms per delivery after 1,000 turns with a subscriber, after 50 sessions | <= 2 MB; <= 1.25 x fresh |
| `hub.gcBurst` host time per incoming GC frame (hub persist and journal append, timed separately) | recorded; decides C-20 (J-9127) |
| `turn.start` and `gc.burst.turnStart` (M1a rows, re-run) | median <= 350 ms; p99 recorded (M1a: 0.5-3.0 s from GC bursts' host cost; p99 <= 1 s **depends on C-20**) |
| `exec.retire` disk returned after a lost exec vat is retired | >= 15 MB (M0: 17.3 MB per vat) |
| too-big probes: 300 tool calls in one round; 1 MiB reply; 10 MiB echo output; 300 KiB exec body; an exec body building an object with 60,000 fresh keys | no session vat halt (the last halts only the exec vat, which is retired) |

**Fit risk:** awkward. Persistent scope and guest-to-guest exec fit well; the cost is blob plumbing
for anything over a few KB and the exec compute ceiling per crank. The cold create has no margin
until the pool exists (C-5).

**Deferred:** real providers (M2), presets and `powers` content (M5), UI (M3).

**Outcome.** Release worker `7cda4467...`, crank budget 50 M, slot ceiling 4,000,000 (M1b QC),
Apple M3 Max with other agents' processes; load 1.5-3.5. "Build" is W1b.6's run (`a99abea744..
1647fcbc41`, J-0360..J-0370, slot ceiling 1,000,000); "QC" is `6794d9e808..e48dffe8f7` (J-0395,
J-0396). Verdicts use the 1.25 x rule.

| item | build | QC | verdict | entries |
|---|---|---|---|---|
| 1 late join (`m1b-live`) | pass | pass | pass | J-0360, J-0396 |
| 2 exec result cut, R4-46 marker, provider gets it (`m1b-content`) | pass | pass (32,767 units; turn 2.2 s) | pass | J-0360, J-0396 |
| 3 `x` across a clean restart; cancel during a 30 s sleep keeps the scope (`m1b-exec-tool-restart`) | pass only when the next exec came after the sleep ended (else busy reset) | pass as written: the next turn's exec 164-165 ms after the cancel, 28.4 s of the sleep left, `x === 5`; an abandoned loop stops | pass | J-0340, J-0391 |
| 4 runaway: terminated text, fresh scope (`m1b-exec-tool`) | pass (604-766 ms) | pass (598-722 ms; one outlier 12.9 s after a wake from snapshot, not reproduced in 4 runs) | pass | J-0341, J-0396 |
| 5 deadline 5 s: timeout and reset texts | pass (5.17 s) | pass (5.16 s) | pass | J-0341, J-0396 |
| 6 100 echo calls: 64 run, 36 refused, session goes on (`m1b-live`) | **fail**: session vat `HeapExhausted` | pass (8.2 s); 256 echo and 256 unknown-tool calls pass too (`m1b-qc`, 11.1-11.3 / 6.1-6.2 s) | pass | J-0362, J-0392 |
| 7 1 MiB reply and 300 KiB exec body through Content; too large refused (`m1b-content`) | pass | pass (reply turn 2.5 s, read 2.2 s) | pass | J-0360, J-0396 |
| 8 200-turn rebuild after a clean restart and an idle SIGKILL (`m1b-context-restart`) | pass (2.3-2.6 s) | pass (2.4 / 2.3 s) | pass | J-0368, J-0396 |
| 9 list feed create and rename within 500 ms; closed subscriber dropped (`m1b-live`) | pass | pass (row 24-35 ms after `createSession` returned; rename 191-195 ms) | pass | J-0360, J-0396 |
| 9 delete | `test.failing` (`deleteSession` is M2) | unchanged; moved to M2 acceptance 13 | M2 | J-0309, J-0396 |
| 10 SIGKILL during a 30 s sleep; next exec sees `x` (`m1b-exec-tool-restart`) | pass | pass (served 7.0 s; outcome-unknown 1.8 s after serving) | pass | J-0340, J-0396 |
| 11 exec worker killed on every attempt (`m1b-exec-tool`) | pass (5.6 s) | pass (5.6-6.1 s) | pass | J-0341, J-0396 |
| 12 spare take, then SIGKILL after the take (`m1b-pool`, `m1b-pool-restart`) | pass | pass | pass | J-0352, J-0396 |
| M1a files (`m1a-slice`, `-restart`, `-crash`, `m1a-provision`) | pass | pass | pass | J-0367, J-0396 |
| `exec.trivial` (250 ms) | 181-191 | 174-179 | pass | J-0341, J-0396 |
| `exec.first` (750 ms) | 536-542 | 537-547 | pass | J-0341, J-0396 |
| `exec.sends` 100 answered (8 s) / sendOnly (1 s) | 4.1-5.6 s / not measurable (empty `powers`, M5) | 4.8-6.7 s (a `then` per sleep doubled it, removed, J-0391) / not measurable | pass / M5 | J-0341, J-0391 |
| `session.create` with the pool (750 ms) | 1,184-1,346 | 1,209-1,255 (awake spare 1,111) | **miss** (1.6-1.7 x); C-2, C-7 (7 serial cranks plus a wake) | J-0351, J-0397 |
| `session.create` without (6 s; C-5) | 7.7 s (198 KB program) | 5.8-5.9 s (130 KB program, comments stripped) | pass | J-0364, J-0394 |
| `pool.refill` 2 spares, 4 lanes (recorded) | 4.7-6.1 s | 4.2 s | recorded | J-0353, J-0396 |
| `context.rebuild` 1,000 turns (5 s) | no result: the session vat halted (`HeapExhausted`); 8.3 s at 400 turns | completes, no halt: 21.7 s (14 pages, 21.1 s of page cranks); live heap about 300,000 slots | **miss** (4.3 x); session no longer lost; C-5, C-7; J-0322 (b) | J-0368, J-0395 |
| `history.page` (300 ms) | 598-666 | 603-715, median 627 (floor 95) | **miss**; C-5, C-7; M2 W2.5 bounds pages by records | J-0370, J-0395 |
| `concurrency.10` turn start (2 x single) / crank p95 (200 ms) / row push (500 ms) | 3.4-3.6 x / 500 / 342 | 3.63 x (1,009 vs 278 ms) / 500 / 372 | **miss** / **miss** / pass; C-2, C-7 | J-0365, J-0397 |
| `hub.growth` (2 MB; 1.25 x fresh) | 570 KB; 1.32 x (C-20 run), 1.22 x (verifier) | not re-run | borderline; C-2 | J-9214 |
| `hub.gcBurst` (recorded; decides C-20) | 16.7 -> 6.6-7.0 ms per GC frame | not re-run | C-20 partly closed | J-9211..J-9213 |
| `turn.start` (350 ms; p99 1 s with C-20) | 291, p99 536 | 282, p99 688 | pass | J-0367, J-0395 |
| `exec.retire` (15 MB) | 25-62 MB | 60 MB | pass | J-0366, J-0396 |
| too-big probes (no session vat halt; keys60k halts or retires only the exec vat) | keys60k **fail** (vat survived, degraded) | all pass: calls300 refused (frame limit), 1 MiB reply, echo 1 MiB cut and staged (10 MiB is an argument error), exec300k refused, keys60k `exhausted` and retired | pass | J-0366, J-0390 |
| `session.program` (200 KB) | 198,438 | 130,798 | pass | J-0394 |
| Unit lane | 423 passed, 37 skipped | 434 passed, 38 skipped | pass | J-0396 |
| Core tsc (`packages/thixotrope` `lint:types`) | 1 error (`b45da47b93`) | 0 | pass | J-0396 |

**After the core changes C-7 and C-2** (CORE-11, CORE-12; worker `367e78ad...`, hub log store;
integration J-9380..J-9399, every row in J-9382). The M1b rows, re-run at `be7d2a84aa`..`bd14ef7e08`:

| item | QC (above) | after | verdict | entries |
|---|---|---|---|---|
| acceptance 1-12, M1a files, `m1b-qc`, `m1b-followups` | pass | pass; 35 SIGKILL runs at varied kill points (M1a 5, 6, 7, held ports x 5; M1b 3/10 x 5, 8 x 5, 12 x 5), no duplicated request, tool run or exec evaluation | pass | J-9380, J-9381 |
| `exec.trivial` (250 ms) | 174-179 | 53 | pass | J-9382 |
| `exec.first` (750 ms) | 537-547 | 285-298 | pass | J-9382 |
| `exec.sends` 100 answered (8 s) | 4.8-6.7 s; 7.0 s (J-9368) | 1.3-1.4 s | pass | J-9382 |
| `session.create` with the pool (750 ms) | 1,209-1,255, **miss** | 849-864 (p95 989) | pass (1.13-1.15 x) | J-9382 |
| `session.create` without (6 s) | 5.8-5.9 s | 4.5 s | pass | J-9382 |
| `pool.refill` (recorded) | 4.2 s | 2.8-3.4 s | recorded | J-9382 |
| `context.rebuild` 1,000 turns (5 s) | 21.7 s | 22.1-22.8 s | **miss**; C-5 (page cranks), J-0322 (b) | J-9382, J-9387 |
| `history.page` (300 ms) | 603-715 | 568-596 at 50 turns, 869 at 1,000 | **miss**; C-5; W2.5 record bound | J-9382, J-9387 |
| `concurrency.10` turn start (2 x) / crank p95 (200 ms) / row push (500 ms) | 3.63 x / 500 / 372 | 6.5 x (728 vs 112 ms) / 500 / 189 | **miss** / **miss** / pass; C-2 (the rest) | J-9382, J-9386 |
| `hub.growth` (2 MB; 1.25 x fresh) | 1.32 x (C-20 run) | 1.36 x, 1.35 MB | **miss**; C-2 (the rest) | J-9382, J-9386 |
| `hub.gcBurst` (recorded) | 6.6-7.0 ms per GC frame | 1.9 ms | recorded | J-9382 |
| `turn.start` (350 ms) | 282, p99 688 | 105, p99 428; 233 ms (p95 1.4 s) at 4,000 turns | pass (median) | J-9382, J-9383 |
| `exec.retire` (15 MB) | 60 MB | 52 MB | pass | J-9382 |
| too-big probes | all pass | all pass | pass | J-9382 |
| `session.program` (200 KB) | 130,798 | 132,588 | pass | J-9382 |
| long sessions, 50 / 1,000 / 5,000 turns (recorded) | per turn 0.69 -> 2.46 s over 1,000 turns (J-0370) | per turn 0.84 / 1.0 / 3.2 s; `turn.start` 121-130 / 142-152 / 271 ms (p95 1.8 s at 5,000); `history.page` 0.54-0.60 / 0.84-0.87 / 2.0 s; rebuild 1.3 / 21-22 / 180 s; slot capacity 13 / 22 / 48 % of 4,000,000 | still grows with length (about +0.53 s per turn per 1,000 turns) | J-9383..J-9389 |

Fit (J-0398): the exec scope, the blob model and the call fence fit vats well; the heap model does
not: the slot ceiling bounds live heap plus one crank (C-21) and every crank collects the whole heap
(C-7), so the cost of a session grows with its length and its heaviest crank sets how long it may
get. Open for the PM: the four misses above, the engine halt for name-table exhaustion (C-6), a
per-session disk quota (J-0393), and the advisories listed in J-0397. After CORE-11 and CORE-12
(J-9385): the per-crank collection is gone and a vat is cheap to talk to, but a collection still
marks the whole live heap and a hub session row grows with the handles a session keeps, so session
cost still grows with length, about 3.3 x more slowly; a 5,000-turn session takes 3.2 s per turn,
180 s to rebuild its context and 48 % of the slot ceiling (J-9383, J-9386..J-9389). New for the PM:
a session takes at most 4,096 Composer submissions in 24 h (J-9391).

---

## M2. Turn loop completeness on API-key backends (with minimal secrets)

**Goal.** Make the headless core correct and complete for daily use on the API-key backends: real
streamed providers, the full queue, exactly-once submission, stop, failure handling, usage, paging,
delete with reclamation, data-only export/import, and fixed prompt composition.

- **P:** P-05 (`provider` slot: OpenRouter streamed and Anthropic API; second `openrouter` slot),
  P-08 (full), P-10 (full), P-11, P-12 (non-shell), P-13 (full), P-15 (fixed composition), P-25,
  P-26 (create, replace, revoke, read grant; no UI), P-27 (per turn and session), P-46 (API part).
- **R:** R3-27, R3-28, R3-231, R3-232, R4-6 (rollback), R4-7, R4-9, R4-12, R4-13, R4-17, R4-20,
  R4-21, R4-22, R4-26, R4-27, R4-28, R4-32, R4-33, R4-41, R4-42, R4-47, R4-48, R4-49, R4-51, R4-53,
  R4-55, R4-56, R4-61, R4-62, R4-64, R4-74, R4-77, R4-78, R4-79, R4-82, R4-83, R4-87, R4-88, R4-92,
  R4-93, R4-94, R4-95, R4-96, R4-97, R4-98, R4-104, R4-106, R4-107, R4-108, R4-109, R7-15, R7-23,
  R7-24, R7-28.
- **Depends on:** M1b (done with recorded perf misses; read its outcome table, the M1b rows of
  "Changes after" and `m1b-interfaces.md` 16 first).
- **Owns:** `AH/providers/{openrouter,anthropic,http,sse,retry,catalog,round}.js`,
  `AH/secrets/{store,manager,writer,seal}.js`, `AH/archive/` (the record archive, D-M2-1),
  `H/guest/session/{submissions,holds,holds-table,history,archive,usage,prompt,export}.js`,
  `H/guest/factory/{delete,export}.js`,
  `H/guest/lib/{pending-queue,journal-usage,token-usage,system-prompt-base}.js`,
  `H/scripts/export.mjs`, `H/test/fixtures/fake-provider-server.mjs`, `H/test/fixtures/sse/`,
  `H/test/*/m2-*`, `H/perf/{journal,history,queue,provider,throughput,archive}.perf.mjs`; the M1a
  and M1b files M2 edits are assigned per group in `m2-interfaces.md` 2.2.

**What M1b leaves for builders to know.** The daemon serves with a slot ceiling of 4,000,000
(`config/defaults.js` `slotCeiling`, `scripts/serve.mjs`): a vat's live heap plus everything one
crank allocates must fit (the engine collects only between cranks, C-7, C-21), so a session vat has a
size at which its heaviest cranks stop fitting; `perf/history.perf.mjs` reports the session vat's
slot capacity per 100 turns (`history.grow` `heap`, `history.heap`), and `perf/crank.perf.mjs` with
`CRANK_POINTS` the long-session table (J-9383). Since CORE-11 a crank no longer pays a collection
of the live heap: the worker collects on an allocation schedule (after 131,072 slots or 16 MiB of
growth, every 32nd crank, at close), so a crank may start with that much uncollected growth, and a
vat's finalizers (its `gc-*` frames) leave up to 32 cranks after the reference died; do not assert
a release in the crank that freed it. Per-turn time still grows with session length, more slowly
(J-9383, J-9388), and a hub session row grows with the handles the session keeps (J-9386).
Since CORE-12 the hub keeps `hub-image.json` plus `hub-log.jsonl` (`hub.json` is a marker; tools
that read hub state read through the store). A scripted backend's script crosses the manager vat:
it must fit one frame; floods of fresh keys use `keys` / `argsFreshKeys` (m1b-interfaces 17.6). Guest bundles carry
no comments (`bundle-guest.mjs`; session program 130 KB of 200 KB). Exec calls end at their answer or
at `ExecScope.abandon()` (cancel, recovery) and model code cannot outlive its call (`sleep` dies with
the call); `exhausted` retires an exec vat whose name table ran out. Progress checkpoints are
answered (`TurnSink.progress -> boolean`), write bytes linear in the reply and leave no superseded
file. Real providers may send up to `maxCallsPerMessage` (256) calls a round: 256-call rounds pass at
the current ceiling (`m1b-qc.test.js`); keep that test green when the record or event shapes grow.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W2.0 interface contract | `H/guest/lib/{interfaces,limits}.js`, `H/designs/m2-interfaces.md` (new), `H/test/unit/m2-interfaces.test.js` | **Done** (`58980f7d9e`, `d0a2f565e2`; J-0400..J-0404). One subagent, first, alone, as W1a.0 and W1b.0; also designs the record archive (D-M2-1, `m2-interfaces.md` 4) and assigns every file M2 edits to one unit per group (2.2). Fold the M1b tables into the M1a ones (`m1bShapes`, `m1bInterfaces`, `m1bMethodNames` into `shapes`, `interfaces`, `methodNames`; adapt `m1a-interfaces.test.js` and `m1b-interfaces.test.js` in the same commit). Add M2's guards and texts: `SessionInternal.blobPage` and `AgentHostAdmin.releaseBlobs` exactly as `m1b-interfaces.md` 4.8 specifies; `SessionFactory.deleteSession` and the `row-removed` list event; the full queue (`QueueEntry.edit/cancel/sendNow`, holds); history pages bounded by records and bytes as well as turns (W2.5); provider, catalogue and secrets shapes. For each method: caller, crank, answered or sendOnly, largest message, retired-break meaning, and the heaviest crank it can cause in records, events and sends (M1b J-0392: crank allocation, not only bytes, halts a vat). | unit: every guard accepts a sample and refuses an unbounded string, an oversize array and an unknown key; the folded tables keep every M1a and M1b method in order |
| W2.1a HTTP, SSE, OpenRouter (group A) | `AH/providers/{http,sse,openrouter,round}.js`, `guest/lib/token-usage.js`, the fake server; `AH/endpoint.js` | Node `fetch` (Node 22 pinned); SSE parser adapted from `lal/providers/subscription-events.js` (linear); OpenRouter **streamed** (G-03), `tool_choice:'auto'`; provider bodies never in failure text | fake-server fixtures: deltas, tool calls, empty answer, length stop, mid-stream disconnect; ported `lal/test/openrouter.test.js` parts |
| W2.1b Anthropic, retry, timeouts (group B) | `AH/providers/{anthropic,retry}.js`; group B owner of the W2.1a files | Anthropic Messages streamed; R4-74 retry schedule only while nothing delivered; R4-77/R4-78/R4-79 texts; timeouts (R4-93, configurable; Anthropic gets one, G-04) | fixtures: 401, 429 Retry-After, 5xx, overload |
| W2.2 model catalogue (group B) | `AH/providers/catalog.js`, `session-options.js` entry; group B owner of `AH/{index,attach}.js` (the factory's `listBackends/listModels` are W2.7's forwards) | catalogue read with the backend credential through the R4-104 cache; rows sorted per R4-20; `unavailable` on failure; selection rules R4-21; the resolved model is stored at creation (R4-22) | adapter + unit tests |
| W2.3 secrets minimal (group A) | `AH/secrets/*`; group A owner of `resources/agent-host/durable.js` (every M2 manager method, `m2-interfaces.md` 3.3) and `scripts/serve.mjs` (the key-file variable) | encrypted file (AES-GCM, key file outside state dir, D-6), `SecretsAdmin.create`, `Secret.makeReadGrant/revoke/delete/describe`, `SecretWriter.replace(secret, value, expectedGeneration)` with amplification inside the resource, sealed-box import for the CLI path, audited reads, values re-read every round (R4-82); adapters never log tool arguments, results or secret values (W-13) | stale generation refused; revoked read fails; grep of the state dir (heaps, journals, `hub.json`, blobs) after a test finds no secret value |
| W2.4 queue and submissions (group A) | `guest/session/{submissions,holds,holds-table}.js`, `guest/lib/pending-queue.js` (adapted, heap Map, no pet names); group A owner of `guest/session/{queue,session,turn,recovery}.js` and `AH/composer.js` | bounded 100 waiting, 4,096 receipts, request-id window from the Composer's `at`, `QueueEntry.edit/cancel/sendNow` (edits go through the Composer for staging), holds `restart/stopped/refused/unavailable` with the A.4 texts (no `interrupted` state, section 4.3), release rule R4-56, duplicate detection | ported `fae/test/session/pending-queue.test.js`, `session-submissions.test.js` (minus `interrupted` cases, recorded) |
| W2.5 history and archive (vat side; group B) | `guest/session/{history,archive}.js`; `turn.js`, `records.js`, `context-source.js` (`m2-interfaces.md` 2.2) | history pages of at most 32 turns, `frameBytes` **and `historyPageRecords` (48)** (a page crank marshals about 3 ms per record, J-0370, J-9387; measure and propose another bound if it misses); the vat side of the record archive (D-M2-1, `m2-interfaces.md` 4): seal in the settle crank when 160 settled turns are kept (32 turns per segment, 128 kept), intent before effect, drop only on the adapter's durable answer, the index of `SegmentEntry`s and the chained `ArchiveState`, `RoundRequest.base.archive`, `ContextSource` from `sealedTo` and `segments()`, archived turns in history (`archived`, `archive`), `Session.findTurn`, `Turn.getContent`/`resolve` of archived turns, at most 64 archived unresolved turns kept; the seams of 2.4 for W2.6 and W2.7; snapshot time and size and the session vat's slot capacity at 200 and 1,000 turns (`journal.snapshot`, `session.heap`, `archive.flat` at those lengths) | unit (archive and history in Node, with a fake port); integration `m2-history` (acceptance 9), `m2-archive-restart` (acceptance 16) |
| W2.6 turn completeness (group B) | `guest/session/{usage,prompt}.js`, `guest/lib/{journal-usage,system-prompt-base}.js`, hook lines; through the seams W2.5 builds in `turn.js` (`m2-interfaces.md` 2.4) | unknown tool / bad JSON texts (R4-43, R4-45), synthesized ids R4-42, round limit fallback R4-47, cancel tears down the stream (R4-7, R4-49) and records late results as ignored, usage five counts and context reading (R4-33, R4-83 "skipped if not read in time"), turn deadline setting (default off), fixed prompt composition (R4-26 parts 1-2, 7) | integration `m2-turns.test.js` |
| W2.7 delete, rollback, export | `guest/factory/{delete,export}.js`, `guest/session/export.js`, `scripts/export.mjs`; group B owner of `session.js`, the factory files and `durable.js` (`m2-interfaces.md` 2.2) | `deleteSession` publishes `row-removed` on the list feed (M1b acceptance 9 "delete", moved here) and marks `deleting`, fences the session (`deleteSelf`), releases the live tail's blobs (`blobPage` -> `releaseBlobs`) and the archive's (`releaseArchive`: segments, the blobs they name, the mirror), retires the session and exec vats (also a `lost` session's, D-17: this is the only way its disk is returned), completes after a restart (R4-9); failed creation rolls back including after a restart (R4-6); `exportState`/`importState` of factory and session records, archived turns read through `History` and re-sealed by the importing session (exec bindings are not exportable: documented loss); `SessionFactory.listBackends`/`listModels`, `Operator.getSecrets`, the M2 `HarnessSettings` | integration `m2-lifecycle.test.js` (acceptance 13, 14) |
| W2.8 archive store (adapter side; group A) | `AH/archive/`; group A owner of `AH/{index,attach,context-cache,projection,blobs,content}.js` (`m2-interfaces.md` 2.2) | the adapter side of the record archive (D-M2-1, `m2-interfaces.md` 4): `ArchivePort.seal` (fingerprint check, segment written and fsynced with a chained digest before the answer, a half-written segment never read), the per-session archive directory (manifest, `context.jsonl` persisted projection, `mirror.jsonl` of the kept records), validation against the vat's `ArchiveState` (orphans deleted), the context cache's sealed part (a restart reads one file and the tail, not a page per 512 records), `History` and `SealedText` (archived pages without a vat crank), `releaseArchive`, `BlobStore.release`, `archiveKeys` for M13; every M2 ops method in `attach.js` (handlers or `notBuilt`) | adapter tests over a fake session (seal, SIGKILL points by killing a child process mid-write, validation, rebuild equals incremental, history pages back to turn 1) |
| W2.9 integration | everything | the wiring of `m2-interfaces.md` 2.3, no `notBuilt` stub left, the fold of `m2Interfaces`; acceptance 7, 11 and 15; perf `throughput`, `restart.serving`, `hub.row`, `archive.flat` at 5,000 turns (fixtures by `importState`) | all M2 integration files, each alone |

**Order and parallelism inside M2.** W2.0 first, alone (done); then **group A** = W2.1a, W2.3, W2.4,
W2.8 in parallel; then **group B** = W2.1b, W2.2, W2.5, W2.6, W2.7 in parallel; then W2.9, which
owns every file. No two units of a group edit one file (`m2-interfaces.md` 2.2 names the owner of
every M1a/M1b file M2 edits); hook tables take lines from several units; an exo switches to its
M2 guard once, with stubs (`textOf.notBuilt`) for methods a later unit builds (`m2-interfaces.md`
1.3); a unit that needs a contract change makes it by the contract rule and reports it.

**Acceptance tests**
1. Against the fake server: an OpenRouter-format session streams more than one delta per reply.
2. A response with two tool calls, an unknown tool and bad JSON produce the R4-43 / R4-45 texts; the
   turn continues.
3. Round limit 2 with an always-tool script ends with the R4-47 text, status completed.
4. Queue at 100 refuses with the R4-53 text; edit/delete/send-now work; the same request id twice
   returns the same id with `duplicate: true` and one transcript entry.
5. With messages held `restart`, sending a new message or pressing send-now releases the hold and
   sends in FIFO order (R4-56).
6. Cancel mid-stream: the fake server sees the connection closed; the turn is `cancelled`; `abort`
   emitted.
7. Replace the API-key secret; the next turn uses it without restart; revoke it; the next turn fails
   with a recorded reason that contains no provider body. No secret value appears anywhere in the state
   directory.
8. 429 with Retry-After: retried per R4-74 only while nothing was delivered.
9. After 300 turns, history pages of 32 turns load back to turn 1, and every page message is at most
   `frameBytes`.
10. Two clients (two admin connections) see the same queue and transcript (P-25).
11. Change the factory's default model: an existing session keeps its model; a new one gets the new
    default (R4-22, R4-21).
12. A turn that failed and an outcome-unknown turn both appear in the next round's context with the
    "Tool outcome unknown" text; a never-dispatched turn does not (R4-32).
13. SIGKILL during `deleteSession`: after restart the delete completes and the session's vats and blobs
    are gone; SIGKILL during `createSession`: after restart nothing half-made is listed (R4-9, R4-6).
    Two list-feed subscribers see the delete (`row-removed`) within 500 ms (M1b acceptance 9's
    delete part; `m1b-live.test.js` keeps it as a known failure until then).
14. `exportState` then `importState` into a fresh state directory yields the same sessions, history,
    queues and presets.
15. **A 5,000-turn session behaves like a 200-turn one** (D-M2-1; `m2-interfaces.md` 4): per-turn
    wall time, `turn.start`, the session vat's snapshot size, its slot capacity and its hub row
    bytes are each within 1.25 x of the 200-turn session's (the scripted backend with
    `logContext: false`; sessions built by `importState`, which seals as a grown session does);
    after a restart the next turn's context is rebuilt in at most 5 s and the provider receives
    the same context as before (`turnDigests`); `history.page` is at most 300 ms; history pages
    load from the newest turn back to turn 1 across archived and kept turns with every turn
    exactly once. The same at 1,000 turns.
16. **SIGKILL during a seal** (`m2-interfaces.md` 4.5): a supervisor SIGKILL after the seal crank,
    while the segment file is written (before its rename), after the adapter's answer, and after
    the answer crank; after each restart history from the newest turn back to turn 1 shows every
    turn exactly once, the provider's next request carries the same context as before, no
    half-written segment is read or left, and the next seal succeeds.

**Perf checks**
| check | budget |
|---|---|
| `queue.enqueue` while a turn runs, round trip | <= 150 ms |
| `history.page` 32 turns on a 1,000-turn session | <= 300 ms (M1b: 598-666 ms for 26 turns of 7 records, J-0370; after CORE-11 869 ms at 1,000 turns, J-9383; needs the record bound of W2.5 or C-5; with the archive a session keeps at most 159 settled turns, so the page crank no longer grows with session length, `m2-interfaces.md` 4.13) |
| `context.rebuild` 1,000-turn session after restart (M1b row, carried) | <= 5 s (M1b: see its outcome table; after CORE-11 22.1 s, 14 page cranks of about 1.55 s, linear in turns, J-9383, J-9387; J-0322 option (b), the adapter's cache persisted next to the blobs, removes the page cranks from the restart path: built by W2.8 as `context.jsonl` and the mirror, `m2-interfaces.md` 4.7, 4.8) |
| `hub.row` bytes per hub commit of a session's row at 1,000 / 5,000 turns | recorded; decides J-9335 (a) in M2 or M3 (a row carries one entry per handle the session holds, and the log store rewrites the whole row per change, J-9386) |
| `session.heap` session vat slot capacity at 1,000 / 10,000 / 30,000 turns | recorded against the slot ceiling (4,000,000); the heaviest crank of a session at that size must still fit |
| `journal.snapshot` session vat at 1,000 / 10,000 / 30,000 turns | <= 500 ms / <= 1 s / recorded |
| `checkpoint.stall` turn latency while a busy session vat snapshots | p99 <= 1 s |
| `provider.overhead` fake-server first byte to subscriber delta | <= 5 ms per delta; 0 deliveries |
| `secrets.read` per round | <= 1 ms, in-process |
| `restart.serving` 50 checkpointed sessions x 300 turns (built by `importState`), no vat crashing | <= 15 s; 0 idle vats woken (gate) (M0: 5.3 s with 50 sleeping spares) |
| `throughput` deliveries per second at saturation (20 sessions) | recorded; journal if < 50/s |
| `disk.session` idle session after 300 turns; after delete | <= 25 MB plus blobs; returned on delete |
| too-big probes: 200 k-char submission accepted through the Composer, 200 k + 1 refused; a 100 KiB string sent straight to a vat method through the admin path is refused by the client library before sending | no halt |
| `archive.flat.turn` wall time per turn (100 turns ending there), 5,000 against 200 turns | <= 1.25 x (D-M2-1) |
| `archive.flat.turnStart` `turn.start` median, 5,000 against 200 turns | <= 1.25 x and <= 350 ms |
| `archive.flat.snapshot` session vat snapshot bytes and ms, 5,000 against 200 turns | <= 1.25 x (expected about 20 MB, `m2-interfaces.md` 4.13) |
| `archive.flat.slots` session vat slot capacity, 5,000 against 200 turns | <= 1.25 x (expected about 16 % of 4,000,000) |
| `archive.flat.hubRow` the session's hub row bytes and entries, 5,000 against 200 turns | <= 1.25 x (expected about 290 entries, 15 KB) |
| `context.rebuild` at 1,000 and 5,000 turns (archive) | <= 5 s each (D-M2-1) |
| `history.page` at 1,000 and 5,000 turns: the newest page (vat) and an archived page (`History`) | <= 300 ms each (D-M2-1) |
| `archive.seal` per seal: session crank ms (S, Z), adapter ms, bytes written, fsyncs | recorded |
| `archive.disk` bytes per archived turn (segments, `context.jsonl`) | recorded |

**Fit risk:** good for queue/records (heap Maps replace 1,320 lines of pet-name storage; atomic claim
removes the `interrupted` window); awkward for time-window checks (time stamped by the gateway).

**Deferred:** subscription backends (M4), compaction (M8; the archive's compaction hook is specified,
`m2-interfaces.md` 4.12), presets (M5), UI (M3). The record archive is **built in M2** (D-M2-1: W2.5
vat side, W2.8 adapter side), not in M13.

**Outcome (W2.9 integration; not yet reviewed, M2 is not marked done).** Release worker
`367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, allocation collection schedule, log hub
store, Node 22.23.4, Apple M3 Max shared with other agents (load 1.6-3.5 for the integration lane,
6-13 for the second long-session run, throughput and the 10,000/30,000-turn rows, when another
checkout's lane ran beside this one). Integration at `81911ab991`..`84fc8cb388` (W2.9 fixes in
J-9401); perf at `84fc8cb388`. Verdicts use the 1.25 x rule: "miss" is over the budget, "**fail**"
over 1.25 x. JSON lines and readings are in J-9400..J-9414.

| item | result | verdict | entries |
|---|---|---|---|
| 1 more than one delta per reply, OpenRouter and Anthropic (`m2-providers`) | 5 deltas each; turn 333-448 ms | pass | J-0423, J-9400 |
| 2 R4-43 / R4-45 texts, synthesized id, the turn continues (`m2-turns`) | pass | pass | J-0470 |
| 3 round limit 2 ends with R4-47, completed | pass at limit 2 in Node (real Endpoint, OpenRouter path); a 100-round turn in a vat (270 ms a round, flat); the real 1,024-round limit takes about 280 s alone, over the 5-minute file budget: opt-in `M2_TURNS_ROUND_LIMIT=1`, known failure | pass (Node) / known failure (vat at 1,024) | J-0471 |
| 4 queue 100 refused, edit / delete / send-now, duplicate request id (`m2-queue`) | pass | pass | J-0450 |
| 5 held `restart`: a new message or send-now releases in FIFO order | pass | pass | J-0450 |
| 6 cancel mid-stream: the server sees the close; `cancelled` | pass (close 51 ms after `cancel`); the stream ends `end { status: 'cancelled' }`, not `abort` (contract 6; the milestone's "abort emitted" is for the PM, J-0424) | pass (as contracted) | J-0424 |
| 7 replace the key, next turn uses it; revoke, next turn fails with no body; no value in the state dir (`m2-secrets`) | pass: the server saw the first, then the second key with no restart; a stale generation refused; a 401 with a body records the status only; revoked: `Secret operation failed: "REVOKED"`, no request; grep of 48 files / 211 MB, every encoding: 0 hits, control found | pass | J-9402 |
| 8 429 Retry-After retried only while nothing was delivered | pass (1.36 s turn with one 429) | pass | J-0423 |
| 9 300 turns, pages back to turn 1, every page <= `frameBytes` (`m2-history`) | pass (19 pages, largest 15,601 B) | pass | J-0461 |
| 10 two clients see the same queue and transcript | pass | pass | J-0450 |
| 11 default model change reaches new sessions only (`m2-catalog`) | pass: each request names its own model, windows 163,840 / 8,192 from the catalogue, R4-20 order, R4-21 refusals list nothing; one catalogue read for the file after the fix of J-9403 | pass | J-9403 |
| 12 failed and outcome-unknown turns in the next context; never-dispatched not | pass | pass | J-0470 |
| 13 SIGKILL during delete and during create; `row-removed` to two viewers <= 500 ms (`m2-lifecycle`; `m1b-live` 9) | pass; row-removed 5 ms after the answer; 6 runs of each SIGKILL case, delete killed 0-800 ms after `deleting`, create 168-3,544 ms after the call | pass | J-0480, J-9409 |
| 14 export then import into fresh state: same sessions, history, queues | pass (1,370 records; re-export identical). Presets are M5 | pass | J-0483 |
| 15 a 5,000-turn session behaves like a 200-turn one (`perf/history.perf.mjs`, built by `importState`, logContext digests off) | run 1 / run 2: wall per turn 0.98 / 0.94 x; `turn.start` 1.74 x (262 vs 151 ms) / 0.85 x (275 vs 322), all <= 350 ms; snapshot bytes 0.96 x; slot capacity 1.00 x; hub row 1.01-1.02 x; same at 1,000 (0.95-1.00 x); rebuild 85-359 ms with the same per-turn context digests; history walks newest to turn 1, every turn once, at 1,000 and 5,000 | pass (the one `turn.start` ratio over 1.25 x did not repeat: `turn.start` medians are bimodal at 140 / 270 ms) | J-9404 |
| 16 SIGKILL during a seal (`m2-archive-restart`) | pass; 6 runs x 4 points (24 kills) | pass | J-0461, J-9409 |
| M1a and M1b files (regression) | all pass, one file per invocation; `m1b-live` 9 delete now a plain test | pass | J-9409 |
| SIGKILL repeats (M1a 5, 6, 7, held ports x 5 delays; M1b 3/10 x 6; 8 x 6; 12 x 5 (+6); M2 13 x 6; seal x 6) | 81 kill cases (20 + 6 + 6 + 13 + 12 + 24); no duplicated provider request, tool run or exec evaluation; no lost or duplicated record; one `m1b-pool-restart` case (+1,000 ms) timed out at 4 min with no row, not reproduced in 6 reruns | pass, one unexplained timeout reported | J-9409 |
| Daemon-level secrets grep | 0 hits | pass | J-9402 |
| `queue.enqueue` (150 ms) | 126 ms (0-99 waiting), 61 ms shallow; 279 ms at 75-99 waiting | pass (deep end 1.9 x) | J-0450, J-9411 |
| `history.page` 1,000 turns (300 ms) | newest page 332 ms (run 1); archived page 41 ms | miss (1.11 x) / pass | J-9406 |
| `context.rebuild` 1,000 / 5,000 turns (5 s) | 290 / 359 ms (354 run 2); 429 ms at 10,000, 540 ms at 30,000 | pass | J-9404, J-9410 |
| `hub.row` 1,000 / 5,000 turns | 10,193 / 10,260-10,326 chars, 211-212 entries (516 KB, 10,012 without the archive) | recorded; J-9335 (a) not needed for length | J-9404 |
| `session.heap` 1,000 / 10,000 / 30,000 | 794,880 / 791,552 / 794,624 slots (20 % of 4,000,000; plain turns imported); 1.07 M for imported tool turns, 0.41 M grown | recorded (flat) | J-9405, J-9410 |
| `journal.snapshot` 1,000 / 10,000 / 30,000 (500 ms / 1 s / recorded) | 429 / 395 / 313 ms; 34.7-34.8 MB snapshot at each | pass / pass / recorded | J-9410 |
| `checkpoint.stall` p99 (1 s) | 2.2-3.1 s p99 of per-turn wall time in every 100-turn window (one outlier turn per window; snapshot turns <= 1.0 s) | **fail** | J-9408 |
| `provider.overhead` (5 ms; 0 deliveries) | 0.5-0.6 ms; 0 TurnSink messages while streaming (in process) | pass | J-0423 |
| `secrets.read` (1 ms) | 0.018-0.025 ms | pass | W2.3 |
| `restart.serving` 50 x 300 turns by import (15 s; 0 woken) | 4.4-5.6 s, 0 woken, 0 crashes | pass | J-9412 |
| `throughput` 20 sessions (journal if < 50/s) | 29.3 deliveries/s at load 8-9 (442 ms per delivery, 5.2 turns/s) | recorded, under 50/s | J-9412 |
| `disk.session` 300 turns (25 MB plus blobs) / after delete | 41.5 MB (40.9 MB the vat snapshot of an imported session) / all returned | **fail** / pass | J-0482, J-9405 |
| too-big probes | 200,000 characters accepted (turn 1.2 s), 200,001 refused by the Composer's guard; a 100 KiB string to `startTurn` refused by the session vat's guard, no halt, but delivered (known failure: "refused before sending") | pass / known failure | J-9407 |
| `archive.flat.*` (5,000 against 200, <= 1.25 x) | turn 0.94-0.98, snapshot 0.96, snapshot ms 0.43-0.89, slots 1.00, hub row 1.01-1.02 x, `turn.start` see 15 | pass | J-9404 |
| `archive.seal` | turns that sealed 633-795 ms against 613-673 ms for others (median); adapter side 17-24 ms (W2.8) | recorded | J-9404, J-0491 |
| `archive.disk` | 2,255-2,281 B of segment and 1,452-1,459 B of `context.jsonl` per archived turn | recorded | J-9404 |
| `session.program` (200 KB) | 186,328 bytes | pass (13.7 KB left) | J-0462 |
| `session.create` with the pool (750 ms) | 1,131 ms at load 6 (`m1b-pool`) | **fail** at that load (849-864 ms at load 2, J-9382) | J-9411 |
| Unit lane | 691 passed, 0 failed, 56 skipped | pass | J-9400 |

Fit (J-9400): the archive turned a heap that grew with every turn into one of fixed size, and the
pieces that live in vats (queue, holds, history, the archive's index and intent) fit the persistent
heap well; providers, secrets and the catalogue fit as adapter code because they are Node work with
no state worth persisting in a vat. What still grows or misses: the adapter's per-round projection
(M8), the heap high-water of an imported session (C-22), `checkpoint.stall`, `history.page` at its
budget's edge, throughput under 50/s at load, and the 100 KiB client-side refusal.

---

## M3. Chat UI and gateway

**Goal.** The daily surface: open the chat page from a desktop or phone browser, sign in by the
fragment secret, create sessions, chat with streaming, reload and reconnect without losing anything.

- **P:** P-01, P-02, P-04 (preset/backend/model; the internet toggle is tested in M7), P-22, P-23,
  P-24, P-27 (status bar), P-48.
- **R:** R2-1, R2-12, R2-14, R4-62, R6-1, R6-8, R6-9, R6-10, R6-11, R6-12, R6-13, R6-14, R6-35, R6-36,
  R6-37, R6-38, R6-39, R6-40 (composer, without @-mention), R6-41, R6-42, R6-43, R6-44, R6-45, R6-46,
  R6-49, R6-51, R6-52, R6-59, R6-60 (layout only), R6-61, R6-62, R6-75, R6-76, R7-2, R7-17, R7-46,
  R7-47, R7-48, R7-49, R8-39.
- **Depends on:** M2. Parallel with M4 and M5. **W3.0 is merged before M4 or M5 start a UI unit.**
- **Owns:** `AH/gateway/` (server, routes table, ws, captp bridge, frame guard, auth, csp, limiter),
  `H/ui/build.mjs`, `H/ui/src/{features.js,shell,conversation,sessions}/`, `H/test/browser/`,
  `H/test/*/m3-*`, `H/perf/ui.perf.mjs`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W3.0 UI shell + gateway skeleton | `ui/build.mjs`, `ui/src/{features.js,shell/}`, `AH/gateway/{server,routes}.js` | esbuild into `implDir` assets; shell with feature mount points; routes table; app shell for every non-upgrade GET | component smoke test; route table test |
| W3.1 auth + limiter | `AH/gateway/{auth,csp,limiter}.js` | `serveGateway({port, operator, publicOrigin, trustedProxies})`; `/ws` upgrade only, Origin check; CSP; fragment secret checked over WS (`fetch(secret)`), +1,000 ms per failure per client address with trusted-proxy forwarding and a global ceiling; secret in the secrets store; `rotateSignIn` | adapter: wrong secret delays; two forwarded addresses limited independently; untrusted `X-Forwarded-For` ignored; Origin refused; query-string config refused |
| W3.2 CapTP bridge | `AH/gateway/{captp-bridge,frame-guard}.js` | `@endo/captp` over WS; bootstrap `fetch` -> `{operator, live, content, composer}`; frame guard refuses calls over `frameBytes`; key guard refuses records with keys the target method's shape in `guest/lib/interfaces.js` does not declare (architecture section 7); 1 MiB WS cap | adapter: browser-side captp client calls `E(factory).listSessions()` through a fake operator; oversize call refused; undeclared-key call refused |
| W3.3a sessions | `ui/src/sessions/` from `space-floot/src/*` and `chat/floot-*.js` at 1315bef86 | session list (live through the list feed), new-session flow (preset, backend, model from catalogue incl. "factory default") | component tests ported from `chat/test/component/floot*.test.js` |
| W3.3b conversation | `ui/src/conversation/` | streaming bubble, thinking row, tool groups ("Thought for ..."), highlighted `exec` source, `</>` raw view, status rows, "Load earlier messages", large content through `Content` | component tests with a fake session |
| W3.3c queue + recovery | `ui/src/conversation/`, `ui/src/shell/` | queue display with Send now / Edit / Delete (through the Composer), reconnect overlay (0,1,2,5,10,30 s, then every 30 s; a refused connection shows "Server starting...", D-17), reload re-attach through `getCurrentTurn`, drawer at <= 640 px, recovery panel with "Record acknowledgement", usage status bar | component tests |
| W3.4 browser e2e | `test/browser/m3-*.mjs` | Playwright/browser-pane scripts against a local gateway + scripted backend | acceptance below |

**Acceptance tests**
1. Any non-upgrade path returns the shell; WS upgrade on `/ws` with the configured Origin succeeds,
   another Origin is refused; configuration in the query string is rejected.
2. Fragment secret yields the operator; a wrong one is refused and delays the next attempt by
   1,000 ms; through a trusted proxy, failures from one forwarded address do not delay another; the
   secret never appears in an HTTP request (network log).
3. Session list updates live across two tabs; rename and delete propagate.
4. Kill the WS: "Reconnecting..." overlay, retries on the schedule; the running turn reattaches and
   keeps streaming. With the gateway not listening for 60 s (daemon stopped), the overlay says
   "Server starting..." and the page reconnects by itself within 30 s of the gateway's return.
5. Close the tab mid-turn, reopen: the turn finished on the server and is in the transcript. Reload
   mid-turn: the page re-attaches to the running turn (R4-62).
6. Drop the connection between send and ack; resend from the saved draft creates no duplicate.
7. Restart the daemon mid-turn: the turn shows the interrupted status row; Details opens "Turn journal
   and recovery"; "Record acknowledgement" works while idle.
8. Tool calls fold into "Thought for ..." groups; `exec` shows highlighted source; `</>` raw view;
   "Load earlier messages" pages history; a 1 MiB reply renders fully.
9. At 640 px the sidebar becomes a drawer. `[real-browser]` on a phone is optional.
10. A browser call carrying a 100 KiB string straight to a session method, and one carrying a record
    with 2,000 invented keys, are both refused by the gateway, and the session keeps working.

**Perf checks**
| check | budget |
|---|---|
| `ui.coldLoad` to interactive (bundle size recorded) | <= 1.5 s on loopback; bundle <= 600 KB gz |
| `ui.reconnect` to rebuilt UI | <= 1 s after the socket opens |
| `ui.deltaFanout` 5 viewers, adapter chunk to all WS frames | <= 5 ms per delta |
| `ui.snapshot` 1,000-turn session watch | <= 300 ms; first message <= `frameBytes` |
| `ui.call` browser `E(session).listPending()` | <= 150 ms |
| `ui.hubGrowth` `hub.json` after 1,000 turns viewed in a browser with reloads | <= 2 MB |

**Fit risk:** good. CapTP-through-adapter is the mail-UI bridge pattern
(`pkg/src/platform/node/mail-ui-server.js`) with object references instead of tokens.

**Deferred:** @-mention (M5), preset editor (M5), widgets (M12), secrets view (M4), voice UI (M11).

---

## M4. Secrets manager and subscription pools

**Goal.** Full Secrets manager and UI, and the two subscription backends with pooled accounts,
renewal, refusal marks and account status.

- **P:** P-26 (full), P-58, P-07, P-06, P-05 (`fae-codex`, `fae-claude`), P-45, P-46 (pool, Codex and
  Claude parts).
- **R:** R2-18, R3-35, R3-233, R3-237, R4-14, R4-15, R4-16, R4-18, R4-19, R4-23, R4-24, R4-25,
  R4-30, R4-75, R4-76 (with the G-05 retry, open decision 12), R4-84, R4-85, R4-90, R4-103, R4-105,
  R6-29, R6-54, R6-67, R7-16, R7-22, R7-25, R7-26, R7-29, R7-30, R7-63, R8-13, R8-14, R8-30, R8-31,
  R8-34, R8-35, R8-36, R8-37, R8-38.
- **Depends on:** M2. Parallel with M3 and M5 (UI units after W3.0).
- **Owns:** `AH/subscriptions/` (pool, share meter, rate-limit headers, renewal, responses + messages
  clients, account oracle), `AH/secrets/{audit,catalog}.js`, `H/guest/factory/{backends,accounts}.js`
  (registered in `session-options.js`), `H/ui/src/secrets/`, `H/ui/src/accounts/`,
  `H/test/fixtures/sse/subscriptions/`, `H/test/*/m4-*`, `H/perf/pool.perf.mjs`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W4.1 secrets full | `AH/secrets/{audit,catalog}.js` | catalogue without values, audit listing 100 (max 1,000), delete only after revoke, size limits R7-25, no path from a Secret to its admin | ported `daemon/test/secret-manager.test.js` parts |
| W4.2 secrets UI | `ui/src/secrets/` | Secrets view: create, replace (value typed into the adapter-local `SecretWriter`), revoke, audit; never shows a value | UI component test |
| W4.3 pool and routing | `AH/subscriptions/{pool,share-meter,rate-limit-headers}.js` (adapted from `hosted-agent/src/*`) | member selection R4-24, stickiness 300 s with last-served records keyed by the Session object in the manager vat (at most 256), one attempt per member plus one refresh retry, "Provider subscriptions exhausted" with the reset time (G-07), marks persisted by coalesced sendOnly, a newer open reading lifts a dated mark | ported `subscription-pool.test.js`, `rate-limit-headers.test.js`, `share-meter.test.js` |
| W4.4 wire clients | `AH/subscriptions/{responses,messages}.js` from `lal/providers/subscription-{responses,messages,events}.js` | Codex Responses SSE, Claude Messages SSE with R4-30 headers, efforts R4-23, Codex overload retry R4-75, Claude overload retry (G-05), other Claude failures R4-76; context window from configuration for Claude (open decision 13); cancel revokes the endpoint (R4-49) | fake-server fixtures; ported `subscription-responses.test.js`, `subscription-messages.test.js` |
| W4.5 renewal | `AH/subscriptions/renewal.js` | OAuth refresh in the adapter, write-back conditioned on generation, holds only its grant and writer (W-5 fix) | two concurrent renewals: one fails |
| W4.6 accounts | `AH/subscriptions/account-oracle.js`, `guest/factory/accounts.js`, `ui/src/accounts/` | accounts channel (D-8) with plan/windows/credits labelled observed/declared/remembered/unavailable; `refreshAccounts`; `accountStatus` tool registered in `tool-table.js` | unit + UI test |

**Acceptance tests** (all with the fake server; `[real-provider]` repeats 4-5 once with owner credentials)
1. Secrets: create, replace with expected generation (stale refused), revoke (next read fails), delete
   only after revoke, audit lists each read; no API returns a value.
2. `auto` picks the member resetting soonest; ties by used fraction then declaration order; a session
   stays on its member for 300 s.
3. A 429 with exhaustion headers marks the member and retries once on the next; all exhausted fails
   "Provider subscriptions exhausted" and shows the reset time.
4. Marks survive restart; a newer open reading lifts a dated mark.
5. `thix reachability` from a session vat and from its exec vat reaches no `AgentHostAdmin`,
   `SecretsAdmin`, Secret admin or value, gateway facet, factory or other session.
6. Catalogue: `fae-codex` intersection rule (R4-18); `fae-claude` synthetic `auto` (R4-19); a failed
   read reports `unavailable`.
7. Account chips and the `accountStatus` tool show plan, windows and reset times with provenance
   labels; refresh updates them (P-45).
8. A Claude overload (529) before any delivery is retried; after a delivery it fails with the R4-76
   text.

**Perf checks**
| check | budget |
|---|---|
| `pool.selectAndOpen` per round | <= 2 ms in-process; 0 extra deliveries |
| `pool.markPersist` per refusal | 1 delivery to the manager vat |
| `accounts.push` per change | 1 factory publish; 0 per viewer |

**Fit risk:** good. All token-bearing code is Node in one process; the vat side is a few handles.

**Deferred:** Codex reset-credit redeem (open decision 8), voice preset model (M11).

---

## M5. Presets, prompt composition, object and exec tools, grants, mentions

**Goal.** Sessions get their authority from presets: built-in and user presets, the grant flow,
composed prompts frozen at creation, the full exec and object tool sets, granted tools, a minimal
operator inventory and @-mentions.

- **P:** P-20 (non-shell presets: `chat-only`, `general` without shell), P-53, P-15 (full), P-16
  (full), P-17, P-65, P-40, P-49 (except the voice shortcut, M11).
- **R:** R3-1, R3-5, R3-6, R3-7, R3-8, R3-9, R3-11, R3-16, R3-17, R3-20, R3-22, R3-29, R3-30 (stub
  until M8), R3-31, R3-32, R3-41, R3-42, R3-265, R3-270, R3-271, R3-273, R4-4, R4-26, R4-27, R4-28,
  R4-29, R4-38, R4-99, R6-40, R6-55, R7-6, R7-38, R7-45.
- **Depends on:** M2 (takes over `guest/session/prompt.js`). Parallel with M3 and M4 (UI units after W3.0).
- **Owns:** `H/guest/factory/{presets,grants,inventory}.js` (registered in `session-options.js`),
  `H/guest/lib/{preset-catalog,system-prompt}.js` (pure parts of `fae/session/preset-catalog.js`,
  `system-prompt.js`), `H/guest/session/prompt.js` (from M2), `H/guest/session/tools/{objects,granted,mentions}.js`,
  `H/guest/session/labels.js`, `H/guest/exec/powers.js`, `H/ui/src/presets/`, `H/ui/src/mentions/`,
  `H/test/*/m5-*`, `H/perf/tools.perf.mjs`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W5.1 preset catalogue | `guest/factory/presets.js`, `guest/lib/preset-catalog.js` | built-in table, user presets with revision compare-and-set, snapshot at creation (R4-4), endowments as `{label, value}` objects (32 max), default preset rule R3-20 | ported `preset-catalog.test.js` |
| W5.2 prompt composition | `guest/lib/system-prompt.js`, `guest/session/prompt.js` | parts R4-26 in order, chosen by snapshot object kinds; the guest part describes the persistent scope (rewritten R4-26 part 2, journaled); systemPrompt override R4-27; stored with the session; built with `join` | ported `system-prompts.test.js`; spoken intro only when `spoken` |
| W5.3 labels + object tools | `guest/session/{labels.js,tools/objects.js}` | **one** label map per session (the single store); `list`, `lookup`, `store`, `remove` (kept for P-17 / R3-31), `describeCapability` (bounded help), `readSources` (per-field budget under the tool limit) | unit tests |
| W5.4 exec powers | `guest/exec/powers.js` | `powers` is a live session-vat facet over the label map (`get`, `list`), not a copy | integration: adopt then use in exec in the same turn |
| W5.5 operator inventory | `guest/factory/inventory.js` | minimal operator inventory in the factory (label -> object, add/remove) used by preset objects and @-mentions; M12 adds the Home view over it | unit |
| W5.6 granted tools + mentions | `guest/session/tools/{granted,mentions}.js` | granted tool objects appear next round, built-in names protected, duplicates refused (P-65); @-mention attachments (32 slots) reach the turn with the R4-29 line and are released after the turn | unit |
| W5.7 preset and mention UI | `ui/src/presets/`, `ui/src/mentions/` (after W3.0) | preset editor shared across devices; composer @-mention autocomplete over the inventory | UI tests |

**Acceptance tests**
1. Edit a preset after creating a session: the session's prompt and objects do not change.
2. `list` shows held labels; `lookup` renders without calling; `describeCapability` returns bounded
   help; an unheld label resolves to nothing; `store` then a restart then `lookup` finds the value;
   `remove` discards it; exec sees the change through `powers` in the same turn.
3. A granted tool named `exec` is refused; two with one name are both refused; withdrawing removes it.
4. @-mention an inventory object: the model adopts it during the turn; an un-adopted attachment is
   released after the turn.
5. Custom presets may add capabilities from the operator's inventory (P-53).
6. Preset editor: save on device A, see it on device B; stale revision refused.
7. Typed (non-spoken) sessions do not get the spoken prompt; the composed prompt describes the
   persistent exec scope.

**Perf checks**
| check | budget |
|---|---|
| `tools.list` / `lookup` | <= 1 delivery each (in the session vat) |
| `exec.powersGet` from exec | <= 150 ms (one guest-to-guest answer) |
| `exec.scope1000` scope with 1,000 bindings: trivial call | <= 300 ms |
| `prompt.compose` largest preset | within one crank, <= 100 ms engine time |
| too-big probe: exec body of 300 k iterations ok; 10 x the per-crank ceiling gives the terminated result | session unaffected |

**Fit risk:** good. Persistent scope and object endowments are what Thixotrope offers; Appendix F
drops most of Endo's name plumbing.

**Deferred:** shell presets (M6), `viewImage` real input (M8), voice shortcut preset (M11).

---

## M6. Containers and git workspace

**Goal.** Development sessions: a per-session rootless container with `/workspace` backed by the
session's live git workspace, a branch-tracking git capability, emergency stop.

- **P:** P-19, P-18, P-55, P-47, P-12 (shell part), P-20 (shell presets `general` with shell,
  `development`, `new-project`; `voice` objects). `full-control` waits for open decision 5.
- **R:** R2-7, R3-10, R3-12, R3-13, R3-14, R3-15, R3-16, R3-21, R3-37, R3-40, R3-44, R3-45, R3-46,
  R3-47, R3-240, R3-246, R3-247, R3-248, R3-266, R4-7, R4-8, R4-81 (improved, D-16), R6-50, R6-57,
  R7-9, R7-36, R7-39, R8-41, R8-42.
- **Depends on:** M5. Parallel with M8, M9, M11.
- **Owns:** `H/resources/workspace/{durable,ephemeral,dirs,git}.js`,
  `H/resources/containers/{durable,ephemeral,runtime-podman,runtime-fake,images,lifecycle}.js`,
  `H/guest/session/tools/{shell,git,environment}.js`, `H/guest/factory/presets-shell.js`,
  entries in `turn-hooks.js` (`onCancel`: stop environment), `session-options.js`, `services.js`,
  `provision-steps.js`, `H/test/fixtures/fake-bin/`, `H/test/*/m6-*`, `H/perf/{container,git}.perf.mjs`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W6.1 workspace resource | `resources/workspace/{durable,ephemeral,dirs}.js` | per-session directory registration under the daemon-owned root; `Workspace` object; released on session delete (G-29) | adapter tests |
| W6.2 git capability | `resources/workspace/git.js` (`exo-git` `makeGitOperations` with the native git backend in Node), `guest/session/tools/git.js` | `main` with an empty initial commit; branches create/switch/rename/delete; status/diff/log/stage/commit/merge (ff-only and merge commit)/stash; `trackingStatus` = no upstream; no rewrite or remote methods; read-only facet; outputs per-field bounded | ported `exo-git/test/kit-conformance.test.js` subset `[real-git]` |
| W6.3a runner | `resources/containers/{runtime-podman,images}.js` | image pinned by digest, never pulled; start-up gate refuses missing pins (P-55); rootless, unprivileged uid, caps dropped, read-only root, memory/pids/CPU limits (W-12), workspace bind-mounted from the workspace dir (no sudo mount, W-2), persistent home volume; `runCommand(argv)` allowlist, per-call timeout then kill after 2 s, 64 KiB per stream, then per-field budget so the result is valid JSON under the tool limit (G-19) | `[real-podman]` tests tagged |
| W6.3b fake runtime + lifecycle | `resources/containers/{runtime-fake,lifecycle,durable,ephemeral}.js` | fake runtime with the same shape; lazy desired state (D-16): `restore` starts nothing, first `runCommand` starts, idle stop after `envIdleStopMs`; a failed stop is retried at the next adapter start instead of quarantining the session | fake-runtime tests |
| W6.4 session wiring | `guest/session/tools/{shell,environment}.js`, `guest/factory/presets-shell.js` | `runCommand`, `inspectShell`; cancel stops the environment (R4-7); emergency stop fences, holds the queue, survives restart; resume leaves the queue held; a retired break of `runCommand` is outcome-unknown (rule 12.8) | integration with the fake runtime |

**Acceptance tests**
1. Start-up refuses when a pin is not a digest or the image is absent `[real-podman]` (fake: missing
   pin refused).
2. `runCommand(['git','status'])` in the environment and `git().status()` see the same repository;
   a commit in one is visible in the other.
3. Non-allowlisted program refused; non-zero exit returned as data; > 64 KiB output cut; timeout
   terminates then kills after 2 s; a command printing 10 MiB returns a result that parses as JSON and
   is at most 32,768 units.
4. Home survives turns and a restart; the workspace is deleted with the session.
5. Git facet has no rebase/amend/cherry-pick/push; read-only facet refuses writes.
6. Emergency stop fences new work, holds the queue, stops the environment, survives restart.
7. A round with one `exec`, one `runCommand` and one object tool call runs them concurrently and
   records results in call order.
8. After a restart, no container is running until a session's first `runCommand`.
9. `[real-podman]` the process runs as a non-root uid with no capabilities.

**Perf checks**
| check | budget |
|---|---|
| `container.coldStart` `[real-podman]` | <= 5 s (record) |
| `container.runTrue` harness overhead over runtime | <= 150 ms |
| `git.status` 10 k-file repo through the capability | <= 1 s |
| `git.log` 1,000 commits page | <= 500 ms |
| `container.stopCleanup` | <= 3 s |
| `restart.environments` 20 sessions with environments | <= 15 s; 0 containers started |
| too-big probe: 10 MiB stdout | cut in the adapter; valid JSON; no vat halt |

**Fit risk:** awkward. Registrations fit, but `restore` re-binds every registration, so containers
need a lazy desired state; workspace projection on macOS without root (bind mounts into the Podman
machine VM) is environment-specific (journal).

**Deferred:** network policy and egress (M7), publishing (M10), `full-control` (open decision 5).

---

## M7. Network policy and public egress

**Goal.** Per-session network policy `off` / `public-internet` under an operator ceiling, agent
requests and operator approval, and public-only egress for shells.

- **P:** P-38, P-39, P-04 (internet toggle in the new-session flow).
- **R:** R2-8, R2-21, R3-10, R3-36, R3-48, R3-49, R6-56, R7-10, R7-41, R7-54, R7-55, R7-56, R8-15.
- **Depends on:** M6. Parallel with M10 and M12.
- **Owns:** `H/resources/containers/egress/` (proxy, DNS, policy), `H/guest/session/network-policy.js`,
  `H/guest/session/tools/network.js`, `H/ui/src/network/`, entries in `session-options.js` and
  `provision-steps.js`, `H/test/*/m7-*`, `H/perf/egress.perf.mjs`.

**Work units:** W7.1 egress proxy + DNS in the containers adapter (adapted from
`hosted-agent/src/public-egress*.js`, `public-dns-listener.js`, policy from `hosted-agent-policy.js`):
80/443 only, public addresses only, host's own refused, caps (connections, bytes, time, configurable
lower than Endo's 1 TiB/24 h). W7.2 session policy record, `requestNetworkPolicyChange` (pending
request, one at a time), operator approval with note applies next turn and restarts the environment,
audit. W7.3 UI panel and the new-session internet toggle (only where the preset allows).

**Acceptance tests**
1. `off`: the container cannot resolve or connect `[real-podman]` (fake: policy object refuses).
2. `public-internet`: HTTPS to a public host works; 10/8, 127/8, 169.254/16, 100.64/10, host addresses
   and other ports refused (proxy unit tests run everywhere with a fake resolver).
3. Agent request records a pending request and grants nothing; a second while pending is refused;
   approval applies at the next turn and restarts the environment; every step audited.
4. New-session flow: the internet toggle is offered only for presets that allow it, and the created
   session's policy matches the toggle (P-04).

**Perf checks:** `egress.connectSetup` <= 50 ms over direct; `egress.throughput` >= 50 MB/s loopback;
policy change to next turn <= environment restart time + 1 s.

**Fit risk:** good (all Node); the real container networking is environment-specific.

**Deferred:** daemon-side outbound filtering (W-11).

---

## M8. Compaction, images and context window

**Goal.** Long sessions keep working: automatic compaction at a share of the context window, image
input through `viewImage`, and the context reading shown to the user.

- **P:** P-36, P-37, P-27 (window share).
- **R:** R3-30, R4-34, R4-35, R4-36, R4-37 (configured window for Claude/Anthropic, open decision 13),
  R4-39, R4-100.
- **Depends on:** M5. Parallel with M6, M9, M11.
- **Owns:** `AH/providers/{compaction,images}.js` (registered in `projection-hooks.js`),
  `H/guest/lib/{context-compaction,compaction-checkpoint,image-result}.js`,
  `H/guest/session/compaction.js` (registered as a `beforeRound` hook), `H/guest/session/tools/view-image.js`,
  `H/test/*/m8-*`, `H/perf/compaction.perf.mjs`.

**Work units:** W8.1 compaction decision in the vat from the previous usage reading (R4-34),
`CompactionStarted` recorded before a tool-less summary round, retained-tail plan computed by the
adapter on its cache (`lal/providers/context-compaction.js`), `Compaction` record with the summary
and boundary; last user directive verbatim; unknown outcomes never hidden; postponed one round after
new images. W8.2 `viewImage`: image bytes read by the workspace/blob adapter and attached by the
provider adapter as native image input; the vat sees only a text receipt and the image's handle (bytes
never enter a vat); 2 MiB limit; exempt from truncation.

**Acceptance tests**
1. With a forced small window a turn crosses 70 %: a summary with the fixed headings is inserted as an
   assistant message; the last user directive is kept verbatim; later turns start from it; unknown tool
   outcomes stay visible.
2. SIGKILL during the summary round: after restart the compaction round is outcome-unknown and the
   next turn starts from the uncompacted context.
3. `viewImage` of a 1 MiB PNG reaches the fake provider as image input; a 3 MiB image is refused; the
   transcript shows a text receipt.

**Perf checks:** `compaction.plan` 150 k-token context <= 500 ms in the adapter; `compaction.record`
1 delivery; `viewImage` adds 0 vat deliveries beyond the tool result.

**Fit risk:** good, because the projection is adapter-side (D-9).

**Deferred:** forced-compaction switch beyond tests.

---

## M9. Mail and subagents

**Goal.** Agents talk to each other and to the operator: mail with packages and typed requests,
mail-started turns, and subagents with tree/depth limits that survive restart.

- **P:** P-41, P-42.
- **R:** R3-33, R3-34, R3-39, R3-214, R3-215, R3-216, R3-217, R3-218, R3-272, R4-5, R4-57, R4-58,
  R4-59, R4-67, R4-69, R4-70, R4-71, R4-72, R4-73, R4-101, R4-102, R7-43, R7-44.
- **Depends on:** M5. Parallel with M6, M8, M11.
- **Owns:** `H/guest/session/{inbox,mail-turns}.js` (registered in `turn-hooks.js` `turnSources`
  and `recoverySteps`, and `holds-table.js`), `H/guest/session/tools/{mail,requests,subagents}.js`,
  `H/guest/factory/{subagents,operator-inbox}.js`, `H/guest/lib/{workload-limits,subagent-admission}.js`,
  `H/test/*/m9-*`, `H/perf/mail.perf.mjs`.

**Work units:** W9.1 per-session inbox in the session vat (bounded backlog; G-13 bound), contact
objects passed directly (`E(otherInbox).deliver(package)`), packages with attachments adopted with
`take`, typed requests/forms answered with `resolveRequest`/`rejectRequest`/`submitForm`, each inbox
message starts at most one turn including across restarts; subagent replies claimed first and own
echoes dismissed (R4-57). W9.2 operator inbox in the factory vat. W9.3 subagents: `spawnSubagent`
creates a hidden session from the spare pool inheriting backend, model, effort, preset snapshot and
current network policy; tree limit 8 counting in-flight spawns and depth 2 with the R4-71 text; at most
65,536 retained asks (R4-102); answer cap 16 Mi characters, staged, then the tool limit; `askSubagent`
with an adapter-timer timeout; `stopSubagent` deletes depth-first; recovery cancels in-flight child
asks (architecture 4.4) and never waits for them to break: an ask pending into a child vat that was
given up during startup never settles (J-9048); a retired break from a child session means the child
is lost (D-17), not a restart.

**Acceptance tests**
1. The operator sends a package with an attachment; a turn starts from the inbox; the model `adopt`s
   it; an un-adopted attachment is released after the turn.
2. A typed request sent to a session is answered with `resolveRequest`; a turn that ends without
   answering rejects with "Agent ended the turn without a typed answer".
3. Each inbox message starts at most one turn, including across a restart mid-handling.
4. Spawn a subagent; it inherits backend/model/preset; `askSubagent` returns its answer; tree limit 8
   (counting in-flight spawns) and depth 2 refuse with the R4-71 text; `stopSubagent` deletes the
   subtree.
5. An ask in progress across a restart fails with the R4-67 text and does not hang; the child's turn
   is outcome-unknown and was cancelled.
6. A subagent reply arriving while the parent waits is claimed by the ask; the parent's own echo is
   dismissed (R4-57).

**Perf checks:** `mail.sessionToSession` <= 300 ms (compare 145 ms Thixotrope mail);
`subagent.spawn` with spare pool <= 1.5 s; `subagent.burst8` 8 spawns against a pool of 2 (record;
<= 30 s); `subagent.ask` overhead over the child turn <= 300 ms.

**Fit risk:** good (contacts are objects; Thixotrope mail showed the pattern); spare-pool sizing under
subagent bursts and surviving child work after a restart are the risks.

**Deferred:** interop with Thixotrope workspace mail between daemons (P-62, open decision 7).

---

## M10. Workspace publishing and asset server

**Goal.** A session can publish its workspace at a stable unguessable URL on a separate origin, served
straight from disk, revocable and released on delete.

- **P:** P-43, P-44, P-64.
- **R:** R2-5, R2-13, R3-38, R3-50, R3-241, R6-3, R6-78, R7-18, R7-40, R7-52, R8-16, R8-27, R8-50.
- **Depends on:** M6. Parallel with M7, M12.
- **Owns:** `H/resources/workspace/{assets,routes,mime}.js`, `H/guest/session/tools/publish.js`,
  entries in `provision-steps.js` (asset listener port), `H/test/*/m10-*`, `H/perf/assets.perf.mjs`.

**Work units:** W10.1 asset listener in the workspace adapter (copied
`endo-fs-asset-server/src/{serve-tree,mime,type-guards}.js`), 192-bit tokens minted in Node, routes as
registrations (restored after restart), `Route {url, revoke, describe}`; per-publication sandboxing CSP
(W-14). W10.2 `publishWorkspace` tool, release on session delete; admin route list and revoke;
read-only static site (P-64).

**Acceptance tests**
1. `publishWorkspace` returns a URL with a 192-bit token on the asset origin; the same URL works after
   a restart; live edits are visible; a path without a valid token gives 404.
2. Deleting the session releases the route (503 or 404 after).
3. The admin lists routes and revokes one.

**Perf checks:** `assets.firstByte` <= 20 ms; 0 vat deliveries per request; throughput >= 100 MB/s.

**Fit risk:** good: no vat on the request path.

**Deferred:** per-publication subdomains (needs the proxy, out of scope).

---

## M11. Voice

**Goal.** Speak to the assistant and hear replies: streamed STT with partials, sentence-pipelined TTS
fed from the live turn, client endpointing, gapless playback, barge-in, and timeouts on every stream.

- **P:** P-30, P-31, P-32, P-33, P-34, P-35, P-49 (voice shortcut preset), P-61, P-66.
- **R:** R2-6, R2-20, R3-13, R3-244, R3-245, R4-89, R5-1..R5-62 (contract and default items), R5-67
  (fixed: timeouts), R6-53, R8-17, R8-29, R8-43.
- **Depends on:** M3 (gateway) and M4 (voice preset backend). Parallel with M6, M8, M9.
- **Owns:** `AH/speech/` (stt, tts, engine supervision, speech view, audio route registered in
  `gateway/routes.js`, a tap registered in `channel-taps.js`, fakes), `H/guest/factory/voice.js`,
  `H/guest/lib/{speech-code-filter,voice-preferences}.js`, `H/ui/src/voice/`, `H/test/*/m11-*`,
  `H/perf/voice.perf.mjs`.

**Work units:** W11.1 STT engine supervision in the adapter (moonshine via `uv run`, a supervised child
process kept loaded, respawn on next use, startup failure isolated, response timeout) with fake-stt.
W11.2 TTS (Piper) with sentence split, code-fence and markdown stripping, chunks under 10 chars merged,
voice catalogue with range checks, synthesis timeout, fake-tts. W11.3 speech view of a turn **in the
adapter**: live turns from the channel tap; finished turns replayed from the transcript through
`Content` (the channel no longer holds them). W11.4a `/audio` WS route (binary frames, capability
token, inactivity timeouts: no audio for `sttIdleMs` (default 30 s) ends the utterance with an error;
no engine output for `engineTimeoutMs` (default 10 s) fails the utterance and restarts the engine).
W11.4b client audio extracted from `chat/floot-component.js` l.2019-2774: calibration, threshold,
silence, grace, min speech, pre-roll, junk filter, gapless playback, soft barge-in, wake lock,
level meter. W11.5 voice preferences in the factory vat; `voice` preset (P-61) with fallback and
warning when its model leaves the catalogue (G-11); the preset used by the voice shortcut (P-49);
per-message replay (P-35); spoken prompt only for voice-started sessions.

**Acceptance tests** (1-2 and 5 run with fakes everywhere and `[real-moonshine]` / `[real-piper]`
once; 6 with synthetic audio in the browser)
1. STT: a fixed 16 kHz clip streamed in 85 ms blocks yields cumulative partials (each replaces the
   previous) and a final after `end`; an odd trailing byte is dropped; closing the reader aborts.
2. The STT engine stays loaded between utterances; killing it respawns on next use; an STT failure at
   start is logged and does not block TTS or other services.
3. TTS: text with a fenced code block and markdown is spoken without the code and without markup;
   sentence split respects abbreviations; chunks under 10 chars merge.
4. `speak` on a turn plays already-finished messages then live deltas; tool calls insert a sentence
   break; a finished turn replays to the end.
5. Out-of-range `speed` or an unknown voice makes `synthesize` throw; the catalogue skips broken voices.
6. Endpointing: calibration 1 s sets the floor; 400 ms bursts discarded; junk phrases discarded;
   1,200 ms silence then 800 ms grace sends; speech during grace joins the message.
7. Barge-in during playback stops audio and synthesis but the turn completes and is recorded; the new
   utterance queues behind it.
8. Voice preferences written on device A are used on device B; the voice shortcut uses the chosen
   preset.
9. Typed sessions do not get the spoken prompt.
10. A hanging fake STT engine fails the utterance after `engineTimeoutMs` with a visible error and is
    restarted; an open audio stream with no frames for `sttIdleMs` is closed; a hanging fake TTS fails
    that sentence and playback continues with the next.
11. Per-message replay plays a finished message again; the level meter moves with input.

**Perf checks:** audio frames 0 vat deliveries (engine counters); STT partial <= 300 ms after 0.5 s of
new audio `[real-moonshine]`; final <= 500 ms after `end`; TTS first audio <= 1 s warm `[real-piper]`;
adapter audio forwarding <= 2 ms per 85 ms block.

**Fit risk:** good, because audio never touches a vat; audio decoding shares the agent-host process
with tokens (blast radius, journal).

**Deferred:** Android (P-60, open decision 7).

---

## M12. Operator surfaces: provisioning, service, CLI, diagnostics, Home, spaces, widgets

**Goal.** Everything needed to operate the harness: idempotent provisioning, a supervised service with
an environment allowlist, an attach-only admin CLI, diagnostics, and the remaining chat-UI spaces.

- **P:** P-28, P-29, P-54, P-56, P-67, P-50, P-51, P-57, P-52 (mapped below).
- **R:** R2-3, R2-4, R2-10, R2-17, R2-25, R3-201, R3-202, R3-203, R3-204, R3-213, R3-219..R3-228,
  R3-230, R3-275, R3-276, R6-2, R6-15, R6-16, R6-17, R6-18, R6-24..R6-32, R6-47, R6-48, R6-70,
  R6-72, R6-73, R7-31, R8-4, R8-5, R8-19..R8-31, R8-47, R8-48, R8-49.
- **Depends on:** M3, M4, M5. Parallel with M7 and M10.
- **Owns:** `H/bin/harness.js`, `H/scripts/{provision,serve}.mjs` (the runners; steps stay in the
  append-only table), `H/guest/factory/{home,spaces,diagnostics}.js`, `H/ui/src/{home,spaces,widgets}/`,
  `H/test/*/m12-*`, `H/perf/admin.perf.mjs`.

**P-54 and P-52 mapping (owner principle 2: CLI for admin only).**

| P-54 / P-52 part | Provided by | Checked by |
|---|---|---|
| attach to the running daemon without starting another | `harness` CLI over `connectLocalControl`; exits "no daemon was started" otherwise (G-53; R6-71 not built) | acceptance 1 |
| run setup scripts with chosen powers | `thix install` / `thix install-native` with grants; `harness provision` | acceptance 4 |
| list and show objects | `thix status`, `thix installations`, `harness sessions`, `harness status` | acceptance 5 |
| read and send mail | `thix inbox`, `thix send`, `thix mail` (operator inbox in M9) | acceptance 5 |
| inspect | `thix reachability`, `harness diagnose` | acceptance 3 |
| evaluate, create agents | dropped as admin-irrelevant: evaluation is the session's `exec`; agents are created in the UI or by `harness sessions create` | recorded |
| P-52 named references, directories | Thixotrope inventory (README 171) and the factory's operator inventory (M5) | M5 acceptance 4-5 |
| P-52 host and guest identities, confined evaluation | vats and the exec Compartment (D-11) | M1b acceptance 3-4, M4 acceptance 5 |
| P-52 plugin installation with explicit powers | `thix install` grants; presets' `{label, value}` endowments | M5 acceptance 5 |
| P-52 cancellation | `Turn.cancel`, `retire()` | M2 acceptance 6 |

**Work units:** W12.1 provisioning runner: fixed order from `provision-steps.js`, each step's outcome
recorded, identities kept (same name + digest + grants), refuses to start without state; serve wrapper
with an environment allowlist (P-56) that clears leftovers of a previous run before starting (stale
socket, stale lock whose pid is gone, orphaned adapter-owned containers) (P-29); launchd/systemd unit
sample (no NixOS). W12.2 CLI `harness`: status, sessions (list/create/delete), secrets import (sealed),
rotate sign-in, reachability, diagnose. W12.3 diagnostics: object description, reachability explanation
(`thix reachability`), turn traces. W12.4a Home view (operator inbox, inventory over M5's store with
relabel and remove, live through a home channel). W12.4b command bar with @-refs and the needed slash
commands only; saved spaces on the server with colour schemes. W12.4c `endowidget` rendering in an
isolated iframe with 65,536-unit / 2,048-node / depth-32 limits.

**Acceptance tests**
1. The CLI with no daemon running exits with "no daemon was started" and does not start one.
2. The Home inventory updates live; relabel and remove work; the command bar autocompletes `@label`.
3. Diagnostics: the reachability report explains why an object is retained.
4. Provisioning twice is a no-op; serve without state refuses; an environment variable outside the
   allowlist never reaches an adapter.
5. Spaces saved on one device appear on another; Home cannot be removed.
6. A reply containing an `endowidget` block renders in isolation; a widget over 65,536 units or 2,048
   nodes is refused.
7. Kill the service with a stale socket, stale lock and an orphaned fake container left behind: the
   next start clears them and serves (P-29).

**Perf checks:** `admin.cliStatus` <= 500 ms; `home.inventoryWatch` 1,000 entries <= 300 ms snapshot;
`provision.fresh` <= 3 min, `provision.noop` <= 20 s.

**Fit risk:** good; the CLI and diagnostics reuse `connectLocalControl` and `thix reachability`.

**Deferred:** P-59, P-60, P-62, P-63 (backlog below).

---

## M13. Upgrade, collection and longevity

**Goal.** The harness survives its own evolution and weeks of use: new program versions without
losing sessions, native reinstalls without breaking references, reclaimed state, bounded disk.

- **P:** hardening of P-13, P-14, P-28, P-29; G-29, G-33 decisions.
- **R:** R2-25, R4-63, R4-64 (and the spec's defect "removed state never reclaimed").
- **Depends on:** all earlier milestones.
- **Owns:** `H/guest/factory/upgrade.js`, `H/scripts/{upgrade,soak}.mjs`, `H/test/*/m13-*`,
  `H/perf/soak.perf.mjs`. (The record archive moved to M2, D-M2-1.)

**Work units:** W13.1 `upgrade.mjs`: automates M2's `exportState`/`importState` into new program
versions and swaps references in the factory. W13.2 native reinstall migration: re-mint
Secrets/Backends/Blobs/Routes handles from adapter-side state and push new `SessionServices` (D-13).
W13.3 collection sweep: `collectVats` with the factory as root, snapshot and incarnation cleanup
verified on disk (per-delete reclamation is already in M2); a sweep of blob files must keep every
key an archive names (`archiveKeys`, `m2-interfaces.md` 4.10). W13.4 (archive) moved to M2 (D-M2-1:
W2.5, W2.8). W13.5 soak: 50 sessions, 7 simulated days of turns with the scripted backend.

**Acceptance tests:** upgrade a state directory with 20 sessions to a new session program:
transcripts, queues, presets intact; reinstall agent-host: sessions keep working; delete 10 sessions:
disk returns to within 10 % of before.

**Perf checks:** `soak.diskPerSession` <= 25 MB + content; `soak.cranks` p99 <= 300 ms over the run;
`upgrade.perSession` <= 10 s; `soak.hubJson` stays <= 2 MB.

**Fit risk:** awkward. Thixotrope has no live upgrade (README 286; `designs/vat-replacement.md` not
implemented), so this is application-level export/import.

**Deferred:** nothing beyond the backlog.

---

## Backlog: parity is not complete until the owner rules on open decision 7

These items are not out of scope under the owner's principles (they are not host infrastructure,
Whylip or irrelevant slash commands). They are scheduled after M13 by default only.

| P | status | notes |
|---|---|---|
| P-59 workflow service | after M13 pending decision 7 | would reuse M9 typed-request forms and the operator inbox |
| P-60 Android shell | after M13 pending decision 7; needs a device | WebView around the M3 UI and M11 voice |
| P-62 daemon-to-daemon peers | after M13 pending decision 7 | not the browser peer relay; Thixotrope peers are same-user same-machine only (README 429-436), so a real remote netlayer is needed first |
| P-63 file explorer, inventory graph, peers, channels | after M13 pending decision 7 | after P-62 |

## Ownership check for parallel groups

- **{M3, M4, M5}:** M3 `AH/gateway/`, `ui/build.mjs`, `ui/src/{features.js,shell,conversation,sessions}`
  (W3.0 merged first); M4 `AH/subscriptions/`, `AH/secrets/{audit,catalog}.js`,
  `guest/factory/{backends,accounts}.js`, `ui/src/{secrets,accounts}`; M5
  `guest/factory/{presets,grants,inventory}.js`, `guest/lib/{preset-catalog,system-prompt}.js`,
  `guest/session/{prompt,labels}.js`, `guest/session/tools/{objects,granted,mentions}.js`,
  `guest/exec/powers.js`, `ui/src/{presets,mentions}`. Hook points: M4 and M5 add entries to
  `session-options.js` (backend/model resolution; preset snapshot), `services.js`, `tool-table.js`
  (`accountStatus`; object tools), `features.js`. Disjoint otherwise.
- **{M6, M8, M9, M11}:** M6 `resources/{workspace,containers}/` (except assets/egress),
  `guest/session/tools/{shell,git,environment}.js`, `guest/factory/presets-shell.js`; M8
  `AH/providers/{compaction,images}.js`, `guest/lib/{context-compaction,compaction-checkpoint,image-result}.js`,
  `guest/session/compaction.js`, `tools/view-image.js`; M9 `guest/session/{inbox,mail-turns}.js`,
  `tools/{mail,requests,subagents}.js`, `guest/factory/{subagents,operator-inbox}.js`,
  `guest/lib/{workload-limits,subagent-admission}.js`; M11 `AH/speech/`, `guest/factory/voice.js`,
  `guest/lib/{speech-code-filter,voice-preferences}.js`, `ui/src/voice/`. Hook points: M6 `turn-hooks.js`
  `onCancel`, `session-options.js`, `services.js`, `provision-steps.js`; M8 `turn-hooks.js`
  `beforeRound`, `projection-hooks.js`; M9 `turn-hooks.js` `turnSources` and `recoverySteps`,
  `holds-table.js`; M11 `channel-taps.js`, `gateway/routes.js`, `features.js`. Nobody edits `turn.js`,
  `context-cache.js`, `channels.js` or `gateway/server.js`.
- **{M7, M10, M12}:** M7 `resources/containers/egress/`, `guest/session/{network-policy}.js`,
  `tools/network.js`, `ui/src/network/`; M10 `resources/workspace/{assets,routes,mime}.js`,
  `tools/publish.js`; M12 `bin/`, `scripts/{provision,serve}.mjs`, `guest/factory/{home,spaces,diagnostics}.js`,
  `ui/src/{home,spaces,widgets}`. Hook points: M7 and M10 append to `provision-steps.js` and
  `session-options.js`; M12 changes only the provisioning runner. Disjoint otherwise.
- All groups: `H/package.json`, `H/perf/_harness.mjs` and `H/JOURNAL.md` are PM-merged; integration
  and perf runs take the run lock.

---

## Disposition of review points

Blocking points from `critique-feasibility.md` (F) and `critique-coverage.md` (C). Each was checked
against the code or the spec before acting.

| point | verified at | disposition |
|---|---|---|
| F B-1 JS decode cannot give 256 k (or 64 k) frames | `pkg/src/core/worker-peer-xs.js:79`; `packages/base64/src/decode.js:86,160`; `boot.rs:800-808`; `polyfills.js:106-160` (ignores `fatal`); README 704-748; reviewer's probe numbers | Accepted. CORE-1a (native `fromBase64` reaches vats) and CORE-1 (native UTF-8 decode and encode, honouring `fatal`) are both in M0, not deferred; crank budget chosen by S1 as configuration; every bound is now in bytes (`frameBytes`, default 24,576 until S1); M0 acceptance no longer asks for 256 k. Architecture fact 2, section 1.1, section 9. |
| F B-2 protocol messages exceed any feasible inbound bound | architecture section 4.1 (old roundFinal, submission, tool output) | Accepted. Anything over `inlineBytes` is staged as a manager-minted Blob with a preview (D-10, D-15): submissions through the gateway Composer, model messages, tool arguments and results, native context; progress carries a Blob that replaces one partial record. Tool output stays R4-100's 32,768 units because the model reads it from the blob in the adapter. M1a refuses oversize output safely; M1b stages it. |
| F B-3 outbound frames halt the sending vat | reviewer's probe (60 k ok, 250 k killed); `polyfills.js:22-70` | Accepted. `frameBytes` and `crankOutBytes` bound vat outbound too (rule 12.5); records are small; exec results are written to a `BlobWriter` in pieces; history, context and list pages are bounded by bytes. |
| F B-4 viewer fan-out from durable vats | `pkg/src/net/hub.js:1917-1931` (silent breaks) | Accepted. D-8: no durable vat holds a viewer; the factory and sessions publish once per crank to adapter channels; the gateway fans out and drops closed sockets (rule 12.7). |
| F B-5 startup wakes workers with an unsnapshotted journal | `pkg/src/core/daemon.js:826-847`; `supervisor.js:141` (`idleSleepMs` option) | Accepted. Restart tests use `idleSleepMs: 2000`, wait for checkpoint and `pool.whenSettled()` before SIGKILL; "0 idle vats woken" is a gate counting checkpointed vats only. |
| F B-6 1 s `sleep` exec acceptance impossible | native.md:39-40 (`clock.after(0n)` 989 ms) | Accepted. M1a acceptance 3 uses the adapter `echo` tool with `delayMs` and asserts overlap (< 1.6 x one call). Interactive timers are adapter timers (architecture section 8). |
| F B-7 `exec.sends100 <= 2 s` ignores answer deliveries | tooling.md 4.5; J-0017 | Accepted. Budget split: 100 answered <= 8 s, 100 `sendOnly` <= 1 s (M1b). |
| F B-8 parallel groups not disjoint; no run lock | old ownership lists | Accepted. Hook tables (`turn-hooks.js`, `holds-table.js`, `session-options.js`, `services.js`, `projection-hooks.js`, `channel-taps.js`, `gateway/routes.js`, `provision-steps.js`, `features.js`), sequential ownership transfers (`prompt.js`, `provision.mjs`), W3.0 merged before M4/M5 UI units, PM-merged files with pre-allocated journal number ranges, and the run lock. |
| C queue entry lifecycle can post twice | SPEC:1619-1620 (A.4 `dispatching` row); R4-54 SPEC:527 | Accepted. Atomic claim: the entry is removed in the crank that records `TurnStarted`; a never-dispatched turn is closed with the R4-66 text and not re-queued (architecture 4.3-4.4). Test: M1a acceptance 6. Journal: atomic claim is a good fit. |
| C cancel retires the exec vat | R4-49 SPEC:519 | Accepted. Cancel abandons the answer by generation; the vat is retired only on the exec deadline, a MeterAbort, or when still busy at the next call, always with a stated scope loss (architecture section 6). Test: M1b acceptance 3. |
| C more than about 200 tool calls in one round quarantine the session | baseline (e) 500 sends MeterAbort | Accepted. `maxCallsPerRound` 64 with an error result for extras, `callWindow` 16 in flight; probe of 300 calls in M1b. Open decision 11. |
| C oversize inbound frames have only a cap | old architecture section 9 | Accepted; same fix as F B-2 (blob staging keeps R4-31 and R4-64). Probes: 1 MiB reply, 300 KiB exec body (M1b). |
| C `services` and `factoryInternal` over-grant | old `setServices({host,...})` | Accepted. `AgentHostAdmin` is held only by the factory; sessions get an attenuated `SessionServices` (their Backend, a per-session `SessionHostFacet`, workspace/shell, an `ExecHandle`) and a per-session `RowReporter`. Reachability test from session and exec vats: M4 acceptance 5. |
| C W-8 limiter behind the proxy | SPEC:1236 (W-1, W-8); spec-digest 4.1 | Accepted. `trustedProxies` with right-most untrusted `X-Forwarded-For`, plus a global ceiling; test with two forwarded addresses (M3 acceptance 2). |
| C G-19 reproduced | old architecture section 6 | Accepted. Per-field budgets so results stay valid JSON under the tool limit (runCommand, readSources, askSubagent); M6 acceptance 3 and too-big probe. |
| C voice stream timeouts missing | SPEC:1240; R5-67 SPEC:716 | Accepted. M11 W11.1, W11.2, W11.4a timeouts and acceptance 10. |
| C J-0004 hides the restore incompatibility | native.md:177-178, 288-289; `manager-kit.js:148-160` | Accepted. D-16 lazy desired state for containers; J-0004 regraded awkward; restart perf check with 20 environment sessions (M6). |
| C no multi-session performance check | single-session budgets only | Accepted. `concurrency.10` (M1b), `throughput` (M2), `hub.growth` (M1b, M3, M13); row changes only on visible transitions. |

Advisory points applied: M1 split into M1a/M1b; oversized work units split (W1a.2-W1a.5, W2.1a/b,
W3.0-W3.3c, W6.3a/b, W11.4a/b, W12.4a-c); integration "per file" with a state template (S8);
restart-race handling by lease and retired-break classification (D-5); thin installed modules with a
run-time implementation directory (D-14); data-only export/import in M2; explicit retirement of
quarantined exec vats; adapter-owned projection and archive deferred behind a measurement (D-9, D-10);
manager-minted, fsynced blobs (D-15); `fatal` decoding; progress as one replaced partial record;
adapter timers instead of clock alarms; per-connection error isolation and supervised speech engines;
`modelId` option and stored resolved model; rewritten persistent-scope prompt; recovery cancels child
asks; reuse.md:353 warning; compaction decided and recorded by the vat; single label map with a live
`powers` facet; last-served records keyed by Session; SecretWriter by amplification; publisher and
subscriber facets; `full-control` behind decision 5; G-05 retry and G-31 improvement; collection on
delete in M2; tests restated as behaviour; new tests for R4-10, R4-56, R4-22, R4-6, R4-9, R4-32, R4-31,
R4-57, R4-62, R4-83, P-04, P-29, P-35, P-45, P-49, P-52/P-54 mapping; spec-digest test texts copied
into M9-M12; backlog heading states that parity is incomplete until decision 7; new open decisions
10-15 and the G items raised.

---

## Changes after M0 and M1a

Decisions, settings and budgets that M0, the PR 1667 integration, M1a and its hardening, M1b and
the core work after M1b (C-7, C-2 and their integration, J-9300..J-9399) changed.
"Was" is the plan before the change; the evidence is in `JOURNAL.md` and `m0-results.md`.

| what | was | now | evidence |
|---|---|---|---|
| `frameBytes` | 24,576 until S1, then half the halt point, target >= 196,608 | 24,576, settled; the target is dropped while `harden` costs per byte (C-5) | halt above 94,208 at 50 M; 24,576 inbound in 312 ms against a 357 ms budget (J-0193, J-0194) |
| `crankOutBytes` | 2 x `frameBytes` | 196,608 (8 frames) | 8 x 64 KiB in one crank 553-576 ms (J-0142) |
| Crank budget | planning value 50 M, S1 to choose | 50 M (`config/defaults.js`); open decision 15 settled | runaway 242-271 ms; 100 M buys nothing (J-0143) |
| `execSourceBytes` | 262,144 in one message | 262,144 **staged** in `frameBytes` pages, evaluated in one crank (architecture 6, rule 12.11) | one message of 150 k halts; 262 k staged 3.9 s (J-0146, J-0195) |
| Record keys into vats | not constrained | rule 12.10: fixed key vocabulary, data-keyed collections as pair arrays or in-vat Maps, model JSON as text; gateway key guard (architecture 7, M3 W3.2) | permanent name table of about 57,000 per vat (J-0191) |
| Where limits live | section 9 named no file | `config/defaults.js`; guest copy `guest/lib/limits.js` (M1a W1a.0); core copy `STAGING_FRAME_BYTES` | J-0144, J-0122 |
| Crash bound | not in the plan | `maxDeliveryAttempts` 5 (D-17, open decision 16) | J-9046, J-9051 |
| Restart budget | "restart to serving, 50 idle sessions <= 15 s" | split: healthy restart <= 15 s (gate); restart with a vat crashing on every replay recorded against 15 s, depends on C-8, C-9 | healthy 4.4-5.8 s; crashing 36-69 s at bound 5 (J-9045, J-9046, J-9050) |
| Session create with spare pool | <= 1.5 s | <= 750 ms | spare take 157-176 ms (J-9045) |
| `exec.first` (spare exec vat) | <= 1.5 s | <= 750 ms | same mechanism as a spare take (J-9045) |
| Factory install of the bundle | <= 30 s | <= 15 s for up to 300 k characters | 11.6 s ASCII, 14.0 s mixed (J-0193) |
| `template.start` | <= 20 s | <= 10 s | 5.6 s (J-9045) |
| Session create without pool | <= 6 s | <= 6 s kept, marked depends on C-5; new bound: session program <= 200 KB (`session.program`) | 6.4 s for a 246 KB program (J-9045) |
| `vat.evaluateProgram` 150 k | <= 2 s | kept, marked depends on C-5 | 2.2-2.3 s, staging 95 % (J-0193) |
| `exec.sends` 100 answered | <= 8 s | kept, marked depends on C-7 | 9.4-10.6 s from a probe vat before CORE-4 (J-0143) |
| Guest rule 12.4 | no suspended async generators across deliveries | allowed, bounded like retained state; SIGKILL replay untested | S5 (J-0147) |
| Meaning of the retired break | always "restart" on the turn path | from an adapter object: restart; from a guest vat: that vat is lost; recovery never waits for a guest call (D-5, D-17, section 4.4, rule 12.8) | J-9048, J-9049, J-9051 |
| Exec scope-loss text | "exceeded the per-step compute budget" | neutral text naming both causes (a halt and a crash give-up look the same from inside) | J-9040, J-9051 |
| Lost session vat | not in the plan | row `lost`, kept listed; `deleteSession` retires it (M2 W2.7); reinstate asked of core (open decision 17, C-11) | J-9049 |
| Browser during startup | reconnect overlay | a refused connection shows "Server starting..." and keeps retrying (architecture 7, M3 W3.3c) | J-9051 |
| Spare pool details | 2 spares, refilled in the background | refilled with up to 4 creations in parallel; ASCII bundles staged in `frameBytes` chunks | J-0183, J-0186, J-9045 |
| Core changes (architecture 1.1) | CORE-1a in `boot.rs`; CORE-1; CORE-1b; CORE-2/3 conditional | CORE-1a landed in `@endo/immutable-arraybuffer`; CORE-4..CORE-7 added; CORE-2/3 not needed | J-0100, J-0190..J-0192, J-9022 |
| Integration test method | template "if path-independent"; run lock by pid | template helper API and supervisor child as built; run lock by generation with workload tracking (architecture 10) | J-0180, J-9020, J-9021 |
| M1a | 7 work units, 8 acceptance tests | W1a.0 interface contract first, then W1a.1-W1a.3 and W1a.4-W1a.6 in parallel; acceptance 8 (frame limit) widened, 9 (record keys) and 10 (crashing session at restart) added; perf `session.program`, `session.createCold`, `install.factory`, `restart.crashingSession` | this table |
| M1b | 9 acceptance tests | 10 (exec call across a restart is not awaited) and 11 (exec worker crash give-up) added; exec staging and pool refill specified | J-9048, J-9051 |
| Turn start ports | `Backend.open` per turn through the manager vat (M1a contract) | ports (`TurnPorts`, with `since`) opened once in `make`, held per adapter incarnation, dropped when proved dead; a turn start is one crank; the settle crank starts the next queued turn (architecture 4.1, contract 6.1) | turn start 573 -> 255 ms (J-0272, J-9151, J-9191) |
| Restart before `Dispatched` | recovered in the crank of the lease break | the session reopens and compares `TurnStarted.at` with the fresh ports' `since`: earlier -> `interrupted`; later -> round 0 again on fresh ports (contract 7.1; a typed notice is C-19) | J-9154, J-9190 |
| Settled turns | a `Turn` exo per turn for the session's life | records; `Turn` minted when handed out, 32 kept (`retainedTurnHandles`); compare turns by `turnId`; receipts: 4,096, 24 h, no exo | 1,000 -> 32 live `Turn`s (J-9152) |
| History page guard | strict `M.or` of every record shape | structural (`M.key()` per record; records were checked at append) | 18.0 -> 0.77 ms per page in Node (J-9153, J-9156); vat row is M1b |
| `createdAt` | stamped from the factory's known time (always 0) | `CreateOptions.at`, the caller's clock | J-9150, J-9193 |
| Blank submissions | not refused | refused with `texts.blankSubmission` (Fae's text; the spec has none: PM decision) | J-9150 |
| OCapN GC frames | one vat delivery each; woke sleeping vats | held in the journal, delivered with the next ordinary crank or after 64; never wake a vat (CORE-9, architecture 4.6) | J-9120..J-9125 |
| Woken-vat checks | "journal grew" | the worker row's `wakes`; `journalLength` is the delivery frontier, `heldFrames` separate | J-9122, J-9193 |
| Live channel | arrival order, deliveries-only drop bound | rev order with a reorder window; 4,096 deliveries or 2 MiB per subscriber; 32 subscribers; envelope-only return guard | J-9170..J-9172 |
| `turn.delta` measurement | control client through the hub | in-process subscriber in the adapter (where the gateway subscribes); the client path is `turn.delta.client`, no budget | J-0274, J-9173 |
| Guest bundles | non-ASCII hidden names (U+034F) from `@endo/module-source` | escaped as `\uXXXX`; guest lint refuses non-ASCII outside comments and SES-rejected source text | J-9174 |
| C-16 workarounds | the `Set`-based queue and no in-place array moves (J-0271, J-0292) | kept; no longer needed for correctness after the engine fix (`9828522485`) | J-9101 |
| Integration runs | one file per invocation | also `corepack yarn test:integration` (serial, one lock); `M1A_KILL_DELAYS_MS` repeats the SIGKILL cases | J-9174, J-9193 |
| M1b | 6 work units, 11 acceptance tests | W1b.0 contract step first (with the carried M1a items); acceptance 8 extended to a session idle across the restart, 12 (spare take and its open) added; perf `history.page`, `hub.gcBurst`, the M1a turn rows re-run | this table |
| Slot ceiling (`THIXOTROPE_SLOT_CEILING`) | not set by the harness (Thixotrope's 1,000,000) | 4,000,000, set by `scripts/serve.mjs` from `config/defaults.js` `slotCeiling` (M1b QC); a host value wins; it bounds live heap plus one crank (C-7, C-21) | a 100-call round halted a session vat at 1,000,000, passes at 4,000,000; 256-call rounds pass (J-0362, J-0392) |
| Exec cancel | abandoned by generation, nothing sent to the exec vat; an exec arriving while the cancelled call still ran got busy, a reset and a fresh scope | `ExecScope.abandon()` (sendOnly, before any later `run`; also from recovery): the next exec runs at once in the same scope; acceptance 3 holds as written (contract 8.3) | J-0307, J-0391 |
| Exec call lifetime | a call ended when the wrapper's promise settled; work it started kept running | a call's `sleep` dies with the call, so model code cannot outlive its call or keep the vat cranking (architecture 6; M5's `powers` must follow) | QC finding 4, J-0391 |
| Exec name-table flood | "halts only the exec vat, which is retired" | the engine's RangeError is catchable: the exec vat answers `exhausted`, the session records `texts.execExhausted` and retires it; an engine halt is C-6 | J-0333, J-0390 |
| `TurnSink.progress` | sendOnly, a checkpoint every 16 KiB or 10 s, never deleted | answered (`-> boolean`, kept); skipped while the round's checkpoints staged more than 2 x the text so far (`progressWriteFactor` 3); superseded files deleted; a streamed round ends on a checkpoint of its whole text, which the reply reuses | 1 MiB reply: 34 MB -> 3.8 MB written, 1 file left (J-0313, J-0393) |
| Guest bundles | comments included | comments stripped by `bundle-guest.mjs` (line numbers kept) | session program 198,438 -> 130,061 bytes, exec 92,917 -> 61,035, factory 141,845 -> 93,009 (J-0394) |
| `ContextSource.page` | copied the log's tail per page | reads only its own records (`RecordLog.at`); page bound unchanged (`contextPageBytes`, 512 records) | QC finding 2, J-0392 |
| M1b acceptance 9 "delete" | M1b | M2 (W2.7, acceptance 13): it needs `deleteSession`; `m1b-live` keeps it as a known failure | m1b-interfaces 16.6, J-0309 |
| M1b perf misses (QC findings 11-14) | budgets as listed | **kept**, not re-based; each names the core candidate it depends on, for the PM to rule: `session.create` with the pool (C-2, C-7: 7 serial cranks plus a wake), `concurrency.10` turn start and crank p95 (C-2), `history.page` (C-5, C-7; W2.5 record bound), `context.rebuild` (C-5; J-0322 (b)) | M1b outcome table, J-0396, J-0397 |
| M2 | 7 work units | W2.0 contract step first (folds the M1b tables, adds `blobPage`/`releaseBlobs`/`deleteSession`, record-bounded history pages, heaviest-crank column); the record archive is built in M2 (D-M2-1: W2.5 vat side, W2.8 adapter side; W2.9 integration), so 10 work units | this table, J-9400 |
| Garbage collection in a vat (CORE-11, C-7) | a full collection after every crank (17-126 ms per delivery, growing with the vat) | an allocation schedule: after 131,072 slots or 16 MiB of growth, every 32nd crank, and before the image at close (`THIXOTROPE_GC_POLICY` `allocation`, fixed per state directory); a trivial delivery 0.5-0.6 ms of worker time at any session length; finalizers and their `gc-*` frames leave up to 32 cranks later or in the first crank after a wake | J-9300..J-9307, J-9382 |
| Hub persistence (CORE-12, C-2) | whole-file `hub.json` rewrite, two fsyncs, 9.8-10.7 ms per commit | write-ahead log of deltas (`hub-image.json` + `hub-log.jsonl`, one append per commit, 5.5-6.8 ms); one-way migration; `THIXOTROPE_HUB_STORE=file` keeps the old store | J-9330..J-9337, J-9382 |
| Serve environment and template key | crank budget, attempt bound, slot ceiling | also `THIXOTROPE_GC_*` and `THIXOTROPE_HUB_STORE` pass through `scripts/serve.mjs`; templates key on them when set; perf rows name `gcPolicy` and `hubStore` | J-9380 |
| M1b SIGKILL cases | acceptance 10 checked outcome-unknown and the next exec only; fixed kill points for 8 and 10 | acceptance 10 also checks that the killed exec ran at most once and the provider got the turn once; `EXEC_KILL_DELAY_MS`, `CONTEXT_KILL_DELAYS_MS` (with `POOL_KILL_DELAYS_MS`, `M1A_KILL_DELAYS_MS`) vary the kill point | J-9380 |
| Scripted backend floods | flood text inside the script | `ScriptChunk.keys` / `ScriptToolCall.argsFreshKeys`: the adapter builds the keys; a script crosses the manager vat and must fit one frame (m1b-interfaces 17.6) | J-9381 |
| M1b perf misses after the core changes | `session.create` with the pool, `concurrency.10` turn start and crank p95, `history.page`, `context.rebuild`, `hub.growth` | `session.create` with the pool passes (864 ms, 1.15 x); the others still miss, now each with a measured cause: hub commits (`concurrency.10`, `hub.growth`: C-2's rest), page-crank marshalling (`history.page`, `context.rebuild`: C-5, M2 W2.5, J-0322 (b)) | J-9382, J-9386..J-9399 |
| Record archive (D-M2-1, architecture D-18) | "no archive in M2 unless the numbers say so"; R4-106 256 resident turns, 256-turn chunks | built: 128 kept turns, 32-turn segments, sealed in the settle crank, dropped on the adapter's durable answer; a session's vat, snapshot and hub row are flat from 200 to 5,000 turns | J-0461, J-9404 |
| Long-session fixtures | built by running every turn (2.5 h for 5,000) | `importState` (`perf/_long-session.mjs`): 5,000 tool turns in 11 min; the per-turn window runs with the scripted context digests off (`<logPath>.nodigest`) | J-0485, J-9404 |
| Turn deadline | armed in the turn's first crank (seam 4); the Endpoint dropped the arm | the Endpoint keeps an arm that arrives before the turn's first round and arms it when the round brings the sink | J-0475, J-9401 |
| Catalogue cache key | one owner per Backend presence in a WeakMap | held strongly, at most 64: a collected presence came back as a new object (C-23) | J-9403 |
| `checkpoint.stall`, `history.page`, `throughput`, `disk.session`, the 100 KiB client refusal | budgets as listed | **kept**, not re-based: `checkpoint.stall` fails (one 2-3 s turn per 100), `history.page` misses by 0-11 % at 1,000/5,000 turns (40 records per page would fit, J-0461), `throughput` 29/s at load 8, `disk.session` 41.5 MB for an imported session (C-22), the 100 KiB string reaches the vat | J-9405..J-9408, J-9412 |
| Acceptance 3 at 1,024 rounds; acceptance 6 "abort emitted" | in the 5-minute integration lane; `abort` on cancel | opt-in (about 280 s alone); a cancel ends `end { status: 'cancelled' }` as the event contract says; both for the PM | J-0471, J-0424 |
