# M2 interface contract

Unit W2.0 of `milestones.md` M2. This file, `guest/lib/interfaces.js` and `guest/lib/limits.js` are
the contract the nine M2 builders (group A: W2.1a, W2.3, W2.4, W2.8; group B: W2.1b, W2.2, W2.5,
W2.6, W2.7) and the integration unit W2.9 build against without talking to each other.
`m1a-interfaces.md` and `m1b-interfaces.md` stay the M1a and M1b contracts and everything in them
still holds unless a section below changes it. Where this file and the code disagree, the guards
win and this file is wrong: report it. Paths: `H/` = `packages/thixotrope-harness/`, `AH/` =
`H/resources/agent-host/impl/`, `pkg/` = `packages/thixotrope/`. Spec items are `R3-n`, `R4-n`,
`R7-n` and `A.n` of `endo-harness-spec.md`; "architecture n" is `designs/architecture.md` section
n; "contract n" is `m1a-interfaces.md` section n; "M1b n" is `m1b-interfaces.md` section n.
Decisions D-M2-1..D-M2-4 are the project manager's (the task text of W2.0): D-M2-1 the record
archive is built in M2; D-M2-2 deleting a session and `row-removed` are M2; D-M2-3 no budget is
re-based; D-M2-4 providers run against a local fake server only (`[real-provider]` steps are the
owner's).

Contents: 1 rules; 2 who builds what (order, file ownership, seams, wiring left to W2.9); 3
objects, holders and methods (with the heaviest crank each can cause); 4 the record archive
(D-M2-1); 5 queue; 6 history pages; 7 delete, rollback, export and import; 8 providers, retry,
timeouts and the catalogue; 9 secrets; 10 turn completeness; 11 retired breaks at the new call
sites; 12 module entry points; 13 hook tables; 14 fixed texts; 15 measurements; 16 decisions,
deviations and open points.

---

## 1. Rules

### 1.1 What the M1a and M1b rules become

Contract 1 and M1b 1.1 hold. Changes:

1. **One set of tables.** M2 W2.0 folded M1b's tables into M1a's: `shapes`, `interfaces` and
   `methodNames` hold every M1a, M1b and M2 entry; where M1b extended an M1a interface the table
   holds the M1b version (`interfaces.Turn` has `getContent`, `interfaces.TurnSink` has
   `progress`, `interfaces.ContextSource` answers `{ from, records, next? }`, ...).
   `m1bShapes`, `m1bInterfaces` and `m1bMethodNames` remain as views of the M1b names over the
   folded tables (the same objects): existing imports keep working; new code imports `shapes` and
   `interfaces`. Test doubles of an interface M1b extended must implement its M1b methods
   (`m1a-agent-host.test.js` was adapted in the fold commit).
2. **Bound a crank by what it builds** (architecture rule 12.12) is now a column of every method
   table (section 3): the records, events, sends and allocation the heaviest crank a method can
   cause produces, and what bounds it.
3. **Nothing that grows with the number of turns stays in a vat** (rule 12.6 and D-M2-1): a
   settled turn's records leave the session vat when they are sealed (section 4); every other
   collection a session keeps has a stated bound (section 4.6).
4. **Objects, not names** (the owner's principle, Appendix F). New names allowed in M2, each for
   an F.2 reason: turn ids in `Session.findTurn` and `History.turnContent` (F.2 d: a page re-finds
   a turn; the turn id that acknowledges an uncertain turn is F.2 d's own example), history and
   catalogue cursors (F.2 d), model ids and selection ids (F.2 c), secret labels (F.2 a), a base
   URL in a backend spec (F.2 c: configuration), the archive key `h<n>` and blob keys `b<n>`
   (never leave the manager-adapter pair, as M1b 17.3).
5. **No secret enters a vat or crosses the hub in clear** (D-6): a vat holds `Secret` and
   `ReadGrant` handles only; values live in the agent-host adapter's encrypted file; the CLI path
   carries a `SealedBox` (section 9).

### 1.2 Sizes used below

String content bytes, UTF-8, keys included (contract rule 4). A `StagedText` is at most 3.1 KB
(M1b 1.2); a `SegmentEntry` about 120 bytes; an `ArchiveState` about 110 bytes; a `SealRequest`
about 0.3 KB plus one byte per record of the range (`kinds`, at most `archiveSegmentRecords`,
4,096); a `ModelRow` at most about 2.9 KB (a 2,048-unit description), typically 0.3 KB.

### 1.3 M2 tables and when an implementer switches

New M2 interfaces (`ArchivePort`, `History`, `SealedText`, `SecretsAdmin`, `Secret`,
`ReadGrant`, `SecretWriter`) are in `interfaces` directly. The M2 versions of the ten interfaces
M2 extends are in `m2Interfaces` (`m2MethodNames`): `Session`, `SessionInternal`, `QueueEntry`,
`ContextSource`, `SessionFactory`, `HarnessRoot`, `Operator`, `AgentHostAdmin`, `Backend`,
`Composer`. Each keeps the folded methods first, in order (unit test).

`makeExo` refuses a guard whose methods it does not implement, so an exo switches from
`interfaces.X` to `m2Interfaces.X` once, in one commit, by the unit that owns its file in that
group (section 2.2), and **implements every M2 method of X in that commit**: its own; for a
method another unit builds later, a stub that throws `Error(textOf.notBuilt('<method>'))`; or,
where section 2.4 says so, a forward to a runtime object that the other unit builds (never an
import of a module of a unit of the same group). The unit that builds the method replaces the
stub in the file it owns in its group. W2.9 checks that no `notBuilt` stub remains (`grep`) and
at M2 sign-off folds `m2Interfaces` into `interfaces` in one contract commit, as W2.0 did for
M1b.

### 1.4 In-place widenings (additive; every earlier value still matches)

| shape | M2 addition | built by |
|---|---|---|
| `Lifecycle` | `'deleting'` | W2.7 |
| `Receipt` | optional `turnId` (a started receipt of an archived turn has no `turn`) | W2.4 |
| `RoundRequest.base` | optional `archive: ArchiveState` | W2.5 (vat), W2.8 (adapter) |
| `RoundRequest.system` | may be a `StagedText` | W2.5 (sends), W2.6 (composes) |
| `TurnPorts` | optional `archive: ArchivePort` | W2.8 |
| `HistoryPage` (and its structural view) | optional `archived`, `archive` | W2.5 |
| `SessionConfig` | optional `systemPrompt` (inline or staged), `contextLength`, `maxOutputTokens`, `turnDeadlineMs` | W2.2, W2.6 (resolvers), W2.7 (factory) |
| `BackendSpec` | a second alternative: `{ kind: 'openrouter' \| 'anthropic', label, keyGrant: ReadGrant, modelId?, baseUrl?, timeoutMs?, maxOutputTokens?, logPath? }` | W2.3 (manager), W2.1a/b (providers) |
| `BackendInfo` | `kind` is `BackendKind`; optional `modelId` | W2.3 |
| `HarnessSettings` | optional `backends`, `defaultBackend`, `defaultModelId`, `turnDeadlineMs` | W2.7 |

A receiver built for M1b that is sent a new field fails its guard, so senders send a new field
only once the receivers accept it: each row's two sides belong to units that run in order (group
A before group B) or to one unit.

---

## 2. Who builds what

### 2.1 Order

W2.0 alone (done); then **group A** = W2.1a, W2.3, W2.4, W2.8 in parallel; then **group B** =
W2.1b, W2.2, W2.5, W2.6, W2.7 in parallel; then **W2.9 integration**, which owns every file. A
group B unit may import group A modules by the entry points of section 12; no unit imports a
module of a unit of its own group (it does not exist yet). Contract changes follow the
`contract(thixotrope-harness):` rule (smallest additive change, this file updated in the same
commit, listed in the unit's report).

### 2.2 File ownership

The milestone's "Owns" line lists the new files. This table assigns every file M2 edits to at
most one unit per group. "-" means nobody in that group edits it. "append" means a hook table:
each unit adds its own lines and never edits another's (the PM resolves trivial merges).

| file (M1a/M1b-built unless marked new) | group A | group B | what |
|---|---|---|---|
| `H/guest/lib/{interfaces,limits}.js`, `H/designs/m2-interfaces.md`, `H/test/unit/m2-interfaces.test.js` | W2.0 rule | W2.0 rule | contract changes only, by the rule of 2.1 |
| `AH/providers/{http,sse,openrouter,round}.js` (new) | W2.1a | W2.1b | fetch, SSE parser, OpenRouter streamed, the shared provider round (8.1); W2.1b plugs `retry.js` into `openrouter.js` |
| `AH/providers/{anthropic,retry}.js` (new) | - | W2.1b | |
| `AH/providers/catalog.js` (new) | - | W2.2 | |
| `H/guest/lib/token-usage.js` (new; from hosted-agent `src/token-usage.js`) | W2.1a | - | providers' usage normalisation |
| `AH/secrets/{store,manager,writer,seal}.js` (new) | W2.3 | - | |
| `AH/archive/{store,segment,mirror,context-file,history}.js` (new) | W2.8 | - | the archive store |
| `resources/agent-host/durable.js` | W2.3 | W2.7 | manager: every M2 method of `AgentHostAdmin` and `Backend`, the secrets exos, the sink additions (3.3) |
| `AH/index.js` | W2.8; W2.1a appends its `backendKinds` line | W2.2; W2.1b appends its `backendKinds` line | composition; ops handlers |
| `AH/attach.js` (the ops guard) | W2.8 | W2.2 | every M2 ops method (3.4) |
| `AH/endpoint.js` | W2.1a | W2.1b | cancel tears down the request (R4-7) |
| `AH/{context-cache,projection,blobs,content}.js` | W2.8 | - | archive-aware context, blob release, sealed reads |
| `AH/providers/scripted.js` | W2.8 | W2.6 | W2.8: the context log over sealed records; W2.6: usage/context readings the tests need |
| `AH/composer.js` | W2.4 | - | `Composer.edit` |
| `AH/{list-channel,channels}.js` | - | W2.7 | `row-removed` delivery (list-channel already accepts it) |
| `AH/projection-hooks.js` | append | append | M8's table; nobody in M2 appends |
| `H/guest/session/session.js` | W2.4 | W2.7 | A: queue wiring (`turnOf` by id, `sendNow`); B: `Session` and `SessionInternal` switch to M2 (2.4) |
| `H/guest/session/turn.js` | W2.4 | W2.5 | A: started receipts by turn id; B: the archive, history, and the seams of 2.4 |
| `H/guest/session/{queue,recovery}.js` | W2.4 | - | |
| `H/guest/session/{records,context-source}.js` | - | W2.5 | |
| `H/guest/session/{submissions,holds,holds-table}.js`, `H/guest/lib/pending-queue.js` (new) | W2.4 | - | |
| `H/guest/session/{history,archive}.js` (new) | - | W2.5 | |
| `H/guest/session/{usage,prompt}.js`, `H/guest/lib/{journal-usage,system-prompt-base}.js` (new) | - | W2.6 | |
| `H/guest/session/export.js` (new) | - | W2.7 | |
| `H/guest/session/{turn-hooks,tool-table}.js` | append | append (W2.6) | hook tables |
| `H/guest/factory/{factory,root,main,rows,list-feed,pool}.js` | - | W2.7 | every M2 method of `SessionFactory`, `HarnessRoot`, `Operator`; rows `deleting` |
| `H/guest/factory/{delete,export}.js` (new) | - | W2.7 | |
| `H/guest/factory/session-options.js` | append | append (W2.2 model; W2.6 prompt; W2.7 turn deadline) | creation resolvers |
| `H/guest/factory/services.js` | append | append | nobody in M2 is expected to append |
| `H/scripts/serve.mjs` | W2.3 | - | allowlist `THIX_HARNESS_SECRETS_KEY` (9.1) |
| `H/scripts/provision-steps.js` | append | append | |
| `H/scripts/export.mjs` (new) | - | W2.7 | export and import to a file |
| `H/test/fixtures/fake-provider-server.mjs` (new) | W2.1a | W2.1b | |
| `H/test/fixtures/sse/` (new) | W2.1a (`openrouter-*`) | W2.1b (`anthropic-*`), W2.2 (`*-models.json`) | one file each |
| `H/test/{unit,adapter}/m2-<unit>-*.test.js` | each unit its own | each unit its own | |
| `H/test/integration/m2-*.test.js` | W2.4 `m2-queue` | W2.1b `m2-providers`, W2.5 `m2-history`, `m2-archive-restart`, W2.6 `m2-turns`, W2.7 `m2-lifecycle` | acceptance (section 2.5) |
| `H/perf/queue.perf.mjs` (new) | W2.4 | - | |
| `H/perf/provider.perf.mjs` (new) | W2.1a | W2.1b | |
| `H/perf/{history,journal,archive}.perf.mjs` | - | W2.5 | `history` exists (M1b); `journal`, `archive` new |
| `H/perf/throughput.perf.mjs` (new) | - | - | W2.9 |
| `H/package.json`, `H/perf/_harness.mjs`, `H/JOURNAL.md` | PM-merged | PM-merged | |

W2.9 owns every file after group B.

### 2.3 Wiring that waits

A group A module that a group A sibling's file must wire is wired by the owner of that file in
group A only if the module is committed before the owner's last commit (as M1b 2.2); otherwise
by the group B owner of the file; otherwise by W2.9. The known cases:

| module | wired into | earliest |
|---|---|---|
| W2.3 `AH/secrets/manager.js` (ops handlers) | `AH/index.js` handlers `secrets` | W2.8 if committed in time, else W2.2 |
| W2.3 read path (`readKey` per backend) | `AH/index.js` `makeProvider` options | W2.2 |
| W2.1a `openrouter` kind | `backendKinds` (W2.1a's own line) | W2.1a |
| W2.2 `catalog.js` | `AH/index.js` handlers `listModels`, `resolveModel` | W2.2 |
| W2.5 `runner.findTurn`, `runner.archive` | `session.js` (W2.7 forwards) | group B, runtime objects |
| W2.6 resolvers | `session-options.js` (W2.6's own lines) | W2.6 |
| everything | the acceptance tests needing several units (7, 11, 15) | W2.9 |

### 2.4 Seams W2.5 builds in `turn.js` for W2.6 and W2.7 (group B)

So that W2.6 and W2.7 never edit `turn.js`, W2.5 builds these, exactly:

1. **System prompt.** Every `RoundRequest` carries `system: config.systemPrompt` when the config
   has one (inline or staged).
2. **Output tokens.** `options.maxOutputTokens = config.maxOutputTokens` when present (R4-92).
3. **Context window.** `addUsage` sets the session's `context.windowTokens` to
   `config.contextLength` when the config has one (R4-33: the window is the catalogue's,
   stored at creation; Anthropic API: none, so 0).
4. **Turn deadline.** With `config.turnDeadlineMs > 0`: when a turn starts on ports, in that
   crank, `E.sendOnly(endpoint).armDeadline({ turn, opId: textOf.turnDeadlineOpId(turnId), ms })`;
   `TurnSink.deadline({ opId })` with that op id while the turn is running does what
   `Turn.cancel()` does (cancelRound, `onCancel` hooks, wait for calls in flight; R4-49) and
   settles the turn `failed` with `textOf.turnDeadline(ms)` instead of `cancelled`; the settle
   disarms it.
5. **Runner accessors** for W2.7's `session.js` and `export.js` (runtime objects, no imports):
   `runner.findTurn(turnId) -> Turn` (section 4.9); `runner.archive` = `{ state() ->
   ArchiveState, segments(cursor?) -> SegmentPage, entries() -> SegmentEntry[] }`;
   `runner.beginDelete()` (the fence of `SessionInternal.deleteSelf`, section 7.1);
   `runner.importTurns(records)` (append imported records, rebuild the turn infos, advance the
   turn counter, then seal as section 4.3 allows); `runner.importArchive({ archive, segments })`
   (adopt an archive the adapter imported); `runner.importUsage(totals)`.
6. **The ContextSource.** `makeTurnRunner` builds the session's `ContextSource` itself (it needs
   the archive); a `contextSource` option is ignored from M2 on (W2.7 removes it from
   `session.js`).

W2.4 builds in group A (it owns `turn.js` and `session.js` there): `runner.turnById(turnId) ->
Turn | undefined` (a live or kept turn's handle; `undefined` for an archived one) and passes it
to `makeQueue` as `turnOf` (receipts keep turn ids, section 5.3).

### 2.5 Acceptance tests and who writes them

| acceptance (milestones.md M2) | file | unit |
|---|---|---|
| 4, 5, 10 (queue, holds, two clients) | `m2-queue.test.js` | W2.4 |
| 1, 6, 8 (streaming, cancel closes the connection, 429 retry) | `m2-providers.test.js` | W2.1b |
| 2, 3, 12 (tool texts, round limit, unknown outcomes in context) | `m2-turns.test.js` | W2.6 |
| 9 (300-turn pages back to turn 1, frame bound) | `m2-history.test.js` | W2.5 |
| 16 (SIGKILL during a seal) | `m2-archive-restart.test.js` | W2.5 |
| 13, 14 (delete and create across SIGKILL, row-removed; export and import) | `m2-lifecycle.test.js` | W2.7 |
| 7, 11, 15 (secrets end to end, default model, 5,000-turn flatness) | `m2-secrets.test.js`, `m2-catalog.test.js`, `perf/archive.perf.mjs` | W2.9 |

Every integration file runs alone in under 5 minutes from `ensureTemplate({ id: 'm2', provision
})`; bulk fixtures (300, 1,000, 5,000 turns) are built with `importState` once W2.7 has it (W2.5
in group B builds its fixtures by running turns at 200 and 300 turns; 1,000 and 5,000 are W2.9's).

---

## 3. Objects, holders and methods

Columns as contract 3 and M1b 3: **caller**; **crank** (section names of contract 6, M1b 6 and
section 4.4 here); **mode** (answered `E()` or `sendOnly`); **max** (largest message, bytes, either
direction); **retired break** (section 11 has the actions); **heaviest crank** (in the vat that
receives the call: records appended, events published, sends, and what bounds its allocation; "-"
for a call that enters no vat).

### 3.1 Session vat

| method | caller | crank | mode | max | retired break | heaviest crank |
|---|---|---|---|---|---|---|
| `Session.findTurn(turnId) -> Turn` (W2.5) | gateway, tests | any | answered | tiny | session vat lost | none appended; one Turn minted (kept among the 32 handles) |
| `Session.getHistoryPage(cursor?)` (changed, W2.5) | gateway, tests, `History` | any | answered | <= frameBytes | session vat lost | <= `historyPageRecords` (48) records previewed and marshalled (section 6) |
| `SessionInternal.blobPage(cursor?) -> BlobPage` (W2.7) | factory (delete) | delete step 2 | answered | <= 64 handles, ~5 KB | session vat lost: skip to step 3 (7.1) | scans the kept records, queue and checkpoint (<= 159 turns), at most 64 handles out |
| `SessionInternal.deleteSelf()` (W2.7 via `runner.beginDelete`, W2.5) | factory | delete step 1 | answered | tiny | session vat lost: continue the delete | a cancel crank (contract 6.4): <= 2 records, 2 publishes |
| `SessionInternal.exportState(cursor?) -> SessionExportPage` (W2.7) | `scripts/export.mjs` through `HarnessRoot.exportState` | any | answered | <= frameBytes | session vat lost | <= `pageRecords` records marshalled; pages bounded by frameBytes |
| `SessionInternal.importState(chunk) -> ImportProgress` (W2.7) | `scripts/export.mjs` | any | answered | <= frameBytes | new vat lost: roll the import back | <= frameBytes of records appended and checked; may start a seal (one send) |
| `QueueEntry.edit(submission)` (W2.4) | Composer | any | answered | <= 8.4 KB | session vat lost | replaces one entry; one `pending` publish |
| `QueueEntry.sendNow()` (W2.4) | gateway, tests | A (it may claim) | answered | tiny | session vat lost | as crank A of contract 6.1 (claim, <= 4 sends) |
| `ContextSource.page(cursor?)` (changed, W2.5) | adapter context cache, `ArchivePort` | P | answered | <= contextPageBytes (to the adapter only) | session vat lost: abandon | <= `pageRecords` (512) records marshalled (1.1-1.5 s at 50-1,000 turns, J-9387) |
| `ContextSource.segments(cursor?) -> SegmentPage` (W2.5) | adapter (validation, 4.7) | any | answered | <= 64 entries, ~8 KB | session vat lost: abandon | 64 entries marshalled |
| `Turn.getContent(cursor?)` (changed) | gateway, tests | any | answered | <= frameBytes | session vat lost | throws `texts.turnSealed` for an archived turn |
| `Turn.resolve(note)` (changed) | gateway, tests | any | answered | ~4 KB | session vat lost | one `TurnResolved`; throws `texts.turnArchivedUnresolvable` for an archived turn no longer kept (4.6) |
| seal answer (crank Z) | the `ArchivePort.seal` answer | Z | (answer) | ~0.2 KB | adapter restarted (4.5) | drops <= `archiveSegmentRecords` records; rebuilds the kept tail (<= 159 turns' records and their position arrays); no publish |
| claim and settle (changed) | as contract 6 | A, S | | | | S may add one answered `seal` send (4.3) |

### 3.2 Factory vat

| method | caller | crank | mode | max | retired break | heaviest crank |
|---|---|---|---|---|---|---|
| `SessionFactory.deleteSession(session)` (W2.7) | gateway, tests | F (7.1) | answered (settles when the delete completed or failed) | tiny | factory lost | one crank per step; a `row-removed` publish |
| `SessionFactory.listBackends() -> [Backend]` (W2.7) | gateway, tests | any | answered | <= 16 handles | factory lost | none |
| `SessionFactory.listModels(request?) -> ModelPage` (W2.7 forwards to `Backend.listModels`) | gateway, tests | F, then the answer | answered | <= frameBytes (50 rows) | factory lost | one forward, the answer passed through (inbound <= frameBytes) |
| `HarnessRoot.exportState(cursor?) -> FactoryExportPage` (W2.7) | `scripts/export.mjs` (operator) | any | answered | <= frameBytes (50 sessions) | factory lost | 50 rows |
| `HarnessRoot.importSession(options) -> MadeSession` (W2.7) | `scripts/export.mjs` | as a creation | answered | < 2 KB | factory lost | as `createSession` (contract 9) with the row unlisted until the import ends |
| `HarnessRoot.configure(settings)` (widened) | operator, provisioning, tests | any | answered | <= frameBytes | factory lost | stores the settings |
| `Operator.getSecrets() -> SecretsAdmin` (W2.7 forwards to the manager's) | gateway, operator | any | answered | tiny | factory lost | one forward |
| list feed `row-removed` (W2.7) | factory -> `ListPublisher` | F (7.1 step 5) | sendOnly | <= frameBytes | dropped | one publish |

### 3.3 Agent-host manager vat (durable; W2.3 owns `durable.js` in group A)

| method | caller | mode | max | retired break | what the manager does |
|---|---|---|---|---|---|
| `AgentHostAdmin.getSecrets() -> SecretsAdmin` | factory, operator | answered | tiny | manager lost | returns its one `SecretsAdmin` |
| `AgentHostAdmin.releaseBlobs([Blob])` | factory (delete) | answered | <= 64 handles | manager lost: the delete stays `deleting` | as M1b 4.8: resolve keys (handles it does not know are skipped), `ops.releaseBlobs(keys)`, forget the keys |
| `AgentHostAdmin.releaseArchive(session)` | factory (delete) | answered | tiny | manager lost | session -> host -> archive key (`h<n>`, assigned on first use); `ops.releaseArchive(key)`; nothing if the session never had a key |
| `AgentHostAdmin.history() -> History` | operator, tests (M3: the gateway) | answered | tiny | manager lost | forwards to the current ops facet (as `content()`) |
| `AgentHostAdmin.writersFor(session?) -> BlobWriters` | factory (prompt staging), `scripts/export.mjs` (import) | answered | tiny | manager lost | forwards `ops.writersFor(session?)` |
| `AgentHostAdmin.makeBackend(spec)` (widened) | provisioning, tests | answered | <= frameBytes | manager lost | an API spec's `keyGrant` must be a `ReadGrant` this manager minted, else `textOf.secretFailed('UNKNOWN_GRANT')` |
| `Backend.listModels(request?) -> ModelPage` | factory | answered | <= frameBytes | manager lost | `ops.listModels({ backend, spec, request })`; the answer passes through (inbound <= frameBytes) |
| `Backend.resolveModel(modelId?) -> ResolvedModel` | factory (creation resolver) | answered | tiny | manager lost | `ops.resolveModel({ backend, spec, modelId })` |
| `SecretsAdmin.list(cursor?)`, `create(NewSecret)`, `openWriter()`, `audit(limit?)` | operator, gateway | answered | <= frameBytes | manager lost | `create` mints a `Secret` with key `k<n>` (durable counter, kept in a manager `WeakMap` only, as blob keys) and `ops.secretCreate`; `openWriter` forwards; `audit` forwards; `list` pages the manager's own strong list of `Secret`s (bounded by the delete path: `Secret.delete` removes it) |
| `Secret.describe()`, `revoke()`, `delete()`, `audit(limit?)` | operator, gateway | answered | <= frameBytes | manager lost | forwards with the secret's key; `delete` only after `revoke` (else `textOf.secretFailed('NOT_REVOKED')`) |
| `Secret.makeReadGrant() -> ReadGrant` | operator, provisioning | answered | tiny | manager lost | mints a grant mapped to the secret's key in a manager `WeakMap` |
| `ReadGrant.describe()` | anyone holding it | answered | tiny | manager lost | label and description; never the value |

Sink additions (manager, called by the adapter only; one manager crank per call): `resolveSessions([Session])
-> [key | null]` (the archive key of each session's host facet, assigned on first use; at most 64),
`resolveSecrets([Secret]) -> [key | null]`, `resolveGrants([ReadGrant]) -> [key | null]` (at most
64 each). Keys never leave the manager-adapter pair (M1b 17.3 rule 1 holds: no method maps a key
to a handle).

### 3.4 Agent-host adapter objects (transient; tombstones after a restart)

| object.method | caller | crank | mode | max | retired break |
|---|---|---|---|---|---|
| `ArchivePort.seal(SealRequest) -> SegmentEntry` (W2.8) | session | S (4.4) | answered | request ~4.4 KB, answer ~0.2 KB | adapter restarted: not sealed (4.5) |
| `History.page(session, cursor?)` (W2.8) | gateway, tests | (A); a live cursor costs one session crank | answered | <= frameBytes | - (adapter-local) |
| `History.turnContent(session, turnId, cursor?)` (W2.8) | gateway, tests | (A) | answered | <= contextPageBytes | - |
| `SealedText.read(range)`, `describe()` (W2.8) | gateway, tests | (A) | answered | <= blobPageBytes | - |
| `SecretWriter.replace(secret, value \| SealedBox, expectedGeneration?)`, `publicKey()` (W2.3) | gateway (in process), CLI (sealed box through the hub) | (A); one manager crank to resolve the secret per incarnation | answered | <= 1.4 MB, never into a vat | adapter restarted: open a new writer |
| `Composer.edit(entry, text)` (W2.4) | gateway, tests | (A), then the entry's crank | answered | <= 200,000 units in, staged over inlineBytes | session vat lost: reject |

**Ops facet** (`AH/attach.js`, W2.8 owns in group A; the manager is its only caller). M2 adds,
each forwarding to a handler of `makeAgentHostImpl` or throwing `textOf.notBuilt(name)` while
the handler is absent: `open({ backend, spec, session, archiveKey })` (the request gains
`archiveKey`; the answer gains `archive`); `history()`; `releaseBlobs(keys)`;
`releaseArchive(key)`; `writersFor(session?)`; `listModels({ backend, spec, request })`;
`resolveModel({ backend, spec, modelId? })`; `secretCreate({ key, label, description })`;
`secretDescribe(key) -> { generation, state, bytes }`; `secretRevoke(key)`; `secretDelete(key)`;
`secretAudit({ key?, limit })`; `secretWriter()`. Keys are strings of at most `idUnits`.

### 3.5 The heaviest crank of every vat entry point (folded)

What one call or answer can make a vat do in one crank, against the slot ceiling (rule 12.12; the
256-call round is the measured worst case, J-0392). M2 rows are marked.

| vat | entry | heaviest crank | bound |
|---|---|---|---|
| session | `enqueueOnce` / `startTurn` / `sendNow` (M2) | crank A: 1 record, <= 4 events, <= 4 sends; receipt pruning scans <= 4,096 receipts (no allocation) | `maxWaiting`, `maxReceipts` |
| session | `roundFinal` | 2 records (a `ToolIntents` of <= 256 intents), <= 256 + 3 events in <= 5 publishes, <= 16 `execute` + 6 sends | `maxCallsPerMessage`, `callWindow`, `publishBatchEvents` (passes at 4,000,000 slots, J-0392) |
| session | a tool result | 1 record, 1-2 events, <= 2 sends; the last result of a round also `startRound` (<= frameBytes) | |
| session | settle (S) | 1-2 records, <= 6 events, <= 5 sends; M2: one `seal` send whose range walk reads <= 4,096 records (byte sums, no copy) | `archiveSegmentRecords` |
| session | seal answer (Z, M2) | drops a prefix; copies the kept tail (<= 159 turns) into fresh arrays | `archiveKeepTurns + archiveSegmentTurns` |
| session | `ContextSource.page` | 512 records out | `pageRecords`, `contextPageBytes` |
| session | `ContextSource.segments` (M2) | 64 entries out | `segmentPageEntries` |
| session | `getHistoryPage` (M2 bound) | 48 records previewed out | `historyPageRecords`, frameBytes |
| session | `Turn.getContent` | 512 records out, frameBytes | `pageRecords` |
| session | `exportState` / `importState` (M2) | 512 records out / frameBytes of records in, each checked | `pageRecords`, frameBytes |
| session | `blobPage` (M2) | a scan of the kept tail, 64 handles out | 159 turns |
| session | progress, dispatching, deadline | 0-1 record, <= 1 publish | |
| factory | `deleteSession` steps (M2) | one call per step; 64 handles per `releaseBlobs` | `blobResolveBatch` |
| factory | `listModels` (M2) | a frameBytes answer passed through | `modelPageRows` |
| factory | `RowReporter.changed`, list publish | one row; one batch of <= 64 events | |
| manager | `mintBlobs`, `resolveBlobs`, M2 `resolveSessions`, `resolveSecrets`, `resolveGrants` | <= 64 entries | `blobResolveBatch` |
| manager | M2 `Backend.listModels` | a frameBytes answer passed through | `modelPageRows` |
| exec | `run` | model code (bounded by the crank budget; halts only this vat) | architecture 6 |

---

## 4. The record archive (D-M2-1)

### 4.1 What and why

At 5,000 turns a session vat kept every record: a 114 MB snapshot, a 556 ms collection, 3.2 s
per turn, a 180 s context rebuild after a restart and a 516 KB hub row of 10,012 entries
rewritten on every change (J-9383, J-9384, J-9386). From M2 a session vat keeps a bounded tail
of recent turns and seals older settled turns into **segments**: files in the agent-host
adapter's directory, written and fsynced before the vat drops its copy (as blobs are, D-15). The
vat stays the system of record: it decides what and when to seal, and keeps the index of what it
sealed; the adapter serves history pages and context for sealed turns from the files, so no page
of sealed records ever leaves the vat again.

Invariants:

1. **Nothing lost.** A record leaves the vat only in the crank that receives the adapter's answer
   that its segment is durable (fsynced file, renamed into place, directory fsynced).
2. **Nothing duplicated.** At every moment each record is either in the vat (index >=
   `sealedTo`) or in an acknowledged segment (index < `sealedTo`), never both as far as any
   reader sees: readers take the archive's part only up to the vat's `ArchiveState`, which
   changes in one crank (Z).
3. **One chain.** Segment n's digest is SHA-256 of the previous segment's digest and segment n's
   content; the vat's `ArchiveState.digest` is the head of the chain, so one comparison tells
   whether the adapter's files are exactly what the vat acknowledged.
4. **Whole turns.** A segment holds whole settled turns; records of a turn are contiguous in the
   log except a later `TurnResolved` (section 4.6 handles those).

### 4.2 Segment format and size rule

A segment is records [`from`, `to`) of the session's log: the whole records of turns with
ordinals `firstTurn` .. `firstTurn + turns - 1` (ordinal = position in start order, from 1), plus
any `TurnResolved` of an earlier turn that lies inside the range.

**Turn spans** (W2.8, found by its adapter tests): a turn's span runs from its `TurnStarted` to the
next turn's `TurnStarted`, so a `TurnResolved` appended between two turns belongs to the earlier
turn's span and every range starts with a `TurnStarted` (the fingerprint check of 4.4 A1 requires
it). A `TurnResolved` appended while a turn runs lies inside that turn's span.

**Size rule** (the vat applies it; `limits.js`): starting at the oldest kept turn, add whole
settled turns while the segment stays within `archiveSegmentTurns` (32) turns,
`archiveSegmentRecords` (4,096) records and `archiveSegmentBytes` (4 MiB) of record bytes
(`plainBytes`, the vat's measure: strings and keys, a Blob handle counts 0); a single turn over
the record or byte bound is a segment of its own (a turn is never split). Typical segment of the
long-session script: 32 turns, about 290 records, about 100 KB.

**File** (W2.8): `<state>/agent-host/archive/<key>/seg-<ordinal, 6 digits>-<first 16 hex of the
digest>.jsonl`, written as `<name>.part`, fsynced, renamed, directory fsynced. JSON lines:

1. header: `{"format":"thixotrope-harness-segment-1","ordinal":n,"from","to","firstTurn","turns","records","bytes","epoch","previous":"<hex or ''>"}`;
2. one line per record in **segment order**: log order, except that the range's tool results are
   in call order (`inCallOrder` over the range, the order `RoundRequest.append` already carries,
   W2.8), so a range read from the mirror and one paged from the vat make the same file; as the
   vat recorded each record, except that every staged field
   (`{ blob, preview, bytes, digest? }`) is written `{"$staged":{"key":"b<n>","preview","bytes","digest"?}}`
   (the adapter's key for the handle; the blob file itself stays in `<state>/agent-host/blobs/`);
3. trailer: `{"end":true,"digest":"<hex>"}` with digest = SHA-256 over the previous digest
   (as hex text) followed by every byte of lines 1 and 2.

A file without a trailer, or whose trailer does not verify, is half-written: it is never read,
and is deleted when found (adapter start, or validation, 4.7).

### 4.3 When the session seals

In the **settle crank** (S) of a turn (contract 6.3), after `TurnSettled` is appended and the
`onSettle` hooks ran, **before** the next entry is claimed, the session starts a seal when all
hold:

1. no seal is in flight;
2. the session keeps at least `archiveKeepTurns + archiveSegmentTurns` (160) settled turns;
3. it holds ports (the settling turn's, or held ports) and they carry `archive`;
4. it has sealed fewer than `archiveMaxSegments` (4,096) segments;
5. it is not being deleted;
6. no seal failed within the last `archiveSegmentTurns / 4` (8) settled turns.

So a seal is never started inside a turn's round: its range holds only turns settled before
crank S, never a record of the turn that may be claimed in the same crank, and the next turn's
records are appended after `to`. An `importState` crank (W2.7) checks the same conditions after
its records are appended. Seals are one at a time; a session keeps between 128 and 159 settled
turns (section 4.13).

### 4.4 Sealing, crank by crank

Session cranks lettered as contract 6 (S = the settle crank, Z = the seal answer); (A) = adapter
work in Node.

| step | where | does | sends |
|---|---|---|---|
| S | session, settle crank | conditions of 4.3; range by the size rule; **record the intent in the heap**: `sealing = { generation, from, to, firstTurn, turns, records, bytes, kinds }` (an archive field, not a transcript record) | `E(ports.archive).seal({ from, to, firstTurn, turns, records, bytes, firstTurnId, lastTurnId, kinds, epoch, previous: state.digest, context })` (answered, ~0.3 KB + `kinds`) |
| (A1) | `ArchivePort` | take records [from, to) from the session's mirror (4.7); pull any missing ones with `E(context).page('p<n>')` (n >= `from`; the vat still holds them); check the fingerprint: `to - from` records, `turns` turn starts, the first record is `turn-started` of `firstTurnId`, the last turn started is `lastTurnId` and its `turn-settled` is inside, and the kind letters of the first `archiveSegmentRecords` records equal `kinds` (a single turn over the record bound sends only that prefix, so the request still fits a frame); any mismatch rejects with `textOf.archiveFailed(...)` | page calls (answered) |
| (A2) | `ArchivePort` | write `seg-....jsonl.part` (header, records with blob keys, trailer with the chained digest), fsync, rename, fsync the directory; append the entry to `manifest.json` as unacknowledged (temp file, fsync, rename) | - |
| (A3) | `ArchivePort` | **only now** answer | the `SegmentEntry` (~0.2 KB) |
| Z | session, the answer | ignore unless it matches `sealing` (generation, from, to, turns, records) and `from` is still the first kept record; then: push the entry to the index; `state = { sealedTo: to, sealedTurns: + turns, segments: + 1, digest }`; drop records [from, to) (`RecordLog.dropBefore(to)`); drop the turn infos of the sealed turns (an unresolved outcome-unknown turn's info moves to `unresolved`, 4.6); clear `sealing` | none (no publish: history readers see `archive` move) |
| (A4) | adapter, at the next `startRound` or vat page that carries the new `ArchiveState` | mark the segment acknowledged; append its projected transcript to `context.jsonl` with a marker; rewrite `mirror.jsonl` from `sealedTo` on (temp file and rename) | - |

A rejection of the `seal` (not the retired text): clear `sealing`; the records stay; try again at
the eighth settle after (4.3 condition 6). The retired text: as a rejection, and the session drops
its held ports unless the current turn uses them (as an answered outside publish, contract 7).

**Durable before drop:** Z drops records only after A2 made the segment durable; **intent before
effect:** S records `sealing` in the crank whose outbound frame starts A1 (M0 S9).

### 4.5 SIGKILL at every point of a seal

"Kill after X" = the supervisor is SIGKILLed after X was journaled (vat) or done (adapter) and
before the next step. The vat's crank S is replayed exactly by journal replay (a replay
regenerates the same `seal` frame, and the hub drops the duplicate, M0 S9).

| kill after | what the restart delivers | outcome | lost / duplicated |
|---|---|---|---|
| nothing of the seal (S not journaled) | nothing | the next settle starts it | none / none |
| S (intent recorded, frame committed), before A1 | the `seal` breaks with the retired text during startup (it wakes the vat, as a lease break) | Z never comes: `sealing` cleared; records kept; seal again later | none / none |
| A1 (pages pulled) | as above | as above | none / none |
| A2 partly (`.part` written, not renamed) | as above | the `.part` is deleted at adapter start (M1b 4.6 sweep extended to the archive directory) | none / none (half-written segment discarded) |
| A2 (renamed, fsynced, unacknowledged in the manifest) | as above | an **orphan** file: the next seal of the same range writes the same content (same digest, the same file name: the adapter verifies it and reuses it) or a different one (new file); validation (4.7) deletes any file the vat's chain does not name | none / none: readers stop at the vat's `ArchiveState` |
| A3 (answered; answer committed by the hub, Z not journaled) | the answer frame reaches the vat, or the retired break does (a break never means "not done", M0 S9) | answer: Z runs, sealed. Break: not sealed; the file is an orphan (row above) | none / none |
| Z | - | sealed; the adapter's manifest, `context.jsonl` and mirror lag; A4 catches up at the next request (a missing marker is rebuilt from the segment file) | none / none |
| A4 partly | - | `context.jsonl` without its marker for the segment: the unmarked tail is truncated and rebuilt from the segment file; a mirror rewrite is temp-then-rename | none / none |

Acceptance 16 kills at each of S, A2 (between write and rename), A3 and Z and checks: history from
the newest turn back to turn 1 shows every turn exactly once; the provider's next request has the
same `turnDigests` as before (M1b 9.1); the next seal succeeds; no `.part` file remains.

### 4.6 What the vat keeps (W2.5)

| state | bound | slots (estimate) |
|---|---|---|
| kept records: every record of the kept turns and the current turn, from `sealedTo` | 128-159 settled turns + the current one (`archiveKeepTurns`, `archiveSegmentTurns`) | ~280 per turn of the long-session script (J-9388) |
| `RecordLog` turn index (`byTurn`, `turnOrder`) | kept turns only | small |
| turn infos (`turns` Map) | kept turns + the current one | ~10 per turn |
| `unresolved`: infos of archived outcome-unknown turns not yet resolved | `maxUnresolvedTurns` (64); a 65th drops the oldest, whose `resolve` then throws `texts.turnArchivedUnresolvable`; `resolve` deletes its entry | ~10 each |
| `ArchiveState` | one | ~10 |
| the segment index: one `SegmentEntry` per segment | `archiveMaxSegments` (4,096); at the bound sealing stops and the tail grows as before M2 (a session of 131,072 turns; journal it) | ~12 per entry (1.8 k slots at 5,000 turns) |
| `sealing` | one | small |
| Turn handles handed out (`retainedTurnHandles`) | 32 | small |
| receipts (W2.4: turn ids and submission fingerprints, never a Blob or a turn info, 5.3) | 4,096 | as M1a |

No handle per segment: every handle a vat holds is an entry of its hub row, rewritten whole at
every change of the row (J-9386); segments are addressed as ranges of the session's one archive
(the vat's index entry plus the archive key the manager keeps for the session's host facet), the
way a `Content.read` addresses a range of one blob.

A `TurnResolved` for an archived turn is appended to the kept log as any record (it is sealed
later with the turns around it); the turn's info is in `unresolved` until then.

### 4.7 What the adapter keeps and how it validates it (W2.8)

Directory `<state>/agent-host/archive/<key>/`, key = the archive key `h<n>` the manager assigned
to the session's host facet (passed in `ops.open` as `archiveKey`, or found by `resolveSessions`).
Mode 0700. Inside:

| file | content | written | durable? |
|---|---|---|---|
| `seg-*.jsonl` | segments (4.2) | A2 | yes (system of record for sealed records) |
| `manifest.json` | `{ format, segments: [{ ordinal, file, from, to, firstTurn, turns, records, bytes, digest, previous, epoch, acknowledged, turnIds, resolutions, blobBytes }], epoch, boundary }` (W2.8 added `previous`, `epoch`, `turnIds` (the segment's turns in start order: `History` finds a turn without reading segments), `resolutions` (`[turnId, note, at]` of every `TurnResolved` in it) and `blobBytes` (the quota of 4.10 item 4)) | A2, A4 (temp + rename) | cache: rebuilt from the segment files |
| `context.jsonl` | the persisted projection: the projected transcript records (`projection.js` output) of the sealed turns from the compaction boundary on, staged texts as `{"$key":"b<n>"}`, each segment's lines followed by a marker `{"through":n,"digest":"<chain head>"}`; first line `{ format, epoch, boundary }` | A4 (append) | cache: rebuilt from the segment files |
| `mirror.jsonl` | the session's kept records as the adapter received them (`RoundRequest.append`, gap pulls), one `{"i":<absolute index>,"r":<record, staged as keys>}` per line | every request (append, no fsync), rewritten from `sealedTo` at A4 | cache: rebuilt from vat pages |

**Validation** (the first prepare or `History` call of a session in an incarnation, and whenever
`base.archive` differs from what the adapter holds): the vat's `ArchiveState` (from
`RoundRequest.base.archive`, a vat history page's `archive`, or none) is the truth.

1. `segments` and `digest` equal the manifest's acknowledged prefix: done.
2. Otherwise walk the segment files' headers and trailers from ordinal 1: the chain of digests
   must reach the vat's `digest` at ordinal `segments`. Files past it, or off the chain, are
   orphans: deleted (their blob files are not: those keys are still in the vat's live records or
   in a later seal). Missing or broken files on the chain: ask the vat
   `ContextSource.segments()` for its entries to name which; an acknowledged segment that is gone
   is data loss: the round fails with `textOf.archiveFailed('segment <n> is missing')` (never
   expected; journal it).
3. `context.jsonl` is truncated after its last marker that the chain confirms and extended from
   the segment files; with another epoch or boundary it is rewritten (4.12).
4. The mirror is used from `sealedTo` only, and only while its records agree with the vat: the
   cache's first gap pull asks `page('p<k>')` with k one below the mirror's end and compares that
   record's kind and turn id; a mismatch discards the mirror (the tail is paged from the vat).

### 4.8 Context for sealed turns (W2.8 adapter, W2.5 vat)

`RoundRequest.base = { count, epoch, archive? }`; `archive` is present once the session sealed a
segment. The adapter's cache entry per session holds `{ epoch, boundary, sealed: { segments,
digest, transcript }, tail: { from: sealedTo, records, texts } }`: the projected transcript of
the sealed part (text read from blob files by key) and the kept records with their texts.

- **In step:** `epoch`, `count` (or the duplicate rule, M1b 9) and `(segments, digest)` equal:
  apply `append` as M1b.
- **A seal moved the base** (`segments` and `digest` newer, same epoch): extend `sealed` from the
  manifest and segment files the adapter wrote (A4); drop tail records below the new `sealedTo`
  and their handles' texts; then as in step. No vat crank.
- **Rebuild** (no entry: first round, restart, eviction): validate (4.7); load `context.jsonl`
  (one file) and resolve its keys' blob files (32 at a time, as M1b); the tail from the mirror
  plus a gap pull `page('p<mirrorEnd>')` to `base.count` (normally the records since the last
  request: under one page); without a mirror, pages from `p<sealedTo>`.
- `ContextSource.page()` without a cursor starts at max(compaction boundary, `sealedTo`); a cursor
  below `sealedTo` throws `texts.recordsSealed` (a prepare that meets it starts over with the
  newer base). The `{count, epoch}` check thus extends across sealed and live records as
  `(count, epoch, segments, digest)`: the chain digest stands for every sealed record.
- Never-dispatched turns are left out and outcome-unknown turns kept (R4-32) in the sealed part
  as in the tail: projection is the same function (`projectRecords`) over the same records.

Costs after a restart: one file read and parse (`context.jsonl`, about the records' size), one
blob read per staged field (10,000 blob files read in 162 ms, J-9383), the tail's resolves (at
most `ceil(blobs in 159 turns / 64)` manager cranks) and normally one page crank: about 1-3 s at
5,000 turns [inferred] against 180 s measured without the archive.

### 4.9 History pages, Turn handles and getTurnContent for sealed turns

**Cursors.** `h<n>` = the turns with ordinals <= n, newest first (as M1a: `next` names the
ordinal of the next turn to show). The vat serves ordinals > `sealedTurns`; the adapter's
`History` serves any.

- `Session.getHistoryPage(cursor?)` (vat, W2.5): kept turns only, newest first, within 32 turns,
  `frameBytes` and `historyPageRecords` (48) records (section 6). When the page reaches the oldest
  kept turn and `sealedTurns > 0`, `next` is `h<sealedTurns>` and `archived: true`. A cursor with
  n <= `sealedTurns` answers `{ turns: [], next: cursor, archived: true, archive }`. Every page of
  a session with sealed segments carries `archive: ArchiveState`.
- `History.page(session, cursor?)` (adapter, W2.8): without a cursor, or a cursor above the
  sealed ordinals it knows, it forwards to `E(session).getHistoryPage(cursor)` (one session crank)
  and returns that answer (it learns `archive` from it). A cursor with n <= `sealedTurns` is
  served from the segment files in process: turns n down to max(1, n - 31), each a
  `SealedTurnPreview` `{ turnId, state, at, sealed: true, records, cut?, resolution? }` (records
  in call order, text fields cut to previews as the vat does, every staged field a `SealedField`
  `{ sealed: SealedText, preview, bytes, digest? }`), within `frameBytes`; `next` is
  `h<o - 1>` for the oldest ordinal o shown, while o - 1 >= 1. An archived turn's
  `resolution` comes from a `TurnResolved` sealed after it (an unresolved one is shown without);
  that `TurnResolved` is also among its records, as the vat's `ofTurn` shows it (W2.8).
  Before serving a sealed cursor for a session it has not validated in this incarnation, `History`
  asks the vat for the newest page once (to learn its `ArchiveState`).
- `History.turnContent(session, turnId, cursor?)`: the turn's records in full, in segment order
  (4.2; its `TurnResolved` last when it was sealed in a later segment), staged
  fields as `SealedField`s, pages of at most `pageRecords` and `contextPageBytes`, cursor `c<n>`;
  a turn the archive does not hold throws `texts.unknownTurn` (the vat's turns are read with
  `Turn.getContent`).
- `SealedText.read({ offset, maxBytes })` reads the blob file by key, as `Content.read` (whole
  code points, `maxBytes` <= `blobPageBytes`); `describe()` gives bytes, preview and digest.
  `SealedText`s are adapter-local and minted per answer (weakly cached per incarnation).
- **Turn handles.** An archived turn has no Turn object in history pages (`SealedTurnPreview`
  has `turnId`, no `turn`). A handle handed out before the seal keeps working for `getStatus`,
  `whenFinished` and `cancel` (its state is its info); `getContent` throws `texts.turnSealed`;
  `resolve(note)` works while the turn's info is in `unresolved`, else throws
  `texts.turnArchivedUnresolvable` (or `texts.resolveNotUnknown` for a resolved or other turn).
- `Session.findTurn(turnId)`: a kept turn's handle, or an archived unresolved one's (from
  `unresolved`); another archived turn (an id `t<k>` with k <= the session's turn counter) throws
  `texts.turnSealed`; anything else `texts.unknownTurn`. This is how a client resolves an
  outcome-unknown turn it found in an archived page (F.2 d).
- Receipts of archived turns answer `{ state: 'started', turnId }` without `turn` (5.3).
- `getTurnContent(ref)` of architecture 3.2 is `Turn.getContent` (kept turns) and
  `History.turnContent` (archived turns).

### 4.10 Blob handles of sealed turns and the hub row

Sealing does **not** call `releaseBlobs`: that deletes files (M1b 4.8; it is for delete). A seal
moves the ownership of a sealed turn's blob files from handles to the segment, which names each
by key:

1. Z drops the sealed records; nothing else in the vat holds their handles (turn infos of sealed
   turns are dropped, receipts hold none, previews are keyed weakly by record; the 32 kept Turn
   handles and the 64 `unresolved` infos hold at most their inputs). At the vat's next collection
   (at most 32 cranks later, CORE-11) its finalizers release the handles: GC frames to the
   manager, and the session's hub row loses those entries.
2. The adapter's cache drops the sealed records' handles at the next request (4.8: the sealed
   part keeps text, not handles), so the adapter's row shrinks too.
3. The manager's `WeakMap` forgets a key when the last holder lets the handle go; the file stays,
   named by the segment. M1b 17.1's "files no handle names" and M13's collection sweep must
   therefore treat every key listed by any segment or mirror of `<state>/agent-host/archive/` as
   live (W2.8 exports `archiveKeys(dir)` for it).
4. Quotas (M1b 17.1): a session's sealed blob bytes are counted from its manifest when its
   archive is validated, so the session quota still covers them.

So a session's hub row holds the handles of its kept turns, the current turn and the fixed
objects only: bounded by `archiveKeepTurns + archiveSegmentTurns`, independent of session
length (4.13).

### 4.11 Delete and export reach the segments

- **Delete** (section 7.1): after the live tail's handles are released page by page
  (`blobPage` -> `releaseBlobs`), `AgentHostAdmin.releaseArchive(session)` makes the adapter read
  the session's manifest, segments and mirror, unlink every blob file they name (missing files
  are fine; quota refunded), and remove the archive directory. Idempotent; a restart repeats it.
  For a `lost` session (its vat gone) `releaseArchive` is the only release: the mirror names the
  live tail's blobs as far as the adapter saw them (a leak of at most the records since the last
  request; journal it).
- **Export** (section 7.3): the live part through `SessionInternal.exportState`, the sealed part
  through `History` (`page` for the turn list, `turnContent` and `SealedText.read` for full
  records and texts): every text lands in the export file. **Import** replays records into a new
  session with `importState`; the new session seals as it goes (4.3), so an imported 5,000-turn
  session is archived exactly as a grown one.

### 4.12 The compaction boundary hook (M8)

M8 records `CompactionStarted { boundary }` and `Compaction { summary, boundary }` with
`boundary` a record index, and increments the epoch (architecture 4.5). With the archive:

1. `ContextSource.page()` without a cursor starts at max(boundary, `sealedTo`); when boundary <
   `sealedTo` the adapter takes [boundary, `sealedTo`) from the segments, else nothing from them.
2. On a new epoch the adapter rewrites `context.jsonl` from the boundary (the segment holding the
   boundary contributes its records from it), with `projectionHooks` applied to the sealed part
   as to the tail: W2.8 exposes `archive.compacted({ key, epoch, boundary })` in
   `AH/archive/store.js` for M8's cache code to call.
3. Segments wholly before the boundary are never read for context again but are kept (R4-64):
   history and export still read them.
4. Sealing and compaction do not interact otherwise: seals cut by turns, compaction by records.

### 4.13 Expected vat heap, snapshot and hub row

Estimates [inferred] from the long-session script's measured slopes (J-9383, J-9384, J-9388):
about 280 live slots and 2 blob handles kept per turn, a new session's live heap 44,700 slots,
71 bytes of snapshot per live slot above a sleeping spare's 17.3 MB, about 51 bytes per hub row
entry, 20 fixed row entries. Kept settled turns: n below 160; else 128 + ((n - 128) mod 32), which
is 136 at 200, 1,000 and 5,000 turns (128-159 in general).

| | 200 turns | 1,000 turns | 5,000 turns | measured without the archive (200 / 1,000 / 5,000) |
|---|---|---|---|---|
| segments sealed | 2 | 27 | 152 | - |
| live slots (vat heap) | ~83,000 | ~83,000 | ~85,000 (+1,800 index) | 107-118 k / 324-330 k / 1.41 M |
| slot capacity (high-water) | ~620,000 (16 %) | ~620,000 | ~620,000 | 645 k / 874 k / 1.91 M |
| session snapshot | ~20 MB, ~0.25 s | ~20 MB | ~20 MB | - / - / 114 MB, 1.29 s |
| hub row | ~290 entries, ~15 KB | same | same | - / - / 10,012 entries, 516 KB |
| context rebuild after a restart | ~1 s | ~1-2 s | ~1-3 s | 4.1 s / 21-22 s / 180 s |
| `history.page` (newest page) | ~245 ms | ~245 ms | ~245 ms | 0.60 / 0.87 / 2.0 s |
| disk added by the archive | ~0.2 MB | ~3 MB | ~15 MB of segments + ~15 MB of `context.jsonl` | - |

**Flatness.** Between seals the kept turns vary from 128 to 159; every quantity above that grows
with kept turns (live slots, row entries) therefore varies by less than 1.25 x at any phase
(`archiveSegmentTurns * 4 <= archiveKeepTurns`, unit-tested). Per-turn wall time on the vat side
is then flat; on the adapter side the scripted provider digests the whole transcript per round
and real providers send the whole context each round until M8 compaction bounds it, so the
flatness check runs the scripted backend with `logContext: false` and records the adapter's
projection time separately (W2.9).

Costs added per seal [inferred]: crank S a few ms over its floor; the adapter's write of ~100 KB
with three fsyncs, 10-30 ms off the vat; crank Z tens of ms (copying the kept tail); one answered
call (two hub commits). About 3-6 ms per turn amortized.

---

## 5. Queue (W2.4)

### 5.1 Full queue

Contract 8 holds. M2 adds, on `QueueEntry` (`m2Interfaces.QueueEntry`; A.4 `editPending`,
`cancelPending`, `sendPending`, object style):

- `edit(submission)`: the entry's text is replaced (inline <= `inlineBytes` or staged); blank
  text is refused with `texts.blankSubmission`; an entry no longer waiting throws
  `texts.entryGone`; its key, place and request id are kept; one `pending` publish. The
  Composer's `edit(entry, text)` stages text over `inlineBytes` and then calls it; it deletes the
  staged file when the edit is refused (M1b 17.1 rule).
- `cancel() -> boolean`: as contract 8.
- `sendNow()`: moves the entry to the head and releases every hold except `interrupted` (R4-56;
  Fae `session-submissions.js`); when idle it is claimed in the same crank (crank A); while a turn
  runs it waits at the head. An entry no longer waiting throws `texts.entryGone`.

Bounds unchanged: 100 waiting (`textOf.queueFull`), receipts 4,096 kept 24 h (J-9391 records the
rate cap; the PM rules on it), request ids per A.4.

### 5.2 Holds

`restart` (recovery), `stopped` (M6), `refused` (a refusal in the claim crank; M2 has none: a
revoked or failing backend fails the turn after its claim, R4-79), `unavailable` (not reachable in
this design: the queue is the vat's heap; kept for the shape). No `interrupted` entry state can
exist (atomic claim, architecture 4.3): the `interrupted` hold and its text exist for the shape
only. A new entry or `sendNow` releases every hold except `interrupted` (R4-56); a duplicate
`enqueueOnce` releases nothing.

### 5.3 Receipts keep no handle (D-M2-1)

A `queued` receipt keeps its entry (live, bounded by 100). A `started` receipt keeps the turn id
and the submission's fingerprint only (inline text, or `{ preview, bytes, digest }` of a staged
one, without its `blob`): never a Blob handle or a turn info, so a sealed turn's input handle is
not kept alive by a receipt. It answers `turn: turnOf(turnId)` when the session still has the turn
(kept, or `unresolved`), else `turnId` alone (`Receipt.turnId`). Duplicate detection compares as
M1b 3.3 on the fingerprint.

---

## 6. History pages (W2.5)

A vat history page holds at most `historyPageTurns` (32) turns, `frameBytes` and
`historyPageRecords` (48) records in all: whole turns are added newest first while all three
hold; the newest turn alone over the records or bytes bound shows its first records and is marked
`cut` (as M1a's byte rule). Each turn shows at most `historyTurnRecords` records. The bound comes
from the page crank's marshalling cost: about 3 ms per record (J-0370, J-9387), so 48 records keep
a page crank near 245 ms over a 95 ms floor [inferred] against the 300 ms `history.page` budget;
W2.5 measures it at 200, 1,000 and 5,000 turns and, if it misses, proposes a smaller bound as a
contract change (no budget is re-based, D-M2-3). Archived turns are paged by `History` (4.9)
without a vat crank. Acceptance 9: after 300 turns, pages load back to turn 1 (across the archive:
by then 160 turns are sealed), every page message is at most `frameBytes`, and no turn is missing
or shown twice.

---

## 7. Delete, rollback, export and import (W2.7)

### 7.1 `deleteSession(session)`

R4-9, D-17 (a `lost` session is deleted the same way, and it is the only way its disk is
returned). The factory keeps a delete record per session (its row, `internal`, the session's
facade and exec facade) and runs, one step per crank, idempotently:

1. Row `state: 'deleting'` (published as a row change); `E(internal).deleteSelf()`: the session
   refuses new work with `texts.sessionDeleting` (`enqueueOnce`, `startTurn`, `sendNow`, `edit`),
   cancels the current turn (contract 6.4; it does not wait for its tool calls), starts no seal,
   abandons its exec call. A retired break (a lost vat) skips to step 3.
2. `E(internal).blobPage(cursor)` -> `E(admin).releaseBlobs(page.blobs)`, until no `next`
   (M1b 4.8: every staged field of the kept records, queue entries, receipts' none, the current
   checkpoint).
3. `E(admin).releaseArchive(session)` (4.11).
4. Retire the exec vat (`ExecHandle`'s current scope's facade) and the session vat's facade
   (`E(facade).retire()`; a facade already gone is fine).
5. Drop the row; publish `{ type: 'row-removed', session, key }` on the list feed;
   `deleteSession` answers.

The start listener completes every delete record after a restart (from its step; R4-9). A delete
of a session that is being created waits for the creation's end. Subagents (M9) are deleted
depth-first before step 1 (`onDelete` hooks: M9 appends; empty in M2).

### 7.2 Creation rollback (R4-6)

As contract 9 and M1b 6.6: a creation record; rolled back on failure and by the start listener
after a restart (retire the facade, drop the row, never listed). M2 adds: a staged system prompt
whose creation rolled back is released (`releaseBlobs([prompt.blob])`); an import (7.3) is a
creation whose row stays unlisted until its `end` chunk.

### 7.3 Export and import (data only)

`scripts/export.mjs export <state> <file>` / `import <state> <file>` (operator CLI; W2.7). The file
is JSON lines: `{ type: 'factory', settings }` (backends by label, default model), then per
session `{ type: 'session', head }`, `{ type: 'records', records }` (every staged field replaced by
`{ text }`, the full text), `{ type: 'queue', entries }`, `{ type: 'end' }`. The exporter reads
`HarnessRoot.exportState` pages (sessions with their `internal`), each session's
`SessionInternal.exportState` pages (head with `ArchiveState`; records from `sealedTo`; queue) and
its archived turns through `History` (`page` from `h<sealedTurns>` down, `turnContent`,
`SealedText.read`), and kept texts through `Content.read`. The importer: `HarnessRoot.importSession
(options)` (backend matched by label in the new state, model and title from the head), stages
texts with `AgentHostAdmin.writersFor(session)` and sends `SessionInternal.importState` chunks in
log order (each <= frameBytes; the session seals as 4.3 allows), queue entries last, then `end`
(the row becomes `ready` and listed if `userInitiated`). Exec bindings are not exportable (a
documented loss); secrets are not exported (re-create them); presets are M5.

---

## 8. Providers, retry, timeouts and the catalogue

### 8.1 Providers (W2.1a OpenRouter, W2.1b Anthropic)

A backend kind entry (`AH/index.js` `backendKinds`, hook table) is `{ kind, makeProvider, tools:
[] }`; `makeProvider({ label, spec, readKey, timers, log, blobs, fetch? })` returns `{
startRound(req, channel, prepare), cancelRound(turn), releaseTurn?(turn) }` exactly as the
scripted provider (contract 10, M1b 9.1): `prepare()` first (the projection); round 0 sends
nothing before `E(req.sink).dispatching(0)` answered `true`; deltas published in process
(`channel.publishDelta`); progress checkpoints and staging as M1b 3.2 and 5.2; the result as one
`roundFinal` (staged per M1b 5.2, `roundResultBytes`) or one `roundFailed`. `readKey()` reads the
backend's key through its grant in process at every round (R4-82): `sink.resolveGrants` once per
incarnation, then the store (audited, section 9). `AH/providers/round.js` (W2.1a) holds the shared
round driver (`runProviderRound({ req, channel, prepare, blobs, log, stream })`, where `stream` is
an async iterator of `{ delta } | { toolCall } | { usage } | { stop }` events) so both API providers
and later ones use one implementation of dispatch, progress, staging and limits. W2.1a: `stream` is
passed as a function `({ projection, signal }) => AsyncIterable<event>`, called only after round 0's
`dispatching(0)` answered `true` (the request must not leave before), with `signal` aborted by
cancel or release; events add `{ servedBy: { modelId?, provider? } }`; a failure is a thrown
`ProviderFailure` (`round.js`) whose `reason` is one of the fixed texts below, never built from a
body. Further options: `owner`, `control` (`makeRoundControl()`), `timers`, `now`, `label`.
`ServedBy` gains an optional `provider` (R4-108: OpenRouter's upstream provider, recorded per
round), additive.

- **OpenRouter** (R4-12, R4-13, R4-41; G-03): chat completions with `stream: true`, `tools` and
  `tool_choice: 'auto'` when tools exist; SSE parsed linearly (`AH/providers/sse.js`, from lal
  `providers/subscription-events.js`); deltas forwarded as they arrive (acceptance 1: more than one
  delta per reply); `finish_reason` `length` with text: the text plus `\n\n` and
  `texts.outputLimitNote` (R4-78); `length` without text or `content_filter`:
  `textOf.openRouterStopped`; empty: `textOf.openRouterEmpty`; served-by model and provider kept
  in `servedBy` (R4-108); ids must be `org/model` (`texts.openRouterModelPrefix`).
- **Anthropic API** (R4-12): Messages streaming; `max_tokens` = the session's `maxOutputTokens`
  or 4,096 (R4-92); text deltas, `tool_use` blocks (input JSON accumulated as text, never parsed
  in a vat); signed thinking kept as native context (staged, R4-31); stop reason checked against
  tool calls (R4-42; Fae `providers/anthropic-streaming.js`'s text, added as a contract text by
  W2.1b); 401: `texts.anthropicAuthFailed` (R4-77); other non-2xx: `textOf.anthropicHttp(status)`;
  unreachable: `texts.anthropicUnreachable`. W2.1b as built: the stop-reason text is a harness text
  (`textOf.anthropicStopMismatch(reason, calls)`; the Fae source was not available to the build);
  `max_tokens` with text and no tool call is delivered with the R4-78 note, as OpenRouter's `length`;
  `max_tokens` without text or inside a tool call, `refusal` and unknown stop reasons fail with
  `textOf.anthropicStopped(reason)`; a stream `error` event fails with
  `textOf.anthropicApiError(details)` (` (type <error type>)` when identifier-shaped). Native context
  is the round's thinking blocks as JSON text with the model and a digest of the round's text; it is
  replayed only when both match (R4-31). Tool-call ids are mapped to Anthropic's id alphabet
  injectively (`t1/r0/c0` -> `t1_2fr0_2fc0`) in each request. The round driver's events add
  `{ nativeContext: string }` (staged with no preview into `RoundResult.nativeContext`).
- **Failure text never carries a provider body** (R4-79): only the fixed texts above, with
  statuses, finish reasons, codes, served-by names and attempt counts.
- **Cancel** (R4-7): `cancelRound(turn)` aborts the request (`AbortController`), so the fake
  server sees the connection closed (acceptance 6); the round sends nothing more to the vat.

### 8.2 Retry and timeouts (W2.1b)

`AH/providers/retry.js`: `withRetries({ attempt, maxAttempts, delayMs(n, retryAfterMs), sleep,
signal })` retries an attempt only while it delivered nothing (no delta published, no usage
reported, R4-74, R4-78). W2.1b as built: `attempt(signal)` returns the attempt's events; events before the
first delivery are held and dropped when the attempt is retried; usage counts as delivered only
when it reports tokens (lal: "no tokens consumed"); `maxTimeoutRetries` (default 1) bounds the
retries of timed-out attempts; `onRetry({ attempt, failure, waitMs })` observes. The Anthropic
provider reports a stream's usage only with its outcome, so an `overloaded_error` event before any
text is retried like a 529 (open decision 12 applied to the API slot).

| provider | retried on | attempts | wait before attempt n+1 | timeout |
|---|---|---|---|---|
| OpenRouter (R4-74, R4-105) | 408, 429, 5xx, network failure, empty answer; at most one timeout retry | 3 per round | min(30 s, max(Retry-After, 1,000 ms x 3^(n-1))) | 1 h per request (R4-93), configurable (`spec.timeoutMs`) |
| Anthropic API (R4-77 [inferred] SDK defaults; harness choice) | 408, 409, 429, 5xx (529 overloaded included), network failure | 3 per round | min(8 s, max(Retry-After, 500 ms x 2^(n-1))) | 1 h (G-04: the spec has none), configurable |

The last failure is `textOf.afterAttempts(failure, attempts)`; a timeout is
`textOf.openRouterTimeout(s)` / `textOf.anthropicTimeout(s)`. Acceptance 8: a 429 with
Retry-After is retried per R4-74 before any delta, and not after one.

### 8.3 The fake provider server (W2.1a, extended by W2.1b and W2.2)

`test/fixtures/fake-provider-server.mjs`: `startFakeProviderServer({ fixtures }) -> { url, close(),
requests(), setPlan(plan) }`, bound to 127.0.0.1 on a free port (D-M2-4). Routes: `POST
/api/v1/chat/completions` and `GET /api/v1/models` (OpenRouter), `POST /v1/messages` and `GET
/v1/models` (Anthropic). A plan is a queue of responses: an SSE fixture file replayed with delays,
a status with headers (Retry-After), a disconnect mid-stream, or a hang until the client closes
(the server records the close). `requests()` returns method, path, body and whether an
authorization header was present (never its value). Fixtures are written by hand from the public
API shapes the Endo reference modules encode (lal `providers/openrouter.js`, Fae
`providers/anthropic-streaming.js`); keys in tests are short placeholder text such as `not a real
key`; a test that needs a provider-format key builds it at run time by concatenation.

### 8.4 The catalogue and model selection (W2.2)

`AH/providers/catalog.js`: per backend, the provider's catalogue read with the backend's key
(R4-17), cached per R4-104 (fresh 15 min, never older than 24 h, a failed read retried after
60 s); a failed read answers `{ rows: [], state: 'unavailable', error: <fixed text> }`. Rows sort
default first, then title ignoring case, then id (R4-20); `default` marks the backend spec's
`modelId` on the factory's default backend; `selectionId` is the bare model id on the default
backend and `<backend label>:<model id>` otherwise. Pages of `modelPageRows` (50), cursor =
the last row's `selectionId`.

`Backend.resolveModel(modelId?)` (R4-21, R4-22): on the factory's default backend an empty model
follows `HarnessSettings.defaultModelId`, else the spec's `modelId`; on any other backend a model
is required; OpenRouter ids need the organisation prefix (`texts.openRouterModelPrefix`); a pinned
model must be in the current catalogue (`textOf.unknownProviderModel(id)`); catalogue unavailable:
`texts.catalogUnavailable`. The answer `{ modelId, contextLength?, maxOutputTokens? }` is stored
in `SessionConfig` at creation (W2.2's `session-options.js` resolver) and never changes (R4-22):
acceptance 11.

`SessionFactory.listBackends()` answers `HarnessSettings.backends`; `listModels({ backend? })`
forwards to that backend (default: the default backend), W2.7.

W2.2 additions (contract commit of W2.2):

- **`ModelRequest.defaultBackend`, `ModelRequest.defaultModelId`** (optional, additive). The
  manager's `Backend` does not know which backend is the factory's default, nor the factory's
  configured model, and the rows of a page must already carry `default` and `selectionId` when
  the factory passes the answer through. So the factory, when it forwards
  `SessionFactory.listModels` to `Backend.listModels`, adds `defaultBackend:
  HarnessSettings.defaultBackend` and, when set, `defaultModelId: HarnessSettings.defaultModelId`.
  The catalogue compares `defaultBackend` with the backend it lists (object identity, no name);
  the default row is the one whose model is `defaultModelId ?? spec.modelId`. Without
  `defaultBackend` no row is default and every selection id is `<label>:<model>`. `backend` in a
  request is the factory's routing field and is ignored by `Backend.listModels`.
- **Creation resolver context.** `resolveCreateOptions(options, context)`: `context` gains
  optional `defaultBackend` and `defaultModelId` (from `HarnessSettings`), which the factory
  (W2.7) passes. The resolvers then: a creation without `backend` takes `defaultBackend`
  (else `texts.noBackend` as M1a); the model of a `scripted` backend is resolved as in M1a (no
  catalogue); on an API backend, an empty model on the default backend asks
  `Backend.resolveModel(defaultModelId)` (or `resolveModel()`, the spec's model, when the
  factory has no default model); an empty model on any other backend fails
  `texts.modelRequired` unless the factory has no default backend at all (then the backend's own
  model, as on the default backend); a given model is pinned and checked by
  `Backend.resolveModel(modelId)`. The resolver fills `resolved.modelId` and, when the answer
  has them, `resolved.contextLength` and `resolved.maxOutputTokens`; the factory (W2.7) copies
  those two into `SessionConfig` (R4-22, R4-33).
- **`ResolvedModel`**: `contextLength` is the catalogue row's (R4-33); `maxOutputTokens` is the
  backend spec's `maxOutputTokens` when set, never the catalogue's (R4-92: OpenRouter sends no
  output limit by default; the Anthropic provider uses 4,096 when absent). Rows show the
  catalogue's own `maxOutputTokens`.
- **Rows.** API rows list no reasoning effort (R4-23: only subscription backends have one). A
  title is cut to `labelUnits`, a description to `modelDescriptionUnits`; a model whose id is
  over `modelIdUnits` or whose selection id is over `modelCursorUnits` is left out. A page holds
  at most `limit` (default `modelPageRows`) rows and is cut further so it fits `frameBytes` by
  the contract measure; `next` is then the last row's selection id. A cursor naming no row of
  the current catalogue answers an empty `ok` page without `next`.
- **`scripted`** (test double): `listModels` answers one row, model `scripted`; `resolveModel`
  accepts any model id.
- **Reads.** OpenRouter `GET <baseUrl>/models` (bearer key); Anthropic `GET
  <baseUrl>/v1/models?limit=1000[&after_id=]` (`x-api-key`, `anthropic-version: 2023-06-01`), at
  most 16 pages. OpenRouter rows are kept only for models with text in and out and `tools` among
  the supported parameters (hosted-agent `modelsFromOpenRouterCatalog`). Any defect (status,
  shape, more than 4,096 models, a body over 16 MiB, a 20 s timeout) fails the whole read; no
  provider body is read on a non-2xx answer or shown anywhere.

---

## 9. Secrets, minimal (W2.3; D-6, R7-15, R7-22..R7-28)

### 9.1 Store

`AH/secrets/store.js`: one encrypted file `<state>/agent-host/secrets.enc` (AES-256-GCM, a fresh
nonce per write, written temp-then-rename with fsync), entries keyed by the manager's `k<n>`:
`{ label, description, generation, state: 'active' | 'revoked', value }`, plus the audit log
(R7-24: `{ at, label, op, outcome, code?, generation? }`, bounded: the newest 10,000 events). The
wrapping key is a 32-byte file **outside the state directory**: the path in the adapter's
environment variable `THIX_HARNESS_SECRETS_KEY` (absolute; `scripts/serve.mjs` passes it
through, W2.3), created 0600 if absent; without it, `~/.config/thixotrope-harness/secrets-<first 16
hex of sha256(state path)>.key`. Tests set it to a file under `H/tmp/` and delete it with their
state; no test reads a real key file.

### 9.2 Objects and flows

- `SecretsAdmin.create({ label, description })` -> `Secret` (generation 0, no value: a read fails
  `READ_FAILED` until the first `replace`). Description 1-200 characters, no newline
  (`INVALID_DESCRIPTION`).
- `SecretWriter.replace(secret, value | SealedBox, expectedGeneration?) -> { generation }`
  (adapter-local; the gateway calls it in process, the CLI with a box sealed to `publicKey()`
  (X25519 + AES-256-GCM, `AH/secrets/seal.js`), so the hub carries ciphertext only). The writer
  maps `secret` to its key by amplification (`sink.resolveSecrets`, never a public key or id). A
  stale `expectedGeneration` fails `GENERATION_CONFLICT`; a revoked secret `REVOKED`; a value
  over 1 MiB `INVALID_SECRET_BYTES`; a provider token over 8,192 bytes is refused by the provider
  at read (R7-25).
- `Secret.makeReadGrant()` -> `ReadGrant`; an API backend spec holds it (`keyGrant`). Providers
  read through it each round (`readKey`, R4-82, R7-28): replace takes effect at the next round
  without a restart; after `revoke` the next read fails `REVOKED` and the turn fails with
  `textOf.secretFailed('REVOKED')` (acceptance 7: the recorded reason contains no provider body).
- `Secret.revoke()`, `delete()` (after revoke), `describe()`, `audit(limit?)`;
  `SecretsAdmin.audit(limit?)` over all secrets (newest first, at most 100 per answer).
- Every read is audited `attempted` then `succeeded` or `failed` with a code (R7-24); errors are
  `textOf.secretFailed(code)` with a code of `secretCodes`, never bytes.
- Adapters never log tool arguments, results or secret values (W-13). Acceptance 7 greps the state
  directory (heaps, journals, hub image and log, blobs, archive, `secrets.enc`'s plaintext never
  written) for the test value and finds nothing.

---

## 10. Turn completeness (W2.6)

- **Tool texts** (R4-43, R4-45): `textOf.unknownTool`, `textOf.unexpectedArgument`,
  `textOf.argumentsNotJson`, `textOf.errorResult` exist since M1a; real providers' tool calls reach
  the same paths (acceptance 2).
- **Synthesized ids, duplicates, missing names** (R4-42): as M1a.
- **Round limit** (R4-47): `texts.roundLimit`, status `completed` (acceptance 3).
- **Cancel** (R4-7, R4-49): the provider aborts (8.1); a late `roundFinal` or `roundFailed` is
  ignored; running tool calls are not interrupted and their results are recorded (contract 6.4).
- **Usage** (R4-33, R4-83): five counts summed per turn (`token-usage.js` normalises each
  provider's usage), the last request's context reading with `windowTokens` from the config
  (seam 3); totals in `getUsage` and the settle's `usage` event. R4-83's "skipped if not read in
  time" does not arise: totals are in the vat and published in the settle crank.
- **Turn deadline** (R4-48 departure, G-06): `HarnessSettings.turnDeadlineMs` (default 0: off;
  at most 1 day) is copied into each new session's config (W2.7's resolver line) and armed by
  seam 4; the turn fails with `textOf.turnDeadline(ms)`.
- **Prompt composition** (R4-26 parts 1, 2 and 7; R4-27, R4-28): `guest/lib/system-prompt-base.js`
  ports Fae `session/system-prompt.js` (1315bef86) parts 1 (plain and spoken Floot
  introductions) and 2 (the guest section) word for word, except the `exec` paragraph, rewritten
  for the persistent scope (architecture 6; a deviation to journal); part 7 is the preset's free
  text (none in M2's `chat-only`). The factory composes once at creation (W2.6's resolver), or
  takes `systemPrompt` from the options (it replaces the composed text; a blank one fails with
  `texts.blankSystemPrompt`). A prompt over `inlineBytes` is staged by the factory through
  `AgentHostAdmin.writersFor()` (no session yet: the session holds it from its first use, M1b
  17.3). Stored in `SessionConfig.systemPrompt`, sent in every request (seam 1).

---

## 11. Retired breaks at the new call sites

As contract 7 and M1b 7: an **adapter** callee means the adapter restarted; a **guest vat** callee
means that vat is lost.

| caller -> callee (kind) | meaning | action |
|---|---|---|
| session -> `ArchivePort.seal` (adapter) | restart, not on the turn path | not sealed: clear `sealing`; drop held ports unless the current turn uses them; seal again later (4.4, 4.5) |
| adapter -> `ContextSource.segments` / `page` (session vat, guest) | session vat lost | abandon the round or the seal |
| `History` -> `Session.getHistoryPage` (session vat) | session vat lost | the page call rejects |
| factory -> `SessionInternal.deleteSelf` / `blobPage` (guest) | session vat lost | continue the delete at step 3 |
| factory -> `AgentHostAdmin.releaseBlobs` / `releaseArchive` / `writersFor` (manager, guest) | manager lost | the delete or creation stays recorded; the start listener retries |
| factory -> `Backend.listModels` / `resolveModel` (manager, guest) | manager lost | `listModels` answers `unavailable`; a creation fails with the error |
| factory -> `SessionInternal.importState` (guest, the new vat) | new vat lost | roll the import back (7.2) |
| adapter -> manager sink `resolveSessions` / `resolveSecrets` / `resolveGrants` (guest) | manager lost | the round fails with `textOf.secretFailed('READ_FAILED')` or `textOf.archiveFailed(message)`; `History` rejects |
| gateway or CLI -> `SecretWriter` (adapter) | restart | open a new writer |
| Composer -> `QueueEntry.edit` (guest) | session vat lost | reject; delete a staged file |
| provider -> `TurnSink.dispatching` (session vat) | session vat lost | as M1a: abandon; nothing sent to the provider |

---

## 12. Module entry points

Every unit exports exactly these (more is allowed; these names and signatures are fixed). "vat" =
guest rules; "Node" = adapter or tests.

### W2.0 (exists)

| file | export | |
|---|---|---|
| `guest/lib/interfaces.js` | `shapes`, `interfaces`, `methodNames` (folded); `m2Interfaces`, `m2MethodNames`; `m1bShapes`, `m1bInterfaces`, `m1bMethodNames` (views); `texts`, `textOf` (M2 additions, section 14); `secretCodes`; `archiveKindLetters` | |
| `guest/lib/limits.js` | `limits` (M2 settings section) | |

### W2.1a (Node unless marked)

| file | export | signature |
|---|---|---|
| `AH/providers/http.js` | `postJson`, `getJson` | `({ url, headers, body?, signal, timeoutMs, fetch? }) -> Promise<Response>`; no body text in any error |
| `AH/providers/sse.js` | `parseSse(chunks: AsyncIterable<Uint8Array>) -> AsyncIterable<{ event?, data }>` | linear, `fatal` UTF-8 |
| `AH/providers/round.js` | `runProviderRound({ req, channel, prepare, blobs, log, stream })` | 8.1 |
| `AH/providers/openrouter.js` | `makeOpenRouterProvider(options)`; `openRouterKind` (the `backendKinds` entry) | 8.1 |
| `guest/lib/token-usage.js` (vat and Node) | `usageFromOpenRouter(raw)`, `usageFromAnthropic(raw)` -> `Usage` | from hosted-agent `src/token-usage.js` |
| `test/fixtures/fake-provider-server.mjs` | `startFakeProviderServer({ fixtures? })` | 8.3 |

### W2.1b

| file | export | signature |
|---|---|---|
| `AH/providers/anthropic.js` | `makeAnthropicProvider(options)`; `anthropicKind` | 8.1 |
| `AH/providers/retry.js` | `withRetries({ attempt, maxAttempts, delayMs, sleep, signal, maxTimeoutRetries?, onRetry? })`; `openRouterDelay(n, retryAfterMs)`, `anthropicDelay(n, retryAfterMs)`; `makeRetry({ timers, delayMs, maxAttempts?, maxTimeoutRetries?, onRetry? })` -> the providers' `retry` option `({ attempt, signal }) => AsyncIterable` | 8.2 |

### W2.2

| file | export | signature |
|---|---|---|
| `AH/providers/catalog.js` | `makeCatalog({ fetch?, now?, timers }) -> { listModels({ backend, spec, readKey, request }) -> Promise<ModelPage>, resolveModel({ backend, spec, readKey, modelId, defaults }) -> Promise<ResolvedModel> }` | 8.4 |
| `guest/factory/session-options.js` (vat; hook line) | a resolver filling `modelId`, `contextLength`, `maxOutputTokens`; `OptionsContext` gains `defaultBackend?`, `defaultModelId?` | 8.4 |

### W2.3

| file | export | signature |
|---|---|---|
| `AH/secrets/store.js` | `makeSecretStore({ file, keyFile }) -> { create(key, label, description), replace(key, value, expectedGeneration?) -> generation, read(key) -> { value, generation }, describe(key), revoke(key), delete(key), audit({ key?, limit }) }` | 9.1; every read audited |
| `AH/secrets/seal.js` | `makeSealKeys({ file })` -> `{ publicKey(), open(box) -> string }`; `sealTo(publicKey, value) -> SealedBox` (CLI) | 9.2 |
| `AH/secrets/writer.js` | `makeSecretWriter({ store, seal, resolveSecret }) -> SecretWriter` | 9.2 |
| `AH/secrets/manager.js` | `makeSecretsOps({ store, seal, sink }) -> { secretCreate, secretDescribe, secretRevoke, secretDelete, secretAudit, secretWriter, readKey(grant) -> Promise<string> }` | the ops handlers (3.4) and the providers' read path |
| `resources/agent-host/durable.js` (manager vat) | as M1a/M1b, every M2 method of 3.3 | |

### W2.4

| file | export | signature |
|---|---|---|
| `guest/lib/pending-queue.js` (vat) | from Fae `session/pending-queue.js`: `makePendingQueue({ onChange })`, heap Maps, no pet names | 5 |
| `guest/session/{submissions,holds}.js` (vat) | `makeSubmissions(...)`, `holdTexts`, `releaseRule` | 5.1, 5.2 |
| `guest/session/holds-table.js` (vat; hook table) | `holdsTable` | 13 |
| `guest/session/queue.js` (vat) | `makeQueue({ onChange, turnOf, claim })` (`turnOf(turnId)`, `claim()` for `sendNow`) | 5 |
| `AH/composer.js` | `Composer.edit` | 5.1 |

### W2.5

| file | export | signature |
|---|---|---|
| `guest/session/archive.js` (vat) | `makeSessionArchive({ records, limits? }) -> { state(), entries(), segments(cursor?), maybeSeal({ ports, context, lastTurnId }) -> boolean, sealed(answer) -> boolean, unresolved }` | 4.3-4.6 |
| `guest/session/history.js` (vat) | `makeHistory({ records, turnInfo, turnHandle, archive }) -> { page(cursor?) -> HistoryPage, content(turnId, cursor?) }` | 4.9, 6 |
| `guest/session/records.js` (vat) | `RecordLog` + `base() -> number`, `dropBefore(index)` | 4.4 Z |
| `guest/session/context-source.js` (vat) | `makeContextSource({ records, archive, boundary? })` (+ `segments`) | 4.8 |
| `guest/session/turn.js` (vat) | the seams of 2.4 | |

### W2.6

| file | export | signature |
|---|---|---|
| `guest/lib/system-prompt-base.js` (vat) | `composeSystemPrompt({ spoken, presetText? }) -> string` | 10 |
| `guest/session/prompt.js`, `guest/session/usage.js` (vat) | free (hook entries) | |
| `guest/lib/journal-usage.js` (vat) | `usageOfRecords(records) -> UsageTotals` (Fae `session/journal-usage.js`) | export and import, tests |

### W2.7

| file | export | signature |
|---|---|---|
| `guest/factory/delete.js` (vat) | `makeDeletions({ admin, rows, listFeed, pool }) -> { delete(session), resume() }` | 7.1 |
| `guest/factory/export.js` (vat) | `exportPage(cursor?)`, `importSession(options)` | 7.3 |
| `guest/session/export.js` (vat) | `makeSessionExport({ records, queue, runner }) -> { blobPage, exportState, importState }` | 7.1, 7.3 |
| `scripts/export.mjs` (Node) | `exportState({ client, file })`, `importState({ client, file })`, CLI | 7.3 |

### W2.8 (Node)

| file | export | signature |
|---|---|---|
| `AH/archive/store.js` | `makeArchiveStore({ dir, blobs, sink, trace? }) -> { portFor({ session, key? }) -> ArchivePort, history() -> History, release(key) -> Promise<void>, prepareSealed(session, key, archiveState, { after?, context? }?) -> Promise<{ transcript, sealedTo, segments, digest, blobs, units }>, record(session, key, { from, records, replace? }), compacted({ key, epoch, boundary }), keyFor(session), tail(session, key, { from, until }), tokenKey(blob), observe(session, key, state), sweep(), entriesOf(key), stats() }`; `checkFingerprint(keyed, sealRequest)`; `archiveDirFor(blobDir)` | 4.4-4.12. `portFor` without `key`: resolved through `sink.resolveSessions` at the first seal (W2.3's `durable.js` does not pass `archiveKey` to `ops.open`; the context cache resolves it the same way, once per session and incarnation, one manager crank) |
| `AH/archive/segment.js` | `writeSegment(dir, header, records, previous, { trace? }) -> Promise<SegmentEntry & { file, reused }>`, `readSegment(path, { records? }) -> Promise<{ header, records, digest, size }>`, `chainDigest(previous, bytes)`, `formatSegment(header, records, previous) -> { header, body, trailer, digest }`, `encodeRecord(record, keyOf)`, `decodeRecord(keyed, toStaged)` | 4.2 |
| `test/unit/_m2-fake-archive.js` (Node, for W2.5's unit tests) | `makeFakeArchive({ keyOf? }) -> { port, rejectNext(message), breakNext(), holdNext() -> { answer(), fail(error) }, segments(), recordsOf(ordinal), acknowledge(state), requests(), counts() }` | an `ArchivePort` without files: pages the range from the request's `context`, the real fingerprint check and digest (`test/unit/m2-w28-fake-archive.test.js` checks it answers what the real store answers) |
| `test/adapter/_m2-archive-vat.js` (Node) | `makeFakeVat(options)` | the vat side as this section specifies it, for the adapter tests (W2.5 may compare against it) |
| `AH/archive/mirror.js`, `context-file.js`, `history.js` | free | 4.7, 4.9 |
| `AH/archive/store.js` | `archiveKeys(dir) -> Promise<Set<string>>` | 4.10 (M13's sweep) |
| `AH/context-cache.js` | as M1b + archive-aware prepare: `makeContextCache({ store, archive? })`, `prepare(session, request, { key? })` | 4.8 |
| `AH/blobs.js` | `BlobStore.release(keys)`, `BlobStore.readKey(key)`, `BlobStore.readPageKey(key, offset, maxBytes)`, `BlobStore.keyOf(blob)`, `BlobStore.chargeArchived(owner, bytes)` | 3.3, 4.9, 4.10 |

### W2.9

Integration: the wiring of 2.3, removal of every `notBuilt` stub, acceptance 7, 11 and 15, perf
`throughput`, `restart.serving` (50 sessions x 300 turns by import), the 5,000-turn rows, and the
fold of `m2Interfaces` (contract commit).

---

## 13. Hook tables

| table | M2 entries |
|---|---|
| `AH/index.js` `backendKinds` | W2.1a `openRouterKind`; W2.1b `anthropicKind` |
| `AH/index.js` `adapterTools` | none |
| `guest/factory/session-options.js` `optionResolvers` | W2.2 model resolution (8.4); W2.6 prompt (10); W2.7 turn deadline (10) |
| `guest/factory/services.js` `serviceBuilders` | none |
| `guest/session/turn-hooks.js` | W2.6 only if its tests need one (`onSettle` for usage checks); W2.5 builds seams instead (2.4) |
| `guest/session/tool-table.js` | none |
| `guest/session/holds-table.js` (new, W2.4) | `[{ reason, text(error?) -> string, releasedBy: 'enqueue' \| 'decision' }]` for the five A.4 holds; M6 and M9 append |
| `scripts/provision-steps.js` | W2.7 a step that configures `backends` and defaults from provisioning options (tests: the fake server) |
| `AH/projection-hooks.js` | none (M8) |
| factory `onDelete` (new, W2.7, `guest/factory/delete.js`) | none in M2 (M9: children depth-first; M6: workspaces) |

---

## 14. Fixed texts (M2)

Exact strings are in `interfaces.js`; `m2-interfaces.test.js` checks them.

| constant | text | source |
|---|---|---|
| `texts.anthropicAuthFailed` | `Anthropic API authentication failed (invalid or expired API key). Check the configured Secret.` | R4-77 (Fae `providers/anthropic-streaming.js:170`) |
| `texts.outputLimitNote` | `[The model stopped here: it reached its own output limit.]`, appended after `\n\n` | R4-78 (lal `providers/openrouter.js:515`) |
| `texts.openRouterUnreachable` | `OpenRouter could not be reached or sent an unreadable response` | R4-74 (lal :337) |
| `textOf.openRouterHttp(status)` | `OpenRouter request failed (HTTP <status>)` | R4-74 (lal :359) |
| `textOf.openRouterTimeout(s)` | `OpenRouter did not answer within <s> seconds` | R4-74, R4-93 (lal :335) |
| `textOf.afterAttempts(failure, n)` | `<failure>, after <n> attempts` (n > 1) | R4-74 (lal :437-441) |
| `textOf.openRouterStopped(reason, served)` | `OpenRouter completion stopped: <reason><served>` | R4-78 (lal :458, :471) |
| `textOf.openRouterEmpty(details)` | `OpenRouter returned an empty assistant response<details>` | R4-78 (lal :497) |
| `textOf.servedBy(parts)` | ` (served by <model>, via <provider>)` or empty | lal :148-156 |
| `textOf.openRouterApiError(details)` | `OpenRouter returned an API error<details>` | R4-79 (lal :379; W2.1a: a stream chunk's `error`) |
| `textOf.openRouterNoMessage(details)` | `OpenRouter returned no successful assistant message<details>` | R4-79 (lal :394; finish reason `error`, or a stream with no choice) |
| `texts.openRouterModelPrefix` | `OpenRouter model must include its organization prefix` | R4-21 (Fae `session/provider-connections.js:546`) |
| `texts.catalogUnavailable` | `Model catalog unavailable for the provider backend; no model can be admitted now` | A.4 (Fae :590) |
| `texts.modelRequired` | `A model must be chosen for this backend` | harness (R4-21 gives no text; W2.2) |
| `textOf.unknownProviderModel(id)` | `Unknown model "<id>" for the provider backend` | A.4 (Fae :600) |
| `textOf.secretFailed(code)` | `Secret operation failed: "<code>"`, code in `secretCodes` | R7-24 (daemon `secret-manager.js:27`) |
| `textOf.anthropicHttp(status)`, `texts.anthropicUnreachable`, `textOf.anthropicTimeout(s)` | `Anthropic API request failed (HTTP <status>)`; `Anthropic API could not be reached or sent an unreadable response`; `Anthropic API did not answer within <s> seconds` | harness (R4-79: no body; OpenRouter's wording) |
| `textOf.anthropicStopped(reason)`, `textOf.anthropicApiError(details)` | `Anthropic API completion stopped: <reason>`; `Anthropic API returned an error<details>` | harness (W2.1b; R4-78, R4-79; OpenRouter's wording) |
| `textOf.anthropicStopMismatch(reason, calls)` | `Anthropic API stop reason <reason> does not match the <calls> tool calls of its answer` | harness (W2.1b; R4-42) |
| `texts.sessionDeleting` | `This session is being deleted` | harness (R4-9) |
| `texts.turnSealed` | `This turn is archived; read it through the history service` | harness (D-M2-1) |
| `texts.turnArchivedUnresolvable` | `This turn is archived and can no longer be resolved` | harness (4.6) |
| `texts.recordsSealed` | `These records are archived` | harness (4.8) |
| `texts.unknownTurn` | `Unknown turn` | harness |
| `textOf.turnDeadline(ms)`, `textOf.turnDeadlineOpId(turnId)` | `The turn ran longer than its <ms> ms deadline and was stopped`; `<turnId>/deadline` | harness (G-06) |
| `textOf.archiveFailed(message)` | `could not archive turns: <message>` | harness (4.4) |
| `textOf.notBuilt(method)` | `not built yet: <method>` | harness (1.3; none after W2.9) |
| existing, used by M2 | `texts.blankSystemPrompt`, `texts.entryGone`, `textOf.queueFull`, the A.4 hold texts, `texts.roundLimit`, `textOf.unknownTool`, `textOf.argumentsNotJson`, `textOf.errorResult` | M1a |

R4-25's "Provider subscriptions exhausted" and R4-76's subscription texts are M4's. R4-26's prompt
texts are ported from Fae by W2.6 (section 10), not contract constants.

---

## 15. Measurements (W2.0)

Bundle bytes (`scripts/bundle-guest.mjs`, comments stripped, ASCII), at `2f57390c54` (before) and
`58980f7d9e` (after the fold and the M2 guards):

| bundle | before | after | delta |
|---|---|---|---|
| session program | 132,760 | 149,433 | +16,673 (budget 200,000: 50,567 left for W2.4-W2.7's vat code) |
| exec program | 65,856 | 82,529 | +16,673 (`execProgramBytes` 100,000: 17,471 left) |
| factory program | 94,802 | 111,475 | +16,673 |
| `interfaces.js` + `limits.js` alone | 43,182 | 59,855 | +16,673 |

Vat probe (JOURNAL J-0402; workspace vat through `client.call('evaluate', ...)`, release worker
`367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, allocation schedule, log store, base
template, load 2.2-2.5; floor 75.8 ms):

| | M1b contract (before) | M2 contract (after) |
|---|---|---|
| staging (pieces of 16,384 units) | 3 pieces, 0.91 s | 4 pieces, 1.19 s |
| evaluating crank, over the floor | 139 ms | 201 ms |
| first use of the guards a session vat needs, over the floor (before: the 12 M1b ones; after: 19 incl. the M2 `Session`, `QueueEntry`, `ContextSource`, `SessionInternal`, `ArchivePort` and the archive shapes) | 247 ms | 387 ms, once per vat |
| the same again | ~0 | ~0 |
| every remaining table entry (115 / 175) | 653 ms | 1,102 ms |

Checks in the vat (all as expected): an `ArchiveState` matched and an extra key was refused; a
64-entry `SegmentPage` matched, 65 refused; a `SealRequest` matched and a 65-unit `previous` was
refused; a `RoundRequest` with `base.archive` matched; `'deleting'` matched `Lifecycle`; an API
`BackendSpec` with a `ReadGrant` matched and one with key text was refused; an exo on
`m2Interfaces.QueueEntry` accepted `edit({ text: 'hi' })` and refused a 9,000-unit edit; an exo
missing `sendNow` could not be made on the M2 guard; `textOf.notBuilt` answered its text.

---

## 16. Decisions, deviations and open points

1. **The fold** (1.1): one set of tables; the M1b tables are views. Test doubles in
   `test/adapter/m1a-agent-host.test.js` (W1a.2's file) gained `getContent` and `progress` in the
   fold commit, because the folded guards require them (J-0400).
2. **Switch once, stub the rest** (1.3): an exo switches to its M2 guard in one commit with every
   M2 method present; unbuilt ones throw `textOf.notBuilt`. Needed because several units of one
   group add methods to the same interface (J-0404).
3. **No handle per segment** (4.6): the PM's "small index of segment handles" is an index of
   `SegmentEntry` ranges of the session's one archive (keyed by the host facet's manager key),
   because every handle a vat holds is a hub row entry and the row must stay flat (J-0401).
4. **Kept turns and segment size** (4.3, 4.13): 128 kept turns and 32 turns per segment instead
   of R4-106's 256 resident and 256-turn chunks (`[default]` values): with 256 the heap, snapshot
   and hub row at the measured lengths would vary by more than 1.25 x (deviation, J-0403).
5. **Archived turns have no Turn object in pages** (4.9); a client resolves one through
   `Session.findTurn(turnId)` (F.2 d); at most 64 archived outcome-unknown turns stay resolvable.
6. **History page record bound 48** (6): an estimate from the measured marshalling cost; W2.5
   measures and may propose another value.
7. **Secrets key file** (9.1): outside the state directory, path from
   `THIX_HARNESS_SECRETS_KEY`, else under `~/.config/thixotrope-harness/` (D-6; open decision 4
   stays open).
8. **Anthropic retries and timeout** (8.2): harness choices standing in for "the SDK's default
   retries [inferred]" (R4-77) and G-04's missing timeout (deviation, J-0403).
9. **Prompt exec paragraph** (10): rewritten for the persistent scope in M2, not M5 (deviation,
   J-0403).
10. **Open for the PM:** the 4,096-receipt rate cap (J-9391) is unchanged; the archive's per-session
    ceiling of 131,072 turns (4,096 segments; sealing stops beyond it); whether R4-106's `[default]`
    values should be re-stated as 128/32 in the architecture; the adapter-side growth of
    per-round projection and provider request with session length until M8 (4.13); a `lost`
    session's live-tail blobs beyond the mirror leak on delete (4.11).
