# AR-DUP: repeated code and excess code paths in the Thixotrope core

Unit AR-DUP of the architecture review. Scope: `packages/thixotrope` (written `pkg/` below), the
JavaScript side only; questions 2 (repeated code) and 3 (excess code paths) across the whole
package, measured. Snapshot: branch `claude/thix-arch` at `3f67a8e505`. Read-only: no source,
test or configuration file was changed and no supervisor was started.

Started 2026-11-18T12:07:18Z; ended at the time recorded in J-9967.

Claims are marked **[read]** (I read the code), **[measured]** (a script counted it) or
**[inferred]**. The sibling reports `core-daemon.md` (AR-CORE) and `core-control.md` (AR-CTRL)
cover overlapping ground; where a finding here extends one of theirs it says so and adds only the
new evidence.

## Summary

- **The source is not copy-pasted.** 0.8 % of normalised source lines sit in a repeated block of
  8 or more lines (86 of 10,199), and no block of 8 lines is shared with any of 21 sibling Endo
  packages [measured]. The helpers that are usually re-implemented (promise kits, serial queues,
  ids, error text, hex and base64, timers, durable file writes) each have one home or come from an
  Endo package. This should be kept.
- **The excess is in modes and compatibility paths, not in copies.** Two hub stores with a
  migration between them (AR-DUP-1), a mail-UI subscription path for mailbox objects that this
  build can no longer open (AR-DUP-2), and a hub session described by seven flags where four
  combinations are used (AR-DUP-3).
- **One defect was found while measuring framing.** The Unix netlayer reassembles continuation
  frames with no total size limit (AR-DUP-4).
- **The tests carry the duplication.** Literal duplication is 5.6 % in tests against 0.8 % in
  source. The fixtures are repeated by hand: 45 files make a temporary directory and 68 build Node
  powers. About 31 % of the XS twin tests repeat their Ironhorse twins, and no CI step builds the
  binary those twins need, so they always skip (AR-DUP-5).
- 14 findings: 0 major, 6 moderate, 8 minor.

## 1. Numbers

### 1.1 Size by area

Raw lines, and code lines with comments and blank lines removed [measured].

| Area | Files | Lines | Code lines |
| --- | ---: | ---: | ---: |
| `src/net` | 8 | 4,858 | 3,333 |
| `src/core` | 10 | 3,561 | 2,085 |
| `src/control` | 12 | 3,200 | 2,077 |
| `src/platform` | 29 | 2,294 | 1,446 |
| `src/ironhorse` | 7 | 1,279 | 922 |
| `src/store` | 8 | 1,219 | 759 |
| `src/web` (mail UI) | 3 | 1,120 | 1,008 |
| `src/native` | 6 | 972 | 500 |
| `src/mail` | 4 | 781 | 505 |
| `src/*.js` (helpers) | 7 | 521 | — |
| `src/tui` | 5 | 244 | 140 |
| `src/guest` | 1 | 66 | 37 |
| **`src` total** | 100 | 20,130 | 10,199 normalised |
| `test` total | 109 | 25,102 | 17,008 normalised |

### 1.2 Duplicate-block finder

The finder is `tools/find-duplicates.mjs` beside this report: 199 lines after Prettier, no
dependencies. It
removes comments, collapses whitespace, and drops import lines and lines with no word character
(lone braces). It hashes every window of 8 normalised lines, extends equal windows to maximal
blocks, and groups equal blocks into clusters. In **token mode** (`--ids`) every identifier and
literal becomes a placeholder, so renamed copies match too. In that mode, lines that are only a
name in a list are dropped, since every parameter list would otherwise match. In **cross mode**
(`A -- B`) only clusters that touch both sets are kept.

| Run | Files | Normalised lines | Lines in a repeated block | Share | Clusters |
| --- | ---: | ---: | ---: | ---: | ---: |
| `src`, literal | 101 | 10,199 | 86 | 0.8 % | 4 |
| `src`, token mode | 101 | 9,034 | 131 | 1.4 % | 8 |
| `test`, literal | 109 | 17,008 | 949 | 5.6 % | 45 |
| `test`, token mode | 109 | 14,823 | 1,572 | 10.6 % | 86 |
| `src` against 21 sibling packages, literal | 412 | 47,372 | 0 | 0 % | 0 |
| `src` against 21 sibling packages, token mode | 412 | 40,263 | 49 | — | 1 (an 8-line record literal; not real) |

The 21 sibling packages were `ocapn`, `captp`, `marshal`, `promise-kit`, `eventual-send`,
`daemon`, `stream`, `netstring`, `syrup-frame`, `lp32`, `stream-node`, `hex`, `base64`, `bytes`,
`random`, `cache-map`, `errors`, `platform`, `pubsub`, `memoize` and `cbor-frame` (their `src`
directories, or their top-level files where there is no `src`).

**Source clusters** [measured, then read]. None exceeds 16 lines.

| Lines × copies | Where | Real? | Single home |
| --- | --- | --- | --- |
| 16 × 2 | `pkg/src/net/peer-sessions.js:265-282`, `:307-324` | yes: `op:start-session` verification, written for the dialer and for the listener | AR-DUP-10 |
| 10-11 × 2 | `pkg/src/net/hub.js:1942-1954`, `:2009-2021` | yes: "broken / done / pendingGift" target checks before forwarding | AR-DUP-10 |
| 8-10 × 3 (token mode) | `hub.js:1466-1475`, `:1542-1551`, `:2263-2276` | yes: settle every live resolver in a list | AR-DUP-10 |
| 9 × 2 | `pkg/src/ironhorse/ironhorse-engine.js:59-67`, `:71-79` | no: two destructurings of the same powers | — |
| 8 × 2 | `pkg/src/control/builtins.js:37-44`, `supervisor.js:570-577` | no: an argument list | — |
| 8-9 × 2 (token mode) | `mail/mail-contact.js` against `mailbox.js`, `observable-map.js` | no: the same exo shape with different fields | — |

**Test clusters above 15 lines** [read]:

| Lines × copies | Where | Real? | Single home |
| --- | --- | --- | --- |
| 20 × 2 | `test/worker-session-restart.test.js:111-147`, `-xs.test.js:127-163` | yes, XS twin | AR-DUP-5 |
| 18 × 2 | `test/durable-worker-session.test.js:90-113`, `-xs.test.js:97-120` | yes, XS twin | AR-DUP-5 |
| 16 × 2 | `test/adapter-keeper.test.js:97-114`, `:190-207` | yes: one desired-state model, built twice | a local `makeDesired()` |
| 15 × 3 | `test/ironhorse/element-attributes.js:78-95`, `key-space.js:45-62`, `text-codec.js:323-340` | yes: daemon start and teardown for one lane | `test/ironhorse/_fixture.js`, which already exists |
| 13 × 3 | `test/*-xs.test.js:32-47` (three files) | yes: XS availability probe | AR-DUP-5 |

### 1.3 Helpers of the usual kinds

For each kind: every definition in `src`, and which one should be the home [read; counts
measured].

| Kind | Implementations | Home | Verdict |
| --- | --- | --- | --- |
| Promise kit / deferred | `@endo/promise-kit` in 6 files. 20 `new Promise(`: 13 in `platform/node` wrapping Node callbacks, plus `ironhorse-runtime.js:214`, `xs-engine.js:167`, `ironhorse-engine.js:264`, `inventory-view-lifetime.js:36`, `peer-replay-engine.js:43`, `demo-promise-vats.js:9` | `@endo/promise-kit` | good. The tests hand-roll 17 `let release;` gates (AR-DUP-5) |
| Serial queue | 1: `pkg/src/serial-queue.js:16`, imported by 7 modules and given to guests through the prelude | that one | good. No other Endo package exports one |
| Retry / backoff | 3 exponential backoffs in different shapes: `durable-worker-transport.js:390-393`, `native/adapters.js:78-80`, `net/durable-netlayer.js:213-214` (plus the browser's `mail-ui-host.js:86`) | `platform/timers.js` | AR-DUP-11 |
| Id / nonce | 1: `randomHex128` and `HEX128_PATTERN` in `pkg/src/random-id.js`. The Node `randomUUID` is used only for scratch file names (`platform/node/files.js:109`, `sync-files.js:44`) | that one | good. The same function has 3 local names (AR-DUP-12) |
| Error description | 1: `describeError` (`pkg/src/describe-error.js`, 7 importers). Exceptions: `native/manager.js:60` `String(error)` (already AR-CTRL-16), and `registry.js:166`, which compares a message string (C-18) | that one | good |
| Hex / base64 / bytes | `@endo/hex` and `@endo/base64` only; no hand-written conversion | Endo packages | good. But the same values are stored in two encodings (AR-DUP-8) |
| Framing | 2 hand-written u32 big-endian readers (`control/local-control.js:41-97`, `net/unix-netlayer.js:98-185`), JSON header plus newline (`durable-netlayer.js:80`, `:397`), and JSON lines to child processes (3 clients, AR-DUP-9). `@endo/netstring`, `lp32` and `syrup-frame` are not used | see AR-CTRL-6 | AR-CTRL-6; AR-DUP-4 adds a defect |
| Durable JSON file write | 1 per family: `writeTextAtomic` and `appendTextDurable` in `platform/node/files.js:104` (async) and `sync-files.js:40,59` (sync). No `fs` or `fsync` outside `platform/node` [measured] | those | good. The sync family exists for the store's "disk before graph" invariant |
| Read a JSON file if present | 5: `store-fs.js:60-65`, `inspect-ironhorse.js:17-25`, `supervisor.js:370-376`, `ironhorse-runtime.js:251-256`, `hub-log-store.js:251-260` (adds a damage message) | the file powers | AR-DUP-13 |
| Timers and deadlines | 1: `withExpiry` and `settleWithin` in `platform/timers.js`. `Promise.race` against a disconnect in `local-control.js:147-166` (4 uses, one closure) | that one | good |
| Weak or bounded caches | none written as a cache. WeakMaps in `hub.js:442,779`, `daemon.js:315`, `worker-session-records.js:79,81` are identity side tables | — | nothing to unify |
| Versioned records | 1: `assertRecordVersion` (`store/versioned-record.js`), used by hub state, runtime and workspace metadata | that one | good |

### 1.4 Excess paths

**Exports** (a script over the import graph). The roots are `src`, the package entry files and
the `package.json` exports map, `bin`, `scripts`, the tests, and the harness's `guest`, `perf`,
`scripts`, `test`, `resources`, `config` and `lint` [measured]:

| Status | Count | Names |
| --- | ---: | --- |
| Named exports in `src` | 121 | — |
| Imported by production code | 111 | — |
| Imported only by tests | 9 | `GC_FRAMES_PER_CRANK`, `journalCranks` (transport); `makePeerJournalReplayEngine`, `makePeerSnapshottingReplayEngine`; `QUICK_EXIT_MS`; `assertWorkerId`, `isSessionToken` (re-exported by `store-fs.js:16`); `makeMemoryStore`; `renderInventory` |
| Imported by nothing | 0 | The script lists `MailUi`, but `platform/browser/mail-ui-host.js:115` evaluates `mail-ui.js` from source |

The test-only set is the test doubles and seams that AR-CORE-11 already lists. The peer replay
engines and the memory store are 329 lines of `src` used only by tests.

**Defaulted option keys that production never passes** (a heuristic script: a key counts as
passed when another file writes `key:` or uses it as a shorthand property) [measured, then read]:

| Key | Where | Passed by | Note |
| --- | --- | --- | --- |
| `startupTimeoutMs = 30_000` | `platform/node/adapter-processes.js:22` | nobody | the only caller is `platform/node/powers.js:163` |
| `chunkChars` | `core/evaluate-source.js:51` | 2 tests | C-13 |
| `compactChars`, `compactRatio` | `store/hub-log-store.js:81` | 2 tests | test seams, reasonable |
| `ephemeral = false` (6 subscribe methods) | `observable-map.js:239,259`, `mail/mailbox.js:169-187` | every core caller passes `true` (9 sites), and only tests use `false` | documented to guests in `observable-map.js:183`, so keep [inferred] |

The script found 41 defaulted keys in all. It misses options that are read off an object without
destructuring.

**Modes selected by configuration** [read]:

| Mode | Values | Where read | Production default | Who selects the other value |
| --- | --- | --- | --- | --- |
| Hub store | `log`, `file` | `supervisor.js:162-167`, `store-fs.js:50-55` | `log` | harness tests `serve.test.js:283`, `template.test.js:62`, `perf/_harness.mjs:228`; core `hub-crash-consistency.test.js` |
| GC policy | `allocation`, `every-crank` | `ironhorse-limits.js:145` | `allocation` | kept to bisect C-7 (`rust/thixotrope-ironhorse-worker/src/main.rs:329`); fixed per state directory |
| Combined delivery | `deliver-v1` or two evals | `ironhorse-engine.js:362-364,409-428` | `deliver-v1`, always advertised (`main.rs:778`) | nobody; AR-CORE-6 |
| Mailbox placement | `workspace`, `separate` | `supervisor.js` options | — | AR-CTRL-10 |
| Engine | Ironhorse, XS, two replay doubles | `index.js:11-12`, tests | Ironhorse | XS: nobody (AR-CORE-4, AR-DUP-5) |

**Environment variables** [measured: every `environment.get` and `process.env` in `src`, `bin`
and the entry files]:

| Name | Read at | Default | In `pkg/README.md` |
| --- | --- | --- | --- |
| `THIXOTROPE_MAX_DELIVERY_ATTEMPTS` | `control/supervisor.js:142` | 5 (2..100) | yes |
| `THIXOTROPE_HUB_STORE` | `control/supervisor.js:163` | `log` | **no** (only CORE-CHANGES CC-025) |
| `THIXOTROPE_IRONHORSE_WORKER` | `control/supervisor.js:240` | `<repo>/target/release/thixotrope-ironhorse-worker` | yes |
| `THIXOTROPE_CRANK_BUDGET` | `ironhorse/ironhorse-limits.js:140` | 10,000,000 | yes |
| `THIXOTROPE_BOOTSTRAP_BUDGET` | `:141` | 1,000,000,000 | yes |
| `THIXOTROPE_SLOT_CEILING` | `:142` | 1,000,000 | yes |
| `THIXOTROPE_CHUNK_CEILING` | `:143` | 256 MiB | yes |
| `THIXOTROPE_GC_POLICY` | `:145` | `allocation` | yes |
| `THIXOTROPE_GC_SLOT_ALLOWANCE` | `:147` | 131,072 | yes |
| `THIXOTROPE_GC_CHUNK_ALLOWANCE` | `:148` | 16 MiB | yes |
| `THIXOTROPE_GC_CRANK_INTERVAL` | `:149` | 32 | yes |
| `THIXOTROPE_REQUEST_TIMEOUT_MS` | `:150` | 60,000 | yes |
| `THIXOTROPE_TRACE` | `platform/node/powers.js:85`, read from `process.env` and not through the environment power | off | yes |

The 13 names and the 5 ways configuration arrives are AR-CTRL-9; the only addition here is the
undocumented `THIXOTROPE_HUB_STORE`. The `THIX_MAIL_*` variables of `pkg/scripts/measure-mail.mjs`
and `profile-mail-loader.mjs` are research tooling (AR-CTRL-19).

**Branches with no producer.** For each string literal that `src` compares against (`case 'x'`,
`=== 'x'`, `!== 'x'`), I counted the places that produce it: `src`, `bin`, the harness, `ocapn`
and the Thixotrope Rust crates. 101 compared literals; 12 have no producer in that set, and every
one of the 12 is produced outside it: OS error codes (`ENOENT`, `EADDRINUSE`, `EPIPE`,
`ECONNRESET`, `EEXIST`, `ERR_IPC_CHANNEL_CLOSED`), DOM keys (`Escape`, `Enter`, `Tab`), store
method names (`daemon.js:1147-1148`), and the ownership process's `locked` [measured, then read].
**No dead `kind`/`op` branch was found.** The dead branches that do exist are guarded by feature
probes and versions instead (AR-DUP-2, AR-CORE-6).

**Markers** [measured, then each one read]:

| Marker | Count in `src` | What they are |
| --- | ---: | --- |
| TODO, FIXME, XXX, HACK | 0 | (one "XXX" is `\uXXXX` in a comment, `tui/terminal-text.js:21`) |
| "legacy" | 7 in 3 files | the mail-UI subscribe path (`web/mail-ui-subscription.js:7,13,20,66`, `web/mail-ui-service.js:132,227`: AR-DUP-2); the hub-store migration (`store-fs.js:258`, `hub-log-store.js` 15 lines: AR-DUP-1); a comment in `hub.js:1295` |
| "compat" | 2 | `web/mail-ui-service.js:366` string recipients (AR-DUP-2); `ironhorse-runtime.js` refusal messages (correct refusals, not compatibility paths) |
| "deprecated" | 0 | — |
| "migrate" / "migration" | 9 | refusal messages that say "migrate to a fresh state directory", and the hub-store migration |

**Catch blocks** (`catch {}` blocks and `.catch(fn)` handlers, classified by a script, then
every flagged one read):

| Kind | Count |
| --- | ---: |
| All | 146 |
| Rethrow, reject or `Fail` | 48 |
| Other handling (record a failure, retry, fall back) | 66 |
| Empty | 24 |
| Log only | 5 |
| Constant return | 3 |

All 32 flagged sites are deliberate, and 28 say why in a comment [read]. They are of four kinds:

- marking a promise handled whose rejection is reported elsewhere (for example
  `supervisor.js:280`, `durable-worker-transport.js:399`, `worker-session-records.js:120`);
- best-effort cleanup after a primary failure (`adapter-keeper.js:31`, `manager-kit.js:251,283`,
  `durable-worker-transport.js:504`);
- predicates that catch to say "no" (`is-remotable.js:15`, `hub.js:154`, `store-fs.js:119`);
- logging in a timer or queue tail that has no caller (`durable-worker-transport.js:371,816,823`,
  `workspaces.js:189`, where the docstring says "the supervisor says so and goes on without").

None hides a failure that a caller is waiting for. The append that can wedge the transport
(C-20's ENOSPC note) is a thrown error, not a swallowed one.

## 2. Findings, by severity

### AR-DUP-1 (moderate; question 3): two hub stores and a one-way migration, selectable in production and undocumented

- **Where.**
  - `pkg/src/store/store-fs.js:29-56` (option and check) and `:249-312` (the whole-file branches
    of `getHubState`/`setHubState`, `refuseHubLog`, the `hubWrites`/`hubChars` counters).
  - `pkg/src/store/hub-log-store.js:52-56,71,80,87-90,121,264-290,354-357` (migration from
    `hub.json`, its marker, the interrupted-migration repair).
  - `pkg/src/control/supervisor.js:151-167` (`readHubStore`).
  - `pkg/src/ironhorse/ironhorse-runtime.js:266-268` (knows both layouts' file names).
- **What** [read]. CC-025 made the log store the default and kept `hubStore: 'file'` as an
  option and as `THIXOTROPE_HUB_STORE=file`. Every reader must handle three states: a log, a
  whole file, and a whole file that says it moved. Both stores and the migration are tested
  (`hub-crash-consistency.test.js`, `hub-log-store.test.js:276`). The harness keeps the old
  store selectable in `serve.test.js:283`, `template.test.js:62` and `perf/_harness.mjs:228` as
  a comparison baseline. `pkg/README.md` does not mention the variable [measured].
- **Why it is excess** [inferred]. The whole-file store is the C-2 cost that CC-025 removed. It
  survives as a baseline, not as a supported configuration. The migration serves directories
  written by the whole-file store under the current worker digest. Such directories exist only
  if they were created between the C-16 worker change (`9828522485`, 2026-11-17 02:38) and CC-025
  (`72ef46f905`, 19:18 the same day), or with the variable set. Harness state directories are
  disposable.
- **Smallest change.** Remove the `file` value: the option, `readHubStore`, the whole-file
  branches and counters. Keep one guard that refuses a directory holding `hub.json` with "made by
  an older build; use a fresh state directory", as `ironhorse-runtime.js` already words it, and
  drop the migration. In the harness, drop `THIXOTROPE_HUB_STORE` from the allowlist and the two
  tests. Perf comparisons against the old store can name the commit before the change.
- **Size.** About 110 lines removed across 4 source files (store-fs about 40, hub-log-store about
  45, supervisor about 20, runtime about 3), 2 core test files reduced, 3 harness files edited.
- **Risk.** Low. A directory written by the whole-file store is refused instead of migrated.
  `hub-crash-consistency.test.js` loses its `file` variants; its `log` variants remain and
  cover the crash windows.

### AR-DUP-2 (moderate; question 3): the mail UI keeps a compatibility path for mailboxes this build cannot open

- **Where.**
  - `pkg/src/web/mail-ui-subscription.js:7,13,20,54-67`: a `__getMethodNames__` probe of
    mailbox, inventory and contacts that falls back to `legacySubscribe`.
  - `pkg/src/web/mail-ui-service.js:132-221` (`legacySubscribe`, 85 code lines) and `:227`.
  - `pkg/src/web/mail-ui-service.js:366-371`: string recipients "for older local bridge callers".
- **What** [read]. Both paths were added in one change, `cbf110c6cc` and `3604d0ebaf`
  (2026-10-20), for mailbox objects made before `subscribeInboxEntries` existed. The mailbox,
  inventory and contacts are guest closures shipped by source, and their shape is pinned by
  `WORKSPACE_VERSION` (now 21, `supervisor.js:113`): "a build whose closures differ cannot serve
  an older state directory and refuses it" (`supervisor.js:74-80`). Separately, the runtime
  identity check refuses any directory whose worker or bootstrap digest differs
  (`ironhorse-runtime.js:66-71`), and the worker changed on 2026-11-17.
- **Why it is excess** [inferred]. No mailbox without `subscribeInboxEntries` can be served by
  this build, so the probe always takes the incremental path. Each UI connection pays three
  `__getMethodNames__` round trips through the hub to learn that. The string-recipient branch is
  reached only if the browser page, which this same build serves, sends a string.
- **Smallest change.** Delete `legacySubscribe`, the probe and the `legacySubscribe` option.
  Make `recipient` a token only.
- **Size.** About 115 lines removed in 2 files; `test/mail-ui.test.js` loses any legacy case.
- **Risk.** Low. The incremental path is the one `test/mail-ui.test.js` exercises; check that no
  test feeds a string recipient.

### AR-DUP-3 (moderate; questions 3 and 4): a hub session is seven flags; four combinations are used, and the kind is also spelled in key prefixes

- **Where.**
  - `pkg/src/net/hub.js:2340-2410`: `attachSession` with `requireAcceptance`, `deferCleanup`,
    `durable`, `discardOnRestart`, `remote`, `coalesceInbound` and the presence of `sendBatch`,
    plus five validity rules between them (`:2397-2409`).
  - `hub.js:1211-1312`: `flushOutbox`, with three loops chosen by those flags (disposable at
    1217, batched at 1251, per-frame at 1281).
  - Callers: `core/daemon.js:272`, `net/peer-sessions.js:62-80`, `native/adapters.js:211`,
    `net/in-process-session.js:104`.
  - Prefixes: `'transient:'` is built at `peer-sessions.js:106`, `daemon.js:1040` and
    `adapters.js:138` (`transient:native:`), and parsed at `hub.js:2405`, `daemon.js:818` and
    `peer-sessions.js:384`; `'peer:'` and `'handoff:'` are parsed at `peer-sessions.js:70-71`.
- **What** [measured, read]. 2^7 = 128 flag combinations, of which the source uses four:

  | Caller | Flags |
  | --- | --- |
  | worker | `durable`, `requireAcceptance`, `deferCleanup`, `sendBatch` |
  | remote peer | `remote`, `requireAcceptance` when resumable, `durable` by key prefix |
  | disposable observer (native adapter `adapters.js:211`, transient client `transient-hub-client.js:64`) | `discardOnRestart`, `coalesceInbound`, `onAbort` |
  | daemon endpoint (`daemon.js:765`) | none |

  55 test calls build further combinations. The comment at `hub.js:1295` ("Legacy ephemeral
  adapters retain their synchronous void contract") describes the per-frame loop's acceptance of
  `undefined`. Every current `send` returns a boolean (`durable-netlayer.js:314-330`,
  `in-process-session.js:106-110`), so "legacy" names no current caller.
- **Smallest change.**
  - Replace the flags with one `policy` value drawn from four frozen records exported by the hub
    (`workerPolicy`, `peerPolicy(resumable)`, `observerPolicy`, `endpointPolicy`). Validate the
    policy once, and choose the flush loop from it.
  - Keep the key a key: the policy, not a prefix, says "transient". The sweep at `daemon.js:818`
    can read the policy stored on the session row.
- **Size.** About 40 lines changed in `hub.js`, 4 callers, about 55 test calls (mechanical).
  Persisted state would gain a policy name per session: a `hub-state` version bump [inferred].
- **Risk.** Moderate. The validity rules encode durability arguments, and
  `hub-outbox.test.js`, `hub-disposable-outbox.test.js` and `hub.test.js` cover them. A wrong
  mapping shows as lost or duplicated frames in those tests.

### AR-DUP-4 (moderate; question 5): the Unix netlayer reassembles continuation frames with no size limit

- **Where.** `pkg/src/net/unix-netlayer.js:12-13,131-185`.
- **What** [read]. Each frame is capped at 1 MiB (`maxFrameLength`). A frame with the
  continuation bit is pushed onto `fragments`, and `messageLength` grows with no check
  (`:168-171`). `messageLength` appears only at lines 138, 170, 174 and 182 [measured]. A peer
  that never clears the bit makes the process hold everything it sends. The local admin framing
  next to it caps a whole message at 8 MiB before allocating (`local-control.js:47,77`). The peer
  must reach a socket in a directory private to the user (`assertUnixPeerLocation`, `:25-40`),
  so the exposure is to same-user processes.
- **Smallest change.** Add a `maxMessageLength` (for example the 8 MiB the admin socket uses, or
  the ceiling C-25 proposes) and fail the connection when `messageLength + size` would pass it.
  If AR-CTRL-6's shared framer is built, the cap belongs in it.
- **Size.** About 5 lines and 1 test in `test/unix-netlayer.test.js`.
- **Risk.** A legitimate message over the cap now breaks the connection. No current message is
  near 8 MiB (C-5 halts a vat above about 94 KB).

### AR-DUP-5 (moderate; question 2): test fixtures are repeated by hand, and the XS twins duplicate tests that never run

- **Where and evidence** [measured].
  - 45 test files call `mkdtemp`, 95 teardowns are `rm(..., { recursive: true, force: true })`,
    and `makeNodePowers()` is called 74 times in 68 files. `test/_util.js` exports only
    `makeTestOcapn`.
  - 17 hand-rolled `let release;` gates, the 8-line `let release` block among them (8 copies:
    `hub.test.js:235,289,331`, `worker-peer.test.js:120` and four others).
  - The 15-line daemon start and teardown appears 3 times in the Ironhorse lane
    (`test/ironhorse/element-attributes.js:78`, `key-space.js:45`, `text-codec.js:323`), beside
    an existing `test/ironhorse/_fixture.js`.
  - XS twins: `worker-session-restart-xs`, `durable-worker-session-xs` and `worker-peer-xs`
    (610 lines) share 255 of 815 normalised lines (31 %) with their Ironhorse or replay twins,
    in token mode at 6-line windows. They skip unless `thixotrope-xs-worker` and `dist-xs` exist.
    The CI workflow builds the XS bundles (`.github/workflows/ci.yml:676`) but has no step that
    builds the `thixotrope-xs-worker` binary, so in CI these tests always skip. This adds the CI
    fact to AR-CORE-4, which measured the skip locally.
- **Smallest change.**
  - Add `makeTempState(t, prefix)` (directory plus teardown) and `makeGate()` (a promise kit
    with a `release` name) to `test/_util.js`, and move the lane's daemon setup into
    `test/ironhorse/_fixture.js`.
  - Decide AR-CORE-4. Deleting XS removes the three twins. Keeping it needs a CI step that builds
    the binary, and the twins should then become one parameterised test per scenario over an
    engine list.
- **Size.** Helpers about 30 lines. Adoption is mechanical: about 45 files at 3-6 lines each,
    which can be done file by file. XS: 610 test lines deleted, or about 300 saved by
    parameterising.
- **Risk.** Low. Test-only. A shared temporary-directory helper must keep each test's directory
  separate, because AVA runs tests concurrently.

### AR-DUP-6 (moderate; question 3): the WorkerEngine contract's optional capabilities are branches that only XS and the doubles need

- **Where.** `pkg/src/core/worker-engine.js:12-48` declares 5 optional members: `assertStoreOwnership`,
  `acquireStore`, `releaseSnapshot`, `deliverBatch`, `onOutboundBatch`. A sixth, `canSnapshot`,
  is a boolean. Branch sites [measured]: `durable-worker-transport.js:554,612,805,911,942,1009`,
  `daemon.js:773,1145`, `control/measured-engine.js:62`.
- **What.** This extends AR-CORE-6 by counting. Ironhorse implements every member, so each of the
  9 branch sites has one side that production never takes. The "else, one after another" side
  of `deliverCrank` (`transport:558-563`) changes a crank's boundaries, which C-17 made part of
  the replay contract. An engine that took it would replay differently from one that batches.
- **Smallest change.** As AR-CORE-6: make the members required, implement them in the doubles
  as loops, and resolve XS (AR-CORE-4). The 9 branch sites then lose one side each.
- **Size.** About 40 lines removed across 3 files; doubles plus about 20.
- **Risk.** The doubles' journals change crank grouping. The `worker-gc-cranks.test.js` and
  `daemon-journal-recovery.test.js` expectations may need new counts.

### AR-DUP-7 (minor; question 3): an option and a parameter no caller sets

- `pkg/src/platform/node/adapter-processes.js:20-23`: `startupTimeoutMs` (default 30 s) is never
  passed. The one caller is `platform/node/powers.js:163` [measured]. It can be a constant, or
  part of AR-CTRL-9's configuration record.
- `chunkChars` in `core/evaluate-source.js:51` is C-13: passed only by tests.
- Size: 3 lines. Risk: none.

### AR-DUP-8 (minor; question 2): the same bytes at rest in two encodings

- **Where** [read].
  - Hub: queued frames are hex (`hub.js:1191`, decoded at 1229, 1266, 1290), and so are session
    identities (`hub.js:2426-2430`: `sessionId`, `peerPublicKeyQ`, `selfPrivateKey`).
  - Worker journal: frames are base64 (`durable-worker-transport.js:742`).
  - Peer sessions: the same three identity fields are base64 (`peer-sessions.js`: `sessionIdB64`,
    `selfPrivateKeyB64`, `peerPublicKeyQB64`), and so are their inbox frames.
- **What.** One frame is written at 2N characters into the hub log and at about 1.33N into the
  journal. `survey-ocapn-hub.md` section 3 (the cost table, "hub state (twice) ... 2 x hex") has
  the cost. The same identity is converted between encodings when a session moves between the
  hub and the netlayer.
- **Smallest change.** Choose base64 for every byte string at rest, and bump the hub-state record
  version. Do this with the next format change to hub rows (C-2's open part, CC-051 and CC-060 in
  `m0-results.md`), not alone.
- **Size.** About 15 call sites in `hub.js`, plus a version bump. Risk: the persisted format (a
  version bump refuses old directories); `hub-log-store.test.js` and `hub.test.js` cover it.

### AR-DUP-9 (minor; question 2): three JSON-lines clients for child processes

- **Where** [read].
  - `pkg/src/ironhorse/xs-engine.js:100-170`: a FIFO of waiters, with an `outbound` push op.
  - `ironhorse-engine.js:315-360`: one pending waiter, with `fatal`/`error`/`ready`/`result`.
  - `ironhorse-runtime.js:195-218`: the ownership process, a line queue and one acceptor.
- **What.** Each one writes the same parts: read lines, `JSON.parse` with its own garbled-line
  handling, match a reply to a waiter, fail all waiters on exit. Each is about 40-70 lines. The
  protocol is dictated by the Rust binaries, so the shared part is the transport, not the ops.
- **Smallest change.** One `makeJsonLineClient(processHandle, { onPush })` in `src/ironhorse/`
  with `request(obj)` and `failAll(error)`, used by the engine and the runtime. If XS stays, it
  uses it too.
- **Size.** About 60 lines removed net across 2-3 files. Risk: the engine's exit and ownership
  ordering is subtle (`ironhorse-engine.js:315-330`, "what a child's pipes report late must not
  be taken out on its successor"). Covered by the Ironhorse lane (`test:ironhorse`), not by the
  default `ses-ava` run.

### AR-DUP-10 (minor; question 2): three local repetitions in the hub and the peer handshake

- **Where** [measured, read].
  - `hub.js:1466-1475`, `:1542-1551`, `:2263-2276`: "for each resolver id, skip dead rows,
    `settleToResolver(...)`", three times with different outcomes.
  - `hub.js:1942-1954` and `:2009-2021`: the "broken / done / pendingGift" target checks
    before `forwardToRow`, written for `op:deliver` and for `op:index`/`op:untag`.
  - `peer-sessions.js:265-282` and `:307-324`: 16 lines verifying `op:start-session` (type,
    CapTP version, location signature), once for the dialer and once for the listener.
- **Smallest change.** `settleLiveResolvers(ids, outcome, value)`, `refuseUnforwardable(target)`
  (returns a reason or `undefined`) in the hub, and `verifyStartSession(reader)` (returns the peer
  key) in `peer-sessions.js`.
- **Size.** About 45 lines removed in 2 files. Risk: low. `hub.test.js` and
  `durable-sessions.test.js` cover all three.

### AR-DUP-11 (minor; question 2): three exponential backoffs, each with its own shape

- **Where** [read]. `durable-worker-transport.js:390-393` (`base * 2 ** min(n, 30)`, capped);
  `native/adapters.js:78-80` (`1000 * 2 ** (q - 1)`, capped, 0 for the first);
  `net/durable-netlayer.js:213-214` (the delay doubles in place, capped).
- **Smallest change.** `backoffDelay(baseMs, attempt, maxMs)` in `platform/timers.js`. The
  netlayer keeps an attempt count instead of a mutable delay.
- **Size.** About 10 lines across 4 files. Risk: none if the sequences are kept. The netlayer's
  first delay is its initial `delay`, so `attempt` starts at 0.

### AR-DUP-12 (minor; question 4): one id function under three names

- `randomHex128` (`random-id.js:14`) is rebound as `randomHexFrom` and then a local
  `randomHex128` in `daemon.js:18,200`, as `randomId` in `supervisor.js:208` and
  `builtins.js:43`, and passed down as a `randomHex128` power to `peer-sessions.js:34`
  [measured]. One name, `randomHex128`, everywhere.
- Size: about 8 lines in 3 files. Risk: none.

### AR-DUP-13 (minor; question 2): "read a JSON file if it exists" five times

- **Where.** `store-fs.js:60-65` (sync, `exists` then read), `inspect-ironhorse.js:17-25` (async,
  ENOENT to `null`), `supervisor.js:370-376` and `ironhorse-runtime.js:251-256` (async, ENOENT to
  `undefined`), and `hub-log-store.js:251-260` (sync, adds a damage message) [read].
- **What.** Two return `null` or `undefined` differently, and only one says which file is
  damaged when the JSON does not parse.
- **Smallest change.** `readJsonIfPresent(path)` on both file-power families, returning
  `undefined` and naming the path on a parse failure.
- **Size.** About 25 lines across 6 files. Risk: none. Error messages change wording.

### AR-DUP-14 (minor; question 3): demo and research code in `src`

- `pkg/src/ironhorse/demo-counter-vats.js` and `demo-promise-vats.js` (58 lines) serve only
  `scripts/ironhorse-demo.mjs` [measured by the import graph]. AR-CORE-11 already covers the
  replay doubles and the memory store; the demos belong with them, in `scripts/` or `examples/`.
- Size: 2 moves. Risk: none.

## 3. What should be kept

- **One home per helper.** The serial queue, `randomHex128`, `describeError`, `withExpiry` and
  `settleWithin`, and `assertRecordVersion` are each defined once and imported (7, 8, 7, 4 and 4
  importing files). The guest prelude re-exports the ones guest factories need instead of letting
  guests copy them [measured, read].
- **Endo packages for the standard pieces.** `@endo/promise-kit`, `@endo/hex`, `@endo/base64`,
  `@endo/errors` and `@endo/ocapn`'s codec are used; no conversion, deferred or error helper is
  written by hand. No 8-line block is shared with 21 sibling packages [measured].
- **Platform code stays in `platform/node`.** No `fs`, `fsync` or `node:` import appears outside
  it [measured]. Durable writes have one implementation per family, with the
  scratch-file-then-rename-then-directory-fsync sequence written once.
- **Exports are lean.** 0 of 121 named exports go unused. The 9 test-only exports are declared
  seams [measured].
- **Swallowed errors are deliberate.** All 32 empty, log-only and constant-return catches were
  read, and none hides a failure a caller is waiting on. Most say why in a comment.
- **No markers.** There is no TODO, FIXME or XXX in `src`. The compatibility code there is the
  code named in AR-DUP-1 and AR-DUP-2.

## 4. Method

- Duplicate finder: `tools/find-duplicates.mjs` (committed), run as
  `node find-duplicates.mjs [--ids] [--min N] DIR... [-- DIR...]` from `packages/thixotrope` or
  `packages/`.
- Scripts not committed (scratch, outside the repository):
  - export-use counts over an import graph that resolves relative specifiers and
    `@endo/thixotrope` subpaths, with the entry files counted as roots;
  - the defaulted-option-key counter;
  - the compared-literal producer counter;
  - the catch classifier.

  Each is under 80 lines, and the method is described with its table above. The counts depend on
  regular expressions, not a parser, so each flagged item was read before it was reported.
- Not covered: the Rust side, except the worker's ready message and GC policy; the harness
  package (reviewed later); the CSS and `.txt` assets in `src`; the internal structure of the
  long closures, which AR-CORE-7 and AR-CTRL-1 cover.
