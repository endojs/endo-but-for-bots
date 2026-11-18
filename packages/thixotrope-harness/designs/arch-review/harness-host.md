# Architecture review HR-HOST: the agent-host manager part and the adapter core

Unit HR-HOST of the harness architecture review. Scope: `resources/agent-host/*.js` (the manager
part `durable.js`, `durable-subscriptions.js`, `durable-gateway.js`, and the loader `ephemeral.js`)
and `resources/agent-host/impl/` except `secrets/`, `subscriptions/` and `gateway/` (the composition
root, the ops facet, endpoint, blobs, Content, context cache and projection, the record archive,
providers, timers, Live, Composer, the session and list channels, the echo tool). 13,470 lines in
33 files [measured]. Read-only: no source, test or config file was changed and no test was run.
Snapshot: branch `claude/thix-arch` at `bd9a8ec070`. Paths are relative to
`packages/thixotrope-harness/`. The glossary of `core-ontology.md` section 5 is reused; findings of
`core.md` are not repeated. Evidence marks: **read** (the code was read), **measured** (a script
counted it), **inferred**.

Started 2026-11-18T12:52:57Z; the end time is in journal entry J-9985.

---

## 1. Summary

The adapter core is careful code with a clear object model at the vat boundary, built by
appending to three files. Every milestone added its part through seams in `durable.js`,
`impl/attach.js` and `impl/index.js` (the m3/m4 hotspot tables H2-H4 and H-2-H-4 list more than twenty named edit
sites in those three files). The seams worked: the lanes merged without conflict. What is left is
the cost of building by appending: the "thin" durable half is not thin, one provider seam became
four, and test, perf and layout knowledge sits in product modules.

**The three things most worth changing**

1. **The durable half is not thin (HR-HOST-1).** D-14 says `durable.js` is small and changes
   rarely, because a reinstall breaks every reference into the manager vat and the W13.2 migration
   is not built. The manager part is 1,503 lines in three files and `durable.js` has changed in
   12 commits [measured]. It holds adapter policy: a Codex effort spelling map, catalogue paging
   with up to 8 adapter round trips, pool-spec equality, frame-fitting by binary search. Move the
   policy to the adapter and keep the identities, WeakMaps and bounds in the vat.
2. **One provider seam became four (HR-HOST-2).** `runProviderRound` is the right seam, but the
   scripted double re-implements it (85 duplicated 5-line windows with `round.js`). The two API
   provider factories are about 100 of 120 lines identical, and the pool provider is a third copy of
   the same shell. The catalogue and the failure text are chosen by kind strings outside the
   `backendKinds` table. One `makeApiProvider` would remove about 400 lines, and the scripted double
   would test the path the real providers use. A `BackendKind` that carries its catalogue reader
   would do the rest.
3. **Product modules know about tests, perf runs and the state layout (HR-HOST-5, -6, -12).** The
   state directory is found from `process.argv` in two modules (`argv[1]` and `argv[3]`) and
   derived by `dirname(dirname(...))` three times in `index.js`. Sweep failures are swallowed
   "because tests have no state dir", which silently disables the daemon-wide blob quota count. A
   durable `BackendSpec.logPath` lets the spec's author have the unconfined adapter append to any
   path, and a perf switch file under the source tree adds a subscriber to every channel.

**The three things most worth keeping**

1. **Rights amplification by manager-side WeakMaps** (`durable.js:101-103`, `:255-256`, `:344-351`;
   `durable-subscriptions.js:161-177`). Blob file keys, archive keys and secret store keys exist
   only in vat WeakMaps and in batched sink answers. Vats hold `Blob`, `Secret`, `ReadGrant`,
   `PoolMember` and `Backend` objects, never names. A handle the manager did not mint answers
   `null`. This is the owner's "pass objects, not names" principle carried out [read].
2. **The Endpoint's lease protocol** (`impl/endpoint.js`, 231 lines). Overtaking `startRound` calls
   are parked until their lease arrives, early deadline arms are kept for the round that brings
   the sink, released turns are ignored, and every map has a bound. Each message-order assumption
   is stated in a comment next to the code that depends on it [read].
3. **Durability order in the stores** (`impl/blobs.js:6-14`, `:84-100`; `archive/store.js:25-47`).
   A handle never leaves the process before its file is named and the directory fsynced.
   `stagePending`, `commit` and `drop` keep unsent stagings from leaking. A final-named segment is
   never deleted except by session delete. Trace hooks let tests check the order of the steps.
   `runProviderRound`'s fixed failure texts (no lower-layer message reaches a record, R4-79) belong
   here too [read].

---

## 2. Map of the area

Sizes in lines [measured]; arrows are static imports [measured with a grep over import lines; no
cycles found].

| group | modules (lines) | job |
| --- | --- | --- |
| manager part (vat) | `durable.js` 638, `durable-subscriptions.js` 665, `durable-gateway.js` 200 (1,503) | identities (Backend, session host facet, Blob, Secret, ReadGrant, PoolMember, pool Backend), WeakMap amplification, the attach sink, `withOps` forwarding, pool marks and served records, the gateway registration |
| loader | `ephemeral.js` 84 | installs the guest prelude, finds the harness from `argv[1]`, `require`s `impl/index.js` |
| composition and ops | `impl/index.js` 402, `impl/attach.js` 274 (676) | builds one incarnation; the hook tables `backendKinds` and `adapterTools`; the `AgentHostOps` facet (19 methods) and `bind`/`unbind` |
| turn path | `endpoint.js` 231, `context-cache.js` 710, `projection.js` 189, `projection-hooks.js` 24, `timers.js` 54 (1,208) | lease and round dispatch; the per-session context cache; records to transcript |
| stores | `blobs.js` 890, `content.js` 30, `archive/` 2,896 (`store.js` 1,590, `history.js` 537, `segment.js` 356, `context-file.js` 293, `mirror.js` 120) (3,816) | staged text files; per-session segments, manifest, persisted projection and mirror; archived history pages |
| providers | `round.js` 682, `scripted.js` 838, `openrouter.js` 685, `anthropic.js` 862, `catalog.js` 816, `retry.js` 243, `http.js` 221, `sse.js` 185 (4,532) | the shared round runner, two API wire clients, the scripted double, model catalogue, retry, HTTP and SSE |
| viewers and input | `channels.js` 788, `channel-taps.js` 21, `list-channel.js` 353, `live-service.js` 50, `composer.js` 240 (1,452) | session channels and fold, the session list feed, `Live`, `Composer` |
| tools | `tools/echo.js` 199 | the echo test tool |

Import structure [measured]:

- `index.js` imports 25 modules, including `secrets/`, `subscriptions/` and `gateway/`.
- `openrouter.js`, `anthropic.js` -> `round.js`, `retry.js`, `http.js`, `sse.js` and `scripted.js`
  (for `makeEventLog`); `round.js` -> `scripted.js` (`tailText`) and `context-cache.js`
  (`isAbandoned`); `scripted.js` -> `context-cache.js`.
- `archive/store.js` -> `segment.js`, `mirror.js`, `context-file.js`, `history.js`;
  `context-file.js` -> `projection.js`; `context-cache.js` -> `projection.js`.
- Nine adapter modules import the session vat's program internals `guest/session/staging.js` or
  `guest/session/records.js`, not only `guest/lib/` (`context-cache`, `projection`, `channels`,
  `round`, `scripted`, `tools/echo`, `archive/store`, `archive/history`, `archive/segment`).
- The manager part imports `guest/lib/interfaces.js`, `interfaces-m3.js` and `interfaces-m4.js`,
  plus `limits`, `bounded` and `retired`.

Functions over 300 lines [measured with the TypeScript parser]: `makeArchiveStore` 1,237,
`makeBlobStore` 690, `makeContextCache` 569, `durable.js` `make` 559, `makeScriptedProvider` 553,
`makeSubscriptionsPart` 516, `makeHistory` 427, `runProviderRound` 358, `runRound` (scripted) 351,
`anthropicAttempt` 316, `makeChannel` 310. This is the closure-per-object style of the whole code
base, not a fault by itself. `makeArchiveStore` is the one large enough to need splitting
(section 4).

---

## 3. Findings, in severity order

### HR-HOST-1 (major, questions 1 and 4) The durable half holds adapter policy and duplicate exos, against D-14

- **Where.** `resources/agent-host/durable.js` (638 lines), `durable-subscriptions.js` (665),
  `durable-gateway.js` (200). Policy examples: `durable-subscriptions.js:293-315` (`rowOf` pages
  the adapter's catalogue, up to `EFFORT_PAGES` = 8 `withOps` calls per `resolveEffort`),
  `:373-379` (Codex spells Fae's `ultra` as `max`), `:543-606` (catalogue page cut to one frame by
  binary search), `:49-101` (`SPEC_FIELDS`, `sameSpec`), `:65` (`providerOf`). Duplicate exos:
  `durable.js:500-544` `makeBackend` and `durable-subscriptions.js:321-406` `makePoolBackend` repeat
  `describe`, `listModels`, `resolveModel` and `open` (9 duplicated 5-line windows [measured]).
  Both are exos named `Backend` with different guards (`m2Interfaces.Backend`,
  `m4Interfaces.PoolBackend`).
- **Evidence.** D-14 (architecture 3.3): "`durable.js` is small and changes rarely". The reason:
  an installation's identity is its bundle digest pair, a reinstall breaks every reference into
  the manager vat, and the reinstall migration is W13.2, not built (`milestones.md`). `durable.js`
  has 12 commits in three days, and the part has grown to 1,503 lines [measured]. Every provider
  quirk placed here (the effort spelling, a new spec field in `SPEC_FIELDS`) needs a reinstall,
  while the same fix in `impl/` needs a restart. The module comment at `durable.js:5` still says
  "Thin on purpose" [read].
- **Fix.**
  - Move `resolveEffort`'s row lookup and spelling rule into the adapter's catalogue: one ops call
    `resolveEffort({ backend, spec, modelId, reasoningEffort })`.
  - Move the catalogue's frame cut into the adapter's `describeSecrets` answer (the adapter
    answers a page already cut).
  - Merge `makeBackend` and `makePoolBackend` into one `Backend` maker with a `kind` check hook.
  - Leave in the vat what must persist: identities, WeakMaps, marks, served records, bounds.
- **Size.** About 200 lines moved or removed across 4 files (`durable-subscriptions.js`,
  `durable.js`, `attach.js` guard, adapter catalogue). It is itself one reinstall, so do it once,
  before W13.
- **Risk.** It changes the manager bundle digest (one reinstall), and every installed state is a
  test state today. Covered by `test/unit/m4-manager.test.js`, `test/unit/m4-effort.test.js`,
  `test/adapter/m2-w23-manager.test.js` and the `m4-pools` integration test.

### HR-HOST-2 (major, questions 2 and 3) The provider abstraction is four shells around one runner, plus kind strings outside the kind table

- **Where.** `impl/providers/round.js:247-605` (`runProviderRound`); `scripted.js:285-838`
  (`makeScriptedProvider`, its own `runRound` at `:380`); `openrouter.js:565-685` and
  `anthropic.js:744-862` (the factories); `subscriptions/provider.js:100-320` (the pool provider,
  outside scope, read for the seam); `impl/endpoint.js:131-136`; `providers/catalog.js:414-428`;
  `impl/index.js:336-356`.
- **Evidence.**
  - The scripted double re-implements the round: the `dispatching(0)` gate, progress checkpoints,
    `roundFailed` partial cutting and result staging. That is 85 duplicated 5-line windows with
    `round.js` [measured], so the fast tests exercise a second implementation, not the one real
    providers use.
  - `diff` of the two API factories: about 100 of 120 lines identical. They differ in base URL,
    timeout, `*Body`, `*Messages`, `*Attempt`, the delay function and the failure text (81
    duplicated windows [measured]).
  - The pool provider is a third copy of the `running` map, `startRound`, `cancelRound` and
    `releaseTurn` shell [read].
  - The catalogue is chosen by `spec.kind === 'openrouter' | 'anthropic'` in `catalog.js:420-427`
    and by `subscriptions.handles(spec)` in `index.js:337` and `:347`. Neither is in
    `backendKinds`.
  - `endpoint.js:133-134` labels any provider without `unexpectedFailure` as "scripted provider
    failed".
  - `BackendKind.makeProvider`'s typedef (`index.js:52`) has three `startRound` parameters, but
    the endpoint passes four (`owner`, `endpoint.js:126`).
  - The options pass `spec` together with `label`, `script` and `logPath`, which are fields of
    `spec` (`index.js:255-268`).
- **Fix.**
  - `makeApiProvider({ defaults: { baseUrl, timeoutMs }, attempt, body, delayMs, unreachable })`
    owns the shell; OpenRouter, Anthropic and the pool kinds supply only `stream`.
  - The scripted double becomes a `stream` (a scripted event source) under the same
    `runProviderRound`.
  - `BackendKind` gains `catalog` (reader or fixed rows) and `unexpectedFailure`; `index.js` and
    `catalog.js` stop switching on kind strings.
  - Fix the typedef.
- **Size.** About 400 lines removed and 6 files touched (`openrouter.js`, `anthropic.js`,
  `scripted.js`, `round.js`, `catalog.js`, `index.js`), plus `subscriptions/provider.js`.
- **Risk.** Scripted timing (progress cadence, the `context` event) is asserted by
  `test/adapter/m2-w26-scripted.test.js`, `m1b-blobs-provider.test.js` and perf
  `perf/turn.perf.mjs`; those tests will show where the scripted double relied on its own loop. API
  paths are covered by `m2-w21a-openrouter`, `m2-w21b-anthropic`, `m2-w21b-retry` and `m4-provider`.

### HR-HOST-3 (moderate, question 5) The Composer decides whether to delete a staged file by matching the session's error texts and guard messages

- **Where.** `impl/composer.js:60-123`, used at `:196-208` and `:221-226`.
- **Evidence.** `REFUSAL_PREFIXES` includes `'In "enqueueOnce" method of (Session)'` (the
  interface guard's message format), `textOfM5.tooManyAttachments(0).split('(')[0]` and
  `textOfM5.duplicateAttachment('').split('"')[0]` [read]. A refusal that matches deletes the
  blob file; one that does not leaves it until session delete. Renaming a session method, changing
  the guard library's message format or rewording an M5 text silently changes the file's fate.
  Matching too much would delete a file the vat kept. This is core finding AR-SYN-2 ("concepts are
  passed as strings") at a new site, and the M5 lane added five prefixes to it.
- **Fix.** The session answers a refusal before storing as a value (`{ refused: code }`) instead
  of throwing; the Composer drops the file on that value and on a retired break, and keeps it
  otherwise. The guard case (a malformed call never runs the method) can be prevented here: the
  Composer already checks blank text and sizes, so it can check the same shape before staging.
- **Size.** About 60 lines in `composer.js`, plus a return-shape change in `guest/session/queue.js`
  and the M5 attachment check (3 files; session program bundle).
- **Risk.** `test/unit/m5-w57-composer.test.js`, `test/adapter/m2-queue-composer.test.js` and
  `m1a-composer.test.js` pin the current texts. The session's `enqueueOnce` receipt shape is
  contract, so the UI and gateway readers of receipts must be checked.

### HR-HOST-4 (moderate, question 5) Two pagers use positions as cursors, the defect J-9486 fixed for `SecretsAdmin.list`

- **Where.** `durable-subscriptions.js:274-283` (`listMembers`), `:543-592` (`catalog`); the fixed
  one at `durable.js:443-458`.
- **Evidence.** M2-FIX (J-9486) changed `SecretsAdmin.list` to page by creation serial "so a
  delete between pages skips none". `catalog` pages `secretList()` by position, and
  `Secret.delete` removes from that list (`durable.js:415`): a delete between two catalogue pages
  skips one secret. `listMembers` pages `memberList` by position, and `retire` removes from it
  (`durable-subscriptions.js:222`): same defect [read]. The operator's Secrets panel uses
  `catalog`, not `list`.
- **Fix.** Page both by creation serial, as `list` does (members need a serial in their record).
- **Size.** About 25 lines, 1 file (manager bundle).
- **Risk.** Low; add the J-9486 "delete between pages" case to `test/unit/m4-manager.test.js`.
  The cursor format is opaque to callers but crosses the browser bridge; old cursors die at
  restart anyway.

### HR-HOST-5 (moderate, question 1) The state layout is discovered from process arguments in two modules and derived three times in the composition root

- **Where.** `ephemeral.js:39-56` (`argv[1]`, the harness as the core's sibling);
  `impl/blobs.js:149-161` (`argv[3]`, `<state>/bundles/<digest>.cjs`); `impl/index.js:141-143`,
  `:167-169`, `:191-192` (`dirname(dirname(typeof blobDir === 'function' ? blobDir() : blobDir))`
  for the state directory, and `archiveDirFor` as the blob directory's sibling,
  `archive/store.js:129`).
- **Evidence.** D-14 promises an operator-owned `implDir` fixed at install. The loader instead
  finds the implementation from the core's entry path (its comment says why: `installNative`
  carries no configuration, J-0221). The state directory is reconstructed from the blob directory,
  which is reconstructed from a bundle path. The sink getter is written three ways: it throws
  (`:131-134`), it returns `undefined` (`:145`, `:189`), or a third time inside `secrets()`
  (`:179-182`) [read]. The M4 contract (H-4 c) copied the `dirname` expression on purpose
  ("the `stateDir` expression is the one the `secrets` helper already uses").
- **Fix.** One `findStateDir(argv)` in the loader. `makeAgentHostImpl({ stateDir })` derives
  `blobs/`, `archive/` and the secrets files from it (one layout function). One `sinkOf()` that
  throws "not attached". Record the `implDir` gap in architecture D-14 instead of in a code
  comment.
- **Size.** About 40 lines, 4 files.
- **Risk.** Low. Tests pass `blobDir` and `archiveDir` (`test/adapter/m1b-*.test.js`,
  `m2-archive-store.test.js`), so those options stay, derived from a `stateDir` option when absent.

### HR-HOST-6 (moderate, question 5) Start-up sweeps swallow every error, which can leave the daemon-wide blob quota uncounted

- **Where.** `impl/index.js:380-387`; `impl/blobs.js:843-865`.
- **Evidence.** `await blobs.sweep().catch(() => {}); // ... no state dir in tests` and the same
  for `archive.sweep()`. `sweep` both deletes `*.part` files and counts the bytes on disk into
  `diskBytes`, which `reserve` checks against `quota.daemonBytes` (`blobs.js:282-294`). If
  `readdir` fails in production (permissions, descriptor exhaustion), the incarnation starts with
  `diskBytes = 0` and nothing is logged, so the daemon quota under-counts by whatever is on disk
  [read; the failure case is inferred]. A test accommodation thus switches off a safety bound in
  product code.
- **Fix.** Tests pass a directory (they already pass `blobDir`). In product, a failed sweep fails
  the bind, or at least is reported through the adapter's event log and makes `reserve` refuse
  until a later sweep succeeds.
- **Size.** About 10 lines, 2 files.
- **Risk.** Tests that build `makeAgentHostImpl` with no directory (`m1a-agent-host.test.js:399`)
  need one; low otherwise.

### HR-HOST-7 (moderate, questions 1 and 3) The ops facet is one guard over five method families, with two dispatch styles and a "not built yet" path that cannot run

- **Where.** `impl/attach.js:41-217`; the forwards in `durable.js:592-616`; `index.js:209-216`,
  `:275-366`.
- **Evidence.** The `AgentHostOps` facet has 19 methods [measured] in five families:
  - ports and viewers: `open`, `liveChannel`, `live`, `composer`, `content`, `listPublisher`;
  - blobs and archive: `history`, `releaseBlobs`, `releaseArchive`, `writersFor`;
  - models: `listModels`, `resolveModel`;
  - secrets: six `secret*` methods;
  - credentials: `credentials`.

  M2 put the secrets methods flat on the facet. M4 instead returned a sub-facet
  (`credentials() -> CredentialOps`, cached per ops facet in `durable-subscriptions.js:137-158`).
  These are two styles for one need. `M2_FORWARDS` and `M2_DONE` (`attach.js:126-143`, `:193-215`)
  and `secretsHandler` (`index.js:209-216`) throw `textOf.notBuilt` when a handler is missing. But
  the only product caller (`index.js:275`) passes every handler, and only two tests call `makeOps`
  directly (`m2-w29-ops-guard`, `m2-archive-store`). The path exists for a staged build that is
  over [read, measured]. Every family also needs a forwarding stub on the manager side.
- **Fix.** Split by family into facets fetched once per incarnation, as `credentials()` already
  is: `secrets()`, `models()`, `store()` (blobs and archive). Required handlers, no `notBuilt`.
  This also gives the integration workflow's "sealing secret writes" change a facet of its own.
- **Size.** About 120 lines across `attach.js`, `index.js`, `durable.js` and
  `durable-subscriptions.js`; changes the manager bundle (pair it with HR-HOST-1).
- **Risk.** `test/adapter/m2-w29-ops-guard.test.js` pins the guard and needs rewriting. Retired
  sub-facets need the same `withOps` retry the credentials facet uses (it re-fetches on a new ops
  facet).

### HR-HOST-8 (moderate, question 5) `withOps` repeats any call once after a retired break, whether or not the call is idempotent

- **Where.** `durable.js:231-240`; callers `:460-480` (`create`), `:410-417` (`delete`).
- **Evidence.** A retired break means the adapter process died. It does not say whether the call
  was applied first. `secretCreate` applied before the break, then retried, meets
  `entries.has(key)` and fails `CREATE_FAILED` (`impl/secrets/store.js:639`). The manager then
  throws and never records the `Secret`, which leaves an orphan entry `k<n>` in the encrypted store
  that no object names. A retried `secretDelete` after an applied delete leaves the manager's
  record in place [read; the interleaving is inferred, needing an adapter death inside the call].
- **Fix.** Make the retried operations idempotent by key (`create` of an existing key with the
  same label succeeds; `delete` of a missing key succeeds). Alternatively, give `withOps` a
  per-call `idempotent` flag and retry only those.
- **Size.** About 15 lines, 2 files (the store change is in `secrets/`, out of scope; the
  integration workflow is editing secret writes now, so this may already be in hand).
- **Risk.** Low; `test/adapter/m2-w23-manager.test.js` with a fake ops facet that applies and
  then throws the retired text.

### HR-HOST-9 (moderate, question 2) The archive's History copies the vat's preview rules and constants

- **Where.** `impl/archive/history.js:24-52`, `:280-345`; `guest/session/history.js:26-30`,
  `:60-115`.
- **Evidence.** `previewRecord` is the same switch over five record kinds with the same constants
  (`PAGE_SLACK` 512, `PREVIEW_INTENTS_BYTES` 6144, `TURN_PREVIEW_KEYS_BYTES` 64). Only the
  staged-field predicate differs (handle or `SealedField`). The module comment says the rules are
  "copied" from `guest/session/turn.js`, but they live in `guest/session/history.js` now (stale
  comment) [read]. If the two copies drift, an archived page looks different from a kept one; no
  test compares them [inferred from test names].
- **Fix.** Export a pure `previewRecord(record, { isStaged })` and the constants from a
  `guest/lib/` module that both import.
- **Size.** About 80 lines removed, 3 files; the session bundle changes.
- **Risk.** Session program size: the M5 merge left a 1.4 % margin (journal, INT-VERIFY), and
  moving code to `guest/lib` must not grow it. Covered by `test/integration/m2-history.test.js`
  and `test/adapter/m2-archive-store.test.js`.

### HR-HOST-10 (moderate, question 2) Small helpers and durable-write primitives are written again in almost every module

- **Where and evidence** [measured with grep]:
  - `messageOf`: 23 copies in the package, 4 in scope (`durable-gateway.js:50`,
    `context-cache.js:96`, `archive/store.js:119`, `providers/scripted.js:224`). The core's
    `describeError` (`packages/thixotrope/src/describe-error.js`) is not exported.
  - `syncDirectory`: 4 copies (`blobs.js:165`, `archive/segment.js:78` (exported), `secrets/store.js:254`,
    `gateway/signin.js:54`).
  - temp-write, fsync and rename, 5 variants in scope with different directory-fsync choices
    (`blobs.js` `writePart`, `archive/store.js:195` `writeDurably`, `segment.js:241`,
    `context-file.js:105`, `mirror.js:56`) and 2 more outside (`secrets/store.js`,
    `subscriptions/account-file.js:192`).
  - `resolveLazy` or `lazy`: 5 copies.
  - Hand-written serial queues: 4 (`durable-gateway.js:78-91`, `context-cache.js:152`,
    `blobs.js:704`, `archive/store.js:528`). The core's `makeSerialQueue`
    (`src/serial-queue.js`) is not exported.
  - Cut text at a code point within N units: `catalog.js:104` `cutUnits` (exported and imported
    by `subscriptions/catalog.js`), `channels.js:190` (private copy), `scripted.js:143`
    `tailText` (used by `round.js`).
  - `assertDescription`: 3 copies (`durable.js:67`, `durable-subscriptions.js:72`,
    `secrets/store.js:267`); `secretError`: 2.
  - `SERVICE_KEY = 'agent-host'`: twice (`durable.js:50`, `attach.js:35`).
- **Fix.**
  - One adapter-side `impl/fs-durable.js` (`syncDirectory`, `writeDurably({ dirSync })`).
  - One `guest/lib/` module for `messageOf`, `cutUnits` and `tailText`, plus `assertDescription`
    and `SERVICE_KEY` beside `GATEWAY_KEY`.
  - Ask the core to export `describeError` and `makeSerialQueue` (vat code cannot import Node
    modules, but both are pure).
- **Size.** About 150 lines removed, about 15 files; mechanical.
- **Risk.** Low. The differing fsync choices are deliberate in places (the mirror and the context
  file are caches, written without fsync), so the shared helper must keep the choice explicit.

### HR-HOST-11 (moderate, question 2) The session channel and the list channel each implement subscriber queues and rev reordering

- **Where.** `impl/channels.js:178-345` (`makeSubscriber`, reorder) and
  `impl/list-channel.js:80-353`.
- **Evidence.** 58 duplicated 4-line windows between the two [measured]. Both have bounded
  per-subscriber queues by deliveries and bytes, the same close reasons, eviction of the subscriber
  with the most queued bytes, and rev reordering with `reorderWaitMs`, `reorderWindowBatches` and
  `reorderBacklogDeliveries`. The list channel's comment says "Numbering and order, as the session
  channel" [read]. Both call `node:timers` directly, although `timers.js` exists for that.
- **Fix.** One `makeRevChannel({ snapshotEvent, fold? })` used by both. The session channel adds
  its fold and taps.
- **Size.** About 150 lines removed, 2 files.
- **Risk.** Moderate: channel bounds are perf-sensitive (J-0230: the guard cost per batch).
  Covered by `test/adapter/m1a-channels.test.js`, `m1a-channel-bounds.test.js`,
  `m1b-pool-list-channel.test.js` and the bench `m1a-channels.bench.mjs`.

### HR-HOST-12 (moderate, questions 3 and 5) Test and perf hooks live in product code, one of them as a durable file path

- **Where.**
  - `BackendSpec.logPath` (`guest/lib/interfaces.js:1297`, `:1310`; `interfaces-m4.js:157`; used
    by `providers/scripted.js:85-97`, `index.js:253`).
  - The live probe (`impl/channels.js:76-82`, `:660-735`).
  - Optional branches labelled for tests: `endpoint.js:125` ("without `prepare` (M1a tests)"),
    `composer.js:150` (`blobs === undefined`), `index.js:121` (`sink` option).
  - `makeAgentHostImpl` returns seven fields only tests read (`index.js:390-400`; product uses
    `bind` and `unbind`).
- **Evidence.**
  - `logPath` is part of the durable spec a `makeBackend` caller writes. The unconfined adapter
    then opens that path for append (mode 0600) and fsyncs a line per round event, with no check
    of where the path points [read]. It is set by 20 test and perf files and one provisioning step
    (`scripts/provision-steps/40-subscriptions.js`) [measured]. Today the factory is the only
    holder of `AgentHostAdmin`, so this is ambient file authority behind a trusted caller, not an
    open hole [inferred]. It still breaks "objects, not names" and rule 12.7's confinement intent.
  - The live probe checks for a switch file under the source tree (`tmp/live-probe/enabled`) when
    the registry is made. If the file exists, every channel of a real daemon gets an extra
    subscriber writing timing lines [read].
- **Fix.**
  - Replace `logPath` with an adapter configuration option (an event-log directory set at start,
    as the secrets key file is) or an `EventLog` capability passed by the test harness. Keep the
    spec free of paths.
  - Inject the probe through `makeChannelRegistry({ probe })` from the perf harness only.
  - Make `prepare` and `blobs` required.
- **Size.** About 60 lines in product, plus the 20 test and perf files that set `logPath`.
- **Risk.** Moderate churn in tests; the perf scripts read the event log to time rounds
  (`perf/_crank.mjs`, `perf/_long-session.mjs`).

### HR-HOST-13 (minor, question 4) "Key", "token" and "epoch" each name several things in this area

- **Evidence** [read; counts measured: 416 `key` and 56 `epoch` tokens in scope]:
  - **key** names a registration key (`SERVICE_KEY`, `GATEWAY_KEY`), a blob file key `b<n>`, an
    archive key `h<n>`, a secret store key `k<n>` and an API key. `readKey` reads an API key
    through a grant in `index.js:201` and the providers, but reads a blob file by its key in
    `blobs.js:625`.
  - `resolveSessions`, `resolveSecrets` and `resolveGrants` all return `m1bShapes.BlobKeys`
    (`durable.js:118-139`).
  - **token** is the `{ key }` stand-in for a blob handle in archived records
    (`archive/context-file.js:44-55`, `context-cache.js:224-227`) and an OAuth token in the
    sibling `subscriptions/`.
  - **epoch** here is the session's context epoch (`RoundRequest.base.epoch`, `context-cache.js`,
    `archive/context-file.js`), a fourth meaning beside the three of AR-ONTO-2.
- **Fix.** Rename the shapes and identifiers to their concepts:
  - `ResolvedKeys`;
  - `blobFileKey`, `archiveKey`, `storeKey`, `apiKey`;
  - `readApiKey` versus `readBlobFile`;
  - `SealedRef` for the token;
  - `contextEpoch`.

  Add these to the glossary. Persisted names (`epoch` in `context.jsonl` and the manifest) stay.
- **Size.** About 100 identifier sites, 12 files; no format change.
- **Risk.** Low; types and tests catch renames.

### HR-HOST-14 (minor, question 1) Adapter modules depend on the scripted double, on a store module and on the session vat's internals

- **Where.** `openrouter.js:82` and `anthropic.js:102` import `makeEventLog` from `scripted.js`;
  `round.js:60-61` imports `isAbandoned` from `context-cache.js` and `tailText` from
  `scripted.js`; nine modules import `guest/session/staging.js` or `guest/session/records.js`
  (section 2).
- **Evidence.** The real providers' import of the test double is the visible sign of HR-HOST-2.
  `isAbandoned` is the round's error class, defined in the cache. `staging.js` and `records.js`
  are the session program's modules, used by the adapter as a shared vocabulary (`isStaged`,
  `blobsOf`, `inCallOrder`) [read, measured].
- **Fix.** `providers/event-log.js` for `makeEventLog`; `isAbandoned` and `tailText` into
  `round.js` or a `providers/shared.js`; move the pure helpers that both sides use from
  `guest/session/` to `guest/lib/`.
- **Size.** About 30 lines moved, 12 import lines.
- **Risk.** Low; the session bundle must not grow (re-export from the old place for the vat).

### HR-HOST-15 (minor, question 3) Dead seams and unused data

- **Evidence** [read, measured]:
  - The hook tables `channelTaps` and `projectionHooks` are still empty after M5. The comment
    says M1b's list feed and M3's gateway would add taps; neither did, and the table is threaded
    through `makeChannelRegistry` and `makeChannel` with a try/catch per delivery.
    `projectionHooks` is reserved for M8 compaction, so keep it.
  - The `incarnation` string travels to `AgentHostSink.attach` and is ignored there
    (`durable.js:195`). It defaults to `${pid}` in `index.js:119` and to `pid` plus random in
    `ephemeral.js:76`.
  - `removeMirror` (`archive/mirror.js`) is exported and never imported.
  - `forwardSinkMethods` (`durable-subscriptions.js:652-664`) exists only because the part is
    built after the sink. Building the part first, with `withOps` passed lazily, removes it.
  - `Live.subscribeList` and `ops.listPublisher` keep "no list feed yet" branches
    (`live-service.js`, `attach.js:188-191`) for a feed that M1b built.
- **Fix.** Remove the `channelTaps` table, the `incarnation` argument (or use it in the
  manager's attach log), `removeMirror` and the "not yet" branches; reorder the construction in
  `durable.js`.
- **Size.** About 60 lines, 7 files (manager bundle for `durable.js`).
- **Risk.** Low.

### HR-HOST-16 (minor, question 1) The per-session blob store view is a spread of the whole store

- **Where.** `impl/index.js:232-241`, used for adapter tools (`:298-305`) and per-session
  `Content` (`:316`).
- **Evidence.** `blobsOf(owner)` spreads every `BlobStore` member and overrides four (`stage`,
  `stagePending`, `read`, `readPage`). The rest pass through unscoped: `release`, `sweep`,
  `discard`, `readKey` (any file by key), `writers` (an ownerless, unquoted writer) and
  `chargeArchived`. A tool given "this session's store" can read or delete any session's blob
  files [read]. Tools are adapter code today, so this is an attenuation the code does not enforce
  rather than a hole. It matters for the integration workflow's "offering adapter tools to the
  model" change.
- **Fix.** Build the session view as an explicit object with only the members a tool or Content
  needs.
- **Size.** About 15 lines, 1 file.
- **Risk.** Low; `test/adapter/m1b-followups-blobs.test.js` covers provenance.

### HR-HOST-17 (minor, question 4) Milestone-named vocabulary in the manager and adapter

- **Evidence.** In scope [measured]: `m4Limits` 52 references, `m4Texts` 47, `m4TextOf` 21,
  `m1bInterfaces` 18, `m4Interfaces` 16, `m3Texts` 11, `m1bShapes` 11, and 9 more names. The
  `AgentHostAdmin` guard is `withGatewayAdmin(m2Interfaces.AgentHostAdmin)`; the Secret guard is
  `m4Interfaces.Secret`.
- **Fix.** This is in hand: the integration workflow is splitting `guest/lib/interfaces.js` per
  vat. Record here only that the manager part and `attach.js` are the heaviest users of the
  milestone names, so they should be in that split.

---

## 4. Also observed (no finding)

- `makeArchiveStore` is a 1,237-line closure, with segment validation, acknowledgment, the context
  file, the mirror and the queue in one scope. The file-level split (`segment`, `mirror`,
  `context-file`, `history`) is good. The next cut would be validation and acknowledgment
  (`observeNow` 106 lines, `sealNow` 94, `syncContext` 99) into a module of their own. No
  defect found in it.
- The three stores with overlapping jobs (blob files, the per-session archive with its manifest,
  persisted projection and mirror, and the in-memory context cache) hold the same session context
  in up to four forms. Each module comment names one system of record (the vat for records, the
  segments for sealed records) and treats the rest as caches with stated torn-tail rules. The
  overlap is deliberate and documented in D-18 and m2-interfaces 4.4-4.12, so it is listed here and
  not as a finding. The weak point is that release has two calls (`releaseBlobs` paged, then
  `releaseArchive`) whose order is the factory's knowledge (`guest/factory/delete.js:14-17`).
- `durable-gateway.js` is a good small state machine with its own `serial` queue and a single
  stated retry for `rotateSignIn`.

## 5. Not covered

- `impl/secrets/`, `impl/subscriptions/`, `impl/gateway/` (other units). They were read only
  where a seam crosses into scope.
- `projection.js`, `sse.js`, `http.js`, `retry.js` and `tools/echo.js` were skimmed, not read
  line by line.
- Tests: only their names and the options they pass were checked. Question 5's "tests that do not
  test what they name" was not examined for this area.
- No run: nothing was executed beyond grep, a duplicate-window script and a function-length
  script (both in a scratch directory outside the repository).
- The reinstall cost in HR-HOST-1 is taken from the design (D-14, native.md section 1.2); the
  digest computation was not traced.
