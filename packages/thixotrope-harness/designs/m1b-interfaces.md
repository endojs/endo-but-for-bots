# M1b interface contract

Unit W1b.0 of `milestones.md` M1b. This file, `guest/lib/interfaces.js` and `guest/lib/limits.js`
are the contract the M1b builders (W1b.1-W1b.5) and the tests (W1b.6) build against without talking
to each other. `m1a-interfaces.md` stays the M1a contract (it gets corrections only) and everything
in it still holds unless a section below changes it. Where this file and the code disagree, the
guards win and this file is wrong: report it. Paths: `H/` = `packages/thixotrope-harness/`, `AH/` =
`H/resources/agent-host/impl/`, `pkg/` = `packages/thixotrope/`. Spec items are `R3-n`, `R4-n` and
`A.n` of `endo-harness-spec.md`; "architecture n" is `designs/architecture.md` section n; "contract
n" is `m1a-interfaces.md` section n.

Contents: 1 rules; 2 who builds what and imports what; 3 objects, holders and methods; 4 the blob
model (D-15); 5 staged fields in records, events and outcomes; 6 crank-by-crank sequences with
message sizes; 7 retired breaks at every new call site; 8 exec; 9 the context cache protocol; 10
pool and list feed; 11 module entry points; 12 hook tables; 13 fixed texts; 14 items carried from
M1a; 15 measurements; 16 decisions, deviations and open points.

---

## 1. Rules

### 1.1 What M1a's rules become

Contract 1 holds, with these changes:

1. **Staging replaces refusal** (contract rule 5). From M1b every text field that crosses into a
   vat is either an inline string of at most `inlineBytes` (8,192) UTF-8 bytes or a `StagedText`
   (section 4). Whoever produces the text stages it (architecture D-10): the Composer for
   submissions, the provider code for model text, tool-call arguments, partial text and native
   context, the callee for tool results (echo in the adapter, the exec vat through a
   `BlobWriter`). A guard still admits inline strings up to its M1a unit bound (`textUnits`
   24,576): the `inlineBytes` rule is the sender's, checked in exact UTF-8 bytes (`bounded.js`).
2. **Frame rule, both directions, with one exception.** No message into a vat exceeds
   `frameBytes`; a crank sends at most `crankOutBytes` and `sendsPerCrank` messages. The one
   message allowed above `frameBytes` is `ContextSource.page`'s answer, which goes from the session
   vat to the agent-host adapter (Node) only and is bounded by `contextPageBytes` (98,304, 4
   frames; section 9, decision 16.4). Nothing sends a page to a vat.
3. **`texts.frameLimit` stays** as the failure when a message cannot be made to fit even after
   staging (section 5.4).
4. **Objects, not names.** A blob is a `Blob` handle, never a file name or key; the file key (`b<n>`)
   lives only in the manager vat and the adapter (section 4). Exec scopes, exec handles, list
   publishers, content readers, writers and timers are objects passed to their users.
5. **Guest rules** (architecture 12) apply to `H/guest/**`, including the new `guest/exec/` program.

### 1.2 Sizes used below

String content bytes, UTF-8, keys included (contract rule 4). `StagedText` = handle + preview +
`bytes`: at most 3.1 KB (a 1,024-unit preview of 3-byte characters), typically 0.3-1.1 KB; a tool
argument or result preview is at most 256 units (0.8 KB).

### 1.3 The M1b tables and when an implementer switches

`interfaces.js` keeps M1a's tables (`shapes`, `interfaces`, `methodNames`) and adds three:

- `m1bShapes`: every new shape (section 3 names them).
- `m1bInterfaces`: every new interface, **and the M1b version of six M1a interfaces**: `TurnSink`
  (+`progress`), `Turn` (+`getContent`), `Live` (+`subscribeList`), `AgentHostAdmin`
  (+`content`, `listPublisher`), `SessionFactory` (+`sessionListFeed`), `HarnessRoot`
  (+`loadExecProgram`, `configure`, `whenSettled`; `status` gains `execProgram`, `pool`). Each keeps
  M1a's methods first, in order (unit test).
- `m1bMethodNames`.

Why separate tables: `makeExo` refuses an interface guard whose methods it does not implement
("methods [...] not implemented", checked in the W1b.0 unit test), so adding a method to an M1a
guard would break every running exo until its owner implements it. **The unit that implements an
M1b method switches that exo from `interfaces.X` to `m1bInterfaces.X` in the same commit.** Until
then the M1a guard stands. `m1bInterfaces.ContextSource` replaces M1a's shape-only
`interfaces.ContextSource` (its answer gains `from`; nobody implemented the M1a one). At M1b
sign-off the PM folds the M1b tables into the M1a ones and adapts `test/unit/m1a-interfaces.test.js`
in one contract commit.

**In-place widenings** (additive; every M1a value still matches; the M1a unit test passes
unchanged): the shapes in section 5.1 accept a `StagedText` where they took a string;
`TurnPorts` gains optional `content`, `writers`, `timer`; `SessionServices` gains optional
`execVat`; `LiveBatch` gains optional `reason`; `ScriptToolCall` gains optional `code`;
`ScriptRound` gains optional `nativeContext`. A receiver built for M1a that is sent a staged field
would fail, so senders stage only once the receivers they send to accept it: within M1b both sides
of every staged path belong to W1b.1 (section 2), which lands them together.

---

## 2. Who builds what and imports what

### 2.1 Order and file ownership

Order (milestones.md): W1b.0 alone; then **group A** = W1b.1, W1b.3, W1b.5 in parallel; then
**group B** = W1b.2, W1b.4 in parallel; then W1b.6. The milestone's "Owns" line lists only the new
files. M1b also needs edits to M1a files; this contract assigns each such file to exactly one unit
per group, so no two units running at once edit the same file:

| file (M1a-built unless marked new) | group A owner | group B owner | why |
|---|---|---|---|
| `AH/blobs.js`, `AH/content.js` (new) | W1b.1 | - | blob store, Content |
| `H/guest/session/staging.js` (new) | W1b.1 | - | vat helpers for staged fields |
| `H/resources/agent-host/durable.js` | W1b.1 (sink `mintBlobs`/`resolveBlobs`; `AgentHostAdmin.content`; switch to `m1bInterfaces.AgentHostAdmin` with `listPublisher` forwarding to ops) | W1b.2 (the list wiring, only if W1b.1 left it; 2.2) | the manager is one file |
| `AH/index.js`, `AH/attach.js` | W1b.1 (blob store, Content, writers, timer per incarnation; `listPublisher` ops answer from `AH/list-channel.js`) | W1b.2 (context cache per incarnation) | composition |
| `AH/endpoint.js` | W1b.1 (TurnPorts `content`, `writers`, `timer`; progress plumbing) | W1b.2 (cache in `startRound`) | |
| `AH/composer.js` | W1b.1 (stage submissions) | - | |
| `AH/channels.js` | W1b.1 (fold staged fields as previews; `LiveBatch.reason`) | - | |
| `AH/live-service.js` | W1b.1 (`subscribeList` over `AH/list-channel.js`; switch to `m1bInterfaces.Live`) | W1b.2 (the same, only if W1b.1 left it; 2.2) | |
| `AH/list-channel.js` (new) | W1b.5 | - | list channel, adapter side |
| `AH/providers/scripted.js` | W1b.1 (staging, progress, `nativeContext`, `code`) | W1b.2 (project through the cache; log the projection) | |
| `AH/tools/echo.js` | W1b.1 (stage results over `inlineBytes`) | - | |
| `AH/{context-cache,projection,projection-hooks}.js` (new) | - | W1b.2 | |
| `H/guest/session/{session,turn,records,queue,recovery}.js` | W1b.1 (staged fields, `progress`, `Turn.getContent`, the tool seams of 2.3) | W1b.2 (`turn.js` `roundRequest` adds `context`; `session.js` makes the source) | one session-vat owner per group |
| `H/guest/session/context-source.js` (new) | - | W1b.2 | |
| `H/guest/session/tool-table.js`, `turn-hooks.js` (hook tables, append) | - | W1b.4 | exec entry and its hooks |
| `H/guest/session/tools/exec.js` (new) | - | W1b.4 | |
| `H/guest/exec/` (new) | W1b.3 | - | exec program |
| `H/guest/factory/{pool,list-feed}.js` (new) | W1b.5 | - | |
| `H/guest/factory/{factory,root,main,rows,services}.js` | W1b.5 | - | pool, list feed, `ExecHandle` |
| `H/scripts/provision-steps.js` (hook table, append) | W1b.5 (load the exec program) | - | |
| `H/guest/lib/{interfaces,limits}.js`, this file, `m1a-interfaces.md`, `H/guest/session/live.js` | W1b.0 only | | contract |
| `H/test/{unit,adapter}/m1b-<unit>-*.test.js` | each unit its own | | |
| `H/test/integration/m1b-*.test.js`, `H/perf/{exec,pool,concurrency,hub,history}.perf.mjs` | W1b.6 | | |

`H/guest/lib/tool-output.js` (milestones "Owns") is **not created**: `bounded.js`
`boundToolOutput` (M1a W1a.1) already is Fae's `session/tool-output.js` cut with the R4-46 marker,
surrogate-safe; the image branch is M8's.

Nothing to build for "calls-per-round cap and window" (W1b.5 row): `turn.js` already runs at most
`maxCallsPerRound` (64) and gives the rest `textOf.tooManyCalls` (M1a `runTools`), with at most
`callWindow` (16) in flight (`issueWaiting`); acceptance 6 tests it.

### 2.2 Imports between units

A unit imports another unit's file only by the entry points of section 11. A group A unit never
imports a group A file of another unit (they do not exist yet); group B imports group A's files.

| unit | imports from other units |
|---|---|
| W1b.1 | W1b.0 all; M1a `bounded.js`, `retired.js`, `reply-fold.js`; W1b.5 `AH/list-channel.js` **only after W1b.5 committed it** (the `listPublisher`/`subscribeList` wiring is W1b.1's last commit in group A; if W1b.5 is not done, W1b.1 leaves that wiring to W1b.2 and says so in its report) |
| W1b.3 | W1b.0 `m1bInterfaces.ExecScope`, `m1bShapes`, `texts`, `textOf`, `execArgumentNames`; M1a `bounded.js` (`boundToolOutput`, `cutText`, `chunkText`, `utf8Bytes`) |
| W1b.5 | W1b.0 all; M1a factory files, `channels.js` internals it needs (read-only; it does not edit `channels.js`) |
| W1b.2 | W1b.0; W1b.1 `AH/blobs.js` (`BlobStore.read`, `resolveMany`), `staging.js` (`isStaged`, `blobsOf`); M1a `records.js` |
| W1b.4 | W1b.0; W1b.1's seams in `turn.js` (section 2.3) and `staging.js`; W1b.3's `ExecScope` and W1b.5's `ExecHandle` only through their guards (objects reached via `services.execVat`) |
| W1b.6 | everything, through public objects; M1a `test/integration/_m1a-slice.js` helpers; `ensureTemplate({ id: 'm1b', provision })` with `scripts/provision-steps.js` |

### 2.3 Session seams W1b.1 builds for W1b.4 (in `turn.js`, group A)

So that W1b.4 never edits `turn.js`, W1b.1 makes these changes, each backward compatible with the
`echo` entry:

1. **Tool context.** `issue()` calls `entry.execute(request, ports, context)` with a third argument
   `ToolContext` (vat-internal, plain hardened record):
   `{ turn: Turn, turnId, generation, round, services: SessionServices, endpoint: Endpoint | undefined }`
   (`endpoint` is `ports.endpoint`). M1a entries ignore it.
2. **Availability with services.** `toolSetFor(ports, table, services)` calls
   `entry.available(ports, services)`; M1a's `echo` ignores the second argument.
3. **Deadlines reach the entry.** `TurnSink.deadline({ opId })`: if the current turn has an issued,
   unsettled intent with that op id, call `entry.deadline?.({ opId }, context)` for that intent's
   entry (synchronously, in this crank); otherwise ignore (as M1a). The entry settles its own
   pending `execute` promise.
4. **Cancel does not wait for an entry that abandons.** Unchanged code path: `Turn.cancel()` runs
   `turnHooks.onCancel` in the cancel crank (M1a); an entry whose hook resolves its pending
   `execute` in that crank lets the turn settle `cancelled` in the same crank (the result is
   recorded as usual, section 8.4).
5. **Staged outcomes.** `onToolOutcome` records `outcome.text` unchanged when it is a `StagedText`
   (the callee already cut it, R4-46) for `ok`; for `failed` with a `StagedText` it records it
   unchanged too (the staged text is the complete model-facing result, section 5.3).

---

## 3. Objects, holders and methods

Columns as contract 3: **caller**; **crank** (section 6 names); **mode** (answered `E()` or
`sendOnly`); **max** (largest message, bytes); **retired break** (section 7 has the actions).

### 3.1 Blobs and content (W1b.1; adapter objects are transient)

**`Blob`** (`m1bInterfaces.Blob`, no methods) - minted by the agent-host manager vat in stock
batches, bound to a file by the adapter, then held by whoever receives the `StagedText`: session
records, queue entries, receipts, events in flight, the exec vat while it reads a source. Durable
(a manager exo). Reading it is `Content.read`; nobody calls the handle.

**`StagedText`** (`m1bShapes.StagedText`) `{ blob: Blob, preview, bytes }`: `preview` is the
text's first `messagePreviewUnits` (1,024) units for messages, submissions, partial text and native
context (native context: `preview` is `''`), and its first `toolPreviewUnits` (256) for tool
arguments and results; cut surrogate-safe (`previewText`), no marker. `bytes` is the exact UTF-8
length. A `StagedText` is a closed record: no units count, no digest, no name.

**`Content`** (adapter, one per incarnation) - held by the gateway (in process, M3), tests
(`AgentHostAdmin.content()`), and the exec vat for one call (through `ExecRequest.content`).

| method | caller | crank | mode | max | retired break |
|---|---|---|---|---|---|
| `read(blob, { offset, maxBytes }) -> { text, next, done }` | exec vat; tests | exec read crank (section 6.2) | answered | answer <= `blobPageBytes` (20,480) + 40 | exec vat: the adapter restarted; fail the call (`Error: ...`), section 7 |

`offset` and `next` are UTF-8 byte offsets; a page holds whole code points only (it ends before a
character that would cross `maxBytes`), so surrogate pairs are never split; `done` is true when
`next === bytes`. An unknown or never-bound handle throws `texts.blobUnknown`. Node code in the
adapter reads whole texts with `BlobStore.read(blob)` (section 11), not through the exo.

**`BlobWriters`** (adapter, one per incarnation, in `TurnPorts.writers`) - `open() -> BlobWriter`,
answered, tiny. **`BlobWriter`** (adapter, one per blob being written):

| method | caller | mode | max | notes |
|---|---|---|---|---|
| `append(piece)` | exec vat | answered | piece <= `blobPieceBytes` (12,288), outbound from the vat | one answered piece per crank; throws `texts.writerClosed` after close or abort |
| `close() -> StagedText` | exec vat | answered | answer <= 1 KB | writes the file, fsyncs file and directory, binds a stock handle, answers; `preview` = first 256 units |
| `abort()` | exec vat | answered or sendOnly | tiny | drops the partial file |

An open writer idle for `blobWriterIdleMs` (60 s) is aborted by the adapter.

**`Timer`** (adapter, one per incarnation, in `TurnPorts.timer`) - `sleep(ms)`, answered, settles
after `ms` (0..`maxDelayMs`); the exec vat's `sleep(ms)` endowment (section 8). Retired break: the
adapter restarted; inside model code the `await` rejects (section 7).

### 3.2 Agent-host adapter and manager changes (W1b.1, W1b.2)

- **`TurnPorts`** gains `content`, `writers`, `timer` (all three present from W1b.1 on; optional in
  the guard only for M1a compatibility). They belong to the incarnation that made the ports and go
  dead with it, like the endpoint.
- **`TurnSink.progress({ round, partial, tail, at }) -> boolean`** (`m1bInterfaces.TurnSink`):
  adapter -> session, **answered** (M1b QC, J-0393; it was sendOnly), at most 6.2 KB, sent when a
  round has produced `progressEveryBytes` (16,384) new UTF-8 bytes or `progressEveryMs` (10 s) have
  passed since the last checkpoint (and there is new text), **and** the round's earlier checkpoints
  together staged at most `(progressWriteFactor - 1)` (2) times the text so far, so the bytes a
  round's checkpoints write stay at most about 3 times its text (they were quadratic: 34 MB for a
  1 MiB reply). The answer is `true` when the session kept the checkpoint in place of the previous
  one; the adapter then deletes the previous checkpoint's file (`BlobStore.discard`). `false`, or a
  break, keeps every file: the session may still hold or have recorded the older one. A round
  that checkpointed and has text after its last checkpoint stages one more checkpoint of the whole
  text before `roundFinal` and waits for its answer; the reply reuses that blob, so no superseded
  checkpoint stays on disk after the round (one more session crank per such round). `partial` is the round's whole text so far, staged; `tail` its last
  `messagePreviewUnits` units. The session keeps the latest checkpoint of the current round
  **outside** the record log (it replaces the previous one; architecture 4.3 "replaces the single
  partial record") and appends it as one `Partial` record only if the round ends without
  `roundFinal`: `roundFailed` without its own `partial`, cancel while the round streams, or
  recovery. A checkpoint for another round or a settled turn is ignored.
- **`AgentHostAdmin.content() -> Content`**, **`AgentHostAdmin.listPublisher() -> ListPublisher`**
  (`m1bInterfaces.AgentHostAdmin`): answered, forwarded to the current ops facet like `live()`.
  Held: `content` by operators, tests and (M3) the gateway; `listPublisher` by the factory only.
- **Manager sink, internal to W1b.1** (guard in `durable.js`; shapes in `m1bShapes`):
  `mintBlobs() -> BlobStock` (`blobStockBatch` (32) entries `{ blob, key }`, keys `b<n>` from a
  durable counter; the manager keeps `WeakMap<Blob, key>` only) and `resolveBlobs([Blob]) ->
  BlobKeys` (at most `blobResolveBatch` (64) per call; `null` for a handle it does not know). One
  manager crank each.
- **`Composer.submit(session, text, requestId)`**: text over `inlineBytes` is staged and sent as
  `enqueueOnce(StagedText, requestId, at)`; blank text (`text.trim() === ''`) is refused with
  `texts.blankSubmission` before staging, whatever its length; text over `messageUnits` (200,000)
  is refused by the guard as in M1a.

### 3.3 Session vat (W1b.1, W1b.2)

- **`Session.enqueueOnce` / `startTurn`** accept `Submission = { text } | StagedText`.
  Duplicates (contract 8): an inline submission is "the same text" when the strings are equal; a
  staged one when `bytes` and `preview` are equal (the vat cannot read the blob; a retry stages a
  new blob for the same text). Inline and staged never compare equal. A staged submission is never
  blank (the Composer refused that).
- **`Turn.getContent(cursor?) -> { records, next? }`** (`m1bInterfaces.Turn`): the turn's records
  in full, in log order (strings at most `inlineBytes`, larger fields staged), pages of at most
  `frameBytes` and `pageRecords` (512); cursor `c<n>` (opaque text, F.2 d); an unknown cursor
  throws `texts.badCursor`. Caller: gateway, tests; answered. This is architecture 3.2's
  `getTurnContent(ref)` in object form (the Turn is the reference). Return guard is structural
  (records as keys, as M1a's history views).
- **`ContextSource`** (`m1bInterfaces.ContextSource`; one per session, made by `context-source.js`,
  passed in every `RoundRequest.context` from W1b.2 on): `page(cursor?) -> { from, records, next? }`.
  Caller: the adapter's context cache; answered; answer at most `contextPageBytes` (98,304, to the
  adapter only) and `pageRecords`. Section 9.

### 3.4 Exec (W1b.3 exec vat, W1b.4 tool, W1b.5 handle)

**`ExecScope`** (`m1bInterfaces.ExecScope`) - the completion value of the exec program's
evaluating crank (`makeExecScope()`); one per exec vat; held by the factory's pool (as a spare) and
then by the `ExecHandle` and the session it serves (from `ExecHandle.scope()`).

| method | caller | crank | mode | max | retired break |
|---|---|---|---|---|---|
| `run(ExecRequest) -> ExecOutcome` | session (exec entry) | D or E (the issuing crank) | answered; settles when the call ends, or at once with `{ status: 'busy' }` | request: inline <= 12.4 KB (8,192 args + notice), staged ~1-3 KB; answer: inline <= 8.3 KB, staged ~1 KB | **exec vat lost** (halted or given up): terminated result + `retire(scope)` (section 8.3) |
| `abandon()` (M1b QC, J-0391) | session (exec hooks `onCancel`, `recoverySteps`) | the cancel crank; the recovery crank | **sendOnly** | tiny | none (dropped) |

`ExecRequest = { args, writers, timer, content?, notice? }`: `args` is the model's JSON argument
text, inline (at most `inlineBytes`) or a `StagedText` (then `content` is required);
`writers`/`timer`/`content` are the current turn's `TurnPorts` ones; `notice` is a text the exec
vat puts first in the result (the busy reset, section 8.4). `ExecOutcome` = a `ToolOutcome`
(`ok` | `failed`, inline or staged; never `frame-limit`), `{ status: 'busy' }`, or (M1b QC, J-0390)
`{ status: 'exhausted' }`: the vat's name table ran out ("property key space exhausted", a
catchable RangeError in this engine, so the vat does not halt); the session records
`texts.execExhausted` and retires the scope.

**`ExecHandle`** (`m1bInterfaces.ExecHandle`) - factory exo, one per session, made at creation by
W1b.5's service builder, held only by that session (`SessionServices.execVat`).

| method | caller | mode | max | notes |
|---|---|---|---|---|
| `scope() -> { scope: ExecScope, deadlineMs }` | session, only when it holds no scope (first exec call, after a retire) | answered | tiny | takes a spare exec vat (or creates one cold, about 1-3 s plus staging) and keeps it as this session's current scope; answers the same scope until retired; `deadlineMs` is the factory's `execDeadlineMs` setting |
| `retire(scope)` | session | **sendOnly** | tiny | if `scope` is this handle's current one: `E(facade).retire()` that vat, forget it, start a refill; otherwise nothing. The next `scope()` takes a fresh vat. Messages from one vat to one object arrive in order, so a `scope()` sent after a `retire` sees it |

Retired break from `scope()`: the factory vat is lost (cannot happen while anything works) - the
call fails with `textOf.execUnavailable(message)`.

There is no `ExecHandle.run`: a call forwarded through the factory would cost two more deliveries
per exec call (a factory crank and an answer back), which would break `exec.trivial` (<= 250 ms;
decision 16.2). The session calls the scope directly.

### 3.5 Factory (W1b.5)

- **`SpareMaker`**: unchanged from M1a (`make(MakeArgs) -> MadeSession`, once per vat). "Completed"
  means the pool's order: a take is `make(...)` then `bindSession(host, session)`, exactly as a
  cold creation (contract 9 steps 4-5); the creation-time `open` the session sends in `make` is
  answered by the manager only after the bind. `MakeArgs.services` now carries `execVat`.
- **`SessionFactory.sessionListFeed() -> { rev }`** (`m1bInterfaces.SessionFactory`): the factory's
  current list rev; answered; tiny. Viewers then call `Live.subscribeList(rev)` on the gateway's
  `Live` (section 10.2).
- **`HarnessRoot`** (`m1bInterfaces.HarnessRoot`, operator only): `status()` gains `execProgram`
  (digest, bytes) and `pool` (`PoolStatus`); `loadExecProgram(ProgramPiece)` as
  `loadSessionProgram` for the exec program (`guest/exec/main.js`, bundled by `bundle-guest exec`);
  `configure({ spareSessions?, spareExec?, execDeadlineMs? }) -> PoolStatus` (targets 0..16;
  deadline 1,000..600,000 ms; kept in the factory heap; a new deadline applies to scopes handed out
  afterwards); `whenSettled() -> PoolStatus` settles when no refill is in flight (`refilling === 0`).
  `PoolStatus = { spareSessions, spareExec, refilling, target: { spareSessions, spareExec } }`.
- **`ListPublisher.publish({ rev, events })`** (`m1bInterfaces.ListPublisher`, adapter): factory ->
  adapter, **sendOnly**, one batch per factory crank that changed rows, at most
  `publishBatchEvents` (64) events and `frameBytes`.

### 3.6 List subscribers (W1b.5 channel, W1b.1 wiring)

- **`Live.subscribeList(rev?) -> ListSubscription`** (`m1bInterfaces.Live`): gateway-local, answered.
- **`ListSubscription`**: `next() -> ListBatch` (as `LiveSubscription.next`: resolves when at least
  one delivery is queued; at most `liveBatchDeliveries`), `close()`. First delivery
  `{ seq, rev, event: { type: 'list-snapshot' } }`, `rev` = the latest rev the channel has seen
  (0 = none since the adapter started). Bounds and drop rules: the session channel's
  (`channelLimits`), `reason` on close.

---

## 4. The blob model (D-15, decided)

1. **Who mints.** The agent-host manager vat, in batches of `blobStockBatch` (32) through the
   attach sink (`mintBlobs()`, one manager crank per batch). Each handle is a `Blob` exo with a
   file key `b<n>` (durable counter) kept in the manager's `WeakMap<Blob, key>`; the manager holds
   handles weakly. The adapter keeps an in-memory stock and refills when it falls below 8, with at
   most one refill in flight. A hot path (staging) takes a handle from the stock and costs no
   manager crank; only a refill does.
2. **When it becomes readable.** The adapter writes the text to `<blobDir>/<key>.part`, fsyncs the
   file, renames it to `<blobDir>/<key>`, fsyncs the directory, records `presence -> { key, bytes }`
   in its incarnation's `WeakMap`, and only then lets the handle leave the process (in a message to
   any vat or object). Every handle any vat holds is therefore readable. A handle in the stock is
   never sent anywhere.
3. **Where the files are.** `blobDir` = `<state>/agent-host/blobs/`, where `<state>` is the state
   directory, found from the adapter process's bundle path (`process.argv[3]` is
   `<state>/bundles/<digest>.cjs`, `pkg/src/store/store-fs.js:54`), so state copies and templates
   carry their blobs (fact 10). Mode 0700 (open decision 3: unencrypted at rest).
4. **How a vat refers to staged text.** Only as a `StagedText` `{ blob, preview, bytes }` inside a
   record, an event, a submission, an outcome or a request. A vat never reads a blob except the exec
   vat reading its own source through `Content.read`, in pages of at most `blobPageBytes`.
5. **How the adapter reads without a vat hop.** `BlobStore.read(blob)` looks the presence up in the
   incarnation's `WeakMap` (S2 (d): one presence per vat object per incarnation) and reads the file;
   no vat is involved. Content, the context cache and the gateway all read this way.
6. **How handles survive a restart.** The handles are durable manager exos held in session
   records; the files are on disk; the keys are in the manager. A new incarnation's map is empty: a
   miss collects the missing presences and resolves them with `resolveBlobs` in batches of 64 (one
   manager crank per batch, not a session crank), then reads the files. The stock is lost at a
   restart: its handles were exported only to the dead adapter session, so when the hub releases
   that session's imports the manager's `WeakMap` lets them be collected ("discarded at the next
   start"). Files `*.part` are deleted at adapter start (writes that never completed).
7. **Leaks, bounded.** A file renamed into place whose handle never reached a vat (the adapter died
   between the rename and the send) stays on disk unreferenced; at most the blobs being staged at
   one crash. M13's collection may sweep them (keys the manager no longer knows); nothing in M1b
   does.
8. **How blobs are freed when a session is deleted (M2 builds; hook specified here).** M2's
   `deleteSession(session)` in the factory: (1) page the session's blobs with
   `E(internal).blobPage(cursor?) -> BlobPage` (`m1bShapes.BlobPage`: at most 64 handles, every
   `StagedText` in the record log, queue entries, receipts and the current checkpoint; cursor `b<n>`);
   (2) for each page `E(admin).releaseBlobs(blobs) -> undefined` (manager: resolve keys, ask the ops
   facet to unlink the files, delete the keys from its map; idempotent; a missing file is fine); (3)
   retire the session vat. An interrupted delete is completed by the start listener (R4-9). The exec
   vat's results are covered because they reach the record log; a writer never closed was aborted
   (3.1). M1b adds neither method to a guard (`SessionInternal`, `AgentHostAdmin` keep their M1b
   method sets); M2 adds them as a contract change with exactly these signatures.

---

## 5. Staged fields in records, events and outcomes

### 5.1 The widened shapes (in place)

| shape | field | M1a | M1b |
|---|---|---|---|
| `Submission` | whole | `{ text }` | `{ text }` or `StagedText` |
| `ToolCall`, `ToolIntent` | `args` | `Text` | `Text` or `StagedText` (preview 256) |
| `ToolRequest` (`AdapterTool.execute`) | `args` | `Text` | `Text` or `StagedText` (W1b.1 contract change: section 6.4 sends staged `args` to echo) |
| `TurnStarted` | `input` | `SubmissionText` | or `StagedText` |
| `Partial` | `text` | `Text` | or `StagedText` (a checkpoint) |
| `RoundSettled` | `text`; new optional `nativeContext` | `Text` | `Text` or `StagedText`; `nativeContext: StagedText` (always staged) |
| `ToolResult` | `result` | `Text` (<= 32,768 units) | or `StagedText` |
| `TurnSettled` | `final` | `Text` | or `StagedText` |
| `RoundResult` | `text`; optional `nativeContext` | `Text` | as `RoundSettled` |
| `RoundFailure` | `partial` | `Text` | or `StagedText` |
| `ToolOutcome` | `text` | `Text` | or `StagedText` |
| `CurrentTurn` | `input` | `SubmissionText` | or `StagedText` |
| `VatEvent` | `turn-start.input`, `tool_call.args`, `tool_result.result`, `final.text` | strings | or `StagedText` |
| `LiveBatch` | optional `reason` | - | `CloseReason` |
| `TurnPorts` | optional `content`, `writers`, `timer` | - | adapter objects |
| `SessionServices` | optional `execVat` | - | `ExecHandle` |
| `ScriptToolCall` | optional `code: { text, repeat? }` | - | args = `JSON.stringify({ code: text.repeat(repeat ?? 1) })` |
| `ScriptToolCall` | optional `times` (W1b.6) | - | the call appears `times` times in the round (default 1), copies alike; the round's calls may then exceed `maxCallsPerMessage` (the too-big probe of 300 calls: the provider fails that round with `texts.frameLimit` before anything reaches the vat) |
| `ScriptRound` | optional `nativeContext` | - | text staged as the round's native context |

`DeltaEvent`, `FoldedMessage`, `FoldableStatus`, `SnapshotEvent` are unchanged: the channel folds
a staged field as its `preview` (W1b.1, `channels.js`), and delivers the event itself (with the
`StagedText`) unchanged; a client reads the full text through `Content`.

### 5.2 Where each staging happens

| text | stager | when | preview |
|---|---|---|---|
| submission | Composer (W1b.1) | text over `inlineBytes` | 1,024 |
| model reply text | provider (`scripted.js`, W1b.1) | at round end, text over `inlineBytes` | 1,024 |
| tool-call arguments | provider | an `args` over `inlineBytes`; then, while the `RoundResult` exceeds `roundResultBytes` (18,432), the largest remaining inline `args` | 256 |
| partial text | provider | each progress checkpoint (3.2) and the `partial` of `roundFailed` when over `inlineBytes` | 1,024 |
| native context | provider | always (opaque; `RoundResult.nativeContext`) | `''` |
| tool result | the callee: echo (adapter); exec (exec vat, through `BlobWriter`) | the model-facing text, already cut by `boundToolOutput`, over `inlineBytes` | 256 |
| `TurnSettled.final` | the session: it is the last round's `text`, inline or the same `StagedText` (no new blob) | - | - |

The session vat never stages (it has no blob writer and never reads a blob); it copies a
`StagedText` from where it arrived into its records and events.

### 5.3 Outcomes and the R4-46 cut

The callee cuts the model-facing text with `boundToolOutput` (32,768 units, R4-46 marker,
surrogate-safe) **before** staging, so a staged result is never cut again. For `ok` the
`StagedText` holds that text. For `failed`, an inline `text` is the error message (the session
records `textOf.errorResult(text)` cut by `boundToolOutput`, as M1a); a staged `text` is the
complete model-facing result (`Error: <message>` already cut) and is recorded unchanged.

### 5.4 When staging is not enough

The provider fails the round with `texts.frameLimit` (as M1a, before anything reaches the vat)
when, after staging, the `RoundResult` still exceeds `roundResultBytes` or carries more than
`maxCallsPerMessage` (256) calls. So a round of 300 tool calls (too-big probe) fails the turn and
the session goes on (no halt). A tool callee that cannot stage (no writers, manager lost) fails the
call with `textOf.stagingFailed(message)`.

---

## 6. Crank by crank

Session-vat deliveries are lettered as in contract 6; X = exec-vat cranks, F = factory, M =
manager, (A) = adapter work (no vat). Sizes are the message's string bytes.

### 6.1 An exec call with an inline source

The model's `exec` call arrives in a `roundFinal`; the session holds a scope (not the first call).

| crank | delivery | does | sends (mode, size) |
|---|---|---|---|
| D | `roundFinal` (<= 18.4 KB) | records `RoundSettled`, `ToolIntents`; the exec entry: args bytes <= `execSourceBytes` (else 8.5); pending call = `{ opId, generation, scope }` | `E(scope).run({ args, writers, timer })` (answered, <= 8.4 KB); `E.sendOnly(endpoint).armDeadline({ turn, opId, ms: deadlineMs })` (tiny); publish (sendOnly) |
| X1 | `run` | not busy: mark busy; parse `args` (JSON, closed `{ code }`), strip one fence, wrap, evaluate in the persistent Compartment, run | (model code's own sends) |
| X2..Xk | answers to model code's awaits (e.g. `Timer.sleep`) | continue | |
| Xk | | body returned: render (Fae), `boundToolOutput`; fits `inlineBytes` | answer `{ status: 'ok', text }` (<= 8.3 KB) |
| E | the answer | generation and opId still current: record `ToolResult`; clear pending | `E.sendOnly(endpoint).disarm({ turn, opId })`; publish; next call or `startRound` |

Cost: 2 session deliveries for the call (D is the round's crank anyway) + 1-k exec cranks.
`exec.trivial` (<= 250 ms) is D's send, X1 and E: about 3 x 56 ms plus the evaluation. The first
exec call of a session (or after a retire) adds `E(handle).scope()`: D sends it (answered, tiny), F
takes a spare and answers (`{ scope, deadlineMs }`), **D'** (the answer, a session crank) sends
`run` and `armDeadline`; the spare's first crank X1 pays its wake (157-176 ms in M0). `exec.first`
<= 750 ms.

A result over `inlineBytes`: at Xk the exec vat calls `E(writers).open()` (answered; Xk+1), then
`append` pieces of at most `blobPieceBytes` (each answered: one exec crank per piece; 32,768 units
of ASCII is 3 pieces), `close()` (answered: the adapter fsyncs and binds; `StagedText`), and
answers `{ status: 'ok', text: StagedText }` (~1 KB) to the session.

### 6.2 An exec call with a staged source

The provider staged the arguments (over `inlineBytes`), so `ToolCall.args` is a `StagedText`.

| crank | delivery | does | sends |
|---|---|---|---|
| D | `roundFinal` (`args` ~0.8 KB staged) | `args.bytes > execSourceBytes`: local `failed` result `textOf.execSourceTooLarge(bytes, execSourceBytes)` (recorded at once, nothing sent to the exec vat); else as 6.1 with `content` | `run({ args: StagedText, writers, timer, content })` (~1 KB) + `armDeadline` |
| X1 | `run` | busy; read page 0 | `E(content).read(blob, { offset: 0, maxBytes: blobPageBytes })` (answered, tiny) |
| X2..Xn | each page (<= 20.5 KB inbound) | append to an array; `done`: `join('')` (one string), check its bytes <= `execSourceBytes`, then as X1 of 6.1 in **this** crank; else read the next page | next `read` |

A 262,144-byte source is 13 pages: 13 exec cranks of about 260-300 ms each (inbound cost about
10 us per byte, fact 2), about 3.5-4 s, then one evaluating crank (S3: 175 ms). The source never
travels in one message (rule 12.11).

### 6.3 A staged submission

| step | where | does | sends |
|---|---|---|---|
| (A) | Composer | `text.trim() === ''` -> `texts.blankSubmission`; UTF-8 bytes > `inlineBytes`: take a stock handle, write, fsync, rename, fsync dir (`BlobStore.stage`) | `E(session).enqueueOnce(StagedText, requestId, at)` (<= 3.2 KB) |
| A | `enqueueOnce` | as contract 6.1 crank A; `TurnStarted.input` = the `StagedText`; `turn-start.input` = the `StagedText` | publish (<= 4 KB), `holdTurn`, `startRound` (round 0 `append: [TurnStarted]`, <= ~6 KB with tool descriptions) |
| (A) | provider | the context cache resolves `input` in process (section 9), projects the full text | `dispatching(0)` |

A stock refill (M, one manager crank) happens at most once per 32 stagings, in the background.

### 6.4 A staged model message and a staged tool result

| step | where | does | sends |
|---|---|---|---|
| (A) | provider, at round end | stage `text` if over `inlineBytes`; stage `args` per 5.2; always stage `nativeContext` when the script has one; check `roundResultBytes` | `E.sendOnly(sink).roundFinal({ round, text: StagedText, toolCalls, usage, at, servedBy, nativeContext })` (<= 18.4 KB) |
| D | `roundFinal` | `RoundSettled { text: StagedText, nativeContext }`, `ToolIntents` (args as received), events with the `StagedText`s; issue calls | `E(echo).execute({ opId, args })` x <= 16 (args inline or `StagedText`, <= 8.4 KB each) |
| (A) | echo | `args` staged: echo reads it with `BlobStore.read` in process; output cut by `boundToolOutput`; over `inlineBytes`: stage | answer `{ status: 'ok', text: StagedText }` (~1 KB) |
| E | the answer | `ToolResult { result: StagedText }`, `tool_result` event with it | as M1a |

Progress checkpoints during the round: each is one session crank (`progress`, sendOnly, <= 6.2 KB)
that replaces the kept checkpoint and records nothing.

### 6.5 A context page pull

The adapter receives `startRound(req)` whose `base` does not match its cache (section 9):

| step | where | does | sends |
|---|---|---|---|
| (A) | context cache | cache empty or `{ count, epoch }` != `req.base` | `E(req.context).page()` (answered, tiny) |
| P1 | `page()` | from the latest compaction boundary (M1b: 0): records from `from` while the answer stays within `contextPageBytes` and `pageRecords` | answer `{ from, records, next? }` (<= 98.3 KB, to the adapter) |
| (A) | cache | collect `Blob`s not in the incarnation map; `resolveBlobs` per 64 (M crank each, in parallel with the next page) | `page(next)` while `from + records.length < req.base.count` |
| P2..Pn | | as P1 | |
| (A) | cache | drop records at index >= `base.count`; apply `req.append`; read blob texts in process; project | `dispatching(0)` (round 0) or the provider request |

A 1,000-turn session of 4-8 records per turn (0.8-2.4 MB of records) is 9-25 pages: 9-25 session
cranks at about 70-90 ms each plus `ceil(blobs / 64)` manager cranks; budget `context.rebuild` <= 5 s
(decision 16.4).

### 6.6 A spare take, then bind (`createSession` with the pool)

| crank | where | does | sends |
|---|---|---|---|
| F1 | `createSession(options)` | validate (contract 9 step 1), row `creating`, creation record; take a spare `{ facade, maker, host }` (none: cold creation as M1a) | `E(backend).describe()` (answered, M); `E(admin).forSession()` only for a cold creation (a spare's unbound `host` was minted when the spare was made, W1b.5) |
| F2 | answers | build services: `{ backend, host, execVat: makeExecHandle(...) }` (local exo, no hop) | `E(maker).make({ config, services, rowReporter })` (answered, < 2 KB) |
| S1 | `make` | the spare wakes (157-176 ms, M0); `makeSession`; `E(backend).open(host)` (answered; the manager holds it until the bind) | answer `{ session, internal }` |
| F3 | `make`'s answer | creation record has `made` | `E(admin).bindSession(host, session)` (answered) |
| M | `bindSession` | binds; answers the held `open` (TurnPorts with `content`, `writers`, `timer`) | |
| F4 | bind answered | row `ready`, record cleared; start a refill lane if below target | answer the `Session`; `ListPublisher.publish` (sendOnly) |
| S2 | `open`'s answer | holds the ports | - |

`session.create` with the pool <= 750 ms: F1..F4 (4 factory cranks), 2-3 manager cranks and the
spare's wake. A SIGKILL after F2 (the take): the start listener finds a creation record with or
without `made` and completes or rolls it back exactly as M1a (contract 9); the spare is never put
back. Acceptance 12.

Refill (background, up to `poolLanes` (4) in parallel): `E(vats).createWorker(label)`, the program
staged in pieces (`frameBytes` units for an ASCII bundle), one evaluating crank returning a
`SpareMaker` (session) or an `ExecScope` (exec). Each refill is a creation record; the start
listener retires half-made spares and restarts refills. Spares made from another program digest
are retired, not handed out.

### 6.7 A list-feed publish

| step | where | does | sends |
|---|---|---|---|
| S | any session crank with a row-visible change | as M1a | `E.sendOnly(rowReporter).changed(patch)` (tiny) |
| F | `changed` | update the row; `rev += 1` per batch; build `[{ type: 'row', row }]` for every row changed in this crank | `E.sendOnly(listPublisher).publish({ rev, events })` (<= frameBytes; split by `splitBatches`, each batch its own rev) |
| (A) | list channel | rev order (reorder window as the session channel); fan out to subscribers in process | - |

Creations (F4), renames (through the session's `RowReporter`), lost rows and (M2) deletions
(`row-removed`) publish the same way. `listSessions().rev` and `sessionListFeed().rev` are the rev
of the last batch published.

---

## 7. Retired breaks at the new call sites

As contract 7: the text is `HUB_RETIRED_MESSAGE`; an **adapter** callee means the adapter restarted;
a **guest vat** callee means that vat is lost (halted or given up, D-17).

| caller -> callee (kind) | meaning | action |
|---|---|---|
| session -> `ExecScope.run` (exec vat, guest) | exec vat lost | record `failed` `texts.execTerminated`; `E.sendOnly(handle).retire(scope)`; drop the scope; the next call takes a fresh one. **Never** recovery |
| session -> `ExecHandle.scope` (factory, guest) | factory lost | `failed` `textOf.execUnavailable(message)` |
| session -> `ExecHandle.retire` (sendOnly) | - | none |
| session -> `Endpoint.armDeadline` / `disarm` (adapter, sendOnly) | dropped | none; the lease reveals a restart |
| exec vat -> `Content.read`, `BlobWriters.open`, `BlobWriter.*` (adapter) | adapter restarted | the call fails: `{ status: 'failed', text: <message> }`; the session's lease break (if the turn was in flight) settles the turn first or ignores this late answer |
| exec vat -> `Timer.sleep`, any object model code calls | adapter restarted / that vat lost | an ordinary rejection inside model code (the exec vat cannot classify it); model code decides |
| adapter -> `ContextSource.page` (session vat, guest) | session vat lost | abandon the round; send nothing to the provider (as `TurnSink`) |
| adapter -> manager sink `mintBlobs` / `resolveBlobs` (manager vat, guest) | manager lost | staging fails: Composer rejects with `textOf.stagingFailed`; a provider fails the round with it; a context rebuild fails the round with it |
| adapter -> `TurnSink.progress` (sendOnly) | dropped | none |
| factory -> `SpareMaker.make` of a spare (guest) | spare lost | retire the facade, drop the spare, take the next spare or create cold, once; then fail the creation as M1a |
| factory -> `ListPublisher.publish` (adapter, sendOnly) | dropped (a tombstone after a restart) | none; the start listener fetches a new publisher with `E(admin).listPublisher()`; subscribers of the dead adapter are gone anyway, new ones see the rev |
| factory -> `AgentHostAdmin.listPublisher` (manager, guest) | manager lost | no list feed; publishes are skipped until the next start |
| factory -> worker facade `retire` of an exec vat (host) | already gone | ignore |
| Composer -> `enqueueOnce` with a `StagedText` | session vat lost | reject as M1a (the staged blob stays, leak 4.7) |

Recovery (contract 7, `recoverAfterRestart`) gains nothing for exec: a pending exec call is an
open intent and gets "Tool outcome unknown" like any other; its late answer is ignored (generation
changed). W1b.4's `recoverySteps` hook only clears the exec entry's pending-call record (it never
awaits, never retires).

---

## 8. Exec

### 8.1 The exec vat (W1b.3, `guest/exec/main.js`)

- Bundle namespace exports `makeExecScope() -> ExecScope`. One `Compartment` per vat, made in
  `makeExecScope`, with globals `{ BigInt }`; its global object is the persistent scope
  (`globalThis.x = 5` in one call is `x` in the next, across turns and clean or SIGKILL restarts,
  since the vat heap is durable; architecture D-11).
- **Busy.** While a `run` is unsettled, another `run` answers `{ status: 'busy' }` in the crank it
  arrives (no evaluation). A synchronous runaway never answers (the vat halts).
- **A call's end is a fence (M1b QC, J-0391).** A call ends when its body's promise settles or the
  session sends `abandon()`. `abandon()` answers the running `run` with `failed`
  `texts.execAbandoned` at once and frees the scope (no busy for the next call); a staged source
  still being read is never evaluated. Each call gets its own `sleep`; a sleep asked for after the
  call ended sends nothing and never settles. Sleeps already in flight still answer, so code the
  call started runs at most until its next sleep (a background `for (;;) await sleep(0)` takes at
  most one more step), cannot keep the vat cranking, and a `sleep` kept on `globalThis` is dead in
  later calls. (Fencing the answers in flight too, with a `then` per sleep, made 100 answered
  sleeps 2-3 x slower in a vat, J-0391.) `sleep` is the only endowment that
  reaches outside the vat in M1b (M5's `powers` must follow the same rule: a facet per call, dead
  after it).
- **Name table (M1b QC, J-0390).** A RangeError "property key space exhausted" anywhere in a call
  (argument JSON, compile, model code, rendering) answers `{ status: 'exhausted' }`. Model code
  that catches and swallows it is not seen; the next call that needs a new name meets it again.
- **Arguments.** `args` inline or read through `content` (6.2). `JSON.parse` in the exec vat is
  allowed (rule 12.10: the exec vat is the place model data is meant to land; a key flood halts only
  this vat, which is then retired). Closed schema: a key other than `code` fails with
  `textOf.unexpectedArgument(key, 'exec', execArgumentNames)`; not JSON with
  `textOf.argumentsNotJson(message)`; empty or non-string `code` with `texts.execCodeRequired`.
- **Evaluation** (Fae `tool-makers.js:1594-1651` at `1315bef86`, ported): strip one wrapping
  markdown fence (`stripCodeFence`); wrap as `(async (powers, E, harden, console, sleep) => {\n<code>\n})`;
  `compartment.evaluate(wrapped)`; a parse failure fails the call with Fae's
  `describeParseFailure(code, message)` text. Then call it with the endowments.
- **Endowments.** `powers`: in M1b `harden({})` (M5 passes the session's live label-map facet per
  call; `ExecRequest` gains it then). `E` and `harden` from the prelude. `console`: an object with
  `log`, `info`, `warn`, `error`, `debug` that accept anything and **discard** it (R3-42: not to the
  model; a vat has no daemon log; decision 16.3). `sleep(ms)` = `E(timer).sleep(clamp(ms))` with
  `clamp = Math.min(maxDelayMs, Math.max(0, Number(ms) || 0))`.
- **Result.** `undefined` -> `texts.execNoReturn`; otherwise Fae's `renderToolResult` (JSON with
  BigInts as decimal strings; a remote capability described by its method names). A thrown error
  fails the call with its message. If `notice` was given, the text is `${notice}\n\n${rendered}`.
  Then `boundToolOutput`; over `inlineBytes`: stage through `writers` (6.1). Inline answers are
  at most `inlineBytes`.
- **No data-keyed records leave the vat**: the outcome is `{ status, text }`.

### 8.2 The exec tool (W1b.4, `guest/session/tools/exec.js`)

Tool-table entry `{ name: 'exec', site: 'guest', describe: () => execDescription, available:
(ports, services) => services?.execVat !== undefined && ports?.writers !== undefined, execute,
deadline }`. Module state (the vat has one session): `scope` (current `ExecScope` or undefined),
`deadlineMs`, `pending` (`{ opId, generation, settle(outcome) }` or undefined).

`execute({ opId, args }, ports, context)`:

1. `fieldBytes(args) > execSourceBytes` -> `{ status: 'failed', text: textOf.execSourceTooLarge(bytes, execSourceBytes) }`.
2. No scope: `await E(context.services.execVat).scope()` -> keep `scope`, `deadlineMs`
   (rejection: `failed` `textOf.execUnavailable`).
3. `E.sendOnly(context.endpoint).armDeadline({ turn: context.turn, opId, ms: deadlineMs })` and
   `E(scope).run({ args, writers, timer, content?, notice? })` in the same crank; `pending` = this
   call. The returned promise settles at the first of: the run's answer, `deadline`, the cancel
   hook (8.4).
4. Answer `busy`: retire as 8.4, take a fresh scope (step 2) and run again once with
   `notice: texts.execBusyReset` (a second `busy` from a fresh vat fails the call with
   `texts.execBusyReset`).
5. Rejection with `isRetiredBreak`: `failed` `texts.execTerminated`; `E.sendOnly(execVat).retire(scope)`;
   `scope = undefined`. Any other rejection: `failed` with its message.
6. On settling: `E.sendOnly(endpoint).disarm({ turn, opId })` unless the deadline fired.

### 8.3 Lifetimes and their texts

| event | result text (recorded `failed` unless stated) | scope |
|---|---|---|
| synchronous runaway (`MeterAbort`) or a worker crashing past `maxDeliveryAttempts` (D-17): the pending `run` breaks with the retired text | `texts.execTerminated` | retired; the next call takes a fresh vat (acceptance 4, 11) |
| `deadline({ opId })` before the answer (`execDeadlineMs`, default 120 s; `HarnessRoot.configure` for tests) | `textOf.execTimeout(deadlineMs)` | retired (the only way to stop it); a late answer is ignored (acceptance 5) |
| `busy` at the next call | the new call's own result, prefixed with `texts.execBusyReset` | retired before the new call |
| turn cancelled while the call runs | `texts.execAbandoned` (recorded in the cancel crank by the `onCancel` hook settling the pending call) | **kept** (R4-49); `abandon()` (sendOnly) ends the call in the exec vat: the next call runs at once in the same scope; the abandoned code runs at most until its next `sleep` (M1b QC, J-0391) |
| restart with the call in flight | `texts.toolOutcomeUnknown` by recovery (contract 7) | kept if the vat survived; recovery sends `abandon()` too (acceptance 10) |
| the vat's name table ran out (`exhausted`) | `texts.execExhausted` | retired (M1b QC, J-0390) |
| arguments over `execSourceBytes` | `textOf.execSourceTooLarge(bytes, limit)` | untouched (nothing sent) |

Acceptance 3 reads with this table: after cancelling during a 30 s `sleep`, the next turn's `exec`
sees `x === 5` at once (M1b QC, J-0391; before, an exec that arrived while the abandoned run still
slept got `busy`, a reset and `texts.execBusyReset`, J-0307). `busy` remains for a session that
lost track of a running call (a dropped `abandon`).

### 8.4 Cancel, deadline and busy in the session (W1b.4 hooks)

- `turnHooks.onCancel` (append): if `pending` belongs to the cancelled turn and its `run` was sent,
  `E.sendOnly(scope).abandon()` first (M1b QC, J-0391), then settle it with `{ status: 'failed',
  text: texts.execAbandoned }` and clear `pending`; no retire (R4-49). The turn then settles
  `cancelled` in the same crank (2.3 item 4).
- `deadline` (entry method, 2.3 item 3): settle `pending` with `textOf.execTimeout(deadlineMs)`,
  `E.sendOnly(execVat).retire(scope)`, `scope = undefined`.
- `turnHooks.recoverySteps` (append): `abandon()` as on cancel, clear `pending` (recovery already
  wrote the unknown result).
- `exhausted` answer: `E.sendOnly(execVat).retire(scope)`, `scope = undefined`, settle with
  `texts.execExhausted` (M1b QC, J-0390).

---

## 9. The context cache protocol (W1b.2)

- **`RoundRequest.base = { count, epoch }`**: `count` = records in the log before `append[0]`;
  `epoch` = the compaction epoch (M1b: always 0; M8 increments it when a `Compaction` record moves
  the projection base). `RoundRequest.context` = the session's one `ContextSource` (from W1b.2 on,
  always present).
- **Cache per session presence** (adapter, per incarnation): `{ epoch, count, records, texts,
  projection }`.
- **On `startRound(req)`**: if `cache.epoch === base.epoch && cache.count === base.count`: apply
  `append`. Else if `cache.epoch === base.epoch && cache.count === base.count + append.length` and
  the cached tail has the same `kind`/`turnId` sequence: it is a duplicate (a round 0 sent again);
  apply nothing. Else rebuild: pull pages from the boundary until `from + records.length >=
  base.count`, keep records `[boundary, base.count)`, then apply `append`. **Never take records at
  or beyond `base.count` from a page**: a reopen after an unannounced restart (contract 7.1 case 3)
  sends round 0 again with `base` unchanged, and `TurnStarted` is in the log by then; counting it
  from the page and again from `append` would project it twice (W1b.2 adapter test).
- **Pages**: `ContextSource.page(cursor?)`; no cursor = the latest compaction boundary (M1b: index
  0); `next` = `p<index>` while records remain past the answer; `from` = absolute index of
  `records[0]`; answer within `contextPageBytes` (98,304) and `pageRecords` (512); a single record
  is never larger than about 24 KB (the `ToolIntents` of a `roundResultBytes` round), so every page
  holds at least one. An unknown cursor throws `texts.badCursor`.
- **Blobs**: resolved in batches (section 4.6), read in process. Native context is replayed from
  its blob (R4-31). Never-dispatched (`interrupted`) turns are left out; outcome-unknown turns stay
  with their unknown results (R4-32).
- **Projection** runs once, in Node (`AH/projection.js`, from Fae `journal-transcript.js`,
  `context-transcript.js`, `transcript-records.js`), with `projectionHooks` (M8 appends).
- `append: []` (the session's fallback when the append does not fit `frameBytes`, M1a) means "pull
  to `base.count`".

### 9.1 As built (W1b.2)

- **The append is per session, not per turn** (changes contract 6.1's "round 0 `append` is exactly
  `[TurnStarted]`"): `turn.js` keeps one `sentUpTo` for the session, so every `RoundRequest`
  carries every record appended since the previous request: a later turn's round 0 starts with the
  records the turn before appended after its last round (its `Dispatched` when it had one round,
  `RoundSettled`, `TurnSettled`, a cancelled round's `Partial`, recovery's results) and ends with
  its own `TurnStarted`. So `base.count` of each request equals the previous request's
  `base.count + append.length`, and a cache in step never pulls a page between turns (a page pull
  is a session crank on the turn-start path). Find a request's `TurnStarted` with
  `append.findLast(r => r.kind === 'turn-started' && r.turnId === req.turnId)`, not `append[0]`.
- **Gap pull**: same epoch and `cache.count < base.count` (an `append: []` fallback, or a request
  this incarnation never ran, e.g. parked and dropped): the cache asks `page('p' + cache.count)`
  (the one cursor the adapter builds; it names an absolute index, as `next` does) and pulls to
  `base.count`, then applies `append`. Any other mismatch rebuilds from `page()`.
- **Resolves** are sent as pages bring handles, in whole batches of `blobResolveBatch` (64), the
  remainder after the last page; files are then read 32 at a time.
- **Projection** (`AH/projection.js`): transcript records of `guest/lib/transcript-records.js`
  (`message`, `tool-call`, `tool-result`): per turn the user `message`; per round the assistant
  `message` (`RoundSettled.text`, or the round's `Partial` when it ended without `roundFinal`;
  omitted when empty and without native context) with the native context as `providerContext {
  format: 'native-context', payload }`; the round's `tool-call`s (`id` = op id) and then their
  `tool-result`s in call order (`failed: true` when failed; results without an intent dropped).
  A turn with `TurnSettled` and no `Dispatched` is left out; `TurnResolved` is not dialogue.
  `Projection = { transcript, epoch, count, input? }` (`input`: the full text of the request's
  `TurnStarted`). `projectionHooks` entries are `(transcript, { records, texts }) => transcript`,
  run in order after the base projection.
- **Where it runs**: the endpoint is made with `prepare: req => cache.prepare(session, req)` (one
  `makeContextCache` per incarnation, `AH/index.js`) and passes the provider a thunk:
  `provider.startRound(req, channel, prepare?)`. The provider calls it first in every round (so a
  cancel during a rebuild is seen when it returns). `isAbandoned(error)` (a page broke): send
  nothing; any other failure: `roundFailed` with `textOf.stagingFailed(message)`, before
  `dispatching(0)`. Prepares of one session run one at a time.
- **Retained state**: at most 32 sessions and 128 Mi units of loaded text per incarnation, least
  recently prepared out (never the one being prepared); `evict(session)`; a failed prepare drops
  the entry.
- **Scripted provider log** (tests, W1b.6): with a `logPath`, one `context` line per round,
  `{ turnId, round, ms, records, bytes, digest, turnDigests }` (`contextDigests(transcript)`:
  sha-256 prefixes of the transcript records' JSON, the whole (32 hex) and per turn (16 hex each,
  space-separated; a turn starts at each user message)), written off the round's path. Contexts
  before and after a restart compare by `turnDigests` prefixes.

---

## 10. Pool and list feed (W1b.5)

### 10.1 Pool

`guest/factory/pool.js`: `makePool({ vats, programs: { session, exec }, settings, sessionSources,
lanes?, mintHost? })` keeps up to `spareSessions` (2) spare session vats and `spareExec` (1) spare
exec vats, each `{ facade, value: maker | scope, host?, digest, label }` in the factory heap (a
session spare's `host` is an unbound `SessionHostFacet` minted with it by `mintHost`); refills with
at most `poolLanes` (4) creations in flight; `whenSettled()`; `configure`. The pool is passive until
first asked (`configure`, `whenSettled`, a take, or a start), so provisioning sets its targets before
it fills. Spares sleep (idle sleep) and are not woken at startup. Takes: `takeSession()` (for
`createSession`), `takeExec()` (for `ExecHandle.scope`). `makeExecHandle({ pool, settings })` ->
`ExecHandle` per session (3.4). Spare workers are labelled `spare session <n>` / `spare exec <n>`
(a pooled session's vat keeps that label; cold ones stay `session s<n>`). Disk: about 17 MB per
sleeping spare (M0; 17.1-17.4 MB snapshots measured in W1b.5, J-0353).

### 10.2 List feed

`guest/factory/list-feed.js`: `makeListFeed({ admin, listed, isListed })` (the row table's published
form and listing rule) -> `{ changed(row), removed(row), flush(), rev(), refresh() }`: collects row changes of a crank, publishes one batch per crank (`flush` at the
end of every factory method and `RowReporter.changed`), `rev` counter; `refresh()` (start listener)
gets a fresh publisher with `E(admin).listPublisher()`. `AH/list-channel.js`:
`makeListChannel({ limits = channelLimits })` -> `{ publisher: ListPublisher, subscribe(rev?) ->
ListSubscription, latestRev() }`, one per adapter incarnation, rev order and bounds as the session
channel. Acceptance 9 ("create, rename and delete within 500 ms"): create and rename are M1b;
`row-removed` is published by M2's `deleteSession` (M1b publishes it only when a creation's row is
rolled back after it was listed, which cannot happen; decision 16.6).

---

## 11. Module entry points

Every unit exports exactly these (more is allowed; these names and signatures are fixed). "vat" =
guest rules; "Node" = adapter or tests.

### W1b.0 (exists)

| file | export | signature |
|---|---|---|
| `guest/lib/interfaces.js` | `m1bShapes`, `m1bInterfaces`, `m1bMethodNames` | lazy tables (section 1.3) |
| | `execDescription`, `execArgumentNames` | the exec tool as offered; `['code']` |
| | `texts`, `textOf` (M1b additions, section 13) | |
| `guest/lib/limits.js` | `limits` (M1b settings section) | |
| `guest/session/live.js` | `makeLivePublishing({ host, onStale? })` | as M1a plus `outsideState() -> { inFlight, pending, pendingEvents, pendingBytes, dropped }` (section 14.1) |

### W1b.1 blobs and staging

| file | export | signature |
|---|---|---|
| `AH/blobs.js` (Node) | `makeBlobStore({ dir, sink, timers? }) -> BlobStore` | `sink` = the manager's attach sink (`mintBlobs`, `resolveBlobs`) |
| | `BlobStore` | `{ stage(text, { previewUnits }) -> Promise<StagedText>, read(blob) -> Promise<string>, readPage(blob, offset, maxBytes) -> Promise<ContentPage>, resolveMany(blobs) -> Promise<void>, writers: BlobWriters, sweep() -> Promise<void>, discard(blob) -> Promise<boolean> }` (`discard`: M1b QC) |
| | `findBlobDir(argv = process.argv) -> string` | `<state>/agent-host/blobs` |
| `AH/content.js` (Node) | `makeContent({ store }) -> Content` | the exo (`m1bInterfaces.Content`) |
| `AH/timers.js` (Node; exists) | `makeTimerFacet(timers) -> Timer` | added by W1b.1 |
| `guest/session/staging.js` (vat) | `isStaged(value) -> boolean` | a `StagedText` record |
| | `fieldBytes(field) -> number` | exact UTF-8 bytes of an inline string, `bytes` of a staged one |
| | `previewOf(field, units) -> string` | `previewText` of a string, the `preview` of a staged one cut to `units` |
| | `sameSubmission(a, b) -> boolean` | section 3.3 |
| | `blobsOf(record) -> Blob[]` | every `blob` in a record (M2 `blobPage`, W1b.2) |

### W1b.2 context cache

| file | export | signature |
|---|---|---|
| `guest/session/context-source.js` (vat) | `makeContextSource({ records, boundary = () => 0 }) -> ContextSource` | section 9 |
| `AH/context-cache.js` (Node) | `makeContextCache({ store, hooks = projectionHooks, maxSessions?, maxTextUnits?, readsInFlight? }) -> { prepare(session, request) -> Promise<Projection>, evict(session), has(session), stats() }`; `isAbandoned(error)` | `session` = the Session presence the endpoint serves; 9.1 |
| `AH/endpoint.js` (Node) | `makeEndpoint({ ..., prepare? })`; providers: `startRound(req, channel, prepare?)` | 9.1 |
| `AH/providers/scripted.js` (Node) | `contextDigests(transcript)`; option `logContext` (default: with `logPath`) | 9.1 |
| `AH/projection.js` (Node) | `projectRecords(records, { texts, hooks? }) -> Projection`; `NATIVE_CONTEXT_FORMAT` | `texts`: `Map<Blob, string>` resolved for these records; 9.1 |
| `AH/projection-hooks.js` (Node) | `projectionHooks` | hook table `[]` (M8) |

### W1b.3 exec vat

| file | export | signature |
|---|---|---|
| `guest/exec/main.js` (vat) | `makeExecScope() -> ExecScope` | the exec program's entry (bundle namespace); section 8.1 |
| | `isKeysExhausted(error) -> boolean` | M1b QC: the engine's name-table RangeError |
| `guest/exec/*.js` (vat) | free | e.g. `render.js` (Fae `renderToolResult`, `stripCodeFence`, `describeParseFailure`) |

### W1b.4 exec tool

| file | export | signature |
|---|---|---|
| `guest/session/tools/exec.js` (vat) | `execEntry` | the tool-table entry (section 8.2) |
| | `execHooks` | `{ onCancel: TurnHook, recoverySteps: TurnHook }` appended to `turnHooks` |

### W1b.5 pool and list feed

| file | export | signature |
|---|---|---|
| `guest/factory/pool.js` (vat) | `makePool({ vats, programs: { session, exec }, settings, sessionSources, lanes?, mintHost? }) -> Pool` | `{ takeSession(), takeExec(), retire(facade), whenSettled(), status(), configure(settings), refill(), programChanged(), onStart() }`; `makePoolSettings(initial?)` |
| | `makeExecHandle({ pool, settings }) -> ExecHandle` | section 3.4 |
| `guest/factory/list-feed.js` (vat) | `makeListFeed({ admin, listed, isListed }) -> ListFeed` | section 10.2 |
| `AH/list-channel.js` (Node) | `makeListChannel({ limits? }) -> { publisher, subscribe(rev?), latestRev() }` | section 10.2 |
| `scripts/provision-steps.js` (Node; hook table) | a step `load exec program` | bundles `exec`, `HarnessRoot.loadExecProgram` pieces as the session program (contract 9) |

### W1b.6

`test/integration/m1b-*.test.js`, one acceptance group per file (each alone under 5 minutes), from
`ensureTemplate({ id: 'm1b', provision })`; perf scripts as milestones.md M1b.

---

## 12. Hook tables

| table | M1b entries |
|---|---|
| `guest/session/tool-table.js` `toolTable` | W1b.4 appends `execEntry`. Entry contract (M1a + 2.3): `execute(request, ports, context)`, `available(ports, services)`, optional `deadline({ opId }, context)` |
| `guest/session/turn-hooks.js` | W1b.4 appends `execHooks.onCancel` to `onCancel`, `execHooks.recoverySteps` to `recoverySteps` |
| `guest/factory/services.js` `serviceBuilders` | W1b.5 appends `({ ... }) -> { execVat: makeExecHandle(...) }` |
| `scripts/provision-steps.js` `provisionSteps` | W1b.5 appends the exec program step |
| `AH/index.js` `backendKinds`, `adapterTools` | unchanged |
| `AH/projection-hooks.js` `projectionHooks` (new, W1b.2) | empty; M8 appends |

---

## 13. Fixed texts (M1b)

| constant | text | source |
|---|---|---|
| `textOf.truncationMarker(n)` | `\n[Tool output truncated from N characters. Only a prefix is shown; use filtering or pagination for more.]` | R4-46 (M1a, unchanged) |
| `textOf.tooManyCalls(n, 64)` | `Too many tool calls in one round (N); only the first 64 were run.` | architecture 4.1 (M1a, unchanged) |
| `texts.execTerminated` | `exec scope terminated: the exec vat stopped (it exceeded the per-step compute budget or its worker failed repeatedly); bindings from earlier calls are gone` | architecture 6 |
| `textOf.execTimeout(ms)` | `exec call timed out after N ms; the exec vat was stopped and the scope was reset; bindings from earlier calls are gone` | architecture 6 (harness wording) |
| `texts.execBusyReset` | `the previous exec call was still running; the scope was reset` | architecture 6 |
| `textOf.execSourceTooLarge(bytes, limit)` | `exec source too large (N bytes; limit L)` | architecture 6 |
| `texts.execNoReturn` | Fae's "done (no return value). Use a top-level return ..." | R3-41; Fae `tool-makers.js:1650` |
| `texts.execCodeRequired` | `code is required` | Fae `tool-makers.js:1617` |
| `texts.execAbandoned` | `exec call abandoned: the turn was cancelled while it ran; the code may still be running and its effects may still happen` | harness (R4-49) |
| `texts.execExhausted` | `exec scope terminated: the exec vat ran out of property names (too many distinct keys were created); bindings from earlier calls are gone` | harness (M1b QC, J-0390) |
| `textOf.execUnavailable(msg)` | `exec is unavailable: <msg>` | harness |
| `textOf.stagingFailed(msg)` | `could not stage large text: <msg>` | harness |
| `texts.blobUnknown`, `texts.writerClosed` | `Unknown blob`; `This blob writer is closed` | harness |
| `texts.blankSubmission` | `A queued message must be non-empty text` (kept) | Fae; deviation 16.1 |

Fae's `describeParseFailure` hints are ported text (W1b.3), not contract constants.

---

## 14. Items carried from M1a

### 14.1 The outside-publish bound (J-9172; done in W1b.0)

`guest/session/live.js` no longer chains outside publishes without bound. One batch is in flight;
the rest wait in insertion order; while the waiting batches exceed one batch's worth
(`outsidePendingEvents` = 64 events, or `frameBytes` bytes), the oldest waiting one is dropped (the
newest is always kept). A dropped batch's `outside()` promise resolves; its rev is never published,
so viewers see a rev gap (the channel gives up on it after `reorderWaitMs`) and re-watch, as after
any lost batch. A `liveChannel()` or `publish` that never settles therefore holds one batch in flight
and at most 64 events pending (unit test: 1,000 outside publishes behind a publish that never
answers leave 64 pending, 935 dropped; the same behind a `liveChannel()` that never settles).

### 14.2 `LiveBatch.reason`

Optional `reason` on a closed batch: `'client' | 'queueDeliveries' | 'queueBytes' |
'subscriberLimit'` (the keys of `AH/channels.js` `closeReasons`). W1b.1 sets it in `channels.js`
(and its `LIVE_SUBSCRIPTION_GUARD` envelope) when the channel closes a subscriber; `ListBatch` has
the same field.

### 14.3 Blank submissions

Kept: `text.trim() === ''` is refused with `texts.blankSubmission` ("A queued message must be
non-empty text", Fae `pending-queue.js:49-53`); the PM accepted it; the spec names the refusal but
gives no text (deviation, J-0302). From M1b the Composer applies the same rule before staging.

---

## 15. Measurements (W1b.0)

Bundle bytes (`bundle-guest`, ASCII, comments included), at `7efa7fb3e4` before and with the
W1b.0 changes:

| bundle | before | after | delta |
|---|---|---|---|
| session program (`guest/session/main.js`) | 157,493 | 177,676 | +20,183 (budget 200,000: 22,324 left) |
| factory program | 94,336 | 112,076 | +17,740 |
| `interfaces.js` + `limits.js` alone | 45,825 | 63,565 | +17,740 |

Without comments the session program would be about 111 KB (a rough regex strip, estimate only).
Vat probe (workspace vat, release worker `7cda4467...`, 50 M, J-0303): the 63,565-byte contract
staged in 4 pieces in 1.67 s; evaluating crank 47 ms over the 168 ms floor (M1a: about 40 ms);
first use of the M1b guards a session vat needs (`TurnSink`, `Turn`, `ContextSource`,
`ExecHandle`, `ExecScope`, `StagedText` and the widened `Submission`, `RoundResult`,
`TurnRecord`) 127 ms over the floor, once per vat; again 9 ms; all 16 M1b interfaces and every M1b
shape 238 ms. Every accept and refuse check passed in the vat.

---

## 16. Decisions, deviations and open points

1. **Blank-submission text** kept from Fae (14.3; deviation; J-0302).
2. **`ExecHandle.scope()` instead of `ExecHandle.run`** (3.4): the session calls the exec vat
   directly; a run forwarded through the factory would add 2 deliveries (about 110 ms) per call
   against a 250 ms budget (J-0304).
3. **Exec `console` discards output** (8.1): R3-42 says console output does not reach the model, a
   vat has no daemon log, and returning a log with the result (architecture 6 "bounded per-call
   log") would have no reader in M1b and repeats the leak of W-13. M12 diagnostics may revisit
   (J-0305).
4. **Context pages up to 4 frames** (`contextPageBytes` 98,304), vat -> adapter only: outbound
   from a vat is cheap (fact 2) and the receiver is Node; with `frameBytes` pages a 1,000-turn
   rebuild would need 33-100 session cranks (2.8-8.5 s) against a 5 s budget. Cost: each queued page
   is written to `hub.json` in hex while queued (fact 9, C-1) (J-0306).
5. **Partial text outside the log** (3.2): the latest checkpoint replaces the previous one in the
   session's turn state and is appended as one `Partial` only when the round ends without
   `roundFinal`; the record log stays append-only, so `{count, epoch}` is monotonic.
6. **List deletions are M2** (10.2): acceptance 9's "delete" needs `deleteSession` (M2 W2.7).
   Open for the PM: test delete in M2, or let W1b.6 test create and rename only (J-0309).
7. **Ownership of M1a files in M1b** (2.1): the milestone's "Owns" line omits the M1a files the
   work needs (`turn.js`, `session.js`, `durable.js`, `endpoint.js`, `channels.js`, ...); this
   contract assigns each to one unit per group (J-0300).
8. **Staged duplicates compare by `bytes` and `preview`** (3.3): exact identity would need a
   digest in `StagedText`; a retry of a different text with the same length and first 1,024 units
   is taken as the same submission. Open: add `digest` (64 hex) if that matters (J-0309).
9. **Session program size** (15): 22 KB left for staging, the context source and the exec tool.
   Recommendation to the PM: strip comments in `scripts/bundle-guest.mjs` (J-0201's standing
   decision) before W1b.4 lands (J-0303).
11. **M1b QC changes** (J-0390..J-0393; contract commit `contract(thixotrope-harness): ...` of
    the QC unit): `ExecScope.abandon()` and the call fence (8.1); `ExecOutcome` gains
    `{ status: 'exhausted' }` and `texts.execExhausted`; `TurnSink.progress` is answered and returns
    whether the session kept the checkpoint; `limits.progressWriteFactor` (3) bounds checkpoint
    writes; the adapter deletes superseded checkpoints and duplicate staged submissions
    (`BlobStore.discard`). Context pages read only their own records (`RecordLog.at`); the page
    bound is unchanged. Not in the guards: the daemon's slot ceiling is 4,000,000
    (`config/defaults.js` `slotCeiling`, `scripts/serve.mjs`), which the 256-call round and the
    1,000-turn rebuild need (J-0392).
10. **Exec arguments bound by their JSON bytes**: `execSourceBytes` applies to the argument text
    (UTF-8 bytes of the model's JSON), checked in the session before any call; the code inside is
    never longer. A code of exactly 262,144 bytes is refused (its JSON is longer).
