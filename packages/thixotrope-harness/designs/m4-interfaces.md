# M4 interface contract

Unit W4.0 of `milestones.md` M4 (Secrets manager and subscription pools). This file,
`guest/lib/interfaces-m4.js`, `guest/lib/texts-m4.js`, `guest/lib/limits-m4.js` and
`resources/agent-host/impl/subscriptions/types.js` are the contract the M4 builders (group A:
W4.1-W4.5; group B: W4.6, W4.7) and the integration unit W4.8 build against without talking to
each other. `m1a-interfaces.md`, `m1b-interfaces.md` and `m2-interfaces.md` stay in force; where
this file and the guards disagree, the guards win and this file is wrong: report it. Paths: `H/` =
`packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`, `pkg/` =
`packages/thixotrope/`. Spec items are `P-nn`, `R2-n` .. `R8-n`, `G-nn`, `W-n` and `A.n` of the
specification (digest: `survey/spec-digest.md`); "architecture n" is `architecture.md` section n;
"M2 n" is `m2-interfaces.md` section n. Endo reference modules are read with
`git -C <T> show 1315bef86:packages/<path>`. This contract names no host, domain, address, account
or secret name of any deployment: providers' endpoints and OAuth client constants come from the
reference modules named in section 12, test endpoints from the fake servers.

M4 runs in its own lane in parallel with M3 (UI and gateway) and M5 (presets, prompts, tools,
grants). Decisions D-M4-1..D-M4-9 are this unit's (section 20 lists them with the owner decisions
they touch).

Contents: 1 scope; 2 rules; 3 objects and interfaces; 4 Secrets, full; 5 pools; 6 accounts;
7 renewal and sign-in; 8 what M4 takes from M2; 9 seams with M3 and M5; 10 restart, crash and
retry; 11 security; 12 module entry points; 13 fixed texts; 14 hook tables; 15 merge hotspots;
16 work units; 17 acceptance; 18 performance; 19 core requests; 20 decisions and open points.

---

## 1. Scope

### 1.1 What M4 delivers

| item | what M4 builds | parts left to others |
|---|---|---|
| P-26 (full) Secrets manager | catalogue page without values, description edit, audit reader up to 1,000 events, delete only after revoke (M2 has it), no path from a grant or a Secret to its admin | - |
| P-58 Secrets view | the browser panel (write-only: create, replace, revoke, delete after revoke, audit), through M3's UI seam | M3 shell and gateway |
| P-05 (`fae-codex`, `fae-claude`) | two backend kinds `codex-pool` (OpenAI Responses over SSE) and `claude-pool` (Anthropic Messages over SSE), harness runs the tools | - |
| P-06 pools | members by Secret object, sticky `auto` selection, hand-over on exhaustion, refusal marks with backoff, reset tracking, marks and last-served records durable in the manager vat | pinned-only members and shares (D-M4-6) |
| P-07 renewal | OAuth refresh in the adapter, write-ahead and generation-conditioned write-back, credential re-read every round; an operator sign-in helper (`[real-provider]`) | - |
| P-45 account status | readings from response headers and on-demand usage reads, provenance labels, an adapter-side accounts channel, `Accounts` service, `accountStatus` tool, account chips and Subscriptions panel | Codex reset-credit redeem (open decision 8: deferred, credits shown read-only) |
| P-46 (pool, Codex, Claude parts) | Codex overload retry (R4-75, R4-105), Claude overload retry (G-05, open decision 12), R4-76 texts, "Provider subscriptions exhausted" with the reset time (G-07) | - |

R items: R2-18, R3-35, R3-231..R3-233, R3-237, R4-14..R4-16, R4-18, R4-19, R4-21 (subscription
part), R4-23..R4-25, R4-30, R4-75, R4-76, R4-80 (G-07), R4-84, R4-85, R4-86 (display only),
R4-90, R4-92 (Claude 16,384), R4-93 (1 h), R4-103, R4-105, R6-29, R6-54, R6-67, R7-16, R7-22..R7-26,
R7-29, R7-30, R7-31 (bootstrap rule), R7-63, R8-13, R8-14, R8-30, R8-31, R8-34..R8-38.

### 1.2 What M4 leaves

- **Brokers.** The spec's subscription brokers run in hosted containers; here the agent-host
  adapter holds the credentials and calls the providers itself (architecture D-6, reuse.md 3.2:
  "host only"). R4-16 holds in substance: sessions receive a Backend, never a credential or an
  inference grant that carries one.
- **Codex reset-credit redeem** (R4-86, open decision 8): banked credits are shown; nothing
  redeems or abandons them.
- **Shares and pinned-only members** (hosted-agent `share-meter.js`, `subscription-share.js`): no
  parity item asks for delegated shares; selection is always `auto` (D-M4-6).
- **The voice preset's model** (R4-89, P-61): M11.
- **Provisioning runner** (M12): M4 appends one step to `provision-steps.js` (section 14) and adds
  `scripts/subscription-login.mjs`; the CLI command around it is M12's.
- **Compaction on subscription sessions** (M8): M4 stores `contextLength` (open decision 13) so
  M8's trigger can fire on Claude pools.

### 1.3 Sizes and limits

String content bytes as M2 1.2. M4's bounds are `guest/lib/limits-m4.js` (`m4Limits`) and, for
Node-only settings, `config/defaults-m4.js` (`subscriptionDefaults`, W4.1, section 12). Measured
limits that apply (m0-results, architecture 9): frame 24,576 bytes (`frameBytes`), inline 8,192
(`inlineBytes`), crank output 196,608 (`crankOutBytes`), 100 sends per crank, about 57,000
record keys per vat for life (rule 12.10).

| value | largest instance | bound |
|---|---|---|
| `PoolSpec` | 16 members + 3 URLs of 2,048 units + label 256 | ~7 KB; refused by the guard above 16 members |
| `PoolState` (sink answer, manager -> adapter) | 16 members x ~350 B + 256 served records x 3 fields | ~9 KB of strings + 528 references; < frameBytes |
| `PoolChange` (adapter -> manager, sendOnly) | 16 marks + 32 served records | ~2 KB |
| `SecretCatalogPage` (manager -> caller) | 64 entries x (256 label + 200 description + 4 numbers) | ~30 KB worst case: **over frameBytes** for full-length labels; the manager cuts the page by `fitsFrame` (M1b `bounded.js`) and answers `next` |
| `describeSecrets` answer (adapter -> manager, inbound to the vat) | 64 x ~60 B | ~4 KB |
| `AuditReaderPage` | 1,000 events x ~120 B | ~120 KB, adapter-local only (never enters a vat; WS message cap 1 MiB) |
| `AccountsView` / `AccountsBatch` | 8 pools x 16 members x ~500 B | ~64 KB, adapter-local only |
| `accountStatus` tool text | rendered for one pool | <= 32,768 units (tool output limit, R4-100); staged by the adapter tool path as any adapter tool result over `inlineBytes` (M1b 5.2) |
| credential value | provider token JSON | read refused over 8,192 bytes (R7-25, `CREDENTIAL_TOO_LARGE` -> `INVALID`) |
| secret value from a browser | `SecretWriter.replace` through the gateway (in process) | `m4Limits.browserSecretBytes` 1,040,384 bytes of JSON-escaped value (`wsMessageBytes` 1 MiB less 8 KiB of envelope), checked by the Secrets panel before sending; M2's 1,048,576-byte store bound (`secretValueBytes`) is reached only by the CLI's sealed-box write (9.1 item 4) |
| accounts subscribers | `Accounts.watch()` viewers | M2's `channelLimits.subscribersPerSession` (32); idle ones (no `next()` call for `accountsIdleMs`, 60 s; a waiting `next()` is answered again every `accountsKeepaliveMs`, 30 s) are evicted (6) |

### 1.4 Bundle budget (measured at `3588cab190`)

`node scripts/bundle-guest.mjs`: session program **186,448** bytes of its 200,000 budget, exec
84,354, factory 137,074. **13,552 bytes are left for M3, M4 and M5 together.** M4 therefore puts
nothing in the session or exec programs: its guards live in `interfaces-m4.js`, which
`interfaces.js` does not import (one-way dependency); the only M4 change that reaches every bundle
is the `BackendKind` widening (H-1, about 30 bytes). The factory bundle gains
`guest/factory/subscription-options.js` and `guest/lib/texts-m4.js` (about 4 KB). The manager
vat's bundle gains `durable-subscriptions.js` and `interfaces-m4.js` (about 30 KB; install time
only). W4.8 records all four sizes (`subscriptions.bundles` row).

Cross-lane budget (PM, after the three contracts were read together): M3 adds 0 bytes to the
session and exec programs, M4 at most 64 (H-1), M5 about 25 KB session and 12 KB exec, so the
merged branch does not fit 200,000 / 100,000. M5's W5.9 measures the merged bundles and the PM
raises `sessionProgramBytes` to 240,000 and `execProgramBytes` to 120,000 in the M5 merge commit
(M5's open point O-1, flagged to the owner). M4 builds as stated here either way: its own budget
is "+ <= 64 bytes" whatever the limit is.

---

## 2. Rules

1. **M2's rules hold** (M2 1.1): fixed key vocabulary, bounded crank work (rule 12.12), no secret
   in a vat or in the hub in clear (D-6), objects not names.
2. **Objects, not names.** Members are `PoolMember` objects minted from a `Secret` object; a pool
   is a `Backend` object made from member objects; the adapter keys pools by the Backend
   presence, members by the PoolMember presence and sessions by the Session presence. Names
   allowed in M4, each for an F.2 reason: member and pool labels (F.2 a, a person labels them),
   provider model ids and effort names (F.2 c, the provider's vocabulary), base URLs in a pool
   spec (F.2 c, configuration), the credential's store key `k<n>` (never leaves the
   manager-adapter pair, M1b 17.3), and secret labels at the provisioning boundary (F.2 c: the
   provisioning step finds a Secret by label in its options file; section 14).
3. **The manager vat decides what is durable; the adapter does the work.** Selection, HTTP, SSE,
   renewal, readings and rendering run in the adapter; marks, last-served records, members and
   pools live in the manager vat, which the adapter updates by coalesced `sendOnly` (D-3).
   Account readings are observations, not decisions: they live in an adapter file.
4. **No M4 code in the session or exec programs** (1.4). A session sees a pool only as a Backend,
   ports and an adapter tool.
5. **Never present a refresh token twice** (section 7): renewal is write-ahead, and an interrupted
   renewal fails closed.
6. **A provider request is sent at most once per round per member attempt**, and a round that
   delivered anything is never retried (R4-74, R4-78, M2 8.2); a member hand-over happens only
   before the first delivery (R4-25).

---

## 3. Objects and interfaces

Columns as M2 3: **caller**; **mode** (answered `E()` or `sendOnly`); **max** (largest message,
either direction); **retired break** (what the caller does; section 10); **heaviest crank** (in
the vat that receives the call); **persists** (what the call changes durably, and where).

### 3.1 Manager vat (durable; `resources/agent-host/durable-subscriptions.js`, W4.1)

Obtained: `Operator.getSecrets()` (M2) or `AgentHostAdmin.getSecrets()` -> `SecretsAdmin` (M4
version) -> `subscriptions()` -> `SubscriptionsAdmin` -> `makeMember` / `makePool` (D-M4-1:
pools hang off the Secrets manager because their members are made from Secrets and both are the
operator's root authority, R7-22; this keeps `AgentHostAdmin`, which M3 extends, untouched).

| method | caller | mode | max | retired break | heaviest crank | persists |
|---|---|---|---|---|---|---|
| `SecretsAdmin.subscriptions() -> SubscriptionsAdmin` | operator, gateway, provisioning | answered | tiny | manager lost | none | nothing (one exo, made at the part's construction) |
| `SubscriptionsAdmin.makeMember(NewMember) -> PoolMember` | operator, provisioning | answered | ~1 KB | manager lost: retry (idempotent) | one record | member record in the manager heap. Same label and same `credential` answers the same member (idempotent, R8-31); same label, other credential: `m4Texts.memberConflict`; a `credential` this manager did not mint: `textOf.secretFailed('UNKNOWN_SECRET')`; more than `maxMembers`: `textOf.secretFailed('CREATE_FAILED')` |
| `SubscriptionsAdmin.listMembers(cursor?)` | operator, UI | answered | <= 64 handles | manager lost | none | - |
| `SubscriptionsAdmin.makePool(PoolSpec) -> Backend` | operator, provisioning | answered | ~7 KB | manager lost: retry (idempotent) | one record | pool record. 1..16 active members of the kind's provider (`m4Texts.memberKind`, `noUsableMember`); same label and equal spec answers the same Backend; same label, other spec: `m4Texts.poolConflict` (R8-23); more than `maxPools`: `m4Texts.poolConflict` |
| `SubscriptionsAdmin.listPools()`, `describePool(pool)` | operator, UI | answered | small | manager lost | none | - |
| `SubscriptionsAdmin.retirePool(pool)` | operator | answered | tiny | manager lost | drops its served records; sends `CredentialOps.poolsChanged()` (sendOnly, 3.2) | pool `retired`: its `open`, `listModels`, `resolveModel` refuse with `m4Texts.retired`; sessions on it fail their next turn with that text (R4-22: no fallback): the push makes the adapter ask `poolState` again at the pool's next round (XB) |
| `SubscriptionsAdmin.accounts() -> Accounts` | operator, gateway | answered | tiny | manager lost | none | - (forwards `ops.credentials()` -> `accounts()`) |
| `PoolMember.describe()` | operator, UI | answered | tiny | manager lost | none | - |
| `PoolMember.retire()` | operator | answered | tiny | manager lost | removes it from every pool's selection; sends `CredentialOps.poolsChanged()` (sendOnly, 3.2) | member `retired`; its mark and served records dropped; it is not chosen at its pools' next round (XB); a pool left with no active member answers `noUsableMember` at its next round |
| pool `Backend.describe()` | factory (creation resolver) | answered | tiny | manager lost | none | - (`{ kind, label, modelId? }`) |
| pool `Backend.open(host) -> TurnPorts` | session (creation-time open, reopen after a restart) | answered | TurnPorts | manager lost | waits for the bind (as M2), records session -> pool in a WeakMap (for `poolOf`) | nothing durable beyond the WeakMap entry; forwards `ops.open({ backend, spec, session, archiveKey })` with the pool spec |
| pool `Backend.listModels(request?)`, `resolveModel(modelId?)` | factory | answered | <= frameBytes | manager lost | an answer passed through | - (forward `ops.listModels` / `ops.resolveModel` with the pool spec; the adapter routes pool specs to the pool catalogue, H-4) |
| pool `Backend.resolveEffort({ modelId, reasoningEffort? })` | factory (M4 resolver) | answered | tiny | manager lost: creation fails | an answer passed through | - (forwards `ops.resolveModel` and checks the effort against the row's `reasoningEfforts`, R4-23; `m4Texts.unsupportedEffort`) |
| `SecretsAdmin.catalog(cursor?) -> SecretCatalogPage` | operator, UI | answered | <= frameBytes | manager lost | <= 64 entries; one `describeSecrets` call | - |
| `SecretsAdmin.auditReader() -> AuditReader` | operator, UI | answered | tiny | manager lost | none | - (forwards `ops.credentials().auditReader()`) |
| `Secret.setDescription(text)` | operator, UI | answered | ~0.6 KB | manager lost | one record | the Secret's record (label, description) in the manager heap; then `ops.credentials().setSecretDescription(key, text)` so audit labels follow; R7-25 rule (1-200, no newline: `INVALID_DESCRIPTION`) |

**Sink additions** (`AgentHostSink`, called by the adapter only; guards
`m4SinkMethodGuards()`):

| method | mode | max | heaviest crank | persists |
|---|---|---|---|---|
| `poolState(pool) -> PoolState` | answered, once per pool per adapter incarnation | ~9 KB out | builds <= 16 + 256 records | - |
| `poolChanged(pool, PoolChange)` | sendOnly; marks at once, served stamps coalesced (5.1) | ~2 KB in | applies <= 16 marks and <= 32 served records; drops the least recently served past 256 | marks (per member, shared by every pool the member is in), last-served records (per pool) |
| `poolOf(session) -> pool \| undefined` | answered | tiny | one WeakMap read | - |

### 3.2 Agent-host adapter (transient; tombstones after a restart)

| object.method | obtained from | caller | mode | max | retired break |
|---|---|---|---|---|---|
| `CredentialOps.describeSecrets(keys)` | `ops.credentials()` (H-3) | manager | answered | 64 keys | adapter restarted: the manager reconciles and calls again (`withOps`) |
| `CredentialOps.setSecretDescription(key, text)` | same | manager | answered | tiny | same |
| `CredentialOps.auditReader()`, `accounts()` | same | manager | answered | tiny | same |
| `CredentialOps.poolsChanged()` | same | manager (`retirePool`, `PoolMember.retire`) | sendOnly, no argument | tiny | lost with a retired adapter: harmless, a new incarnation loads every pool afresh; the adapter also re-reads a used pool's state when it is older than `poolStateRefreshMs` (600 s), the safety net |
| `AuditReader.page({ secret?, limit?, before? })` | `SecretsAdmin.auditReader()` | gateway (in process), CLI, tests | answered | <= 1,000 events, never into a vat | restart: get a new reader |
| `Accounts.list()`, `forBackend(pool)`, `forSession(session)`, `refresh(pool?)`, `watch(rev?)` | `SubscriptionsAdmin.accounts()` | gateway (in process), CLI, tests | answered | adapter-local | restart: get a new one |
| `AccountsSubscription.next()`, `close()` | `Accounts.watch()` | gateway | answered | one `AccountsBatch` | restart: re-watch; idle (no `next()` call for 60 s): evicted, its next `next()` rejects with `m4Texts.accountsWatchClosed` and the page calls `watch(lastRev)` (6) |
| `gatewayExtension` of `AH/gateway/extensions/m4-secrets.js` (W4.6) | loaded by M3's `GW/extensions.js` at adapter start | M3's bridge | - | - | - |
| pool provider (`claudePoolKind`, `codexPoolKind` in `backendKinds`) | `backendKinds` hook (H-4) | the endpoint, per round | in process | - | - |
| `accountStatus` adapter tool | `adapterTools` hook; offered by both pool kinds and both API kinds (`tools` lists) | the session vat through `TurnPorts.tools` (`AdapterTool.execute`, M1a) | answered | text <= 32,768 units, staged over `inlineBytes` | adapter restarted: as any adapter tool on the turn path (M2 11: outcome-unknown recovery) |

`Accounts.forSession(session)` answers the session's pool from the adapter's map of sessions that
opened a pool in this incarnation, else one `E(sink).poolOf(session)` (one manager crank), else
`undefined` (`m4Texts.noSubscriptionAccounts` in the tool text). No vat method is added for it
(D-M4-3: A.4's `Session.getAccount` is served by the gateway-local `Accounts`, so no session
code grows).

### 3.3 Object graph (who can reach what)

```
operator (control socket, gateway) --getSecrets--> SecretsAdmin(M4) --subscriptions--> SubscriptionsAdmin
   SecretsAdmin --catalog--> [Secret]          Secret --setDescription / M2 methods
   SecretsAdmin --auditReader--> AuditReader (adapter-local)
   SubscriptionsAdmin --makeMember(Secret)--> PoolMember --retire
   SubscriptionsAdmin --makePool([PoolMember])--> Backend(pool) --> HarnessRoot.configure({ backends })
   SubscriptionsAdmin --accounts--> Accounts (adapter-local) --watch--> AccountsSubscription
factory --holds--> Backend(pool): describe, listModels, resolveModel, resolveEffort, open
session vat --holds--> Backend(pool) (SessionServices.backend): open -> TurnPorts (endpoint, tools incl. accountStatus)
adapter --holds--> AgentHostSink: poolState, poolChanged, poolOf (+ M2's resolveSecrets/Grants)
```

Nothing a session or exec vat can call returns a `PoolMember`, a `Secret`, a `ReadGrant`, the
`SecretsAdmin`, the `SubscriptionsAdmin`, `Accounts` or a credential (section 11).

### 3.4 What persists where

| state | where | written | bound |
|---|---|---|---|
| members (label, provider, weight, declared profile, credential Secret, state) | manager vat heap | `makeMember`, `retire` | `maxMembers` 64 |
| pools (spec, state) | manager vat heap | `makePool`, `retirePool` | `maxPools` 8 |
| marks | manager vat heap, per member | `poolChanged` | one per member |
| last-served records | manager vat heap, per pool, `Map<Session, { member, at }>` in least-recently-served order | `poolChanged` (coalesced) | 256 per pool (R4-103) |
| session -> pool | manager WeakMap (lost with the session object) | pool `open` | - |
| secret records (label, description) | manager vat heap (M2), description edits M4 | `setDescription` | `MAX_SECRETS` 1,024 (M2) |
| credentials (access and refresh tokens, expiry, write-ahead mark) | the Secrets store (`secrets.enc`, M2 9.1), one secret per member | renewal (section 7) | 8,192 bytes per credential read |
| audit events | the Secrets store's audit file (M2) | every read, replace, create, revoke, delete | newest 10,000 (M2) |
| account readings | adapter file `<state>/agent-host/subscriptions/readings.json` (no secret: windows, plan, credits, times), keyed by the credential's store key | at most every `readingsFlushMs` (5 s), temp + rename + fsync | one entry per member |
| selection state, single-flight renewals, catalogue caches, accounts channel | adapter memory | - | lost at restart by design |

---

## 4. Secrets, full (W4.1 manager part, W4.4 adapter part)

### 4.1 What M4 adds to M2's Secrets

- **Catalogue** (R7-22, R6-67): `SecretsAdmin.catalog(cursor?)` pages the manager's list of
  Secrets (M2's `secretList`, creation order, cursor = position as in `list`), at most 64 per
  page and at most `frameBytes` (cut, then `next`); one `CredentialOps.describeSecrets(keys)`
  call fills generation, state and bytes; labels and descriptions come from the manager's records
  (the system of record). Never a value (R7-26).
- **Description edit** (R6-67, R7-23 `setDescription`): `Secret.setDescription(text)`.
- **Audit reader** (R7-63: default 100, at most 1,000): `SecretsAdmin.auditReader()` returns an
  adapter-local `AuditReader`; `page({ secret?, limit = 100, before? })` answers newest first,
  `next` = the `before` of the following page. A `secret` presence is resolved by
  `sink.resolveSecrets` (cached per incarnation). M2's `SecretsAdmin.audit(limit <= 100)` and
  `Secret.audit` stay as they are.
- **Delete only after revoke** and **revocation of every grant**: M2 already (`NOT_REVOKED`;
  grants map to the store key, so a revoked secret fails every grant's next read).
- **No path from a Secret or a grant to its admin**: `ReadGrant` has `describe` only; nothing
  maps a key to a handle (M1b 17.3 rule 1).
- **Values are UTF-8 text** (D-M4-7): R6-67's "byte-exact file" is a file whose bytes are valid
  UTF-8; the panel refuses any other file with `m4Texts.secretNotText`.
- **Bootstrap rule** (R7-31, R8-38): the provisioning step (section 14) imports a value only into
  a Secret it creates in that run; it never writes a Secret that exists, is revoked or was
  deleted (it keeps the labels it created in its own options-file record).

### 4.2 Store additions (W4.4, H-5)

`AH/secrets/store.js` gains `audit({ key?, limit, before? })` with `limit <= 1,000` and
`setDescription(key, description)` (audit labels); `AH/secrets/manager.js` (`makeSecretsOps`)
gains `credentialFor(key) -> CredentialAccess` (`types.js`): read (audited `read`) and
`replace(value, expectedGeneration)` of that one key, nothing else (W-5).

---

## 5. Pools (W4.2 core, W4.3 wire, W4.6 provider)

### 5.1 Selection, marks and last-served records

Port of hosted-agent `subscription-pool.js` (`standingOf`, `makeRefusalMarks`, `selectMembers`,
`makeSubscriptionPool`) and `rate-limit-headers.js` (`rateLimitReadingFromHeaders`,
`isSubscriptionExhausted`), with object keys and no pinning:

- **`auto`** (R4-24): among active, unmarked members, the one whose long window resets soonest;
  ties by the larger used fraction, then declaration order (the order of `PoolSpec.members`). A
  session stays on the member that last served it while that was within `cacheLifetimeMs`
  (`PoolSpec.cacheLifetimeMs`, default 300,000, R4-103).
- **Marks** (R4-25, R4-103): an exhausted refusal marks the member until the reset time its
  reading named (`dated`), else 60 s doubling to 1 h while refusals come in a row; an undated
  "limit reached" reading blocks for 1 h; a newer open reading of the member lifts a dated mark.
  `unusable` (credential unreadable, rejected after one renewal, consumed, expired) is an undated
  mark.
- **Persistence**: the adapter loads `poolState` once per pool per incarnation (lazily: at the
  pool's first `open`, `listModels` or accounts use) and asks it again only after the manager's
  `CredentialOps.poolsChanged()` push (a retirement, 3.1; XB) or when the answer is older than
  `poolStateRefreshMs` (600 s, a safety net for a lost push: at most one manager crank per used
  pool per 10 minutes, 0.1 per 60 s, so `subscriptions.servedWrites` keeps its budget; the 30 s of
  M4-FIX cost up to two per pool per 60 s). It sends `poolChanged` **at once** for a
  mark change (one manager crank per refusal, never more than one per member per round) and
  **coalesced** for served stamps: a stamp is sent when the session moved to another member, or
  the kept stamp is 60 s old (`servedStampMs`, the reference's `SERVED_STAMP_MS`), batched at
  most once per second per pool. A restart therefore errs by at most 60 s in judging a cache warm.

### 5.2 One round on a pool (W4.6 `provider.js`)

`makePoolProvider` returns M2's provider shape (`startRound(req, channel, prepare, owner)`,
`cancelRound`, `releaseTurn`) and runs M2's `runProviderRound` (M2 8.1) with a `stream` that
tries members:

```
order = core.forSession(owner).select()           // owner = the Session presence (endpoint.js)
for member of order:                               // one attempt per member, R4-25
  credential = await credentials(member).current() // audited read; renew if near expiry (7)
    failure -> core.unusable(member); next member
  attempt = wire({ member, credential, request, signal, onReading })
  before the first delivery:
    401 / credential rejected -> renewAfterRejection once, same member once more (R4-25)
                                 then core.unusable(member); next member
    429 exhausted (headers)   -> core.exhausted(member, untilMs); next member (same request rebuilt)
    overload                  -> retry the same member on the overload schedule (R4-75; Claude: D-M4-4)
    other failure             -> fail the round (fixed text), no next member
  after a delivery: any failure fails the round, never retried (R4-74, R4-78)
  success: core.served(member); readings -> accounts
all members marked or exhausted -> fail m4TextOf.subscriptionsExhausted(earliest dated reset as ISO)
```

The round's request is built once per member attempt from the same projection (`prepare()` runs
once). **System text:** `provider.js` resolves it exactly once per round, before the member loop,
with M2's `systemTextOf(req.system, blobs, owner)` (`AH/providers/round.js`), and passes the
resulting plain string (or `undefined`) to the wire builders: `claudeBody(request)` and
`codexBody(request)` take `request.system` as a string and never read `req.system`, a blob key
or a staged reference themselves. M5 widens `RoundRequest.system` (a staged text or `[text,
note]`) and changes only `systemTextOf` (its H-8, `round.js`, M5's file); M4 makes no edit to
`round.js` or `scripted.js` and inherits the join. Round 0 still sends nothing before `dispatching(0)` answered `true` (M1a contract 6).
Cancel aborts the attempt in flight and stops the member loop (R4-7).

### 5.3 Wire clients (W4.3)

- **`claude-pool`**: Anthropic Messages SSE. Reuses M2's `AH/providers/anthropic.js`
  (`anthropicMessages`, `anthropicTools`, `anthropicAttempt`, `anthropicBody`) with two additive
  options (H-14): `headers` (an OAuth bearer authorization and the R4-30 headers instead of the
  API key header) and `bodyExtras` (the R4-30 billing system block first, adaptive thinking with
  the effort, R4-23; `max_tokens` 16,384 unless the pool spec sets `maxOutputTokens`, R4-92).
  Failures (R4-76): SSE `error` event -> `m4Texts.claudeInferenceFailed`; non-200 ->
  `m4TextOf.subscriptionHttp(status)`; empty output -> `m4Texts.emptyMessagesOutput`. Overload
  (529 or an `overloaded_error` event) before any delivery is retried (open decision 12, D-M4-4).
  The event is told by its type: M2's `anthropicAttempt` sets `ProviderFailure.errorType` (the
  event's symbolic type, `''` when none) and `messages.js` compares that, never the failure
  text (XB).
  Efforts: lal `providers/subscription-messages.js` `claudeMessagesEfforts(model)`.
- **`codex-pool`**: OpenAI Responses SSE, request builder and output mapping ported from lal
  `providers/subscription-responses.js` (`instructions` = the system text, `store: false`,
  encrypted reasoning included and replayed as native context, R4-30, R4-31); events through
  M2's `sse.js`. Retry only on `server_is_overloaded` before visible delivery, delays 5, 10, 20,
  40, 60 s (R4-75, R4-105; `codexOverloadDelaysMs`). Failures: `m4TextOf.responsesFailed` with
  symbolic facts only (codes, types, params, reasons; never prose, a request id or a body);
  non-200 `m4TextOf.subscriptionHttp(status)`; empty `m4Texts.emptyResponsesOutput`. Effort
  `ultra` is sent as `max` (R4-23, hosted-agent `codex-reasoning.js`).
- **Both**: redirects refused (M2 `http.js` already sets `redirect: 'error'`, R7-29); request
  timeout `PoolSpec.timeoutMs` or 1 h (R4-93); no prompt-cache breakpoints (R4-30); rate-limit
  headers of every answer go to `onReading`; no header value, body or token is ever logged or
  put in a failure text.
- **Since the lane merge (INT-M4), as M2's providers after its review:** `PoolSpec.timeoutMs` is
  at least 1,000 and at most `maxTurnDeadlineMs` (guard); `baseUrl`, `tokenUrl` and `usageUrl`
  pass M2 `http.js` `providerBaseUrl` (https, or http to a loopback host; no user info, query or
  fragment) before a credential is sent: a refused `baseUrl` fails the round or catalogue read
  with M2's `BASE_URL_REFUSED`, a refused `tokenUrl` fails renewal with `RENEWAL_FAILED` before
  any request, a refused `usageUrl` is not read; a Codex round's stream is bounded at
  `limits.roundStreamBytes` (`texts.frameLimit`).

### 5.4 Catalogue and creation (W4.3 catalogue, W4.1 resolver)

- **Catalogue** (`AH/subscriptions/catalog.js`, same request and answer shapes as M2's
  `makeCatalog`, its timing constants reused: fresh 15 min, never older than 24 h, a failed read
  retried after 60 s, R4-104; its pages are M2's `pageOf` with an `efforts` option and its reads
  M2's bounded `readJson`, both exported by `AH/providers/catalog.js`, XB): each active member's
  model list is read with its credential;
  `codex-pool` lists the models of members whose reading is current or stale, a model offered by
  several gets the intersection of their efforts and the smallest context length and output
  limit (R4-18, Fae `src/subscription-models.js` `pooledSubscriptionModels`); `claude-pool` lists
  the union of the members' admitted models as the synthetic account `auto`, with efforts and no
  context length unless the pool spec sets `contextLength` (R4-19; open decision 13: D-M4-5).
  A read where no member answers: `{ rows: [], state: 'unavailable', error: texts.catalogUnavailable }`.
  Rows: `selectionId` and `default` exactly as M2 8.4 (a pool is never the default backend unless
  the operator makes it so).
- **Creation** (R4-21, R4-22, R4-23): W2.2's `catalogueModel` resolver already pins a given model
  through `Backend.resolveModel(modelId)` and refuses an empty model on a non-default backend
  (`texts.modelRequired`); a pool's `resolveModel()` without a model answers
  `m4Texts.subscriptionModelRequired` unless the spec has `modelId`. M4's resolver
  `subscriptionEffort` (appended after it, H-6) takes `resolved.reasoningEffort ??
  options.reasoningEffort`; on a pool it calls `resolveEffort({ modelId, reasoningEffort? })` and
  stores the answer (absent: the model's `defaultReasoningEffort`, else none); on any other
  backend an effort is refused with `m4Texts.effortNotSupported`. `factory.js` copies
  `reasoningEffort` into `SessionConfig` (H-7); the session sends it in `RoundRequest.options`
  already (M2 `turn.js`). Backend, model and effort never change afterwards (R4-22).

---

## 6. Accounts (W4.5)

Port of hosted-agent `account-oracle.js` and `account.js` (normalisation) and Fae
`session/account-tool.js` (rendering), adapter-side only:

- **Sources** (R4-84): `observed` = a reading from this incarnation (response headers of every
  attempt, or an on-demand usage read: claude-sandbox `subscription-auth.js` `makeClaudeAccountRead`
  and `readingFromClaudeUsage`, codex-sandbox `subscription-auth.js` for Codex); `remembered` = a
  reading loaded from `readings.json` (an earlier incarnation's, or this one's after a failed
  refresh); `declared` = the member's `DeclaredProfile`; `unavailable` = none of these.
- **Push, never poll** (R4-85): every new reading or member state change publishes one
  `AccountsBatch` (the whole view, `rev` + 1) on an adapter-side channel with M2's channel
  bounds (`channelLimits`); `Accounts.watch(rev?)` subscribes (gateway, in process). Zero vat
  deliveries per change and per viewer. `refresh(pool?)` reads the providers now (on demand
  only; never on a first read).
- **Abandoned viewers** (M3 closes only its own `Live` subscriptions at connection close, M3
  4.5): the accounts channel itself evicts them. A `next()` that has waited
  `accountsKeepaliveMs` (30 s) with no change answers the current view again (same `rev`), so a
  live page calls `next()` at least every 30 s; a subscriber with no `next()` call for
  `accountsIdleMs` (60 s) is idle and evicted (closed; a later `next()` rejects with
  `m4Texts.accountsWatchClosed`; the page calls `watch(lastRev)`). A `watch` that meets the
  subscriber cap (`channelLimits.subscribersPerSession`, 32) evicts the oldest idle subscriber
  first and refuses only when none is idle. Times come from the injected `timers` (tests use a
  fake clock). W4.5 test: 40 watchers opened and abandoned (one `next()` each, then nothing),
  in batches of 16, 16 and 8 with the fake clock moved 61 s after each batch; then a new `watch`
  succeeds and receives the next change; and 32 live watchers (each keeps a `next()` waiting)
  make a 33rd `watch` fail (no idle one to evict).
- **`accountStatus`** (R3-35, R4-84): an adapter tool (`{ refresh?: boolean }`) offered by the
  pool kinds and both API kinds; its text follows Fae's rendering (selection mode, per account
  plan, state, windows with remaining, percent used and reset, each labelled with its provenance;
  the session's token usage, not attributed; no cost; no reset authority). Session usage comes
  from one `E(session).getUsage()` (one session delivery per tool call). On an API backend it
  says `m4Texts.noSubscriptionAccounts` (R4-91: the API account profile is unavailable).
  **How the model is offered it** (D-M4-9 as amended at the cross-lane merge, XC): its
  `adapterTools` row carries `description: accountStatusDescription`, the agent host's `open`
  passes it in the tool's `AdapterToolEntry` (`{ name, tool, description? }`; the shape admits
  the optional `description: ToolDescription`), and the session offers every port tool that has
  a description and no static tool-table entry of its name through one generic entry
  (`adapterToolEntries` in `guest/session/tool-table.js`: `site: 'adapter'`, `execute` sends `{
  opId, args }` to that port's tool object; m5-interfaces.md 2.8 S1). A static entry is never
  shadowed and a granted tool of the same name is `refused-builtin`. Acceptance 7's model part
  (`m4-accounts.test.js`): the first request offers `accountStatus`, the model calls it, and the
  next request carries the rendered text as a tool result that is not an error.
- **Banked reset credits** (R4-86): shown read-only with their expiry; no redeem (decision 8).
- **Readings file**: `<state>/agent-host/subscriptions/readings.json`, `{ format:
  'thixotrope-harness-readings-1', members: [{ key, provider, reading }] }`, no token, no header
  value, no body; written temp + rename + fsync at most every 5 s.

---

## 7. Renewal and sign-in (W4.4; R7-16, R7-29, R7-30, R8-35..R8-38)

- **Credential** (`credentials.js`): the member's Secret holds one JSON credential `{ version:
  1, accessToken, refreshToken?, expiresAtMs, accountId?, pendingRefresh? }`, validated at each
  read (claude-sandbox and codex-sandbox `subscription-auth.js` `import*Subscription` for the
  accepted inputs); over 8,192 bytes, unparsable or of the wrong provider: code `INVALID`. Never
  logged; errors carry codes only.
- **Renewal** (`renewal.js`, port of hosted-agent `provider-broker.js` refresh and
  `managed-renewable-credentials.js`): one `MemberCredential` per member and incarnation, holding
  only `credentialFor(key)` (W-5 fixed). Renewal can also run at session creation, at the
  creation's catalogue read (J-9643). When the access token is within `refreshSkewMs` of expiry,
  or after a 401 for that exact credential: single-flight per member; **re-read** inside the
  flight (a credential renewed by another flight or replaced by the operator wins); a credential
  already carrying `pendingRefresh` fails closed with code `CONSUMED`
  (`m4Texts.credentialConsumed`); otherwise **write-ahead**: replace the value with the same
  credential plus `pendingRefresh: { startedAtMs }` conditioned on the generation read, then POST
  the refresh-token grant to the provider's token endpoint (`PoolSpec.tokenUrl` in tests,
  redirects refused), then write the answer (a missing refresh token keeps the old one, RFC 6749
  6) conditioned on the intent's generation. An answer naming another `accountId` is refused
  (`INVALID`). A failure the request provably never left (connection refused before sending)
  undoes the intent; any other failure leaves it (fail closed). A concurrent renewal elsewhere
  fails `GENERATION_CONFLICT` and the loser re-reads (R7-30). A renewal never runs on a first
  account read (it is on the round's path only).
- **Sign-in** (`scripts/subscription-login.mjs`, `[real-provider]`, owner-run): the operator
  runs it against the control socket; it prints the provider's authorization URL (PKCE), reads the
  pasted `code#state`, exchanges it, and writes the credential through
  `SecretsAdmin.openWriter()` -> `SecretWriter.replace(secret, sealedBox)` (sealed to the
  adapter's key, so the hub carries ciphertext only, D-6); it never writes a file. Tests run it
  against the fake OAuth server.
- **Large values from the command line** (same script, `--value-file <path> --secret-label
  <label>`, exported as `writeValue`): reads a UTF-8 file of at most M2's `secretValueBytes`
  (1,048,576 bytes), finds the Secret by label through `SecretsAdmin.list` (the CLI boundary,
  F.2 c), and writes it as a sealed box with `SecretWriter.replace(secret, sealedBox,
  expectedGeneration)` (M2's CLI path, "sealed box through the hub"). This is where the Secrets
  panel sends a person whose value is over `browserSecretBytes`.

---

## 8. What M4 takes from M2

Exact objects and methods, as built at `3588cab190` (check against M2 as it stands after its
merge):

| object / module | used | by |
|---|---|---|
| `durable.js`: `withOps`, `whenBound`, `archiveKeyOf`, `secretRecords`, `secretList`, `grantRecords`, the sink exo, `makeSecret` class, `secretsAdmin` exo | the part is constructed with them (H-2) | W4.1 |
| `AgentHostSink.resolveSecrets([Secret])` | the audit reader's `secret` filter | W4.4 |
| `ops.open({ backend, spec, session, archiveKey })`, `listModels`, `resolveModel` | pool backends forward with a pool spec (ops guard widened, H-3) | W4.1, W4.6 |
| `AH/index.js` `backendKinds`, `adapterTools`, `backendState`, the open handler's per-session tool entries, `secrets()` | hook entries and the lines of H-4 | W4.6 |
| `AH/providers/round.js` `runProviderRound`, `ProviderFailure`, `makeRoundControl`, `readProviderKey` pattern, `systemTextOf` | the pool provider's round | W4.6 |
| `AH/providers/retry.js` `withRetries`, `sleeperOf` | overload schedules | W4.3 |
| `AH/providers/{http,sse}.js` `postJson`, `getJson`, `retryAfterMs`, `bodyChunks`, `parseSse` | wire clients | W4.3 |
| `AH/providers/anthropic.js` `anthropicMessages`, `anthropicTools`, `anthropicAttempt`, `anthropicBody`, `textDigest` | Claude Messages (two additive options, H-14) | W4.3 |
| `AH/providers/catalog.js` `CATALOG_FRESH_MS`, `CATALOG_MAX_AGE_MS`, `CATALOG_RETRY_MS`, `CATALOG_READ_TIMEOUT_MS`, `cutUnits` | pool catalogue | W4.3 |
| `AH/secrets/{store,manager,writer,seal}.js` | store accessor, audit, description (H-5), sealed writes | W4.4, W4.6 |
| `AH/channels.js` / `list-channel.js` patterns and `channelLimits` | the accounts channel | W4.5 |
| `AH/endpoint.js` | `provider.startRound(req, channel, prepare, owner)` with `owner` = Session | W4.6 |
| `guest/factory/session-options.js` `optionResolvers`, `catalogueModel`, `NOT_YET` | effort resolver (H-6) | W4.1 |
| `guest/factory/factory.js` creation fields | `reasoningEffort` copy (H-7) | W4.1 |
| `shapes`: `TurnPorts`, `ModelRequest`, `ModelPage`, `ResolvedModel`, `ModelRow`, `SecretPage`, `SecretInfo`, `NewSecret`, `AuditEvent`, `AuditPage`, `Label`, `Id`, `Cursor`, `ModelId`; `textOf.secretFailed`, `texts.catalogUnavailable`, `texts.modelRequired`, `secretCodes` | guards and texts | all |
| `SessionConfig.reasoningEffort`, `RoundRequest.options.reasoningEffort` | the effort reaches the provider | W4.6 |
| `test/template` (`ensureTemplate`, `startFromTemplate`), `perf/_harness.mjs` (`runPerf`, `provision`), `scripts/provision-steps.js` | integration and perf | W4.8 |

**Assumptions M2's contract does not settle** (to check after M2's merge; each is in the
report's `assumesFromM2`):

1. W2.9 folds `m2Interfaces` into `interfaces` without changing `SecretsAdmin`, `Secret` or
   `BackendInfo`; `interfaces-m4.js` copies M2's `SecretsAdmin` and `Secret` method guards, and
   W4.1's test compares them with `interfaces.SecretsAdmin` / `interfaces.Secret` (equal at
   `3588cab190`).
2. The ops facet's `open`, `listModels` and `resolveModel` stay the only manager -> adapter paths
   a backend needs, and their request guard is the one `spec` pattern H-3 widens.
3. `endpoint.js` keeps passing the Session presence as the provider's fourth `startRound`
   argument (`owner`).
4. `makeSecretsOps` keeps one store instance per incarnation, so `credentialFor` and the
   providers' `readKey` see the same generations.
5. An adapter tool's result over `inlineBytes` is staged by the adapter-tool path as M1b 5.2
   says (the `accountStatus` text can reach 32,768 units).
6. `HarnessRoot.configure({ backends })` accepts any `Backend` presence (pool backends are
   added there by provisioning; the factory never inspects a backend's kind except through
   `describe()`).
7. The secrets store keeps audit events with times that can page backwards (`before`), and
   `audit` can be widened to 1,000 without a format change.
8. M2's `m2-*` tests do not assert the exact tool list of API sessions; adding `accountStatus`
   to the API kinds' `tools` (H-14) changes their projected tool lists. If one does, W4.6 adapts
   that test's expectation (not its intent) and reports it.

---

## 9. Seams with M3 and M5

### 9.1 What M4 needs from M3 (the UI and gateway lane)

M3's seams are **directory registries**: M4 adds files and edits none of M3's collectors
(`ui/build.mjs`, `ui/src/features.js`, `AH/gateway/extensions.js`, `AH/gateway/vocabulary.js`
are M3's and nobody else edits them). M4 uses them in W4.6 (one gateway extension file) and W4.7
(two feature files), each written against M3's W3.0 contract (`contract-m3.js` typedefs
`UiFeature`, `FeatureContext`, `GatewayExtension`, `LargeCall`, `GatewayContext`).

1. **UI features** (M3 6.2: `ui/build.mjs` collects every `ui/src/*/feature.js` in
   directory-name order; each exports `feature`, a `UiFeature` `{ id, slot, label?, order?,
   when?, component, send? }` or, per M3's 6.2 as settled by the PM, an array of them):
   - `ui/src/secrets/feature.js`: `feature = { id: 'secrets', slot: 'app.panel', label:
     'Secrets', component }` (P-58, R6-67, R7-26).
   - `ui/src/accounts/feature.js`: `feature = [{ id: 'accounts', slot: 'app.panel', label:
     'Subscriptions', component }, { id: 'account-chip', slot: 'statusbar.chip', when, component
     }]` (R6-54; the chip shows the active session's pool accounts from
     `Accounts.forSession(session)`, live through `Accounts.watch`; `when` is false when the
     session's backend is not a pool). **If M3's collector takes one feature per file**, the chip
     moves unchanged to `ui/src/account-chip/feature.js` (W4.7 still owns it) and
     `accounts/feature.js` exports the panel alone.
   Components reach the daemon only through `FeatureContext.powers` (`Operator` ->
   `getSecrets()` -> M4 `SecretsAdmin`) and `context.call(fn)`; no feature imports another
   lane's directory.
2. **Key-guard vocabulary** (M3 4.4 rule 4, 6.3): M3's `GW/vocabulary.js` loads every
   `guest/lib/interfaces-m<N>.js` by file name and admits the record keys of the patterns its
   `vocabularyShapes()` answers (a file without the export is logged and skipped). M4's
   `interfaces-m4.js` exports `vocabularyShapes = () => harden([...Object.values(m4Shapes),
   ...Object.values(m4Interfaces)])` (W4.0 follow-up, done). Without it every browser call
   carrying an M4 record key (`catalog` pages, `setDescription`, `makeMember`, `makePool`,
   `AuditQuery`, ...) is refused `unexpectedField`. Method checking stays in each exo's own
   guard; the vocabulary only bounds record keys.
3. **Gateway extension for large secret writes** (M3 4.4 rule 3, 6.1): the frame guard refuses a
   call body over `frameBytes` (24,576) unless its target and method are a registered
   `LargeCall`. W4.6 adds `AH/gateway/extensions/m4-secrets.js`:

   ```js
   export const gatewayExtension = harden({
     name: 'm4-secrets',
     largeCalls: [{ target: context => context.secretWriter(), methods: ['replace'] }],
   });
   ```

   `context.secretWriter()` is the adapter's one `SecretWriter` of this incarnation (M3 adds
   `secretWriter` to `GatewayContext`, fed by the `index.js` line of its own H-seam; the bridge
   compares identity with the target it resolves). Only `wsMessageBytes` (1,048,576) then holds,
   and a value plus its CapTP JSON envelope must fit it: the browser bound is
   `m4Limits.browserSecretBytes` = 1,040,384 bytes (1 MiB less 8 KiB). The Secrets panel
   measures `new TextEncoder().encode(JSON.stringify(value)).length` before sending and over the
   bound refuses in the page with `m4Texts.secretTooLargeForBrowser`, which names the CLI path
   (7, `scripts/subscription-login.mjs --value-file`); nothing is sent. A non-UTF-8 file is
   refused with `m4Texts.secretNotText` (D-M4-7).
4. **Adapter-local objects resolve locally in the gateway**: `Accounts`, `AccountsSubscription`,
   `AuditReader` and `SecretWriter` returned through the manager are this adapter's own exports;
   M3's bridge calls them in process (M3 6.4: pass-through, `SecretWriter` adapter-local), so
   secret values typed in the browser never cross the hub (D-6).
5. **Browser test harness** (M3 W3.8, M3 17): M4's browser files are written against
   `startBrowserGateway({ template, provision? }) -> { page, url, client, close() }` from M3's
   `test/browser/_harness.mjs`; M4's component tests (W4.7) use M3's
   `test/unit/_m3-fake-powers.js` (`makeFakePowers`). Ownership in `test/browser/`: M3 owns
   `_harness.mjs` and `m3-*.mjs`, M4 owns `m4-*.mjs`, M5 owns `m5-*.mjs`. W4.7's component tests
   run once M3's group A (W3.4) is on the shared branch; acceptance 14 (browser) runs after M3 is
   merged; no other M4 acceptance waits on M3.
6. **M3 does not extend `SecretsAdmin` or `Secret`** (M4 owns their M4 versions) and does not
   change the ops guard's `spec` pattern. M3 imports the encrypt, decrypt and wrapping-key helpers
   of `AH/secrets/{store,manager}.js` read-only; M4 is those files' owner (H-5).
7. **Accounts subscriptions are not closed by M3** at connection close (only its `Live`
   facade's are, M3 4.5); M4's accounts channel evicts idle viewers itself (6).

### 9.2 What M4 offers M3

- `vocabularyShapes()` (and `m4Interfaces`, `m4Shapes`, `m4MethodNames`) for its key guard and
  its UI types.
- `AccountsBatch` events for any M3 view that wants them; the accounts channel uses M2's channel
  bounds, is subscribed in process like `Live`, and evicts idle viewers (6).

### 9.3 What M4 needs from M5 (presets, prompts, tools, grants)

1. M5 fills preset defaults into the create options before the resolvers
   (`catalog.withDefaults`); `subscriptionEffort` reads `resolved.reasoningEffort`, then
   `options.reasoningEffort`. M4 only appends its resolver at the end of `optionResolvers` (H-6).
2. M5 does not remove `reasoningEffort` handling from `session-options.js` (M4 removes it from
   `NOT_YET`, H-6).

### 9.4 What M4 offers M5

- `accountStatus` is an adapter tool: it adds no entry to `guest/session/tool-table.js`, so M5's
  object tools and the protected built-in names (P-65) are unaffected; M5's prompt composition may
  name it in the tool part if it lists adapter tools.
- Pool backends are ordinary `Backend` presences: a preset may carry one as its default backend.
- M4 adds no method to `Operator`, `Session` or `SessionFactory` and exports no `m4Extensions`:
  M5's `extendInterface` lines for those interfaces have no M4 part, and `factory.js` and
  `session.js` get no M4 edit besides H-7's one line in `factory.js`.
- Pool rounds read the system text through `systemTextOf` once per round (5.2), so M5's widening
  of `RoundRequest.system` reaches both pool kinds with no M4 edit; after the M5 merge the case
  is in `m4-catalog.test.js` (17, acceptance 13; XB): a turn with an attachment carries
  `[stored prompt, R4-29 line]`.
- The `reasoningEffort` lift out of `NOT_YET` (H-6) and the `BackendKind` widening (H-1) are
  what M5's preset efforts need; H-1 may be merged early as a contract follow-up.

---

## 10. Restart, crash and retry

Dormant after restart (D-5): M4 registers no start listener and wakes nothing. Pools, marks and
served records load lazily at a pool's first use in an incarnation (one manager crank); readings
load lazily at the first `Accounts` use or pool round; the catalogue cache starts empty.

| durable thing | what a SIGKILL can leave | after restart | kill points to test (W4.8) |
|---|---|---|---|
| member, pool (manager heap) | the creating call broke before or after its crank | the operator retries; `makeMember` / `makePool` are idempotent by label and argument | K-1: SIGKILL right after `makePool` was sent; restart; `makePool` again answers a Backend that works and `listPools` shows one pool |
| mark | the adapter saw the 429 but the manager crank of `poolChanged` did not commit | the mark is missing: the member is tried once more at the next round, refuses again and is marked again; no round is retried | K-2: SIGKILL between member A's 429 and member B's request (before `dispatching` of B is irrelevant: the round is already dispatched) -> the turn is outcome-unknown; the fake server saw one request to A and at most one to B for that round ("none to B" is not placeable from outside, J-9644), none after restart for it |
| served stamp | up to 60 s of stamps | stickiness may move a session once (cold cache) | - (recorded, not tested) |
| pool round | a request in flight to some member | M2 recovery: `Dispatched` recorded -> outcome-unknown, never re-sent | K-3: SIGKILL mid-stream from member B; K-4: SIGKILL after B's request left and before its first byte: in both, the fake server saw exactly one request per member attempt and none for that round after restart |
| credential renewal | an intent written, or a refresh token presented and its answer lost | the credential carries `pendingRefresh`: the member is `unusable` with code `CONSUMED` (fail closed) until the operator signs in again; the other members serve | K-5: SIGKILL after the intent write and before the POST; K-6: SIGKILL after the token endpoint answered and before the write-back (the fake OAuth server holds its answer until killed): the token endpoint saw at most one refresh for that token across the restart; the member reports `CONSUMED`; a turn succeeds on the other member |
| readings file | the last <= 5 s of readings | older `remembered` readings | - |
| secret description | the manager crank committed, the store's copy not | labels in old audit events show the old description; the catalogue shows the new one (the manager is the system of record) | - |

Retries: a member attempt is retried only on overload and only before delivery (5.2, 5.3); the
renewal is never retried automatically after an uncertain POST; the manager's `withOps` retries
a manager -> adapter call once after a retired break (M2), which for `poolState`,
`describeSecrets` and `auditReader` is safe (reads); `setSecretDescription` is idempotent.

---

## 11. Security

| holder | reaches | cannot reach |
|---|---|---|
| session vat | its `Backend` (pool or not): `describe`, `open`, `listModels`, `resolveModel`, `resolveEffort`; its ports; the `accountStatus` tool (read-only text) | any `PoolMember`, `Secret`, `ReadGrant`, `SecretsAdmin`, `SubscriptionsAdmin`, `Accounts`, a credential, another session's pool state (`Accounts.forSession` is gateway-local, not on its ports) |
| exec vat | what the session gives its `powers` (M5) | as the session; it never holds the Backend |
| model | `accountStatus` text: plans, windows, provenance, unattributed usage | credentials, member objects, refresh, redeem |
| browser page (operator, signed in) | `Operator` -> `SecretsAdmin` (M4) -> catalogue, writer (in process), audit reader (in process), `Secret` admin, `SubscriptionsAdmin`, `Accounts` | a secret value (no method returns one, R7-26) |
| operator (control socket) | as the browser, plus `AgentHostAdmin` | a secret value over the control socket (the CLI path writes sealed boxes only) |
| adapter | everything above plus the store and the wrapping key | - (unconfined Node, native.md 5) |

- **Secrets never in a vat, the hub, a transcript, a log or a journal** (D-6): credentials are read
  and written only in the adapter (`credentialFor`); the manager holds Secret identities and store
  keys; `PoolState` carries keys, never values; the sign-in helper sends sealed boxes; the browser
  writer is called in process (the `largeCalls` exemption of `m4-secrets.js` keeps it so for
  values up to `browserSecretBytes`); failure texts and the event log carry fixed texts and codes only;
  `readings.json` holds no token. Acceptance 15 greps for every test credential value.
- **Renewal holds one key's accessor** (W-5 fixed): `credentialFor(key)`, not the store or the
  Secrets manager.
- **Redirects refused** on every provider and token request (R7-29); the authorization header is
  built in the request and never logged.
- **The key guard** (M3) refuses undeclared record keys on M4's methods; the guards bound every
  string and array (`limits-m4.js`).
- **Reachability check** (acceptance 5): object-granular reachability is a core request (CC-060);
  the harness checks the reachable interface closure from the session's capabilities over the
  guards plus the session and exec vats' hub holdings by origin (section 19).

---

## 12. Module entry points

"vat" = guest rules; "Node" = adapter or tests. Every unit exports exactly these (more is
allowed; names and signatures are fixed). Types: `resources/agent-host/impl/subscriptions/types.js`.

### W4.0 (exists)

| file | export |
|---|---|
| `guest/lib/interfaces-m4.js` (vat and Node) | `m4Shapes`, `m4Interfaces`, `m4MethodNames`, `m4SinkMethodGuards()`, `m4SinkMethodNames`, `vocabularyShapes()` (M3's key guard, 9.1 item 2); re-exports of `texts-m4.js` and `limits-m4.js` |
| `guest/lib/texts-m4.js` (vat and Node) | `m4Texts`, `m4TextOf`, `codexExplanations`, `m4Codes`, `poolKinds`, `providerOfKind` |
| `guest/lib/limits-m4.js` (vat and Node) | `m4Limits` |
| `resources/agent-host/impl/subscriptions/types.js` (Node) | JSDoc types only |

### W4.1 (vat parts and Node config)

| file | export | signature |
|---|---|---|
| `resources/agent-host/durable-subscriptions.js` (manager vat) | `makeSubscriptionsPart(deps)` | `deps = { withOps, whenBound, archiveKeyOf, secretRecords, secretList: () => any[] }` -> `{ admin: SubscriptionsAdmin, secretsAdminMethods: { catalog, auditReader, subscriptions }, secretMethods: { setDescription }, sinkMethods: { poolState, poolChanged, poolOf } }` |
| same | `forwardSinkMethods(getPart)` | `{ poolState, poolChanged, poolOf }` calling `getPart().sinkMethods` at call time (the sink is made before the part, H-2) |
| `guest/factory/subscription-options.js` (vat, factory) | `subscriptionEffort` | an `OptionResolver` (M2 `session-options.js`) |
| `config/defaults-m4.js` (Node) | `subscriptionDefaults` | frozen: `cacheLifetimeMs` 300,000; `servedRecords` 256; `servedStampMs` 60,000; `servedFlushMs` 1,000; `backoffStartMs` 60,000; `backoffMaxMs` 3,600,000; `undatedBlockMs` 3,600,000; `requestTimeoutMs` 3,600,000; `claudeMaxOutputTokens` 16,384; `claudeContextLength` 200,000 (D-M4-5); `codexOverloadDelaysMs` [5,000, 10,000, 20,000, 40,000, 60,000]; `claudeOverloadDelaysMs` the same (D-M4-4); `refreshSkewMs` 120,000; `readingsFlushMs` 5,000; `credentialBytes` 8,192; `auditReaderMax` 1,000; `auditReaderDefault` 100 |

### W4.2 (Node)

| file | export | signature |
|---|---|---|
| `AH/subscriptions/pool.js` | `standingOf(reading, nowMs)`, `makeRefusalMarks({ initial, onChange, settings })`, `selectMembers({ members, readingOf, marks, last, cacheLifetimeMs, nowMs })`, `makePoolCore({ members, readingOf, cacheLifetimeMs, now, initial, onChange, settings }) -> PoolCore` | 5.1, `types.js` |
| `AH/subscriptions/rate-limit-headers.js` | `readingFromHeaders(get, nowMs) -> Reading \| undefined`, `isExhausted(status, get) -> { untilMs } \| undefined` | port of hosted-agent `rate-limit-headers.js` |
| `AH/subscriptions/pool-state.js` | `makePoolStateBridge({ sink, backend, timers, settings }) -> PoolStateBridge` | 5.1 |

### W4.3 (Node)

| file | export | signature |
|---|---|---|
| `AH/subscriptions/messages.js` | `claudeAttempt: WireAttempt`, `claudeBody(request)`, `claudeEfforts(modelId)` | 5.3 |
| `AH/subscriptions/responses.js` | `codexAttempt: WireAttempt`, `codexBody(request)`, `codexEffort(effort)` | 5.3 |
| `AH/subscriptions/catalog.js` | `makePoolCatalog({ fetch?, now?, readCredential: (member) => Promise<Credential>, members: (backend, spec) => Promise<MemberEntry[]> }) -> { listModels(request), resolveModel(request), efforts(request) }` | 5.4; the request shapes of M2's `makeCatalog` |
| `AH/providers/anthropic.js` (edit, H-14) | `anthropicAttempt({ ..., headers? })`, `anthropicBody({ ..., extras? })` | additive |
| `test/fixtures/fake-subscription-server.mjs` | `startFakeSubscriptionServer({ fixtures? }) -> { url, close(), requests(), setPlan(plan) }` | routes: Messages SSE, Responses SSE, model lists, usage reads; plans as M2 8.3 (status + headers, SSE file, disconnect, hang); `requests()` reports header names present, never values |

### W4.4 (Node)

| file | export | signature |
|---|---|---|
| `AH/subscriptions/credentials.js` | `parseCredential(text, provider) -> Credential` (throws a code), `formatCredential(credential) -> string` | 7 |
| `AH/subscriptions/renewal.js` | `makeMemberCredential({ access: CredentialAccess, provider, tokenUrl?, fetch?, now, settings }) -> MemberCredential` | 7 |
| `AH/secrets/credential-access.js` | `makeCredentialAccess({ store, key }) -> CredentialAccess` | 4.2 |
| `AH/secrets/audit.js` | `makeAuditReader({ store, resolveSecret }) -> AuditReader` | 4.1 |
| `AH/secrets/catalog.js` | `describeKeys({ store, keys }) -> Promise<(SecretKeyInfo)[]>` | 4.1 |
| `AH/secrets/{store,manager}.js` (edits, H-5) | `store.audit({ key?, limit, before? })`, `store.setDescription(key, d)`; `makeSecretsOps(...).credentialFor(key)` | 4.2 |
| `test/fixtures/fake-oauth-server.mjs` | `startFakeOAuthServer() -> { url, close(), requests(), setPlan(plan), hold() }` | token endpoint (refresh grant, rotating refresh tokens), authorization-code exchange for the sign-in helper; `hold()` keeps the next answer until released or killed (K-6) |

### W4.5 (Node)

| file | export | signature |
|---|---|---|
| `AH/subscriptions/accounts.js` | `makeAccounts({ file, timers, now, readers, settings }) -> AccountsCore` | 6 |
| `AH/subscriptions/account-file.js` | `loadReadings(file)`, `makeReadingsWriter({ file, timers, flushMs })` | 6 |
| `AH/subscriptions/account-tool.js` | `makeAccountStatusTool({ subscriptions, backend, session, blobs }) -> AdapterTool`; `accountStatusDescription` | 6; the `adapterTools` entry `{ name: 'accountStatus', makeTool }` |

### W4.6 (Node)

| file | export | signature |
|---|---|---|
| `AH/subscriptions/provider.js` | `makePoolProvider({ label, spec, backend, subscriptions, timers, log, blobs, fetch? })` (the options `backendState` passes after H-4 (d); `blobs` is the adapter's store, read per owner by `systemTextOf`); `claudePoolKind`, `codexPoolKind` (`backendKinds` entries, `tools: ['accountStatus']`) | 5.2 |
| `AH/subscriptions/index.js` | `makeSubscriptions({ sink: () => any, secrets: () => any, stateDir: () => string, timers, fetch? }) -> Subscriptions` | `types.js` |
| `AH/subscriptions/credential-ops.js` | `makeCredentialOps({ secrets, accounts, resolveSecret }) -> CredentialOps` | 3.2 |
| `scripts/subscription-login.mjs` | `signIn({ client, secret, provider, authorizeUrl?, tokenUrl?, prompt })`, `writeValue({ client, secret, value, expectedGeneration? })`; CLI (`--value-file`) | 7 |
| `AH/gateway/extensions/m4-secrets.js` | `gatewayExtension` (`GatewayExtension`, `contract-m3.js`) | 9.1 item 3, exactly as written there |

### W4.7 (browser)

| file | export |
|---|---|
| `ui/src/secrets/feature.js` | `feature` (`UiFeature`, slot `app.panel`, label `Secrets`) |
| `ui/src/accounts/feature.js` | `feature` (array: Subscriptions panel `app.panel`, account chip `statusbar.chip`; or the panel alone if the chip moves to `ui/src/account-chip/feature.js`, 9.1 item 1) |

Other files under those directories: free layout (Preact components as M3 9.2's client rules).

### W4.8

Integration and perf files (sections 17, 18); no library exports.

---

## 13. Fixed texts

Exact strings are in `texts-m4.js`; W4.1's test checks them.

| constant | text | source |
|---|---|---|
| `m4Texts.subscriptionsExhausted`, `m4TextOf.subscriptionsExhausted(resetsAt?)` | `Provider subscriptions exhausted` [`; the first member is expected back at <ISO>`] | R4-25; G-07 improvement (harness) |
| `m4Texts.claudeInferenceFailed` | `Claude subscription inference failed` | R4-76 |
| `m4TextOf.subscriptionHttp(n)` | `Subscription inference failed (HTTP <n>)` | R4-76 |
| `m4Texts.emptyMessagesOutput` | `Empty Messages assistant output` | R4-76 |
| `m4Texts.emptyResponsesOutput` | `Empty Responses assistant output` | harness |
| `m4TextOf.responsesFailed(type, facts, explanation?)`, `codexExplanations` | `Subscription inference ended unsuccessfully (<type>[; facts])[ <explanation>]` | lal `subscription-responses.js` |
| `m4Texts.unsupportedEffort` | `Unsupported reasoning effort for Fae subscription` | Fae `src/subscription-models.js` (R4-23) |
| `m4Texts.effortNotSupported`, `subscriptionModelRequired`, `noUsableMember`, `memberConflict`, `poolConflict`, `memberKind`, `unknownMember`, `unknownPool`, `retired`, `credentialConsumed`, `credentialExpired`, `credentialInvalid`, `credentialRejected`, `noSubscriptionAccounts` | see `texts-m4.js` | harness |
| `m4Texts.secretTooLargeForBrowser` | `This value is too large to send from the browser; write it from the command line with scripts/subscription-login.mjs --value-file, which sends a sealed box` | harness (9.1 item 3) |
| `m4Texts.secretNotText` | `This file is not text; secrets hold text` | harness (D-M4-7) |
| `m4Texts.accountsWatchClosed` | `This accounts watch is closed; watch again` | harness (6) |
| `m4Texts.provenance*` | `observed`, `declared`, `remembered`, `unavailable` | R4-84 |
| `m4TextOf.memberFailed(label, code)` | `Subscription member "<label>" failed: "<code>"` | harness (event log and account state; codes `m4Codes`) |
| existing, used | `textOf.secretFailed(code)`, `texts.catalogUnavailable`, `texts.modelRequired`, `textOf.afterAttempts` | M2 |

---

## 14. Hook tables

| table | M4 entries | unit |
|---|---|---|
| `AH/index.js` `backendKinds` | `claudePoolKind`, `codexPoolKind` | W4.6 |
| `AH/index.js` `adapterTools` | `{ name: 'accountStatus', makeTool, description: accountStatusDescription }` (the description since XC: an adapter tool without a static tool-table entry is offered to the model only with one) | W4.6, XC |
| `guest/factory/session-options.js` `optionResolvers` | `subscriptionEffort` (last) | W4.1 |
| `scripts/provision-steps.js` | `subscriptions`: from the provisioning options' `subscriptions: [{ kind, label, members: [{ label, provider, secretLabel, weight? }], contextLength?, ... }]`, find each Secret by label (provisioning boundary, rule 2), `makeMember`, `makePool`, add the pool to `HarnessSettings.backends`; idempotent; never writes a secret value (R8-38) | W4.6 |
| M3's UI registry `ui/src/<dir>/feature.js` (new files, no edit) | `secrets/`, `accounts/` (and `account-chip/` if needed) | W4.7 |
| M3's gateway registry `AH/gateway/extensions/<name>.js` (new file, no edit) | `m4-secrets.js` | W4.6 |
| M3's vocabulary loader (reads `guest/lib/interfaces-m<N>.js`, no edit) | `vocabularyShapes()` in `interfaces-m4.js` | W4.0 (done) |
| `guest/session/tool-table.js`, `turn-hooks.js`, `holds-table.js`, `services.js`, `projection-hooks.js`, `channel-taps.js` | none (XC's generic adapter-tool entry in `tool-table.js` serves `accountStatus` with no M4 row there) | - |

---

## 15. Merge hotspots

Every edit M4 makes to a file M3 or M5 may also edit, with the exact seam. All are additive; the
PM resolves adjacent-line conflicts as for hook tables.

| id | file (shared with) | unit | exact seam |
|---|---|---|---|
| H-1 | `guest/lib/interfaces.js` (M3, M5) | W4.1 | one line changed: `BackendKind: () => M.or('scripted', 'openrouter', 'anthropic', 'claude-pool', 'codex-pool'),` (plus its comment). Nothing else in this file (M4's guards are in `interfaces-m4.js`). |
| H-2 | `resources/agent-host/durable.js` (M3: `serveGateway`, sign-in) | W4.1 | (a) one import line from `./durable-subscriptions.js` and `m4Interfaces` from `interfaces-m4.js`; (b) last entry of the `AgentHostSink` guard: `...m4SinkMethodGuards(),`; (c) last entry of the sink's methods: `...forwardSinkMethods(() => subscriptions),`; (d) after `let secretList = [];`: `const subscriptions = makeSubscriptionsPart({ withOps, whenBound, archiveKeyOf, secretRecords, secretList: () => secretList });`; (e) `makeSecret`: guard `m4Interfaces.Secret` and last method entry `...subscriptions.secretMethods,`; (f) `secretsAdmin`: guard `m4Interfaces.SecretsAdmin` and last method entry `...subscriptions.secretsAdminMethods,`. `AgentHostAdmin` is not touched. |
| H-3 | `AH/attach.js` (M3: gateway ops) | W4.6 | (a) import `m4Shapes`; (b) in `makeOpsInterface`: `const spec = M.or(shapes.BackendSpec, m4Shapes.PoolSpec);` and the two `spec: shapes.BackendSpec` become `spec`; (c) last guard entry `credentials: M.call().returns(M.remotable('CredentialOps')),`; (d) `'credentials'` appended to `M2_FORWARDS`; (e) one `@property` line in `OpsHandlers` |
| H-4 | `AH/index.js` (M3: gateway handlers) | W4.6 | (a) imports of `./subscriptions/index.js`, `./subscriptions/provider.js` (kinds), `./subscriptions/account-tool.js`; (b) hook entries (section 14); (c) after the `secrets` helper: `const subscriptions = makeSubscriptions({ sink: () => sink, secrets, stateDir: () => dirname(dirname(typeof blobDir === 'function' ? blobDir() : blobDir)), timers, ...(fetch === undefined ? {} : { fetch }) });` (the `stateDir` expression is the one the `secrets` helper already uses; `fetch` is `makeHarnessAgentHost`'s existing option; tests point pools at the fake servers through the pool spec's URLs); (d) in `backendState`'s `makeProvider` call: `backend, subscriptions,` added to the options, and the `BackendKind.makeProvider` `@property` options type gains `backend?: any, subscriptions?: any`; (e) in the open handler's `entry.makeTool(...)` call: `backend, session, subscriptions` added to the options, and the `AdapterToolKind.makeTool` `@property` options type gains the same three; (f) ops handler `credentials: () => subscriptions.credentialOps,` after `secretWriter`; (g) `listModels` and `resolveModel` handlers: `(subscriptions.handles(spec) ? subscriptions.catalog : models)` in place of `models` |
| H-5 | `AH/secrets/{store,manager}.js` (M3 if its sign-in secret needs store access) | W4.4 | `store.audit` gains `before` and a 1,000 limit; `store.setDescription(key, description)` added after `describe`; `makeSecretsOps` returns `credentialFor(key)` as its last entry |
| H-6 | `guest/factory/session-options.js` (M5: preset resolvers) | W4.1 | (a) `const NOT_YET = harden(['networkPolicy']);` (`reasoningEffort` removed); (b) one import line; (c) `subscriptionEffort,` appended last in `optionResolvers` |
| H-7 | `guest/factory/factory.js` (M5 possibly) | W4.1 | one line after the `turnDeadlineMs` copy: `if (extras.reasoningEffort !== undefined) fields.reasoningEffort = extras.reasoningEffort;` and one `@property` line in `ResolvedOptions` (`session-options.js`) |
| H-8 | `scripts/provision-steps.js` (M3, M5: steps) | W4.6 | one appended step (hook table) |
| H-11 | `config/defaults.js` (owner M4; M3 and M5 make no edit) | W4.1 | one line at the end: `export { subscriptionDefaults } from './defaults-m4.js';` |
| H-12 | `H/package.json`, `H/JOURNAL.md` (PM-merged) | W4.8, all | `package.json`: nothing expected (perf scripts are found by `perf/_harness.mjs`); journal: W4.0 holds J-0610..J-0629 (M3 J-0510..J-0529, M5 J-0710..J-0729), build units take the M4 numbers the PM assigns |

H-9 and H-10 of the first W4.0 commit are withdrawn: M3's seams are directory registries (14),
so M4 adds `ui/src/{secrets,accounts}/feature.js`, `AH/gateway/extensions/m4-secrets.js` and the
`vocabularyShapes` export, all new files or M4's own file.

**Single owners of shared files** (PM's table after the cross-check; M4's part):

| file | owner | M4's edit |
|---|---|---|
| `guest/lib/interfaces.js` | M5 (W5.3's four widenings) | H-1 only (one line); may be merged early |
| `resources/agent-host/durable.js` | M4 (H-2, six seams) | M3 adds three lines (merged first): its import, `const gateway = makeGatewayManager({ manager })`, and the guard `withGatewayAdmin(...)` with `gateway: () => gateway.admin` as its last method; M4's six seams are independent of them (none touches `AgentHostAdmin`) |
| `AH/attach.js` | M3 (`bindings` in `makeAttach`) | H-3 only: `makeOpsInterface` (`spec` `M.or`, `credentials` guard), `M2_FORWARDS`, one `OpsHandlers` `@property` |
| `AH/index.js` | M4 (H-4) | M3 adds one import, one `makeGatewayService` statement (with `secretWriter`), one `bindings` property and `gateway.attached()` in `onSink` (merged first); M4's H-4 lines go beside them, its `subscriptions` statement after the `secrets` helper |
| `scripts/provision-steps.js` | PM (append-only) | the `subscriptions` step, second in merge order (gateway M3, subscriptions M4, M5 fixtures) |
| `guest/factory/factory.js` | M5 | H-7 only (one line after the `turnDeadlineMs` copy) |
| `guest/factory/session-options.js` | M4 (H-6, and H-7's `ResolvedOptions` `@property`) | M5 makes no edit |
| `AH/secrets/{store,manager}.js` | M4 (H-5) | M3 imports helpers read-only |
| `AH/providers/{round,scripted}.js` | M5 | none (M4 calls `systemTextOf`) |
| `AH/providers/{anthropic,openrouter}.js` | M4 (H-14) | as listed below |
| `guest/session/*`, `guest/lib/pending-queue.js`, `AH/composer.js` | M5 | none |
| `config/defaults.js` | M4 | H-11 |
| `ui/build.mjs`, `ui/src/features.js`, `AH/gateway/{extensions,vocabulary}.js` | M3 | none |

M4-only edits of M2 files (no other lane touches them; listed so the PM can check): H-14
`AH/providers/anthropic.js` (W4.3: `headers`, `extras` options; W4.6: `tools: ['accountStatus']`
in `anthropicKind`), `AH/providers/openrouter.js` (W4.6: `tools: ['accountStatus']` in
`openRouterKind`).

Not touched by M4: `guest/session/*`, `guest/exec/*`, `guest/lib/limits.js`,
`guest/lib/interfaces.js` beyond H-1, `AgentHostAdmin`, `Operator`, `SessionFactory`,
`test/fixtures/fake-provider-server.mjs`, `scripts/serve.mjs`, `ui/src/features.js`,
`ui/build.mjs`, `AH/gateway/{extensions,vocabulary}.js`, `test/browser/_harness.mjs`,
`perf/_harness.mjs`, `perf/pool.perf.mjs` (M1b's spare pool; M4's perf scripts are
`perf/subscriptions.perf.mjs`, `perf/secrets.perf.mjs` and `perf/accounts.perf.mjs`).

---

## 16. Work units

Order: **group A** = W4.1, W4.2, W4.3, W4.4, W4.5 in parallel (they share no file and import each
other only through this contract's types and signatures; tests use fakes); **group B** = W4.6 and
W4.7 in parallel (W4.7 builds against M3's merged W3.0 contract, and its component tests run once
M3's group A is on the shared branch); then **W4.8**, which owns every M4 file. Merge order
(PM): M3, then M4, then M5; M4 applies H-2 and H-4 with M3's lines already in place, and H-1 may
go to the shared branch early as a contract follow-up. No
unit needs a running supervisor except W4.8. Estimates are hours of one Opus agent.

| id | owns (disjoint) | depends on | tests | supervisor | est. | slower if |
|---|---|---|---|---|---|---|
| W4.1 manager part and creation | `resources/agent-host/durable-subscriptions.js`; H-1, H-2, H-6, H-7, H-11; `guest/factory/subscription-options.js`; `config/defaults-m4.js`; `test/unit/m4-interfaces.test.js`, `test/unit/m4-manager.test.js`, `test/unit/m4-effort.test.js` | W4.0 | unit: every M4 guard accepts a sample and refuses an unbounded string, an oversize array and an unknown key; M4 `SecretsAdmin`/`Secret` keep M2's method guards (compared through `guard.payload.methodGuards`, the technique M5's CC-072 asks core to support; until then `.payload` read directly, pinned by this test); `vocabularyShapes()` answers every M4 shape and interface; the part with a fake `withOps`: idempotent `makeMember`/`makePool`, conflicts, retire, catalogue page cut by `fitsFrame`, served LRU at 256, marks per member; resolver: effort accepted, refused, refused on API backends | no | 6 | M2's fold reorders `durable.js`; manager bundle size needs a vat probe |
| W4.2 pool core | `AH/subscriptions/{pool,rate-limit-headers,pool-state}.js`; `test/adapter/m4-pool*.test.js` | W4.0 | ported hosted-agent `subscription-pool.test.js`, `rate-limit-headers.test.js` (object keys, no pinning); bridge: marks sent at once, served coalesced, load once per incarnation, a retired sink reloads | no | 5 | the reference tests lean on member ids throughout |
| W4.3 wire clients and catalogue | `AH/subscriptions/{messages,responses,catalog}.js`; H-14 (`anthropic.js` options); `test/fixtures/fake-subscription-server.mjs`; `test/fixtures/sse/subscriptions/`; `test/adapter/m4-wire*.test.js`, `m4-catalog.test.js` | W4.0 | fixtures: Claude deltas, thinking, tool use, SSE error, 529 then success, 529 after a delta, empty; Codex deltas, function calls, encrypted reasoning, `server_is_overloaded` with the schedule (delays scaled), failure facts; R4-30 header names present; ported lal `subscription-responses.test.js`, `subscription-messages.test.js` parts; catalogue: R4-18 intersection, R4-19 `auto`, `unavailable`, cache | no | 9 | lal's Responses mapping needs more adaptation than expected; fixtures written by hand |
| W4.4 credentials, renewal, Secrets adapter | `AH/subscriptions/{credentials,renewal}.js`; `AH/secrets/{credential-access,audit,catalog}.js`; H-5; `test/fixtures/fake-oauth-server.mjs`; `test/adapter/m4-renewal*.test.js`, `m4-secrets-full.test.js` | W4.0 | renewal: near-expiry renews once for 16 concurrent rounds; write-ahead intent then write-back; a `pendingRefresh` credential fails `CONSUMED`; two stores renewing one credential: one `GENERATION_CONFLICT`, re-read; a killed child process at K-5/K-6 leaves `CONSUMED`; audit reader 1,000 and `before`; describe batch; no value in any error | no | 7 | the store's audit format needs a migration for `before` |
| W4.5 accounts | `AH/subscriptions/{accounts,account-file,account-tool}.js`; `test/adapter/m4-accounts*.test.js` | W4.0 | provenance per source; push per change, zero per viewer; refresh on demand only; keepalive and idle eviction (6: 40 abandoned watchers, then a new watch succeeds; 33rd live watcher refused); readings file round trip and atomic write; tool text per Fae's rendering (ported `account-tool` expectations); banked credits display | no | 6 | the usage-read formats of the two providers differ more than the reference shows |
| W4.6 composition and wiring | `AH/subscriptions/{provider,index,credential-ops}.js`; `AH/gateway/extensions/m4-secrets.js`; H-3, H-4, H-8; kind tool lines of H-14; `scripts/subscription-login.mjs`; `test/adapter/m4-provider*.test.js`, `m4-login.test.js`, `m4-gateway-extension.test.js` | W4.1-W4.5 | adapter (fake servers, fake sink): hand-over on 429 before delivery, none after; one attempt per member; all exhausted text with the reset time; 401 then one renewal then retry; overload schedules; marks reach the sink; system text resolved once per round through `systemTextOf` and passed to both wire builders as a string; `accountStatus` through the ports; login helper and `--value-file` write sealed boxes; `m4-secrets.js` loads as a `GatewayExtension` whose `largeCalls[0].target` answers the context's `secretWriter()` (fake context; the gateway itself is M3's) | no | 8 | M2's merged `index.js` differs from `3588cab190` |
| W4.7 UI | `ui/src/secrets/` (with `feature.js`), `ui/src/accounts/` (with `feature.js`), `ui/src/account-chip/` only if M3's collector takes one feature per file; `test/unit/m4-ui*.test.js` (component) | M3 W3.0 merged (contract); component tests run once M3's group A (W3.4: `_m3-fake-powers.js`, the collector) is on the shared branch; W4.1, W4.4, W4.5 | component tests (happy-dom, M3's `makeFakePowers`): the Secrets panel never renders a value; replace with expected generation; revoke and delete-after-revoke; audit paging; a value of `browserSecretBytes` + 1 JSON-escaped bytes is refused in the page with `m4Texts.secretTooLargeForBrowser` and nothing is sent, one of exactly `browserSecretBytes` is sent; a non-UTF-8 file refused; account chip and Subscriptions panel update from `AccountsBatch` and re-watch after `accountsWatchClosed`; the features collect through M3's `ui/build.mjs` | no | 7 | M3's collector or `FeatureContext` differs from `contract-m3.js` |
| W4.8 integration | everything of M4; `test/integration/m4-*.test.js`, `test/browser/m4-*.mjs` (never `_harness.mjs` or another lane's files), `perf/{subscriptions,secrets,accounts}.perf.mjs` | all; acceptance 14 after M3 is merged; the `systemTextOf` case of acceptance 13 after M5 is merged | acceptance 1-16, perf section 18, kill points K-1..K-6 | yes | 9 | the run lock's four slots are not there yet (then the files run one after another: about 25 min, over the 20 min rule) |

Total about 57 hours of agent time; wall time about 9 (group A) + 8 (group B) + 9 (W4.8) hours.

---

## 17. Acceptance

All against the fake servers (D-M2-4); `[real-provider]` repeats 3, 7, 8 and 10 once with the
owner's credentials. Each item is one integration test under 5 minutes from
`ensureTemplate({ id: 'm4', provision })`.

| # | test | file |
|---|---|---|
| 1 | Secrets: create, replace with expected generation (stale: `GENERATION_CONFLICT`), revoke (next read `REVOKED`), delete only after revoke, `setDescription`, `catalog` lists label, description, generation, state and bytes and no value; the audit reader lists each read as attempted and succeeded, 1,000 events in pages | `m4-secrets.test.js` |
| 2 | `auto` picks the member whose long window resets soonest; ties by used fraction then declaration order; a session stays on its member within `cacheLifetimeMs` (3 s in the test) and moves after it | `m4-pools.test.js` |
| 3 | A 429 with exhaustion headers marks the member and the same request goes to the next member once; all exhausted fails "Provider subscriptions exhausted" with the first reset time; the recorded reason has no body | `m4-pools.test.js` |
| 4 | Marks survive a SIGKILL restart (after the mark's crank); a newer open reading lifts a dated mark | `m4-restart.test.js` |
| 5 | Reachability: from a session vat and its exec vat no `AgentHostAdmin`, `SecretsAdmin`, `SubscriptionsAdmin`, `Secret`, `PoolMember`, `Accounts`, gateway facet, factory or other session is reachable (section 19 method) | `m4-reachability.test.js` |
| 6 | Catalogue: `codex-pool` intersection (R4-18); `claude-pool` synthetic `auto` rows with efforts and the configured context length (R4-19, decision 13); a read with no member answering reports `unavailable`; a second listing within 15 min reads nothing | `m4-catalog.test.js` |
| 7 | Accounts: `accountStatus` and `Accounts.forSession` show plan, windows and reset times labelled observed / declared / remembered / unavailable; `refresh` updates them; a watcher sees one batch per change; after a restart the readings are `remembered` | `m4-accounts.test.js` |
| 8 | Claude: a 529 before any delivery is retried and the turn completes; after a delivery it fails with an R4-76 text; an SSE error, a non-200 and an empty answer give the three R4-76 texts | `m4-wire.test.js` |
| 9 | Codex: `server_is_overloaded` before visible delivery is retried on the schedule (scaled delays), after it is not; a failure event gives symbolic facts only | `m4-wire.test.js` |
| 10 | Renewal: an expired access token is renewed once and the round succeeds; a 401 gets one renewal and one retry, then the member is marked unusable and the next serves; a concurrent renewal in a second store fails `GENERATION_CONFLICT` and re-reads | `m4-renewal.test.js` |
| 11 | SIGKILL during a pool round at K-2, K-3 and K-4: after restart the turn is outcome-unknown and the fake server saw each member attempt at most once and nothing for that round after restart | `m4-restart.test.js` |
| 12 | SIGKILL during renewal at K-5 and K-6: the token endpoint saw at most one refresh for the token; the member reports `CONSUMED`; a turn succeeds on the other member | `m4-restart.test.js` |
| 13 | Efforts: an unsupported effort is refused at creation, a supported one is stored and reaches the request (Claude adaptive thinking; Codex `ultra` as `max`); an effort on an API backend is refused; the R4-30 header names are present; after the M5 merge, a two-part `system` (`[text, note]`) reaches both fake servers as one string joined with a blank line (Claude `system`, Codex `instructions`) | `m4-catalog.test.js` |
| 14 | Secrets panel and Subscriptions panel in a browser (`startBrowserGateway({ template, provision })` of M3's `test/browser/_harness.mjs`; runs after M3 is merged): create, replace, revoke, delete after revoke, audit; the value never appears in the DOM or in any frame from the gateway; account chips update live; size probe: a value of 1,040,382 ASCII letters (exactly `browserSecretBytes` = 1,040,384 bytes JSON-escaped, the two quotes included) is written from the page and the catalogue then shows `bytes` 1,040,382 and a new generation; one letter more is refused in the page with `m4Texts.secretTooLargeForBrowser` and no frame carries the value and no Secrets call is sent (the harness reads the outgoing WebSocket frames; the page's live subscriptions may send other frames at any time, J-10036; PM ruling, K1 J-10075) | `test/browser/m4-ui.test.mjs` |
| 15 | No credential anywhere: after 3, 10 and 12, a grep of the state directory (heaps, journals, hub image and log, blobs, archive, `readings.json`), the adapter's event log and the test's captured stderr finds no access token, refresh token or API key value; when run after 14, also no 64-byte marker taken from each of the two size-probe values (neither reached the hub) | `m4-secrets.test.js` (the browser part in `test/browser/m4-ui.mjs`) |
| 16 | Provisioning twice is a no-op; a member label bound to another Secret is refused until that member is retired (R8-31); a revoked Secret is never rewritten by provisioning (R8-38); `makePool` again after K-1 answers the same pool. Provisioning runs through `makeProvision({ subscriptions })` (the registered step `scripts/provision-steps/40-subscriptions.js`; XB) | `m4-provision.test.js` |
| 17 | Retirement on the next turn (3.1, XB): a retired member is not chosen at the session's next turn, submitted at once (the session was sticky on it); a retired pool fails the next turn with `m4Texts.retired` and sends nothing; neither waits for `poolStateRefreshMs` | `m4-retire.test.js` |

---

## 18. Performance

Rule (2026-11-18): every check measures a rate or a latency over a fixed window (default 60 s
per measured point), runs under 10 minutes, and builds large states by import, never by replaying
turns; M4's whole regression run (unit, adapter, integration, perf) finishes within 20 minutes of
wall time with four concurrent test slots. No M4 check depends on a long session. Output as
architecture 11 (JSON lines, `pass`, budget); fake servers answer at a fixed 20 ms.

| check | file | measured over | budget | why this budget |
|---|---|---|---|---|
| `subscriptions.select` member order for one round, 16 members, 256 served sessions | subscriptions | 60 s, in process | median <= 0.5 ms; 0 deliveries | the plan's 2 ms per round left room for the request; selection is a sort of 16 |
| `subscriptions.turnStart` submit to provider request on a pool backend | subscriptions | 60 s of turns, one session | median <= 350 ms; <= 3 session deliveries per turn start; 0 manager deliveries | the M1a turn-start budget: a pool must cost nothing on the vat path |
| `subscriptions.handover` a 429 on member A then B, over a plain round | subscriptions | 60 s, alternating | <= 50 ms added over the fake server's time; exactly 1 manager delivery per refusal | in-process retry; the mark is the only vat cost (the plan's `pool.markPersist`) |
| `subscriptions.servedWrites` manager deliveries while one session runs turns on a sticky member | subscriptions | 60 s | <= 1 per session per 60 s | coalesced stamps (5.1) |
| `subscriptions.renewal` 16 concurrent rounds on an expired member | subscriptions | 60 s, repeated expiries | exactly 1 refresh POST per expiry; <= the fake's time + 50 ms added | single-flight and write-ahead must not serialise rounds |
| `subscriptions.firstOpen` the first pool open after a restart | subscriptions | restarts of the small `m4` template state over a 150 s window | median <= 750 ms; 1 manager crank for `poolState` per restart | restart stays dormant and cheap (D-5) |
| `catalog.pool` listModels through the factory, 2 members, warm and cold | subscriptions | one 60 s window of pairs: invalidate the cache, one cold read, one warm read | warm median <= 300 ms (one factory and one manager crank); cold median <= 2 s | R4-104 cache |
| `subscriptions.bundles` session, exec, factory and manager bundle bytes | subscriptions | one build, no window | session and exec unchanged by M4 (+ <= 64 bytes for H-1); factory <= +6 KB | 1.4 |
| too-big probes | subscriptions | single runs, no window | no halt; each refused by the sending side: credential 8,193 bytes at read; secret 1 MiB + 1 at the writer; audit limit 1,001; 17 members; a 16 MiB + 1 SSE line; `poolState` with 256 served records fits `frameBytes`; a 64-entry catalogue page of full-length labels is cut (the browser bound is probed in acceptance 14) | rules 12.5, 12.10 |
| `secrets.credentialRead` audited read and parse per round | secrets | 60 s | median <= 1 ms; 0 deliveries | M2's `secrets.read` |
| `secrets.catalog` a 64-secret catalogue page | secrets | 60 s | median <= 300 ms; 1 manager crank; 1 ops call | the Secrets panel opens at once |
| `secrets.auditReader` a 1,000-event page | secrets | 60 s | median <= 50 ms; 0 vat deliveries | R7-63's largest page, adapter-local |
| `accounts.push` reading to an in-process subscriber | accounts | 60 s | median <= 5 ms; 0 vat deliveries per change and per viewer | like live deltas (D-8); replaces the plan's "1 factory publish" |
| `accounts.refresh` on-demand read of 2 members | accounts | 60 s | median <= the fake's time + 100 ms | R4-85 on demand |

Files (each under the 10-minute rule, at most 7 timed windows; each starts from the cached `m4`
template, about 60 s of setup at most):

| file | windows | timed | with setup |
|---|---|---|---|
| `perf/subscriptions.perf.mjs` | select, turnStart, handover, servedWrites, renewal, catalog.pool (60 s each), firstOpen (150 s): 7; bundles and probes untimed (<= 25 s together) | 510 s | <= 595 s |
| `perf/secrets.perf.mjs` | credentialRead, catalog, auditReader: 3 | 180 s | <= 270 s |
| `perf/accounts.perf.mjs` | push, refresh: 2 | 120 s | <= 210 s |

`subscriptions.perf.mjs` is the tightest: 510 s timed, setup <= 60 s, bundles and probes <= 25 s,
so <= 595 s. W4.8 records each file's wall time in its report; a file over 9 minutes is reported
to the PM before the merge instead of shortening a window. The 64 secrets of `secrets.catalog` and the
1,000 audit events of `secrets.auditReader` are written by the file's setup through the adapter's
store (not by turns); no M4 check needs a long session.

As built (W4.8), the first row is two files: `perf/subscriptions.perf.mjs` (3.5 min) and
`perf/subscriptions-lifecycle.perf.mjs` (6.0 min; `catalog.pool` measured in the restart
window).

Integration budget: eight integration files of 2-4 minutes each, the browser file (about 4
minutes) and the three perf files above run in four slots within 20 minutes of wall time.

---

## 19. Core requests (CC-060..CC-069)

**CC-060 object-granular reachability.** Motivation: acceptance 5 must show that a session vat
and its exec vat cannot reach `SecretsAdmin`, `SubscriptionsAdmin`, a `Secret` or a
`PoolMember`. `thix reachability` reports which sessions hold references into which origin
sessions (`pkg/src/net/hub.js` `inspect()`: `publishedOrigins`, `holdings`), and every one of
those objects lives in the agent-host manager vat, which the session legitimately reaches through
its Backend, so origin granularity cannot tell them apart. Smallest change: the hub records the
alleged interface name the exporting peer gave when it first exported an object **once per
exporting object, in the export row of the origin peer**, never per holder entry (one bounded
string per exported object; the worker's marshal knows the `Alleged: <name>` tag), and
`reachability({ holder })` joins a holder's entries to those rows to list `{ origin, alleged }`.
Stored this way it adds nothing to a viewer's holder entries, so M3's `ui.hubGrowth` row does not
see it. **Do together with CC-051** (M3: per-entry diffs of hub session rows): both change the
row format of `pkg/src/net/hub.js`, so core makes one format change for the two. M4 files no
request for the guard-payload technique its W4.1 test uses (`guard.payload.methodGuards`): that
is M5's CC-072, cited, not duplicated.
Workaround if refused (what W4.8 builds meanwhile): (a) a unit test computes the interface
closure reachable from a session's initial capabilities by following every method's return
guard in `interfaces.js` and `interfaces-m4.js` (`M.remotable(label)` returns) and asserts none
of the forbidden interfaces is in it; (b) the integration test checks that the session and exec
vats' holdings are only into the expected origins (factory, manager, adapter sessions, its exec
vat) and that the number of manager-origin rows each holds equals what its capabilities explain
(its Backend, host facet and blob handles), before and after a full turn with `accountStatus`.

CC-061..CC-069: not used.

---

## 20. Decisions and open points

M4 decisions (journaled J-0610..J-0629):

- **D-M4-1** Pools hang off `SecretsAdmin.subscriptions()`, not `AgentHostAdmin` (3.1): members
  are made from Secrets, both are root-only (R7-22), and `AgentHostAdmin` is M3's to extend.
- **D-M4-2** M4's guards live in `interfaces-m4.js`, imported one way; `interfaces.js` changes by
  one line (H-1) because the session program has 13.5 KB left for three milestones (1.4).
- **D-M4-3** `Session.getAccount` (A.4) is served by the gateway-local `Accounts.forSession`; no
  session method is added.
- **D-M4-4** Claude overload (529, `overloaded_error`) before any delivery is retried on Codex's
  schedule (open decision 12's default).
- **D-M4-5** `claude-pool` takes its context window from the pool spec, default 200,000 tokens
  (open decision 13's default), so M8's compaction can fire.
- **D-M4-6** Selection is `auto` only; pinned-only members, shares and the share meter are not
  built.
- **D-M4-7** Secret values are UTF-8 text; the panel refuses a non-text file.
- **D-M4-8** Renewal is write-ahead and fails closed (`CONSUMED`) after an interrupted refresh,
  as the reference broker does: an operator sign-in is the price of never presenting a refresh
  token twice.
- **D-M4-9** `accountStatus` is an adapter tool offered on pool and API backends (not on the
  scripted test backend), so no tool-table entry and no session code is added.
- **D-M4-10** (XB) A retirement reaches the adapter by a push: `retirePool` and
  `PoolMember.retire` send `CredentialOps.poolsChanged()` (sendOnly, no argument: the adapter
  marks every pool state it loaded stale and asks `poolState` again at each pool's next round).
  The retirement does not wait for the push; when the manager has not yet fetched the
  incarnation's `CredentialOps` the push leaves after one `ops.credentials()` answer. The
  periodic re-read of M4-FIX stays as a safety net, raised from 30 s to 600 s
  (`poolStateRefreshMs`).

Owner decisions (the default M4 builds until told otherwise):

1. Open decision 8, Codex reset-credit redeem: **deferred**; credits shown read-only.
2. Open decision 12, Claude overload retry: **retry before delivery** (D-M4-4).
3. Open decision 13, Claude context window: **from configuration, default 200,000** (D-M4-5).
4. Interrupted renewal: **fail closed, operator signs in again** (D-M4-8), or accept a possible
   replay of a refresh token to keep the member usable.
5. R4-30's client identification headers and billing block: **sent as the spec says**,
   configurable in `config/defaults-m4.js`.
6. Pool administration from the Secrets manager (D-M4-1) rather than a separate operator
   facet: **as designed**.
7. Pinned-only members and shares (D-M4-6): **not built**.

Open points for the PM (after the cross-check of the three contracts):

1. Bundle budget: settled as M5's O-1 (1.4): the PM raises the session and exec limits in the
   M5 merge commit; M4's own budget stays "+ <= 64 bytes". The owner may still overrule O-1.
2. The run lock's four concurrent slots (the 20 minute rule) are assumed; without them W4.8's
   files run one after another in about 25 minutes.
3. Merge order is settled: M3, then M4, then M5 (15, owners table). H-1 may be merged early.
4. M3's 6.2 must state that a `feature.js` may export an array of features; until it does, W4.7
   splits the chip into `ui/src/account-chip/feature.js` (9.1 item 1).
5. M3 adds `secretWriter` to `GatewayContext` (`contract-m3.js`); `m4-secrets.js` depends on it.
   M3's 6.4 text still says the writer is resolved through `secretsAdmin.openWriter()`; the
   settled form is `context.secretWriter()`.
