# HR-DUP: repeated code and excess code paths in the harness

Unit HR-DUP of the harness architecture review. Scope: `packages/thixotrope-harness` (paths below
are relative to it unless they start with `packages/`), questions 2 (repeated code) and 3 (excess
code paths), across `guest/`, `resources/`, `ui/src/`, `scripts/`, `perf/` and `test/`, measured.
Snapshot: branch `claude/thix-arch` at `bd9a8ec070` (the M3/M4/M5 merge). Read-only: no source,
test or configuration file was changed and no supervisor was started. The glossary of
`core-ontology.md` is used as is; the core findings of `core-duplication.md` are not repeated.

Started 2026-11-18T12:52:56Z; the end time is in journal entry J-9997.

Claims are marked **[read]** (I read the code), **[measured]** (a script counted it) or
**[inferred]**. The scripts (an export-use counter, an import-graph and cycle finder, an
option-use counter, an empty-catch counter, a pair summariser for the finder's output) were
written in a scratch directory outside the repository and are not committed; the duplicate-block
finder is `tools/find-duplicates.mjs`, run unchanged.

A cross-lane integration workflow is changing this tree in another worktree (splitting
`guest/lib/interfaces.js` per vat, sealing secret writes, offering adapter tools to the model).
Findings it may already be fixing say so ("may be in hand").

## Summary

- **The harness source is copy-pasted about five times as much as the core.** 3.9 % of
  normalised source lines sit in a repeated block of 8 or more lines (1,033 of 26,476), against
  0.8 % in the core [measured]. It is concentrated: four pairs of adapter files hold 367 of the
  repeated lines, and each pair is one lane's module copied by a later lane instead of extending
  the earlier one (HR-DUP-1 to HR-DUP-4).
- **Nothing is copied from the core.** No block of 8 lines is shared with `packages/thixotrope/src`
  in literal mode; one 8-line record literal matches in token mode [measured]. The copies from
  sibling packages (`hosted-agent`, `fae`, `floot`, `chat`) are the declared ports of the
  milestone plan (the guest package has no dependencies on purpose).
- **Semantic duplicates are where the risk is.** Thirteen atomic-file writers with four private
  `syncDirectory` copies, five without a directory fsync, beside a core `writeTextAtomic` the
  harness does not use (HR-DUP-5); four fixed-window loops in the perf checks, and sixteen window
  settings that ignore the `PERF_WINDOW_SCALE` knob (HR-DUP-6).
- **The excess paths are milestone scaffolding left standing.** Per-milestone vocabulary tables
  and compatibility views (HR-DUP-7, may be in hand), two library modules only tests import
  (HR-DUP-8), "not built yet" branches whose parts are all built (HR-DUP-12), and a pre-projection
  transcript fallback that production never takes (HR-DUP-14).
- **Several things should be kept** (section 3): one AES-GCM seal, one retry module, environment
  reads centralised in `scripts/serve.mjs`, no TODO or FIXME in source, every empty `catch`
  commented, and test skips that are all environment gates.
- 16 findings: 0 major, 8 moderate, 8 minor.

## 1. Numbers

### 1.1 Size

Raw lines of `.js`/`.mjs` files [measured].

| Area | Files | Lines |
| --- | ---: | ---: |
| `guest/` | 71 | 20,085 |
| `resources/` | 68 | 25,094 |
| `ui/src/` | 52 | 8,872 |
| `scripts/` | 15 | 5,855 |
| `perf/` | 46 | 13,306 |
| `test/` | 243 | 80,562 |

### 1.2 Duplicate-block finder

`tools/find-duplicates.mjs`, unchanged: comments, imports and lone braces dropped, windows of 8
normalised lines hashed and extended to maximal blocks. Token mode (`--ids`) replaces names and
literals, so renamed copies match. Cross mode (`A -- B`) keeps only clusters that touch both sets.

| Run | Files | Normalised lines | Lines in a repeated block | Share | Clusters |
| --- | ---: | ---: | ---: | ---: | ---: |
| `guest` + `resources` + `ui/src`, literal | 191 | 26,476 | 1,033 | 3.9 % | 45 |
| `guest` + `resources` + `ui/src`, token mode | 191 | 23,019 | 1,295 | 5.6 % | 59 |
| `scripts` + `perf`, literal | 61 | 11,168 | 227 | 2.0 % | 12 |
| `scripts` + `perf`, token mode | 61 | 9,329 | 315 | 3.4 % | 16 |
| `test`, literal | 243 | 49,877 | 1,599 | 3.2 % | 66 |
| `test`, token mode | 243 | 42,024 | 2,281 | 5.4 % | 109 |
| harness source against `packages/thixotrope/src`, literal | 307 | 39,792 | 0 | 0 % | 0 |
| harness source against `packages/thixotrope/src`, token mode | 307 | 34,689 | 44 | — | 1 (an 8-line record literal; not real) |
| harness source against 23 sibling packages, literal | 525 | 74,037 | 724 | — | 17 |
| harness source against 23 sibling packages, token mode | 525 | 64,016 | 921 | — | 25 |

The 23 sibling packages: `agent-tools`, `cache-map`, `chat`, `claude-sandbox`, `codex-sandbox`,
`conversation-tree`, `errors`, `fae`, `familiar`, `floot`, `gateway`, `hosted-agent`, `inference`,
`is-well-formed-string`, `jsonl-transcript`, `lal`, `markmdown`, `netstring`, `promise-kit`,
`pubsub`, `sha256`, `stream`, `utf8` (their `src`, or top-level files where there is none).

### 1.3 Where the source repetition is (literal mode, repeated lines by file set)

| Repeated lines | Files | Lanes | Finding |
| ---: | --- | --- | --- |
| 122 | `AH/providers/catalog.js` + `AH/subscriptions/catalog.js` | M2 W2.2, M4 W4.3 | HR-DUP-1 |
| 104 | `AH/providers/round.js` + `AH/providers/scripted.js` | M2 W2.1a, M1a W1a.2 | HR-DUP-2 |
| 81 (+24 with `subscriptions/provider.js`) | `AH/providers/anthropic.js` + `AH/providers/openrouter.js` | M2 W2.1a/b, M4 | HR-DUP-3 |
| 60 | `AH/channels.js` + `AH/list-channel.js` | M1a W1a.3, M1b W1b.5 | HR-DUP-4 |
| 47 | `guest/lib/interfaces{,-m3,-m4,-m5}.js` | M1a..M5 | HR-DUP-7 |
| 22 | `guest/lib/bounded.js` + `ui/src/presets/size.js` | M1a, M5 W5.8 | HR-DUP-10 |
| 20 (29 token) | `AH/providers/anthropic.js` + `AH/subscriptions/responses.js` | M2, M4 | HR-DUP-3 |
| 12 | `ui/src/sessions/Sidebar.js` + `ui/src/shell/App.js` | M3 | — (a shared `aside` element tree) |
| 10 (23 token) | `AH/subscriptions/account-tool.js` + `AH/tools/echo.js` | M4, M1a | — (tool skeleton; small) |
| 9 | `guest/session/tools/inspection.js` + `tools/objects.js` | M5 | HR-DUP-16 |
| 8 | `ui/src/mentions/mentions.js` + `ui/src/presets/editor.js` | M5 W5.8 | HR-DUP-11 |

`AH` is `resources/agent-host/impl`. The top four pairs hold 367 of the 1,033 repeated lines.

### 1.4 Semantic duplicates (what a text finder misses)

| Kind | Implementations [read] | Should be one, where |
| --- | --- | --- |
| Atomic write (temp, fsync, rename, directory fsync) | 13: `AH/archive/store.js:195`, `AH/archive/context-file.js:76,105`, `AH/archive/mirror.js:56`, `AH/archive/segment.js:241`, `AH/secrets/store.js:360` (audit, sync), `:474` (entries), `AH/subscriptions/account-file.js:192`, `AH/blobs.js:356`, `AH/gateway/signin.js:149`, `scripts/run-lock.mjs:384`, `scripts/serve.mjs:326`, `scripts/bundle-guest.mjs:422`; `syncDirectory` written 4 times (`segment.js:78` exported, `secrets/store.js:254`, `blobs.js:165`, `gateway/signin.js:54`) | the core's `writeTextAtomic` contract (unique scratch, `wx`, directory fsync) as one adapter helper (HR-DUP-5) |
| AES-GCM seal and open | 1: `AH/secrets/store.js:227,241` (`encrypt`, `decrypt`), reused by `secrets/seal.js` and `gateway/signin.js` | already one; keep |
| Page with cursor | about 12 page producers, each with its own cursor text: `p<n>` (`guest/session/context-source.js:67`), `p<i>.<k>` (`guest/session/export.js:132`), `h<n>`/`c<n>` (`guest/session/history.js:189,251`, `AH/archive/history.js:442,530`), `s<n>` (`guest/session/archive.js:268`), `i<n>` (`guest/factory/inventory.js:41`), bare positions (`resources/agent-host/durable-subscriptions.js:281,589`), serials (`durable.js:455`), catalogue `pageOf` twice; 2 identical UI all-pages readers | a `guest/lib/page.js` with position cursors (HR-DUP-11) |
| Bounded read of a body or stream | 5: `boundedChunks` (`AH/providers/http.js:70`) and four bounded JSON readers that do not use it (`providers/catalog.js:178`, `subscriptions/catalog.js:136`, `subscriptions/accounts.js:1013`, `subscriptions/renewal.js:~115`) | `boundedJson` in `http.js` over `boundedChunks` (HR-DUP-9) |
| Retry with backoff | 1 for provider rounds (`AH/providers/retry.js`, used by `anthropic.js`, `openrouter.js`, `subscriptions/wire.js`); the pool's member backoff (`subscriptions/pool.js:255`) is a different thing (a strike mark, not a retry) | already one; keep |
| Single-flight | 3: the two catalogue owners (`providers/catalog.js:481`, `subscriptions/catalog.js:392`, copies) and renewal (`subscriptions/renewal.js:407`) | the catalogue owner once (HR-DUP-1) |
| LRU or bounded cache | 8 insertion-order `Map` evictions written inline (`guest/session/turn.js:1522`, `guest/session/archive.js:249`, `AH/archive/store.js:428`, `AH/archive/history.js:148,208,245`, `AH/context-cache.js:188`, `durable-subscriptions.js:526`) plus 2 catalogue owner maps; `@endo/cache-map` unused (the guest may not import it; the adapter may) | minor (HR-DUP-16) |
| Watch or subscription feed | 3: session channel (`AH/channels.js`), list channel (`AH/list-channel.js`, a copy of the first's subscriber and reorder code), accounts watch (`AH/subscriptions/accounts.js:367`, latest-value; a different model, rightly) | channels share one subscriber and one reorder buffer (HR-DUP-4) |
| Fits-in-frame checks and size cuts | `fitsFrame`/`messageBytes` in `guest/lib/bounded.js` (one home, used by adapters); a browser copy in `ui/src/presets/size.js`; a surrogate-safe cut written 4 times (`bounded.js:30`, `providers/catalog.js:104` `cutUnits`, `channels.js:190` `cutUnits`, `round.js:216` `deltaPieces`) | `bounded.js` (HR-DUP-10, HR-DUP-16) |
| Rights amplification by WeakMap | 46 `new WeakMap` in 27 files, one idiom (presence to record) | already consistent; keep |
| Idempotent create by label | 2 (`durable-subscriptions.js:238` `makeMember`, `:418` `makePool`), each a linear scan with the same refuse-on-conflict rule | fine at two |
| Kill-point test hooks | 2 styles: injected `trace(step)` (`archive/store.js`, `archive/segment.js`, `blobs.js`) and a `hooks` record (`gateway/signin.js:89`); none read the environment | fine; keep injected |
| Fixed-window measurement loops | 4: `perf/_window.mjs:49` `runWindow`, `perf/_m4.mjs:46` `inWindow`, `perf/_m3-client.mjs:217` `measureWindow`, `perf/_long-session.mjs:266` `overWindow` | `runWindow` (HR-DUP-6) |
| Median/quantile | 9 in `perf/` (`_harness.mjs:120` `summarize`, `_hub.mjs:331`, `_crank.mjs:159`, `_long-session.mjs:244`, `crash.perf.mjs:223`, `gc.perf.mjs:85`, `import.perf.mjs:63`, `subscriptions-lifecycle.perf.mjs:61`, `turn.perf.mjs:91`, `provider.perf.mjs:531`), 5 more in `test/` | `summarize` (HR-DUP-6) |

### 1.5 Excess paths

| Measure | Count | Notes |
| --- | ---: | --- |
| Exported names in source (`guest`, `resources`, `ui/src`, `scripts`) | 815 | [measured] |
| … imported by no other file (source, test or perf) | 126 | mostly constants exported for documentation; 5 are used nowhere at all (HR-DUP-13) |
| … imported only by tests | 168 | 19 outside `scripts/` are not used in their own module either (test-only API) |
| Source modules imported by no source module | 28 | 24 are entry points (vat `main.js`, `durable.js`, UI `feature.js`/`index.js`, scripts); 2 library modules are test-only (HR-DUP-8) |
| Import cycles in source | 9 | 7 in `guest/session/tool-table.js` and its tools, 1 `factory/pool.js`↔`root.js`, 1 `archive/history.js`↔`store.js` (question 1; reported for the area units) |
| Options of exported makers that no source caller passes | 56 | most are injected clocks and limits for tests (good); 17 are passed by nobody, tests included (HR-DUP-13) |
| Environment variables read in source | 22 distinct | all in `scripts/serve.mjs` (allowlist at `:82-105`), `scripts/run-lock.mjs`, `scripts/process-time.mjs` and the secrets key name (`AH/secrets/store.js:70`) |
| Environment variables read in `perf/` | 76 distinct | 42 named in no Markdown file (HR-DUP-6) |
| `textOf.notBuilt` / `NOT_YET` sites in source | 17 | 11 in guest tools and session, 5 in adapter forwarding; reasons mostly gone (HR-DUP-12) |
| `test.skip` | 66 | every one an environment gate (`integrationEnabled`, `spikeEnabled`, a missing binary) |
| `test.failing` | 1 | `test/integration/m2-probes.test.js:140`; reason still holds [inferred] |
| TODO / FIXME / HACK in source | 0 | 8 TODO in tests and perf |
| Empty `catch` blocks in source | 50 | all 50 carry a comment saying why [measured] |
| `.catch(() => {})` in source | 54 | 12 in `AH/blobs.js`; cleanup of temp files and readers |
| Compatibility views | `m1bInterfaces` (13 source files), `m1bShapes` (7), `m1bMethodNames` (1), `m2Interfaces` (11), `m2MethodNames` (4) | HR-DUP-7 |
| Hook tables with no entry | 4 | `AH/channel-taps.js:21`, `AH/projection-hooks.js:24`, `turnHooks.beforeRound` and `turnHooks.turnSources` (`guest/session/turn-hooks.js:39-52`) |

---

## 2. Findings

Severity order. Size is lines touched and files; risk names what could break and what covers it.

### HR-DUP-1 (moderate, Q2): the pool catalogue is a copy of the model catalogue

**Where.** `AH/subscriptions/catalog.js:119-163` (`tokenCount`, `boundedJson`), `:376-436`
(`makeMemberOwner`), `:577-615` (owner map with eviction), `:664-712` (`pageOf`), `:741-758` (row
fields); the originals at `AH/providers/catalog.js:144-205`, `:461-560`, `:576-615`, `:626-676`,
`:702-721`.

**Evidence.** 122 repeated lines in literal mode, 134 in token mode [measured]. `pageOf` is
identical except two comments (`diff` of `providers/catalog.js:626-676` and
`subscriptions/catalog.js:664-712`) [read]. `makeMemberOwner` is `makeOwner` minus the key read and
the failure log line; the freshness rules (`CATALOG_FRESH_MS`, `CATALOG_MAX_AGE_MS`,
`CATALOG_RETRY_MS`), single-flight, `snapshot` and `admitting` are the same code [read]. The M4
module already imports five names from the M2 one (`subscriptions/catalog.js:61-69`), so the
dependency exists; the lane copied what was not exported. Its header says "the same request and
answer shapes as M2's `makeCatalog`" and "cached ... with M2's timing (R4-104)".

**Fix.** Export from `providers/catalog.js` (or a new `catalog-core.js`): `makeOwner({ read, now,
log? })` with the key read moved into the M2 caller's `read`, `pageOf`, `boundedJson` (see
HR-DUP-9), `tokenCount` and the owner map. The pool catalogue keeps only its readers
(`readClaudeModels`, `readCodexModels`) and its combination rules (R4-18, R4-19).

**Size.** About 150 lines removed, 30 changed; 2 files. **Risk.** Low: both catalogues have
adapter tests with a fake server (`test/adapter/m2-w22-catalog.test.js`, the M4 pool catalogue
tests); the R4-104 timing tests cover the owner. The M2 owner logs `catalog-failed` once per
message; the shared owner must keep that optional so the pool's silence is unchanged.

### HR-DUP-2 (moderate, Q2, Q1): two round engines; production providers import the fake

**Where.** `AH/providers/scripted.js:380-747` (`runRound`, `stageRound`) against
`AH/providers/round.js:247-682` (`runProviderRound`, `stageResult`); a private copy of
`makeRoundControl` (`scripted.js:232`, `round.js:94`). Imports the wrong way:
`anthropic.js:102`, `openrouter.js:82` and `subscriptions/provider.js:51` take `makeEventLog` from
`scripted.js`; `round.js:61` takes `tailText` from it.

**Evidence.** 104 repeated lines literal, 102 token [measured]: staging of reply text and
partials, progress checkpoints (`checkpointBytes`, `fresh = textBytes - checkpointBytes`), the
failure builder, the frame-limit cut, `kept`/`build` of the result [read]. `round.js`'s header
says it is "one implementation of what every API provider does around its request ... as the
scripted provider does"; the scripted provider (M1a, extended in M1b and M2) was never moved onto
it. The two `makeRoundControl` differ only in `harden` versus `Object.freeze` and an
`AbortController` [read]. Most integration tests run scripted backends, so the round path the
daemon tests prove is the fake's; the shared round is proven by adapter tests with the fake HTTP
server [inferred from the test layout].

**Fix.** (a) Move `makeEventLog`, `tailText` and the `EventLog` type to
`AH/providers/event-log.js`; (b) make the scripted provider a `stream` generator for
`runProviderRound` (text chunks and delays as `{ delta }`, calls, usage, a scripted error as a
thrown `ProviderFailure`, a stall as an await on `signal`), keeping its `context` log line and
`times` rounds in the scripted module.

**Size.** (a) 40 lines, 6 files; (b) about 300 lines removed from `scripted.js`, 4 files.
**Risk.** (a) none. (b) moderate: the scripted provider is the backend of nearly every
integration test and the perf checks; its `context` digest line (W1b.2, W2.9) and progress
cadence must stay byte-identical. Covered by `test/adapter/m1b-blobs-provider.test.js`, the M1a
channel tests, and every integration file.

### HR-DUP-3 (moderate, Q2): the API provider wrapper is written three times

**Where.** `AH/providers/anthropic.js:744-861`, `AH/providers/openrouter.js:565-685`,
`AH/subscriptions/provider.js:~110-335`.

**Evidence.** 81 lines repeated between the first two, 24 more shared by all three, 94 in token
mode [measured]; `diff` of `anthropic.js:800-862` against `openrouter.js:623-685` differs only in
the body builder, the delay rule, the URL path and the unreachable text [read]. Each defines the
`running` map, `startRound` (stop the previous round, make a control, call `runProviderRound`,
delete in `finally`), `cancelRound`, `releaseTurn`, and the `makeRetry` wiring with the same
`onRetry` log record. A fix to the release rule (for example J-9361's dropped staged file) has
three places to land.

**Fix.** `makeApiProvider({ label, unreachable, timers, blobs, log, now, retry, attempt })` in
`round.js`, where `attempt({ req, projection, system, key, signal })` is the only per-provider
part. The `*Kind` records stay per provider.

**Size.** About 120 lines removed, 4 files. **Risk.** Low to moderate: covered by
`test/adapter/m2-w21a-openrouter.test.js`, `_m2-w21b-round.js`, the M4 wire tests
(`m4-wire-claude`, `m4-wire-codex`); the pool provider's per-round member choice must stay inside
its `attempt`.

### HR-DUP-4 (moderate, Q2, Q4): the list channel is a copy of the session channel

**Where.** `AH/list-channel.js:80-170` (`makeListSubscriber`), `:203-309` (`deliver`, `drain`,
`declareGap`, `armWait`, `enforceWindow`, `slowest`) against `AH/channels.js:237-345`,
`:442-607`.

**Evidence.** 60 repeated lines [measured]; the subscriber factories differ in names, the guard,
and how a close reason is held: the session channel stores a `closeReasons` **key** and maps it
when closing (`channels.js:268-282`), the list channel stores the reason **text**
(`list-channel.js:111-124`) [read]. Its header says "Numbering and order, as the session channel".
The rev reorder rules (window, backlog, wait, gap) are the same code twice.

**Fix.** `AH/channel-core.js` with `makeSubscriber({ guard, queueLimit, queueBytes, onClose })`
and `makeReorderBuffer({ limits, schedule, onBatch, onGap })`; both channels use them. Pick one
close-reason model (the keyed one).

**Size.** About 150 lines removed, 3 files. **Risk.** Low: `test/adapter/m1a-channels.test.js`,
`m1a-channel-bounds.test.js` and `m1b-pool-list-channel.test.js` pin the bounds and gaps.

### HR-DUP-5 (moderate, Q2, Q5): thirteen atomic writers, four `syncDirectory`, uneven durability

**Where.** Table in 1.4. **Evidence [read].** The core already defines the contract and its Node
implementation: `packages/thixotrope/src/platform/files.js` `writeTextAtomic` and
`src/platform/node/files.js:104-123` (a per-call scratch name created with `wx`, fsync, rename,
directory fsync, scratch removed in `finally`). The harness writes its own each time. Differences
that matter:

- **No directory fsync** after the rename in `archive/store.js:195` (`writeDurably`, the archive
  manifest), `archive/context-file.js:76` and `:105`, `secrets/store.js:360-370` (audit
  compaction), `scripts/run-lock.mjs:384` and `scripts/serve.mjs:326`. `archive/mirror.js` has
  none by design (it says so). A rename not yet on disk is lost by power loss, not by SIGKILL, so
  the SIGKILL tests cannot see it [inferred].
- **Fixed scratch names** (`<path>.tmp`) everywhere except `run-lock` (`wx`): two concurrent
  writers to one path would share the scratch file. The writers are serialised today (one
  persist at a time in `secrets/store.js`, one manifest writer per session) [inferred].
- Four private copies of `syncDirectory` (`segment.js:78` exported but not reused by
  `secrets/store.js:254`, `blobs.js:165`, `gateway/signin.js:54`); `account-file.js:192` inlines a
  fifth that tolerates refusal.

The integration lane's "sealing secret writes" may touch `secrets/store.js` and `signin.js`.

**Fix.** One `AH/files.js` `writeFileAtomic(path, data, { mode })` and `syncDirectory(path)`
following the core's Node implementation (or the core's `makeNodePowers().files` passed into the
adapter), used by every writer above; the `trace`/`hooks` kill points become arguments of it.

**Size.** About 200 lines removed, 12 files. **Risk.** Moderate: the kill-point tests
(`test/adapter/m2-archive-*`, the blob and sign-in K-tests) assert the order of `fsync`,
`rename`, `fsync-dir` steps; keep the step names.

### HR-DUP-6 (moderate, Q2, Q3): perf windows are written four times and ignore the scale knob

**Where.** `perf/_window.mjs:49` (`runWindow`), `perf/_m4.mjs:46` (`inWindow`),
`perf/_m3-client.mjs:217` (`measureWindow`), `perf/_long-session.mjs:266` (`overWindow`); window
lengths read with `Number(process.env.X ?? n)` in `archive.perf.mjs:49-50`,
`creation-m5.perf.mjs:57-58`, `history.perf.mjs:48`, `history.restart.perf.mjs:36`,
`import.perf.mjs:54`, `journal.perf.mjs:66`, `mentions.perf.mjs:30`, `presets.perf.mjs:41`,
`provider.perf.mjs:78`, `queue.perf.mjs:52`, `tools.perf.mjs:50`, `_m4.mjs:34`,
`_m3-client.mjs:193`.

**Evidence.** `_window.mjs` (the process.md section 3 rule) is used by 13 of 37 perf files; the
four loops differ only in whether a window holds at least one sample and whether it records
results [read]. `windowMs()` multiplies by `PERF_WINDOW_SCALE` (`_window.mjs:30-31`); the 16
settings above bypass it, so a "quick smoke at 0.25" still runs those windows at full length
[read]. Nine median or quantile helpers beside `_harness.mjs:120` `summarize` [measured]. Of 76
environment variables the perf files read, 42 are named in no Markdown file [measured]. This
touches the owner's "no hours-long tests" rule: the scale knob is the time box, and it does not
reach the M3, M4 and M5 checks.

**Fix.** Every window through `windowMs(name, fallback)` and `runWindow`; `_m4.inWindow`,
`_m3-client.measureWindow`, `_long-session.overWindow` become calls of it; medians through
`summarize`; one table of perf variables in `perf/README.md` (or the file headers).

**Size.** About 120 lines, 18 files. **Risk.** Low: `test/perf-harness.test.js` covers
`_window.mjs`; row names must not change (the perf history compares them).

### HR-DUP-7 (moderate, Q3, Q4; may be in hand): vocabulary is kept per milestone

**Where.** `guest/lib/interfaces.js`, `interfaces-m3.js`, `interfaces-m4.js`, `interfaces-m5.js`,
`interfaces-m5-factory.js`, `limits.js`, `limits-m4.js`, `limits-m5.js`, `texts-m4.js`.

**Evidence [measured unless marked].** Seven interface tables (`interfaces`, `m1bInterfaces`,
`m2Interfaces`, `m3Interfaces`, `m4Interfaces`, `m5Interfaces`, `m5FactoryInterfaces`), six shape
tables, five text tables of which three modules export the same name `texts` (`interfaces.js:148`,
`interfaces-m5.js:182`, `interfaces-m5-factory.js:85`), four limit tables named two ways
(`m3Limits`, `m4Limits`, but `limitsM5`). `lazyTable` is written in `interfaces.js:101`,
`interfaces-m3.js:73`, `interfaces-m4.js:65` and exported only from `interfaces-m5.js:73`;
`interfaces-m4.js:34` says "the same helpers as interfaces.js (not exported there; kept equal)".
The compatibility views `m1bShapes`/`m1bInterfaces` (`interfaces.js:2612-2621`, "for modules
written against them before the fold") are still read by 7 and 13 source files; `m2Interfaces` by
11. Interfaces grow by four mechanisms: fold (`interfaces.js`), `extendInterface`
(`interfaces-m5.js:103`), `withGatewayAdmin` (`interfaces-m3.js:314`) and the `m5Widenings` /
`m5Extensions` tables [read]. In tests, the `pathsOf` walker and its checks are copied into all
six `test/unit/m*-interfaces.test.js` (about 300 repeated lines). The integration workflow is
splitting `interfaces.js` per vat; this finding is input to that work, not a separate change.

**Fix.** When splitting per vat: one table per vat (not per milestone), one `lazyTable` exported
from a helpers module, `texts`/`limits` as pure-data modules (see HR-DUP-10), the `m1b*` and
`m2*` views replaced by the vat table in their importers, and one shared `pathsOf` in a test
helper.

**Size.** Large (the split itself). **Risk.** Guard identity matters (the views are the same
objects, so importers can move one at a time); session program bytes (J-9933: 1.4 % margin) are
the binding constraint and favour the split.

### HR-DUP-8 (moderate, Q3, Q4): two library modules are imported only by tests

**Where.** `guest/lib/transcript-records.js` (330 lines; `assertTranscriptRecord`,
`encodeTranscript`, `parseTranscript`, `pairToolCalls`) and `guest/lib/journal-usage.js` (92
lines; `makeUsageTally`, `usageOfRecords`).

**Evidence.** No source module imports either; 3 test files import each [measured]. 138 lines of
`transcript-records.js` are a copy of `packages/hosted-agent/src/transcript-records.js`
[measured]. `AH/projection.js:8` says its output is "transcript records
(`guest/lib/transcript-records.js`, the stack's own format ...)", but it never imports or checks
against that module [read]. `journal-usage.js` says `usageOfRecords(all records)` "equals what
`Session.getUsage()` answers"; the session computes usage with its own `addUsage` in
`guest/session/turn.js`, and the M2 contract row says export and import use it, which they do not
[read]. A test proving two implementations agree is kept for code that production never runs.

**Fix.** Either wire them (the projection asserts its output with `assertTranscriptRecord` in a
debug check; export/import totals through `usageOfRecords`) or delete both modules and their
tests and change the projection's comment to describe the record kinds itself.

**Size.** Delete: about 420 lines and 3 to 6 test files. **Risk.** Low; the decision is whether
the format module is a contract the providers translate from (then wire it) or documentation.

### HR-DUP-9 (minor, Q2): four bounded JSON readers beside an unused bounded-chunks primitive

**Where.** `AH/providers/catalog.js:178`, `AH/subscriptions/catalog.js:136`,
`AH/subscriptions/accounts.js:1013`, `AH/subscriptions/renewal.js:~115`; primitive
`AH/providers/http.js:70` (`boundedChunks`).

**Evidence [read].** Each collects chunks, counts bytes, cancels the body over the bound, decodes
fatal UTF-8 and parses JSON; they differ only in the error each throws. `renewal.js` uses a
`reader` loop and its own concatenation.

**Fix.** `readBoundedJson(response, maxBytes, fail)` in `http.js` over `boundedChunks`.
**Size.** About 70 lines, 5 files. **Risk.** Low; each caller's error class stays its own through
`fail`.

### HR-DUP-10 (minor, Q2, Q4): two conventions for giving the browser contract values

**Where.** M4 UI imports guest pure-data modules: `ui/src/secrets/values.js:18-19`,
`ui/src/accounts/feed.js:24`, `ui/src/accounts/labels.js:12` (`texts-m4.js`, `limits-m4.js`). M5
UI copies them: `ui/src/presets/texts.js`, `ui/src/mentions/texts.js`, `ui/src/presets/size.js`
(a 22-line copy of `fitsFrame`'s walk, `bounded.js:79-113`), each checked equal by
`test/unit/m5-w58-copies.test.js`.

**Evidence [read].** The M5 files say "the bundle cannot import the guest modules (they need the
vat prelude)"; that is true of `interfaces-m5-factory.js` (it reads `M` from `globalThis`) but not
of a data-only module, as M4 shows.

**Fix.** Put M5's browser-facing texts and limits in data-only modules (as `texts-m4.js`) and
import them; keep the copy only for `fitsFrame`, or make `bounded.js`'s walk take `passStyleOf`
as an argument. Fits the per-vat split (HR-DUP-7).

**Size.** About 80 lines, 5 files. **Risk.** Low: the UI build tests (`m3-ui-build`,
`m4-ui-build`) show whether a module pulls in the prelude.

### HR-DUP-11 (minor, Q2, Q5): every page has its own cursor

**Where.** Table in 1.4; UI readers `ui/src/mentions/mentions.js:309-326` and
`ui/src/presets/editor.js:156-172` (identical all-pages loops, same lane).

**Evidence [read].** About twelve page producers, eight cursor spellings, each with its own parse
and refusal text. Two use bare positions over lists that shrink: `durable-subscriptions.js:281`
(`members`) and `:589` (`entries`); `memberList` is filtered on retire, so a member retired between
two page reads shifts the next page by one and one row is skipped [inferred].

**Fix.** `guest/lib/page.js`: `pageAt(items, cursor, limit, prefix)` and `parseCursor(prefix,
cursor)`; one `readAllPages(list, maxPages)` in the UI. For shrinking lists, a cursor naming the
last key given (as `durable.js:455` does with serials) instead of a position.

**Size.** About 100 lines, 10 files. **Risk.** Cursor strings are opaque to clients but stored by
none, so changing their spelling is safe; refusal texts are pinned by tests.

### HR-DUP-12 (minor, Q3, Q5): "not built yet" branches for parts that are built

**Where.** `guest/session/session.js:271-284` (`enqueueMessageOnce`, `grants`),
`guest/session/tools/objects.js:158,194,205`, `tools/inspection.js:148`,
`tools/mentions.js:135,177`, `guest/session/prompt.js:97`, `AH/index.js:214`,
`AH/attach.js:199,210`, `AH/subscriptions/credential-ops.js:76`; `NOT_YET` in
`guest/factory/session-options.js:32`.

**Evidence [read].** `guest/session/m5-parts.js` registers all four parts (`powers`,
`inspector`, `grants`, `packages`) and `makeSession` defaults `parts = m5Parts`; no source caller
passes another value (`session.js:78`), so `runtime.labels`, `runtime.grants` and
`runtime.packages` are never undefined in a vat; only tests passing `parts: []` reach the
branches (`test/unit/m5-w53-session.test.js:418`). The `session.js` header (lines 21-24) still
says these "throw `textOf.notBuilt` until W5.6 and W5.7 register", which contradicts the table.
`NOT_YET = ['networkPolicy']` still holds (sandboxing is M6), but presets now carry a
`networkPolicy` (`guest/lib/preset-catalog.js:235`), so the setting arrives one way (preset,
accepted) and is refused the other (`createSession` option); that is intended but not stated.

**Fix.** Drop the `notBuilt` branches whose parts are always made (the getter can assert), update
the header, and say beside `NOT_YET` that a preset's `networkPolicy` is stored and not enforced
until M6. Keep the adapter forwarding `notBuilt` (it guards a real race at start).

**Size.** About 40 lines, 7 files. **Risk.** Low; the tests that pass `parts: []` to reach these
branches go too.

### HR-DUP-13 (minor, Q3): dead exports, never-passed options, empty hook tables

**Evidence [measured].** Used nowhere, not even in their own module: `templateObjectKinds`
(`guest/lib/interfaces-m5-factory.js:74`), `resetContextFile` (`AH/archive/context-file.js:76`),
`removeMirror` (`AH/archive/mirror.js:119`), `networkPolicies` (`ui/src/presets/texts.js:24`),
`defaultLockPath` (`scripts/run-lock.mjs:128`, computed at import time). Test-only API used nowhere
in its own module: `estimateBytes` (`guest/lib/bounded.js`), `assertNoActiveTurn`
(`guest/session/queue.js`), `checkCall` (`AH/gateway/guard.js`), `collectRecordKeys`
(`AH/gateway/vocabulary.js`), `featuresFor` (`ui/src/features.js`), and the six
`m*MethodNames` lists. Options no caller passes, tests included: `makeContextCache.readsInFlight`,
`makeGatewayService.{extensionsDir, assetsDir, guestLibDir, now, serverLimits}`,
`makeSignInLimiter.penaltyMs`, `makeRetry.maxTimeoutRetries`, `makeUsageReader.timeoutMs`,
`makePoolCatalog.clientVersion`, `makeSubscriptions.endpoints`, `makeConnection.deadlineMs`,
`exportState.recordsPerLine`, `makeAgentHostImpl.channels`, `makeDeletions.hooks`,
`makeContextSource.boundary`, `readOpenRouterModels`/`readAnthropicModels.timeoutMs` (heuristic:
the option name appears in no file that names the maker). Empty hook tables waiting for M8/M9:
`channelTaps`, `projectionHooks`, `turnHooks.beforeRound`, `turnHooks.turnSources`.

**Fix.** Delete the five dead exports; unexport test-only helpers or move them to test helpers;
drop never-passed options whose default is the only value. Keep the empty hook tables (they are
the milestone plan's seams and cost a loop each) but list them in one place.

**Size.** About 60 lines, 20 files. **Risk.** Low; `tsc` finds every broken reference.

### HR-DUP-14 (minor, Q3): a pre-projection transcript fallback production never takes

**Where.** `AH/providers/anthropic.js:790-801`, `AH/providers/openrouter.js:613-622`
(`projection?.transcript ?? req.append.filter(...)`), `AH/subscriptions/messages.js:212`,
`responses.js:451` (`projection?.transcript ?? []`).

**Evidence [read].** `AH/index.js:283` always gives the endpoint a `prepare`, and
`AH/endpoint.js:125` always hands it to the provider; the fallback serves M1a-style tests that
call `startRound` without one (`endpoint.js:27` says so). In the pool path the fallback is an
empty transcript, so a missing projection would send a request with no messages instead of
failing.

**Fix.** Make `prepare` required for API providers and fail the round with `stagingFailed` when
there is no projection; tests pass a trivial `prepare`.

**Size.** About 30 lines, 4 files plus tests. **Risk.** Low.

### HR-DUP-15 (minor, Q2): test fixtures are re-written per lane

**Evidence [measured].** `test/fixtures/fake-subscription-server.mjs:388-604` repeats the plan
and serve loop of `fake-provider-server.mjs:447-662` (an 83-line literal block, 114 repeated
lines; its header says "as M2's `fake-provider-server.mjs` does"); `fake-oauth-server.mjs` is a
third server. 41 test files define their own `drain`/`settle`/`waitFor`/`until`; 26 call
`mkdtemp` themselves although `test/_helpers.js` `scratch` exists (15 files use it). `useKeyFile`
is written twice (`test/integration/_m4.js:100`, `perf/_m4.mjs:62`). Test literal duplication is
3.2 %, lower than the source's 3.9 %.

**Fix.** A `startPlannedServer({ routes, onRequest })` used by the three fakes; `waitFor` and
`drain` in `test/_helpers.js`; one `useKeyFile` shared by `test/` and `perf/`.

**Size.** About 250 lines, 50 files (mechanical). **Risk.** Low.

### HR-DUP-16 (minor, Q2): small helpers written several times

**Evidence [read].** A surrogate-safe cut in four places (`guest/lib/bounded.js:30` and its
`cutText`, `AH/providers/catalog.js:104` `cutUnits`, `AH/channels.js:190` `cutUnits`,
`AH/providers/round.js:216` `deltaPieces`); the adapter modules already import `bounded.js`.
Tool outcome helpers `ok`/`failed` in five guest tool modules and `readArgs` twice
(`guest/session/tools/inspection.js:125`, `objects.js:125`). The insertion-order LRU eviction
inline eight times (1.4).

**Fix.** `cutUnits` from `bounded.js`; `ok`/`failed`/`readArgs` in `guest/lib/tool-args.js`; a
two-line `touch`/`evictOldest` pair in `bounded.js` (the guest cannot use `@endo/cache-map`).

**Size.** About 60 lines, 12 files. **Risk.** Low; guest program bytes go down.

## 3. What is good and should be kept

- **No copy from the core** (0 literal lines; 2.0 % in scripts and perf) and **one AES-GCM**
  implementation (`AH/secrets/store.js:227-252`) reused by the sealed box and the sign-in file
  [measured, read].
- **One retry module** for provider rounds (`AH/providers/retry.js`), used by both API providers
  and the subscription wire client [read].
- **Environment reads are centralised** in source: `scripts/serve.mjs:82-105` is an allowlist of
  what reaches the supervisor, and the run lock reads its own three; no adapter or guest module
  reads `process.env` [measured].
- **No TODO, FIXME or HACK in source**, and **every empty `catch` says why** (50 of 50) [measured].
- **Kill points are injected** (`trace`, `hooks`), never switched by environment variables, so a
  production start cannot enable them [read].
- **Test skips are honest**: all 66 are environment gates, and the one `test.failing` carries its
  reason and journal reference [read].
- **WeakMap rights amplification is one idiom** across 46 sites [measured].
- **The deliberate copies are guarded**: `limits` shared between `config/defaults.js` and
  `guest/lib/limits.js` (6 names) and the M5 browser copies each have an equality test [read];
  the finding (HR-DUP-10) is about removing the need, not about drift.

## 4. Not covered

- Question 1 (layering) beyond what the duplication showed; the 9 import cycles are listed but not
  analysed.
- Correctness of the copied logic (whether the two catalogue owners, or the two round engines,
  agree in every edge); only their text and structure were compared.
- `test/` beyond fixtures and helpers: whether each test tests what it names was not checked.
- The UI's component code beyond the clusters the finder reported.
- The option and export counts are regex heuristics (a name used under another spelling, or
  through a namespace import in `AH/gateway/vocabulary.js` and five tests, is missed).
