# Architecture review of the Thixotrope core: ranked synthesis (AR-SYN)

Unit AR-SYN of the core architecture review. It merges the six area reports in this directory with
the two verification passes (AR-VER1 over AR-NET, AR-CORE and AR-CTRL-1..9; AR-VER2 over AR-APPS,
AR-ONTO and AR-DUP). Read-only: no source, test or config file was changed and nothing was run.
Snapshot: branch `claude/thix-arch` at `3f67a8e505`. Paths are relative to `packages/thixotrope/`
unless they start with `packages/`.

| report | unit | scope | findings (major / moderate / minor) |
| --- | --- | --- | --- |
| `core-net.md` | AR-NET | `src/net/**`, `src/store/**` | 3 / 10 / 5 |
| `core-daemon.md` | AR-CORE | `src/core/**`, `src/ironhorse/**`, guest, shared helpers | 1 / 8 / 4 |
| `core-control.md` | AR-CTRL | supervisor, control plane, native, platform, bin, scripts | 2 / 7 / 10 |
| `core-apps-tests.md` | AR-APPS | mail, web, TUI, resources, tests, build | 2 / 8 / 5 |
| `core-ontology.md` | AR-ONTO | question 4 across the package | 2 / 10 / 8 |
| `core-duplication.md` | AR-DUP | questions 2 and 3 across the package, measured | 0 / 6 / 8 |

Evidence marks carry over from the area reports: **read**, **measured**, **inferred**. A finding
here is "confirmed" or "confirmed-smaller" only if a verifier said so; where a verifier corrected
the proposed fix, the correction is the fix given here (section 3.2). No finding was refuted.
Findings that no verifier checked are listed apart (section 3.3). Three lines cited by the top
findings were re-read for this synthesis (`hub.js:405-416`, `:2418-2422`, `:2664-2675`;
`durable-worker-transport.js:998-1014`; `store-fs.js:186-198`); they hold.

Started 2026-11-18T12:27:14Z; the end time is in journal entry J-9975.

---

## 1. Verdict

The core is sound where it matters most and untidy around the edges. Dependencies point the right
way (no import cycles in `src/net`, `src/store` or `src/core`; core imports nothing from control; no
`node:` import outside `src/platform/node`), platform powers are injected, the source is not
copy-pasted (0.8 % of normalised lines in a repeated block, none shared with 21 sibling Endo
packages), and the durability rules ("tables before wire", "journal before the duct") are stated
and tested, including under SIGKILL. What costs is accretion: three closures of 900 to 2,800 lines
grew one feature at a time, modes and compatibility paths were kept after the version gate made
them unreachable, and an application (mail) and an engine that never runs (XS) live inside the
core. One correctness defect is confirmed: hub retirement can be left half done. Two smaller ones
are a retirement retry that skips its cleanup and a journal append that is not repaired after a
failure. **The three structural problems that matter most:**

1. **Life cycles have no owner.** A vat's life cycle is spread over about ten transport flags,
   `meta.failure` on disk, the daemon's worker map and the hub's retired flag. A hub session's
   retirement is a run of separate commits, and "retired" stands for both quarantine and removal.
   This is where the confirmed defects are, and C-8, C-10, C-11 and C-18 all land on it.
2. **Concepts are passed as strings and flags, not objects.** A session's kind is a key prefix (14
   sites), seven attach flags and three outbox loops. "The callee is gone" is an error text the
   harness matches exactly. Vat GC and the engine runtime read the hub's and the store's persisted
   files instead of asking their owners. This is the owner's "pass objects, not names" principle
   broken in the core's centre, and it couples the C-2 row-format work to vat GC.
3. **Guest code shipped by source is versioned by hand.** Twelve functions are shipped into heaps
   with `toString()`, guarded only by a person bumping `WORKSPACE_VERSION` (now 21). No test fails
   when a bump is forgotten. Many of the fixes below edit shipped source, so this guard should come
   first, and those fixes should share one bump.

## 2. What is good and must be kept

A fix that damages one of these is a bad fix.

- **Dependency direction and the platform boundary** [measured]. `net/` and `store/` import nothing
  from `core/`, `control/`, `native/` or `mail/`; `core/` imports nothing from `control/`. No module
  outside `src/platform/node` imports a `node:` module or uses `fs`. Core receives only the
  `PlatformPowers` members it names.
- **The non-reifying hub with its rollback ledger** (`src/net/hub.js:310-351`, `776-820`). Decode,
  route and encode either all happen or leave no rows, refcounts or routes. Tokens are inert
  `Far('HubRef')` objects; nothing promise-shaped lives in the supervisor.
- **"Tables before wire" and "journal before the duct"**, enforced in `deliverFrame`, the outbox
  loops and the worker transport, and proven by `test/hub-crash-consistency.test.js` (random SIGKILL
  at commit points). AR-SYN-1 is the one path that does not yet follow the rule.
- **`src/store/hub-log-store.js`**: a documented log format with a torn-tail rule, recovery and
  compaction rules, refusal on damage, and exhaustive prefix and fault tests. It is the right base
  for peer session records (AR-SYN-10).
- **The durable netlayer** (`src/net/durable-netlayer.js`): a small explicit envelope state machine
  with checked sequence arithmetic and a crash-safe retire handshake, over a stateless Unix
  transport that checks directory privacy and `sockaddr_un` length.
- **The transport's replay contract** (`src/core/durable-worker-transport.js:26-68`, `738-854`):
  crank boundaries as a pure function of the journal, outbound sequence numbers deduplicated by the
  hub watermark.
- **The failure taxonomy and crash-loop policy**: halt, crash and host trouble kept apart, with 26
  tests in `test/durable-worker-crash-loop.test.js` that read as its specification. Keep them as the
  oracle for AR-SYN-5.
- **Ironhorse runtime pinning** (`src/ironhorse/ironhorse-runtime.js`): pinned worker and bootstrap
  digests, heap ceilings that only rise, a fixed collection schedule, private checked copies, a
  kernel lease, and refusals that say what to do.
- **The native-resource kits** (`src/native/manager-kit.js`, `adapter-kit.js`): epochs per
  registration, adopted specs, desired state withdrawn before unbind, handles per generation; every
  kit option has a real user.
- **The registry vat with the host's installation index as a repair path** that does not run
  through the broken vat; tested with a quarantined registry.
- **One home per helper**: `serial-queue.js` (7 importers), `random-id.js` (8), `describe-error.js`
  (7), `platform/timers.js` (4), `store/versioned-record.js` (4); `@endo/promise-kit`, `@endo/hex`,
  `@endo/base64`, `@endo/errors` and the `@endo/ocapn` codec for the standard pieces. 0 of 121
  exports unused; all 32 empty or log-only catches deliberate; no TODO or FIXME in `src`.
- **The design's vocabulary table** (`designs/thixotrope.md` lines 73-105), which the code mostly
  follows, the retire/forget split, and versioned records refusing with named messages.
- **Tests that aim at real failure points**: engine-parameterised integration scenarios
  (`test/_alarm-integration.js` and siblings), commit-failure injection, lane fault injection, and
  `test/shipped-factories.test.js`.
- **`observable-map.js`** (bounded coalescing, one notification outstanding per listener) and the
  **TUI** (five small modules, one view-lifetime idiom, escaping of every remote string).

---

## 3. Ranked findings

### 3.1 Table

Class: **do now** (small, safe, pays at once); **do with** (belongs with a named candidate or
planned change); **plan** (a refactor that needs its own design); **leave** (true, not worth the
churn). Q: 1 architecture, 2 repetition, 3 excess paths, 4 ontology, 5 other. Verdicts: C =
confirmed, CS = confirmed-smaller.

| rank | id | what | where | Q | size | risk of the fix | class | sources (verdict) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | AR-SYN-1 | Hub retirement commits and sends in pieces: resolver breaks and GC batches persist and send at `deliveryDepth` 0 before the answer-route rewrite and `retired = true`. A throw or a kill in between leaves a bumped epoch with `retired: false`; the epoch-mismatch path then only persists, so the cleanup never completes. The comment "Still inside deliveryDepth" is false on this path, and `attachSession` sets `retired = false` with no epoch check | `src/net/hub.js:2223-2338`, `:411`, `:2420`, `:2664-2675` | 5 | about 30 lines, 1 file; 2 tests (store throws on the Nth `setState`; kill between flush and final commit) | Holding the depth makes nested persists no-ops: persist once, then flush every outbox, with `withGcBatch` flushing inside the depth, or GC frames stay queued. No current test injects a mid-retirement failure | do now | AR-NET-1 (C; no crash needed), AR-VER1 missed items 2 and 4 |
| 2 | AR-SYN-2 | Shipped guest closures (12 `toString()` sites) are guarded only by a hand-bumped `WORKSPACE_VERSION`; nothing fails when a bump is forgotten, and several fixes below edit shipped source | `src/control/supervisor.js:74-113`, `builtins.js`, `workspaces.js:143-146,312,323,361`, `installer.js:140-141` | 5 | about 40 lines, 2 files | A golden test trips on every formatting change and forces bumps that refuse old state directories; record the digest of the shipped text in `workspace.json` and refuse on mismatch instead | do now | AR-CTRL-3 (CS, moderate), AR-VER2 missed item 1 |
| 3 | AR-SYN-3 | A retried vat retirement skips its own cleanup: `retire()` sets `destroyed` before its work; if `releaseSnapshot` throws, the retry returns at once, `forgetWorker` deletes the record, and the image is never released; meanwhile the still-listed worker refuses every frame | `src/core/durable-worker-transport.js:1000-1013`; `src/core/daemon.js:523-538` | 5 | about 10 lines + 1 test (an engine whose `releaseSnapshot` throws once) | Memoising the promise rethrows the same failure for ever: reset the memo on failure, or set `destroyed` only after success while still refusing new frames | do now | AR-CORE-2 (C) |
| 4 | AR-SYN-4 | `appendJournal` does not reset the repair state after a failed append, unlike `appendJournalEntries`; a later append lands after a torn fragment and `readJournal` throws on the middle line | `src/store/store-fs.js:189-219` | 5 | 5 lines + 1 fault test | Behaviour-preserving apart from the repair; `store-memory` unaffected | do now | AR-NET-11 (C) |
| 5 | AR-SYN-5 | The vat life cycle has no owner: about ten transport flags, `meta.failure` (7 checks in 2 files), the daemon's startup loop repeating the transport's retry policy, image release written 3 times, and a per-frame synchronous `getMeta()` read to learn what `givenUp` already knows | transport `:200-243`, `:478`, `:512`, `:586-595`, `:837`, `:866`; daemon `:767-784`, `:887-911`; `store-fs.js:186` | 1, 3, 4 | 150-250 lines in 2 files, mostly moved; meta cache about 30 | Order between `transport.retire`, `sink.detach` and `forgetWorker` is subtle (AR-SYN-3 is already wrong there); a cache must update on `setMeta` and drop on `deleteWorker` | do with C-8, C-10, C-11 (and C-24) | AR-CORE-1 (C), AR-CORE-9 (C), AR-CTRL-12 (unverified), AR-VER1 missed item 5 |
| 6 | AR-SYN-6 | A hub session's kind is spelled three ways: key prefixes (14 sites in 4 files), seven attach flags with five coupling rules, and three outbox loops; "disposable observer" is applied to native adapters that command vats | `src/net/hub.js:1211-1312`, `:2383-2423`; `net/peer-sessions.js:62-80,384`; `core/daemon.js:816-818`; `native/adapters.js:138,211` | 3, 4 | about 150-200 lines, 5 files; about 55 test calls; a hub-state version | Peers need a `resumable` parameter (acceptance depends on the netlayer's resume token); the kind must be persisted on the session row or the startup sweep stops reclaiming transient rows, an unbounded leak with no failing test | do with C-2 (CC-051, CC-060) | AR-NET-3 (CS), AR-DUP-3 (CS), AR-ONTO-9 (C), AR-VER2 missed item 4 |
| 7 | AR-SYN-7 | Vat GC parses the hub's persisted tables (`hubState.refs`, `answersOwed`, `gifts`, ...) and the engine runtime probes the store's file names; `hub.inspect()`, documented as the reachability graph, has no `src` caller. `collectVats` re-reads and re-parses the committed image once per candidate | `src/core/vat-reachability.js:51-150`; `daemon.js:954`, `:1074-1089`; `ironhorse/ironhorse-runtime.js:262-277`; `hub.js:2779-2800` | 1 | about 150 lines, 4 files | `inspect()` cannot replace the whole input (endpoint exports and pending answers are not hub data); live tables may hold uncommitted state during a delivery; reachability tests build state literals by hand and must be rebuilt through a real hub, or vats get collected while reachable | do with C-2 (CC-051, CC-060) | AR-NET-2 (C), AR-CORE-8 (CS), AR-VER1 missed item 1 |
| 8 | AR-SYN-8 | Frames for transient sessions are committed into hub state before they are spliced, and never read back (the open "at rest" half of C-1) | `src/net/hub.js:1217-1225`; `net/hub-state.js:64-65` | 2, 5 | 3 lines, 1 file | None found; check no test asserts a transient session's persisted queue | do now (closes C-1 at rest) | AR-NET-13 (C) |
| 9 | AR-SYN-9 | One error text, "the target session has been retired", reports quarantine, removal and adapter end, with a second text for remote retirement; callers (the harness) cannot tell which | `src/net/hub.js:1842,2278,2306,2624`; `core/daemon.js:263,288-289` | 4, 5 | about 30 lines in hub and daemon, plus the harness's `guest/lib/retired.js` | Keeping the text as a prefix breaks the harness's exact match (deliberate since J-0290). Put the reason in a separate field of a typed break, and change `retired.js` in the same step | do with C-18 | AR-ONTO-3 (C), AR-CORE-3 (CS) |
| 10 | AR-SYN-10 | Hub-side state that grows with history: the session's private key is re-appended to the hub log at every commit touching the session (200 copies for 200 commits, measured); retired peer sessions are kept for ever in four places (287 characters each, stringified at every commit); a peer record is rewritten whole per frame (O(n^2) for a backlog, inferred) | `hub.js:2424-2431`; `hub-state.js:67`; `peer-sessions.js:126-137,506-573`; `durable-netlayer.js:113-121` | 2, 5 | identity table about 20 lines; tombstone table about 40; record log about 60 | The hub needs the key to sign gift handoffs after a restart, so every reattach must supply it; `forgetSession` on a handoff key would reopen a location the hub now refuses (keep a tombstone table of retired tokens and handoff epochs); a record log changes the netlayer's crash contract | do with C-2 (CC-051, CC-060) | AR-NET-4 (C), AR-NET-5 (CS), AR-NET-6 (CS), AR-DUP-8 (unverified) |
| 11 | AR-SYN-11 | The Unix netlayer reassembles continuation fragments with no total limit; a same-user peer can make the supervisor hold any amount | `src/net/unix-netlayer.js:11-13,131-185` | 5 | about 8 lines + 1 test | A cap below the largest legitimate logical message breaks cross-daemon sends, and no test sends large messages: choose the cap from the largest admitted message | do with C-25 | AR-DUP-4 (CS, minor), AR-NET-16 |
| 12 | AR-SYN-12 | An inbound `op:abort` only sets `attached = false`; a remote peer's connection is not ended | `src/net/hub.js:2166-2170` against `:2185-2211` | 5 | about 10 lines + 1 test | Apply `onAbort` only when `session.remote`, as `frameError` does: native and transient sessions' `onAbort` ends a process or forgets a session | do now | AR-NET-10 (CS) |
| 13 | AR-SYN-13 | Three closures grew by accretion: `hub.js` (2,803 lines; routing core about 1,200, gifts 460, outbox modes 400, diagnostics 235; `attachSession` 209), `buildDaemon` (936 lines, about twelve jobs), `serveThixotrope` (940 lines, 11 mutable bindings read by closures defined before assignment) | `src/net/hub.js`; `src/core/daemon.js:183-1118`; `src/control/supervisor.js:182-1122` | 1 | about 1,100 + 400 + 450 lines moved into about 8 files | Ordering is load-bearing (`readyKit`, `makeConnectionFacet`); mutable lets (`deliveryDepth`, `dirty`, `gcBatches`) must be shared by reference, not copied, or persist gating breaks silently; `hub-crash-consistency` is the only test that notices a missing commit | plan (after AR-SYN-5 and AR-SYN-6) | AR-NET-8 (C), AR-CORE-7 (C), AR-CTRL-1 (C) |
| 14 | AR-SYN-14 | Two engines in name, one in fact: XS cannot run the daemon as composed and its tests always skip (CI never builds the binary); the one bootstrap every Ironhorse vat runs is `worker-peer-xs.js`, documented as XS; optional engine seams (`deliverBatch`, `onOutboundBatch`, `appendJournalEntries`, `combinedDelivery`) mean the 29 test files on the replay doubles take paths production never takes | `src/core/worker-peer-xs.js:1-21`; `src/ironhorse/xs-engine.js`; `index.js:11`; transport `:550-564`, `:884-895`; `ironhorse-engine.js:362-364,409-428` | 1, 3, 4 | delete XS about 820 lines; or a CI lane; seams about 60 lines removed | Renaming the entry must update `eslint.config.js:155` and the root lint-config test; header text is part of the bundle bytes (runtime identity changes); deleting `makeXsEngine` is a public API break; `canSnapshot` is a mode (journal-only replay tests), not a seam; replace `combinedDelivery` with a refusal at boot, not silence | plan (owner decides XS first) | AR-CORE-4 (C), AR-CORE-6 (CS), AR-DUP-6 (CS), AR-APPS-10 (C), AR-DUP-5 (C), AR-ONTO-16 |
| 15 | AR-SYN-15 | The mail application is wired into the core's control plane (supervisor, built-ins, workspaces, a host resource, the admin facet, the state version), while `src/mail` and `src/web` are import leaves and the harness uses none of it: about 3,080 lines of `src` (15 %), 2,577 of tests, 1,781 of scripts, 5.3 MB of data | `src/control/supervisor.js:65,383-395,438-447,881-927`; `builtins.js:211-217`; `workspaces.js:113-175,341-372`; `src/platform/browser/*`, `platform/node/mail-ui-server.js` | 1, 4 | (a) a provider list passed in, about 150 lines, 4 files; (b) a package move of about 9,000 lines | The design glossary makes mail part of the core model (workspace, message, mailbox sections), so this is a design decision first. Step (a) must precede (b) or a cycle results; moved shipped source must stay byte-identical or the version moves | plan (design first) | AR-APPS-1 (CS), AR-CTRL-11, AR-APPS-11 |
| 16 | AR-SYN-16 | The control socket is served two ways (a native resource and a host fallback), with the listener written twice and `replaceUnhealthy` used once; the resource path is the cause of C-4 | `src/control/supervisor.js:997-1085`; `resources/control/ephemeral.js:45-100` | 2, 3 | shared `serveLocalControl` about 60 lines; host-only about 300 removed | The shared helper must keep the fallback's stand-down on `EADDRINUSE` and its refusal before `makeConnectionFacet` exists; the host-only fix removes a recorded native resource (version bump) | do with C-4 | AR-CTRL-2 (C), AR-APPS-12 |
| 17 | AR-SYN-17 | Admin `stop()` only requests a stop; every caller writes `await stopped; await close()`, and `stopped` means "requested" on one path and "closed" on the other | `src/control/supervisor.js:282-287,662-665,1087-1110` | 3, 4 | about 10 lines | `stop()` runs over the connection `close()` tears down: keep it deferred (timer), never awaited inside the call | do now | AR-CTRL-4 (C) |
| 18 | AR-SYN-18 | Compatibility paths for states the version gate already refuses: the mail UI's `legacySubscribe` and top-level probe; `mailboxPlacement: 'workspace'` (one test caller); the ephemeral worker (no production caller); the launcher's pre-bundle message; `restoreHubState` fallbacks and the `'resume'` envelope | `src/web/mail-ui-subscription.js:54-67`; `web/mail-ui-service.js:132-221`; `control/workspaces.js:354-373`; `core/daemon.js:570-591,664-690,746-783,1100-1104`; `native/adapters.js:131-137`; `net/hub-state.js:107-148` | 3 | about 400 lines removed over 8 files; 5 test files edited | Keep the per-contact `subscribeStatus` probe (contacts accept any value) and the HTTP `name` input (a live API, not stored state); keep the startup discard of `meta.ephemeral`; reword the launcher check rather than delete it (it validates the daemon-level resource API); several are shipped source, so one shared bump | do with the next `WORKSPACE_VERSION` bump | AR-APPS-4 (CS), AR-DUP-2 (CS), AR-APPS-8 (C), AR-ONTO-11 (CS), AR-CTRL-8 (CS), AR-NET-14 |
| 19 | AR-SYN-19 | The whole-file hub store, its one-way migration and two mail-hub experiments (scripts, tests, fixture) stay in the core; two research patches no longer apply; `THIXOTROPE_HUB_STORE` is undocumented | `src/store/store-fs.js:29-56,249-312`; `store/hub-log-store.js` migration; `scripts/mail-hub-*.mjs`, `*.patch`; `test/mail-hub-*.test.js` | 3 | experiments about 1,100 lines and the patches removed; file mode about 250 later | The harness uses `file` as its perf A/B baseline (`perf/_harness.mjs:228`, `serve.test.js`, `template.test.js`); seven design notes cite 37 trace files (archive, do not delete); the crash child writes the legacy `hub.json` the migration test reads | do now (experiments, patches, document the variable); leave file mode until the harness retires its baseline | AR-NET-7 (CS), AR-DUP-1 (CS), AR-APPS-7 (CS) |
| 20 | AR-SYN-20 | Words with several meanings and concepts with several words: incarnation (process and session epoch), epoch (three counters), delivery (frame and crank), slot (four senses), resource (host and native), transient (five names), daemon/supervisor/host, worker for vat (about 1,082 identifier tokens against 283) | design lines 79-105; `hub.js:47,2214,2652`; `control/measured-engine.js:20-23`; `daemon.js:41`; README | 4 | about 60 prose lines and 5 local renames | None if persisted names (`workerId`, `epoch`, `refId`, `native-adapter`, `deliveryHistogram`) stay; deriving the endpoint's identity differently changes its key pair and is not a rename | do now (glossary, section 6) | AR-ONTO-1, -2, -4, -6, -7, -8, -13, -14 (C or CS), AR-CORE-3 (CS), AR-NET-12 (CS) |
| 21 | AR-SYN-21 | The host endpoint is a pseudo-worker (`'e'.repeat(32)` under `workers/`, eight special cases in the daemon); its records module is named and keyed for workers with one entry; `store.js` documents fields that no longer exist | `src/core/daemon.js:144-147`; `core/worker-session-records.js:79,87`; `store/store.js:56-61` | 4 | about 40 lines in 5 files; a store record of its own is a migration | Dropping the WeakMap edits 2 test files; moving `tables.json` is a persisted-layout change | do now (rename, docs); plan (own record) | AR-ONTO-5 (CS), AR-CORE-13, AR-CORE-3 (CS) |
| 22 | AR-SYN-22 | Wire shapes hand-coded: the duct envelope at 18 sites in 4 files, decoded on two paths with different validation; OCapN slot strings parsed by hand at 11 sites | transport `:527-540`, `:615-630`; `peer-replay-engine.js:62-87`; `worker-session-records.js`; `daemon.js:345-354` | 2 | about 80 lines, 6 files | `@endo/ocapn`'s `parseSlot` is not exported and differs in strictness: use a local `slot.js` and check each site; the in-vat side of the duct is frozen into heaps, so change host-side code only | do now (host side) | AR-CORE-5 (CS) |
| 23 | AR-SYN-23 | The Ironhorse lane (12-23 minutes) cold-provisions in nearly every test, runs one file at a time, and records no per-file time, so its cost cannot be attributed; the Node suite runs every file under three SES configurations | `ava.ironhorse.config.mjs`; `test/ironhorse/_fixture.js:150-170`; `test/ironhorse/supervisor.js:32-70`; `package.json:98-102` | 5 | timing about 20 lines; templates about 80 | Timing-sensitive files (`limits`, `alarm-crash`, `http-crash`, `reliability`) stay serial; template caches go stale with each worker build (runtime digests); the SES split is a monorepo decision | do now (timing first) | AR-APPS-2 (C) |
| 24 | AR-SYN-24 | The mail UI service and mailbox keep state that only grows (`selections`, `recipients`, the outbox), project one snapshot two ways, and duck-type an untyped `contacts` map | `src/web/mail-ui-service.js:36-45,63-328`; `src/mail/mailbox.js:101-164`; `control/workspaces.js:142-146` | 2, 5 | about 100 lines | Keeping a captured recipient is deliberate and tested (`test/mail-ui.test.js:753-762`): bound the maps when a subscription cohort closes, not per projection; `describe` cannot be hoisted out of the shipped `makeObservableMap` | do with AR-SYN-15 | AR-APPS-3 (CS), AR-APPS-5 (C), AR-APPS-6 (CS), AR-VER2 missed item 3 |
| 25 | AR-SYN-25 | Repeated test scaffolding: 45 files make temporary state by hand, the replay engine plus `acquireStore` is spelled at 15 sites, three lane files share an 18-window preamble, and the retirement text is a literal in tests | `test/**`; `test/ironhorse/element-attributes.js`, `key-space.js`, `text-codec.js` | 2 | about 150 lines added, 400 removed, file by file | A shared `stateDir` must keep `/tmp` for socket tests (macOS `tmpdir()` exceeds the 103-byte socket path) and keep directories per test | do now (incrementally) | AR-APPS-9 (C), AR-DUP-5 (C) |
| 26 | AR-SYN-26 | The registry-or-index choice is made at each use (13 `registryHealthy` references in 3 files) with three hand-written listing projections | `src/control/supervisor.js:550-555,639-654,804-848`; `workspaces.js:219-249`; `builtins.js:91-96` | 2, 3 | about 60 lines fewer, 1 new module | `registryHealthy` may change during a run: decide per call, not once at start | do with AR-SYN-13 | AR-CTRL-7 (C) |
| 27 | AR-SYN-27 | Configuration arrives five ways (options, environment, `process.env` directly, persisted, hard-coded); `THIXOTROPE_TRACE` bypasses the environment power; an injected engine silently ignores `THIXOTROPE_IRONHORSE_*` | `src/control/supervisor.js:141-167,233,240`; `platform/node/powers.js:85` | 3, 5 | about 60 lines, 3 files | Warn, do not refuse, when limit variables are set beside an injected engine (the harness and tests inject a measured engine with the environment set globally) | do with AR-SYN-13 | AR-CTRL-9 (CS) |
| 28 | AR-SYN-28 | The native contract has no "service" shape and no install-time configuration; the harness's agent host registers a fake key to get the adapter's root and finds its code by walking four directories up from `argv[1]` | `src/native/manager-kit.js:139-146,200-306`; `native/contract.js:40`; `platform/node/adapter-process-entry.js:41` | 1, 4 | core about 30 lines; harness saves about 40 | `manager-kit.js` is shipped: a version bump that refuses existing state directories | do with the next `WORKSPACE_VERSION` bump | AR-CTRL-5 (C) |
| 29 | AR-SYN-29 | Local repetition in the hub and the handshake: `op:start-session` verification written twice (16 lines), the resolver-settle loop three times, the forward-target triage twice, pipe identity derivation twice | `src/net/peer-sessions.js:265-282,307-324`; `hub.js:1465-1479,1543-1555,2268-2280,1942-1962,2003-2022`; `pipe-network.js:80-145` | 2 | about 120 lines removed, 4 files | Low inside the package; `@endo/ocapn`'s handshake is not exported and does not persist the handshake for recovery, so do not switch to it | do now | AR-NET-9 (CS), AR-DUP-10 |
| 30 | AR-SYN-30 | The crank histogram counts wake-replay cranks with live ones, and is named "delivery" | `src/control/measured-engine.js:20-23,58-60` | 4, 5 | about 15 lines | Keep `deliveryHistogram` as an alias: the harness's `perf/concurrency.perf.mjs` reads it | do with AR-SYN-20 | AR-ONTO-6 (C), AR-VER2 missed item 5 |
| 31 | AR-SYN-31 | Two length-prefix framings over the same socket port (admin: 8 MiB, no continuation; peer: 1 MiB fragments with continuation) | `src/control/local-control.js:41-97`; `src/net/unix-netlayer.js:98-185` | 2 | a shared header reader, about 40 lines | They are two wire formats, not one written twice; unifying them breaks older clients and peers | leave (or share only the header reader with AR-SYN-11) | AR-CTRL-6 (CS) |

### 3.2 Where verification changed the fix

The verifiers corrected eleven proposed fixes. Using the original fix would break something.

- **AR-NET-1**: the defect needs no crash; a throw from `setState` or a send leaves a live hub
  half-retired. Holding `deliveryDepth` is not enough by itself: persist once, then flush every
  outbox, and flush `withGcBatch` inside the depth. Severity in effect: leaked pins and a mixed
  session, not misrouting.
- **AR-NET-3 / AR-DUP-3**: "four combinations" undercounts. Peers vary by resumability, and the
  `transient:` prefix is read at startup where no attach-time kind exists, so the kind must be
  persisted.
- **AR-NET-5**: the retired record is also the tombstone that refuses a retired token;
  `forgetSession` on `handoff:` keys would silently reopen locations. Use a tombstone table.
- **AR-NET-7 / AR-DUP-1 against AR-APPS-7**: the first two remove `THIXOTROPE_HUB_STORE=file`, the
  third makes a script require it. File mode is the harness's perf baseline; remove the
  experiments now and file mode only when the baseline goes (AR-SYN-19).
- **AR-NET-12**: a new role or derivation for the endpoint's pipe identity changes its key pair
  and location, which can be persisted. That is a state-format change, not a rename.
- **AR-CORE-2**: a memoised retire promise would rethrow for ever; reset it on failure.
- **AR-CORE-6 / AR-DUP-6**: `canSnapshot` is a mode that journal-only replay tests use, not a seam;
  `combinedDelivery` should become a refusal at boot, not be deleted silently.
- **AR-CTRL-3**: a pinned golden digest churns on every Prettier change and forces version bumps;
  record the digest in `workspace.json` instead.
- **AR-CTRL-8**: the bundle-digest check also validates `makeResource('native-adapter', ...)`;
  reword it, do not delete it.
- **AR-APPS-3**: keeping a captured recipient is a documented, tested rule; refusing tokens outside
  the current projection breaks it.
- **AR-APPS-4 / AR-DUP-2** (one finding filed twice): the per-contact `subscribeStatus` probe and
  the bridge's string `name` input are not legacy; only `legacySubscribe` and the top-level probe
  are.
- **AR-APPS-5**: `describe` cannot be hoisted out of `makeObservableMap`, which is shipped whole.
- **AR-ONTO-3**: keeping the retirement text as a prefix breaks the harness's exact match; carry
  the reason in a separate field.

### 3.3 Not verified, and cannot tell

**Checked by no verifier.** These were read by one reviewer only. Where one overlaps a verified
finding it is merged above; the rest are candidates, almost all minor:

- AR-NET-14 (dead code: `gcBatching = true`, the import-alias scan, unused hub methods),
  AR-NET-15 (`gcCounts` grows per transient session), AR-NET-17 (`resumption` belongs in
  `store/`), AR-NET-18 (untested surfaces: the tests for AR-SYN-1, -4 and -12 cover most of it).
- AR-CORE-10 (`evaluate-source.js` in core holds an Ironhorse frame cost: C-13), AR-CORE-11
  (test doubles and demos in `src`), AR-CORE-12 (an unguarded `setMeta` in the halt branch;
  `WorkerHaltError` not hardened; `globalThis.crypto` absent in a vat), AR-CORE-13 (the endpoint
  records repeat key and tombstone logic).
- AR-CTRL-10..19: a test-only mailbox placement (merged in AR-SYN-18), mail-UI methods on the
  root admin facet, small control-plane repetitions (`hasWorker`, `shipNative`), directories that
  do not say where code runs, pipe `workerId`/`role` vocabulary, admin verbs with different
  shapes, `String(error)` in `native/manager.js`, a public surface wider than its users, five
  command lists in `bin/thix.js`, and research scripts in `scripts/`.
- AR-APPS-11..15: platform files that belong to the mail UI, the control resource under
  `resources/`, an ignored bundle dependency hook and no freshness check of `dist-ironhorse`, names
  that say less than the thing (`workspace-client.js`, `MailIntroductions`), and mail validation
  written three times with different limits.
- AR-ONTO-10, -12, -15, -17..-20 (swissnum/secret/locator, stale CC terms, "adapter" used in other
  senses, binding and key, the "workspace" version that versions the whole state, two senses of
  "collect"); all are prose and fold into the glossary (section 6).
- AR-DUP-7..14: an option nobody sets, the same bytes in hex and base64 (merged in AR-SYN-10),
  three JSON-lines child clients, three backoffs, one id function under three names, five "read
  JSON if present", and demos in `src`.

**Cannot tell from the code alone.**

- Whether permanently refusing a `handoff:` location after one retirement is intended
  (`hub.js:669-683`, `:2624`). No reviewer established it, and AR-NET-5's original fix would have
  reversed it silently. The owner should decide before AR-SYN-10.
- Whether any state directory still needs the two-`eval` delivery path for a worker without
  `deliver-v1`: unlikely (the host protocol postdates it), not impossible.
- Whether OCapN calls `randomBytes` inside a vat, where `crypto` is absent (AR-CORE-12).
- The magnitude of three inferred costs: the per-frame meta read (AR-SYN-5), the peer record's
  O(n^2) rewrite (AR-SYN-10), and what dominates the Ironhorse lane (AR-SYN-23). None was measured.

---

## 4. Themes

Seven root causes explain most of the findings.

**T1. Three closures that grew by accretion.** `hub.js`, `buildDaemon` and `serveThixotrope` each
gained one job per feature. Their state is shared through mutable bindings whose order is stated
only in comments. That is how AR-SYN-1 happened: retirement runs outside the `deliveryDepth`
discipline that every other entry point keeps, and a comment claims otherwise. The seams are
already visible (session kind, gifts, diagnostics; worker table, start notices; admin facet,
config). Explains AR-SYN-1, -13, -17, -26, -27.

**T2. Concepts passed as names, not objects.** A session's kind is a prefix and seven flags; "the
callee is gone" is a string; a resource's identity is a `JSON.stringify` whose stability depends on
field order; slots and envelopes are parsed by hand; vat GC learns the hub's graph by parsing its
files. Each name has to be re-parsed at every site, and each format change has to be made in
several modules at once. This is the owner's own principle, broken where it costs most. Explains
AR-SYN-6, -7, -9, -21, -22, AR-CORE-13.

**T3. Life cycles with no owner.** The vat life cycle is split between the transport, the daemon,
the store and the hub; hub-session retirement is reused for quarantine; the endpoint is modelled
as a worker; `stop()` only requests. The confirmed defects in retirement (AR-SYN-1, -3) are where
two owners hand off. Explains AR-SYN-1, -3, -5, -9, -17, -21.

**T4. A version gate kept by hand, and compatibility code kept despite it.** `WORKSPACE_VERSION`
and the runtime digest already refuse old state directories, which is a good, simple compatibility
story. But the gate is bumped by hand (AR-SYN-2), and code for states it refuses was kept anyway
(AR-SYN-18). Many fixes in this review change shipped source; done one at a time they would cost
one bump each. Batch them. Explains AR-SYN-2, -18, -19, -28, AR-NET-14.

**T5. An application and its experiments grew inside the core.** Mail began as the demonstration
of the core's capability model and became part of its control plane, with its UI in the platform
layer and its measurement scripts, patches and traces in the package. The harness uses none of it.
Explains AR-SYN-15, -19, -24, AR-CTRL-11, AR-APPS-11.

**T6. A second engine that exists in name only.** The `WorkerEngine` interface keeps optional
members for XS and the replay doubles. XS does not build and its tests always skip, and the
doubles take paths that production never takes, so most daemon tests exercise the frame-by-frame
paths while production runs the batch paths. Explains AR-SYN-14 and part of AR-SYN-25.

**T7. Retained state bounded by history, not by need.** Private keys re-appended per commit,
retired sessions kept for ever, transient frames committed, GC counters per transient session, the
outbox and UI maps that only grow. Each is a small leak; together they are what C-2's `hub.growth`
budget keeps missing. The owner's rule ("bound retained state, not use") applies directly.
Explains AR-SYN-8, -10, -24, AR-NET-15.

---

## 5. Proposed order of work

Five steps, each one coherent change with its own tests. Lane timing (AR-SYN-23, step one) and the
test helpers (AR-SYN-25) can go in at any time.

**Step 1. Correctness and guards, no format change.** AR-SYN-1 (retirement in one commit, and no
silent un-retire at attach), AR-SYN-3 (a retirement retry that repeats its failed step), AR-SYN-4
(`appendJournal` via `appendJournalEntries`), AR-SYN-8 (empty transient queues in the serializer),
AR-SYN-12 (inbound abort on remote sessions), AR-SYN-17 (`stop()` closes), and AR-SYN-2 (the
shipped-source digest recorded in `workspace.json`). Add the per-file lane timing from AR-SYN-23.
Tests: a hub whose store throws on the Nth `setState` during retirement, plus a crash-child kill
between flush and final commit; an engine whose `releaseSnapshot` throws once; a torn single append
followed by a second append and a read; a peer that sends `op:abort`; a shipped factory edited
without a bump is refused. *Harness gains:* C-1 closed at rest; no half-retired sessions leaking
pins after a failed commit; a journal that survives a failed append; a guard that makes every later
shipped-source change safe; a lane whose cost can finally be attributed.

**Step 2. One owner for the vat life cycle** (AR-SYN-5, then C-8, C-10 and C-11 on top). The
transport holds one `state` with checked transitions, and exposes `state()`, `resume()` (the
startup loop moved out of the daemon) and `discard()`; the fs worker store caches meta; the daemon
offers `hasWorker` and `workerFailure`. Then serve before retrying crashing vats (C-8), break calls
into a given-up vat (C-10), and add reinstate (C-11). Tests: the 26 crash-loop tests unchanged as
the oracle, plus one per new transition and one per candidate. *Harness gains:* a crashing session
vat no longer blocks startup for 20-64 s; calls into a lost vat break instead of hanging; a
given-up session vat can be reinstated with its transcript, as "transcript content is never
deleted" requires.

**Step 3. Hub-state version 3, together with C-2's open part (CC-051, CC-060) and C-18.** One
format change carries: a persisted session kind with four policy records (`peer` takes
`resumable`), replacing the flags and the prefix sweep (AR-SYN-6); identity in its own table, and a
tombstone table for retired tokens and handoff epochs (AR-SYN-10); one byte encoding at rest; a
`hub.reachabilityGraph()` and `hub.sessionKeys()` that vat GC and the daemon use instead of parsing
the image (AR-SYN-7); a typed retirement break with a reason field, changed together with the
harness's `guest/lib/retired.js` (AR-SYN-9); and per-row dirty tracking. Settle the handoff-refusal
question (section 3.3) first. Tests: the outbox, coalescing, GC-batch and crash-consistency suites
as the oracle; reachability tests rebuilt through a real hub; a retired token refused after a
restart. *Harness gains:* the `hub.growth` budget and per-delivery cost under many sessions (C-2);
restart versus lost vat told by type, not by an exact string (C-18); vat GC that cannot drift from
the hub's format.

**Step 4. One `WORKSPACE_VERSION` bump for the shipped-source changes.** Decide XS (delete it, or
build it in CI) and then make the batch seams required (AR-SYN-14); remove the compatibility paths
(AR-SYN-18); give the native contract a service shape and an install-time configuration (AR-SYN-28);
serve the control socket from the host and drop the control resource (AR-SYN-16, closes C-4);
`describeError` in `native/manager.js`. Tests: `shipped-factories`, `manager-kit`, `native-install`,
`workspaces`, and the lane's supervisor tests; the step-1 digest guard proves the bump was made.
*Harness gains:* the agent host drops its fake service key and directory walk; running state
directories can be copied (C-4), which the template work needs; the replay doubles exercise the
paths production takes.

**Step 5. Structural splits, mail, and names.** Split `hub.js` along the kinds of step 3, split
`buildDaemon` after step 2 (worker table, start notices), and split `serveThixotrope` into
`admin.js` and a frozen configuration record (AR-SYN-13, -26, -27). Decide in the design whether
mail is part of the core; if not, pass host-provided installations in as a list and move mail to a
package of its own (AR-SYN-15, -24). Apply the glossary (AR-SYN-20, -21, -30) to the design, README
and comments. Tests: all existing suites, since nothing should change behaviour; a non-mail
two-supervisor scenario must replace the mailbox lane test if mail moves. *Harness gains:* core
changes touch smaller modules (five of the harness's logged core changes went through
`serveThixotrope`); a core about 15 % smaller and a Node suite about 10 % shorter if mail leaves;
documents in which "session", "workspace" and "endpoint" no longer collide between the packages.

---

## 6. Glossary proposal

This is the 38-term glossary of `core-ontology.md` section 5, adjusted by the other reviews.
Changes are marked. Bold is the word to use; brackets name words to avoid. Persisted names
(`workerId`, `workers/`, `epoch`, `refId`, `native-adapter`, `workspace.json`,
`deliveryHistogram`) are not renamed: the glossary fixes definitions, not identifiers.

**Vats and engines**

1. **vat**: one guest heap behind one OCapN endpoint, identified by its `workerId`.
2. **worker**: the host's record and machinery for one vat (store, journal, transport). In code,
   "worker" denotes the vat.
3. **incarnation**: one process of a worker or an adapter. A worker's references survive it; an
   adapter's break with it because its transient session is forgotten. [not: session epoch]
4. **sleep / wake**: the end and start of a worker incarnation, invisible to the guest.
5. **crank**: one engine evaluation of one or more deliveries plus the job drain. [not: execution
   step] *Changed:* the crank histogram counts live and wake-replay cranks; report them apart.
6. **delivery**: one journal frame handed to the engine within a crank. The snapshot cadence counts
   deliveries, GC frames included.
7. **frame**: one OCapN wire message. [not: message, duct message] **duct envelope** *(added)*: the
   host-worker wrapping of a frame (`init`, `f`), defined once.
8. **journal**: a worker's durable log of inbound frames, cut at its snapshot.
9. **snapshot**: the engine's heap artifact plus its record `{ ref, cut }`; **checkpoint** is making
   one and truncating the journal. **image** *(narrowed)*: only the hub image.
10. **life-cycle state** *(added)*: one of asleep, awake, retry owed, quarantined, retiring,
    retired, owned by the transport (AR-SYN-5).
11. **quarantine**: a vat whose `failure` is recorded, after a **halt** or after being **given up**.
    Its store is kept. *Changed:* its hub session is no longer said to be "retired"; callers see a
    typed break whose reason is `quarantined` (AR-SYN-9).
12. **engine**: an implementation of `WorkerEngine`. *Changed:* Ironhorse is the engine; XS is
    named only if it is built and tested (AR-SYN-14). The in-vat entry is the **worker bootstrap**.

**The hub**

13. **hub**: the supervisor's OCapN router; it holds tables, never values.
14. **hub state**: the hub's tables, stored as a hub image plus a hub log.
15. **hub session**: one protocol relationship in the hub, named by a session key; never a socket or
    a terminal. [not: session, unqualified, in harness text]
16. **session kind** *(added)*: worker, peer (resumable or not), transient, endpoint. Persisted on
    the session row; the key does not encode it (AR-SYN-6).
17. **session key**: a hub session's name: a `workerId`, `endpoint`, `peer:…`, `handoff:…` or
    `transient:…`.
18. **durable session**: queues frames while detached and survives restart. *Changed:* the endpoint
    is not one in the hub's sense (it attaches with `durable: false`); its durability is in the
    endpoint records.
19. **transient session**: discarded at startup. [not: ephemeral session, disposable observer,
    `discardOnRestart` in prose]
20. **session epoch**: the counter retirement bumps. [not: incarnation, generation]
21. **reference row** (row): the hub's record of one exported object or promise, keyed by `refId`.
22. **c-list** *(added)*: one session's view of the rows, kept as `ourExports` (position to row)
    and `facing` (row to position).
23. **position**: one session's index for a row. [not: slot, for the hub; "slot-rewriting"]
24. **delivery number** *(added)*: the outbox identity of a frame across hub, transport and record.
    [not: the seven names in AR-NET-12]
25. **tombstone**: a dead row that keeps holders' positions breaking loudly until released; also a
    retired token kept to refuse a reused identity *(added)*.
26. **publication** and **swissnum**: a swissnum-to-reference mapping that is a retention root.
    [not: secret, locator]
27. **sturdy reference**: a node location plus a swissnum.

**Peers**

28. **logical connection** *(added)*: the durable netlayer's resumable connection, keyed by a
    session token. **session record** *(added)*: its stored form under `sessions/<token>/`.

**The host**

29. **supervisor**: the process that owns a state directory, and its composition root.
30. **daemon**: the `ThixotropeDaemon` object inside it (hub, workers, endpoint).
31. **host**: everything trusted outside the vats.
32. **restart**: a supervisor restart. **stop / close** *(added)*: `stop()` ends with the
    supervisor closed; `closed` resolves then.
33. **host endpoint**: the daemon's one reifying session, holding host resources and
    administration. [not: pseudo-worker; `worker-session-records` names]
34. **host resource**: made by a factory registered at the host endpoint and bound by a **resource
    binding** `{ workerId?, key? }`.
35. **state version** *(changed from AR-ONTO-19)*: the version of everything the supervisor ships by
    source, recorded with the shipped-source digest; stored in `workspace.json` under its old name.
36. **shipped factory** *(added)*: a function shipped into a heap by `toString()`; whole, prelude
    only, covered by the state version.

**Native resources and installations**

37. **native resource**: an installation kind made of `durable.js` and `ephemeral.js`; not a host
    resource.
38. **manager**, **manager vat**, **manager kit**: the durable half of a native resource.
39. **adapter**: the ephemeral half: one Node process per incarnation. No other sense.
    *Added:* a **service adapter** hands its root to its manager (AR-SYN-28).
40. **launcher**: the host resource that starts adapter processes, registered as `native-adapter`.
41. **registration**: a desired entry under a **registration key**, with its **spec**, its
    **registration epoch** and its **handle**; the adapter's live object for it is its **adapter
    binding**.
42. **installation**: a registry name for an application or a native resource.

**Users and applications**

43. **workspace**: one user's vat with its inventory (and, while mail is in the core, its address
    book). The harness's per-session directories need another name.
44. **invitation** *(added)*: a capability published as text and redeemed by text (today
    `MailIntroductions`); **introduction** keeps the design's sense, the exchange of contact
    inboxes.

**Collection and durability**

45. **retire / forget**: end for good leaving tombstones; forget also deletes the record, for a key
    never reused.
46. **garbage collection / vat collection**: the engine reclaiming heap, and the host retiring
    unreachable vats.
47. **durable / ephemeral / transient**: durable survives restart; ephemeral is discarded by design
    (subscription, module); transient is for sessions and clients. *Changed:* "ephemeral vat" leaves
    the glossary with the ephemeral worker (AR-SYN-18).

---

## 7. What this review did not cover

- The Rust engine and worker (`rust/**`), apart from the facts the JavaScript side depends on
  (`deliver-v1`, the GC policy, the worker's `timing` flag).
- The harness package's own code; only its documents and its uses of the core were compared. It
  gets its own review.
- No test, lane, build or supervisor was run by any unit. AR-SYN-1 and AR-SYN-3 are confirmed by
  reading, not reproduced; costs marked inferred were not measured (section 3.3).
- Third-party gift correctness against the OCapN draft, and the growth of `usedGiftHandoffs`.
- A security read of the mail HTTP bridge (token, origin and rebinding checks) and the browser
  host's confinement.
- Whether each of the 78 test files asserts what its title claims; only the hub, mail and lane
  files were sampled.
- `src/platform/node` file powers beyond a skim; the async and sync twins and the two host records
  written through different twins (only one asserts the store lease) were noted without a finding.
- About forty minor findings that no verifier checked (section 3.3); they should be re-read before
  anyone acts on them.
