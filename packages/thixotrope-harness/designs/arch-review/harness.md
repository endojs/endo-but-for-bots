# Architecture review of the harness: ranked synthesis (HR-SYN)

Unit HR-SYN of the harness architecture review. It merges the six area reports in this directory
with the two verification passes (HR-VER1 over HR-GUEST-1..9, HR-HOST-1..12 and HR-EDGE-1..11;
HR-VER2 over HR-TEST-1..12, HR-ONTO-1..4, -6..-9, -13 and HR-DUP-1..8). It is written for the
owner, who will decide what to fix before milestones M6 to M13 are built on this code. Read-only:
no source, test or config file was changed and nothing was run. Snapshot: branch `claude/thix-arch`
at `5acf3c2e22` (the area reports read `bd9a8ec070`, the M3/M4/M5 merge; only review documents
changed in between). Paths are relative to `packages/thixotrope-harness/` unless they start with
`packages/`. `AH` is `resources/agent-host/impl`.

| report | unit | scope | findings (major / moderate / minor) |
| --- | --- | --- | --- |
| `harness-guest.md` | HR-GUEST | vat programs: session, factory, exec, `guest/lib` | 2 / 7 / 7 |
| `harness-host.md` | HR-HOST | the agent-host manager part and the adapter core | 2 / 10 / 5 |
| `harness-edge.md` | HR-EDGE | secrets, subscriptions, gateway, browser UI | 3 / 8 / 8 |
| `harness-tests.md` | HR-TEST | tests, perf checks, scripts, tooling | 2 / 10 / 10 |
| `harness-ontology.md` | HR-ONTO | question 4 across the package | 1 / 8 / 9 |
| `harness-duplication.md` | HR-DUP | questions 2 and 3 across the package, measured | 0 / 8 / 8 |

Evidence marks carry over from the area reports: **read**, **measured**, **inferred**. A row in the
ranked table is there only because a verifier said "confirmed" (C) or "confirmed-smaller" (CS); no
finding was refuted. Where a verifier corrected a fix, the corrected fix is the one given
(section 3.2). Findings no verifier checked are listed apart (section 3.3); this synthesis re-read
four of them and the sites of four verifier "missed" items, and says so. One disagreement between
reports was settled by reading: HR-GUEST measured no import cycle in `guest/`, HR-DUP measured nine.
All nine are JSDoc `@import` type references (the tools import `ToolTableEntry` from
`tool-table.js`; `pool.js` and `root.js` import each other's types; `archive/history.js` names
`store.js` types) [read]. There is no runtime cycle; both reports are right.

Started 2026-11-18T13:13:51Z; the end time is in journal entry J-10105.

---

## 1. Verdict

The harness is sound where it matters and untidy in a way that is easy to trace back to how it was
built. Dependencies point the right way: product code imports no test, perf or tooling module;
vat code depends only on `guest/lib` and its own directory; no guest module uses a clock, a timer,
randomness or `console`; there is no runtime import cycle; nothing is copied from the core. Crank
discipline, durability order and the restart rules are written down and followed. Vats hold
objects, never keys. The wire vocabulary is closed and enforced, down to the gateway's pre-decode
guard. No confirmed defect loses a transcript. What costs is that each of the roughly 150 agent
runs built against a contract by **appending**: a new interface table, a new limits or texts
file, a new seam, a copy of the module it could not edit. The merge kept every layer. The harness
is about five times as copy-pasted as the core (3.9 % of normalised source lines in repeated
blocks against 0.8 %), and the session program has 3,417 of its 240,000 bytes left, so the
leftovers now block growth. **Four structural problems matter most before M6:**

1. **The contract scaffolding is still in the product** (HR-SYN-1, -7, -23). Three versions of the
   Session guard, M1b and M2 "views", M5 "widenings", an exec copy of the M5 guards, ten `notBuilt`
   stubs no vat reaches, and 546 milestone-named identifiers in 12 milestone-named files. The
   gateway finds its key vocabulary by file-name glob, so the per-vat split now in progress can
   silently narrow it. Removing the scaffolding is also what frees the session program's bytes.
2. **The durable half is not thin** (HR-SYN-2, -11, -13). The agent-host manager part is 1,503
   lines that changed in 12 commits in three days, and it holds adapter policy. Every change to it
   is a reinstall that breaks references, and the reinstall migration (W13.2) does not exist.
3. **Seams became copies** (HR-SYN-3, -17, -25, -26). Four provider shells around one round
   runner, a scripted double that is a second round engine (so most integration tests prove the
   fake's path), a copied catalogue whose limits have already drifted, two channel subscribers,
   thirteen atomic writers.
4. **Two closures own too much** (HR-SYN-4, -6). The turn runner (1,560 lines, eight jobs) and the
   UI controller (1,235 lines), each with state that later milestones put beside them in
   module-level `WeakMap`s because there was no seam for it.

Correctness items are few and small: a retry that re-applies a non-idempotent secret write
(HR-SYN-8), a blob quota that can be under- or over-counted (HR-SYN-9), a staged file deleted or
kept by matching error texts (HR-SYN-10), two pagers that skip a row after a delete (HR-SYN-11), and
a failure fallback that can copy a provider body into a turn record (HR-SYN-12).

## 2. What is good and must be kept

A fix that damages one of these is a bad fix.

- **Dependency direction** [measured]: guest, resources, ui and config import nothing from tests,
  perf or tooling; scripts import no test or perf code; vat code depends only on `guest/lib` and
  its own directory; no runtime import cycle anywhere in source; 0 lines copied from
  `packages/thixotrope/src`.
- **Crank discipline in the session vat** (`guest/session/turn.js`, `recovery.js`): intent before
  effect (`claim` takes before any record or send, `turn.js:1296-1378`), one publish per crank
  through the outbox, `settle` keeps its batch and lease release when the next claim throws
  (`:512-529`), synchronous recovery that abandons work by generation. The archive drops records
  only after the durable answer matches the intent (`archive.js:204-238`).
- **Rights amplification by manager-side `WeakMap`s** (`resources/agent-host/durable.js:101-103`,
  `:255-256`, `:344-351`; `durable-subscriptions.js:161-177`; 46 sites, one idiom): blob, archive and
  store keys never reach a vat; an unknown handle answers `null`. This is "objects, not names"
  carried out.
- **The Endpoint's lease protocol** (`AH/endpoint.js`) and **store durability order**
  (`AH/blobs.js`, `AH/archive/store.js`): parked rounds, bounded maps, ordering assumptions stated
  beside the code; a handle never leaves before file and directory are fsynced; kill points
  injected as `trace`/`hooks`, never switched by the environment.
- **`runProviderRound` with fixed failure texts** (R4-79) and **one retry module**
  (`AH/providers/retry.js`): the right seams to consolidate on.
- **The secret value path**: `SecretWriter` finds the key by amplification, CLI values sealed to an
  X25519 key, one-key `CredentialAccess` with generation-conditioned replace, store `mutate` that
  changes the map only after the durable write and rolls back on failure; one AES-GCM seal reused.
- **The gateway's pre-decode guard** (`AH/gateway/guard.js`, `vocabulary.js`): checks the encoded
  call before CapTP decodes it, derives its vocabulary from the interface guards, names the rule
  in every refusal. The hand-written WebSocket parser is careful (masks, RSV, bounds before
  buffering, slow-consumer bound).
- **Closed vocabularies and fixed-text tables**: `M.splitRecord` shapes and `M.or` state sets,
  texts that cite their spec item, format tags on every persisted file, one exact-match
  retired-break predicate (`guest/lib/retired.js`) with site classification in the tool table.
- **Structured wire facts** (`AH/subscriptions/wire.js` `WireFacts`), a pure selection core
  (`AH/subscriptions/pool.js` imports nothing), a sign-in limiter bounded by its ceiling.
- **The test machinery the time rules rest on**: the state template (cloned per test, keyed on
  runtime identity, published by one rename), one spawn path with an environment allowlist and a
  parent-death pipe, the run lock with the 10-minute box and `runs.jsonl`, one perf row emitter,
  object-level fakes in unit and adapter lanes with no skipped test, the black-box secret grep
  (`assertNoSecretInState`).
- **Hygiene** [measured]: no TODO/FIXME/HACK in source, all 50 empty `catch` blocks commented,
  environment reads centralised in `scripts/serve.mjs`, all 66 `test.skip` are environment gates,
  deliberate copies (config against guest limits, M5 browser copies) guarded by equality tests.

---

## 3. Ranked findings

### 3.1 Table

Class: **do now** (small, safe, pays at once); **before M6** (structure M6-M13 would otherwise
copy); **do with X** (belongs with the named change); **plan** (needs its own design); **leave**.
Q: 1 architecture, 2 repetition, 3 excess paths, 4 ontology, 5 other. Sev: M major, m moderate, n
minor. "Split" is the per-vat split of `guest/lib/interfaces.js` the integration workflow is doing;
"sealed writes" is its sealing of secret writes; "adapter tools" its offering of adapter tools to
the model; "reinstall" is one batched agent-host manager reinstall (step 4 of section 5).

| rank | id | sev | what | where | Q | size | risk of the fix | class | sources (verdict) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HR-SYN-1 | M | Contract scaffolding and milestone names left after the merge: Session guard in 3 versions; `m1b*` views and `m2Interfaces` read by 22 product files; `m5Widenings`; an exec copy of the M5 guards kept equal by a test; `lazyTable` 4 times; `texts`/`textOf` exported by 4 modules, `limits` by 2, imported under 13 aliases; 12 milestone-named files, 546 identifier sites | `guest/lib/interfaces.js:101,2441-2621`; `interfaces-m3.js:73`; `-m4.js:65`; `-m5.js:73,444`; `exec/render.js:366-440,423,428`; `limits-m5.js:7-8`; `config/defaults.js:11` | 3, 4 | about 600 lines deleted, about 550 identifier sites, 12 file renames | `m5Widenings` is read (`interfaces-m5-factory.js:222`, `interfaces-m5.js:601`): rewire before deleting; measure the exec bundle (`perf/creation-m5`) before dropping its copy; factory and manager identifiers change installed bundles; contract tests rewrite | do with split (in hand) | HR-GUEST-2 (C), HR-GUEST-9 (C), HR-ONTO-2 (C), HR-DUP-7 (C), HR-HOST-17, HR-EDGE-16, HR-DUP-10 |
| 2 | HR-SYN-2 | M | The manager part is not thin (D-14): 1,503 lines, 12 commits to `durable.js`; adapter policy in the vat (Codex `ultra`->`max`, `EFFORT_PAGES` 8 round trips, a binary-search frame cut, `SPEC_FIELDS`); two `Backend` makers; one ops guard over five method families in two dispatch styles with `notBuilt` paths no caller reaches; `forwardSinkMethods` from construction order | `durable-subscriptions.js:49-101,290-315,363-381,543-606,652-664`; `durable.js:489-545`; `AH/attach.js:41-217` | 1, 3, 4 | about 320 lines in 5 files | The fix is itself a reinstall that breaks live references until W13.2: batch it, never piecemeal. `PoolBackend` keeps `resolveEffort`, `assertActivePool`, `poolOfSession` (merge with a kind hook). Facets must be re-fetched after a retired break, as `credentials()` is. Tests: `m4-effort`, `m4-pools`, `m4-catalog`, `m2-w29-ops-guard` | before M6 (reinstall) | HR-HOST-1 (C), HR-HOST-7 (C), HR-HOST-15, HR-ONTO-5 |
| 3 | HR-SYN-3 | M | One provider seam became four shells: the two API factories are about 100 of 120 lines identical, the pool provider is a third copy; the scripted double is a second round engine (104 repeated lines; real providers import `makeEventLog` from it); catalogue chosen by kind strings outside `backendKinds`; `startRound` typedef 3 parameters, called with 4; a projection fallback production never takes (an empty transcript in the pool path) | `AH/providers/anthropic.js:744-862`, `openrouter.js:565-685`, `scripted.js:232,380-747`, `round.js:61,94,247-605`, `catalog.js:414-428`; `AH/subscriptions/provider.js:100-320`; `AH/index.js:52,336-356` | 2, 3 | (a) about 200 lines removed, 7 files; (b) about 300 | (a) `makeApiProvider` + `providers/event-log.js` + `BackendKind.catalog`: low (adapter tests against fake servers). (b) the scripted double as a stream under `runProviderRound`: high, most integration and perf files depend on its timing; failures look like flakiness | (a) before M6; (b) plan, last and alone | HR-HOST-2 (C), HR-DUP-2 (C), HR-DUP-3 (C), HR-HOST-14, HR-DUP-14 |
| 4 | HR-SYN-4 | M | `makeTurnRunner` is one 1,560-line closure with 17 mutable bindings and eight jobs (ports and restart state, outbox, usage, settle/tools/rounds, archive/history/context source, claim and cancel, handles, import and delete fence); `archive.unresolved` is a raw `Map` read and deleted from `turn.js`; the delete fence is three flags | `guest/session/turn.js:197-1755`, `:1497-1611`; `archive.js:62,68,280`; `export.js:78,83,91` | 1, 5 | about 400 lines moved, 2 new modules | Crank boundaries must not move. Each module costs about 1.2 KB of wrapper against 3.4 KB margin: after HR-SYN-1 frees bytes. `runner.deleting` is used by `m2-w25-archive.test.js:595` (test behaviour instead); keep `maxUnresolvedTurns` when hiding the map | before M6, after split | HR-GUEST-1 (C), HR-GUEST-11 |
| 5 | HR-SYN-5 | M | One wrapping key, three loaders with three failure policies (two memoise a failure until restart, one retries), used raw for three AEAD formats; `signin.enc` is a separate file while ARCH says a store entry; the store's error contract leaks a raw audit-append failure and audits a failed revoke as `REPLACE_FAILED` | `AH/secrets/store.js:142-219,402,468-471,543-547,704`; `seal.js:120-148`; `AH/gateway/signin.js:94-124`; `designs/architecture.md:510` | 2, 5 | (a) one key object from `impl/index.js`, retry on failure: about 80 lines, 4 files; (b) HKDF subkeys | (a) low. (b) changes the encryption of the live `secrets.enc`: dual read, a one-time rewrite, never a wipe; test on a copy of a real-format file | (a) do with sealed writes; (b) plan | HR-EDGE-2 (C), HR-EDGE-13 |
| 6 | HR-SYN-6 | M | UI controller is one 1,235-line closure; M4/M5 features keep their own state beside it (3 `WeakMap`s keyed by `powers`, 4 listener sets, `getSecrets()` fetched twice, the inventory pager twice); the account chip's controller branch is dead in production, tested only against a fake | `ui/src/controller/index.js:187-1421,994`; `ui/src/secrets/daemon.js:20-64`; `accounts/feed.js:53-193`; `mentions/mentions.js:155,309-325`; `presets/editor.js:156-172`; `accounts/AccountChip.js:30-38` | 1 | (a) about 130 lines, 7 files; (b) 1,200 moved | (a) a per-connection cache on `FeatureContext` must reset when `powers` change; expose a no-argument `activeSession()` bound to the current key (the internal one takes a key). (b) epoch checks must be passed in, not captured | (a) before M6 (M11, M12 add features); (b) plan | HR-EDGE-1 (C), HR-EDGE-10 (C), HR-DUP-11 |
| 7 | HR-SYN-7 | m | The gateway's key vocabulary is collected by the glob `interfaces-m*.js`; a per-vat file outside it silently drops field names and the gateway refuses valid calls with "unexpected field"; extension and vocabulary loaders log and skip, and no test asserts zero skips | `AH/gateway/vocabulary.js:51,139-181`; `extensions.js:157-195` | 1, 5 | about 30 lines + 1 test | Low; must land before or with the split, which is the change that trips it | do now | HR-EDGE-11 (C, note), HR-EDGE-19, HR-VER1 on HR-GUEST-2, -9 |
| 8 | HR-SYN-8 | m | `withOps` repeats any call once after a retired break: a `secretCreate` applied before the break fails `CREATE_FAILED` on retry and leaves an orphan `k<n>` in `secrets.enc`; a repeated delete leaves the manager's record | `durable.js:231-240,410-417,460-480`; `AH/secrets/store.js:633-650,~716` | 5 | about 20 lines, 2 files | Create of the same key and label answers success (keys are manager-chosen, unique); delete of a missing key succeeds only on the retry path. No test kills the adapter between apply and answer: add a fault hook | do with sealed writes | HR-HOST-8 (C) |
| 9 | HR-SYN-9 | m | The daemon-wide blob quota can be wrong both ways: start-up sweeps swallow every error ("no state dir in tests"), leaving files on disk uncounted; `sweep` adds (`diskBytes += total`) on every bind of the service key, so a rebind in one incarnation counts files twice [inferred] | `AH/index.js:380-387`; `AH/blobs.js:289,843-865` | 5 | about 20 lines, 2 files | Failing the bind would stop every session: instead set the count from one sweep per incarnation, refuse `reserve` until it succeeded, log the failure; adapter tests without a state directory need a temporary one | do now | HR-HOST-6 (C), HR-VER1 missed 1 (site re-read) |
| 10 | HR-SYN-10 | m | The Composer decides whether to delete a staged file by matching the session's error texts and guard-message prefixes (an M5 text cut at `(`); `isEditRefusal` treats a retired break as "kept nothing" and discards, `isRefusal` treats it as "maybe kept" and keeps, with no stated reason | `AH/composer.js:60-123,196-226` | 5 | about 40 lines | Pre-check shape and attachment counts in the Composer before staging (no contract change); state the retired-break rule once. A value answer (`{ refused }`) would change Session return guards: not needed | do now | HR-HOST-3 (C), HR-VER1 missed 2 (re-read) |
| 11 | HR-SYN-11 | m | Two pagers use positions over lists that shrink (`listMembers`, the Secrets catalogue): a delete between pages skips a row, the defect J-9486 fixed for `SecretsAdmin.list`; cursors parsed with `Number()` accept `1e3`, ` 5`, `0x10` | `durable-subscriptions.js:222,274-283,543-592`; `durable.js:415,443-458` | 5 | about 30 lines, 1 file | A manager change; members need a serial; add a delete-between-pages test | do with reinstall | HR-HOST-4 (C), HR-DUP-11, HR-VER1 missed 3 |
| 12 | HR-SYN-12 | m | For any backend kind without `unexpectedFailure` the endpoint writes `scripted provider failed: <error.message>` into the turn record, the leak R4-79 forbids; a new kind added without the field would carry provider bodies into records | `AH/endpoint.js:131-136`; `AH/index.js:50` | 5 | about 10 lines | Make `unexpectedFailure` required on `BackendKind`; scripted names its own text; scripted tests that assert the old text change | do now | HR-VER1 missed 4 (re-read), HR-HOST-2 (C) |
| 13 | HR-SYN-13 | m | `BackendSpec.logPath` lets the caller of `makeBackend` make the unconfined adapter append to any path; a switch file under the source tree adds a probe subscriber to every channel | `guest/lib/interfaces.js:1293-1311`; `AH/index.js:253`; `durable-subscriptions.js:58`; `AH/channels.js:76-82,660-735` | 3, 5 | about 60 product lines + 21 test and perf files | `SPEC_FIELDS` compares it, so a manager change; persisted specs with `logPath` fail a new guard after reinstall; perf scripts read the event log | do with reinstall | HR-HOST-12 (C) |
| 14 | HR-SYN-14 | m | Fakes and fixtures are not held to the code: UI fakes are hand `Far` objects (0 guard references, 12 test files); the unit session fixture re-assembles the session "as session.js does" and drifted (no `maxToolRounds`, `sources`, `getRuntime`, `cancelCurrent`); two queue fakes break a lease with a text the hub never sends, so they take a branch production does not | `test/unit/_m3-fake-powers.js`, `_m4-ui-fakes.js`, `_m2-w25-session.js:187-215`, `_m2-queue-session.js:64`, `m5-w57-packages.test.js:244` | 5 | about 100 lines + fallout | Expect a batch of red tests (the point). Exporting `makeSessionCore` from `session.js` changes the session bundle (no new code); archive tests may meet behaviour they never set up | before M6 | HR-EDGE-9 (C), HR-TEST-11 (C), HR-TEST-22 (plausible) |
| 15 | HR-SYN-15 | m | Two extension mechanisms: static append-only hook tables whose per-session state lives in module-level `WeakMap`s, beside M5's per-session runtime parts; four context bags; `enqueueMessageOnce` re-implements `enqueueOnce`; a gateway extension registry (`services`, `routes`, `csp`, `extras`) with one 27-line user | `guest/session/recovery.js:83`; `packages.js:121,138-150`; `tools/exec.js:62`; `session.js:122-131,182,217-225`; `AH/gateway/extensions.js`; `ui/src/controller/index.js:851-856` | 1, 3, 4 | about 200 lines, 10 files | Hook signatures change; `recoveredGeneration` is per-incarnation; `checkAttachments` must still run before `see(at)`; `extras`/`services` are M3 contract (amend it, or keep); drop `csp` | before M6 (M6 adds `onCancel`, services, option resolvers) | HR-GUEST-4 (CS), HR-GUEST-6 (C), HR-EDGE-7 (CS) |
| 16 | HR-SYN-16 | m | No test-support layer: each milestone's helpers are the library; perf imports `test/integration` 58 times and tests import perf 44 (mostly one emitter); one spawn path wrapped four times with two served-state models, crash regexes already different; 13 poll helpers, drain helpers in 25 files, `stubExo`/`pathsOf` in all six interface tests; two fake provider servers share an 83-line copy | `test/integration/_m1a-slice.js`, `_m4.js:122-127`; `test/template/index.js:213,227-298,534-620`; `perf/_harness.mjs:456-543`; `perf/crash.perf.mjs:236-300`; `test/fixtures/fake-*-server.mjs` | 1, 2 | about 5,000 lines moved, imports in about 150 files | Mechanical in one commit after the lanes close; drain round counts stay a parameter (some are tuned to a crank depth); `crash.perf` has no test, run it once | before M6 | HR-TEST-1 (CS), HR-TEST-2 (C), HR-TEST-8 (C), HR-DUP-15, HR-TEST-18, HR-TEST-21 |
| 17 | HR-SYN-17 | m | The pool catalogue copies M2's (122 lines; `pageOf` identical but for comments; the owner cache) and has drifted: `MAX_BODY_BYTES` 16 MB against 8 MB, `ANTHROPIC_VERSION` defined twice; four bounded-JSON readers beside an unused `boundedChunks` | `AH/subscriptions/catalog.js:60,88,119-191,376-436,664-758`; `AH/providers/catalog.js:53,56,144-236,626-721`; `AH/providers/http.js:70`; `subscriptions/accounts.js:1013`; `renewal.js:~115` | 2, 4 | about 250 lines removed, 5 files | Keep each catalogue's bounds as parameters (body size, owner count) or a limit loosens silently; keep the `admitting` path and the optional failure log | before M6 (M8 reads catalogue windows) | HR-EDGE-3 (C), HR-DUP-1 (C), HR-DUP-9, HR-VER2 missed 2 |
| 18 | HR-SYN-18 | m | The integration suite no longer fits the 20-minute regression rule: 8,068 s of slot time, at least 22.4 min at 6 slots; `process.md` still lists 25 files and 1,040 s | `designs/process.md` 3, 3.1; `runs.jsonl` | 5 | a table; about 10 file merges | Merged files can hide order dependence; keep restart, crash and quota files apart | do now (table); before M6 (merges) | HR-TEST-3 (C) |
| 19 | HR-SYN-19 | m | Perf: `runWindow` is used by 13 of 37 scripts beside private loops (two can return zero samples); 20 window reads bypass `PERF_WINDOW_SCALE`, which README says scales every window; 14 more medians; `window` in two row shapes; many perf variables documented nowhere | `perf/_window.mjs:20-66`; `_m4.mjs:46`; `_m3-client.mjs:193,217`; `_long-session.mjs:266`; window reads listed in HR-DUP-6 | 2, 3, 4 | about 400 lines touched, about 20 files | Add a `runWindow` test first; windows that must outlast a restart, a timeout or a GC cycle (`history.restart`, `gc`, `journal`) take an explicit unscaled flag, or a quick smoke fails falsely; 7 rows change shape | do now | HR-TEST-7 (C), HR-DUP-6 (C; one finding, HR-VER2's counts) |
| 20 | HR-SYN-20 | m | Three template-key policies: the `m3-300` perf template (300 imported turns) is keyed by a hand-bumped version and can serve stale state; `WORKSPACE_VERSION` parsed by regex with a silent `'?'` fallback; a redundant extra hash with a stale comment; product provisioning carries about 110 lines of template code and a registered step that evaluates test fixture source | `test/template/index.js:142-177`; `scripts/provision-steps.js:83-103,446-571`; `scripts/provision-steps/50-m5-fixtures.js`; `perf/_m3-client.mjs:47`; `test/integration/_m4.js:72-95` | 2, 3, 5 | about 230 lines, 6 files | Every template id changes once (one rebuild, up to 9 min for the long chain); an `extraSteps` option must be part of the key | do now (ids); before M6 (provisioning) | HR-TEST-4 (C), HR-TEST-5 (C) |
| 21 | HR-SYN-21 | m | Hidden global state: `useKeyFile` sets `THIX_HARNESS_SECRETS_KEY` for every later supervisor, never restores it, and its teardown deletes the directory it still names; `THIX_HARNESS_SPIKES=1` also turns every integration file on, in parallel workers | `test/integration/_m4.js:100-106`; `perf/_m4.mjs:62-67`; `test/template/index.js:88-90` | 5 | about 60 lines, 8 files | The key file becomes an option of `spawnSupervisorChild` (its allowlist changes); the m2/m4 secrets and gateway integration files cover it | do with sealed writes (may be in hand) | HR-TEST-10 (C), HR-VER2 missed 1 |
| 22 | HR-SYN-22 | m | The state layout is guessed: the blob directory from `argv[3]`, the state directory by `dirname(dirname(...))` at three sites, the gateway independently of `impl/index.js` | `AH/blobs.js:145-160`; `AH/index.js:167-169,191-192`; `AH/gateway/index.js:126` | 1 | about 15 lines now | Keep both sink getter forms (`sinkOrUndefined`, `requireSink`): start-up code relies on the quiet one. The lasting fix is a core power (AR-SYN-28) | do now; core part with core step 4 | HR-HOST-5 (CS), HR-EDGE-8 (C) |
| 23 | HR-SYN-23 | m | Paths no product state reaches: ten `notBuilt` stubs (all parts always registered), M2 `typeof` seams, optional factory pool and settings, `site ?? 'adapter'`, ignored options, adapter "not yet" branches, an empty `channelTaps`; dead exports (5 used nowhere; 47 in the edge used by no other file) | `guest/session/session.js:273,283`; `tools/objects.js:158,194,205`; `inspection.js:148`; `mentions.js:135,177`; `prompt.js:97`; `export.js:85-96`; `factory.js:113-120`; `AH/live-service.js`; `AH/channel-taps.js` | 3 | about 200 lines, about 25 files | Tests that build a session with a parts subset or a factory without a pool need fakes; `m2-w27-session-export` fakes need `beginDelete`, `archive`, `base`. Keep `projectionHooks` (M8) | do with split (frees bytes) | HR-GUEST-3 (C), HR-DUP-12, HR-DUP-13, HR-EDGE-17, HR-HOST-15 |
| 24 | HR-SYN-24 | m | Usage arithmetic three times with two context rules (vat: whole reading plus the catalogue window, by design R4-33; adapter: field by field, capped); `journal-usage.js` and `transcript-records.js` are imported only by tests, while contracts say export and the projection use them | `guest/session/turn.js:107-113,965-994,1703-1712`; `guest/lib/token-usage.js:127-151`; `journal-usage.js`; `transcript-records.js`; `AH/projection.js:8` | 2, 4 | about 60 lines | The two modules are oracles: keep them; wire `usageOfRecords` into export or correct the contract rows. Importing `token-usage.js` into the session program costs bytes | do with M8 (context window) | HR-GUEST-5 (CS), HR-DUP-8 (CS) |
| 25 | HR-SYN-25 | m | The session channel and the list channel each implement the subscriber queue and rev reordering (60 repeated lines), both on `node:timers` directly; their `onClose` callbacks get text in one and a key in the other under one `CloseReason` name | `AH/channels.js:178-345,275`; `AH/list-channel.js:54,66-170,117` | 2, 4 | about 150 lines, 2-3 files | Share the subscriber only (gap and window rules differ); guard, exo name and closed shape are parameters (contract); channel bounds are perf-sensitive | do with the next feed (M11, M12) | HR-HOST-11 (C), HR-DUP-4 (CS), HR-VER2 missed 3 |
| 26 | HR-SYN-26 | m | Thirteen atomic file writers and four private `syncDirectory`, fixed `.tmp` scratch names, while the core's `writeTextAtomic` goes unused | table in `harness-duplication.md` 1.4 | 2, 5 | about 200 lines, 12 files | Most missing directory fsyncs are deliberate caches (context file, rebuildable manifest, superset audit log): keep the choice explicit, the kill-point step names and the `.tmp` cleanup; fsync on hot caches costs perf rows | do with sealed writes | HR-DUP-5 (CS), HR-HOST-10, HR-EDGE-2 |
| 27 | HR-SYN-27 | m | Small helpers repeated: `messageOf` about 23 times with three behaviours, six hand serial queues, a surrogate-safe cut 4 times, `ok`/`failed`/`readArgs`, `assertDescription` 3, `SERVICE_KEY` 2, one text twice; `describeError` and `makeSerialQueue` are already on every vat's and the adapter's `globalThis` through the core prelude | `packages/thixotrope/src/guest/prelude.js:58-59`; guest, adapter and UI sites in HR-GUEST-8, HR-HOST-10, HR-EDGE-12 | 2 | about 250 lines removed, about 30 files | `instanceof Error` is false across realms and CapTP: unify on the guarded `?.message` form or texts change. `turn.js` must import `NOT_RUN_TEXT` from `tools/exec.js`, not the reverse (cycle). The exec bundle is at its budget: shared guest helpers go in a module it already loads | do now (adapter, UI); with split (guest) | HR-GUEST-8 (C), HR-HOST-10 (CS), HR-EDGE-12 |
| 28 | HR-SYN-28 | m | The archive's `History` copies the vat's preview rules and three constants; its comment points at the wrong module | `AH/archive/history.js:24-52,280-345`; `guest/session/history.js:26-30,60-115` | 2 | about 80 lines removed, 3 files | Put the pure function in a guest module the session bundle already loads; history and export round-trip tests compare previews | before M8 (compaction) | HR-HOST-9 (C) |
| 29 | HR-SYN-29 | m | Tests are named for milestones and work units (178 of 196 files; 16 subjects split across milestones); 8 benches nothing runs; M0 spikes register placeholder passes; the default lane imports every gated file to skip it; `scripts/` mixes product and build tooling | `test/**`; `perf/frames.perf.mjs:28`; `test/spikes/`; `ava` `files` glob; `scripts/process-time.mjs` | 4 | one rename commit (about 190 files); config | Benches and test paths are cited as evidence in contracts and the journal: keep a rename map, move benches to `perf/` or mark them historical, never delete; a file in no lane is silently never run (add a check) | before M6 (convention); renames after lanes close | HR-TEST-9 (C), HR-TEST-12 (CS), HR-TEST-16, -19, -20 |
| 30 | HR-SYN-30 | m | ARCH is out of date in nine places the contracts changed (`open() -> TurnPorts`, `getTurnContent`, `ExecHandle.scope`, sign-in file, 240 KB session program, `SessionRow.state`, preset configuration, binary frames, union key guard) and has no glossary | `designs/architecture.md:286,416,419,440,444,458,484,510,999,1011-1012` | 4 | about 40 lines + a glossary section | None; the union guard is weaker than ARCH promises (any known key to any method): say so | do now | HR-ONTO-13 (C), HR-EDGE-11 (C) |
| 31 | HR-SYN-31 | m | "Seal" means both archiving (359 uses) and encryption (59); the sealed-writes work adds to the second | `guest/session/archive.js`; `AH/archive/*`; `AH/secrets/seal.js`; `interfaces.js:290,308,2241` | 4 | about 60 non-persisted identifiers | Keep persisted `sealedTo`, `sealedTurns`; rename `SealedText`, `SealRequest` with the next archive change | do with sealed writes (names in new code now) | HR-ONTO-7 (C) |
| 32 | HR-SYN-32 | m | Three vocabularies for one turn: `tool-result` and `tool-call` name a turn record and a transcript record of different shape, read and written in one function; live events spell `tool_result`; "transcript" has three senses | `guest/lib/interfaces.js:770-781`; `transcript-records.js:58,77`; `AH/projection.js:125,176` | 4 | about 30 lines, one table | Documentation and parameter names only; never rename persisted kinds | do now | HR-ONTO-1 (C), HR-GUEST-14 |
| 33 | HR-SYN-33 | m | Shared and overloaded words: session (hub session written 0 times), `Registration` (a start-listener handle), endpoint, lease (`ExecLease` leases nothing), delivery, journal (a UI panel), host, workspace; one subscription login has four names and "provider" three senses; "label" is a petname, a display name and a lookup key; attachment and endowment one shape written three times; epoch, generation, powers, key, token | HR-ONTO-6 table; `interfaces-m4.js:92,458`; `durable-subscriptions.js:244-249,424-428`; `interfaces-m5-factory.js:161`; `interfaces.js:1206-1212,1569,1748` | 4 | the glossary (section 6); about 80 local renames | Persisted label, member and row fields stay; `Registration` and `ExecLease` renames change installed or program bundles (with reinstall and split) | do now (glossary); with reinstall and split (renames) | HR-ONTO-6, -4, -8, -9 (C), HR-GUEST-13, HR-HOST-13 |
| 34 | HR-SYN-34 | m | Failures recognised by text where a field would do: Claude overloads by comparing M2's failure text (consistent today; breaks if `servedBy` gains fields), accounts-watch eviction by a text compared after CapTP while channels answer `{ closed, reason }` | `AH/subscriptions/messages.js:162-167,281-288`; `accounts.js:23-31`; `ui/src/accounts/feed.js:133` | 4, 5 | about 35 lines, 5 files | `AccountsBatch` is in `interfaces-m4.js` (gateway vocabulary); the UI must switch in the same change or stops re-watching; only browser tests catch a mismatch | do with split | HR-EDGE-4 (CS), HR-EDGE-5 (C) |
| 35 | HR-SYN-35 | n | `ws` is a dependency nothing imports, beside a hand-written server whose comment says the package does not depend on it; a received close code is echoed unvalidated, the reason not checked as UTF-8 | `package.json:52`; `AH/gateway/server.js:23-27,309-317` | 3, 5 | about 15 lines | Check the lockfile and that browser tests use the platform `WebSocket`; replacing the server with `ws` is larger and not proposed | do now | HR-EDGE-6 (C) |
| 36 | HR-SYN-36 | n | The factory counts its starts three times, each called "epoch" | `guest/factory/factory.js:142,495`; `delete.js:71,194`; `pool.js:179,461` | 2, 4 | about 20 lines, 3 files | Increment before the pool and deletions read it (interruption counting); three tests drive `onStart`/`resume` directly and need a counter fake | do now | HR-GUEST-7 (C) |
| 37 | HR-SYN-37 | n | The product has three names: Floot (persona, a word-for-word parity port), Familiar (client, spec), thix (CSS prefix beside `floot-`, formats) | `guest/lib/prompt-sections.js:15-55`; `ui/src/net/connection.js:155`; `ui/src/main.js:25-26` | 4 | glossary; CSS about 600 sites if done | The persona text is compared word for word with Fae; storage keys and the subprotocol break drafts and handshakes | leave (glossary line; owner decides CSS) | HR-ONTO-3 (CS) |
| 38 | HR-SYN-38 | n | `yarn test:browser` with no file argument runs the integration suite and no browser test | `package.json:40`; `scripts/test-integration.mjs:60-67` | 5 | about 10 lines | Keep `test:integration`'s defaults | do now | HR-TEST-6 (CS) |

### 3.2 Where verification changed the fix

The verifiers corrected these fixes; the original would break something.

- **HR-GUEST-1** (HR-SYN-4): `runner.deleting` has a test user; change the test to assert behaviour.
  Hiding `unresolved` must keep its `maxUnresolvedTurns` bound.
- **HR-GUEST-2, HR-DUP-7** (HR-SYN-1): `m5Widenings` is read by `PresetSnapshot`; the views reach
  22 product files including the adapter, not 6 exo sites. Do the work inside the split, not beside
  it, and measure the exec bundle before dropping its copy.
- **HR-GUEST-3** (HR-SYN-23): the `typeof` fallbacks in `export.js` are what the M2 export test
  fakes run on; give the fakes the members before deleting the fallbacks.
- **HR-GUEST-5, HR-DUP-8** (HR-SYN-24): the catalogue-window override is intended (R4-33);
  `journal-usage.js` and `transcript-records.js` are contract-required oracles. Do not delete them.
- **HR-GUEST-8** (HR-SYN-27): the proposed import would create a cycle; `turn.js` imports the text
  from `tools/exec.js`. No reviewer drew the import graph of `guest/session` before proposing a
  shared helper; check direction first.
- **HR-HOST-1** (HR-SYN-2): the fix is the costly change it warns about; batch it with every other
  manager change. The two `Backend` makers merge only with a kind hook.
- **HR-HOST-3** (HR-SYN-10): the Composer can pre-check before staging; no contract change needed.
- **HR-HOST-5** (HR-SYN-22): `ephemeral.js` reads `argv[1]` for the code root, not the state; the
  three sink getters differ on purpose (keep a quiet and a throwing form).
- **HR-HOST-6** (HR-SYN-9): failing the bind on a sweep error breaks every session; block
  `reserve` instead.
- **HR-HOST-7** (HR-SYN-2): split facets must be re-fetched after a retired break.
- **HR-HOST-10** (HR-SYN-27): the `messageOf` copies differ in behaviour (realms, CapTP). The
  synthesis adds: no core export is needed, the prelude already provides `describeError` and
  `makeSerialQueue` (`packages/thixotrope/src/guest/prelude.js:58-59`) [read].
- **HR-HOST-12** (HR-SYN-13): removing `logPath` is a manager change; persisted specs would fail the
  new guard.
- **HR-EDGE-4**: minor, not moderate (both sides build the text from the same functions).
- **HR-EDGE-7** (HR-SYN-15): `extras` and `services` are M3 contract (F.2 d); amend the contract.
- **HR-EDGE-10** (HR-SYN-6): the internal `activeSession` takes a key; expose a no-argument one.
- **HR-TEST-1**: moderate, not major; most of the test-to-perf direction is one emitter.
- **HR-TEST-7, HR-DUP-6** (HR-SYN-19): one finding filed twice with different counts; some windows
  must not scale.
- **HR-TEST-8** (HR-SYN-16): drain round counts may be tuned to crank depth; keep a parameter.
- **HR-TEST-12** (HR-SYN-29): the benches are cited evidence; move or mark, do not delete.
- **HR-DUP-4** (HR-SYN-25): the close-reason claim was backwards; both store a key, and one passes
  text to `onClose`.
- **HR-DUP-5** (HR-SYN-26): the durability gap is much smaller than five writers.
- **HR-ONTO-3** (HR-SYN-37): the "You are Floot ... inside the Endo daemon" text is a parity port.

### 3.3 Not verified, and cannot tell

**Checked by no verifier.** Merged into a row above where they overlap. The rest, all minor unless
marked; the synthesis re-read the first two and they hold:

- HR-HOST-16 (**moderate now**): the per-session blob view spreads the whole store, so a tool given
  "this session's store" can `readKey`, `discard` or take an unowned `writers` for any session
  (`AH/index.js:232-241`) [re-read]. Harmless while tools are adapter code; it matters for the
  in-flight "adapter tools to the model" change, which should build the view as an explicit object.
- HR-GUEST-12: the factory's start-listener registration failure is swallowed (`() => undefined`,
  `guest/factory/main.js:92-101`) and nothing reports it [re-read]; report it in `status()`.
- HR-GUEST-10 (five hold reasons, one produced; a dead fallback holds `stopped` for deletion),
  HR-GUEST-15 (archive sealing stops after 4,096 segments, a lifetime cap that turns retained growth
  back on: do with M13), HR-GUEST-16 and HR-ONTO-17 (949 milestone references in guest comments,
  stale ones; `H-5` names two hooks).
- HR-HOST-13, -14 (merged in HR-SYN-33, -3).
- HR-EDGE-14 (two secret audit paths with two bounds: with the reinstall), HR-EDGE-15 (slot
  aliases), HR-EDGE-18 (provider code over seven files: leave until a third provider).
- HR-TEST-13 (a `test.failing` whose guard cannot surface), HR-TEST-14 (the unit lane needs the
  release worker), HR-TEST-15 (pid modulo 100,000 in build directory names), HR-TEST-17 (perf reads
  the core's on-disk layout: do with core step 3), HR-TEST-22 (merged in HR-SYN-14, plausible).
- HR-ONTO-5, -10, -11, -12, -14, -15, -16, -18 (names; folded into the glossary, section 6).
- HR-DUP-9 to -16 (merged in HR-SYN-17, -23, -27 and -16).

**Cannot tell from the code alone.**

- Whether the core ever rebinds the agent-host service key in a live adapter incarnation (the
  double count in HR-SYN-9 depends on it).
- Whether "Provider" (the backend selector label) and the "Turn journal" panel title are fixed by
  the spec (R6-51 was not read).
- Whether the gateway's union key guard is acceptable to the owner (HR-SYN-30): it is the right
  engineering choice for the vat's name budget and weaker than ARCH's promise.
- Whether native-resource bundles strip comments as guest bundles do (comment-only renames in
  `durable.js` may still cost a reinstall).
- How many tests go red when the fakes are built on the real guards (HR-SYN-14).

---

## 4. Themes

Seven root causes explain most findings. Each names what in the way the harness was built caused
it, so the process for M6-M13 can change.

**T1. The contract was the unit of construction, and the merge kept every contract.** Each lane
built against a written contract and was forbidden to edit another lane's tables (D-M5-5: "M5 adds
no interface to `interfaces.js`"). So each lane added its own table, view, widening, limits file,
hook table, directory registry and `notBuilt` stub, and the merges kept them all. M5's W5.9 asked
for "no `notBuilt` stub left" and the stubs are still there: no check enforced it. *Explains*
HR-SYN-1, -7, -15, -23, and part of -2 and -6. *Process change:* every merge of a parallel group
ends with a **fold unit** whose done-criterion is deletion (views, widenings, stubs, empty
registries), checked by a grep in the lint lane, not by a sentence in a contract.

**T2. A later lane could not edit the earlier lane's module, so it copied it.** Ownership was by
path. When M4 needed M2's catalogue paging, M1b the session channel's subscriber, or M5 the
inventory pager, the helper was not exported, and the cheapest legal move was a copy. The copies
then drifted (catalogue body limits, close-reason types, crash regexes). *Explains* HR-SYN-3, -17,
-25, -26, -27, -16, -19, -28. *Process change:* "export a helper from another lane's module" is a
small allowed edit with the owner's review, and the duplicate finder
(`designs/arch-review/tools/find-duplicates.mjs`) runs in the lint lane with a ceiling at today's
3.9 % that may only go down.

**T3. The milestone is used as a name.** Files, exports, types, test files, helpers, comments,
runtime directory tags (`w48-`) and journal ranges carry the milestone or work unit, because names
were the merge-avoidance registry (`milestones.md` "Conventions"). The milestone is a date, not a
concept: a reader must know when a thing was built to find it. *Explains* HR-SYN-1, -29, -33 and
the stale comments. *Process change:* name by vat or concept; test files by subject; milestone ids
only in contracts, journal and commit messages. Change the conventions section before M6, which
otherwise prescribes `H/test/*/m6-*`.

**T4. Names and texts at the seams instead of objects and fields.** The harness side of the core's
own theme: the Composer reads error texts to decide a file's fate, overloads and watch eviction are
texts, the vocabulary is found by file name, the state directory by `argv`, a log file by a path in
a durable spec, pools and built-in presets by label, pages by position. Each works today and breaks
silently when a text, a file name or a list changes. *Explains* HR-SYN-7, -10, -11, -13, -22, -34,
and the label sense of -33. *Process change:* a contract review question, "what here is a string
that stands for an object, a reason or a position?"

**T5. Fakes built to the contract text, not to the code.** UI fakes are hand objects, the session
fixture re-assembles the program, the scripted provider is a second round engine, two fakes break a
lease with a wrong text, and product code keeps branches only tests take (optional pool,
`prepare`-less providers, sweep errors swallowed "for tests"). Tests then pass on paths production
does not take. *Explains* HR-SYN-3 (b), -9, -14, -23. *Process change:* fakes are built from the
real guards (`makeExo` with the interface), assemblies are exported from the product, and a product
branch labelled "for tests" is a review failure.

**T6. The durable boundary eroded by appending.** D-14 made the manager part small because a
reinstall breaks references. But the manager part was a hotspot every milestone had a seam in, and
the cheapest place to put a provider quirk was next to the identity it concerned. *Explains*
HR-SYN-2, -11, -13, HR-HOST-8's retry. *Process change:* a manager-part change needs a reason why it
cannot live in the adapter, and manager changes are batched once per parallel group.

**T7. Closures that grow.** The turn runner, the UI controller, `makeArchiveStore` (1,237 lines)
and the account and catalogue modules grew one job per milestone, as the core's hub and daemon did
(core T1). The extension seams offered no place for per-session or per-connection state, so it went
into module-level `WeakMap`s. *Explains* HR-SYN-4, -6, -15. *Process change:* when a contract adds
a job to an existing closure, it names the module the job lives in.

---

## 5. Proposed order of work

Five steps, each one coherent change with its tests. Steps 1 and 2 can start today; step 2 is the
split already running in the other worktree. Step 4 aligns with the core's step 4 (see
`README.md`). The plan items (scripted provider on the shared round, the controller split, HKDF
subkeys) come after these and alone.

**Step 1. Correctness and guards, no format, bundle or manager change.** HR-SYN-7 (an explicit list
of interface tables for the vocabulary, and a test that the real directories load with zero skips;
land before the split merges), -9 (one sweep per incarnation sets the quota count; `reserve`
refuses until it has), -10 (Composer pre-check; one retired-break rule), -12 (`unexpectedFailure`
required), -22 (state directory computed once), -35 (`ws`, close codes), -36, -38, the swallowed
start-listener failure (HR-GUEST-12), -19 (a `runWindow` test, then every window through
`windowMs` with explicit unscaled windows), -20's template ids, -18's table, -30 (ARCH and its
glossary) and -32/-33's glossary (section 6). Tests: the zero-skip vocabulary test; a blob store
started over existing files and bound twice; Composer refusals that never stage; an unknown backend
kind refused at registration; `runWindow` and `defaultFiles` cases. *Gains:* the split cannot
narrow the gateway silently; the daemon quota means what it says; every milestone from M6 has a
perf scale knob that actually time-boxes its checks.

**Step 2. Fold the contracts, inside the per-vat split (in hand).** HR-SYN-1 (one table per vat and
one shared, latest version under its plain name, one helpers module, one naming rule written into
`milestones.md`), -23 (stubs, seams, dead exports; a missing part is a construction error), -27's
guest helpers, -34 (the `AccountsBatch` field and the UI in one change), the non-persisted renames
of -31 and -33 (`SealedText`, `ExecLease`). Tests: the interface contract tests rewritten against
the vat tables; the exec and session bundle sizes measured (`perf/creation-m5`). *Gains:* bytes in
the session program for M6's environment tools and M8's compaction; M6-M13 add guards to a vat's
table, not a seventh milestone table.

**Step 3. Session and adapter structure.** HR-SYN-4 (ports, outbox and archive out of the turn
runner), -15 (per-session state as runtime parts, one `enqueue`, hooks receive the runtime), -3 (a)
(`makeApiProvider`, `providers/event-log.js`, `BackendKind.catalog`, `prepare` required), -17 (one
catalogue core with per-catalogue bounds), -28 (one preview function), -24 (one usage rule, written
in m2-interfaces 12), -8 and -26 with the sealed-writes work (idempotent store writes with a fault
hook test; one atomic-write helper keeping the kill-point steps), -5 (a) (one wrapping-key object),
-21 (the key file as a spawn option). Tests: the `m1a-session*`, `m1b-qc` and `m2-w25-archive`
crank-order suites; provider adapter tests against the fake servers; catalogue page and cursor
tests; a kill between apply and answer for secret writes. *Gains:* M6's `onCancel` (stop the
environment) and services become runtime parts with visible state; M7's egress and M8's images
land in one provider shell; M8's compaction lands in the archive and context modules, not inside a
1,560-line closure.

**Step 4. One agent-host manager reinstall.** HR-SYN-2 (policy to the adapter, one `Backend`
maker, ops facets by family, construction order), -11 (pagers by serial, strict cursor parse), -13
(`logPath` out of the spec, the probe injected), the `Registration` rename (-33), the audit path
(HR-EDGE-14). If the core's shipped-source bump with the native service shape (AR-SYN-28) is ready,
take it in the same reinstall so the agent host also drops its fake service key and its directory
walk (HR-SYN-22's lasting part). Tests: `m4-manager`, `m4-effort`, `m4-pools`, `m4-catalog`,
`m2-w23-manager`, the rewritten ops-guard test, a delete-between-pages case. *Gains:* M6 and M10
add their own native resources beside a small manager; M13's W13.2 migration starts from a manager
that changes rarely, as D-14 intended.

**Step 5. Tests, fakes and UI seams, and the conventions for M6.** HR-SYN-16 (`test/support/` with
behaviour names, one served-state model, perf on top of it), -14 (fakes on the real guards,
`makeSessionCore`, `HUB_RETIRED_MESSAGE`), -6 (a) (per-connection cache and subscribe on
`FeatureContext`, the chip's accessor), -29 (subject-named tests with a rename map, benches moved or
marked, one lane list per file), -18's file merges, and the process changes of section 4 written
into `milestones.md` and `process.md` (fold unit at each merge, helper exports allowed, duplicate
ceiling in lint, naming rule, fakes from guards, manager changes batched). Tests: the whole unit,
adapter and integration lanes; a check that every test file is in exactly one lane. *Gains:* every
later milestone; M11 and M12 UI features get state without `WeakMap`s; the regression run fits the
20-minute rule again.

---

## 6. Glossary proposal

The 50 terms of `harness-ontology.md` section 5, reconciled with the core's glossary (`core.md`
section 6) and with the other harness reports. Bold is the word to use; brackets name words to
avoid. Persisted names (`sealedTo`, `epoch` in `context.jsonl`, `label`, `members`,
`readings.json`, `familiar.*`, tool argument names) are not renamed: the glossary fixes definitions.
Changes from HR-ONTO's list are marked.

**Places and parts.** **harness**: the server in this package (factory, session and exec vats, the
agent-host native resource) [not: Floot, Familiar]. **Familiar**: the browser client (spec);
**Floot**: the persona the model is told it is; neither names a component. **operator**: the owner,
who holds `Operator`. **factory**: the installed vat with the session index, presets, inventory and
spare pool. **session**: one agent conversation, one session vat; the core's sense is always
written **hub session** in harness text. **session vat / exec vat / spare**. **exec scope**: the exec
vat's persistent bindings (`ExecHandle.scope()`). **agent host**: manager vat plus **adapter** (the
core's sense: one Node process per **adapter incarnation**); its facets are `AgentHostAdmin` and the
**session host facet**. **gateway** and its **bridge**. **start count** *(adopted from HR-GUEST-13)*:
how many times the factory's start listener ran [not: epoch]. **listener handle** *(changed)*: what
`onStart` returns [not: Registration, which is the core's native-resource registration].

**Turns.** **turn**; **round**: one model request and the calls it asks for [not: step, tool
round; the limit becomes `maxRounds`]; **attempt**: one try of a round by a provider module or a
pool member; **turn generation**; **turn endpoint** (`Endpoint`) [not: endpoint, the core's host
endpoint]; **turn lease** (`holdTurn`) [not: lease, the core's engine lease; `ExecLease` becomes
`ExecScopeInfo`]; **ports** (`TurnPorts`); **sink**; **retired break**: from an adapter object a
restart, from a guest vat that the vat is **lost** (core: a typed break once AR-SYN-9 lands).

**Records and streams.** **turn record** in the **record log**; **transcript record**: the
projection's output ("transcript" means this format only); **context projection**, **context
cache**, **context epoch** *(the fourth epoch; distinct from the core's session epoch)*; **native
context** (carried as `providerContext`); **archive** (verb and noun, segments) [not: seal];
**archived ref** *(changed: HR-HOST-13 proposed `SealedRef`, which conflicts with "seal" for
encryption)*: the `{ key }` stand-in for a blob in archived records; **history page**; **live
event**, **delta**, **snapshot event**, **fold**; **live delivery** [not: delivery, the core's
journal-frame-into-engine]; **channel** (the adapter's stream), **publisher** (the vat's handle),
**subscription** (a viewer's handle; `Accounts.watch` becomes `subscribe`), **watch** (the
snapshot read) *(decided: HR-EDGE-16 proposed "watch" for feeds and HR-ONTO-4 reserved
"subscription" for the plan; the existing `Live.subscribe` and `Session.watch` settle it, and the
plan is written **subscription plan** in prose)*.

**Input.** **submission**, **request id**, **receipt**; **queue entry** ("queued message" to the
user) [not: pending row, waiting entry, queue item]; **hold**; **Composer** (the gateway service)
and **composer** (the input box); **draft**.

**Backends and secrets.** **backend** of a **backend kind** (`scripted`, `openrouter`,
`anthropic`, `claude-pool`, `codex-pool`); **provider**: the vendor behind a kind, its code a
**provider module** [not: a backend; the UI selector label waits on the spec check]; **pool**;
**member**: a pool's entry for one login, with its **credential** (the Secret's JSON) and its
**account reading**; **Secret**, **read grant**, **SecretWriter**, **sealed box** ("seal" means
encryption only); **store key** `k<n>`, **blob file key** `b<n>`, **archive key** `h<n>` (distinct
from the **history cursor** `h<n>`), **API key** *(adopted from HR-HOST-13)*; **wrapping key**: the
one key behind the store, the audit log, the sign-in file and the sealed boxes; **sign-in secret**:
the gateway's password, in its own file.

**Objects, tools and presets.** **label**: a session's name for an object (its petname) [not: a
display name, not a key]; **title**: a display name; **pool name** and **built-in id** for the two
keyed uses; **attachment**, **package** (one message's attachments, open for its turn; not M9's
mail package, which needs its own word), **endowment** (same `LabelledObject` shape); **inventory**;
**powers**: the per-call object model code receives, and `GatewayPowers` [not: an options bag, which
is **options** or **deps**]; **tool** by **site**: adapter tool, granted tool, object tools, exec
tool; **tool grant**; **preset**, **preset snapshot**, **preset template**, **template object**;
**state template**: a prepared state directory for tests [not: template alone].

**Shared with the core, kept in the core's sense.** vat, worker, incarnation, crank, delivery,
journal, snapshot ("heap snapshot" in harness prose), hub, hub session, session epoch, host,
host endpoint, native resource, manager, adapter, launcher, registration, installation, workspace
(one user's vat; M6's per-session directory is a **git workspace**, as the object kind already
says), retire/forget, durable/ephemeral/transient. In the harness, "the UI's Turn journal panel"
becomes "Turn records" if the spec allows.

---

## 7. What this review did not cover

- No test, lane, build, bundle or supervisor was run by any unit. Correctness items are confirmed
  by reading; HR-SYN-8's interleaving and HR-SYN-9's double count are inferred. Byte savings come
  from J-9933, not from a build.
- Correctness of `exec/membrane.js`, `exec/inspect.js`, the grant states, factory presets and
  inventory, `subscriptions/pool.js` selection, `pool-state.js` coalescing and `renewal.js` timing
  against their contracts; `projection.js`, `sse.js`, `http.js`, `retry.js` were skimmed.
- Whether each of the about 1,200 tests asserts what its title says (sampled only); the UI fakes
  and browser tests were mapped, not reviewed; `scripts/run-lock.mjs`, `export.mjs` and
  `subscription-login.mjs` for structure only.
- UI rendering, CSS, accessibility; fuzzing of the WebSocket parser; a CSP test.
- The spec text (`endo-harness-spec.md`): where a word or text is called spec-fixed, the code's
  citation was trusted.
- Perf numbers and budgets.
- About thirty minor findings that no verifier checked (section 3.3); re-read before acting.
- The integration workflow's in-flight changes (split, sealed writes, adapter tools) were not read;
  findings say where they may already be in hand.
