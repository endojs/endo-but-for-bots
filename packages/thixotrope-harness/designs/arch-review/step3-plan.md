# Step 3 of the harness review: target structure and build units (P3)

Unit P3 of the step-3 workflow. Read the code at `9bb9f4f2ea` (branch `claude/thix-clean`), not only
the review. Paths are relative to `packages/thixotrope-harness/`; `AH` is
`resources/agent-host/impl`. Rows are `harness.md` section 3 (fixes as corrected in 3.2) and their
status in section 8. This is the structure the build units SESSION, PROVIDERS and HOST implement
and the one the M6, M8, M9 and M11 contracts design against: a contract that adds a job names the
module below it goes into (milestones.md rule 7), and a per-session job is a runtime part (2).

Binding for every unit (from the workflow rules): behaviour-preserving unless a row below names a
behaviour change; no wire shape, persisted format, record shape, guard or user/model text changes
except where marked **behaviour change**; crank counts and messages per turn unchanged (moving code
inside a vat or inside the adapter adds no send); no manager-part file (`resources/agent-host/*.js`
outside `impl/`); names by vat or concept.

---

## 1. The turn runner (HR-SYN-4)

**Today.** `guest/session/turn.js` is 1,728 lines; `makeTurnRunner` (`:175-1727`) holds 17 `let`
bindings and these jobs: archive, context source and history made inside it (`:235-266`); ports of
the adapter incarnation (`held`, `opening`, `reopens`, `brokenSince`: `:274-283`, `:1097-1264`);
outbox and row patch (`outbox`, `pendingOwed`, `rowPatch`, `flushScheduled`: `:302-376`); usage
(`totals`, `addUsage`, `importUsage`: `:287-294`, `:937-966`, `:1676-1685`); settle, tool calls,
rounds, engine, sink (`:423-1089`); claim and cancel (`:1281-1423`); Turn exo, handles and lookup
(`:1432-1537`); import (`:1547-1612`); the delete fence (`deleting` `:226`, `:1662-1672`).
Reach-ins: `archive.unresolved` is a raw `Map` read and deleted by the runner (`:1469`, `:1479`,
`:1519`, `:1566`, `:1583`; `archive.js:280`); `export.js` reaches the archive as `runner.archive`
and the fence as `runner.beginDelete`; `session.js:120-130` builds `SessionCore` from runner
members and hands it back with `runner.attach`; `recovery.js` keeps its generation in a
module-level `WeakMap` keyed by that core. `ActiveTurn` is typed in `turn.js:124-157` and again in
`recovery.js:58-69`; the delete fence is three flags (`export.js` `deleting`, `turn.js:226`,
`archive.js` `fenced`).

### 1.1 Target modules (all under `guest/session/`)

| module | owns (private state) | interface the runner uses | moved from `turn.js` |
| --- | --- | --- | --- |
| `outbox.js` `makeOutbox({ live, rowReporter, pendingView })` | events of this crank, `pendingOwed`, `rowPatch`, `flushScheduled` | `emit(event)`, `report(patch)`, `owePending()`, `flushRow()`, `flushTo(ports)`, `schedule(flush)` | `:296-376` |
| `usage.js` `makeUsage({ contextLength })` | the session `totals` | `addRound(active, usage)` (sets `active.usage`), `settled(status)`, `totals()`, `replace(imported)` | `:88-94`, `:287-294`, `:449-450`, `:937-966`, `:1608-1609`, `:1676-1685` |
| `ports.js` `makePorts({ services, live, toolsFor, onFresh, onFailed, settled })` | `held`, `opening`, `reopens`, `brokenSince` | `held()`, `open()`, `drop(ports)` (was `dropHeld`), `broke(ports)` (raise `brokenSince`, reset `reopens`, open), `publisherBroke(publisher, inUse)` | `:268-283`, `:1093-1100`, `:1154-1228`, `:1257-1262`, `:1692-1696` |
| `turn-index.js` `makeTurnIndex({ limits })` | `turns` (infos), `handles` (recent Turns), `turnCounter` | `nextId()`, `started(info)`, `info(turnId)`, `remember(turnId, turn)`, `handle(info, mint)`, `byId(turnId, archive, mint)`, `find(...)`, `archived(dropped, archive)` (the `onSealed` body), `running()` | `:209`, `:213-224`, `:237-250`, `:1484-1537` |
| `turn-import.js` `makeTurnImport({ records, index, archive, usage, see, idle, seal })` | none | `importTurns(list)`, `importEnd()` | `:1539-1612` |
| `recovery.js` `makeRecovery({ records, queue, current, settle, hooks })` | the last recovered generation (was the `WeakMap`) | `recover(active)` (same 8 steps, same order); `isRestartSignal` stays a plain export | `recovery.js:83-193` |
| `turn-types.js` (types only, `@import`ed, so not in the bundle) | - | `ActiveTurn`, `TurnInfo`, `RoundCalls` | `turn.js:96-157`, `recovery.js:58-75` |

`archive.js` keeps `makeSessionArchive` and hides `unresolved`: `keepUnresolved(turnId, info)`
(bound `maxUnresolvedTurns` kept), `unresolvedInfo(turnId)`, `resolve(turnId)`; `fence()` and
`fenced` go (the archive reads the session's one fence, below). `history.js` and
`context-source.js` keep their signatures.

**What stays in `turn.js`** (about 900 lines): the turn's own life, which shares `current`,
`records` and the crank: claim, settle, cancel, tool calls (`issue`, `afterResult`, `runTools`),
rounds (`systemFor`, `roundRequest`, `invoke`, engine), the TurnSink and Turn exo classes,
`attachPorts` and `onLeaseBroken` (the lease, deadline and round sends are turn steps: they stay
beside settle; only the incarnation state moves to `ports.js`). Splitting tool calls further is
not proposed: they share `current`, `settle` and the crank's publish with rounds.

### 1.2 Who makes what, who calls whom

`session.js` (composition root) makes `records`, `live`, the **fence**, the **archive** (its
`onSealed`/`onNotSealed` late-bound to the runner, as `live.onStale` is today), `contextSource`,
then the runner with `{ config, services, rowReporter, records, live, archive, contextSource,
fence, getRuntime, ... }`, then the queue, lifecycle (`export.js` given `archive` and `fence`
directly) and runtime. The runner makes `outbox`, `usage`, `ports`, `index`, `history`,
`recovery`, `turnImport` and calls them; none of them imports `turn.js` or calls the runner except
through the callbacks named in its constructor. The fence is one record made in `makeSession`:
`{ close(), closed() }`; `deleteSelf` closes it, `claimNext`, `startTurn`, `maybeSeal` and
`refuseIfDeleting` read it; `runner.beginDelete()` keeps only its cancel-and-flush part.
`SessionCore` and `runner.attach({ core })` go: recovery and hooks no longer need a core
(`attach({ queue })` stays: queue and runner need each other).

Runner return members after the split: drop `archive`, `deleting`, `turnHandle`, `isLive`
(unused outside, `m2-w25-archive.test.js` asserts `deleting`: assert behaviour instead, a claim
refused after `deleteSelf`). Everything else keeps its name and meaning.

### 1.3 What must NOT change

- **Records** appended, their fields and their order in every crank: `turn-started` (with
  `attachments` labels), `dispatched`, `round-settled`, `tool-intents`, `tool-result` (incl.
  recovery's `outcome: 'unknown'`), `partial` (checkpoint, before `turn-settled`),
  `turn-settled`, `turn-resolved`.
- **The settle sequence** (`turn.js:423-507`): unwind waits, keep checkpoint, append
  `turn-settled`, count, emit `final`/`usage`/`abort|end`, `onSettle` hooks, report row, resolve
  `finished`, remember the handle, `maybeSeal` (before the claim), `claimNext` (its throw rethrown
  only after), `flushTo(ports)`, then `releaseTurn`. The claim sequence: `take(info)` before any
  record or send, `turn-started`, `onClaim` hooks, report, attach or open.
- **One publish per crank** at the same points (`flush`, `flushTo`, `invoke`, `attachPorts`,
  `scheduleFlush` for `queueChanged`); the row patch rides in the same flush. A handler that hands
  control to the engine still does not publish.
- **Crank and message counts**: every `E`/`E.sendOnly` (`open`, `holdTurn`, `armDeadline`,
  `startRound`, `cancelRound`, `releaseTurn`, `seal`, `changed`, publish) stays one call at the
  same place; no module adds a promise hop on the turn path (a `.then` that today runs in the
  answer's crank must still do so).
- **The seal protocol** (m2-interfaces 4.3-4.6): intent recorded in the crank that sends `seal`;
  records dropped only in crank Z when the answer matches the intent and still starts the log;
  crank Z publishes nothing; retry every `archiveSegmentTurns / 4` settles; no seal once fenced.
- **The SIGKILL table** of m2-interfaces 4.5 (`test/adapter/m2-archive-kill.test.js`,
  `test/integration/m2-archive-restart.test.js`): every kill point keeps its outcome.
- **Recovery's 8 steps** and their order (hold before settle); a recovery hook that throws or
  rejects is skipped; ports learned dead stay tombstones; the 3-reopen bound and the
  `since <= brokenSince` rule.

### 1.4 Order of extraction (each commit green on the unit lane)

1. `turn-types.js`; `usage.js` with `guest/lib/usage-counts.js` (4) - pure, no crank effect.
2. `outbox.js` - mechanical; the crank-order suites (5) prove the publish points.
3. The one fence; `archive.js` hides `unresolved`; archive and context source made in
   `session.js`; `export.js` takes `archive` and `fence`; drop the four return members.
4. `turn-index.js` and `turn-import.js` (history made over the index).
5. `ports.js` last: the hardest state machine, moved when the closure is already small.
6. `recovery.js` per session (`makeRecovery`), `SessionCore` gone - with section 2.

---

## 2. Per-session extension: one mechanism, the runtime parts (HR-SYN-15)

**Today.** Two mechanisms. Static append-only tables: `turn-hooks.js` (`beforeRound`, `onCancel`,
`onSettle`, `turnSources`, `recoverySteps`, `onClaim`; hooks get `{ core, active, round|item }`)
and `tool-table.js` `toolSources`; their per-session state lives in module `WeakMap`s
(`tools/exec.js:63` exec state by ExecHandle, shared with `inspect-client.js` through
`execStateOf`/`takeScope`/`retireScope`; `packages.js:121` `partOf(core)`; `recovery.js:83`).
Beside them, M5's runtime parts (`runtime-parts.js`: `powers`, `inspector`, `grants`, `packages`,
made per session, reaching each other through getters). Context bags: `SessionCore`,
`runtime.session` (`{ core, queue, runner, inCrank, refuseIfDeleting }`, used only by
`packages.js`), ToolContext, the hook context. `packages.js:135-147` `enqueueMessageOnce`
repeats `Session.enqueueOnce` (`session.js:215-224`) with attachments.

### 2.1 Target

**One mechanism: every per-session job is a runtime part.** Parts are made once per session in
table order in `makeSession`; a part's state lives in its `make` closure; hooks and tool sources
are members of the part's value, so they close over that state. No module-level state keyed by a
session's objects remains in `guest/session` (rights-amplification `WeakMap`s keyed by objects a
part itself mints, such as `granted.js:121`, are part state and stay).

The exact signature a new part implements (in `runtime-parts.js`):

```js
/**
 * @typedef {object} RuntimePart
 * @property {PartName} name     closed list in runtime-parts.js; one getter per name on Runtime
 * @property {(runtime: Runtime) => PartValue} make   called once, in makeSession, synchronously;
 *   sends nothing and awaits nothing
 *
 * @typedef {object} PartValue   what runtime.<name> answers: the part's own members, plus
 * @property {PartHooks} [hooks]
 * @property {ToolSource} [tools] (ports, services, runtime) -> ToolTableEntry[], asked every
 *   round after the static table, under the name rules of toolSetFor
 *
 * @typedef {object} PartHooks  all synchronous, called in table order in the crank named;
 *   never await, at most the crank's send budget (ARCH 12.3)
 * @property {(turn: HookTurn, item: any) => void} [onClaim]   claim crank, after turn-started
 * @property {(turn: HookTurn) => void} [beforeRound]          crank that sends startRound
 * @property {(turn: HookTurn) => void} [onCancel]             crank of Turn.cancel / deadline
 * @property {(turn: HookTurn) => void} [onSettle]             settle crank, after turn-settled
 * @property {(turn: HookTurn) => unknown} [onRecover]        recovery step 6; a throw or a
 *   rejection is skipped
 * @property {() => ({ text: string, at: number } | undefined)} [nextTurn]  a turn source, asked
 *   when idle, the queue empty and not held
 *
 * @typedef {object} HookTurn   frozen (not hardened: `active` is the runner's mutable record)
 * @property {ActiveTurn} active
 * @property {number} round
 * @property {(record: any) => void} append   into the record log, in this crank
 * @property {(event: any) => void} emit      into this crank's outbox
 */
```

`Runtime` = `{ labels, services, config, powers, inspector, grants, packages, exec, ...one getter
per later part }`; `runtime.session` and `part(name)` go (no string lookup). The runner and
recovery read one combined `runtime.hooks` (fan-outs built once in `makeRuntime`, in part table
order) and `runtime.toolSources`. Order is behaviour: the table becomes `powers, inspector,
grants, exec, packages`, which keeps today's hook order (`recoverySteps`: exec, then packages;
`onCancel`: exec; `onSettle`, `onClaim`: packages).

**One enqueue** (HR-GUEST-6): `session.js` has `enqueue(submission, requestId, at, attachments)`
(see, `queue.enqueueOnce`, claim, re-read receipt) used by both exo methods; `enqueueMessageOnce`
calls `checkAttachments` (exported by `packages.js`) first, as today, before anything is written.

### 2.2 How each static table ends

| table | fate |
| --- | --- |
| `turn-hooks.js` (all six lists) | deleted; `execHooks` become the `exec` part's `hooks`, `mentionHooks` the `packages` part's `hooks`; `turnSources` and `beforeRound` (empty) are part hooks |
| `tool-table.js` `toolSources` (`grantedToolSource`) | the `grants` part's `tools`; `toolSetFor(ports, table, services, runtime)` reads `runtime.toolSources` |
| `tools/exec.js` `states` `WeakMap` | the `exec` part's state; `execEntry` and the inspector reach it as `context.runtime.exec` (ToolContext unchanged); `abandon` keeps its early return when the turn has no running call |
| `packages.js` `partOf` `WeakMap` | gone; the part's hooks close over its table |
| `recovery.js` `recoveredGeneration` | `makeRecovery`'s own number (1.1) |
| `toolTable`, `holds-table.js`, `label-seeds.js`, `lib/prompt-sections.js`, factory `services.js`, `session-options.js` | stay static: their entries are data or pure functions with no per-session state |

`SessionOptions` keeps test overrides as `parts` (a test part with hooks) and `toolTable`; the
`hooks` and `toolSources` options go, and the tests that passed them (`m1a-session-turn`,
`_m2-w25-session.js`) pass a part. Check first that each session has its own `ExecHandle`
(`services.execVat`): the `WeakMap` shared state per handle, the part shares per session.

### 2.3 What a part may hold, and may not

May: per-session state in its closure (each collection bounded or with a delete path, ARCH 12.6);
exos it mints; services it reads from `runtime.services`; other parts through `runtime` getters at
run time (never during `make` of an earlier part); records and events through `HookTurn` in a
hook's crank. May not: module-level state keyed by session objects; the runner, queue, record log
or `SessionCore` (they are not on `runtime`); an `await` or a promise the turn waits on inside a
hook; ports beyond the turn they came with; per-connection or viewer objects (ARCH 12.7);
data-dependent record keys (12.10); state that must survive export/import or a vat restart (that
belongs in records). A part changes the session bundle: state its bytes.

### 2.4 How the next milestones add parts (contracts design against this)

- **M6** workspace and container: a `workspace` part (name by concept, rule 1) made from
  `runtime.services` (the factory adds the service through its static `services.js` and
  `session-options.js` resolvers), with `hooks.onCancel` (stop the environment's running command),
  `hooks.onRecover`, `hooks.onSettle` as needed, and its tools as a `tools` source or static
  entries reaching `context.runtime.workspace`. One getter in `runtime-parts.js`.
- **M8** compaction: a `compaction` part with `hooks.beforeRound` appending its record through
  `HookTurn.append`; the archive and context source stay in `archive.js`/`context-source.js` and
  `usage.js` (the context reading), never in `turn.js`.
- **M9** mail and subagents: an `inbox` part (`hooks.nextTurn`, `hooks.onRecover` for child
  asks) and a `subagents` part; their tools as `tools` sources. Revisit the `restart` hold in
  `claimNext` (R4-65) in the runner, not in a part.
- **M11** voice: a session-side part only if voice keeps per-session state in the vat; feeds use
  the shared channel subscriber (4).

---

## 3. The provider seam (HR-SYN-3 (a))

**Today.** `AH/providers/anthropic.js:750-857` and `openrouter.js:565-676` are the same 90-line
shell (running map, round control, `runProviderRound`, retry with log, transcript fallback);
`subscriptions/provider.js:96-317` is a third copy of the shell; `scripted.js:291-842` is a second
round engine with its own `makeRoundControl` copy (`:232-270`); `makeEventLog` lives in
`scripted.js` and is imported by real providers, `round.js`, `index.js` and `tools/echo.js`;
backend kinds are matched by strings in `providers/catalog.js:433-440` (`readerFor`), `:823`
(OpenRouter id shape), `subscriptions/catalog.js:562,639`, and by `subscriptions.handles(spec)` in
`index.js:449-466`; `BackendKind.makeProvider`'s `startRound` is typed with 3 parameters and
called with 4.

**Target.**

- `AH/providers/event-log.js`: `makeEventLog`, `EventLog` (moved, unchanged).
- `AH/providers/shell.js`: `makeProviderShell({ timers, runRound })` -> `Provider { startRound(req,
  channel, prepare, owner), cancelRound(turn), releaseTurn(turn) }`; owns the turn -> control map
  and makes each round's control with `round.js` `makeRoundControl`; `runRound(req, channel,
  control, prepare, owner)`. The one `Provider` typedef (4 parameters).
- `AH/providers/api.js`: `makeApiProvider({ wire, label, spec, readKey, timers, log, blobs,
  fetch, now, retry })` = shell + `runProviderRound` + a stream that does, in today's order:
  `wire.model(req)` (may throw `ProviderFailure`), key, system text, projection transcript,
  `wire.body(...)`, retry with `wire.delay` logging `retry`, `wire.attempt(...)` at
  `baseUrl + wire.path`. `anthropic.js` and `openrouter.js` keep their wire functions and export a
  `wire` record and their kind; their `make*Provider` become `makeApiProvider` calls.
- Pools: `makePoolProvider` keeps its member loop as its stream, under `makeProviderShell`.
- Scripted: `makeScriptedProvider` uses `makeProviderShell` and `round.js`'s control; its
  `runRound` stays the scripted source until plan item (b) replaces it by a scripted stream under
  `runProviderRound` - last and alone, with the perf pass, because most integration and perf files
  depend on its timing (`harness.md` HR-SYN-3 risk).
- `AH/providers/kinds.js`: `backendKinds`, `BackendKind`, `assertBackendKinds` and
  `kindOf(spec)` (the one place `spec.kind` is matched), moved out of `index.js`, with the
  scripted entry exported by `scripted.js` as `scriptedKind`. `BackendKind` = `{ kind,
  makeProvider, tools, unexpectedFailure (required), catalog({ models, pools }) -> catalogue,
  readModels?({ spec, fetch }) -> (key) => models, acceptsModelId?(id) }`; pool kinds carry
  their provider (`providerOfKind`), read by the pool catalogue instead of `spec.kind === ...`.
  `index.js` asks `kindOf(spec).catalog(...)` instead of `subscriptions.handles(spec)`.
- `prepare` required by the API shell and the pool provider (the endpoint always passes it): the
  `req.append` transcript fallback goes (**behaviour change** on a path only tests take; the adapter
  tests pass a `prepare` built from `AH/projection.js`).

---

## 4. Single homes

| row | one home | users | note |
| --- | --- | --- | --- |
| HR-SYN-17 catalogue | `AH/providers/catalog-core.js`: `makeCatalogOwner({ read, readKey, now, log })` (single flight, fresh/usable/due, `admitting`, stats) and `makeOwnerTable(maxOwners)`; `pageOf` and `boundedJson` stay in `providers/catalog.js`/`http.js` | `makeCatalog` (owner per Backend) and `makePoolCatalog` (owner per member) | bounds stay parameters: body 16 MB (API) and 8 MB (pool), owners `4 * maxBackends` and `2 * maxMembers`; diff the two owners first, each difference a parameter; `ANTHROPIC_VERSION` only in `anthropic.js` |
| HR-SYN-28 preview | `guest/lib/record-preview.js`: `previewRecord(record, { isStaged })` and `PAGE_SLACK`, `PREVIEW_INTENTS_BYTES`, `TURN_PREVIEW_KEYS_BYTES` | `guest/session/history.js` (keeps its `WeakMap` cache), `AH/archive/history.js` (with `isSealedField`) | a test compares a kept and an archived page of the same turn |
| HR-SYN-24 usage | `guest/lib/usage-counts.js`: `addCounts(into, next)` (named keys) and `sessionContext(reading, contextLength)` (R4-33: whole reading, catalogue window) | `guest/session/usage.js`; `token-usage.js` `addUsage` builds on `addCounts` and keeps its own clamp and field-wise rule | both rules written in `m2-interfaces.md` 12; `journal-usage.js` stays an independent oracle (3.2) |
| HR-SYN-25 subscriber | `AH/channel-subscriber.js`: `makeSubscriber({ guard, exoName, queueLimit, queueBytes, onClose })`, `makeRevReorder({ limits, schedule, deliverBatch, onGap })` | `channels.js`, `list-channel.js` | close reasons kept by key in both, wire text unchanged; schedule stays injectable |
| HR-SYN-26 atomic write | `AH/files.js`: `writeFileAtomic(path, data, options)`, `writeFileAtomicSync`, `syncDirectory(dir)`; options cover today's differences: scratch name (`.tmp`, `.part`), mode, chmod, `trace` with the step names `write`/`fsync`/`rename`/`fsync-dir`, scratch removal on error, directory fsync on or off | `archive/store.js`, `context-file.js` (2), `mirror.js`, `segment.js`, `secrets/store.js` (entries, audit), `blobs.js` | each call site keeps its exact syscall sequence; deliberate caches keep no directory fsync, stated at the call; a writer the options cannot express stays and is listed |
| HR-SYN-5 (a) key | `AH/secrets/wrapping-key.js`: `makeWrappingKey({ keyFile, stateDir })` -> `{ get() }` (one load per incarnation, in-flight shared, a failure not kept: **behaviour change**, retry) and `loadWrappingKey` | `makeSecretStore`, `makeSealKeys` take the object, made once in `index.js`; `gateway/signin.js` imports `loadWrappingKey` from here and keeps its retrying cache | the sign-in file taking the same object waits for the next gateway change |
| HR-SYN-21 rest | the key file as `spawnSupervisorChild`'s `secretsKeyFile` option (exists, `test/template/index.js:104`) | `_m3-gateway.js` `useTestWrappingKey`, `m2-secrets`, `m2-providers`, `m2-catalog` stop setting `process.env` | - |

---

## 5. Build units

All three can run in parallel; files are disjoint except two hand-overs, named. Every unit: unit
and adapter tests directly (`corepack yarn test <files>`), integration through `corepack yarn
test:integration --jobs N <files>`, `corepack yarn lint` (types, eslint, duplicates) before each
commit; commit subjects end `(P3)` and name the HR-SYN row; the duplicate ceiling may only go
down (lower it in the commit that lowers the share).

### SESSION (guest; rows HR-SYN-4, -15, -24 vat side, -28 vat side, -36, HR-GUEST-11, -12)

Files: `guest/session/turn.js`, `session.js`, `recovery.js`, `archive.js`, `export.js`,
`history.js`, `runtime-parts.js`, `packages.js`, `tool-table.js`, `turn-hooks.js` (deleted),
`tools/exec.js`, `tools/inspect-client.js`, `tools/mentions.js`, `tools/granted.js`; new
`guest/session/outbox.js`, `usage.js`, `ports.js`, `turn-index.js`, `turn-import.js`,
`turn-types.js`, `guest/lib/usage-counts.js`, `guest/lib/record-preview.js`; `guest/lib/
journal-usage.js` (comment only, if any); factory: `guest/factory/factory.js`, `delete.js`,
`pool.js` (one start count, incremented before pool and deletions read it), `main.js` and
`root.js` plus `guest/lib/guards/factory.js` (HR-GUEST-12: the start-listener failure reported in
`status()`: **behaviour change**, one optional `HarnessStatus` field; check the gateway vocabulary
test); `designs/m2-interfaces.md` 12 (the two usage rules). Tests: the unit files below that build
a session with `hooks`, `toolSources`, `recoverAfterRestart` or `runner.deleting`
(`m1a-session-turn`, `m1a-recovery`, `m2-w25-archive`, `_m2-w25-session.js`, `m1b-exec-tool`,
`m5-w53-session`, `m5-w57-packages`, `m5-w56-grants`, `m5-w55-powers`, `m5-w53-labels`,
`m5-w57-composer`, `_contract-tables.js`, `m1a-queue.bench.mjs`) and the factory start-count
tests; a new kept-against-archived preview test.

Order: 1.4 steps 1-5; then section 2 (exec part, packages hooks, grants tool source, one enqueue,
`makeRecovery`, `turn-hooks.js` deleted); then `record-preview.js` (commit it early enough for
HOST, see hand-overs); then the factory rows. Guest edits are batched: integration runs once on
the final tree, not per commit.

Proof of no behaviour change: the whole unit lane after every commit (crank-order suites
`m1a-session-turn`, `m1a-recovery`, `m1b-qc`, `m2-w25-archive`, `m2-w27-*`, `m1a-session-growth`,
`m1a-session-program`); then `corepack yarn test:regression:core` and the M5 list
(`test:regression:milestones`, which rebuild templates: about 3 minutes); bundles before and after
(`node scripts/bundle-guest.mjs`; session now 206,907 of 240,000; seven new runtime modules at
about 1.2 KB each [inferred, J-9933] minus `turn-hooks.js` and the copies: expect about 213-216 K);
for the PM's mini-pass, the delivery-counting rows of `perf/turn`, `session`, `exec`, `mentions`
and `archive` must not move. Leave alone: `guest/lib/guards/session.js` and `base.js`, `queue.js`,
`live.js`, `records.js`, `context-source.js`, `exec/**`, every `resources/**` file.

### PROVIDERS (adapter; rows HR-SYN-3 (a), -17)

Files: `AH/providers/*.js` (new `event-log.js`, `shell.js`, `api.js`, `kinds.js`,
`catalog-core.js`), `AH/subscriptions/catalog.js`, `AH/subscriptions/provider.js`,
`AH/endpoint.js`, `AH/index.js` (kinds, event log, catalogue choice; and HOST's key wiring, see
hand-overs), `AH/tools/echo.js` (the `EventLog` type import); import lines of the tests and perf
files that take `makeEventLog` or kinds from `scripted.js`/`index.js` (`test/adapter/_m1b-blobs.js`,
`m1a-agent-host`, `m1b-blobs-provider`, `m1b-blobs.bench.mjs`, `m1b-context-cache`,
`m2-w26-scripted`, `test/integration/_m1b.js`, `m1a-slice`, `m2-turns`, `perf/turn.perf.mjs`);
adapter provider tests that call `startRound` without `prepare`.

Order: event log; shell (scripted and pools onto it, their copies deleted); `api.js` (Anthropic,
OpenRouter); `kinds.js` with `catalog`/`readModels`/`acceptsModelId`, string matches gone;
`catalog-core.js` and `ANTHROPIC_VERSION`; `prepare` required last. Proof: adapter lane against
the fake servers (`m2-w21a-*`, `m2-w21b-*`, `m2-w22-catalog`, `m2-w26-*`, `m4-provider*`,
`m4-catalog`, `m4-pool*`, `m4-wire-*`, `m1a-agent-host`); integration `m2-turns`, `m2-catalog`,
`m2-providers`, `m1a-slice` and the M4 pool files; event-log lines and `servedBy` unchanged (perf
reads them). Leave alone: `round.js`'s `runProviderRound` body, `retry.js`, `sse.js`, wire
encoders, `subscriptions/` files other than the two named (`accounts.js`, `renewal.js` bounded
readers stay; `index.js` `handles` stays if still used there), the manager part.

### HOST (adapter; rows HR-SYN-25, -26, -5 (a), -21 rest, -28 adapter side, -35)

Files: `AH/channels.js`, `AH/list-channel.js`, new `AH/channel-subscriber.js`, new `AH/files.js`,
`AH/archive/store.js`, `context-file.js`, `mirror.js`, `segment.js`, `history.js`, `AH/blobs.js`,
`AH/secrets/store.js`, `seal.js`, new `secrets/wrapping-key.js`, `AH/gateway/signin.js` (its
`loadWrappingKey` import line only), `AH/gateway/server.js` and `package.json` (HR-SYN-35: drop
`ws` if the lockfile change stays inside this workspace's entry, else report; validate a received
close code and the reason's UTF-8: **behaviour change**), `test/integration/_m3-gateway.js`,
`m2-secrets`, `m2-providers`, `m2-catalog` (key file option).

Order: wrapping key (with the hand-over); `files.js` writer by writer, each with its kill-point
test; channel subscriber; HR-SYN-21; HR-SYN-35; archive history preview last. Proof: adapter lane
(`m1a-channels`, `m1a-channel-bounds`, `m1b-pool-list-channel`, `m2-archive-kill`,
`m2-archive-store`, `m1b-blobs-store`, `m2-secret-writer-paths`, `m2-w23-secrets`, `m4-key-race`,
`m4-secrets-full`, `m3-w31-signin`, `m3-w32-wire`); integration `m2-secrets`, `m2-archive-restart`,
`m2-history`, the M3 gateway files; `m1a-channels.bench.mjs` before and after. Leave alone:
`impl/subscriptions/account-file.js`, the rest of `gateway/`, `scripts/*` writers, `composer.js`,
`context-cache.js`, the manager part.

### Hand-overs (the only shared files)

- `AH/index.js` belongs to PROVIDERS. HOST's change there (make one `makeWrappingKey` per
  incarnation in `secrets()` and pass it to `makeSecretStore` and `makeSealKeys`) is HOST's first
  commit, small and alone; PROVIDERS starts its `index.js` edits after it.
- `guest/lib/record-preview.js` is SESSION's; HOST's `archive/history.js` switch waits for that
  commit and is HOST's last step (not done if SESSION has not landed it).

---

## 6. What step 3 deliberately does not do

- **The manager part** (`resources/agent-host/durable*.js`, HR-SYN-2, -11's reinstall, -13's
  `logPath`, `Registration`): each change is a reinstall that breaks live references and the W13.2
  migration does not exist; it is step 4, one batch. Step 3 keeps every manager-facing shape.
- **The UI controller** (HR-SYN-6): (a) is step 5 with the test-support layer, (b) is a plan item;
  no browser file is touched here, so no browser lane is needed.
- **The test-support layer, fakes on real guards, renames** (HR-SYN-14, -16, -29): step 5, after
  the code they wrap stops moving; doing them now would move 5,000 lines twice.
- **The scripted double on the shared round** (HR-SYN-3 (b)), **HKDF subkeys** (HR-SYN-5 (b)),
  **unique scratch names** for atomic writes: format or timing changes that need their own design
  and the perf pass.
- **The gateway extension registry** (HR-EDGE-7, HR-SYN-7's loader): gateway, outside the three
  units.
