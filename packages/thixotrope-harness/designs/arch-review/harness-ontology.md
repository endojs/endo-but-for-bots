# Architecture review HR-ONTO: ontological consistency of the harness

Unit: HR-ONTO (question 4, across the whole of `packages/thixotrope-harness`).
Started 2026-11-18T12:52:57Z; the end time is in journal entry J-9994.
Read-only review of the snapshot on branch `claude/thix-arch` (merge `bd9a8ec070`). No source,
test or config file was changed and nothing was run except grep and small counting scripts.

Paths are relative to `packages/thixotrope-harness/` unless they start with `packages/`.
Abbreviations: ARCH = `designs/architecture.md`; M1a..M5 = `designs/m1a-interfaces.md` ..
`designs/m5-interfaces.md`; AR-ONTO = the core's ontology review (`core-ontology.md`), whose
glossary proposal this report extends; HR-GUEST and HR-HOST = the harness area reports written
today (`harness-guest.md`, `harness-host.md`).

How each claim was established: **[read]** I read the code or text at that place; **[measured]**
a script counted it; **[inferred]** a conclusion not checked by running anything. Counts come from
a case-insensitive `(?<![A-Za-z])TERM` scan run outside the repository over `guest/`,
`resources/`, `ui/src/` (vendor excluded), `scripts/` with `config/`, `test/` and `perf/`, and
over ARCH and each contract. A count is occurrences, not meanings; short stems also match longer
words. Read counts as scale only.

**Already reported by the area units, not repeated here** (this report adds only the cross-cutting
part): the interface tables in several versions (HR-GUEST-2, HR-HOST-17; the integration workflow
is splitting `guest/lib/interfaces.js` per vat), "epoch", "generation" and "powers" in guest code
(HR-GUEST-13), event against record spellings (HR-GUEST-14), `enqueueMessageOnce` (HR-GUEST-6),
the factory's three start counters (HR-GUEST-7), milestone narration in comments (HR-GUEST-16),
"key", "token" and "epoch" in the adapter (HR-HOST-13), the ops facet's dispatch styles
(HR-HOST-7).

---

## 1. What is good and should be kept

- **Closed vocabularies are written once and enforced** [read]. Every record that crosses into a
  vat has a closed `M.splitRecord` shape (`guest/lib/interfaces.js:72-79`), turn states, settled
  statuses, phases, activities, lifecycles and hold reasons are closed `M.or` sets
  (`interfaces.js:648-668`), and the gateway derives its key vocabulary from the same shapes
  (`resources/agent-host/impl/gateway/vocabulary.js`, M3 6.3) instead of a hand list. For a
  question-4 review this is the best possible base: a new word cannot slip into a wire record
  without a contract edit.
- **Fixed texts are tables with their source** [read]. `texts` and `textOf`
  (`interfaces.js:148-340`), `m4Texts`, `uiTexts` and the M5 tables cite the spec item or Fae line
  each text comes from, so a reader can tell a spec-fixed word (which must not be "fixed") from a
  harness word.
- **One predicate for "the callee is gone"** [read]. `guest/lib/retired.js` matches the hub text
  exactly, in one place, and its header states why the text cannot discriminate (restart against
  lost vat). Keep it.
- **"Adapter" is used in the core's one sense** [measured]. Of the collocations sampled ("the
  adapter" 115, "agent-host adapter" 17, "adapter tool(s)" 6, "adapter incarnation" 3), only one
  site uses another sense ("provider adapter", `resources/agent-host/impl/projection.js:10`).
  "Adapter incarnation" is used as AR-ONTO-1 proposes (27 sites in `resources/`, 12 in `guest/`).
- **"Sink" has one meaning** [read]: an object a vat holds and an adapter reports into
  (`TurnSink`, `AgentHostSink`, `GatewaySink`). **"Staged text"** has one shape
  (`StagedText`, `interfaces.js:1715-1723`) and one predicate (`guest/session/staging.js:7`).
- **End-of-life verbs mostly say what they do** [read], and should stay distinct:

  | verb | object | meaning |
  |---|---|---|
  | cancel | `Turn`, `QueueEntry`, `Registration` | stop something not yet done |
  | abandon | `ExecScope` | stop waiting; the code may still run |
  | abort | `BlobWriter`; live event `abort` | discard a partial result |
  | retire | `ExecHandle`, `PoolMember`, pool | end for good; the object stays and refuses |
  | revoke | `Secret` | stop future reads; the entry stays |
  | delete | `Secret`, `Preset`, `deleteSession` | remove the record (and its files) |
  | withdraw | `ToolGrant` | stop offering a granted tool |
  | remove | `InventoryEntry`, object tool `remove` | unbind a label |
  | release | `releaseTurn`, `releaseBlobs`, `releaseArchive` | let go of a held resource |

  Two blemishes only: the event `abort` reports a `failed` turn (HR-GUEST-14), and the core
  uses "cancel" for a native registration while the harness `Registration` is something else
  (HR-ONTO-6).
- **Persisted formats carry format tags** [measured]: seven `FORMAT` constants
  (`thixotrope-harness-segment-1`, `-manifest-1`, `-context-1`, `-readings-1`, `-signin-1`,
  `thix-secrets-1`, `thix-secrets-audit-1`), so a later rename can be a versioned migration.
- **Comments are stripped from guest bundles** [read] (`scripts/bundle-guest.mjs:118-131`
  `stripComments`). Renames in comments cost no bundle digest change. Whether native-resource
  bundles (`durable.js`) are stripped too was not checked [inferred: they go through the core's
  `thix install-native`].

---

## 2. Vocabulary table

ARCH has **no glossary section** [measured: no "glossary" or "vocabulary table" in any file under
`designs/`; the only glossary is AR-ONTO section 5]. The ARCH column below is therefore the word
ARCH's sections 2-4 use. Counts are guest / resources / ui / scripts+config [measured].

| concept | ARCH | contracts (m1a..m5) | code: identifiers, files, persisted, UI | divergence |
|---|---|---|---|---|
| one agent conversation | **session** (237), "conversation" 1 | session | `Session` exo, `session/` (761 / 608 / 207 / 140); UI dir `ui/src/conversation/` (43 "conversation" in ui); default title `'New chat'` (`guest/factory/session-options.js:25`, persisted in every session config); UI "New session", "Sessions" (`impl/gateway/contract-m3.js:169-173`) | Session in code, conversation in UI views, chat in the stored default title. Core "session" is the hub session (HR-ONTO-6). |
| processing one input | **turn** | turn; "agentic turn" (`guest/lib/turn-engine.js:62`) | `Turn`, `turnId` (364), `TurnRecord` | consistent |
| one model request and its calls | **round** | round | `RoundRequest`, `maxToolRounds` ("Model rounds per turn", `guest/lib/limits.js:89-90`); model text "tool-step limit" (`interfaces.js:153`, R4-47) | round, tool round and tool step (HR-ONTO-12) |
| one HTTP try of a round | - | "attempt" (M2 8.2) | `withRetries({ attempt })` (`impl/providers/retry.js`); pool "one attempt per member per round" (`durable-subscriptions.js:418`) | consistent; two scopes of retry share it |
| a crank in a vat | crank | crank | model text "per-step compute budget" (`interfaces.js:218`) | step = crank there (HR-ONTO-12) |
| what a session keeps per step | turn records | record, `TurnRecord` kinds `turn-started` .. `turn-resolved` | `records.js` "record log"; kinds and letters (`interfaces.js:311-320`) persisted in segments | consistent within the vat |
| what the model sees | context projection | transcript records | `transcript-records.js` kinds `message`, `tool-call`, `tool-result`, `compaction`, `native-context` (`:57-80`); persisted in `context.jsonl` | `tool-call`/`tool-result` name a different record shape than the turn record of the same kind (HR-ONTO-1) |
| what a viewer sees | live events (ARCH 4.2) | `VatEvent` types `turn-start`, `tool_call`, `tool_result`, `final`, `end`, `abort`, ... | `interfaces.js:1019-1059`; `DeltaEvent`, `SnapshotEvent`, `Delivery`, `LiveBatch` | third spelling for the same steps (HR-GUEST-14, HR-ONTO-1) |
| "transcript" | "transcripts are never deleted" = the session's records | - | `transcript-records.js` (projection format); `ui/src/conversation/transcript.js` (messages for display) | three senses (HR-ONTO-1) |
| older turns kept out of the vat | record archive | archive, segment, seal, sealed | `seal`, `sealedTo`, `sealedTurns`, `SealedText` (359 uses with "seal" in archive code); user text says "archived" (`interfaces.js:290`) | "seal" also names encryption (HR-ONTO-7) |
| reading old turns | history page | `getHistoryPage`, `History.page` | cursor `h<n>` (`guest/session/history.js:164`) | `h<n>` is also the archive key (HR-ONTO-11) |
| a model's opaque replay data | native context | `nativeContext` | `nativeContext` in records (39), `providerContext` on transcript messages (22), kind `native-context` | two field names across the projection [read] |
| model's window | - | `contextLength` (M2) | `contextLength` 15/40/0, `ContextReading.windowTokens` 23/0/4, UI "ctx" | HR-ONTO-14 |
| text waiting to be sent | queue, submission, receipt | `QueueEntry`, `PendingRow`, `PendingView`, "waiting entry" (M1a 6) | `QueueItem` (`guest/lib/pending-queue.js:82`), `maxWaiting`, `queuedCount`, UI "queued message", `Queue.js`; browser `drafts.js` | HR-ONTO-16 |
| gateway submission service | Composer | `Composer.submit` | `impl/composer.js`; UI `Composer.js` (the input box), slot `composer.addon` | two senses, harmless [read] |
| what a session talks to | backend | `Backend`, `BackendKind` | `backend` 244/314/138; UI label "Provider" (`ui/src/presets/texts.js:33`) | HR-ONTO-4 |
| who serves a backend | provider | provider (API), Provider (M4: `claude`, `codex`) | `impl/providers/` (API modules), `Provider` shape (`interfaces-m4.js:92`) | three senses (HR-ONTO-4) |
| one subscription login | - | member, account, credential (M4) | `PoolMember`, `MemberAccount`, `Accounts`, `SubscriptionsAdmin`, `impl/subscriptions/`, UI "Subscriptions" panel, `credentials.js` | four names (HR-ONTO-4) |
| a stored secret | Secret | `Secret`, `ReadGrant`, `SecretWriter`, sealed box | `Secret`, store key `k<n>`, `secrets.enc`; sign-in secret in `signin.enc`; URL fragment `agent=<secret>` (`ui/src/net/fragment.js:4`) | ARCH places the sign-in secret in the Secrets store (HR-ONTO-13) |
| permission objects | grant | `ReadGrant` (M2), `ToolGrant` (M5) | 108 `grant`; `keyGrant` | two qualified kinds, consistent when qualified |
| tools offered to the model | tool table, adapter tool | adapter tool (21), granted tool (16), object tools (8), built-in (3), exec tool | `site: 'adapter' \| 'guest' \| 'session'` (`guest/session/tool-table.js:10-26`) | "built-in" includes the round's adapter tools (`tool-table.js:31-33`): a reader of "built-in" thinks "static" [read] |
| objects given to code | powers (rule 12.13) | powers | exec `powers`, `GatewayPowers`, JSDoc `powers` bags | HR-GUEST-13 |
| a session's name for an object | label map | label, `EdgeLabel`; model: `petName` | `label` 519/196/267; `petName` 86; `edgeName` 18 | label also means display name and key (HR-ONTO-8) |
| objects sent with a message | - | attachment, package, mention | `Attachment`, `packages.js`, `mentions.js`, UI chips; model `messageNumber`, `edgeName` | HR-ONTO-9 |
| objects a preset gives | endowments (F.1 #4) | endowment | `Endowment: () => m5Shapes.Attachment` (`interfaces-m5-factory.js:161`); UI "Default objects" | same shape as attachment (HR-ONTO-9) |
| session recipe | preset, preset snapshot | preset, template, template object | `presets.js`, `preset-catalog.js`, `preset-templates.js`; UI "Assistant presets", "Template" | "template" has three senses (HR-ONTO-10) |
| harness tuning | settings (`configure`) | settings, limits, defaults | `limits` (guest), `limits` (config), `m4Limits`, `limitsM5`, `subscriptionDefaults`, `HarnessSettings` | HR-ONTO-2 |
| the human owner | operator | operator | `Operator` (44), "Operator acknowledgment" (UI) | consistent |
| privileged facets | admin | `AgentHostAdmin`, `SecretsAdmin`, `SubscriptionsAdmin`, `GatewayAdmin` | factory parameter `host` = `AgentHostAdmin` (`guest/factory/main.js:41-44`); session `host` = `SessionHostFacet` (`guest/session/session.js:65`) | HR-ONTO-6 |
| text behind a handle | Blob, staged text | `Blob`, `StagedText`, `Content`, `SealedText` | consistent | keep |
| turn-scoped adapter objects | Endpoint, TurnPorts | `Endpoint`, `TurnPorts`, `ArchivePort` | "ports" | `Endpoint` collides with the core's host endpoint (HR-ONTO-6) |
| HTTP/WS front | gateway | gateway, bridge | `impl/gateway/`, `bridge.js` | consistent |
| live streams | channel (D-8) | `Live.subscribe`, `subscribeList`, `Accounts.watch`, `Session.watch` | channel 108, feed 67, publisher 66, subscription 92 | HR-ONTO-15 |
| product name | "harness" | "Familiar" (M3:211, R6-8) | Floot, Familiar, thix (HR-ONTO-3) | three names |

---

## 3. Findings

### HR-ONTO-1 (moderate, question 4b and 4d) `tool-result` and `tool-call` each name two different record shapes, and "transcript" names three things

- **Where** [read].
  - The session's `ToolResult` record is `{ kind: 'tool-result', opId, result, ... }`
    (`guest/lib/interfaces.js:770-781`, written at `guest/session/turn.js:552`).
  - The transcript record of the projection is `{ kind: 'tool-result', id, content, failed? }`
    (`guest/lib/transcript-records.js:58`, `:77`).
  - `resources/agent-host/impl/projection.js` reads the first (`case 'tool-result':` at `:125`)
    and writes the second (`kind: 'tool-result'` at `:176`) in one function. The providers read the
    second (`impl/providers/anthropic.js:293`, `openrouter.js:201`,
    `impl/subscriptions/responses.js:296`); the archive reads the first
    (`impl/archive/history.js:307`). The same holds for `tool-call` against the record kind
    `tool-intents`, and the live event spells it `tool_call` / `tool_result`.
  - "Transcript" means the session's records in ARCH ("transcripts are never deleted", D-17), the
    projection format in `transcript-records.js`, and the display messages in
    `ui/src/conversation/transcript.js`.
- **Why it misleads** [inferred]. A function that is handed the wrong one of two records passes a
  `kind === 'tool-result'` test and then reads `undefined` fields. Both are persisted: turn
  records in segment files (with the kind letter `t`, `interfaces.js:317`), transcript records in
  `context.jsonl`. HR-GUEST-14 covers events against turn records; the third vocabulary is the
  one that collides by exact spelling.
- **Fix.** Do not rename persisted kinds. Add one table to M1a (or ARCH 4.5) that maps the three
  vocabularies step by step (turn record kind, transcript record kind, live event type), and
  qualify every prose and JSDoc use: "turn record", "transcript record", "live event". In
  `projection.js` name the two parameters `turnRecord` and `transcriptRecord`. Reserve
  "transcript" for the projection format; the UI module becomes `messages.js`.
- **Size.** About 30 comment and identifier lines in 6 files, one table. **Risk.** None for
  behaviour; `test/unit/m1b-*projection*` covers the projection.

### HR-ONTO-2 (major, questions 4a and 4e) Milestone ids name modules, exports and types, and three export names are each defined two or three times

- **Where** [measured].
  - 12 product files carry a milestone in their name: `config/defaults-m4.js`,
    `guest/lib/{interfaces-m3,interfaces-m4,interfaces-m5,interfaces-m5-factory,limits-m4,limits-m5,texts-m4}.js`,
    `guest/session/m5-parts.js`, `impl/gateway/contract-m3.js`,
    `impl/gateway/extensions/m4-secrets.js`, `scripts/provision-steps/50-m5-fixtures.js`.
  - 62 distinct identifiers with a milestone in them, 546 sites in product code. The largest:
    `m4Limits` 87, `m4Texts` 69, `m5Shapes` 33, `m1bInterfaces` 31, `m2Interfaces` 30,
    `m4TextOf` 23. Types too: `M5Part`, `M1A_POOL`, `m1aTemplateOptions`.
  - Two orders for one pattern: `m4Limits` (`guest/lib/limits-m4.js:18`) against `limitsM5`
    (`guest/lib/limits-m5.js:19`).
  - `texts` is exported by three modules and `textOf` by three (`interfaces.js`,
    `interfaces-m5.js`, `interfaces-m5-factory.js`); `limits` by two with different contents
    (`guest/lib/limits.js:20` for vats, `config/defaults.js:11` for Node). Importers rename them
    under 13 local names: `textOfM5` 17, `m5Texts` 6, `factoryTexts` 5, `harnessLimits` 4,
    `guestLimits` 3, `textsM5` 2, `m5TextOf` 2, `m1Text` 2, `factoryTextOf` 2, `hostLimits` 2,
    `execTexts`, `execTextOf`, `defaultLimits`.
- **Why it costs.** The milestone was the unit of parallel building, not a concept of the
  product. A reader looking for "the Secret's guard" must know it arrived in M4
  (`m4Interfaces.Secret`); a reader of `limits` must know which of two modules it came from. Every
  later milestone (M6..M13) would add another set. The local aliases mean one export is grep-able
  under up to five names.
- **In hand, partly.** The integration workflow's per-vat split of `interfaces.js` covers the
  interface tables (HR-GUEST-2, HR-HOST-17). It does not by itself cover limits, texts, config,
  `contract-m3.js`, `m5-parts.js` or the export-name collisions.
- **Fix.** One naming rule for the split, written in `milestones.md` "Conventions": modules and
  exports are named for the vat or concept (`session-shapes.js`, `secretsTexts`,
  `subscriptionLimits`, `gateway-contract.js`, `session-parts.js`), never for a milestone; one
  export name per concept across the package (`vatLimits` against `hostLimits`, so no alias is
  needed). The provisioning step numbers (`50-...`) may stay; they order files, but drop `m5`
  from the name.
- **Persisted or frozen** (flag). Identifiers inside installed programs (the factory and the
  agent-host manager, `resources/agent-host/durable*.js`) change bundle bytes, and a reinstall
  breaks every reference into the manager vat (ARCH D-14). Session and exec programs change only
  for new vats (D-4). Nothing is in production, so the rename is cheapest now [inferred]. Comment
  references are stripped and free.
- **Size** [inferred]. About 550 identifier sites and 12 file renames, mostly mechanical, best
  done inside the integration split. **Risk.** Contract tests that import the old names
  (`test/unit/m*-interfaces.test.js`); the gateway's `interfaces-m*.js` glob (M3 6.3), which
  needs a new registry pattern.

### HR-ONTO-3 (moderate, questions 4a and 4d) The product has three names: Floot, Familiar and thix

- **Where** [read, measured].
  - **Floot** to the model: "You are Floot, a warm, concise assistant living inside the Endo
    daemon." (`guest/lib/prompt-sections.js:47-55`), stored in every session's composed prompt.
    To the user: composer placeholder "Message Floot…" (`impl/gateway/contract-m3.js:177`),
    "Say hello to Floot." (`ui/src/conversation/labels.js:9`). In CSS: 441 `floot-` class uses
    (144 distinct) and `ui/src/styles/floot.css`.
  - **Familiar**: page title (`contract-m3.js:160`, M3:211, spec R6-8), the WebSocket subprotocol
    (`ui/src/net/connection.js:155`), and localStorage keys `familiar.signIn`,
    `familiar.protocolReload`, `familiar.draft:`, `familiar.send:`, `familiar.mentions:`
    (`ui/src/main.js:25-26`, `ui/src/controller/drafts.js:12-14`, `ui/src/mentions/mentions.js:48`).
  - **thix / thixotrope-harness**: 176 `thix-` class uses (81 distinct), format tags
    `thix-secrets-1` and `thixotrope-harness-*-1`.
- **Why it misleads** [inferred]. A user sees "Familiar" in the tab, types to "Floot", and an
  operator finds `thix-` and `floot-` classes side by side in one component (`ui/src/sessions/Sidebar.js:
  108-109`). The model is told it lives "inside the Endo daemon", which it does not.
- **Fix.** An owner decision, then a glossary line: Familiar is the client (spec-fixed), Floot is
  the assistant persona (spec-ported text), "harness" is the server. Then one CSS prefix for
  classes the harness added (`thix-`, kept for the Floot-derived ones is acceptable if written
  down), and correct "inside the Endo daemon" when M5's prompt is next revised.
- **Persisted** (flag). The subprotocol is wire; the localStorage keys survive reloads; the
  prompt text is stored per session at creation (R4-26..R4-28), so an edit reaches new sessions
  only. Do not rename the storage keys without reading the old ones once.
- **Size.** Documentation now; the CSS prefix about 600 sites if done. **Risk.** Browser tests
  that select classes (`test/browser/m3-*.mjs`).

### HR-ONTO-4 (moderate, questions 4a and 4b) One subscription login has four names, and "provider" has three senses

- **Where** [read].
  - One provider login is a **member** in the pool (`PoolMember`, `makeMember`; 359 uses), an
    **account** in the readings and the UI chip (`MemberAccount`, `Accounts`, `accountId`; 182),
    a **subscription** in the UI panel, the admin facet and the directory
    (`ui/src/accounts/SubscriptionsPanel.js:20` "Subscriptions", `SubscriptionsAdmin`,
    `impl/subscriptions/`, persisted `<state>/agent-host/subscriptions/readings.json`), and a
    **credential** for its Secret's JSON (`impl/subscriptions/credentials.js`).
  - "Subscription" is also the live-stream object: `AccountsSubscription`
    (`guest/lib/interfaces-m4.js:458`) is a subscription to the accounts of subscriptions.
  - "Provider" is the subscription vendor (`Provider: M.or('claude', 'codex')`,
    `interfaces-m4.js:92`), the API modules (`impl/providers/anthropic.js`, `openrouter.js`,
    `scripted.js`) and the UI label for a backend (`ui/src/presets/texts.js:33`
    `backend: 'Provider'`). The backend kind `anthropic` and the provider `claude` are the same
    company.
- **Fix.** Glossary: **member** (a pool's entry for one login, with its credential Secret),
  **account reading** (what the provider reports about it), **subscription** only in the user's
  sense (the plan), **provider** = the vendor behind a backend kind. Rename
  `AccountsSubscription` to `AccountsWatch` (adapter-local, not persisted) or follow HR-ONTO-15.
  In the UI, label the backend selector "Backend" unless the spec fixes "Provider" (not checked
  [inferred]). Call `impl/providers/*` "provider modules" in prose.
- **Persisted** (flag). `readings.json` path and its `members` field; M4 method names on the
  manager (`makeMember`, `retirePool`) are in an installed program.
- **Size.** Glossary and about 10 identifiers. **Risk.** None for state.

### HR-ONTO-5 (minor, question 4b) `CredentialOps` holds no credential

- **Where** [read]. `guest/lib/interfaces-m4.js:499-504` gives `CredentialOps` the methods
  `describeSecrets`, `setSecretDescription`, `auditReader`, `accounts`; the header of
  `impl/subscriptions/credential-ops.js:2-10` says it fills the Secrets catalogue, keeps audit
  labels and hands out `AuditReader` and `Accounts`. "No method answers a value." It is reached as
  `ops.credentials()`. Meanwhile the thing that does touch one credential is
  `makeCredentialAccess` (`impl/secrets/credential-access.js:23`).
- **Fix.** Fold into HR-HOST-7's split: name the facets for what they serve (`secretsCatalog()`,
  `accounts()`), and keep "credential" for the member's stored login.
- **Persisted** (flag). `credentials` is a method name the manager vat calls; changing it changes
  the installed manager bundle. **Size.** About 25 lines in 5 files.

### HR-ONTO-6 (moderate, question 4b, across both packages) Words the harness shares with the core mean something else here

AR-ONTO-14 listed session, workspace, endpoint, lease and turn from ARCH. The code adds more
[read, measured]:

| word | core sense | harness sense (code) | where a reader is misled |
|---|---|---|---|
| session | hub session | agent conversation | "hub session" is written **0** times in the harness; `guest/lib/retired.js:6-7` says "When the hub retires a session" inside the session vat's helper |
| Registration | a native-resource registration (key, spec, epoch) | the cancel handle of a start listener (`resources/agent-host/durable.js:556`, guard `interfaces.js:1569-1572`) | the same file registers its real registration under `SERVICE_KEY` (`durable.js:50`, `manager.register`) |
| endpoint | the host endpoint session | the adapter's turn object `Endpoint` (`interfaces.js:1520`) | ARCH 3.3 and D-5 use both within a page |
| lease | the state-directory engine lease | the turn lease (`holdTurn`) and `ExecLease` = `{ scope, deadlineMs }` (`interfaces.js:1748`), which leases nothing | `ExecLease` is a scope plus a deadline |
| delivery | one journal frame into the engine (AR-ONTO-6) | a numbered live event (`Delivery`, `LiveBatch.deliveries`, `interfaces.js:1108-1118`); a delta or token count that forbids a retry (`impl/providers/retry.js:9-16`) | three senses in one turn's path |
| journal | a worker's durable input log | the UI's "Turn journal and recovery" panel (`contract-m3.js:189`) for the turn records | an operator reading core logs and this panel |
| snapshot | a vat heap image | `watch() -> { snapshot }`, `SnapshotEvent`, `PresetSnapshot`, `rowSnapshot` | harmless in context; qualify in prose |
| host | everything trusted outside vats | `host` = `AgentHostAdmin` in the factory (`guest/factory/main.js:41-44`, installed edge `host=agentHostAdmin`, ARCH 3.1) and `host` = `SessionHostFacet` in the session (`guest/session/session.js:65`, `live.js:95`) | one parameter name for an admin facet and a per-session facet |
| workspace | one user's vat | the preset object kind `git-workspace`, label `workspace` (`guest/factory/preset-templates.js:57-60`, model-facing) | `scripts/gateway.mjs:48-49` uses the core sense in the same package |

- **Fix.**
  - Prose rule for the harness: "hub session", "host endpoint", "engine lease", "journal
    frame" for the core senses; "session", "turn endpoint", "turn lease" for the harness's.
  - Rename the start-listener handle `Registration` to `ListenerHandle` (adapter and factory
    only; a manager-bundle change, so with HR-HOST-1's reinstall).
  - Rename `ExecLease` to `ExecScopeInfo` (the shape name is not persisted; the exec vat and
    session program change).
  - Name the factory parameter `agentHost` and keep the installed edge name `host`.
  - "Turn records and recovery" for the UI panel title, if the spec does not fix it (R6-51 was not
    checked [inferred]).
- **Size.** About 40 lines plus the glossary. **Risk.** Low; the renamed shapes are guarded by
  name in contract tests.

### HR-ONTO-7 (moderate, question 4b) "Seal" names both archiving and encryption, and the open "sealing secret writes" work will add to the second

- **Where** [measured, read].
  - Archive sense: 359 identifier uses (`seal`, `sealing`, `sealedTo`, `sealedTurns`,
    `SealRequest`, `SealedText`, `SealedTurnPreview`, `SealedContentPage`) in
    `guest/session/{archive,history,turn,export,context-source}.js`,
    `impl/archive/*`, `impl/context-cache.js`, `scripts/export.mjs`, the UI controller.
  - Encryption sense: 59 uses (`SealedBox`, `interfaces.js:2241`; `seal.js`; sealed audit lines
    in `impl/secrets/store.js`; `sealTo` in `scripts/subscription-login.mjs`).
  - The user and model already read "archived", not "sealed": `texts.turnSealed` is "This turn is
    archived; ..." (`interfaces.js:290`), `texts.recordsSealed` is "These records are archived".
  - `SealedText` (an archived text) sits beside `StagedText` and `SealedBox` in one module.
- **Why it matters now.** The integration workflow is "sealing secret writes". After it, "sealed"
  in `SecretWriter` code will mean encrypted, while "sealed" in the archive code next door means
  durable in a segment [inferred].
- **Fix.** Keep "seal" for encryption only (it is the crypto term). In the archive, write
  "archive" for the verb in prose and in new identifiers; rename non-persisted identifiers
  (`SealedText` to `ArchivedText`, `SealRequest` to `ArchiveRequest`) with the next M2-area
  change. Leave persisted fields (`sealedTo`, `sealedTurns` in `ArchiveState`, carried in session
  heaps and the manifest).
- **Size.** About 60 non-persisted identifiers in 10 files. **Risk.** Session program change;
  `test/unit/m2-w25-archive.test.js`, `test/adapter/m2-archive-store.test.js`.

### HR-ONTO-8 (moderate, question 4b) "Label" is a petname, a display name and a lookup key

- **Where** [read].
  - Petname: the session's label map, `EdgeLabel` (`guest/lib/interfaces-m5.js:337`); the model
    calls it `petName` (`interfaces-m5.js:125-136`, spec-fixed).
  - Display name: `Secret.label`, `BackendSpec.label`, `Preset.label`; the preset editor shows it as
    "Name" (`ui/src/presets/texts.js:30`).
  - Lookup key: a member and a pool are found by label, idempotently
    (`resources/agent-host/durable-subscriptions.js:244-249`, `:424-428`; text
    "A pool with this label already exists ..." `guest/lib/texts-m4.js:37`); built-in presets are
    found by label, "Their labels are Fae's ids" (`guest/lib/preset-catalog.js:45-47`).
  - The built-in preset labels `development`, `chat-only`, `general`, `new-project` are also the
    template names (`guest/lib/interfaces-m5-factory.js:59-71`), so `development` is a preset and
    a template.
- **Why it misleads.** The owner's principle is objects, not names; a "label" that is a key
  hides a name lookup behind a display word. A reader cannot tell whether renaming a pool's
  label is cosmetic (it is not: it changes idempotency).
- **Fix.** Glossary: **label** = a session-local petname (no other sense); **title** = a display
  name. For the two keyed uses, name the field what it is (`poolName`, `builtInId`) or document
  it as a key in M4 and M5. No rename of persisted fields now.
- **Persisted** (flag). `label` is stored in member, pool, Secret and preset records in manager
  and factory heaps.
- **Size.** Documentation and about 10 identifiers. **Risk.** None.

### HR-ONTO-9 (moderate, questions 4a and 2) One concept, an object sent with a label, has six names and three shapes

- **Where** [read, measured].
  - The browser's **mention** becomes an **attachment** chip (`ui/src/mentions/`; chip/chips 92),
    crosses as `attachments` (`Attachment = { label, value }`, `interfaces-m5.js:339`), is opened
    in the session as a **package** (`guest/session/packages.js:5-8`), and is named to the model
    by `messageNumber` and **edgeName**, adopted under a **petName** (`interfaces-m5.js:133-134`).
  - A preset's **endowment** is the same shape: `Endowment: () => m5Shapes.Attachment`
    (`interfaces-m5-factory.js:161`). The UI calls endowments "Default objects"
    (`ui/src/presets/texts.js:39`).
  - `SessionServices.endowments` writes the shape a third time inline
    (`guest/lib/interfaces.js:1206-1212`).
  - "Package" is also M9's mail package (`SessionInternal.deliverMail(package)`, ARCH 3.2).
- **Fix.** One shape, `LabelledObject`, used by attachments, endowments and services. Glossary:
  **attachment** (sent with one message), **endowment** (given by a preset to every session it
  makes), **package** (one message's attachments, open for its turn); the model-facing names stay
  (spec). The inline copy goes with the integration split.
- **Size.** About 15 lines. **Risk.** The gateway vocabulary is derived from shapes, so the key
  set is unchanged (both have `label`, `value`).

### HR-ONTO-10 (minor, questions 4b and 2) "Template" names three things, and the preset templates are defined twice

- **Where** [read].
  - **Preset template** (the kind of a preset): `presetTemplateNames`, `TemplateObject`,
    `templateKindUnits` (which bounds both a template name and an object kind,
    `interfaces-m5.js:468-475`).
  - **State template** (a prepared state directory for tests and perf): `test/template/`,
    `m1aTemplateOptions`, `templateIdFor` (`scripts/provision-steps.js:467-560`), "the m1a
    template" in product code (`guest/factory/pool.js:21`).
  - **Text template**: "Templated UI texts" (`contract-m3.js:195`), and `@template` JSDoc.
  - The preset templates' data exist twice: `workspace` and `shell` objects and the description
    texts in `guest/lib/preset-catalog.js:40-60` and again, with `required`, in
    `guest/factory/preset-templates.js:57-96`; the names a third time in
    `ui/src/presets/texts.js:16-21` (checked equal by a test).
- **Fix.** Prose: "preset template", "state template". Build `BUILTIN_PRESETS` from
  `preset-templates.js` (one source of the objects and texts). Give the template-name bound its
  own limit.
- **Size.** About 40 lines. **Risk.** `test/unit/m5-w51-presets.test.js`.

### HR-ONTO-11 (minor, question 4b) `h<n>` is both an archive key and a history cursor

- **Where** [read]. The manager assigns each session's archive directory a key `h<n>`
  (`resources/agent-host/durable.js:255`, `impl/archive/store.js:11`, `:102`). The history
  cursor is also `h<n>`, where n is a turn ordinal (`guest/session/history.js:164`,
  `impl/archive/history.js:7-14`). Both pass through `impl/archive/history.js`.
- **Fix.** Document both in M2 4.2 and 4.9 as distinct. A prefix change to the cursor (wire text,
  not persisted) would need the adapter to accept both while old session programs live, so
  document only.
- **Size.** 2 lines. **Risk.** None.

### HR-ONTO-12 (minor, questions 4a and 4d) Round, step and crank in texts the model reads

- **Where** [read].
  - `limits.maxToolRounds` counts model rounds ("Model rounds per turn", `limits.js:89-90`), not
    tool rounds; the turn engine calls it `maxRounds` (`guest/lib/turn-engine.js:39-62`).
  - The model reads "tool-step limit" for that bound (`interfaces.js:153`, R4-47, spec-fixed).
  - The model reads "exceeded the per-step compute budget" (`interfaces.js:218`, harness text),
    where a step is a crank of the exec vat.
  - "Step" is also a recovery step (`turn-hooks.js`), a provisioning step and a crank step
    (`turn.js:16`).
- **Fix.** Rename the limit `maxRounds` (guest only, not persisted). Change the harness text to
  "the per-call compute budget" (model-facing, not spec-fixed). Leave R4-47's text.
- **Size.** About 10 sites. **Risk.** Tests that compare `texts.execTerminated` exactly.

### HR-ONTO-13 (moderate, question 4c) ARCH section 3 describes interfaces the contracts changed, and has no glossary

In each case the contract and code agree, and ARCH is the one out of date [read]:

| ARCH | contract and code |
|---|---|
| `Backend ... open() -> Endpoint` (ARCH:440, :484) | `open(host) -> TurnPorts` (ARCH's own D-5 at :307; `interfaces.js:1459-1462`) |
| `getTurnContent(ref)` (ARCH:458, :902) | `Turn.getContent`, `History.turnContent`, `SessionInternal.blobPage` (`interfaces.js:2038`, `:2561`, `:2585`) |
| `ExecHandle: run(), retire()` (ARCH:444) | `ExecHandle: scope(), retire()` and `ExecScope: run, abandon, inspect` (`interfaces.js:2040-2041`, `interfaces-m5.js:584`) |
| "The sign-in secret is an entry in the same store" (ARCH:510) | its own file `agent-host/gateway/signin.enc` (`impl/gateway/signin.js:7`, `:47`; M3:111, :176) |
| session program "bounded to 200 KB" (ARCH:286, :1080, :1226, :1281) | `sessionProgramBytes: 240_000` since M5 (`limits.js:117-122`, M5 O-1) |
| `SessionRow` without `state` (ARCH:419) | `state: Lifecycle` (`interfaces.js:1139`), which D-17's `lost` needs |
| `getPresetConfiguration()` (ARCH:416) | `PresetCatalog.configuration` reached by `Operator.getPresets` (`interfaces-m5-factory.js:305-308`) |

- **Fix.** Update ARCH 3.1-3.3 and the budget rows in one documentation commit, and add a
  glossary section to ARCH that adopts section 5 below.
- **Size.** About 30 lines. **Risk.** None.

### HR-ONTO-14 (minor, questions 4a and 4d) A session's stored fields use other names than its options

- **Where** [measured]. `effort` (24 / 39 / 21) in `SessionRow` (`interfaces.js:1146`) against
  `reasoningEffort` (46 / 33 / 23) in `CreateOptions`, `SessionConfig`, presets. `backendTitle`
  (20 / 0 / 4) in the row and config against `label` on the Backend. `contextLength` (15 / 40 /
  0) in `SessionConfig` against `windowTokens` (23 / 0 / 4) in `ContextReading`.
- **Fix.** Use the option name in the next contract change that touches the row
  (`reasoningEffort`, `backendLabel` or `backendTitle` with HR-ONTO-8's "title" rule), and say in
  the glossary that `contextLength` is the model's window and `windowTokens` the same number as
  reported.
- **Persisted** (flag). Rows in the factory heap, configs in session heaps: a rename needs
  `exportState`/`importState` or a reader that accepts both.

### HR-ONTO-15 (minor, question 4a) Three ways to open a live stream, and "watch" means two things

- **Where** [read]. `Live.subscribe(session, rev?)` and `Live.subscribeList(rev?)`
  (`interfaces.js:1413-1417`, M1b), and `Accounts.watch(rev?) -> AccountsSubscription`
  (`interfaces-m4.js:455`). `Session.watch()` returns a snapshot, not a stream (M1a). The
  adapter side says channel (108), feed (67) and publisher (66) for the source.
- **Fix.** `Accounts.subscribe` (adapter-local, not persisted; the M4 browser feature calls it
  once). Glossary: a **channel** in the adapter, a **publisher** a vat holds, a **subscription**
  a viewer holds; `watch` is the snapshot read.
- **Size.** About 10 lines. **Risk.** `test/browser/m4-*.mjs`.

### HR-ONTO-16 (minor, question 4a) The waiting message has five names

- **Where** [measured]. `QueueEntry` (the exo), `QueueItem` (`pending-queue.js:82`),
  `PendingRow` / `PendingView` (the wire), "waiting entry" (11 in guest, 6 in M1a), "queued
  message" (UI and `texts.entryGone`). "Pending" also names calls in flight (`pendingTools`),
  unpublished events (`pendingEvents`) and a grant state. Two Session methods enqueue
  (HR-GUEST-6).
- **Fix.** Glossary: **queue entry** for the waiting message (code), "queued message" for the
  user. `QueueItem` becomes `QueueEntryState`. Leave the wire names.
- **Size.** About 10 lines.

### HR-ONTO-17 (minor, question 4e) Hook and weakness ids are not unique across contracts

- **Where** [read, measured]. `H-5` in product comments means the tool-table hook of M5
  (`guest/session/tools/mentions.js:191`, `objects.js:253`, `inspection.js:223`) and the store
  additions of M4 (`impl/secrets/audit.js:13`, `store.js:303`). `W-5` (a spec weakness,
  `impl/secrets/credential-access.js:3`) sits beside work units `W4.4`. Product code carries 445
  work-unit references (`W\d.\d`) and 59 `H-n` references.
- **Fix.** With HR-GUEST-16: cite a hook by its table name (`toolTable`), not its id; never cite
  `W-n`, `H-n` or `W<m>.<n>` in product code.
- **Size.** Comment-only; free in bundles.

### HR-ONTO-18 (minor, questions 4a and 5) UI text tables: two file names, one false rule, two spellings

- **Where** [read].
  - The same role is `labels.js` in two directories and `texts.js` in two
    (`ui/src/{conversation,accounts}/labels.js`, `ui/src/{mentions,presets}/texts.js`), and
    `accounts/labels.js` holds formatting functions, not labels.
  - `ui/src/mentions/texts.js:6-8` and `ui/src/presets/texts.js:4-8` say "the bundle cannot
    import the guest modules" and keep copies; `ui/src/accounts/labels.js:12` and seven other UI
    files import `guest/lib` directly.
  - "Record acknowledgement" (`contract-m3.js:190`) and "Operator acknowledgment"
    (`ui/src/conversation/labels.js:23`) are both on screen. "Factory default" is defined twice
    (`contract-m3.js:174`, `presets/texts.js:34`).
- **Fix.** One name (`texts.js`); state the true rule (prelude-free guest modules may be
  imported; only modules that need the vat prelude are copied) and import where it holds; one
  spelling.
- **Size.** About 30 lines. **Risk.** `test/unit/m5-w58-copies.test.js` shrinks.

---

## 4. Names fixed in persisted formats, wire shapes and texts (question 4d: flag only)

| name | where it lives | concept | finding |
|---|---|---|---|
| turn record kinds `turn-started` .. `turn-resolved`, letters `s d p r i t e v` | session heaps; segment files `seg-*.jsonl` | turn record | HR-ONTO-1 |
| transcript kinds `message`, `tool-call`, `tool-result`, `compaction`, `native-context`; `{ "$key": "b<n>" }` | `context.jsonl` | transcript record | HR-ONTO-1 |
| `{ "$staged": { key, preview, bytes, digest? } }` | segment files, `mirror.jsonl` | staged text | - |
| live event types `turn-start`, `tool_call`, `tool_result`, `final`, `usage`, `end`, `abort`, `pending`, `snapshot`, `delta` | adapter channel to browser; Fae's fold | live event | HR-GUEST-14 |
| `sealedTo`, `sealedTurns`, `epoch`, `boundary` | `ArchiveState` in session heaps; `manifest.json`, `context.jsonl` | archive | HR-ONTO-7 |
| keys `b<n>` (blob), `h<n>` (archive dir), `k<n>` (store) | file and directory names; manager heaps | handles' keys | HR-ONTO-11, HR-HOST-13 |
| `secrets.enc`, `secrets-audit.log`, `gateway/signin.enc`, `subscriptions/readings.json` | `<state>/agent-host/` | stores | HR-ONTO-4, -13 |
| format tags `thix-secrets-1`, `thix-secrets-audit-1`, `thixotrope-harness-{segment,manifest,context,readings,signin}-1`, `x25519-aes-256-gcm-1` | file headers, AAD | formats | HR-ONTO-3 (two prefixes) |
| registration keys `agent-host`, `gateway`; install edges `host`, `vats` | manager registrations; factory install | services | HR-ONTO-6 |
| manager exo tags and method names (`Registration`, `CredentialOps` via `credentials()`, `makeMember`, `retirePool`, ...) | installed agent-host manager program | facets | HR-ONTO-5, -6; changing them is a reinstall (D-14) |
| `SessionRow` fields `effort`, `backendTitle`, `state`; preset fields `label`, `template`, `objects`, `endowments` | factory heap | rows, presets | HR-ONTO-8, -14 |
| `SessionConfig` `reasoningEffort`, `contextLength`, `systemPrompt` ("You are Floot ...") | session heaps | session config | HR-ONTO-3, -14 |
| default title `'New chat'` | every session's config | session title | §2 |
| tool names `exec`, `echo`, `list`, `lookup`, `store`, `remove`, `describeCapability`, `readSources`, `adopt`, `adoptTool`; arguments `petName`, `edgeName`, `messageNumber`, `toolName` | model-facing (Fae, spec) | tools | HR-ONTO-8, -9 |
| WebSocket subprotocol `familiar`; localStorage `familiar.*`; fragment `#gateway=...&agent=<secret>` | browser | client | HR-ONTO-3 |

---

## 5. Proposed harness glossary (50 terms)

Consistent with AR-ONTO section 5, whose 38 terms stand. The winner is in bold; words in
brackets are to be avoided in that sense.

**Places and parts**

1. **harness**: the server built in this package: factory, session and exec vats and the
   agent-host native resource. [not: Floot, Familiar]
2. **Familiar**: the browser client (spec R6-8). **Floot**: the assistant persona the model is
   told it is. Neither names a component.
3. **operator**: the person who owns the harness and holds `Operator`.
4. **factory** (factory vat): the installed vat with the session index, presets, inventory and
   the spare pool.
5. **session**: one agent conversation, one session vat. In harness text the core's sense is
   always written **hub session**. [not, in code: conversation, chat]
6. **session vat / exec vat / spare**: a session's program vat; its lazily made vat for model
   code; a vat preloaded with a program, kept by the factory.
7. **exec scope**: the exec vat's persistent bindings, obtained through `ExecHandle.scope()`.
8. **agent host** (agent-host native resource): manager vat plus adapter. Its admin facet is
   `AgentHostAdmin`; a session's facet is its **session host facet**.
9. **gateway**: the HTTP and WebSocket server in the agent-host adapter; the **bridge** is its
   CapTP side.
10. **start count**: how many times the factory's start listener ran (HR-GUEST-7). [not: epoch]

**Turns**

11. **turn**: processing of one input from claim to settle.
12. **round**: one model request and the tool calls it asks for. [not: step, tool round]
13. **attempt**: one try of a round's request by a provider module, or of one pool member.
14. **turn generation**: the counter that lets late answers of an abandoned turn be ignored.
15. **turn endpoint** (`Endpoint`): the adapter's object for one session's turns. [not: endpoint,
    which is the core's host endpoint]
16. **turn lease**: the answered `holdTurn` call whose break signals a restart. [not: lease alone]
17. **ports** (`TurnPorts`): what `Backend.open` returns: turn endpoint, publisher, tools and,
    since M1b, content, writers, timer, archive port.
18. **sink**: a vat-side object an adapter reports into (`TurnSink`, `AgentHostSink`).
19. **retired break**: a call that rejects with the hub's retired text; from an adapter object it
    means restart, from a guest vat that the vat is **lost**.

**Records and streams**

20. **turn record**: one entry of the session's **record log** (`TurnRecord`, kinds
    `turn-started` .. `turn-resolved`).
21. **transcript record**: one entry of the projection's output, the format providers read
    (`message`, `tool-call`, `tool-result`, `compaction`, `native-context`). "Transcript" means
    this format only.
22. **context projection**: turn records to transcript records, in the adapter, once per round.
    **context cache**: the adapter's per-session copy; **context epoch**: its compaction counter.
23. **native context**: a round's opaque provider payload (signed thinking, encrypted
    reasoning); carried as `providerContext` on a transcript message.
24. **archive**: whole settled turns moved from the record log into **segments** (verb:
    archive). [not: seal]
25. **history page**: a page of turns, from the vat or, for archived turns, from the adapter's
    `History`.
26. **live event**: what a session publishes for viewers (`VatEvent`), plus the adapter's
    **delta** and **snapshot event**; the **fold** turns them into a view.
27. **live delivery**: one numbered live event in a `LiveBatch`. [not: delivery alone, which is
    the core's]
28. **channel / publisher / subscription**: the adapter's stream; the vat's handle to publish;
    a viewer's handle to read. `watch` is the snapshot read.

**Input**

29. **submission**: the text (inline or staged) and attachments a person sends; **request id**:
    its idempotency key; **receipt**: the answer.
30. **queue entry**: a submission waiting; "queued message" to the user. [not: pending row,
    waiting entry, queue item]
31. **hold**: why the queue does not drain.
32. **Composer**: the gateway service that stages and submits; the **composer** in the UI is the
    input box.
33. **draft**: the browser's unsent text.

**Backends and secrets**

34. **backend**: the `Backend` object a session uses, of a **backend kind** (`scripted`,
    `openrouter`, `anthropic`, `claude-pool`, `codex-pool`).
35. **provider**: the vendor behind a backend kind (`anthropic`, `openrouter`, `claude`,
    `codex`); its code is a **provider module**. [not: a backend]
36. **pool**: a subscription backend over several members.
37. **member**: a pool's entry for one subscription login; its **credential** is the JSON its
    Secret holds; its **account reading** is what the provider reports.
38. **Secret**: a managed value in the encrypted store, read through a **read grant**, written
    through a **SecretWriter**, from outside the adapter as a **sealed box**. "Seal" means
    encryption only.
39. **sign-in secret**: the gateway's browser password, in its own file (`signin.enc`).

**Objects, tools and presets**

40. **label**: a session's name for an object (its petname; the model says `petName`). [not: a
    display name, not a key]
41. **title**: a display name (session, backend, Secret, preset).
42. **attachment**: an object sent with one message under a label; **package**: one message's
    attachments, open for its turn.
43. **endowment**: an object a preset gives every session it makes, under a label (same shape as
    an attachment).
44. **inventory**: the operator's labelled objects in the factory.
45. **powers**: the object an exec call's model code receives (per call). The page's
    `GatewayPowers` is the only other use.
46. **tool**: something the model can call; by **site**: **adapter tool** (served by the
    adapter), **granted tool** (an object the operator or model granted), **object tools**
    (`list`, `lookup`, `store`, `remove`, ...), the **exec tool**. **Built-in** means the static
    table plus the round's adapter tools.
47. **tool grant**: the record of a granted tool (`ToolGrant`), withdrawn by `withdraw`.
48. **preset**: a named recipe for new sessions (template, instructions, network policy, model
    defaults, endowments); a session keeps a **preset snapshot**.
49. **preset template**: the kind of a preset and the **template objects** it may require.
50. **state template**: a prepared state directory for tests and perf. [not: template alone]

**Reconciliation with AR-ONTO's glossary.**

- AR-ONTO 12 (hub session) and 5 here: both glossaries must say that a bare "session" in harness
  text is the agent conversation. AR-ONTO-14 proposed preferring "conversation"; this report
  prefers keeping "session" (2,815 test and 761 guest uses, the spec's word) and qualifying the
  core sense.
- AR-ONTO 32 (workspace): the core keeps the word. The harness's M6 per-session directories
  should be called **git workspace** (the object kind is already `git-workspace`), never bare
  "workspace" in prose.
- AR-ONTO 20 (host endpoint) against 15 here (turn endpoint); AR-ONTO 6 (delivery) against 27
  here (live delivery); AR-ONTO's engine lease against 16 here (turn lease). Each pair needs the
  qualifier in both packages.
- AR-ONTO 30 (registration): the harness's start-listener `Registration` is not one
  (HR-ONTO-6).
- AR-ONTO 16 (session epoch) and AR-ONTO-2's three epochs: the harness adds context epoch (22),
  and replaces its own factory "epoch" with start count (10).
- AR-ONTO 9 (snapshot): the harness's `watch()` snapshot, snapshot event and preset snapshot are
  view or copy senses; write "heap snapshot" for the core's in harness prose.

---

## 6. Not covered

- Test and perf vocabulary beyond the counts (`test/` 2,815 uses of "session"); whether tests
  name what they test belongs to the area units.
- The spec (`endo-harness-spec.md`): where this report says a word is spec-fixed it relies on the
  `R*`/`A.4` citations in the code; the spec text itself was not read. Items marked "not checked"
  (R6-51, the "Provider" label) may be spec-fixed.
- `resources/agent-host/impl/subscriptions/` wire vocabulary of the Claude and Codex APIs
  (provider-defined, out of scope).
- CSS class semantics beyond the prefix count.
