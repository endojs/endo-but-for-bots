# M1a interface contract

Unit W1a.0 of `milestones.md` M1a. This file and `guest/lib/interfaces.js` + `guest/lib/limits.js`
are the contract the six M1a builders (W1a.1-W1a.6) and the slice tests (W1a.7) build against
without talking to each other. Where this file and the code disagree, the code's guards win and
this file is wrong: report it. Paths: `H/` = `packages/thixotrope-harness/`, `AH/` =
`H/resources/agent-host/impl/`, `pkg/` = `packages/thixotrope/`. Spec items are `R4-n`
(`endo-harness-spec.md` Part I section 4) and `A.4` (Appendix A.4).

Contents: 1 rules every unit follows; 2 who builds what (table); 3 objects, holders and methods;
4 records; 5 live channel events and the fold; 6 a turn crank by crank; 7 restart, retired breaks
and recovery; 8 queue; 9 factory, session creation and provisioning; 10 scripted provider and
echo; 11 module entry points; 12 hook tables; 13 fixed texts; 14 measurements; 15 decisions this
contract made (deviations and open points).

---

## 1. Rules every unit follows

1. **Objects, not names.** Methods take and return objects (`Session`, `Turn`, `QueueEntry`,
   `Backend`, `SessionHostFacet` ...). Strings remain only for F.2 reasons: human labels (title,
   preset and backend labels), the model boundary (tool names, tool argument JSON, call ids), text
   leaving the system (`logPath`, `modelId`), page re-finding (session key, history cursor, entry
   key, turn id), idempotency (`requestId`). Turn ids, op ids, entry keys and session keys are vat
   counters (`t<n>`, `t<n>/r<round>/c<ordinal>`, `q<n>`, `s<n>`; architecture 8).
2. **Guards.** Every exo crossing between units is `makeExo(name, interfaces.<Name>, methods)`
   with the guard from `interfaces.js`; no unit writes its own guard for these objects. Methods
   whose guard is `M.callWhen` are implemented `async` (the guard awaits the result before checking
   it); `M.call` methods are synchronous. Vat-internal objects (the tool table, the queue module,
   the record log) are plain hardened records, not exos.
3. **Closed records, fixed keys.** Every record crossing a vat boundary matches a shape in
   `shapes` (closed: `M.splitRecord(required, optional, {})`; an extra key is refused). No record a
   vat receives or builds may have data-dependent keys (rule 12.10): model and tool JSON is text,
   data-keyed collections are `Map`s inside a vat. A vat never `JSON.parse`s model or tool JSON:
   argument validation happens in the callee (the adapter tool), and in M1a every tool is an
   adapter tool.
4. **Sizes, on the sending side** (rule 12.5). The real bound is per message: the sum of the UTF-8
   bytes of every string in one message (record keys included) is at most `frameBytes` (24,576),
   in both directions, and a crank sends at most `crankOutBytes` (196,608) and `sendsPerCrank`
   (100) messages. Guards bound string length in UTF-16 units and array length; they run after
   decoding, so they do not protect the receiver. Senders measure with `bounded.js`:
   `fitsFrame(value)` takes the cheap estimate (units x 3) first and measures exact UTF-8 bytes only
   when the estimate is over the budget. **Exact measurement is available in vats**: `TextEncoder`
   is a global there (native, J-0110; W1a.0 probe: `typeof TextEncoder === 'function'`,
   `encode('a€b').length === 5`). Node adapters measure exactly (`Buffer.byteLength` or the same
   helper).
5. **No staging in M1a.** Text fields are inline. The Composer refuses a submission over
   `inlineBytes` (8,192 bytes); the adapter refuses any message into a vat over `frameBytes` and
   fails the round or the tool call with `texts.frameLimit` instead. M1b adds Blobs.
6. **Sends per crank.** No crank sends more than `callWindow` (16) tool calls plus four other
   messages (publish, row change, next round or lease release, open). Fan-out is the adapter's job.
7. **Guest rules** (architecture 12) apply to `H/guest/**` and are linted.
8. **Prelude in Node.** `guest/lib/*.js` read `M`, `makeExo`, `harden`, `E`, ... from `globalThis`.
   A Node process (unit test, adapter test, the agent-host adapter) must put the prelude there before
   the first import of a guest module:
   - unit and adapter tests: `import './_m1a-prelude.js';` as the **first** import of the test file
     (`H/test/unit/_m1a-prelude.js`; from `H/test/adapter/` import `'../unit/_m1a-prelude.js'`).
     ES modules evaluate their imports in order, so later imports see the globals. Tests run under
     `ses-ava` lockdown (`corepack yarn test <file>`).
   - the agent-host adapter (W1a.2): `installGuestPrelude()` from `H/scripts/guest-prelude.js`
     must have run before any module that imports `guest/lib/` is evaluated. The loader
     (`ephemeral.js`) calls it and only then `import()`s `impl/index.js` (D-14); W1a.2 arranges
     this, and `AH/*` modules may then import `guest/lib/*` statically.
   - `H/scripts/guest-prelude.js` imports the core's own prelude record
     (`pkg/src/guest/prelude.js`) by relative path, so Node sees exactly a vat's vocabulary.
   - ESLint: Node code that imports `H/guest/**` by path needs
     `/* eslint-disable import/no-relative-packages */` around those imports (the guest tree is
     its own private package); see `H/test/unit/m1a-interfaces.test.js`.
9. **Lazy guards.** `shapes` and `interfaces` are hardened tables whose properties are built on
   first read and kept (section 14: building every guard at load costs a vat 0.55-0.7 s; lazily, a
   session vat pays about 0.2 s once, on first use). Read them where you use them
   (`interfaces.Session`, `shapes.TurnRecord`); never enumerate them in a vat on a hot path.
10. **Time is data.** Vats have no clock. `at` (ms since the epoch, a number) arrives on
    `enqueueOnce` (stamped by the Composer), on `roundFinal`/`roundFailed` (stamped by the adapter)
    and optionally on `startTurn`; the session keeps `lastKnownTime` = the latest `at` it has seen
    and stamps its own records with it.

---

## 2. Who builds what

| unit | builds (files) | imports from other units (exports in section 11) |
|---|---|---|
| W1a.0 | `guest/lib/{interfaces,limits}.js`, `designs/m1a-interfaces.md`, `test/unit/m1a-interfaces.test.js`, `test/unit/_m1a-prelude.js`, `scripts/guest-prelude.js` | - |
| W1a.1 guest lib | `guest/lib/{turn-engine,reply-fold,transcript-records,bounded,retired}.js` + their unit tests | W1a.0 `limits`, `textOf.truncationMarker` |
| W1a.2 agent host + attach | `resources/agent-host/{durable,ephemeral}.js`, `AH/{index,attach,endpoint,timers}.js`, `AH/providers/scripted.js`, `AH/tools/echo.js` + adapter tests | W1a.0 all; W1a.1 `bounded.js` (`fitsFrame`, `utf8Bytes`, `boundToolOutput`, `cutText`), `retired.js`; W1a.3 `makeChannelRegistry`, `makeLive`, `makeComposer`, `channelTaps` |
| W1a.3 channels | `AH/{channels,channel-taps,live-service,composer}.js` + adapter tests | W1a.0 all; W1a.1 `reply-fold.js` (`makeReplyFold`, `makeFoldableStatus`), `bounded.js` (`utf8Bytes`) |
| W1a.4 session turn | `guest/session/{main,session,turn,turn-hooks,records,live,tool-table}.js` + unit tests | W1a.0 all; W1a.1 `turn-engine.js`, `bounded.js`, `retired.js`; W1a.5 `makeQueue`, `recoverAfterRestart` |
| W1a.5 queue + recovery | `guest/session/{queue,recovery}.js` + unit tests | W1a.0 all; W1a.1 `bounded.js` (`previewText`), `retired.js`; W1a.4 `turnHooks` (`recoverySteps`), and the `SessionCore` it passes in (section 11) |
| W1a.6 factory + provisioning | `guest/factory/{main,root,factory,services,session-options,rows}.js`, `scripts/{provision.mjs,provision-steps.js}` + unit tests, `test/integration/m1a-provision.test.js` | W1a.0 all; W1a.1 `retired.js`, `bounded.js` (`chunkText`); W1a.4 the session program's namespace (`makeSpareMaker`, via the bundle); W1a.2 the native resource directory `resources/agent-host/` |
| W1a.7 slice tests + perf | `test/integration/m1a-slice.test.js`, `perf/{turn,restart,session}.perf.mjs`, `test/fixtures/scripts/*` | everything above through public objects only; `scripts/provision-steps.js` `provision` for `ensureTemplate({ id: 'm1a', provision })` |

`test/fixtures/scripts/` (scripted-provider scripts as JSON or JS modules exporting a `Script`)
belongs to W1a.7; W1a.2 may add fixtures it needs for adapter tests under `test/adapter/`.

---

## 3. Objects, holders and methods

Columns: **caller** (vat, adapter, gateway/test, manager); **crank** (the step of section 6 where
it happens, or "any"); **mode** (answered `E()` or `sendOnly`); **max** (largest message in bytes,
string content, either direction); **retired break** (what a rejection with "ocapn hub: the target
session has been retired" means at this call site; section 7 for the actions).

### 3.1 Session vat (W1a.4, W1a.5)

**`Session`** — made by `SpareMaker.make`; held by the factory (index, `findSession`), the
Composer and the gateway (through the factory), tests. Lives in the session vat.

| method | caller | crank | mode | max | retired break (caller's view) |
|---|---|---|---|---|---|
| `getInfo() -> SessionInfo` | test, gateway | any | answered | < 2 KB | session vat lost |
| `rename(title)` | test, gateway | any | answered | ~1 KB | session vat lost |
| `watch() -> WatchSnapshot` | test, gateway | any | answered | < frameBytes (pending previews) | session vat lost |
| `enqueueOnce(submission, requestId, at) -> Receipt` | Composer (adapter), tests | A | answered | ~8.4 KB | Composer: session vat lost; the Composer rejects to its caller |
| `getSubmissionReceipt(requestId) -> Receipt \| undefined` | Composer, test | any | answered | < 1 KB | session vat lost |
| `listPending() -> PendingView` | test, gateway | any | answered | <= frameBytes (previews are cut to fit, section 8) | session vat lost |
| `startTurn(submission, at?) -> Turn` | test, gateway | A | answered | ~8.4 KB | session vat lost |
| `getCurrentTurn() -> CurrentTurn \| undefined` | test, gateway | any | answered | < frameBytes | session vat lost |
| `getHistoryPage(cursor?) -> HistoryPage` | test, gateway | any | answered | <= frameBytes (W1a.4 cuts the page by bytes) | session vat lost |

Return guards of `getHistoryPage` and `getCurrentTurn` (J-0243, J-9156): the value matches
`shapes.HistoryPage` / `shapes.CurrentTurn`, but the guard checks only the structure and bounds
(at most `historyPageTurns` turns, at most `historyTurnRecords` records per turn, the closed
`TurnPreview` record with its ids and state) and each record only with `M.key()`. Every record was
matched against its closed shape when it was appended (`records.js`, one `M.splitRecord` chosen by
`kind`), and a preview only shortens strings or drops trailing intents, so checking each record
against the `M.or` of the eight record shapes again on every read was pure cost. Cost model: the
strict guard is one `M.or` attempt sequence per record (Node 18.7 ms for a full page of 28 turns
of 8 records, about 84 us per record; a vat pays about 120 ms per 8-record turn, J-0243); the
structural guard is one `M.splitRecord` per turn plus one memoized pass-style test per record
(Node 0.69 ms for the same page, about 3 us per record; `test/unit/m1a-session.bench.mjs`).
`M.record()` was not used: it walks every entry of every record (Node 6.4 ms for the page).
| `getUsage() -> UsageTotals` | test, gateway | any | answered | < 1 KB | session vat lost |

- `startTurn` refuses with `texts.activeTurn` (R4-10) while a turn is current (state `running` or
  `cancelling`). It does not take the queue's entries or holds into account (A.4 direct start).
  `at` defaults to `lastKnownTime`.
- `enqueueOnce` and `startTurn` take `{ text }` (at most `submissionUnits` units; the Composer has
  already refused anything over `inlineBytes` bytes). Text that is empty or only whitespace
  (`text.trim() === ''`) is refused with `texts.blankSubmission` before anything else (no receipt,
  no entry, no turn; J-9150); other text is kept exactly as given, blanks included.
- `watch()` returns `{ rev, info, pending, usage, current? }`; the transcript comes from
  `getHistoryPage` (section 5 for `rev`).
- `getHistoryPage(cursor?)`: newest turn first, at most `historyPageTurns` (32) turns and
  `frameBytes`; each `TurnPreview` lists that turn's records in order (`TurnRecord` shapes) with
  text fields cut to previews (`messagePreviewUnits` for input/text/final, `toolPreviewUnits` for
  args/result, R4-46 marker not used for previews) and `cut: true` when anything was cut or more
  than `historyTurnRecords` records exist. `next` is an opaque cursor (`h<n>`); an unknown cursor
  throws `texts.badCursor`. Full contents arrive in M1b (`getTurnContent`).
- `getCurrentTurn()` returns `{ input, turn, history }` where `history` is the current turn's
  `TurnPreview` (A.4 reload re-attach), or `undefined` when idle.

**`SessionInternal`** — made with the Session; held only by the factory.
`rowSnapshot() -> RowPatch` (all four fields): answered, tiny; the factory's probe (section 9).
Retired break: session vat lost; the factory marks the row `lost`.

**`Turn`** — made in the claim crank (A); held by whoever started or re-attached (Receipt,
`startTurn`, `getCurrentTurn`, history pages) and by the adapter (lease key, round key). The
session keeps the current turn's Turn; a settled turn is a plain record (`TurnInfo` and the record
log), and its Turn is minted from that record whenever a page or a receipt hands one out (J-9152,
C-7). The session keeps the `retainedTurnHandles` (32) most recently handed-out Turns of settled
turns, so a page read again hands out the same objects; an older turn's Turn may be a new object
that answers exactly as the first (same record). Compare turns by `turnId`, not by identity.

| method | caller | mode | notes |
|---|---|---|---|
| `getStatus() -> TurnStatus` | test, gateway | answered | `{ turnId, state, round, at, error?, resolution? }` |
| `cancel()` | test, gateway | answered | section 6.4; no-op when settled |
| `whenFinished() -> TurnStatus` | test, gateway | answered, settles when the turn settles | a settled turn answers at once; after a restart a turn settled by recovery answers at once |
| `resolve(note)` | test, gateway | answered | only while the session is idle and `state === 'outcome-unknown'`, once; records `TurnResolved`; else throws `texts.activeTurn` (a turn is current), `texts.resolveNotUnknown`, or `texts.turnAlreadyResolved` (a second resolve; J-9150) |

**`QueueEntry`** — one exo per waiting entry, made in the `enqueueOnce` crank; held by receipts
and pending rows. `describe() -> EntryInfo` (throws `texts.entryGone` once claimed or cancelled);
`cancel() -> boolean` (true if it was waiting and is now removed). Edit and send-now are M2.

**`TurnSink`** — one exo per turn (W1a.4), passed in every `startRound`; held by the adapter for
that turn. Every call names its round; a call for a settled turn or another round is ignored
(answered `false` for `dispatching`).

| method | caller | crank | mode | max | notes |
|---|---|---|---|---|---|
| `dispatching(round) -> boolean` | adapter, round 0 only, before any provider request | C | answered | tiny | records `Dispatched`; answers `true` to proceed, `false` if the turn was cancelled or settled. The adapter sends nothing to the provider unless it got `true`. |
| `roundFinal(RoundResult)` | adapter | D | sendOnly | <= frameBytes (adapter-checked) | section 6.2 |
| `roundFailed(RoundFailure)` | adapter | D | sendOnly | <= frameBytes (`partial` cut to fit) | records `Partial` (if any text) and `TurnSettled{failed, error: reason}` |
| `deadline({ opId })` | adapter timer | any | sendOnly | tiny | M1a: no armed deadline uses it (turn deadline off, exec in M1b); an unknown opId is ignored |

**`ContextSource`** (shape only; M1b builds it): `page(cursor?) -> { records, next? }`.

**`SpareMaker`** — the completion value of the session program's evaluating crank
(`makeSpareMaker()`, section 9); held by the factory. `make({ config, services, rowReporter }) ->
{ session, internal }`, answered, once per vat (a second call throws). Small message (< 2 KB).
Retired break: the new session vat halted or was given up while making; the factory rolls the
creation back.

### 3.2 Agent-host adapter objects (W1a.2, W1a.3) — transient

All live in the agent-host adapter process and die with it; after a restart every reference a
vat holds to one is a tombstone (answered calls break with the retired text, `sendOnly` is
dropped silently).

**`Endpoint`** (W1a.2) — one per `Backend.open`, so one per session per adapter incarnation; held
by the session vat for every turn of that incarnation (J-9151).

| method | caller | crank | mode | max | retired break |
|---|---|---|---|---|---|
| `holdTurn(turn)` the lease, once per turn (and incarnation): settles `undefined` when `releaseTurn(turn)` arrives | session | A (held ports), B (after an open) | answered (pending all turn) | tiny | **restart**: after `Dispatched`, `recoverAfterRestart()`; before, reopen and classify (section 7) |
| `releaseTurn(turn)` | session | settle crank | sendOnly | tiny | (dropped) |
| `startRound(RoundRequest)` | session | A or B (round 0), last tool-result crank (round n) | sendOnly | <= frameBytes (session-checked) | (dropped; the lease break reveals the restart) |
| `cancelRound(turn)` | session | cancel crank | sendOnly | tiny | (dropped) |
| `armDeadline({ turn, opId, ms })` / `disarm({ turn, opId })` | session | any in a turn | sendOnly | tiny | (dropped) |

A second `holdTurn` for the same turn returns the same pending lease. `releaseTurn` also disarms
the turn's timers and forgets it. The adapter's `startRound` must not run a round for a turn it
holds no lease for (it answers nothing; the session's lease is pending in the same crank anyway).

**`LivePublisher`** (W1a.3) — the publisher facet of one session's channel. Held by the session
vat: in a turn from its held `TurnPorts.publisher`, outside a turn the last publisher it used or one
from `SessionHostFacet.liveChannel()`.
`publish({ rev, events })`: **sendOnly inside a turn**, **answered outside a turn**; at most
`publishBatchEvents` (64) events and `frameBytes` per call; retired break on an answered publish:
the adapter restarted (not a turn-path signal): the session stops holding ports with that
publisher (unless the current turn uses them; its lease will tell), gets a fresh publisher with
`E(host).liveChannel()` and publishes once more; never run recovery for it.

**`AdapterTool`** (W1a.2; M1a: `echo`) — reached through `TurnPorts.tools`. `execute({ opId, args })
-> ToolOutcome`: answered, issued in crank D (or a tool-result crank), result <= frameBytes
(callee-checked). A rejection is a tool failure (`Error: <message>`, failed) **unless**
`isRetiredBreak(error)`: then it is a **restart** (recovery; never recorded as a tool failure).

**`Live`** (W1a.3) — gateway-local; tests get it from `AgentHostAdmin.live()`.
`subscribe(session, rev?) -> LiveSubscription`; the adapter keys the channel by the Session
presence it receives (S2 (d): one presence per vat object per incarnation).

**`LiveSubscription`** (W1a.3) — one per subscriber. `next() -> LiveBatch`: answered; resolves as
soon as at least one delivery is queued (at once if any is), with at most `liveBatchDeliveries`
(256); `closed: true` once closed (then always `{ deliveries: [], closed: true }`). `close()`:
drops the subscriber. A subscriber whose queue exceeds 4,096 undelivered deliveries is dropped
(closed) and must re-watch and re-subscribe.

**`Composer`** (W1a.3) — gateway-local; tests get it from `AgentHostAdmin.composer()`.
`submit(session, text, requestId) -> Receipt`: measures `text` in UTF-8 bytes; over `inlineBytes`
it throws `textOf.submissionTooLarge(bytes, inlineBytes)` and sends nothing; otherwise
`E(session).enqueueOnce(harden({ text }), requestId, Date.now())` and returns its receipt.

### 3.3 Agent-host manager vat objects (W1a.2) — durable

The manager vat runs `resources/agent-host/durable.js` (bundled by `installNative`; it may import
`guest/lib/*` by relative path; the prelude is global there). The attach pattern is the S2
fixture's (`H/test/spikes/fixtures/attach/`): one registration whose spec carries a manager-owned
sink; the adapter's `bind` awaits `E(sink).attach(ops)`; manager methods that need the adapter
call the current ops facet and on a retired break reconcile once (`manager.register(key, spec)`,
`same: () => true`) and call again. The ops facet is W1a.2-internal.

**`AgentHostAdmin`** — the installation's facet, inventory name `agentHostAdmin`; held by the
factory (granted as `host`) and the operator (control socket, tests).

| method | caller | mode | notes |
|---|---|---|---|
| `makeBackend(BackendSpec) -> Backend` | test, provisioning, factory | answered | M1a kind `'scripted'` only (section 10); the spec is kept in the manager heap (<= frameBytes) |
| `forSession() -> SessionHostFacet` | factory, in a creation | answered | minted unbound |
| `bindSession(host, session)` | factory, after `make` | answered | binds the facet to its Session (manager `WeakMap`s both ways); idempotent for the same pair; another session for a bound facet throws |
| `onStart(listener) -> Registration` | factory, once at make | answered | the manager calls `E.sendOnly(listener).started()` from every `lifecycle.started()` after its own restore; `Registration.cancel()` removes it |
| `live() -> Live` / `composer() -> Composer` | operator, tests (M3: the gateway) | answered | forwarded to the current ops facet; transient objects |

**`Backend`** — manager exo per `makeBackend`; held by the factory, by tests, and in each
session's `SessionServices`. `describe() -> { kind, label }`; `open(host) -> TurnPorts`:
answered; the session sends it once per adapter incarnation (in `make`, and again only after a
retired break showed its ports dead; section 6.1). The manager refuses a facet it did not mint
(`texts.unknownSessionHost`), waits for the bind of a minted facet that is not bound yet (`make`
opens before the factory's `bindSession`; a weak map, so a rolled-back creation leaves nothing),
then asks the adapter (ops) for `TurnPorts`: `{ endpoint, publisher: the bound session's channel
publisher, tools, since }`. `tools` lists the adapter tools this backend offers: a scripted backend
offers `echo`; other kinds (M2) offer none. `since` is when the adapter incarnation started (ms,
the adapter's clock; the ops facet stamps it when it is made). Retired break from `open`: the
manager vat is lost (it is a guest vat) or its reconcile failed twice; never a restart signal: a
turn waiting for ports fails with `textOf.openFailed(message)`, a turn waiting to classify a
pre-dispatch break (section 7) is recovered `interrupted`.

**`SessionHostFacet`** — minted per session; held only by that session (in `SessionServices`)
and by the manager. `liveChannel() -> LivePublisher`: answered, outside-turn publishing.
Retired break: the manager vat is lost; give up this publish (viewers re-watch).

### 3.4 Factory vat (W1a.6) — durable

Installed as the application `harness` from `guest/factory/main.js` with grants
`host` -> `agentHostAdmin` and `vats` -> the worker controller.

**`HarnessRoot`** (inventory `harness`; operator only): `getOperator() -> Operator`; `status() ->
{ sessions, program: { digest, bytes } }`; `loadSessionProgram({ digest, index, count, text }) ->
{ complete, bytes }` (section 9).

**`Operator`**: `getFactory() -> SessionFactory`.

**`SessionFactory`**:

| method | notes |
|---|---|
| `createSession(CreateOptions) -> Session` | section 9; answered; 6-7 s cold in M1a |
| `listSessions({ after?, limit? }) -> SessionPage` | rows in creation order, `limit` default and maximum `sessionPageRows` (50); `after` is a session key; `next` is the last key returned when more rows exist; `rev` is the factory's row revision. Never calls a session. Lists rows with `userInitiated: true` only (R4-6) |
| `findSession(key) -> Session` | page reload (F.2 d); unknown key throws `texts.unknownSession` |
| `listPresets() -> [Preset]` | M1a: `[chatOnly]` |

**`Preset`**: `describe() -> { label, builtIn }`; `snapshot() -> { label }`. M1a has one built-in
preset, label `chat-only`, the default.

**`RowReporter`** — one exo per session, made by the factory in the creation; held only by that
session. `changed(RowPatch)`: **sendOnly**, at most once per crank and only on a row-visible
change: `activity` (claim: `working`; settle: `passive`, or `error` for a failed turn),
`queuedCount` (enqueue, claim, cancel), `messageCount` (number of `TurnStarted` records, sent at
settle), `title` (rename). Dropped silently if the factory is unreachable.

**`StartListener`** — the factory's, registered with `onStart` when the factory is made.
`started()`: sendOnly from the manager; section 9.

---

## 4. Records (architecture 4.3)

The session vat's record log is an array of `TurnRecord`s in append order (`records.js`, W1a.4);
the same shapes travel in `RoundRequest.append`, `ContextSource.page` (M1b) and history pages
(previews). A record is appended in the same crank as the effect it precedes (intent before
effect, S9). `kind` is the discriminator; every shape is closed.

| record | written in | fields |
|---|---|---|
| `TurnStarted` | the claim crank (A), which also removes the queue entry | `kind:'turn-started', turnId, input, at` |
| `Dispatched` | crank C (`dispatching(0)` answered `true`) | `kind:'dispatched', turnId, round` |
| `Partial` | `roundFailed` with partial text | `kind:'partial', turnId, round, text` (replaced in M1b by a Blob record) |
| `RoundSettled` | crank D (`roundFinal`) | `kind:'round-settled', turnId, round, text, callCount, usage, at, servedBy?` |
| `ToolIntents` | crank D, after `RoundSettled`, before any call is issued; omitted when `callCount` is 0 | `kind:'tool-intents', turnId, round, intents: [{ opId, callId, name, args }]` (all calls of the round, including those beyond `maxCallsPerRound`) |
| `ToolResult` | the crank that has the outcome (tool answer, local refusal, recovery) | `kind:'tool-result', turnId, opId, name, result, failed, outcome?:'unknown'` |
| `TurnSettled` | the settle crank | `kind:'turn-settled', turnId, status, at, error?, final?, usage?` |
| `TurnResolved` | `Turn.resolve(note)` | `kind:'turn-resolved', turnId, note, at` |

`status` of `TurnSettled`: `completed` (a round without tool calls, or the round limit),
`failed` (error, including `texts.frameLimit` and `textOf.openFailed`), `cancelled`,
`outcome-unknown` (restart after `Dispatched`), `interrupted` (restart before `Dispatched`; `error`
is `texts.interruptedBeforeDispatch`). `final` is the last round's text (completed turns; the
round-limit text R4-47 when the limit ended it). `usage` is the turn's summed counts with the last
round's context reading.

`ToolResult.result` is the model-facing string: the tool's text cut by `boundToolOutput`
(R4-46), or `textOf.errorResult(message)` with `failed: true`, or `texts.toolOutcomeUnknown` with
`failed: true, outcome: 'unknown'`.

Op ids: `textOf.opId(turnId, round, ordinal)`, ordinal = the call's index in the model's
`toolCalls`. Call ids (R4-42): an empty `callId` becomes `textOf.synthesizedCallId(round, index)`;
an empty `name` fails the turn with `texts.invalidToolCall`; two equal call ids (after synthesis)
fail it with `texts.duplicateToolCallId`. Both failures are decided in crank D before
`ToolIntents` is written (the turn settles `failed`, no call runs).

---

## 5. Live channel events and the fold

One channel per session in the agent-host adapter (D-8), keyed by the Session presence. Two
sources publish into it:

- **the session vat**: `LivePublisher.publish({ rev, events })`, one batch per crank (split into
  several calls only when 64 events or `frameBytes` would be exceeded), events in `VatEvent`;
- **the adapter's provider code**, in-process, never through a vat: `delta` events
  `{ type:'delta', turnId, round, text }` (`channel.publishDelta(event)`, W1a.3).

`rev`: the session's durable revision. It starts at 1 when the session is made and increases by
one for every batch the session publishes (each `publish` call); `watch()` returns the current
`rev`. The channel remembers the latest vat `rev` it has seen (0 = none since the adapter
started).

Vat events (all carry `turnId` except `pending`):

| event | when (crank of section 6) |
|---|---|
| `turn-start { input, at }` | A, or B without held ports (the first batch of a turn on its ports; again on fresh ports after dead ones, 7.1) |
| `phase { phase }` | A or B (`thinking`), D with calls (`using tools`), next round (`thinking`), cancel (`cancelling`) |
| `tool_call { id: opId, name, args }` | D, one per call, before any `tool_result` |
| `tool_result { id: opId, name, result, failed }` | each result crank (and D for local refusals) |
| `final { text }` | settle: the last round's text (completed turns only) |
| `usage { five counts, context, turns, incompleteTurns }` | settle: session totals after the turn (R4-83) |
| `end { status }` | settle, last event of every turn that is not failed (`completed`, `cancelled`, `outcome-unknown`, `interrupted`) |
| `abort { reason }` | settle of a `failed` turn instead of `end` (`reason` = the error) |
| `pending { pending: PendingView }` | any crank that changed the queue or its hold |

Order inside a batch: as listed for that crank; a settle batch is `final`, `usage`, `end` (or
`abort`), then the next turn's `turn-start` and `phase` if it was claimed and started on held ports,
then `pending` if the queue changed. The adapter publishes a round's deltas
before it sends `roundFinal`, and the vat publishes that round's events only after receiving it,
so subscribers see deltas before the round's tool calls or final (architecture 4.2).

**What a subscriber receives** (`LiveBatch.deliveries`): `{ seq, rev, event }`, `seq` numbering
every delivery of this channel incarnation from 1, `rev` the batch's rev for vat events and the
channel's latest rev for deltas and the snapshot. The first delivery of every subscription is
`{ type: 'snapshot', turn? }`: the fold of the current turn, or of the last settled turn
(`settled: true`), or no `turn` if the channel has seen none. Client rule: `watch()` first; then
`subscribe(session, rev)`; if the snapshot's `rev` is non-zero and differs from the watched one,
or a later vat delivery's `rev` is not the previous one plus one, call `watch()` again.

**The fold** (W1a.3, with W1a.1's `reply-fold.js`): the channel keeps one `FoldableStatus` per
session: `turn-start` replaces it with `makeFoldableStatus()` for the new turn; `phase`, `delta`,
`final`, `tool_call`, `tool_result`, `usage`, `end`, `abort` are passed to `fold.apply(status,
event)` **without their `turnId` key** (and `round` for deltas), so the status matches
`shapes.FoldableStatus`; `end`/`abort` also call `fold.finish(status)` and mark it settled;
`pending` is not folded. Deltas for a turn other than the folded one are delivered but not folded.
"Fold equals replay": folding every delivery of a turn from a fresh status gives the snapshot's
status.

---

## 6. A turn, crank by crank (M1a, scripted backend)

Session-vat deliveries are lettered. Sizes are string bytes of each message.

### 6.1 Start

**Ports are held per adapter incarnation** (J-9151; before, `Backend.open` ran once per turn
through the manager vat and turn start was 573 ms against 350, J-0272, J-0293). The session sends
`E(backend).open(host)` once in `make` and keeps the answer (`TurnPorts`: endpoint, publisher,
tools, `since`) across turns. It drops them when they prove dead: a retired break from the lease,
an adapter tool or an answered outside publish. A claim with no ports held opens again (crank A'
then B below). The lease stays per turn: one `holdTurn(turn)` per turn, released at the settle.

| crank | delivery into the session | the session does (in this order) | sends (mode, size) |
|---|---|---|---|
| A | `enqueueOnce(submission, requestId, at)` from the Composer (<= 8.4 KB), or `startTurn` | validate (blank text refused); receipt; append the entry; if idle and no hold (or `startTurn`): **claim** = remove the entry, append `TurnStarted`, make `Turn` and `TurnSink`, current turn = running, generation += 1; with ports held: start the turn on them | `RowReporter.changed({ activity:'working', queuedCount })` (sendOnly, tiny); `publish({ rev, events:[turn-start, phase thinking, pending?] })` (sendOnly, <= 9 KB); `E(endpoint).holdTurn(turn)` (answered, the lease); `startRound({ turn, sink, turnId, round:0, base, append:[TurnStarted], tools, options })` (sendOnly, <= 20 KB); returns the receipt (`state:'started', turn`) |
| (adapter) | | selects the script turn, waits `dispatchDelayMs`, calls `E(sink).dispatching(0)` and **waits for the answer** | |
| C | `dispatching(0)` (tiny) | append `Dispatched`; answer `true` | - |
| (adapter) | | logs `request` (the provider request), streams deltas in-process | |

Without ports held (the creation-time open has not answered, or the last ports proved dead):

| crank | delivery | the session does | sends |
|---|---|---|---|
| A' | as A | claim as A | row change; `E(backend).open(host)` (answered, tiny), unless one is in flight |
| B | answer of `open`: `TurnPorts` (< 1 KB) | keep them as the held ports; if the turn was cancelled meanwhile (it is settled already, 6.4), send nothing; else start the turn on them | as A: publish, `holdTurn`, `startRound` |

If `open` rejects (crank B): append `TurnSettled{ failed, error: textOf.openFailed(msg) }`, publish
`abort` through `SessionHostFacet.liveChannel()` (answered), row `error`, then claim the next entry
if any.

**Cost.** With ports held a turn start costs 2 session deliveries (A, C) and no manager crank; a
GC frame for the previous turn's Turn and TurnSink (dropped by the adapter after its release, J-0277)
may arrive in between, so at most 3 frames reach the session before the provider request. A plain
turn is A, C, D (final round, with the settle) and the lease answer: 4 deliveries (5 before). The
first turn of a session whose creation-time open has not answered yet, and the first turn after an
adapter restart that the session learned of from a broken outside publish, pay crank B and the
manager hop once (A', B, C). The first turn after a restart the session was not told of (idle across
it) pays a reopen: A, the lease break, B (fresh ports, round 0 again), C (section 7).

`RoundRequest`: `base = { count: <records in the log before append[0]>, epoch: 0 }`; round 0
`append` is exactly `[TurnStarted]`; round n carries the records appended since the previous
`startRound` of this turn if the message fits `frameBytes`, else `append: []` (M1a adapters do not
read past records; M1b pulls through `context`). `tools` are the descriptions of the tool-table
entries available with these ports (M1a: `echoDescription` when `ports.tools` has `echo`).
`options.modelId` is the session's resolved model. `system` is absent in M1a (M2 prompts).

### 6.2 A round

| crank | delivery | the session does | sends |
|---|---|---|---|
| D | `roundFinal(RoundResult)` (<= frameBytes) | ignore unless current turn, running, same round; `lastKnownTime = at`; R4-42 checks; append `RoundSettled`; no calls: settle `completed` (6.3); calls: append `ToolIntents` (all calls), then for each call in order: ordinal >= `maxCallsPerRound` -> local result `textOf.tooManyCalls(n, 64)`, failed; unknown name -> local result `textOf.errorResult(textOf.unknownTool(name, available))`, failed; else queue it; issue the first `callWindow` queued calls | `publish({ events:[phase 'using tools', tool_call x n, tool_result for local results] })` (sendOnly, split to fit); `E(tool).execute({ opId, args })` x <= 16 (answered) |
| E1..Ek | each `execute` answer | ignore if the turn's generation changed; record `ToolResult` (`ok`: result = `boundToolOutput(text)`; `failed` or rejection: `textOf.errorResult(...)`; `frame-limit`: result = `texts.frameLimit`, failed, and mark the round failed); publish `tool_result`; issue the next queued call. After the **last** result of the round: if the round was marked frame-limited -> settle `failed` with `texts.frameLimit`; else if `round + 1 >= maxToolRounds` -> settle `completed` with `final = texts.roundLimit` (R4-47); else `startRound(round + 1)` | `publish` (sendOnly); next `execute`; in the last one `startRound` (sendOnly) and `phase thinking` |
| D' | `roundFailed({ round, reason, partial? })` | append `Partial` if `partial`, settle `failed` with `reason` | as settle |

Results reach the record log in completion order, but every `ToolResult` carries its op id, and
the next round's context and history pages present them in call order (R4-44). Deliveries per
round with 2 calls: D, E1, E2 = 3. A turn cannot settle while a call of its current round is
unsettled, except by recovery (7) and cancel (6.4, which waits).

### 6.3 Settle

In the crank that decides the turn's end: append `TurnSettled`; current turn cleared (the Turn's
`whenFinished` resolves; the settled turn is a record from now on, its Turn kept only as a recent
handle); update usage totals (`turns` += 1; `incompleteTurns` += 1 unless `completed`); publish
`[final?, usage, end | abort]`; `RowReporter.changed({ activity, messageCount, queuedCount })`;
`E.sendOnly(endpoint).releaseTurn(turn)` (the lease answer comes back as one more delivery, which
the session ignores); then, if the queue has a waiting entry and no hold, claim it in the same
crank (6.1 crank A's work). With ports held the next turn starts in this crank too, and its events
ride in the same batch: `[final?, usage, end | abort, turn-start, phase, pending]`. Turn sources
(M9) are asked only when the queue has no waiting entry **and no hold** (J-9157).

### 6.4 Cancel

`Turn.cancel()` while running: state `cancelling`; publish `phase cancelling`;
`E.sendOnly(endpoint).cancelRound(turn)` if ports exist. If no tool call is in flight, settle
`cancelled` in this crank (a late `roundFinal`, `roundFailed` or `dispatching` for this turn is
ignored or answered `false`). If tool calls are in flight, the turn waits for their results
(recorded as usual; R4-49 does not interrupt a running tool), issues no further calls and no next
round, and settles `cancelled` after the last one. While the turn waits for ports (an open
pending, crank B, or a reopen after a pre-dispatch break), settle at once; the open's answer is
then kept as the held ports and nothing is sent for the turn.

---

## 7. Restart, retired breaks and recovery

`isRetiredBreak(error)` (`retired.js`) is true when the error's message is exactly
`HUB_RETIRED_MESSAGE`, "ocapn hub: the target session has been retired" (`pkg/src/net/hub.js:1522`,
`:1947`, `:1968`; the hub builds every such break as `Error(reason)` with that whole text). It is
an exact match, not a substring test (QC finding 1, J-0290): an error that only quotes the text,
such as an argument error naming a key the model chose, is not a break. Adapter tools answer their
own failures as `{ status: 'failed', text }` (section 10), so a rejection from an adapter tool is a
hub break or a defect in the tool, never model, user or provider text. The text means "the callee's session is
gone": for an **adapter object** that is a restart (D-5); for a **guest vat** it is that vat lost
(halted or given up, D-17). Classify by the call site, never by the text alone:

| caller -> callee (kind) | meaning | action |
|---|---|---|
| session -> `Endpoint.holdTurn` (adapter) | restart | `Dispatched` recorded: `recoverAfterRestart()`; else drop the ports, reopen, and on fresh ports either `recoverAfterRestart()` (claimed before their `since`: in flight) or send round 0 again (claimed on ports already dead); section 7.1 |
| session -> `AdapterTool.execute` (adapter) | restart | `recoverAfterRestart()`; never a tool failure |
| session -> `Endpoint` sendOnly methods (adapter) | no answer; silently dropped on a tombstone | none (the lease break reveals it) |
| session -> `LivePublisher.publish` answered, outside a turn (adapter) | restart, not on the turn path | stop holding ports with that publisher; `E(host).liveChannel()`, publish again once |
| session -> `Backend.open` (manager, guest) | manager lost | a turn waiting for ports: `failed`, `textOf.openFailed`; a turn waiting to classify a pre-dispatch break: `recoverAfterRestart()` (`interrupted`) |
| session -> `SessionHostFacet.liveChannel` (manager, guest) | manager lost | drop this publish |
| session -> `RowReporter.changed` (factory, sendOnly) | - | none |
| factory -> `Session`, `SessionInternal` (guest) | session vat lost | row `state: 'lost'` (kept listed; D-17) |
| factory -> `SpareMaker.make` (guest, the new vat) | new vat lost | roll the creation back |
| factory -> worker facade `evaluate` (host resource) | restart during a creation, or the worker is gone | roll the creation back |
| factory -> `AgentHostAdmin` (manager, guest) | manager lost | the factory operation fails with the error |
| manager -> ops facet (adapter) | restart | reconcile once and retry (attach pattern) |
| adapter -> `TurnSink` (session vat) | session vat lost | abandon the round; send nothing to the provider |
| Composer -> `Session.enqueueOnce` (guest) | session vat lost | reject to the Composer's caller with the error |
| test or gateway -> anything in a vat | that vat lost | report |

**`recoverAfterRestart()`** (W1a.5; idempotent; keyed by the turn's generation, so a second break
for the same turn, or a late answer of the old generation, does nothing):

1. No current turn: nothing to recover (an old lease of a settled turn).
2. Drop the turn's ports (endpoint, publisher, tools): tombstones; the session stops holding them
   too (the next claim opens fresh ports).
3. No `Dispatched` record for the turn: append `TurnSettled{ status: 'interrupted', error:
   texts.interruptedBeforeDispatch }`. The input stays in the log once (it was claimed, not
   re-queued) and is left out of later context (R4-32).
4. `Dispatched` recorded: for every intent of the current round without a `ToolResult`, append
   `ToolResult{ result: texts.toolOutcomeUnknown, failed: true, outcome: 'unknown' }`; append
   `TurnSettled{ status: 'outcome-unknown' }`. Nothing is re-sent; no further round is requested.
5. Abandon every guest call the turn holds open (none in M1a; exec in M1b) by generation; never
   await one (C-10).
6. Run `turnHooks.recoverySteps` (empty in M1a).
7. Queue non-empty: hold it `restart` (`texts.holdRestart`).
8. Report the row (`activity: 'passive'`, counts); publish `[end{status}, pending]` outside the
   turn (fresh publisher through `host.liveChannel()`, answered; failures ignored).

**Order inside the recovery crank** (W1a.5, `guest/session/recovery.js`): the steps above all run
in the one crank that received the break, synchronously, in the order 1, 2, 4 (the unknown
results), 5, 6, 7, then the settle (`core.settle(active, { status, error? })`, which appends the
`TurnSettled` of 3 or 4 and does 8). The hold (7) is set **before** the settle because the settle
claims the next entry (6.3) and must find the queue held; there is no observable difference, since
everything happens in one crank. With the ports dropped (2) the settle publishes its batch outside
the turn (answered, through `host.liveChannel()`) and sends no `releaseTurn`; the `pending` event
of the hold rides at the end of that batch. `turnHooks.recoverySteps` get a context that is frozen,
not hardened (hardening it would freeze the session's mutable `ActiveTurn` and `SessionCore`); a step
that throws or rejects is skipped. `Dispatched` is taken as recorded when `active.dispatched` is set
or the log has the record.

The lease break is delivered during startup before the daemon serves (S2). A dispatched turn has
recovered by the time clients connect; an undispatched one recovers when its reopen is answered
(after the manager's restore re-attaches the adapter, about 65 ms after serving plus one open,
S2). A turn whose `Dispatched` is recorded but whose provider request was never made is still
reported `outcome-unknown` (conservative, architecture 4.3).

### 7.1 Held ports and SIGKILL, crank by crank (J-9151)

A session that holds its ports across turns can claim a turn on ports whose adapter incarnation
died while the session was idle: no vat is told of a restart unless it has a call pending into the
dead incarnation (D-5 keeps idle sessions asleep). The `holdTurn` of that claim then breaks at once,
with the same retired text as the lease of a turn that was in flight when the adapter died. The
session tells the two apart by time: it opens fresh ports and compares the turn's claim time
(`TurnStarted.at`: the caller's `at`, or for a queued claim the latest `at` the session has seen)
with the fresh ports' `since`. Claimed before the fresh incarnation started: the turn was in flight
at the restart and is recovered (R4-66: `interrupted`, never sent again). Claimed after: the ports
were dead when it was claimed, nothing reached any adapter, and the same round 0 request goes to
the fresh ports (with its `turn-start` and `phase` published again on the fresh publisher, after a
rev the old publisher swallowed: viewers see a rev gap and re-watch). An open answered with ports no
newer than the broken ones (an open that was in flight across the break) is asked again, at most
three times, then the turn is recovered.

Session cranks: A claim on held ports (records `TurnStarted`; sends publish, `holdTurn`,
`startRound`); A' claim without ports (sends `open`); B ports answered; K a lease break; R the
reopen answered; C `dispatching(0)` (records `Dispatched`); D `roundFinal` (records `RoundSettled`,
`ToolIntents`; sends `execute`); E a tool result; S the settle (records `TurnSettled`; sends the
batch and `releaseTurn`; may claim the next entry, S+A). "Kill after X" means the supervisor is
SIGKILLed after crank X was journaled (its outbound frames are committed with it, M0 S9) and before
the next session crank.

| case | kill after | what the restart delivers | outcome | before J-9151 |
|---|---|---|---|---|
| 1 | nothing of the turn (A not journaled) | the Composer's call breaks or is replayed | no turn, or the turn once (request ids are idempotent) | same |
| 2 | A on live ports, before C | K during startup; reopen; R: `since` > claim time | `interrupted` (R4-66), queue held `restart` if non-empty, `[end, pending]` published outside; the provider never got a request (the adapter waits for `dispatching(0) = true`) | same outcome, without the reopen (recovered in K) |
| 3 | A on ports already dead (the adapter died earlier, session idle) | nothing: K arrives at once after A, before any kill | R: claim time >= `since`: round 0 again on fresh ports, then as a normal turn (C ...) | did not exist (ports per turn) |
| 3a | K of case 3, before R | the reopen (pending in the manager, a durable vat) is answered after the restart with the newest ports | `since` > claim time: `interrupted`; the turn was in flight at this restart | - |
| 3b | R of case 3 (round 0 resent), before C | as case 2 | `interrupted` | - |
| 4 | A' (open pending), before B | the manager answers the open after the restart with fresh ports | B starts the turn; it proceeds (nothing was dispatched, nothing is sent twice); a deviation from R4-66's letter kept from M1a: `since` cannot be compared here, because the first open of a daemon's life starts the adapter after the claim | same |
| 5 | C | K during startup | `recoverAfterRestart()` at once: `outcome-unknown`, open intents "Tool outcome unknown", queue held; held ports dropped, no reopen | same |
| 6 | D (intents recorded, calls sent) | K and the `execute` breaks | as 5; the first break recovers, the rest do nothing (one recovery per generation) | same |
| 7 | E | as 6 | as 5 | same |
| 8 | S, no next claim | K for a release that never arrived | no current turn: nothing to recover; held ports dropped | same |
| 8a | S+A (the next entry claimed on held ports in the settle crank) | K of the new turn | as case 2: `interrupted` (claim time is the settle's last known time, before the restart) | the claim sent `open`; as case 4 the turn proceeded after the restart |
| 9 | the session idle, ports held | nothing (the session sleeps; GC frames from dead peers are C-17) | the next claim is case 3 | the next claim opened (A', B) |

Clocks. The claim time is the caller's clock (the Composer's `Date.now()`, or an adapter's `at` for
a queued claim) and `since` the adapter's; on one machine in M1a. A misclassification is safe in
both directions, since nothing was dispatched in any of these cases: a clock stepping back across a
restart makes an in-flight turn go to the fresh ports (the provider sees it once; a deviation from
R4-66's "closed"); a claim made between the daemon serving and the adapter's re-attach (about 65 ms,
S2), or a `startTurn` without `at` after a restart (`lastKnownTime` older than `since`), closes a
turn that was not in flight as `interrupted` (the user sends it again). Callers should pass `at`.

C-10. Recovery itself stays synchronous and never awaits. In case 2 the *decision* waits for the
reopen, an answered call into the manager (a guest vat): if that vat was given up during startup
the turn stays `running` until `Turn.cancel()`, which settles it at once (it has no ports). Case 4
had the same exposure before this change.

---

## 8. Queue (W1a.5)

FIFO of waiting entries (at most `maxWaiting`, 100), a hold, and receipts (at most `maxReceipts`,
4,096) keyed by request id inside the vat (a `Map`).

- **Blank text** (A.4, Fae): `text.trim() === ''` throws `texts.blankSubmission` before the
  request id is looked at (J-9150).
- **Request id** (A.4): matches `/^\d{13}-[0-9a-f-]{36}$/` else `texts.invalidRequestId`; its
  timestamp `issued` (first 13 digits) must satisfy `issued > at - retryWindowMs` and
  `issued <= at + clockSkewMs`, else `texts.requestIdExpired`. A known id with the same text returns
  the stored receipt with `duplicate: true` and its current state (`queued` with its entry, or
  `started` with its turn); with another text it throws `texts.requestIdReused`. Receipts whose
  `issued` is older than `at - retryWindowMs` are pruned on each `enqueueOnce`; if 4,096 remain,
  `texts.receiptLimit`. A full queue throws `textOf.queueFull(100)`.
- **Entries**: `{ entry: QueueEntry, key: 'q<n>', submission, at }`; `pending` rows show
  `preview` = the text cut to `messagePreviewUnits` (and shorter if the whole `PendingView` would
  exceed `frameBytes`: W1a.5 cuts every preview to `floor(frameBytes / (3 x entries)) - 64` units
  when needed).
- **Holds** (A.4): `restart` (set by recovery), `refused` (`textOf.holdRefused(error)` when the
  claim crank finds a refusal; M1a has none), `stopped`, `interrupted`, `unavailable` (M2+). A new
  `enqueueOnce` releases every hold except `interrupted` and then runs the queue (the oldest entry
  first). While a hold is set no entry is claimed.
- **Claim** (atomic): only in the crank that appends `TurnStarted`; the entry is removed and its
  receipt becomes `started` with the Turn in that same crank.
- **Details settled by W1a.5** (`guest/session/queue.js`): only a *new* entry releases holds (a
  duplicate `enqueueOnce` is a retry and releases nothing); cancelling the last waiting entry clears
  the hold (Fae `session-submissions.js` cancel); `hold(reason)` never replaces an `interrupted`
  hold with another reason; a cancelled entry keeps its receipt (`state: 'queued'`, naming one
  shared stand-in entry per queue whose `describe()` throws `texts.entryGone`, so the cancelled
  QueueEntry itself is kept only by its holders), so a retry does not resurrect it; a `started`
  receipt keeps only the session's record of its turn and hands out `turnOf(record)`, the Turn
  minted from it (J-9152; the claimed entry is dropped so it can be collected: every retained
  object costs each later delivery, C-7). Receipt pruning looks at the oldest receipts in insertion order
  and stops at the first live one; when the table is full it scans all of them before refusing with
  `texts.receiptLimit` (an expired id is refused before lookup, so an expired receipt left behind a
  live one costs memory only). The preview cut of `view()` is `floor((frameBytes - holdBytes -
  overhead) / (3 x entries))` units, which is at least the formula above whenever the hold text is
  short and still fits when it is long.
- **Receipt table rule** (J-9152): at most `maxReceipts` (4,096, A.4) receipts of plain data, none
  holding an exo; a receipt is dropped once its request id was issued more than `retryWindowMs`
  (24 h) before the `at` of an `enqueueOnce` (checked at every `enqueueOnce`, oldest first); a full
  table of live ids refuses new submissions with `texts.receiptLimit`. Retained memory is
  therefore bounded by count (4,096 small records) and, while submissions arrive, by age.

---

## 9. Factory, session creation and provisioning (W1a.6)

**Session program.** `guest/session/main.js` (W1a.4) is bundled by `scripts/bundle-guest.mjs
session` into one source whose value is its namespace; the namespace exports
`makeSpareMaker()`. The bundle must stay <= `sessionProgramBytes` (200,000 bytes; perf
`session.program`). Provisioning loads it into the factory with `HarnessRoot.loadSessionProgram`
pieces: `{ digest (sha256 hex of the source), index, count, text }`, each piece at most
`frameBytes` units for an ASCII source and `frameBytes / 3` units otherwise, cut surrogate-safe
(`bounded.js` `chunkText`); the factory keeps the pieces, joins them when `index === count - 1`
arrives with every index present, and answers `{ complete: true, bytes }`. A new digest replaces
the program for later creations only.

**`createSession(options)`**:

1. Validate: `model` present -> `texts.modelOption` (R4-6); `systemPrompt`, `networkPolicy`,
   `spoken`, `reasoningEffort` present -> `textOf.optionNotSupported(name)` (M1a); `backend`
   absent -> `texts.noBackend`. Defaults: `title` "New chat" (R4-6), `preset` chat-only,
   `modelId` `'scripted'`, `userInitiated` **true** (section 15).
2. Row `{ state: 'creating', activity: 'passive' }` with key `s<n>`, and a creation record in the
   factory heap (the steps done so far).
3. `E(vats).createWorker('session s<n>')` -> facade. Stage: `facade.evaluate('(globalThis[Symbol.for("harness.session")] = [], true)')`,
   one `facade.evaluate('(globalThis[Symbol.for("harness.session")].push(chunk), true)', { chunk })`
   per piece, then one evaluating crank:
   `facade.evaluate('(() => { const h = Symbol.for("harness.session"); const source = globalThis[h].join(""); delete globalThis[h]; return (0, globalThis.eval)(source).makeSpareMaker(); })()')`
   -> `SpareMaker`. (The string is data sent to the worker; guest code itself never evaluates.)
4. `host = E(admin).forSession()`; `config = { key, title, backendTitle: (await
   E(backend).describe()).label, modelId, preset: E(preset).snapshot(), createdAt, userInitiated }`
   (`createdAt` = `CreateOptions.at`, stamped by the caller, which has the clock, as the Composer
   stamps `enqueueOnce`; without it the latest `at` the factory has seen, 0 before any; J-9150); `rowReporter` = a new RowReporter;
   `{ session, internal } = E(maker).make({ config, services: { backend, host }, rowReporter })`;
   `E(admin).bindSession(host, session)`.
5. Row `ready`; creation record cleared; return `session`. On any failure: retire the facade
   (`E(facade).retire()`), drop the row, rethrow (nothing half-made, R4-6).

**Start listener `started()`** (every start, after the manager's restore): (1) each creation
record: if `make` answered, finish steps 4-5 (`bindSession` again is idempotent); otherwise retire
the facade if one was made and drop the row; (2) for each row with `activity: 'working'` (its
session had a turn in flight, so its lease break woke it anyway), `E(internal).rowSnapshot()` ->
update the row, or on a retired break set `state: 'lost'`. Idle sessions are never called (D-5).
Any other factory call into a session that breaks with the retired text also sets `lost`.

**Provisioning** (`scripts/provision-steps.js` `provision(context)`, also the `provision` of
`ensureTemplate({ id: 'm1a', provision })`; `context` is the template helper's `{ client, connect
}` with `client` on workspace `w`): (1) `client.call('installNative', 'agentHostAdmin',
<H/resources/agent-host>)`; (2) `bundle-guest` the factory and session programs; (3)
`client.call('install', 'harness', <factory bundle>, [['host', 'agentHostAdmin'], ['vats',
'vats']])`; (4) `lookup('harness')` and load the session program (pieces as above); (5) nothing
else: the factory registers its start listener in `make`. Re-running is a no-op (each step checks
the inventory and the program digest first). Tests and perf find `agentHostAdmin` and `harness` by
`client.call('lookup', name)`.

---

## 10. Scripted provider and echo (W1a.2; used by W1a.4 tests, W1a.7)

**Backend spec**: `E(agentHostAdmin).makeBackend({ kind: 'scripted', label, script, logPath? })`.
`logPath` (absolute; tests put it under `H/tmp/`) receives one JSON line per event, appended and
fsynced, from the provider and from `echo` for calls made through this backend's ports:
`{ kind, label, pid, at, turnId?, round?, opId?, args?, units? }` with `kind` one of `request`,
`dispatch-refused`, `round-final`, `round-failed`, `frame-limit`, `cancelled`, `echo-start`,
`echo-end`, `echo-frame-limit`, `echo-failed`, `delta`, `round-start`. `pid` identifies the adapter incarnation. "The provider received
exactly one request" = one `request` line for the turn; "echo ran at most once" = at most one
`echo-start` per op id. A `delta` line (`turnId`, `round`, `units`) is written for every delta the
provider publishes; its `at` is the time of the publish, and it is written on a later turn of the
adapter's event loop (so its fsync does not delay subscribers), possibly after the round's
`round-final` line (W1a.7, perf `turn.delta`). A `round-start` line (`turnId`, `round`) is written
the same way for every `startRound` the provider runs; its `at` is when the round reached the
provider (perf `turn.start` splits the start at it).

**Script** (`shapes.Script`; the whole spec <= `frameBytes`, so large outputs use `repeat`):

```js
{
  turns: [                      // chosen per turn: the first whose `input` equals the turn's
    {                           // input text, else the first without `input`
      input: 'hi',              // optional
      rounds: [                 // rounds[r] answers RoundRequest.round === r
        {
          dispatchDelayMs: 0,   // round 0 only: wait before calling dispatching(0)
          chunks: [{ text: 'Hel', delayMs: 20 }, { text: 'x', repeat: 65536 }],
          chunkDelayMs: 50,     // default delay before each chunk without its own delayMs
          toolCalls: [          // the round's tool calls, in order
            { name: 'echo', args: '{"text":"a","delayMs":1000}' },
            { name: 'echo', callId: 'c2', argsKeys: 2000 },
          ],
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0,
                   cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
          error: 'scripted failure',  // optional: fail the round after the chunks
          stall: 'untilCancel',       // optional: after the chunks, wait for cancelRound
        },
      ],
    },
  ],
}
```

Behaviour per `startRound(req)`:

1. Round 0: the script turn is chosen from `req.append[0].input` and remembered for `req.turn`
   (a `WeakMap` in this incarnation). No script turn, or no `rounds[req.round]`: `roundFailed({
   reason: textOf.scriptExhausted(round) })`.
2. Round 0: wait `dispatchDelayMs`; `await E(req.sink).dispatching(0)`; `false` or a rejection ->
   log `dispatch-refused` and stop. Then log `request`. Rounds >= 1: log `request` at once.
3. Each chunk: wait `chunk.delayMs ?? chunkDelayMs ?? 0`, then publish one delta whose text is
   `chunk.text` repeated `chunk.repeat ?? 1` times (one delta per chunk, however long).
4. `cancelRound(req.turn)` at any point stops the round silently (log `cancelled`); a stalled
   round waits only for that (or the adapter's death).
5. `error`: `roundFailed({ round, reason: error, at, partial })`, `partial` = the text so far cut
   (surrogate-safe) so the message fits `frameBytes`.
6. Otherwise `RoundResult { round, text: all chunk text, toolCalls, usage (zeros if absent), at,
   servedBy: { label, modelId: req.options.modelId } }`, where each tool call is `{ callId:
   c.callId ?? '', name: c.name, args: c.args ?? (c.argsKeys ? generated : '{}') }` and
   `generated` is `JSON.stringify({ data: { k0: 0, k1: 0, ... } })` with `argsKeys` keys (2,000
   keys is about 19 KB). Missing call ids exercise R4-42 synthesis in the vat.
7. If the RoundResult's strings exceed `frameBytes` (exact UTF-8): log `frame-limit` and send
   `roundFailed({ round, reason: texts.frameLimit, at })` instead, before anything reaches the
   vat. Else log `round-final` and `E.sendOnly(req.sink).roundFinal(result)`.

**echo** (`AH/tools/echo.js`; description `echoDescription`; offered in `TurnPorts.tools` by
scripted backends): `execute({ opId, args })`:

1. log `echo-start` with `opId` and `args` (the text exactly as received);
2. `JSON.parse(args)`; a parse error fails with `textOf.argumentsNotJson(e.message)`;
   anything but a plain object fails with `textOf.invalidArgument('args', 'echo', 'a JSON
   object')`;
3. the first key not in `echoArgumentNames` fails with `textOf.unexpectedArgument(key,
   'echo', echoArgumentNames)`; `text` must be a string, `delayMs` a number in 0..`maxDelayMs`,
   `bytes` a number in 0..`echoMaxUnits`, else `textOf.invalidArgument(name, 'echo', expected)`;
   `data` is anything and is ignored. "Fails with" means: log `echo-failed` (`units`) and answer
   `{ status: 'failed', text }` with the text bounded by `boundToolOutput` and, if still over the
   frame, cut to `frameBytes - 1024` bytes; the session records `Error: <text>` (R4-45). Echo
   never rejects for an argument error, because these texts quote model text (QC finding 1);
4. wait `delayMs` (adapter timer; R4-49: cancel does not interrupt it);
5. output = `bytes` given ? `(text || 'x')` repeated and cut to exactly `bytes` units
   (surrogate-safe) : `text ?? ''`; then `boundToolOutput(output)` (R4-46, `toolOutputUnits`);
6. if `{ status: 'ok', text: output }` exceeds `frameBytes` (exact UTF-8): log `echo-frame-limit`
   and answer `{ status: 'frame-limit', text: texts.frameLimit }`; else log `echo-end` (`units`)
   and answer `{ status: 'ok', text: output }`.

So a 64 KiB or 300 k-character echo result is cut in the callee to 32,768 units with the marker,
is still over `frameBytes`, and fails the turn with `texts.frameLimit` (acceptance 8); 2,000-key
arguments reach echo as text and are logged intact (acceptance 9).

---

## 11. Module entry points

Every unit exports exactly these (more is allowed; these names and signatures are fixed). "vat"
modules follow the guest rules; "Node" modules run in the adapter or in tests.

### W1a.0 (exists)

| file | export | signature |
|---|---|---|
| `guest/lib/limits.js` | `limits` | hardened record of numbers (section headers in the file) |
| `guest/lib/interfaces.js` | `interfaces` | lazy table `{ [Name]: InterfaceGuard }`, names as in section 3 |
| | `shapes` | lazy table of every pattern by name |
| | `methodNames` | `{ [Name]: string[] }` |
| | `texts`, `textOf` | fixed texts; functions returning fixed texts (section 13) |
| | `echoDescription`, `echoArgumentNames` | the echo tool as offered; its argument names |
| `scripts/guest-prelude.js` (Node) | `installGuestPrelude() -> string[]`, `guestPrelude` | defines missing prelude names on `globalThis` |
| `test/unit/_m1a-prelude.js` (Node) | side effect | calls `installGuestPrelude()` |

### W1a.1 guest lib (vat and Node)

| file | export | signature |
|---|---|---|
| `guest/lib/bounded.js` | `estimateBytes(text) -> number` | `text.length * 3` |
| | `utf8Bytes(text) -> number` | exact (`new TextEncoder().encode(text).length`) |
| | `messageBytes(value) -> number` | exact UTF-8 bytes of every string in a passable tree (record keys and values, array items; remotables and numbers count 0) |
| | `fitsFrame(value, budget = limits.frameBytes) -> boolean` | estimate first; exact only when the estimate is over |
| | `cutText(text, maxBytes) -> string` | the longest prefix within `maxBytes` UTF-8 bytes, never splitting a surrogate pair |
| | `chunkText(text, maxBytes = limits.frameBytes) -> string[]` | consecutive pieces, each within `maxBytes`, surrogate-safe; joined they equal `text` |
| | `previewText(text, units) -> string` | prefix of at most `units` units, surrogate-safe, no marker |
| | `boundToolOutput(text, limit = limits.toolOutputUnits) -> string` | R4-46: unchanged if `text.length <= limit`, else a prefix plus `textOf.truncationMarker(text.length)`, total <= `limit` units, surrogate-safe |
| | `splitBatches(events, { maxEvents = limits.publishBatchEvents, maxBytes = limits.frameBytes }) -> events[][]` | consecutive groups each within both bounds (an event alone over `maxBytes` is its own group; the sender cuts its text fields first) |
| `guest/lib/retired.js` | `RETIRED_TEXT` | `'the target session has been retired'` |
| | `isRetiredBreak(error) -> boolean` | true when `error` is an object whose `message` (string) includes `RETIRED_TEXT` |
| `guest/lib/turn-engine.js` | `runAgenticTurn(options)`, `DEFAULT_MAX_TOOL_ROUNDS` | as Fae `src/turn-engine.js` (1315bef86), `Fail` from the prelude |
| `guest/lib/reply-fold.js` | `makeReplyFold({ projectUsage? }) -> { adopt(status, snapshot), apply(status, event) -> event \| undefined, finish(status) }` | as Fae `session/reply-fold.js`; `harden` from the prelude |
| | `makeFoldableStatus() -> FoldableStatus` | `{ phase: '', streamingText: '', messages: [], error: null, usage: null }` (mutable) |
| `guest/lib/transcript-records.js` | `assertTranscriptRecord`, `encodeTranscript`, `parseTranscript`, `pairToolCalls` | the subset of hosted-agent `src/transcript-records.js` with these names and signatures (no image helpers) |

### W1a.2 agent host (Node, except `durable.js`)

| file | export | signature |
|---|---|---|
| `resources/agent-host/durable.js` (manager vat) | `make(powers) -> { facet: AgentHostAdmin, lifecycle }` | `powers.makeManager` as the S2 fixture; `facet` is `interfaces.AgentHostAdmin` |
| `resources/agent-host/ephemeral.js` | `make() -> adapter` | loader (D-14): calls `installGuestPrelude()`, then `import()`s `impl/index.js` from `implDir`, returns `makeAdapter({ label, bind, unbind })` |
| `AH/index.js` | `makeAgentHostImpl({ timers? }) -> { bind(key, spec), unbind(binding, key) }` | composes ops, channels, live, composer, backends and tools from the tables below |
| | `backendKinds` | hook table: `[{ kind: 'scripted', makeProvider }]` |
| | `adapterTools` | hook table: `[{ name: 'echo', makeTool }]` |
| `AH/endpoint.js` | `makeEndpoint({ provider, channel, timers }) -> Endpoint` | |
| `AH/timers.js` | `makeTimers() -> { delay(ms) -> Promise<void>, after(ms, fn) -> cancel() }` | |
| `AH/attach.js` | internal to W1a.2 | |
| `AH/providers/scripted.js` | `makeScriptedProvider({ label, script, logPath?, timers }) -> { startRound(req, channel), cancelRound(turn) }` | section 10 |
| `AH/tools/echo.js` | `makeEchoTool({ timers, log }) -> AdapterTool` | section 10 |

### W1a.3 channels (Node)

| file | export | signature |
|---|---|---|
| `AH/channels.js` | `makeChannelRegistry({ taps = channelTaps } = {}) -> { channelFor(session) -> Channel }` | one Channel per Session presence (`WeakMap`) |
| | Channel | `{ publisher: LivePublisher, publishDelta(event: DeltaEvent): void, subscribe(rev?) -> LiveSubscription, snapshot() -> SnapshotEvent, latestRev() -> number }` |
| `AH/channel-taps.js` | `channelTaps` | hook table: `[(session, delivery) => void]`, called for every delivery after it is queued |
| `AH/live-service.js` | `makeLive({ channels }) -> Live` | `subscribe(session, rev)` = `channels.channelFor(session).subscribe(rev)` |
| `AH/composer.js` | `makeComposer({ now = () => Date.now() } = {}) -> Composer` | section 3.2 |

### W1a.4 session vat

| file | export | signature |
|---|---|---|
| `guest/session/main.js` | `makeSpareMaker() -> SpareMaker` | the session program's entry (bundle namespace) |
| `guest/session/session.js` | `makeSession(makeArgs) -> { session, internal }` | builds `SessionCore` and passes it to `recovery.js` |
| `guest/session/records.js` | `makeRecordLog() -> RecordLog` | `{ append(record) -> index, count(), since(index) -> records, ofTurn(turnId) -> records, messageCount() }`; `append` checks `shapes.TurnRecord` |
| `guest/session/turn.js` | internal to W1a.4 | the turn loop over `runAgenticTurn`; W1a.5 reaches it only through `SessionCore` |
| `guest/session/live.js` | `makeLivePublishing({ host, onStale? }) -> { inTurn(ports, events), outside(events) -> Promise<void>, rev(), forget(publisher) }` | rev counter and batching (section 5); `onStale(publisher)` on a retired break of an answered publish |
| `guest/session/tool-table.js` | `toolTable` | hook table: `[ToolTableEntry]` (section 12) |
| | `toolSetFor(ports) -> { descriptions: ToolDescription[], byName: Map<string, ToolTableEntry> }` | entries whose `available(ports)` is true |
| `guest/session/turn-hooks.js` | `turnHooks` | `{ beforeRound: [], onCancel: [], onSettle: [], turnSources: [], recoverySteps: [] }` |

**`SessionCore`** (made by `session.js`, passed to W1a.5's functions; vat-internal, not an exo):

```js
{
  records,            // RecordLog
  queue,              // Queue (W1a.5)
  current(),          // ActiveTurn | undefined
  settle(active, { status, error?, final? }),   // section 6.3, including the next claim
  report(patch),      // RowReporter.changed, coalesced per crank
  publishOutside(events),  // answered publish with publisher refresh (section 5)
  lastKnownTime(),
  claimNext(),        // claim the first waiting entry if idle and no hold
}
ActiveTurn = { turn, sink, turnId, generation, state, round, dispatched: boolean,
               ports: TurnPorts | undefined, claimAt: number, reopening: boolean,
               openIntents(): ToolIntent[] /* intents of the current round without a
               ToolResult */, dropPorts() /* also stops holding those ports */ }
```

### W1a.5 queue and recovery (vat)

| file | export | signature |
|---|---|---|
| `guest/session/queue.js` | `makeQueue({ onChange, turnOf? }) -> Queue` | `onChange()` is called after any change (the session publishes `pending` and reports `queuedCount`); `turnOf(kept)` turns what `claim` was given into the receipt's Turn (the session passes its turn record and mints; identity by default) |
| | Queue | `{ enqueueOnce(submission, requestId, at) -> { receipt: Receipt, added: boolean }, receiptFor(requestId) -> Receipt \| undefined, view() -> PendingView, first() -> QueueItem \| undefined /* undefined while held */, claim(item, turn) -> void, hold(reason, message), release() /* every hold but interrupted */, holdReason() -> string \| undefined, size() }` |
| | QueueItem | `{ entry: QueueEntry, key, submission, at, requestId }` |
| | `assertNoActiveTurn(current)` | throws `texts.activeTurn` (R4-10) when `current` is not undefined; for `startTurn` |
| `guest/session/recovery.js` | `recoverAfterRestart(core: SessionCore, active: ActiveTurn, { steps? }) -> boolean` | section 7; synchronous; returns false when there is no current turn of `active.generation` or this generation was already recovered; `steps` defaults to `turnHooks.recoverySteps` (tests pass their own) |
| | `isRestartSignal(error) -> boolean` | `isRetiredBreak(error)`; call it only at adapter call sites (section 7 table) |

### W1a.6 factory and provisioning

| file | export | signature |
|---|---|---|
| `guest/factory/main.js` | `make({ host, vats }) -> HarnessRoot` | the installed application's entry |
| `guest/factory/services.js` | `serviceBuilders`, `buildSessionServices(context) -> Promise<SessionServices>` | hook table (section 12) |
| `guest/factory/session-options.js` | `optionResolvers`, `resolveCreateOptions(options, context) -> Promise<ResolvedOptions>` | hook table (section 12) |
| `scripts/provision-steps.js` (Node) | `provisionSteps`, `provision(context) -> Promise<void>` | section 9; `context = { client, connect }` |
| `scripts/provision.mjs` (Node) | `provisionState(statePath)` and a CLI | runs `provision` against a served state |

---

## 12. Hook tables (append-only for later milestones)

- `guest/session/tool-table.js` `toolTable`: entries `{ name, describe() -> ToolDescription,
  available(ports) -> boolean, execute({ opId, args, turnId }, ports) -> Promise<ToolOutcome> }`.
  M1a's only entry is `echo`: available when `ports.tools` has an entry named `echo`;
  `execute` = `E(tool).execute({ opId, args })`. An entry may also throw; the session treats a
  throw as `failed` with its message, and a retired break from an adapter object as a restart.
- `guest/session/turn-hooks.js` `turnHooks`: each a list of functions called in order with a
  context `{ core, active, round }`: `beforeRound` (before each `startRound`; may append records;
  M8), `onCancel` (in the cancel crank; M6), `onSettle` (in the settle crank), `turnSources`
  (sources of turns besides the queue; M9), `recoverySteps` (section 7 step 6; M9). In M1a all are
  empty.
- `guest/factory/services.js` `serviceBuilders`: `[(context) -> Promise<Partial<SessionServices>>]`
  merged in order; `context = { admin, backend, preset, key }`. M1a: `{ backend, host: E(admin).forSession() }`.
- `guest/factory/session-options.js` `optionResolvers`: `[(options, resolved, context) ->
  Promise<void>]` that fill `resolved` (`{ title, preset, backend, modelId, userInitiated }` in
  M1a).
- `AH/index.js` `backendKinds`, `adapterTools` (section 11); `AH/channel-taps.js` `channelTaps`.
- `scripts/provision-steps.js` `provisionSteps`: `[{ name, run(context) -> Promise<void> }]`,
  each idempotent.

---

## 13. Fixed texts

Exact strings live in `interfaces.js` `texts` and `textOf`; the unit test checks them.

| constant | text | source |
|---|---|---|
| `texts.activeTurn` | Session already has an active turn; observe or cancel it first | R4-10 |
| `textOf.unknownTool(name, available)` | `Unknown tool: "x". Available tools: a, b` | R4-43 |
| `textOf.unexpectedArgument(key, tool, allowed)` | `Unexpected argument "x" for echo; allowed arguments: text, delayMs, bytes, data` | R4-43 |
| `textOf.argumentsNotJson(err)` | `could not parse tool arguments as JSON (…). Re-send this tool call with valid JSON arguments.` | R4-45 |
| `textOf.errorResult(msg)` | `Error: <msg>` | R4-45 |
| `textOf.truncationMarker(n)` | `\n[Tool output truncated from N characters. Only a prefix is shown; use filtering or pagination for more.]` | R4-46 |
| `texts.roundLimit` | I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again? | R4-47 |
| `texts.interruptedBeforeDispatch` | Interrupted before dispatch; no backend execution was started. | R4-66 |
| `texts.toolOutcomeUnknown` | Tool outcome unknown; do not automatically retry. | R4-32, R4-66 |
| `texts.frameLimit` | round output exceeds this build's frame limit | harness (M1a) |
| `textOf.tooManyCalls(n, 64)` | Too many tool calls in one round (N); only the first 64 were run. | architecture 4.1 |
| `texts.invalidToolCall`, `texts.duplicateToolCallId` | Invalid provider tool call; Provider returned a duplicate tool call ID within one response | R4-42 (Fae) |
| `textOf.synthesizedCallId(r, i)` | `floot-synth-<r>-<i>` | R4-42 |
| `textOf.queueFull(100)` | This session already has 100 messages waiting; send or delete some first | R4-53 |
| `texts.holdRestart` / `holdStopped` / `holdInterrupted` / `textOf.holdRefused` / `texts.holdRefusedDefault` / `textOf.holdUnavailable` | the A.4 hold texts | A.4 |
| `texts.invalidRequestId`, `requestIdExpired`, `requestIdReused`, `receiptLimit` | Fae pending-queue texts | R4-55 |
| `texts.modelOption` | createSession option "model" is unsupported; use backend and modelId | R4-6 (object-passing wording) |
| `texts.blankSubmission` | A queued message must be non-empty text | A.4 / R4-55 (the spec names the refusal without a text; Fae `pending-queue.js:49-53`, J-0253, J-9150) |
| `texts.turnAlreadyResolved` | This turn was already resolved | harness (J-9150) |
| `textOf.optionNotSupported`, `texts.noBackend`, `texts.unknownSession`, `texts.badCursor`, `texts.resolveNotUnknown`, `texts.entryGone`, `texts.unknownSessionHost`, `textOf.openFailed`, `textOf.scriptExhausted`, `textOf.submissionTooLarge`, `textOf.invalidArgument` | harness texts | this contract |

---

## 14. Measurements (W1a.0 vat probe)

One run each under the run lock, release worker, crank budget 50 M, workspace vat reached through
`client.call('evaluate', ...)` (control-socket floor 158-177 ms per call), commit `d0a35ae1f6` with
the W1a.0 files uncommitted. Journal J-0201.

| what | eager guards (first draft) | lazy tables (as committed) |
|---|---|---|
| bundle of `interfaces.js` + `limits.js` (comments included) | 43,204 bytes | 42,323 bytes as probed; 42,793 bytes as committed (21 % of the 200 KB session program) |
| staging, 6 pieces of 8,192 characters | 1.7-2.8 s | 1.7-2.6 s |
| evaluating crank (load), total / over the floor | 697-874 ms / 539-697 ms | 195-203 ms / about 40 ms |
| first use of the 6 interfaces a session vat needs (with their shapes) | - | 199-202 ms over the floor, once per vat (persisted) |
| the same again | - | 3-11 ms |
| first use of the other 17 interfaces / all remaining shapes | - | 350-359 ms / 9-18 ms |
| checks in the vat | a Turn exo accepted a note and refused a 5,000-unit note; a TurnSink refused an extra key and 300 tool calls; `TextEncoder` is a function; `matches` works | same |

Micro costs in the vat (over the floor, 50 M): 100 `M.string` 113 ms; 100 `M.splitRecord` 150 ms;
20 `M.interface` of 5 methods 513 ms (about 25 ms each); 100 `M.or` 67 ms.

---

## 15. Decisions this contract made

- **Lazy guard tables** (section 1.9, 14): eager construction would add 0.55-0.7 s to every vat's
  loading crank (session program, factory, manager).
- **`M.splitRecord` is open by default** (its rest pattern defaults to `M.any()`); every shape here
  passes `{}` as rest. Builders who write other patterns must do the same.
- **Exact UTF-8 sizes in vats** via `TextEncoder` after the cheap estimate (rule 12.5 said
  "estimate units x 3"; the estimate alone would refuse an 8,192-character ASCII submission inside a
  RoundRequest).
- **`Backend.open(host)` once per adapter incarnation** (J-9151, replacing "per turn", which cost
  one manager hop and one session delivery per turn and made `turn.start` 573 ms against 350,
  J-0272/J-0293): the session opens in `make` and holds `TurnPorts` (endpoint, publisher, adapter
  tools, `since`) across turns; a stale Endpoint is found by its lease and handled by section 7.1.
  `SessionHostFacet` is minted unbound and bound after `make` (`bindSession`), because `make` needs
  the facet before the Session exists; `open` waits for that bind.
- **Settled turns are records** (J-9152): one `TurnInfo` record per turn and the record log; Turn
  objects are minted from records on demand, at most `retainedTurnHandles` (32) kept; receipts keep
  records, not exos. Exo classes are defined once per session (`defineExoClass`).
- **History return guards are structural** (J-9156, section 3.1).
- **Tool arguments are never parsed in a vat**; JSON and argument checks (R4-43, R4-45) happen in
  the adapter tool. A vat-side tool (M5+) that must read arguments needs its own design for rule
  12.10.
- **Frame-limited tool result** fails the turn after the round's other calls settle (acceptance 8),
  rather than becoming an ordinary failed result the model would see.
- **`userInitiated` defaults to true** in M1a (R4-6 says the UI sets it; acceptance 1 creates
  without it and expects the row listed). Subagents (M9) pass `false`.
- **R4-6 wording**: "use backend and modelId" instead of Endo's "use backendId and modelId".
- **`Turn.resolve(note)`** replaces A.4 `resolveTurn(turnId, note)`; the Turn is reached through
  history pages (`TurnPreview.turn`) or receipts.
- **Cancel waits for running tool calls** before settling `cancelled` (R4-44, R4-49).
- **Not decided here** (left to later milestones, each a contract change): Blob-valued fields and
  `TurnSink.progress` (M1b), `getTurnContent`, queue `edit`/`sendNow`, emergency stop, presets beyond
  `chat-only`, system prompts, real backends' `listModels`.
