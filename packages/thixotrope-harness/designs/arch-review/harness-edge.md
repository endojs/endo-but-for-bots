# Architecture review of the harness edge: secrets, subscriptions, gateway, browser UI (HR-EDGE)

Unit HR-EDGE of the harness architecture review. Read-only: no source, test or config file was
changed; no supervisor was started. Snapshot: branch `claude/thix-arch` at `bd9a8ec070` (the
M3/M4/M5 merge). Paths are relative to `packages/thixotrope-harness/` unless they start with
`packages/`. Glossary: `core-ontology.md` section 5; this report adds no term it does not define
where it is first used.

Evidence marks: **read** (the code was read), **measured** (a script counted it; scripts were
kept outside the repository: an export-use counter, a six-line duplicate-window finder over
normalised lines, an import-cycle finder, a function-length counter on the TypeScript parser, and
a dump of the interface method-name tables), **inferred**.

Started 2026-11-18T12:52:57Z; the end time is in journal entry J-9988.

---

## 1. Summary

The edge is safe where safety was specified and untidy where three lanes met it. The secret value
path is well built: values never enter a vat or the hub in clear, the writer finds a store key by
rights amplification, the CLI path seals to an X25519 key derived from the wrapping key, a pool
member's renewal holds a one-key `CredentialAccess`, and the store changes its entry map only
after the encrypted file is durable. The gateway's pre-decode guard is the best module here. What
costs is duplication across lanes (a second catalogue, a second secret file, four bounded-JSON
readers, nine copies of one error helper), feature state that grew outside the controller because
the controller offers no seam for it, and fakes that nothing holds to the real interfaces.

**The three things most worth changing**

1. **Give UI features a state seam and shrink the controller** (HR-EDGE-1, -9, -10). The
   controller is one 1,235-line closure; the M4 and M5 features did not extend it but built three
   per-connection caches keyed by `powers`, four listener sets and a second inventory pager, and
   the account chip looks the active session up by name because the controller does not expose
   the presence it holds. Its unit test passes through a branch production never takes.
2. **One sealed-file module for the wrapping key** (HR-EDGE-2). `secrets.enc` and the gateway's
   `signin.enc` use one key through three independent lazy loaders with three failure policies,
   and the "temp, fsync, rename, fsync directory" write is written five times in this area; the
   architecture still says the sign-in secret is an entry of the Secrets store.
3. **Share the catalogue core and stop reading failures by text** (HR-EDGE-3, -4, -5). The pool
   catalogue copies about 150 normalised lines of M2's catalogue (paging, cache, readers); Claude
   overloads are recognised by comparing M2's failure text; the accounts feed signals eviction by
   an error text the browser compares across CapTP, where the channels already answer
   `{ closed: true, reason }`.

**The three things most worth keeping**

1. **The bridge guard** (`resources/agent-host/impl/gateway/guard.js`, `vocabulary.js`): checks
   the encoded call before CapTP decodes it, derives the key vocabulary and the method-name set
   from the interface guards themselves (one source of truth, no hand list), and answers every
   refusal with a named rule.
2. **The secret value path** (`impl/secrets/writer.js`, `seal.js`, `credential-access.js`,
   `store.js` `mutate`): amplification instead of ids, sealed boxes for the hub, a one-key
   accessor with generation-conditioned replace for renewals, rollback when the durable write
   fails.
3. **Structure that holds**: 88 modules in the area with **0 import cycles** [measured];
   `subscriptions/pool.js` (638 lines) imports nothing and is pure selection logic; wire failures
   carry structured facts (`subscriptions/wire.js` `WireFacts`: `exhausted`, `rejected`,
   `overloaded`), not texts; the sign-in limiter's retained state is bounded by its global
   ceiling; the UI feature collector fails the build on a bad slot or a duplicate id and isolates
   a throwing feature (`ui/src/features.js`, `ui/src/shell/Slot.js`).

Findings: 3 major, 8 moderate, 8 minor.

---

## 2. Map of the area

Sizes are lines including comments [measured].

| directory | files | lines | job |
| --- | --- | --- | --- |
| `resources/agent-host/impl/secrets/` | 7 | 1,281 | encrypted store and audit log (`store.js` 750), sealed boxes (`seal.js`), ops handlers (`manager.js`), `SecretWriter`, one-key accessor, catalogue batch, audit reader |
| `resources/agent-host/impl/subscriptions/` | 16 | 6,671 | pools of provider accounts: selection core (`pool.js`), manager bridge (`pool-state.js`), Claude and Codex wire clients (`messages.js`, `responses.js` 727), pool catalogue (`catalog.js` 861), credentials and renewal, accounts oracle and usage readers (`accounts.js` 1,100), account-status tool, readings file |
| `resources/agent-host/impl/gateway/` | 13 | 3,672 | HTTP and hand-written WebSocket server (`server.js` 750), CapTP bridge (`bridge.js`), pre-decode guard and vocabulary, bootstrap and powers, sign-in file and limiter, static files and CSP, extension loader, composition (`index.js`), shared M3 contract (`contract-m3.js`, data only) |
| `ui/src/controller/` | 2 | 1,559 | page state and actions (`index.js` 1,421), drafts and request ids |
| `ui/src/net/`, `shell/` | 9 | 929 | connection with reconnect, fragment parsing; App, header, overlay, status bar, `Slot` |
| `ui/src/conversation/`, `sessions/` | 19 | 2,814 | M3 views (registered as views, not features) |
| `ui/src/accounts/`, `secrets/`, `presets/`, `mentions/` | 17 | 3,214 | M4 and M5 features (`feature.js` per directory) |
| `ui/src/*.js` | 5 | 356 | feature collector, Node feature list, slot order, entry, pre-lockdown |

Who imports whom [measured, relative imports only]:

- `gateway/signin.js` -> `secrets/store.js` (`findSecretsFiles`, `loadWrappingKey`, `encrypt`,
  `decrypt`); `gateway/index.js` -> `blobs.js` (`findBlobDir`) and every gateway module.
- `subscriptions/` -> `secrets/audit.js`, `secrets/catalog.js` (via `credential-ops.js`);
  -> `providers/anthropic.js`, `catalog.js`, `http.js`, `round.js`, `retry.js`, `sse.js`,
  `scripted.js`; `account-tool.js` -> `guest/session/staging.js` (a session-vat module; ten
  adapter modules outside this area do the same).
- `ui/src/**` -> `resources/agent-host/impl/gateway/contract-m3.js` (38 import sites),
  `guest/lib/reply-fold.js`, `texts-m4.js`, `limits-m4.js`; no UI module imports any other
  adapter module.
- `impl/index.js` wires all three: `secrets()` lazily, `makeSubscriptions({ secrets })`,
  `makeGatewayService({ secretWriter: () => secrets().secretWriter() })`.
- Runtime discovery by directory listing, three times: gateway extensions
  (`gateway/extensions/*.js`), the vocabulary (`guest/lib/interfaces-m*.js`), UI features
  (`ui/src/*/feature.js`, twice: `ui/src/feature-list.js` and `ui/build.mjs`).

Long functions (over 300 lines, excluding the maker closures that are the package's idiom)
[measured]: `subscriptions/responses.js:426` `codexAttempt` 301; `gateway/bridge.js:138`
`connect` 314. Maker closures over 400 lines: `makeController` 1,235, `makeMentions` 514,
`makeAccounts` 501, `SecretsPanel` 430, `makeSecretStore` 426.

---

## 3. Findings, by severity

### HR-EDGE-1 (major, Q1) The UI controller is one closure, and features keep their own state beside it

- **Where.** `ui/src/controller/index.js:187-1421` (`makeController`, 1,235 lines [measured]);
  `ui/src/secrets/daemon.js:20-64` (`byPowers` WeakMap, `once`); `ui/src/accounts/feed.js:53-193`
  (own listener set, own lazy `accounts()`, `feeds` WeakMap); `ui/src/mentions/mentions.js:143-160,
  300-335` (`inventories` WeakMap, own `notify`); `ui/src/presets/editor.js:125-215` (own
  `getPresets`, `getFactory`, `listModels`, inventory pager).
- **Evidence.** [read] The controller holds connection life cycle, the session list feed, the
  catalogue (presets, backends, models), the conversation view (history pages, live deliveries;
  `applyDelivery` 584-719), drafts and resend under Web Locks, the composer chain, the feature
  context and panel flags. The feature seam (`FeatureContext`: `powers`, `controller`, `extra`,
  `call`) offers features no state of their own, so each M4/M5 feature built one: three
  module-level WeakMaps keyed by the connection's `powers` [measured: `new WeakMap` in
  `ui/src` = 3, all in features], four modules with listener sets (`controller`, `feed`,
  `mentions`, `presets/editor`). Two features call `E(powers.operator).getSecrets()` and cache
  it separately (`secrets/daemon.js:47`, `accounts/feed.js:59`). The inventory pager is written
  twice line for line (`presets/editor.js:156-172`, `mentions/mentions.js:309-325`). The model
  listing is read by the controller (`refreshModels`, `moreModels`) and again by the preset
  editor (`editor.js:185`).
- **Fix.** Two steps. (a) Add `context.connectionCache(key, make)` (per-`powers`, dropped on
  reconnect) and `context.subscribe` to `FeatureContext`; move the three WeakMaps onto it and
  share one `secretsAdmin()` and one `inventory()` reader. (b) Split `makeController` along its
  own section comments into `list.js` (sessions feed), `catalogue.js`, `view.js` (history, live
  fold) and `send.js` (drafts, chain, locks), composed by `index.js`, each taking `update`.
- **Size.** (a) about 120 lines in 6 files; (b) mostly moved code, about 1,200 lines in 5 files.
- **Risk.** Epoch checks (`attachEpoch`) guard every async path; a split must pass the epoch in,
  not capture a stale one. Covered by `test/unit/m3-ui-controller*.test.js` (four files) and the
  browser tests `test/browser/m3-ui*.test.mjs`. Do (a) first; it is independent of (b).

### HR-EDGE-2 (major, Q2 and Q4) Two sealed files under one key, three key loaders, five durable-write copies

- **Where.** `resources/agent-host/impl/secrets/store.js:142-219` (`loadWrappingKey`, in-flight
  dedupe only), `:254-261` (`syncDirectory`), `:474-495` (`persist`), `:163-190` (key creation),
  `:359-373` (audit rewrite); `gateway/signin.js:54-61` (second `syncDirectory`), `:101-113`
  (own lazy key with retry), `:120-124` (own `serialize`), `:149-166` (`writeNew`);
  `secrets/seal.js:120-146` (third lazy load, memoised for ever);
  `subscriptions/account-file.js:192-222` (`writeAtomic`); design: `designs/architecture.md:510`
  ("The sign-in secret is an entry in the same store").
- **Evidence.** [read] One 32-byte wrapping key is loaded by `makeSecretStore.ready`,
  `makeSealKeys.ready` and `makeSignInStore.wrappingKey`, each with its own cache; a failed load
  is permanent for the first two (`loading ??= load()`) and retried for the third. The key is
  used raw as the AES-256-GCM key of three formats separated only by additional data
  (`thix-secrets-1`, `thix-secrets-audit-1`, `thixotrope-harness-signin-1`) and as HKDF input for
  the X25519 key; the design leaves per-purpose subkeys open (`architecture.md:533`). The
  sign-in file is not in the audit log, so a rotation leaves no audit event. The durable
  "temp, fsync, rename, directory fsync" sequence appears 5 times in this area and 9 times
  under `resources/agent-host/impl/` [measured: `await rename(` / `renameSync(` / `link(`
  sites]. The M3 contract chose the separate file deliberately (`m3-interfaces.md` 4.3, D-M3-3);
  the architecture was not updated.
- **Fix.** A `secrets/sealed-file.js` with `makeWrappingKey({ keyFile, stateDir })` (one load
  per incarnation, one failure policy: retry) and `writeSealed(path, purpose, bytes)` /
  `readSealed(path, purpose)` that derive a subkey per purpose with HKDF. Store, audit, sign-in
  and seal take the one key object from `impl/index.js` (the gateway already receives
  `secretWriter` from there; give it the key the same way). Correct `architecture.md:510` to say
  the sign-in secret is a separate sealed file under the same key, and record rotations in the
  audit. Moving existing files to subkeys needs a format bump (`thix-secrets-2`), so it can be
  a second step.
- **Size.** About 150 lines in 5 files, minus about 90 removed.
- **Risk.** A format change locks out existing state directories unless the reader accepts
  both versions; the owner's rule that the Secrets store must not be wiped (re-importing secrets
  is costly) makes a dual-read period mandatory. Covered by `test/unit/m2-secrets*`,
  `test/adapter/m3-w31-signin*` (K2 kill points) and the daemon check `m2-secrets`.

### HR-EDGE-3 (major, Q2) The pool catalogue is a copy of M2's catalogue

- **Where.** `subscriptions/catalog.js:119-191` (`tokenCount`, `boundedJson`, `readJson`),
  `:380-428` (fresh/stale/retry single-flight cache), `:437-442` (`byTitleThenId`), `:664-758`
  (`pageOf`); originals `providers/catalog.js:144-236`, `:436-441`, `:470-554`, `:626-721`.
  Further bounded-JSON readers: `subscriptions/renewal.js:108-135`,
  `subscriptions/accounts.js:1013-1036`.
- **Evidence.** [measured] 154 normalised lines of `subscriptions/catalog.js` lie in six-line
  windows identical to `providers/catalog.js` (the largest shared block of the area; the next
  is 40 lines between `providers/anthropic.js` and `subscriptions/responses.js`). [read]
  `pageOf` differs only in the efforts fields (`rowEfforts`, `defaultReasoningEffort`); the
  cache differs by an `admitting()` variant. The R4-20 order, the cursor rule and the frame-fit
  rule now live in two places. Bounded JSON of a response body is written 4 times, with three
  different failure types, while `providers/http.js` already exports `boundedChunks` and
  `bodyChunks`.
- **Fix.** Export `pageOf` (with a `rowExtras(model)` hook), `makeObservationCache` and
  `readJson` from `providers/catalog.js` and import them; add `readBoundedJson(response, max,
  fail)` to `providers/http.js` and use it at the four sites.
- **Size.** About 250 lines removed, 40 added, 5 files.
- **Risk.** Low; `test/unit/m4-*catalog*` and `test/unit/m2-*catalog*` pin page contents and
  cursors. The `admitting` path (a creation answers a usable observation at once) must keep its
  behaviour.

### HR-EDGE-4 (moderate, Q5 and Q2) Claude overloads are recognised by comparing M2's failure text

- **Where.** `subscriptions/messages.js:162-167` (`API_ERROR`, `OVERLOADED_EVENT`), `:281-288`.
- **Evidence.** [read] The Claude pool client reuses M2's Anthropic client (good) but learns that
  an SSE event was `overloaded_error` by `error.reason.startsWith(API_ERROR)` and
  `error.reason === OVERLOADED_EVENT`, both built from `textOf.anthropicApiError(...)`. A change
  to that text, or to `textOf.servedBy`'s formatting, silently turns overloads into plain
  failures (no retry, no `overloaded` fact). The Codex client sets the same facts from the
  event's own type (`responses.js`, `server_is_overloaded`), so the two pool clients classify by
  different means.
- **Fix.** Have `providers/anthropic.js` put the event type on its `ProviderFailure`
  (`eventType: 'overloaded_error'`) and test that field here.
- **Size.** About 10 lines, 2 files.
- **Risk.** None for behaviour; `test/unit/m4-*messages*` covers the retry.

### HR-EDGE-5 (moderate, Q4) A closed watch is a structured answer on channels and an error text on accounts

- **Where.** `subscriptions/accounts.js:23-31`, `:382`, `:422` (rejects with
  `m4Texts.accountsWatchClosed`; a watch at the cap is refused); `ui/src/accounts/feed.js:133`
  (`messageOf(thrown) !== m4Texts.accountsWatchClosed`); the channel model:
  `impl/list-channel.js:28-33` (`next()` answers `{ deliveries: [], closed: true, reason }`; at
  the cap the subscriber with the most queued bytes is closed).
- **Evidence.** [read] Two models of one concept, "a viewer subscription the adapter ended":
  structured with a `CloseReason` on the session and list channels, a rejection text on
  accounts, which the browser compares after the text has crossed the hub and CapTP. The cap
  policies also differ (refuse the newcomer vs close the heaviest).
- **Fix.** Answer `next()` with `{ closed: true, reason: 'idle' | 'closed' }` in an
  `AccountsBatch`, as the channels do; the feed tests the field.
- **Size.** About 25 lines, 3 files plus the `AccountsBatch` shape in `interfaces-m4.js`.
- **Risk.** A shape change in `interfaces-m4.js` changes the vocabulary (adds `closed`,
  `reason`, both already present) and the manager bundle; `test/unit/m4-ui-accounts.test.js`
  and `test/unit/m4-*accounts*` cover it.

### HR-EDGE-6 (moderate, Q3 and Q5) A hand-written WebSocket server beside an unused `ws` dependency

- **Where.** `gateway/server.js:23-27` (comment: "rather than with the `ws` package, which this
  package does not depend on"), `:100-411` (RFC 6455 framing, about 300 lines); `package.json:52`
  (`"ws": "^8.22.0"` in `dependencies`, added by `1849414b2a` "M3 UI and gateway dependencies
  (H6)").
- **Evidence.** [measured] 0 files import `ws` (source, scripts, tests, perf); tests use Node's
  global `WebSocket`. The comment contradicts the manifest. [read] The parser is careful (mask
  required, RSV refused, control frames bounded, fragment bound checked before buffering, no
  per-chunk concatenation) and the slow-consumer rule bounds the send buffer. Two small
  deviations from RFC 6455: a received close code is echoed without validation (1005 is
  replaced, but 1006, 1015 or 0-999 are echoed back), and the close reason is decoded without
  checking UTF-8 (`:309-312`).
- **Fix.** Decide once. Keeping the hand-written server (no dependency, already reviewed): remove
  `ws` from `dependencies`, fix the comment, validate the close code (echo 1002 for an invalid
  one). Or replace `makeWebSocket` with `ws`'s `WebSocketServer({ noServer: true,
  maxPayload })` and keep the gateway's own rules (origin, binary only, slow consumer).
- **Size.** Keep: 3 lines of manifest and comment, about 10 lines of close validation. Replace:
  about 250 lines removed.
- **Risk.** Removing the dependency: none. Replacing: close-code and slow-consumer behaviour
  pinned by `test/adapter/m3-w31-http.test.js` and `m3-w32-wire.test.js` must hold.

### HR-EDGE-7 (moderate, Q3) The extension registry carries four mechanisms for one 27-line user

- **Where.** `gateway/extensions.js` (331 lines): `makeExtensionServices` `:200-233`,
  `extensionRoutes` `:240`, `extensionCsp` `:250`, `makeLargeCalls` `:280`;
  `gateway/server.js:433-442`, `:574`, `:625` (extension HTTP and upgrade routes);
  `ui/src/controller/index.js:851-856` (`extra(label)`); the only extension,
  `gateway/extensions/m4-secrets.js` (27 lines, `largeCalls` only). UI feature discovery is also
  written twice: `ui/src/feature-list.js:24-55` (Node, top-level await) and `ui/build.mjs`
  `listUiModules`.
- **Evidence.** [measured] Producers of `services`, `routes` and `csp`: 0. Consumers of
  `FeatureContext.extra`: 0 outside `test/unit/m3-ui-controller.test.js:597`. Extras are found
  by a label string, against the owner's "objects, not names" principle. [read] The registries
  were the merge seams of three parallel lanes (`m3-interfaces.md` 6); the lanes are merged, and
  M11's `/audio` route is the only planned user of `routes` (`architecture.md:1019`).
- **Fix.** Keep `largeCalls` and `routes` (M11 will need an upgrade route). Remove `services`,
  `extras`, `FeatureContext.extra` and `csp` until a milestone needs them; or replace the
  directory scan with one static list in `gateway/index.js` now that no lane edits it in
  parallel. Have `ui/build.mjs` import `listUiModules` logic from one module shared with
  `feature-list.js`.
- **Size.** About 120 lines removed in 4 files; tests `test/adapter/m3-w32-extensions.test.js`
  shrink.
- **Risk.** Low; the `GatewayPowers.extras` field is in `interfaces-m3.js` shapes (removing it
  changes the vocabulary and the manager bundle).

### HR-EDGE-8 (moderate, Q1 and Q5) The state directory is guessed from `process.argv`, three times

- **Where.** `impl/blobs.js:149-161` (`findBlobDir`: `argv[3]` must be
  `<state>/bundles/<digest>.cjs`); `impl/index.js:167-169` and `:191-192`
  (`dirname(dirname(blobDir))`); `gateway/index.js:126` (`dirname(dirname(findBlobDir()))`).
- **Evidence.** [read] The adapter derives the state directory from the core's launch command
  layout (`packages/thixotrope/src/platform/node/adapter-process-entry.js:14`), goes down to
  `agent-host/blobs` and back up two levels, at three sites; the gateway does it independently of
  `impl/index.js`, which already knows the directory. The core gives an adapter no state
  directory (no `stateDir` in `native-adapter.js` or `adapter-kit.js` [read]). The secrets and
  sign-in files hang off this guess.
- **Fix.** Compute `stateDir` once in `impl/index.js` and pass it to `makeGatewayService` and
  `makeSubscriptions` (both already accept it). Longer term, a core request: give an adapter its
  state directory as a power, so no adapter parses `argv`.
- **Size.** About 10 lines, 3 files (now); core request separately.
- **Risk.** None for the first step; `test/adapter/m3-*` pass `stateDir` explicitly already.

### HR-EDGE-9 (moderate, Q5) The UI fakes are not held to the real interfaces

- **Where.** `test/unit/_m3-fake-powers.js` (1,436 lines), `test/unit/_m4-ui-fakes.js` (360);
  used by 14 test files [measured].
- **Evidence.** [measured] 0 references to an interface guard or a method-name table in either
  fake; every object is a hand-written `Far(name, {...})`. Nothing fails when a real interface
  renames, drops or reshapes a method the UI calls, or when a fake offers a method the real
  object lacks. HR-EDGE-10 is a live case: the account-chip test gives its fake controller an
  `activeSession` the real controller does not have. The backstop is four browser test files
  against a real daemon (`test/browser/`), which run only with `THIX_HARNESS_BROWSER=1`.
- **Fix.** In each fake, build objects with `makeExo(name, realInterfaceGuard, methods)` (from
  `guest/lib/interfaces*.js`) instead of `Far`: names and argument shapes are then checked on
  every fake call. Where a fake implements a subset, assert `fakeNames ⊆ methodNames[name]` in
  one helper. Add a fake of the controller's public API typed from `makeController`'s return.
- **Size.** About 60 lines in 2 files, plus fixes to whatever drift it finds.
- **Risk.** It will find drift; that is the point. Guards add a little time per call.

### HR-EDGE-10 (moderate, Q3 and Q4) The account chip finds the session by name; its "controller first" branch is dead

- **Where.** `ui/src/accounts/AccountChip.js:30-38`; `ui/src/controller/index.js:994`
  (`activeSession` is internal; not in the returned API, `:1046-1421`);
  `test/unit/m4-ui-accounts.test.js:361-374`.
- **Evidence.** [read] `activeSessionOf` calls `controller.activeSession()` when it exists,
  else `E(operator).getFactory()` then `E(factory).findSession(key)`. The controller holds the
  `Session` presence but does not expose it, so production always takes the second branch: two
  round trips and a lookup by string key into the factory vat on each chip refresh. The test named
  "the controller accessor first, else findSession" exercises the first branch only with a fake.
- **Fix.** Expose `activeSession()` on the controller API (it exists) and delete the fallback.
- **Size.** About 12 lines, 3 files.
- **Risk.** None; the test keeps its first half.

### HR-EDGE-11 (moderate, Q4) The architecture's gateway section disagrees with the code three times

- **Where.** `designs/architecture.md:999` ("JSON text frames") vs `gateway/server.js:27-28`,
  `m3-interfaces.md:227` (binary frames); `architecture.md:1011-1012` (the key guard refuses a
  key "the target method's declared shape" does not name) vs `gateway/guard.js:109-158` (one
  vocabulary, the union over every interface and shape); `architecture.md:510` (sign-in secret
  in the Secrets store) vs `gateway/signin.js` (HR-EDGE-2).
- **Evidence.** [read] The M3 contract changed all three deliberately (`m3-interfaces.md:879`
  for frames, 4.4 for the union); the architecture, which the process names as the design of
  record, was not updated. The union is the right engineering choice (the vat's name budget is
  spent once on a fixed set) but it is weaker than what the architecture promises: any known key
  may be sent to any method.
- **Fix.** Amend the three sentences of `architecture.md` section 7 and section 3.3 D-6 to the
  built behaviour, citing the contract.
- **Size.** About 8 lines, 1 file. **Risk.** None.
- **Note.** The integration workflow is splitting `guest/lib/interfaces.js` per vat now; the
  vocabulary reads `interfaces.js` by import and `interfaces-m*.js` by file glob
  (`gateway/vocabulary.js:51`, `:139-181`), so new file names outside that glob drop out of the
  vocabulary silently (a logged `vocabulary-skip` at most). That work should keep the glob or
  replace it with an explicit list; it may already be in hand.

### HR-EDGE-12 (minor, Q2) Small helpers written many times while the prelude provides them

- **Where and evidence.** [measured]
  - `messageOf(error)`: 9 identical copies in `ui/src` (`shell/Slot.js:24`,
    `net/connection.js:42`, `secrets/SecretsPanel.js:62`, `mentions/mentions.js:130`,
    `controller/index.js:116`, `accounts/SubscriptionsPanel.js:49`, `accounts/feed.js:44`,
    `presets/editor.js:31`, `conversation/slots.js:18`, the last exported and imported once);
    3 in `gateway/` (`index.js:91`, `extensions.js:54`, `vocabulary.js:127`) where
    `describeError` is on the adapter's `globalThis` (`packages/thixotrope/src/guest/prelude.js:59`).
  - Serial queue: `gateway/signin.js:120`, `gateway/index.js:235`; the prelude provides
    `makeSerialQueue` (`prelude.js:58`), used by every core keeper.
  - "Promise kept until it rejects": `ui/src/secrets/daemon.js:28`, `accounts/feed.js:57-67`,
    `gateway/signin.js:101-113`, `subscriptions/pool-state.js:200`.
  - Fixed-code test `/^[A-Z_]+$/` on `error.code`: `secrets/store.js:561`,
    `subscriptions/provider.js:64`, `subscriptions/renewal.js:84`.
  - Request id: `ui/src/controller/drafts.js:128-138` hand-builds a UUID v4 that
    `crypto.randomUUID()` gives (the page is a secure context: loopback or behind TLS).
- **Fix.** One `ui/src/errors.js`; `describeError` and `makeSerialQueue` from the prelude in the
  gateway; one `codeOf` in `secrets/store.js` beside `secretError`.
- **Size.** About 100 lines removed, 15 files. **Risk.** None (UI copies are identical).

### HR-EDGE-13 (minor, Q5) The secrets store's error contract has three holes

- **Where.** `secrets/store.js:543-547` and `:573` (the `attempted` audit is outside the
  `try`), `:704` (revoke's fail code), `:468-471` and `seal.js:136-142` (permanent memo).
- **Evidence.** [read] The header promises "Every failure is `textOf.secretFailed(code)`". An
  `appendFileSync` failure of the audit (full disk) escapes `audited` and `readNow` as a raw
  file-system error naming the audit path, and fails the read itself. A revoke whose write fails
  is audited `REPLACE_FAILED` (`secretCodes` has no revoke code). A key or file load that fails
  once makes the store and the sealing keys fail until the adapter restarts, while the sign-in
  store retries.
- **Fix.** Wrap the attempted audit in the `try` (or map its failure to `READ_FAILED`); add
  `REVOKE_FAILED` to `secretCodes`; reset `loading` on failure as `signin.js` does (or adopt
  HR-EDGE-2's one loader).
- **Size.** About 15 lines, 3 files. **Risk.** `secretCodes` is in `interfaces.js` (the manager
  and session bundles); a new code is an additive change.

### HR-EDGE-14 (minor, Q3) Two audit paths with two bounds

- **Where.** `secrets/store.js:729-730` (`audit` bounded by `limits.auditPageEvents` 100,
  `auditPage` by `m4Limits.auditReaderMax` 1,000); `secrets/manager.js:101-102`
  (`secretAudit` drops `before`); `resources/agent-host/durable.js:422`, `:484`
  (`Secret.audit`, `SecretsAdmin.audit` through the manager vat); `secrets/audit.js` (the M4
  adapter-local `AuditReader`).
- **Evidence.** [read] M2's path carries up to 100 events through a vat frame; M4 added the
  adapter-local reader because that costs a vat delivery. The UI uses only the reader
  (`ui/src/secrets/SecretsPanel.js`); no script calls `Secret.audit` [measured: 0 call sites
  outside `durable.js` and tests].
- **Fix.** Make `Secret.audit` and `SecretsAdmin.audit` answer through the reader (or retire
  them in a contract revision); drop `store.audit` and the `auditPageEvents` limit.
- **Size.** About 40 lines, 4 files. **Risk.** The manager-vat interface is persisted state's
  contract; removal needs the M13 upgrade path or a fresh state directory. Redirect first.

### HR-EDGE-15 (minor, Q2 and Q4) Slot code: aliases and one more copy

- **Where.** `ui/src/conversation/slots.js:9-12` (re-exports `Slot` as `ConversationSlot`,
  `visibleFeatures` as `slotFeatures`); `ui/src/sessions/slot.js:9` (`Slot` as `SessionsSlot`);
  `ui/src/controller/index.js:874-883` (`addons()` re-implements `selectSlot` with a literal
  `100` instead of `DEFAULT_ORDER`); `controller/index.js:42-44` (`CONTENT_PAGE_BYTES`,
  `SESSION_PAGE_ROWS` copied from `guest/lib/limits.js`, which `ui/src/secrets/values.js:18`
  shows the UI may import).
- **Evidence.** [read] The local copies were collapsed into re-exports by M3-FIX, leaving three
  names for one component; the controller's copy of the slot order was missed.
- **Fix.** Import `Slot` and `selectSlot` directly; delete the two alias modules; import the
  limits.
- **Size.** About 40 lines, 6 files. **Risk.** None; `m3-ui-conversation-slots.test.js` imports
  the alias and needs its import changed.

### HR-EDGE-16 (minor, Q4 and Q1) Names by milestone, "subscription" twice, the shared contract inside the gateway

- **Where and evidence.** [read]
  - Modules named for the milestone that built them, not the concept: `contract-m3.js`,
    `interfaces-m3.js`, `interfaces-m4.js`, `limits-m4.js`, `texts-m4.js`,
    `config/defaults-m4.js`, `extensions/m4-secrets.js`. Fixed texts for this area live in 11
    tables across 9 modules [measured]; limits in 8 (`limits`, `m3Limits`, `m4Limits`,
    `gatewayLimits`, `channelLimits`, `subscriptionDefaults`, `defaultGuardLimits`,
    `defaultBridgeLimits`), and `config/defaults.js` and `guest/lib/limits.js` both export a table
    named `limits`.
  - "Subscription" names a provider plan (`SubscriptionsAdmin`, `subscriptions/`) and a feed
    watch (`AccountsSubscription`, `subscribers`, `LiveSubscription`) in the same module
    (`subscriptions/accounts.js`). The glossary has "pool" and "member"; it should add
    "subscription (provider plan)" and use "watch" for the feed.
  - The browser and the gateway share `resources/agent-host/impl/gateway/contract-m3.js`
    (38 UI imports), so the UI depends on a file inside the adapter's implementation directory,
    and `ui/build.mjs` writes its output into `gateway/assets/`.
  - A user-visible text names the reference project: `guest/lib/texts-m4.js:24`
    ("... for Fae subscription"); it may be a parity text, so ask before changing it.
- **Fix.** Rename when a file is next touched for another reason: `contract-m3.js` to
  `gateway-contract.js` beside `ui/` and `gateway/` (for example `resources/agent-host/shared/`);
  "watch" for feeds in new code. The integration workflow's per-vat split of `interfaces.js` is
  the moment to drop milestone suffixes from the guest library; it may already be in hand.
- **Size.** Mechanical; about 60 import lines. **Risk.** Persisted names are not involved.

### HR-EDGE-17 (minor, Q3) Exports and options nobody uses

- **Where and evidence.** [measured] Of 267 exports in the area, 47 are used by no other file,
  source or test (for example `gateway/server.js` `wsCloseCodes`, `gateway/index.js`
  `notAttachedText`, `secrets/seal.js` `SEALED_BOX_FORMAT`, `subscriptions/catalog.js`
  `readClaudeModels`, `readCodexModels`, `pooledClaudeModels`, `ui/src/conversation/ToolGroup.js`
  six helpers), and 36 more only by tests. [read] `makeGatewayService` takes `blobs` and `timers`
  "kept for later extensions; M3 reads nothing from it" (`gateway/index.js:100-102`, `:123-124`)
  and `impl/index.js:373-374` passes them. `gateway/bridge.js:85` `normalClose = 1000` repeats
  `wsCloseCodes.normal`. `harnessVocabulary` and `collectRecordKeys` are test-only wrappers of
  `harnessNames` and `collectNames`.
- **Fix.** Unexport the 47; drop the two options. **Size.** About 60 lines, 20 files.
- **Risk.** None.

### HR-EDGE-18 (minor, Q1) Provider-specific subscription code is spread over seven files

- **Where.** Claude/Codex specifics in `subscriptions/index.js:58-71` (endpoints),
  `credentials.js`, `renewal.js`, `messages.js`, `responses.js`, `catalog.js` (two readers, two
  pooling rules), `accounts.js:828-1000` (two usage parsers) [read; 26 provider branches
  measured by a rough pattern count]. `accounts.js` (1,100 lines) does four jobs: the accounts
  oracle and its watch, account-status rendering for the tool (`:698-810`), two usage parsers,
  and bounded HTTP.
- **Fix.** One module per provider (`subscriptions/claude.js`, `codex.js`) exporting endpoints,
  credential parse, renewal request, usage parser, catalogue reader and wire attempt behind one
  `ProviderKind` record that `index.js` selects once; move `renderAccountStatus` beside
  `account-tool.js`.
- **Size.** Mostly moved code, about 1,500 lines, 9 files. **Risk.** Medium churn for little
  behaviour change; do it when a third provider arrives, not before.

### HR-EDGE-19 (minor, Q5) The extension and vocabulary loaders fail by logging

- **Where.** `gateway/extensions.js:157-195`, `gateway/vocabulary.js:152-179`.
- **Evidence.** [read] A file that fails to load is logged and skipped; the gateway serves. For
  the vocabulary this fails closed (fewer keys, more refusals) and for `m4-secrets.js` it fails
  closed (large secret writes refused), so it is safe; but the symptom is a browser error far
  from the cause, and no test asserts the production directories load without a skip.
- **Fix.** A unit test that loads the real `extensions/` and `guest/lib/` and asserts zero skip
  events. **Size.** About 20 lines, 1 test. **Risk.** None.

---

## 4. Not covered

- `resources/agent-host/impl/providers/**` except where this area copies it (HR-EDGE-3, -4);
  `durable.js` and the manager-vat side of Secrets, gateway and pools; `impl/index.js` beyond
  the wiring of the three subsystems.
- The guest library's content (`interfaces*.js`, `limits*.js`, `texts-m4.js`) beyond the names
  this area uses; the adapter-wide habit of importing `guest/session/staging.js` from adapter
  code (ten sites, one in this area) belongs to the resources review.
- `subscriptions/pool.js` selection rules, `pool-state.js` coalescing and `renewal.js` timing were
  read for structure, not checked for correctness against `m4-interfaces.md` 5 and 7.
- UI components' rendering and CSS (`conversation/*`, `sessions/*`, `presets/PresetEditor.js`),
  accessibility, and `ui/build.mjs` beyond feature discovery.
- Tests beyond the two fake modules and the account-chip test; perf checks; nothing was run.
- A security test of the WebSocket parser (fuzzing) and of the CSP; the reading in HR-EDGE-6 is
  a code review only.
