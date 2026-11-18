# M3 interface contract

Unit W3.0 of `milestones.md` M3. This file, `guest/lib/interfaces-m3.js` (what crosses a vat
boundary) and `resources/agent-host/impl/gateway/contract-m3.js` (Node and browser constants,
texts and hook types) are the contract the M3 builders (group A: W3.1, W3.2, W3.3, W3.4; group
B: W3.5, W3.6, W3.7) and the integration unit W3.8 build against without talking to each other.
`m1a-interfaces.md`, `m1b-interfaces.md` and `m2-interfaces.md` stay in force; M3 changes none of
their objects. Where this file and the guards disagree, the guards win and this file is wrong:
report it. Paths: `H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`,
`GW/` = `AH/gateway/`, `UI/` = `H/ui/`, `pkg/` = `packages/thixotrope/`. Spec items are `R2-n`,
`R4-n`, `R6-n`, `R7-n`, `R8-n`, `P-nn`, `W-n` of the specification (Part I; section 10 for the
parity checklist); "architecture n" is `designs/architecture.md` section n; "M2 n" is
`m2-interfaces.md` section n.

Decisions this contract makes (journal J-0510..J-0519; the joint cross-check of the M3, M4 and
M5 contracts was applied to this file, the guards and the milestones section at W3.0's settle step,
see "Cross-check" before section 1):

- **D-M3-1 Pass-through bridge.** A signed-in browser holds the daemon's own objects. The gateway
  runs `@endo/captp` per WebSocket connection with the `GatewayPowers` record as the answer of
  `fetch`; every object a vat call returns (a Session, Turn, QueueEntry, Backend, Preset, Blob,
  Secret, ...) is exported to the browser as it is, and a browser call on it is forwarded to it
  unchanged. The gateway keeps **no per-interface method table**: a method M4, M5 or any later
  milestone adds to a vat object is reachable from the browser with no gateway change.
- **D-M3-2 Guard before decode, in Node.** Because an exo guard runs only after a vat has decoded
  (and hardened, and interned the keys of) a message (architecture 3, fact 4), the bridge checks
  every browser call **on its encoded form, before CapTP decodes it**: bytes (frame guard), record
  keys against a fixed vocabulary (key guard), nesting depth, objects the page made, and calls in
  flight. The vocabulary is derived from the guards themselves (4.4), not written by hand.
- **D-M3-3 The gateway is a second registration of the agent-host native resource** (manager-kit
  key `gateway`, `GatewaySpec` carrying the operator's `Operator`), restored by the kit at every
  start; nothing wakes a session (D-5).
- **D-M3-4 Extensions by file, not by edit.** Later milestones add gateway services and routes as
  files under `GW/extensions/`, UI features as `UI/src/<dir>/feature.js` and browser-sendable
  record keys as a `vocabularyShapes()` export of their own `guest/lib/interfaces-m<N>.js`; nobody
  edits an M3 file, `ui/src/features.js` or a key table to add a panel, a route, a gateway service
  or a record shape (section 6). M3 itself edits no shared contract file (`interfaces.js` is
  untouched: hotspot H2 extends the manager's facet guard locally).
- **D-M3-5 The UI is a copy-and-adapt of `space-floot` and `chat/floot-*.js` at 1315bef86**
  (architecture 7), restructured as a controller (`UI/src/controller/`) and views; the view keeps
  its look and texts, the controller speaks to `GatewayPowers` instead of pet names.
- **D-M3-6 Fixed-window performance** (owner's rule of 2026-11-18): every M3 perf check measures a
  rate or a latency over a fixed window (60 s per point), no check or test file runs longer than
  10 minutes, and long sessions are built by import. With the M2 archive a session past 160 turns
  is in steady state (J-0461), so a 300-turn imported session stands for any length.

Contents: 1 scope; 2 the design in one page; 3 objects, holders and methods; 4 the gateway
protocol (HTTP, WebSocket, sign-in, guards); 5 what M3 takes from M2; 6 extension seams and the
other parallel milestones; 7 restart, crash and retry; 8 security; 9 the UI (controller, client
rules, spec mapping); 10 work units; 11 file ownership and merge hotspots; 12 acceptance; 13
performance; 14 fixed texts; 15 core requests; 16 owner decisions; 17 module entry points.

**Cross-check (applied at W3.0's settle step).** After the M3, M4 and M5 contracts were read
together, M3 changed: (1) no edit to `guest/lib/interfaces.js` (old hotspot H1 dropped; the
manager's facet guard is extended by `withGatewayAdmin` in H2, so the session and exec bundles do
not grow); (2) `GatewayContext.secretWriter()` and the matching H4 statement, so M4's
`GW/extensions/m4-secrets.js` can exempt `SecretWriter.replace` from the frame guard; (3) the
vocabulary loader reads every `interfaces-m*.js` and skips (with a log line) a file without
`vocabularyShapes()`, and the walk covers interface guards' argument patterns (4.4, 6.3); (4) a
`feature.js` may export an array of features, `composer.addon` gets the input and
`replaceRange`, every resend goes through the addon chain, `message.renderer` gets the turn's
`TurnStarted` record, and the new-session dialog shows preset availability (6.2, 9.1, 9.2); (5)
M3 owns only `_harness.mjs` and `m3-*.mjs` in `test/browser/`, with `startBrowserGateway` fixed
(17); (6) the journal range is J-0510..J-0529; (7) the Node perf rows are split over two files
and `ui.restartReady` uses a 150 s window per mode (13).

---

## 1. Scope

**Parity items delivered** (spec section 10): P-01 (chat UI shell and gateway on one origin),
P-02 (fragment sign-in, stable across restarts), P-04 (new-session flow: preset, backend, model
from the live catalogue plus "Factory default"; the internet toggle is M7's field in the
new-session slot), P-22 (conversation view), P-23 (reconnect overlay, rebuild, re-attach), P-24
(phone drawer), P-27 (usage status bar; the per-turn part is M2's), P-48 (turn journal and
recovery panel); the browser half of P-03 (live session list, rename, delete), P-09 (many
viewers, late joiners and reloads see the same), P-10 (queue rows: Send now, Edit, Delete, hold
line), P-11 (exactly-once submission from the page: draft and request id saved first, Web Locks),
P-12 (Stop; closing the page never cancels), P-14 (interrupted and outcome-unknown rows,
acknowledgement) and P-25 (every device sees the same).

**R items:** R2-1, R2-12 (with the `/ws` deviation, decision 1), R2-14, R4-62, R6-1, R6-8..R6-14,
R6-35..R6-39, R6-40 (composer, without @-mention), R6-41..R6-46, R6-49, R6-51, R6-52 (status
bar; account chips are M4's, the Network chip M7's), R6-59, R6-61, R6-62, R6-75, R6-76, R7-2,
R7-11, R7-13, R7-17, R7-46..R7-49, R8-39; W-1 (Origin check, one published object), W-8 (limiter
per forwarded client), W-15 (CSP) fixed.

**Left to later milestones** (each adds UI through the seams of section 6, never by editing M3
files): @-mention autocomplete and object chips (M5, `composer.addon`), preset editor (M5,
`app.panel`), Secrets view and account chips (M4), Network chip and internet toggle (M7),
emergency stop and resume (M6, `session.settings`), widgets (M12, `message.renderer`), mail
captions (M9), voice and the `/audio` route (M11), Home, spaces, command bar (M12), the admin CLI
(M12; M3 ships only `scripts/gateway.mjs` for the gateway itself), assistant launch R6-60 (M11).
Out of scope for parity: the reverse proxy and TLS (the gateway binds loopback), the browser peer
relay, Endo's `/dev` redirect.

---

## 2. The design in one page

```
browser page (UI/, Preact, SES lockdown)                      one WebSocket per page, path /ws
  controller --- @endo/captp (JSON in binary frames) ---------------------------+
                                                                                |
agent-host ADAPTER process (Node)                                               v
  GW/server.js  HTTP: shell, /assets/*, extension routes; upgrade /ws (Origin) -> GW/bridge.js
  GW/bridge.js  per connection: CapTP; pre-dispatch guard (frame, keys, depth, page objects,
                calls in flight, exports); bootstrap = GatewayBootstrap
  GW/powers.js  fetch(secret) -> GatewayPowers { operator (factory vat presence, passed through),
                live, content, composer, history (this incarnation's local objects), extras }
  GW/signin.js  sign-in secret: <state>/agent-host/gateway/signin.enc (secrets wrapping key)
  GW/limiter.js +1,000 ms per failure per client address (trusted proxies), global ceiling
       |  OCapN through the hub: only the calls a browser makes on vat objects
       v
  factory VAT (Operator, SessionFactory)   session VATs (Session, Turn, QueueEntry)   manager VAT
                                                                    (AgentHostAdmin.gateway() -> GatewayAdmin;
                                                                     kit registration `gateway`)
```

A page connects to `/ws`, calls `fetch(secret)` once, and from then on calls the daemon's objects
directly: `E(operator).getFactory()`, `E(factory).listSessions()`, `E(session).watch()`,
`E(live).subscribe(session, rev)`, `E(composer).submit(session, text, requestId)`. Live events
and deltas reach it from the adapter's channels in process (zero vat deliveries per delta, D-8).
The gateway is an adapter object of the agent-host process (D-12), so `Live`, `Content`,
`Composer` and `History` are local to it; the only traffic into vats is what the page asks for.
The listener's configuration and its `Operator` live in the manager vat as a kit registration
(D-M3-3); the sign-in secret lives in an encrypted adapter file and never enters a vat or the hub
(D-6).

---

## 3. Objects, holders and methods

Columns as M2 3: **caller**; **mode** (answered or sendOnly); **max** (largest message, bytes,
either direction); **retired break** (what a break with the hub's retired text means to the
caller); **heaviest crank** (in the vat that receives it). Sizes against `frameBytes` 24,576,
`inlineBytes` 8,192 and `crankOutBytes` 196,608 (`m0-results.md` page 1).

### 3.1 Manager vat (durable; W3.3, `resources/agent-host/durable-gateway.js`)

`AgentHostAdmin.gateway() -> GatewayAdmin` (the one method M3 adds to an existing interface).
It is added only to the guard of the manager's own facet, in `durable.js`, by
`withGatewayAdmin(m2Interfaces.AgentHostAdmin)` from `interfaces-m3.js` (hotspot H2);
`interfaces.js` and `m2MethodNames` are not edited, so the session and exec bundles do not grow
(0 bytes; W3.3 records it). A caller's `E(admin).gateway()` needs no guard of its own. The manager
keeps one `GatewayAdmin` for its life.

| method | caller | mode | max | retired break | what the manager does; heaviest crank |
|---|---|---|---|---|---|
| `AgentHostAdmin.gateway()` | operator (control socket), provisioning, tests | answered | tiny | manager lost | answers the one `GatewayAdmin`; no state |
| `GatewayAdmin.serve(GatewayConfig) -> GatewayStatus` | operator, provisioning step, tests | answered (settles after the adapter's bind) | <= 3.4 KB in (16 proxies, a 2,048-unit origin), ~0.3 KB out | manager lost | closes the previous registration handle if any (kit `close`), then `manager.register(GATEWAY_KEY, { sink, config })`; the kit builds or reuses the adapter and calls its `bind`; answers the status the adapter attached with (`GatewaySink.attach`) or `{ state: 'failed', error: m3TextOf.gatewayFailed(kit error) }`. Crank: one register, one stored config; 2-4 manager cranks per call |
| `GatewayAdmin.status() -> GatewayStatus` | operator, tests | answered | ~0.3 KB | manager lost | `{ state: 'stopped' }` with no registration; else `E(ops).status()` on the attached `GatewayOps` (one answered call); a retired ops facet (adapter restarted, not yet re-attached): `{ state: 'starting' }` |
| `GatewayAdmin.rotateSignIn()` | operator | answered | tiny | manager lost | `E(ops).rotateSignIn()`; no registration or no ops: throws `m3Texts.gatewayNotAttached`. The value never passes the manager |
| `GatewayAdmin.stop()` | operator, tests | answered | tiny | manager lost | closes the registration (the kit unbinds: the adapter closes every connection with `closeCodes.gatewayStopped` and the listener); forgets the config |
| `GatewaySink.attach(GatewayOps, GatewayStatus) -> n` | the adapter's `bind` of `GATEWAY_KEY`, once per incarnation, after it listens | answered | ~0.4 KB | (adapter side: the manager is lost) | keeps the ops facet and the status; answers the attach count |

**Persists (manager vat heap):** the registration handle, the `GatewayConfig` (its `Operator`
presence included) and the last `GatewayOps` presence and status (a tombstone after a restart,
replaced by the next attach). One registration; nothing grows.

### 3.2 Gateway objects (agent-host adapter, transient; W3.1, W3.2, W3.7)

All live in the agent-host adapter process and die with it. None is ever given to a vat.

| object.method | caller | crank | max | notes |
|---|---|---|---|---|
| `GatewayOps.status()` | manager | - | ~0.3 KB | `{ state: 'serving', port, origin, connections, since }` |
| `GatewayOps.rotateSignIn()` | manager | - | tiny | mints 32 random bytes, writes `signin.enc` (temp file, fsync, rename, directory fsync), then closes every connection with `closeCodes.signInRotated`; answers after the write |
| `GatewayBootstrap.fetch(secret) -> GatewayPowers` | browser (CapTP bootstrap) | - | 256 units in | 4.3: penalty first, constant-time compare, then per-connection powers |
| `Live` (per-connection facade over the incarnation's `Live`) `subscribe(session, rev?)`, `subscribeList(rev?)` | browser | (A) | as M1b | the facade records each subscription and `close()`s it when the connection closes (a channel keeps at most 32 subscribers per session, `channelLimits`) |
| `Composer.submit` / `edit` | browser | (A) then the entry's crank | <= 200,000 units in (`messageUnits`), staged over `inlineBytes` | M2's Composer, unchanged; the bridge exempts these two methods from the frame guard (`LargeCall`) |
| `Content.read(blob, range)` | browser | (A) | <= `blobPageBytes` out | M1b; the page reads a large reply (1 MiB) in pages |
| `History.page(session, cursor?)`, `turnContent(...)`, `SealedText.read(...)` | browser | (A); a live cursor costs one session crank | <= frameBytes | M2 4.9; "Load earlier messages" past the kept turns and the recovery panel |
| extension services (`GatewayPowers.extras`) | browser | - | per service | section 6.1 |

**Persists:** only `<state>/agent-host/gateway/signin.enc` (the sign-in secret, encrypted with the
secrets wrapping key, M2 9.1). Limiter state, connections, CapTP tables and subscriptions are
memory and are lost by contract at a restart.

### 3.3 Objects a browser reaches through the operator (M1a-M2, passed through)

M3 adds no method to these. The table says what M3's UI calls and what each call costs a vat.

| object (vat) | methods the UI calls | from | max per call | vat cost |
|---|---|---|---|---|
| `Operator` (factory) | `getFactory()`; M4/M5 add their own | `GatewayPowers.operator` | tiny | 1 factory crank |
| `SessionFactory` (factory) | `listSessions({ after, limit })`, `sessionListFeed()`, `createSession(options)`, `deleteSession(session)`, `findSession(key)`, `listPresets()`, `listBackends()`, `listModels(request?)` | `getFactory()` | <= frameBytes out (50 rows) | 1 factory crank each; `createSession` as M1b/M2 (spare take) |
| `Session` (session) | `getInfo`, `rename`, `watch`, `listPending`, `getCurrentTurn`, `getHistoryPage`, `getUsage`, `findTurn`, `getSubmissionReceipt` | list rows, `findSession` | <= frameBytes out | 1 session crank each; never `enqueueOnce` (the Composer stamps `at`) and never `startTurn` |
| `Turn` (session) | `getStatus`, `cancel`, `resolve(note)`, `getContent(cursor?)` | `watch`/`getCurrentTurn`/history pages/`findTurn` | <= frameBytes | 1 session crank |
| `QueueEntry` (session) | `describe`, `cancel`, `sendNow` (edit goes through `Composer.edit`) | `listPending`, `pending` events | tiny | crank A for `sendNow` (M2 3.1) |
| `Backend`, `Preset` (manager, factory) | `describe()`; passed back to `createSession` / `listModels` | `listBackends`, `listPresets`, `ModelRow.backend` | tiny | 1 crank |
| `Blob` (manager) | none: passed to `Content.read` | records, events | - | 0 (Content is local) |

A browser holds at most `exportsPerConnection` (4,096) such objects per connection (4.5); each is
one OCapN import of the adapter and so one hub row entry of its vat while held (J-9386, J-9392).

---

## 4. The gateway protocol

### 4.1 HTTP (W3.1, `GW/server.js`, `GW/static.js`, `GW/csp.js`)

- Binds `127.0.0.1:<port>` only (R7-46, D-12); `port` 0 binds an ephemeral port (tests). Headers
  over `maxHeaderBytes` and paths over `maxPathUnits` are refused (431, 414).
- **Any request with a query string that carries `gateway` or `agent` parameters** is answered
  400 with `gatewayTexts.queryConfig` (R6-10, R7-48); the query is never logged.
- `GET /assets/<content-hashed name>`: the built files of `GW/assets/` (W3.4's build output; git
  ignored), correct content type, `Cache-Control: public, max-age=31536000, immutable` (R6-8);
  missing: 404 `gatewayTexts.notFound`.
- **Every other non-upgrade `GET` or `HEAD`** answers the app shell (`index.html`, title
  "Familiar", R6-8), `Cache-Control: no-cache`; while `GW/assets/` has no built shell: 503
  `gatewayTexts.uiNotBuilt`. Other methods: 405.
- Every response carries `Content-Security-Policy` from `cspDirectives` plus extension sources
  (W-15; a departure from R7-47, decision 2), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.
- Extension `http` routes (`GatewayRoute`, exact path) are served before the shell fallback; `/`,
  `/ws` and `/assets/*` cannot be taken.

### 4.2 WebSocket (W3.1 upgrade, W3.2 bridge)

- Upgrade on `WS_PATH` (`/ws`) only (decision 1), and on extension `upgrade` routes (M11
  `/audio`). Another path: 404. **Origin** must equal `publicOrigin` (or, without one,
  `http://127.0.0.1:<port>` or `http://localhost:<port>`): otherwise 403 `originRefused` (W-1;
  a departure from R7-48's "no Origin checks").
- Connections: at most `maxConnections` (64) in all and `connectionsPerAddress` (16) per client
  address (4.3); over: 503 before the upgrade.
- Frames: **binary**, each one CapTP message as UTF-8 JSON (R2-14, R6-11); a text frame, bad
  UTF-8 or bad JSON closes with `closeCodes.protocol` (as Endo, R6-11); a message over
  `wsMessageBytes` (1 MiB) closes it too (`ws` `maxPayload`).
- A connection that has not completed `fetch` within `signInDeadlineMs` (15 s) is closed
  (`closeCodes.signInDeadline`); before `fetch` only `CTP_BOOTSTRAP` and the `fetch` call are
  dispatched, anything else is answered with `gatewayTexts.notSignedIn`.

### 4.3 Sign-in (W3.1 `GW/signin.js`, `GW/limiter.js`; W3.2 `GW/powers.js`)

- **The secret** is 32 random bytes (`node:crypto`), shown as 64 lowercase hex digits, minted by
  the gateway at its first bind (R8-39) and kept in `<state>/agent-host/gateway/signin.enc`:
  AES-256-GCM with the secrets wrapping key (M2 9.1 `loadWrappingKey`, `encrypt`, `decrypt`,
  `findSecretsFiles`, used read-only; additional data `thixotrope-harness-signin-1`), written
  temp-then-rename with fsyncs. Stable across restarts (P-02) until `rotateSignIn`. The gateway
  keeps only its SHA-256 in memory and compares digests with `timingSafeEqual`.
- **The URL** the operator opens: `<publicOrigin>/#gateway=<host[:port]>&agent=<secret>` (R6-9;
  the parameter names are kept so the page's parser matches the spec). `scripts/gateway.mjs url
  <state>` prints it by reading `signin.enc` locally with the wrapping key; nothing carries the
  secret through the control socket or the hub.
- **The client address** (W-8): the socket peer, unless the peer is in `trustedProxies`; then the
  right-most `X-Forwarded-For` entry that is not in `trustedProxies` (the peer if none). An
  untrusted peer's `X-Forwarded-For` is ignored.
- **Penalty** (R6-76, R7-49): before comparing, if the address's next allowed attempt is in the
  future, `fetch` rejects with `m3TextOf.rateLimited(ms)`; a failed comparison pushes the
  address's next attempt `signInPenaltyMs` (1,000 ms) later, cumulatively from
  max(now, previous deadline), and rejects with `m3Texts.signInRefused`; an entry is forgotten
  `signInForgetMs` (10 s) after its deadline. **Global ceiling** (W-8): more than
  `signInFailuresPerMinute` (default 20, `GatewayConfig`) failures in the last 60 s from all
  addresses make every `fetch` reject with `m3Texts.signInCeiling` until the oldest ages out.
  A success clears nothing but the caller's own entry.
- **Success** builds the connection's powers (`GW/powers.js`): `operator` (the presence from the
  registration's config), a per-connection `Live` facade, and the incarnation's `content`,
  `composer`, `history` and `extras`. A second successful `fetch` on one connection answers the
  same record.

### 4.4 The bridge guard (W3.2 `GW/bridge.js`, `GW/guard.js`, `GW/vocabulary.js`)

Every message a browser sends is parsed as JSON and, for `CTP_CALL`, checked **before** it is
given to CapTP's `dispatch` (captp's `capdata` body format: `@qclass` encodings and `slots`):

1. **Target.** The gateway records, from captp's `exportHook`, which local value each of its
   export slots is (a `WeakRef`-free `Map` per connection, entries dropped on `CTP_DROP`). A call
   whose target is an answer the gateway does not hold, or an unknown slot, is refused
   `notSignedIn`.
2. **Page objects.** A call whose `method.slots` name an object or promise the **browser**
   exported (`o+n`, `p+n` from the browser's side) is refused `browserObject`: no durable vat may
   hold a per-connection object (rule 12.7), and the gateway has no use for page callbacks.
3. **Frame guard.** `Buffer.byteLength(method.body)` must be at most `frameBytes`, unless the
   target is a `LargeCall` local object and the method is one of its `methods` (M3: the
   Composer's `submit`, `edit`; M4 adds the gateway's in-process secret writer's `replace`,
   A-11); then only `wsMessageBytes`
   holds. Refusal: `messageTooLarge` (architecture 7).
4. **Key guard.** Walking the body's JSON to depth `argumentDepth` (32; deeper: `tooDeep`), every
   key of every plain object that is not a `@qclass` encoding must be in the **vocabulary** (6.3):
   the record keys of every pattern reachable from (a) every value of `shapes`, `interfaces` and,
   while it exists (until the W2.9 fold), `m2Interfaces` of `guest/lib/interfaces.js`, and (b) the
   patterns answered by the `vocabularyShapes()` export of **every** `guest/lib/interfaces-m*.js`
   file (glob `interfaces-m*.js`, so `interfaces-m3.js`, `interfaces-m4.js`, `interfaces-m5.js`,
   `interfaces-m5-factory.js` and any later one; a file without the export, or whose import or call
   throws, is logged `{ event: 'vocabulary-skip', file, error }` and skipped). The walk
   (`collectRecordKeys`) descends copyRecords (keys collected, values walked), copyArrays and
   tagged values, so it covers shapes **and** interface guards:
   - a `match:*` tagged value (`M.splitRecord`, `M.or`, `M.arrayOf`, `M.string(limits)`, ...):
     its payload is walked like any value (so `splitRecord`'s required and optional records give
     their keys; a limits record adds names such as `stringLengthLimit`, harmless: fixed names
     every program has);
   - a `guard:interfaceGuard`: its payload's own keys and the method names (the keys of
     `methodGuards`) are **not** collected; each method guard in `methodGuards` is walked;
   - a `guard:methodGuard`: its payload's own keys are not collected; `argGuards`,
     `optionalArgGuards`, `restArgGuard` and `returnGuard` are walked (an `M.await(...)` wrapper,
     `guard:awaitArgGuard`, is walked through to its pattern; `guard:rawGuard` adds nothing).
   No harness pattern uses `M.recordOf`; a lane that adds one gets no free keys through the
   gateway (its keys must still be in the vocabulary). Computed once per incarnation (measured in
   Node at W3.0: 290 keys from the M2 tables in 22 ms; measured after the M2 review and the M3 merge:
   258 keys and 140 method names in about 36 ms, J-9630). A key outside it is refused `unexpectedField` (rule 12.10; it also closes
   the `M.any()` fields of `CreateOptions`, `networkPolicy` and `model`, through which a record of
   invented keys would reach the factory vat). Rule 4 checks keys; whether a given object has a
   method stays the business of that object's own exo guard (an undeclared method is refused by
   the vat as today), and rule 4a below only bounds which names reach a vat. The vocabulary is a fixed set of names every harness vat's program
   already contains, so a browser can make a vat intern at most these few hundred names, ever.

   4a. **Method names** (M3-FIX, J-9630). The same walk also keeps the method names (the keys of
   every interface guard's `methodGuards`) as a second set, `methods`. A call or property get
   toward a target that is not gateway-local (a vat presence, or an answer a page pipelines on)
   must name a method in `methods`; a function application toward one is refused; a passable
   symbol (`@qclass: 'symbol'`), as an argument or as the method toward any target, must name one
   of `methods`. Refusal: `unknownMethod`. A vat decodes every selector and symbol as a registered
   symbol, so without this a page could make a vat register any number of fresh names. Toward a
   gateway-local object a string name stays that object's own guard's business. Browser-reachable
   objects of later lanes must have their guards answered by `vocabularyShapes()` (6.3), or the
   gateway refuses their methods.
5. **Calls in flight.** At most `callsInFlight` (32) answered calls per connection whose target
   is not a gateway-local object; one more is refused `tooManyCalls`.

A refused call is answered with a `CTP_RETURN` exception carrying the text; nothing reaches the
target and the connection stays open. Results flow back unchecked (they come from the daemon).

### 4.5 Exports, GC and closing

- captp runs with `gcImports: true` on the browser side, so a page that drops a presence sends
  `CTP_DROP` and the gateway releases its export (and with it, at the adapter's next collection,
  the OCapN import: a GC frame to the vat, held until that vat's next crank, J-9392).
- More than `exportsPerConnection` (4,096) live exports on one connection: closed with
  `closeCodes.tooManyObjects`; the page rebuilds (9.2). The UI keeps at most the visible session's
  pages and the list, so this is a leak detector, not a working limit.
- Answers (XA): captp keeps one answer per page question until the page drops it (`CTP_DROP` of
  `q-n`, sent when the question's promise is collected), and the bridge mirrors that table (rule
  1 targets, duplicate ids). Both are bounded by `answersPerConnection` (4,096, `gatewayLimits`):
  when a new question would exceed it, the oldest **settled** answer is forgotten on both sides
  (the bridge dispatches to the gateway's captp the `CTP_DROP` the page would have sent, so the
  answer and its payload are released). A well-behaved long-lived page is never closed for it; a
  later call pipelined on a forgotten answer is refused `notSignedIn` (rule 1). Only when every
  kept answer is still unsettled is the connection closed with `closeCodes.tooManyObjects`.
  `stats()` of a connection reports `answers`, `answersPeak`, `answersEvicted`, and the
  `gateway-connection-closed` log line carries the last two. Measured with `perf/gateway.perf.mjs`
  (the client's held questions per 60 s window, J-10008).
- When a connection closes (either side, or the adapter stops it): captp `abort`, every
  subscription its `Live` facade opened is closed, its exports are dropped. Nothing is cancelled
  in any vat: closing a page never stops a turn (R6-49).

---

## 5. What M3 takes from M2

Every object and method M3 uses, as `m2-interfaces.md` and the code at `3588cab190` define it.
W3.8 checks each against M2 as merged (a contract change of M2 after this point is reported to the
PM as a W3.0 follow-up).

| from | object.method | used by |
|---|---|---|
| M1a/M2 `HarnessRoot` | `getOperator()` | provisioning step, tests (the `operator` of `GatewayConfig`) |
| M2 `Operator` | `getFactory()`, `getSecrets()` | UI (factory); M4's Secrets view (secrets) |
| M2 `SessionFactory` | `createSession`, `listSessions`, `sessionListFeed`, `findSession`, `listPresets`, `deleteSession`, `listBackends`, `listModels` | UI sessions (W3.5) |
| M2 `Session` | `getInfo`, `rename`, `watch`, `getSubmissionReceipt`, `listPending`, `getCurrentTurn`, `getHistoryPage`, `getUsage`, `findTurn` | UI controller and conversation (W3.4, W3.6) |
| M2 `Turn` | `getStatus`, `cancel`, `resolve`, `getContent`, `whenFinished` | conversation, recovery panel |
| M2 `QueueEntry` | `describe`, `cancel`, `sendNow` | queue rows |
| M2 `Composer` | `submit(session, text, requestId)`, `edit(entry, text)` | composer, queue Edit |
| M1b `Live`, `LiveSubscription`, `ListSubscription` | `subscribe`, `subscribeList`, `next`, `close` | controller |
| M1b `Content` | `read(blob, range)` | large texts |
| M2 `History`, `SealedText` | `page`, `turnContent`, `read`, `describe` | Load earlier, recovery panel |
| M1b `AgentHostAdmin` | `live()`, `composer()`, `content()` (ops: `live`, `composer`, `content`); M2 `history()` | gateway composition (W3.7) through `makeAgentHostImpl`'s local objects, not through the manager |
| M2 secrets store (`AH/secrets/store.js`) | `findSecretsFiles`, `loadWrappingKey`, `encrypt`, `decrypt` | `GW/signin.js` (read-only use; no edit) |
| manager kit (`pkg/src/native/manager-kit.js`) | `register(key, spec) -> { handle, status }`, `handle.close()`, restore of every desired key at each new adapter incarnation | `durable-gateway.js` |
| shapes | `SessionRow`, `SessionPage`, `WatchSnapshot`, `PendingView`, `Receipt`, `TurnStatus`, `HistoryPage`, `CurrentTurn`, `Delivery`, `LiveBatch`, `ListBatch`, `ModelPage`, `UsageTotals`, `VatEvent`, `FoldableStatus` | the controller's state model |

**Assumptions** (things `m2-interfaces.md` does not settle; the build proceeds on them and W3.8
verifies each):

- A-1. An OCapN presence of a vat object in the adapter process is a passable remotable to
  `@endo/captp`'s marshal (the same `@endo/pass-style`), and `E(presence)` from captp's dispatch
  forwards over OCapN. If not, W3.2 wraps each in a forwarding `Far` per presence (identity kept
  by a `WeakMap`), still without per-interface tables.
- A-2. A presence a vat returns twice is the same presence within one incarnation (S2 (d)), so a
  page can compare sessions and turns by identity across calls on one connection.
- A-3. The manager kit restores the `gateway` key at every new adapter incarnation (daemon start
  and adapter-only rebuild), after `agent-host` (insertion order), and its `bind` may await a
  listen. Read in `manager-kit.js` (`restore` of every `desired` entry); not yet exercised by the
  harness.
- A-4. `Composer.submit` stages any text up to `messageUnits` over `inlineBytes` and stamps `at`
  (M2 W2.4); `Composer.edit` the same for an entry.
- A-5. R6-43 "sending is blocked while a journal resolution is pending": M2's session accepts
  `enqueueOnce` while an outcome-unknown turn is unresolved, so the block is the page's: the
  composer is disabled while `watch().current` is `outcome-unknown` without `resolution`.
- A-6. A `createSession` whose answer is lost (connection dropped) cannot be retried
  idempotently (`CreateOptions` has no request id): a retry may make a second "New chat" (decision
  7).
- A-7. `SessionRow.state` `creating`/`deleting` and `activity` are what R6-36's status circle
  shows (Working while creating or deleting; Error for `error` and `lost`).
- A-8. The archive (M2 4.9): a page's "Load earlier messages" uses `Session.getHistoryPage` until
  a page answers `archived: true`, then `History.page(session, next)`; turns are compared by
  `turnId` (archived turns have no `Turn`, M2 4.9).
- A-9. `ModelPage` has no search argument: the dialog filters loaded rows client-side and loads
  further pages with `after` (R6-38's "searchable").
- A-10. The W2.9 fold of `m2Interfaces` into `interfaces` may land before or after M3 merges; the
  H2 seam (section 11) passes to `withGatewayAdmin` the `AgentHostAdmin` guard `durable.js`'s facet
  uses, which is `m2Interfaces.AgentHostAdmin` before the fold and `interfaces.AgentHostAdmin`
  after. Either is an `M.interface` with `payload.methodGuards` (CC-072).
- A-11. A presence the hub returns for one of the adapter's own exports resolves to the local
  object (`pkg/src/net/hub.js:804-812`, architecture 7). **Superseded for the writer by XA
  (2026-11-18):** the hub-reachable `SecretWriter` (`E(secretsAdmin).openWriter()`) takes a
  `SealedBox` only (m2-interfaces 9.2), so a plain value can never travel through the hub in
  clear. A page writes through the gateway's own in-process writer instead: one gateway-local
  exo per incarnation (`GatewaySecretWriter`: `replace(secret, value | SealedBox,
  expectedGeneration?)`, `publicKey()`), made by `GW/index.js` over M2's `replaceLocal`, offered
  first in every page's `GatewayPowers.extras` under `secretWriterLabel` (`'secretWriter'`,
  `contract-m3.js`) and answered by `GatewayContext.secretWriter()`, so M4's
  `GW/extensions/m4-secrets.js` `LargeCall` target is the object a page calls. The value goes from
  the page's WebSocket to the store in the agent-host process (J-0440's condition for a browser
  path); before the attach the writer's methods reject (`notAttachedText`). Checked by
  `m2-secrets.test.js` (the state grep after a page's write) and
  `test/adapter/m2-secret-writer-paths.test.js`; acceptance 16 checks that the context's writer is
  the page's extras writer and not the hub's.

---

## 6. Extension seams, and the other parallel milestones

### 6.1 Gateway extensions (files under `GW/extensions/`)

`GW/extensions.js` (W3.2) loads every `GW/extensions/*.js` in name order at adapter start (the
adapter loads ES modules synchronously with `require`, so no top-level await) and reads its
`gatewayExtension` export (`GatewayExtension`, `contract-m3.js`):

- `services: [{ label, make(context) }]`: one object per incarnation, offered to every signed-in
  page in `GatewayPowers.extras` as `{ label, service }` (at most 32 in all). Its methods are
  guarded by its own exo guard, and the bridge's frame and key guards apply to calls on it like
  any other target (`largeCalls` exempts named methods).
- `routes: [{ kind: 'http' | 'upgrade', path, handle }]`: exact paths; an upgrade route does its
  own authentication (M11's `/audio` uses a capability token minted through an extras service).
- `largeCalls: [{ target(context), methods }]`: `target` is awaited once per incarnation, after
  `whenAttached`; the frame guard compares a call's target with the resolved object by identity.
- `csp: { directive: [sources] }`: added, never removed.

The `GatewayContext` an extension receives (`contract-m3.js`): `live`, `composer`, `content`,
`history()`, `whenAttached(callback)`, `secretWriter()` (the incarnation's one `SecretWriter`,
resolved lazily from `AH/secrets/manager.js`'s `secretWriter`, which makes it once per
incarnation, so it is the same object a page gets from `SecretsAdmin.openWriter()`, A-11; it
rejects before the agent host is attached), `stateDir` and `log`. M4's `GW/extensions/m4-secrets.js`
is `{ name: 'm4-secrets', largeCalls: [{ target: context => context.secretWriter(), methods:
['replace'] }] }`.

A file is owned by the milestone that adds it (`m4-secrets.js`, `m11-audio.js`, ...). A file that
throws while loading is logged and skipped; the gateway still serves.

### 6.2 UI features (files `UI/src/<dir>/feature.js`)

`UI/build.mjs` (W3.4) collects every `UI/src/*/feature.js` in directory-name order into the
bundle (it generates the import list; `UI/src/features.js` is the collector and is never edited
by another lane). Each file exports `feature`: **one `UiFeature` or an array of them** (so
`UI/src/accounts/feature.js` may export M4's Subscriptions panel and its status-bar chip, and
`UI/src/mentions/feature.js` M5's composer addon and its attachment-chip renderer); `id`s are
unique over all files (the directory name, or `<dir>.<part>` for several), and a duplicate fails
the build. Slots (`uiSlots`) and the props each slot's `component` receives:

| slot | used by | props |
|---|---|---|
| `app.panel` | M4 Secrets, Subscriptions; M5 preset editor; M12 Home | `{ context }`; opened from the header menu by `label` |
| `header.chip` | M7 Network | `{ context }` |
| `statusbar.chip` | M4 account chips | `{ context }` |
| `composer.addon` | M5 mentions, M11 voice | `{ context, input: { text, caret }, replaceRange(start, end, text) }` (`ComposerAddonProps`); optional `send(ComposerSendRequest)`, 9.2 |
| `newSession.field` | M7 internet toggle | `{ context }` |
| `session.settings` | M6 emergency stop | `{ context }` |
| `message.renderer` | M5 attachment chips, M9 captions, M12 widgets | `{ context, turn, record }` (`MessageRendererProps`): once per turn, under the turn's user message; `record` is the turn's `TurnStarted` (or live `turn-start`) record with unknown optional fields kept |

A feature receives a `FeatureContext`: the connection's `powers` (presences), `extra(label)`, the
controller (read-only state, `subscribe`, the actions of 9.1) and `call(fn)`. The shell renders
slots; a feature that throws while rendering is shown as an error line in its slot, not a broken
page. Features use `globalThis.<api>` for browser APIs (lint: section 11, H7).

### 6.3 Vocabulary

The gateway (`GW/vocabulary.js` `harnessVocabulary`) loads **every** `guest/lib/interfaces-m*.js`
at adapter start, `interfaces-m5-factory.js` included, and walks the patterns its
`vocabularyShapes()` export answers; a file without that export, or whose import or call throws,
is logged and skipped (its keys are then refused, which the lane's own browser test would show).
The walk covers shapes and interface guards alike (4.4: an interface's method argument patterns
are walked). The rule for a lane is one line in its own contract file, as M3's:

`export const vocabularyShapes = () => harden([...Object.values(mNShapes), ...Object.values(mNInterfaces)]);`

There is no table to append to: a record shape a later milestone adds is admitted through the
gateway once its contract file exists and exports the function. Method checking is not the key
guard's: an undeclared method is refused by the target's own exo guard.

### 6.4 With M4 (secrets manager, subscription pools) and M5 (presets, prompts, tools, grants)

M3 **needs nothing** from M4 or M5 to build or pass its acceptance. It **offers**:

| to | what M3 offers | what the other milestone adds, by file only |
|---|---|---|
| M4 | pass-through of `Operator.getSecrets()`, `SecretsAdmin`, `Secret`, `SecretWriter` (adapter-local: a browser's `replace` stays in the agent-host process, A-11); `GatewayContext.secretWriter()` for its `largeCalls` target; slots `app.panel`, `statusbar.chip` | `UI/src/secrets/feature.js` (Secrets view, `app.panel`, label "Secrets"); `UI/src/accounts/feature.js` exporting an array: the Subscriptions panel (`app.panel`) and the account chip (`statusbar.chip`); `GW/extensions/m4-secrets.js` (`largeCalls: [{ target: c => c.secretWriter(), methods: ['replace'] }]`); `export const vocabularyShapes` in `guest/lib/interfaces-m4.js`; `test/browser/m4-*.mjs`. A secret value must fit `wsMessageBytes` (1 MiB) with its JSON and CapTP envelope: M4 states its own browser bound below that |
| M5 | `composer.addon` with `ComposerAddonProps` (input text and caret, `replaceRange`) and the `send` override, used for the first send and every resend (9.2); `message.renderer` with the turn's `TurnStarted` record (attachment chips); `app.panel`; the new-session dialog reads `Preset.describe()` `available` / `unavailableReason` when present (9.1) | `UI/src/presets/feature.js` (preset editor, `app.panel`); `UI/src/mentions/feature.js` exporting an array: the mention addon (`composer.addon`, whose `send` calls `E(context.powers.composer).submit(session, text, requestId, { attachments })` and throws a fixed text on a resend whose chips a reload lost) and the attachment-chip renderer (`message.renderer`); `export const vocabularyShapes` in both `guest/lib/interfaces-m5.js` and `interfaces-m5-factory.js`; `test/browser/m5-*.mjs`. Preset objects pass through as `Preset` presences |

**Testing against M3 from another lane.** M4's and M5's UI component tests import
`test/unit/_m3-fake-powers.js` (W3.4, section 17) and so run once M3's group A is merged into the
shared branch. Their browser acceptance (M4 #14, M5 #15) is written against
`test/browser/_harness.mjs` `startBrowserGateway` (W3.8, section 17; fixed signature) and runs, gated
by `THIX_HARNESS_BROWSER=1`, after M3 is merged; no other acceptance item of M4 or M5 waits on M3.
In `test/browser/`, M3 owns `_harness.mjs` and `m3-*.mjs`, M4 `m4-*.mjs`, M5 `m5-*.mjs`. The PM
merges M3 first (its group A as early as possible), then M4, then M5.

### 6.5 Later milestones

M6 `session.settings` (emergency stop); M7 `header.chip` (Network) and `newSession.field`
(internet toggle); M9 `message.renderer` (mail captions); M11 `GW/extensions/m11-audio.js`
(upgrade route), `composer.addon` and `UI/src/voice/feature.js`; M12 `app.panel` (Home, spaces),
`message.renderer` (widgets, with its CSP addition for the isolated frame).

---

## 7. Restart, crash and retry

| durable thing | where | after a clean restart | after SIGKILL | kill points to test |
|---|---|---|---|---|
| gateway registration (config, `Operator`) | manager vat heap + kit desired map | restored by the kit when the agent-host adapter is built at start; listens again on the same port; no vat besides the manager and the factory's start listener (M1b) is woken (D-5) | same, from the journal | K1: SIGKILL after `serve`'s register crank, before the bind answered: after restart the registration is restored and serves |
| sign-in secret | `signin.enc` | unchanged (P-02) | old or new file, never neither: rename is atomic and fsynced | K2: SIGKILL during `rotateSignIn` (between temp write and rename, and after): after restart exactly one of the old and new secrets signs in, and `gateway.mjs url` prints that one |
| submissions | session vat (M2 receipts) + the page's saved draft and request id (`localStorage`) | the page resends from the draft; `enqueueOnce` by request id answers the same receipt (`duplicate: true`) | same | K3: SIGKILL after `Composer.submit` staged a large text and before the enqueue crank; K4: after the enqueue crank, before the answer reached the page. Both: one transcript entry after resend |
| a turn in flight | session vat (M2 recovery) | M2: `outcome-unknown` or `interrupted`; the page shows the status row | same | K5: SIGKILL mid-stream with two pages watching: both show the recovered state and no provider request or tool run happened twice (M2's fake-provider and echo logs) |
| everything else of the gateway | memory | lost by contract: pages reconnect (9.2) | same | - |

M3 adds **no call on the turn path** and nothing that retries one: every vat call a page makes is
either a read, idempotent (`rename`, `cancel`, `deleteSession`, `enqueueOnce` by request id,
`sendNow`), or user-visible if repeated (`createSession`, A-6). So M3 can duplicate no provider
request and no tool run.

**During startup** (D-17): while a crashing vat holds startup nothing listens; the page sees a
refused connection and shows "Server starting..." (9.2). The gateway binds about 65 ms after
serving (S2 (c)); `ui.restartReady` measures it.

**The adapter process alone** dies (not the supervisor): every connection drops; the kit rebuilds
the adapter at the next call that needs it and restores both keys; pages reconnect.

---

## 8. Security

| principal | can reach | cannot reach |
|---|---|---|
| anonymous network client (through the proxy) | the shell and assets; a WebSocket upgrade with the right Origin; `fetch` (rate limited) | any vat object; any HTTP content route (there is none); the secret (never sent in HTTP) |
| a page with the sign-in secret | `GatewayPowers`: the `Operator` (full operator authority, as R7-2: one principal) and the local `Live`, `Content`, `Composer`, `History`, extras; everything reachable from them | `AgentHostAdmin`, `GatewayAdmin`, `HarnessRoot`, `SessionInternal`, `RowReporter`, any manager sink, any secret value (secret objects yes, values no: `SecretWriter` only writes) |
| a model (session vat, exec vat) | its `SessionServices` (M1a-M2) | every gateway object: no session holds one, and nothing in `GatewayPowers` is handed into a session (M4 acceptance 5 checks "gateway facet" by `thix reachability`) |
| the operator (control socket) | `AgentHostAdmin.gateway()` -> `GatewayAdmin`; `scripts/gateway.mjs` | the secret through the socket (the script reads the file locally) |

- **The sign-in secret** never enters a vat, the hub or a log: compared in the adapter process
  (digest in memory); the file is encrypted at rest with the wrapping key outside the state
  directory (D-6); `rotateSignIn` carries no value. The page keeps it in the URL fragment and
  `sessionStorage`; it is sent only inside the WebSocket (R2-14). Acceptance 2 checks that no
  HTTP request line or header contains it.
- **Logs**: the gateway logs connection open/close (address, close code), refusals (rule, target
  interface label, byte count) and sign-in failures (address); never a message body, a fragment,
  a query string or a secret.
- **Transcripts and journals**: M3 writes nothing into them except what a page submits through
  the Composer (the user's text, by design).
- **Browser-made objects** never reach a vat (4.4 rule 2).
- **Fresh record keys** reach no vat from a page (4.4 rule 4); **oversize frames** neither (rule
  3). Both are checked before decoding, in Node.
- **Origin check, CSP, limiter per forwarded client, global ceiling, rotation**: W-1, W-8, W-15.
  Remaining exposure (journal J-0515): one bearer secret is full authority (R7-2); anyone with the
  URL is the operator until rotation.

---

## 9. The UI

### 9.1 Controller (W3.4, `UI/src/controller/`)

`makeController({ powers, storage, locks, now }) -> UiController`. `storage` is
`globalThis.localStorage` (or a fake), `locks` `globalThis.navigator.locks`. State (pure data;
re-read after each `subscribe` notification):

```
{ connection: 'unconfigured'|'connecting'|'open'|'reconnecting'|'starting'|'refused',
  sessions: [{ key, title, state, activity, backendTitle, modelId, effort?, messageCount,
               queuedCount }],           // from listSessions + the list feed; `key` names a row (F.2 d)
  activeKey,
  presets: [{ index, label, available, unavailableReason? }], // from listPresets + describe()
  backends: [{ index, label, kind }],
  models: { rows, state, next?, error? }, // for the new-session dialog
  view: { info, messages, streamingText, phase, busy, current?, pending, hold?,
          usage, earlier: 'none'|'more'|'loading', status,
          input: { text, caret }, sendError? } | null,
  recovery: { turns, next?, loading } | null, settingsOpen, drawerOpen }
```

Actions: `selectSession(key)`, `newSession({ presetIndex?, backendIndex?, modelSelection?,
title? })`, `renameSession(key, title)`, `deleteSession(key)`, `send(text)`, `stop()`,
`sendPendingNow(entryKey)`, `editPending(entryKey, text)`, `cancelPending(entryKey)`,
`loadEarlier()`, `openRecovery()`, `resolveTurn(turnId, note)`, `readContent(staged) -> text`,
`setInput(text, caret?)`, `replaceInput(start, end, text)` (what `replaceRange` calls),
`toggleDrawer()`, `toggleSettings()`, `refreshModels(backendIndex)`. String keys
appear only where the page re-finds an object it holds (F.2 d): the controller keeps
`Map<key, Session>` from the rows it received, `Map<entryKey, QueueEntry>` from `PendingRow`s,
turns by `turnId` from history pages.

**Presets in the new-session dialog** (R6-38): the controller calls `listPresets()` and then
`E(preset).describe()` for each and keeps `{ index, label, available, unavailableReason }`; a
description without `available` (M2's chat-only presets) counts as available. The dialog shows an
unavailable row disabled with its `unavailableReason` under the label; it cannot be chosen. A
`describe()` that rejects shows the row disabled with `uiTextOf.statusError(message)`.

**Records are kept as received.** Every record and event the controller stores (history-page
records, `VatEvent`s, `PendingRow`s) is kept as the daemon sent it; the controller reads the fields
it knows and never copies records onto M2's keys, so an optional field a later milestone adds
(M5's `TurnStarted.attachments`) reaches `message.renderer`.

### 9.2 Client rules

- **Connect** (R6-11, R6-12): parse the fragment (`gateway`, `agent`; no path, query, credentials
  or whitespace in `gateway`, trailing slash stripped); no fragment: "Gateway not configured"; a
  query string with either parameter: refused (R6-10). Open `wss://<gateway>/ws` (`ws://` for a
  loopback origin), CapTP, `E(bootstrap).fetch(agent)`; 15 s deadline for both.
- **Reconnect** (R6-13, R6-14): on close or error a full-screen overlay "Reconnecting…", delays
  0, 1, 2, 5, 10, 30 s then every 30 s, reset after a connection whose `fetch` succeeded; a
  refused connection (no listener) shows "Server starting..." (D-17); a rejected `fetch` stops
  retrying and shows the text. After reconnecting the controller rebuilds everything from the new
  powers: `listSessions` (all pages), `subscribeList(rev)`, and for the active session `watch()`,
  `subscribe(session, rev)`, `getCurrentTurn()` (re-attach, R4-62) and the newest history page.
- **Live** (M1a 5): `watch()` first, then `subscribe(session, rev)`; a rev gap or a `closed`
  batch re-watches. One `next()` waiting per subscription.
- **Exactly once** (R6-41, R6-42): before sending, the page writes `{ sessionKey, text,
  requestId }` to `localStorage` under a Web Lock named for the session; then it sends through the
  **addon chain**: each `composer.addon` feature with a `send`, in slot order, is called with
  `{ context, session, text, requestId, resend: false }`; the first that answers a promise sends
  (its promise answers the `Receipt`); if none does, the controller calls
  `Composer.submit(session, text, requestId)`. On the receipt it clears the draft. After a
  reconnect or reload, a saved draft is checked with `getSubmissionReceipt(requestId)`; only if it
  answers none is it resent, **through the same chain** with `resend: true` (an addon that keeps
  state beside the draft, such as M5's attachment chips, sees the resend and either sends the same
  submission or throws). When a `send` (or `Composer.submit`) rejects, the draft is kept, the
  composer's text is left as it was, and `view.sendError` shows the error's message
  (`uiTextOf.statusError`) until the next edit or send; nothing is retried automatically except
  the resend after a reconnect. The user's next Send in that session reuses the saved draft's
  `requestId` with the composer's current text (no receipt exists for it, so the id is unspent;
  if the lost original lands first, the receipt answers `duplicate: true` and the page shows the
  original). Without `navigator.locks` the composer is disabled with
  `uiTexts.noWebLocks`. `requestId` is M2's A.4 form (`guest/lib/pending-queue.js` `REQUEST_ID`):
  13 decimal digits of `Date.now()`, `-`, and a version 4 UUID from `crypto.getRandomValues`
  (`ui/src/controller/drafts.js` `newRequestId`). The contract's first text said 32 hex digits;
  a real session refuses that form (J-9604).
- **Stop** (R6-49): `E(turn).cancel()` on the running turn; leaving the page cancels nothing.
- **Send now** (R6-44): `E(entry).sendNow()` only. Since M2's review the session itself cancels
  the running turn when the head entry is sent now (`guest/session/queue.js` `cancelCurrent`,
  J-9491; the spec's "cancels the running turn so it goes next"); the page sends no
  `E(turn).cancel()` of its own, which could reach the turn send-now has just started.
- **Large content**: a `StagedText` shows its preview and loads the full text with `Content.read`
  in `blobPageBytes` pages on expand (a 1 MiB reply renders fully, acceptance 8).

### 9.3 Spec items to views (W3.5, W3.6)

| spec | view | source data |
|---|---|---|
| R6-36 sidebar, status circle, two lines, "No sessions yet" | `UI/src/sessions/Sidebar.js` | rows; `uiTextOf.rowCounts` |
| R6-37 rename (Enter, Esc, double-click title), delete with `confirm` | `Sidebar.js`, `UI/src/shell/Header.js` | `rename`, `deleteSession` |
| R6-38, R6-39 new-session dialog | `UI/src/sessions/NewSession.js` | `listPresets` + `Preset.describe()` (`available`, `unavailableReason` when present), `listBackends`, `listModels`; `ModelRow.reasoningEfforts` for R6-39; feature slot `newSession.field` |
| R6-40 composer (Enter, Shift+Enter, IME) | `UI/src/conversation/Composer.js` | the addon chain then `Composer.submit` (9.2); slot `composer.addon` with `ComposerAddonProps` |
| R6-43 blocked sending with a status | `Composer.js` | row state, A-5 |
| R6-44 queue rows | `UI/src/conversation/Queue.js` | `PendingView`, `pending` events, hold line |
| R6-45 bubble, thinking row, phase, tool groups, exec highlight, `</>`, Load earlier | `UI/src/conversation/{MessageList,ToolGroup,highlight,RawView}.js` | fold snapshot, deltas, `VatEvent`s, history pages |
| R6-46 plain text, http(s) links in a new tab | `MessageList.js` | slot `message.renderer` (`{ context, turn, record }`, once per turn under the user message) for later renderers |
| R6-49 Stop | `Composer.js` | `Turn.cancel` |
| R6-51 status rows, Details, recovery panel, Record acknowledgement | `UI/src/conversation/{StatusRow,Recovery}.js` | `TurnStatus`, history pages, `Turn.resolve` / `Session.findTurn` |
| R6-52 status bar | `UI/src/shell/StatusBar.js` | `UsageTotals`; slot `statusbar.chip` |
| R6-13 overlay, R6-61 drawer | `UI/src/shell/{Overlay,Layout}.js` | connection state; `drawerMaxWidthPx` |

---

## 10. Work units

After this contract (W3.0) is merged and M2's build is merged. **Group A** (W3.1-W3.4) in
parallel; then **group B** (W3.5-W3.7) in parallel; then **W3.8** alone. No two units of a group
own one file; a unit imports only modules of earlier groups (by the entry points of section 17)
and tests against fakes for its own group's siblings.

| id | group | owns (disjoint) | depends on | tests | supervisor | estimate (one Opus agent) | slower if |
|---|---|---|---|---|---|---|---|
| W3.1 HTTP server, sign-in, limiter | A | `GW/{server,static,csp,signin,limiter}.js`, `GW/.gitignore` (`assets/`), `test/adapter/m3-w31-*.test.js` | M2 secrets store exports | adapter: shell for every path, assets and cache headers, 400 on query config, 403 on a foreign Origin, 404 off `/ws`, connection caps; limiter (penalty, cumulative, forget after 10 s, trusted-proxy keys, untrusted XFF ignored, global ceiling) with a fake clock; `signin.enc` round trip, rotation atomic (kill a child mid-write), digest compare | no | 4 h | `ws` upgrade handling and Origin edge cases; the wrapping key helper's error paths |
| W3.2 CapTP bridge and guards | A | `GW/{bridge,guard,vocabulary,powers,extensions}.js`, `GW/extensions/` (empty, a `README.md` stating 6.1 and the `GatewayContext`), `test/adapter/_m3-captp-client.js`, `test/adapter/m3-w32-*.test.js`, `test/fixtures/gateway-extension/` | M2 shapes | adapter, over an in-memory socket pair: bootstrap and `fetch`; pass-through of `Far` objects standing in for vat presences (calls, results with nested remotables, identity); each refusal of 4.4 with nothing reaching the target; vocabulary (6.3): keys of `interfaces-m3.js` shapes and of an interface's method argument patterns admitted, a fixture `interfaces-m*.js` without `vocabularyShapes` logged and skipped, a throwing one skipped, a glob over a temporary `guestLibDir`; `largeCalls` (target resolved after `whenAttached`, compared by identity); exports cap; subscriptions closed at close; extension loading (a fixture extension's service, route and csp; a throwing file skipped) | no | 6 h | A-1 fails (forwarding wrappers needed, +3 h); captp's internal slot conventions differ from 4.4 (read `captp.js`) |
| W3.3 manager side and vat contract seams | A | `resources/agent-host/durable-gateway.js`, seam lines H2 (`resources/agent-host/durable.js`), H3 (`AH/attach.js`), `test/unit/m3-interfaces.test.js`, `test/unit/m3-w33-*.test.js` | this contract | unit: every M3 guard accepts the samples of `interfaces-m3.js` and refuses an extra key, an oversize string or array; `withGatewayAdmin(m2Interfaces.AgentHostAdmin)` is an interface named `AgentHostAdmin` whose methods are exactly `[...m2MethodNames.AgentHostAdmin, ...m3AgentHostAdminMethodNames]` (pins `payload.methodGuards`, CC-072); `GatewayAdmin` with a fake kit (`register`, `close`, restore) and fake ops: serve, replace, status before and after attach, retired ops -> `starting`, rotate without ops -> `gatewayNotAttached`, stop; `makeAttach` dispatches `gateway` binds to its binding and still refuses unknown keys; bundle sizes recorded (session and exec: growth 0 bytes against `3588cab190`, since `interfaces.js` is not edited; factory; manager with its growth) | no | 3 h | the manager-vat bundle rejects something in `interfaces-m3.js` (guest lint, bundling) |
| W3.4 UI foundation | A | `UI/build.mjs`, `UI/index.html`, `UI/src/{main.js,features.js}`, `UI/src/{net,controller,shell,styles}/`, `test/unit/_m3-fake-powers.js`, `test/unit/m3-ui-{build,controller,shell}*.test.js` | this contract | unit (happy-dom): fragment parsing (R6-10, R6-11), reconnect schedule with a fake clock, refused -> "Server starting...", rebuild after reconnect, re-attach of a running turn, rev-gap re-watch, exactly-once draft rules with a fake lock and storage, the addon chain (9.2: first `send` wins, `undefined` passes, a rejection keeps the draft and sets `sendError`, a resend goes through the chain with `resend: true` only after `getSubmissionReceipt` answered none), records kept with unknown fields, presets with `describe()` availability (missing `available` = available), feature collection (single and array exports, duplicate `id` fails the build) and slot rendering (a throwing feature isolated), drawer at 640 px; build: bundle size and gzip size recorded, content-hashed names, shell embeds `GATEWAY_PROTOCOL` | no | 7 h | SES lockdown + captp in the browser bundle; bundle over 600 KB gz; happy-dom gaps |
| W3.5 sessions UI | B | `UI/src/sessions/`, `test/unit/m3-ui-sessions*.test.js` | W3.4 | unit with `_m3-fake-powers.js`: sidebar rows and circles, empty text, live insert/rename/remove, rename keys, delete confirm, new-session dialog (presets with an unavailable one shown disabled with its reason, backends, catalogue pages, filter, Factory default, unavailable text, effort refusal R6-39), slot `newSession.field` | no | 4 h | adapting `space-floot` `FlootApp`/`SessionSidebar`/`ProviderModelFields` away from string ids |
| W3.6 conversation UI | B | `UI/src/conversation/`, `test/unit/m3-ui-conversation*.test.js` | W3.4 | unit: streaming bubble from deltas, thinking row and phase, tool groups and "Thought for", exec highlight, raw view, plain text and links, status rows R6-51, recovery panel paging (kept and archived pages, fake `History`), acknowledgement, queue rows with Send now/Edit/Delete/Send again and the hold line, Stop, blocked sending (A-5), `sendError` line, usage bar, large content paging; slots: a fixture `composer.addon` receives `input` and edits it with `replaceRange` (caret after the insert), a fixture `message.renderer` receives `{ context, turn, record }` with an unknown record field kept, for a kept, an archived and a live turn | no | 7 h | `MessageList.js` (1,000+ lines) carries Endo-specific shapes; the fold events differ from Floot's |
| W3.7 gateway wiring | B | `GW/index.js`, seam H4 (`AH/index.js`), H5 (`scripts/provision-steps.js` step), `scripts/gateway.mjs`, `test/integration/_m3-gateway.js`, `test/integration/m3-gateway.test.js`, `test/integration/m3-sessions.test.js` | W3.1, W3.2, W3.3 | integration (Node CapTP client over a real WebSocket, scripted backend): acceptance 1, 2, 3, 10, 11, 12 (protocol part), 13, 14, 16 (the fixture extension also resolves `context.secretWriter()` after attach and gets the object `SecretsAdmin.openWriter()` answers); kill points K1, K2 | **yes** | 5 h | A-3 (kit restore order) or A-1 surprises; port reuse after SIGKILL |
| W3.8 integration | alone | `test/browser/_harness.mjs`, `test/browser/m3-*.mjs`, `test/integration/m3-reconnect.test.js`, `perf/{ui,gateway,gateway-session}.perf.mjs`, `perf/_m3-client.mjs`, the M3 rows of `README.md` (PM-merged) | all | browser (Playwright, gated) and integration: acceptance 4-9, 12 (UI part), 15; K3-K5; every perf row of section 13; `startBrowserGateway` (17) used by M3's own browser files exactly as M4 and M5 will use it; checks section 5 against M2 as merged; no stub left | **yes** | 6 h | Playwright set-up in a lane; the 300-turn fixture import (about 40 s) if no template is cached |

Wall time with one agent per unit: about 7 h (group A) + 7 h (group B) + 6 h (W3.8) = **20 h**.

---

## 11. File ownership and merge hotspots

Everything else M3 touches is a **new file** under `GW/`, `UI/`, `resources/agent-host/durable-gateway.js`,
`scripts/gateway.mjs`, `guest/lib/interfaces-m3.js`, `test/**/m3-*`, `test/browser/_harness.mjs`,
`test/unit/_m3-fake-powers.js`, `perf/{ui,gateway,gateway-session}.perf.mjs`, `perf/_m3-client.mjs`.
M3 edits **no** factory, session, exec or provider file, no `guest/lib/interfaces.js`, no
`config/defaults.js` (gateway settings are in `contract-m3.js`), no `tsconfig.json` (UI files are
linted, not type-checked: decision 11), no root `eslint.config.js`.

Hotspots: each is an edit to a file another lane may also edit, with the exact seam.

| id | file | owner in M3 | seam (the whole M3 change) | who else may edit it |
|---|---|---|---|---|
| H1 | `guest/lib/interfaces.js` | - | **none** (dropped at the cross-check): M3 does not edit it. `gateway()` is added to the manager facet's guard in H2 by `withGatewayAdmin`, so the session and exec bundles carry no M3 code (0 bytes) | owner M5 (W5.3's widenings); M4 one line (BackendKind) |
| H2 | `resources/agent-host/durable.js` | W3.3 | three edits: `import { makeGatewayManager } from './durable-gateway.js';` and `import { withGatewayAdmin } from '../../guest/lib/interfaces-m3.js';` after the last import (two import lines); `const gateway = makeGatewayManager({ manager });` right after `const manager = makeManager(...)`; the facet line becomes `const facet = makeExo('AgentHostAdmin', withGatewayAdmin(m2Interfaces.AgentHostAdmin), {` (after the W2.9 fold `interfaces.AgentHostAdmin`) with `gateway: () => gateway.admin,` as the **last** method of its object | owner M4 (W4.1, six H-2 seams). M3's lines touch nothing M4 edits if M4 also appends; if M4 also wraps the facet guard, the wrappers nest (`withGatewayAdmin(withM4(base))`) |
| H3 | `AH/attach.js` | W3.3 | `makeAttach({ ops, incarnation, onSink, bindings = {} })`: `bind(key, spec, epoch)` and `unbind(binding, key)` hand any key other than `SERVICE_KEY` to `bindings[key]` (`{ bind(spec), unbind() }`) and still throw for a key with no binding (about 8 lines in two functions) | M4 (ops methods in `makeOpsInterface`, a different function) |
| H4 | `AH/index.js` | W3.7 | `import { makeGatewayService } from './gateway/index.js';` and `import { GATEWAY_KEY } from '../../../guest/lib/interfaces-m3.js';` (two import lines after the last import); immediately **before** `const { bind, unbind } = makeAttach({`: `const gateway = makeGatewayService({ live, composer, content, history: () => archive.history(), blobs, timers, secretWriter: () => secrets().secretWriter() });` (one statement; `secretWriter` is called lazily, after `whenAttached`); `bindings: { [GATEWAY_KEY]: gateway.binding },` as the last property of the `makeAttach` options; `gateway.attached();` as the last line of `onSink` | owner M4 (W4.6, H-4 seams: subscriptions after the secrets helper, ops handlers inside `makeOps`); M5 none expected. M3's statement sits after `makeOps(...)` and before `makeAttach`, away from M4's insertions |
| H5 | `scripts/provision-steps.js` | W3.7 | one appended step `{ name: 'gateway', run }`, skipped unless `options.gateway` (`{ port, publicOrigin?, trustedProxies? }`) is given; tests serve their own gateway on port 0 instead | hook table (append-only) |
| H6 | `H/package.json` (PM-merged) | W3.4 asks, PM merges | dependencies `@endo/captp`, `@endo/marshal`, `ws`, `preact`, `ses`; dev `esbuild`, `happy-dom`, `@playwright/test`; scripts `build:ui` (`node ui/build.mjs`), `test:browser` | M4, M5 (their own deps) |
| H7 | lint | - | none: UI code reads browser APIs as `globalThis.document`, `globalThis.localStorage`, ... so the root config needs no browser globals | - |
| H8 | `JOURNAL.md` | every unit | J-0510..J-0529: W3.0 used J-0510..J-0519; build units take J-0520..J-0529 in unit order; further numbers from the PM | union merge |

Not hotspots (directory registries; each lane adds its own new files, nobody edits a list):

| registry | collector (M3 only) | what another lane adds |
|---|---|---|
| `UI/src/<dir>/` | `UI/build.mjs`, `UI/src/features.js` | one directory with a `feature.js` per lane feature group: M3 `sessions`, `conversation`, `shell`, `net`, `controller`, `styles`; M4 `secrets`, `accounts` (and `account-chip` if needed); M5 `presets`, `mentions` |
| `GW/extensions/` | `GW/extensions.js` (and its `README.md`) | M4 `m4-secrets.js`; M11 `m11-audio.js` |
| `guest/lib/interfaces-m*.js` `vocabularyShapes()` | `GW/vocabulary.js` | the one export line in each lane's own contract file (M4: `interfaces-m4.js`; M5: `interfaces-m5.js`, `interfaces-m5-factory.js`) |
| `test/browser/` | M3 owns `_harness.mjs` and `m3-*.mjs` | M4 `m4-*.mjs`, M5 `m5-*.mjs`, written against `startBrowserGateway` (17) |

The milestones conventions' "hook tables `AH/gateway/routes.js` and `H/ui/src/features.js`" are
these directory registries (the PM updates the conventions list).

---

## 12. Acceptance

Each item is one integration test (or one test of a file) that runs in under 5 minutes, from the
`m2` state template plus a gateway served on port 0. "Client" is the Node CapTP client over a real
WebSocket (`test/integration/_m3-gateway.js`); "browser" is Playwright headless Chromium, gated by
`THIX_HARNESS_BROWSER=1` (tag `[browser]`). Files: `m3-gateway` (1, 2, 10, 11, 16), `m3-sessions`
(3, 13, 14, 12 protocol part), `m3-reconnect` (4-7 protocol parts), `test/browser/m3-ui.mjs`
(4-9, 12, 15).

1. Any non-upgrade `GET` path returns the shell with the CSP header; an asset has its content type
   and the immutable cache header; a WebSocket upgrade on `/ws` with the configured Origin
   succeeds, with another Origin is refused 403, on another path 404; a request whose query
   carries `agent` or `gateway` is refused 400 and the browser page shows the refusal (R6-10).
2. `fetch(secret)` yields the powers; a wrong secret is refused and an attempt within 1,000 ms
   gets the R7-49 text; through a trusted proxy, failures from one forwarded address do not delay
   another; an untrusted peer's `X-Forwarded-For` is ignored; 21 failures in a minute from
   different addresses trip the ceiling; the browser's network log shows the secret in no request
   line or header.
3. Two clients: a session created on one appears in the other's list within 500 ms; rename and
   delete propagate the same way; rows carry the R6-36 fields and circles.
4. Kill the socket: the overlay shows "Reconnecting…" and retries on the R6-14 schedule; the
   running turn re-attaches and keeps streaming. Gateway not listening for 60 s (daemon stopped):
   "Server starting...", and the page reconnects by itself within 30 s of the gateway's return.
5. Close the page mid-turn and reopen: the turn finished on the server and is in the transcript.
   Reload mid-turn: the page re-attaches to the running turn (R4-62).
6. Drop the connection between send and receipt; the page resends from the saved draft and the
   transcript has the message once (K3, K4).
7. SIGKILL the daemon mid-turn with two pages open (K5): both show the interrupted or
   outcome-unknown status row; Details opens "Turn journal and recovery"; "Record
   acknowledgement" works while idle; no provider request or tool run happened twice.
8. Tool calls fold into "Thought for ..." groups; `exec` calls show highlighted source; `</>`
   shows raw JSON; "Load earlier messages" pages a 300-turn imported session back to turn 1
   across the archive with every turn once; a 1 MiB reply renders fully.
9. At 640 px the sidebar is a drawer opened with ☰ over a backdrop; at 641 px it is not.
10. A client call carrying a 100 KiB string to a session method, one carrying a record with 2,000
    invented keys, one passing a page-made object, and a `createSession` whose `networkPolicy` is
    a record of invented keys are each refused by the gateway with its text; the session and the
    factory keep working, and the vats' worker rows show no delivery for the refused calls.
11. SIGKILL and restart: the gateway serves again on the same port with the same secret (K1);
    `rotateSignIn` closes open pages with `closeCodes.signInRotated`, the old secret fails and
    the new one (from `scripts/gateway.mjs url`) works; a SIGKILL inside the rotation leaves
    exactly one valid secret (K2).
12. A message sent during a turn shows as queued with Send now, Edit and Delete; Edit and Delete
    work; after a restart the queue is held with the hold line, and Send now releases it in FIFO
    order (R4-56, R6-44).
13. The new-session dialog lists presets, backends and the catalogue with "Factory default"; a
    failing catalogue shows its text; the created session runs on the chosen model; a session
    created with the default keeps its model after the default changes (R4-22).
14. The status bar shows `↑in ↓out · ctx N%` equal to `getUsage()` after each turn.
15. ■ Stop cancels the running turn (the fake provider sees the connection closed); closing the
    page instead leaves the turn running to completion.
16. A fixture extension (`test/fixtures/gateway-extension/`, copied into `GW/extensions/` by the
    test and removed after) adds a service in `extras`, an HTTP route and a CSP source, and a
    fixture feature adds an `app.panel`, with no M3 file edited; the fixture extension's
    `context.secretWriter()`, resolved after attach, is the same object a client gets from
    `E(E(operator).getSecrets()).openWriter()` (the client passes that presence back to a fixture
service method `sameWriter(writer)`, which compares identities in the adapter); a throwing extension
    file is skipped and the gateway still serves.

---

## 13. Performance

Rules (D-M3-6): each row is one measured point over a **fixed window** (60 s unless stated) and
reports median, p95, p99, max and the number of samples the window held; a point with too few
samples says so and does not run longer; no row counts a fixed number of runs. Each perf file
runs under 10 minutes in exclusive mode (the run lock enforces it): before opening a window, a
file checks its elapsed time and, if the window would end after 9 min 30 s, reports that row as
`not measured: file time` instead of starting it. Fixtures are imported (`writeSyntheticExport`
+ `importState`) and cached as a template (`m3-300`: one 300-turn session with a tool round per
turn, about 40 s to import once, `perf/_m3-client.mjs` `ensureM3Template()`); nothing grows a
session by replaying turns.

| metric | file | window | budget | why this budget |
|---|---|---|---|---|
| `gateway.fetch` sign-in to powers (Node client, loopback) | `gateway` | 60 s, sequential | median <= 50 ms; 0 vat deliveries | all in the adapter process; a WS round trip and a digest compare |
| `gateway.guard` pre-dispatch check of a `frameBytes` call (in process) | `gateway` | 60 s | median <= 2 ms per call | must stay far below a vat crank (tens of ms) so the guard never dominates |
| `ui.call` `E(session).listPending()` from a client | `gateway` | 60 s, sequential | median <= 150 ms | architecture 11 queue round trip: one session crank (about 60 ms at steady state, J-0461) plus the hub and WS hops |
| `ui.submit` `Composer.submit` while a turn runs, receipt latency | `gateway` | 60 s, a turn always running | median <= 150 ms | M2 `queue.enqueue` (same path plus WS) |
| `ui.deltaFanout` 5 clients, scripted chunks every 50 ms, adapter publish to each client's frame | `gateway` | 60 s | median <= 5 ms per delta, p99 recorded; 0 vat deliveries per delta | D-8: deltas never cross a vat; 0.15-0.18 ms in process today (J-9173) plus a loopback WS write |
| too-big probes: a 100 KiB call, 2,000 fresh keys, depth 33, 33 calls in flight, 4,097 exports | `gateway` | single probe each (a correctness check, not a rate; under 30 s together) | refused; no halt; 0 deliveries to the target vat | 4.4, 4.5 |
| `ui.snapshot` `watch()` of the `m3-300` session | `gateway-session` | 60 s | median <= 300 ms; message <= frameBytes | architecture 11 "session watch snapshot"; the archive keeps the session at 128-159 turns, so 300 stands for any length |
| `ui.history.newest` newest page (vat) through the gateway | `gateway-session` | 60 s | median <= 300 ms | M2 `history.page` budget (vat page measured 286-312 ms, J-0461; recorded, not re-based) |
| `ui.history.archived` an archived page (`History`) through the gateway | `gateway-session` | 60 s | median <= 300 ms | as above |
| `ui.reconnect` socket open to rebuilt state (`fetch`, list, `subscribeList`, `watch`, `subscribe`, `getCurrentTurn`, newest page) | `gateway-session` | 60 s, repeated reconnects | median <= 1 s | R6-13 rebuild should feel immediate; about 5 vat cranks |
| `ui.restartReady.clean`, `ui.restartReady.sigkill` supervisor serving to the gateway accepting a `fetch` | `gateway-session` | restarts repeated over a 150 s window per mode (clean, SIGKILL), sample count reported | median <= 2 s after serving | S2 (c): restore re-attaches 62-68 ms after serving; the rest is the listen and the sign-in file read |
| `ui.coldLoad` navigation to sessions listed (browser), bundle bytes and gzip bytes | `ui` | 60 s, fresh contexts | median <= 1.5 s on loopback; bundle <= 600 KB gz | architecture 11; SES lockdown and captp dominate the bundle |
| `ui.hubGrowth` hub image + log bytes and the session's hub row entries, while one browser reloads every 10 s and a turn runs every 5 s | `ui` | 5 min | hub state <= 2 MB at the end; session row entries <= 1.25 x the start once the viewer is closed and the vat has run 32 cranks | J-9386, J-9392: viewer-held presences are hub row entries; they must be released, not accumulate |

Files and their time (all owned by W3.8; `perf/<file>.perf.mjs`):

| file | rows | measured windows | set-up | worst case |
|---|---|---|---|---|
| `gateway.perf.mjs` | fetch, guard, call, submit, deltaFanout, probes | 5 x 60 s + probes (30 s) | serve the `m2` template, start the supervisor (about 30 s) | about 6 min |
| `gateway-session.perf.mjs` | snapshot, history.newest, history.archived, reconnect, restartReady (both modes) | 4 x 60 s + 2 x 150 s | `ensureM3Template()` (about 40 s when not cached), serve (about 20 s) | about 9 min with the template cached. The `m3-300` template is built before the perf files by the run's fixture step (`node perf/_m3-client.mjs template`, about 40 s, under the run lock; acceptance 8 builds it too if it runs first); uncached, the 9 min 30 s guard may report the last window `not measured: file time` |
| `ui.perf.mjs` (`[browser]`, `THIX_HARNESS_BROWSER=1`) | coldLoad, hubGrowth | 60 s + 5 min | build the UI, serve, launch Chromium (about 1 min) | about 7 min |

**Wall time.** The test files (unit and adapter lanes, about 2 min; the integration files
`m3-gateway`, `m3-sessions`, `m3-reconnect` and the browser file `test/browser/m3-ui.mjs`, each
under 5 minutes, on the four shared slots) take about 8 minutes. The three perf files run one
after another in exclusive mode and take about 22 minutes. If the owner's 20-minute bound for a
milestone's regression run includes its perf files, M3 does not fit it as stated (owner decision
12); the windows are the owner's 60 s rule and the reviewed 150 s restart window.

---

## 14. Fixed texts

Exact strings are in `interfaces-m3.js` (`m3Texts`, `m3TextOf`: what crosses the manager vat or
answers `fetch`) and `contract-m3.js` (`gatewayTexts`, `uiTexts`, `uiTextOf`).

| constant | text | source |
|---|---|---|
| `m3TextOf.rateLimited(ms)` | `Rate limit exceeded, try in <ms>ms` | R7-49 |
| `m3Texts.signInRefused` | `Sign-in refused` | harness (Endo's text for an unknown id is not specified) |
| `m3Texts.signInCeiling` | `Too many failed sign-ins; try again in a minute` | harness (W-8) |
| `m3Texts.gatewayNotServing`, `gatewayNotAttached`, `m3TextOf.gatewayFailed(m)` | see the file | harness |
| `gatewayTexts.messageTooLarge` | `message too large; use the composer` | architecture 7 |
| `gatewayTexts.unexpectedField` | `unexpected field` | architecture 7 |
| `gatewayTexts.unknownMethod` | `unknown method` | rule 4.4 4a (M3-FIX) |
| `gatewayTexts.queryConfig` | `Configuration in the query string is not accepted; use the URL fragment` | R6-10, R7-48 (harness wording) |
| `uiTexts.reconnecting` | `Reconnecting…` | R6-13 |
| `uiTexts.serverStarting` | `Server starting...` | architecture 7, D-17 |
| `uiTexts.gatewayNotConfigured` | `Gateway not configured` | R6-10 |
| `uiTexts.turnFailed`, `turnStopped`, `turnInterrupted` | `This turn did not finish.`, `This turn was stopped.`, `This turn was interrupted.` | R6-51 |
| `uiTexts.recoveryTitle`, `recordAcknowledgement` | `Turn journal and recovery`, `Record acknowledgement` | R6-51 |
| `uiTexts.noSessions`, `sessions`, `startNewSession`, `newChatTitle`, `factoryDefault`, `lastModelList`, `accountsUnreachable` | as R6-36, R6-38 | R6-36, R6-38 |
| `uiTextOf.confirmDelete(t)` | `Delete "<t>"?` | R6-37 |
| `uiTextOf.rowCounts(m, q)` | `<m> messages · <q> queued` | R6-36 |
| `uiTextOf.usage(up, down, p)` | `↑<up> ↓<down> · ctx <p>%` | R6-52 |
| `uiTextOf.thoughtFor(s, running)` | `Thought for 1m2s` / `Thinking… (0m5s)` | R6-45 |
| `uiTexts.pageTitle` | `Familiar` | R6-8 |
| the rest of `uiTexts` | composer, queue and recovery labels | R6-40, R6-44, R6-45 |

---

## 15. Core requests (CC-050..CC-059)

M3 needs **no change** in Thixotrope core, the Ironhorse engine or the worker. Two conditional
requests, filed only if a measurement says so:

- **CC-050 (conditional on A-1): an adapter-side test for "this remotable is an OCapN import".**
  Motivation: the frame guard must know whether a call goes into a vat. Smallest change: export
  `isImportPresence(value)` from `@endo/thixotrope/native-adapter.js`. Harness workaround (the
  default, built in W3.2): treat every target as a vat target except the gateway-local objects
  the gateway itself registered (`LargeCall` identities and its own services), which is
  conservative.
- **CC-051 (conditional on `ui.hubGrowth`): per-entry diffs of a hub session row.** Motivation: a
  viewer's presences add entries to its vats' hub rows, and the log store rewrites a changed row
  whole (J-9335 (a), J-9386). This is C-2's rest, already a candidate; M3 adds evidence, not a new
  change. It and M4's CC-060 (an alleged interface name stored once per export row of the
  exporting peer, not per holder entry) both change the hub row format in `pkg/src/net/hub.js`:
  core should make them one hub-format change. Harness workaround: `exportsPerConnection`,
  `gcImports`, and the UI dropping pages it no longer shows.

**Cited, not filed: CC-072** (M5: `getInterfaceGuardPayload` in the guest prelude). M3's
`withGatewayAdmin` reads `base.payload.methodGuards` as M5's `extendInterface` does; W3.3's unit
test pins it. If CC-072 lands, `withGatewayAdmin` switches to the helper with no contract change.

---

## 16. Owner decisions (the default is what M3 builds until told otherwise)

1. **Upgrade path**: `/ws` only (architecture D-12) instead of "any path" (R2-12, R6-11 open
   `wss://<gateway>/`). Default `/ws`; the client is ours, so nothing else connects.
2. **CSP** (W-15) instead of none (R7-47). Default strict `cspDirectives`.
3. **Origin check** (W-1) instead of none (R7-48). Default: `publicOrigin` must match.
4. **Sign-in secret**: 32 random bytes as hex in an encrypted adapter file (D-6), the fragment
   keeps R6-9's `gateway` and `agent` names. Default as stated; rotation by `rotateSignIn`.
5. **Frames**: binary frames carrying UTF-8 JSON (R2-14, R6-11) instead of D-12's text frames.
   Default binary.
6. **UI source**: copy and adapt `space-floot` (architecture 7) rather than depend on the
   workspace package `@endo/space-floot` (less code to own, but its view would need hooks for the
   slots). Default copy.
7. **A retried `createSession`** after a lost answer may create a second session (no request id
   in `CreateOptions`, A-6). Default accept; a factory-side request id is a later M2-style change.
8. **Page title** "Familiar" (R6-8). Default kept.
9. **Per-connection object cap** 4,096 with a closing reload rather than unbounded. Default cap.
10. **Web Locks** required (R6-41): browsers without them cannot send. Default kept.
11. **UI type checking**: `ui/` is linted, not in `tsconfig.json` (no DOM lib in the package's
    type check). Default lint only.
12. **Perf files and the 20-minute regression bound.** M3's test files take about 8 minutes on
    four slots; its three perf files (each under 10 minutes, 60 s windows, 150 s restart windows)
    take about 22 minutes in exclusive mode (13). Default: the perf pass runs after the regression
    run, not inside its 20 minutes. If the bound includes perf, the owner says which rows to drop
    or shorten.

---

## 17. Module entry points

Every unit exports exactly these (more is allowed; these names and signatures are fixed). "Node"
= adapter or tests; "vat" = guest rules; "browser" = the UI bundle.

### W3.0 (exists)

| file | export |
|---|---|
| `guest/lib/interfaces-m3.js` (vat, Node) | `GATEWAY_KEY`, `m3Limits`, `m3Texts`, `m3TextOf`, `m3Shapes`, `m3Interfaces`, `m3MethodNames`, `m3AgentHostAdminMethods`, `m3AgentHostAdminMethodNames`, `withGatewayAdmin(base)`, `vocabularyShapes` |
| `GW/contract-m3.js` (Node, browser) | `GATEWAY_PROTOCOL`, `WS_PATH`, `gatewayLimits`, `closeCodes`, `gatewayTexts`, `cspDirectives`, `reconnectDelaysMs`, `connectDeadlineMs`, `drawerMaxWidthPx`, `uiSlots`, `uiTexts`, `uiTextOf`; typedefs `GatewayContext` (with `secretWriter`), `GatewayRoute`, `GatewayService`, `LargeCall`, `GatewayExtension`, `UiFeature`, `ComposerAddonProps`, `ComposerSendRequest`, `MessageRendererProps`, `FeatureContext` |

### W3.1 (Node)

| file | export | signature |
|---|---|---|
| `GW/server.js` | `makeGatewayServer` | `({ port, publicOrigin?, trustedProxies?, routes, staticHandler, onSocket, log }) -> Promise<{ port, origin, close(code?, reason?) -> Promise<void>, connections() -> number }>`; `onSocket(socket)` after an accepted `/ws` upgrade, where `socket` = `{ address, send(bytes), close(code, reason), onMessage(fn(bytes)), onClose(fn) }` |
| `GW/static.js` | `makeStaticHandler` | `({ assetsDir, csp }) -> (request, response) -> boolean` (true when it answered) |
| `GW/csp.js` | `cspHeader` | `(extra?: Record<string, string[]>) -> string` |
| `GW/limiter.js` | `makeSignInLimiter`, `clientAddress` | `({ now, penaltyMs?, forgetMs?, perMinute? }) -> { check(address) -> { ok: true } \| { ok: false, text }, failed(address), succeeded(address) }`; `({ socketAddress, forwardedFor?, trustedProxies }) -> string` |
| `GW/signin.js` | `makeSignInStore`, `signInFile` | `({ stateDir, env? }) -> { ensure() -> Promise<void>, matches(candidate) -> boolean, rotate() -> Promise<void>, fragment(host) -> Promise<string> }` (`fragment` for `scripts/gateway.mjs` only); `(stateDir) -> path` |

### W3.2 (Node)

| file | export | signature |
|---|---|---|
| `GW/bridge.js` | `makeBridge` | `({ makeBootstrap, vocabulary, isLargeCall, limits?, log }) -> { connect(socket) -> { close(code, reason), stats() -> { exports, inFlight, refused } } }`; `makeBootstrap({ address, onClose }) -> GatewayBootstrap` |
| `GW/guard.js` | `checkCall` | `({ message, targetOf, vocabulary, isLargeCall, inFlight, limits }) -> undefined \| string` (the refusal text) |
| `GW/vocabulary.js` | `collectRecordKeys`, `harnessVocabulary` | `(patterns: any[]) -> Set<string>` (walks copyRecords, copyArrays and tagged payloads, so interface guards' method argument patterns too; 4.4); `({ guestLibDir?, log }) -> Set<string>` (`interfaces.js` tables, then every `guestLibDir/interfaces-m*.js` in name order through its `vocabularyShapes()`; a file without it or that throws: `log({ event: 'vocabulary-skip', file, error })` and skipped) |
| `GW/powers.js` | `makeBootstrapFactory` | `({ signIn, limiter, operator, live, content, composer, history, extras }) -> ({ address, onClose }) -> GatewayBootstrap` (per connection: the `Live` facade that closes its subscriptions) |
| `GW/extensions.js` | `loadGatewayExtensions` | `({ dir?, log }) -> GatewayExtension[]` |
| `test/adapter/_m3-captp-client.js` | `makeClient` | `({ send, onClose? }) -> { receive(bytes), bootstrap(), close() }` (Node CapTP over any message transport) |

### W3.3 (vat)

| file | export | signature |
|---|---|---|
| `resources/agent-host/durable-gateway.js` | `makeGatewayManager` | `({ manager }) -> { admin: GatewayAdmin }` |
| `AH/attach.js` (H3) | `makeAttach` | gains `bindings?: Record<string, { bind(spec) -> Promise<unknown>, unbind() -> unknown }>` |

### W3.4 (browser, build in Node)

| file | export | signature |
|---|---|---|
| `UI/build.mjs` (Node) | `buildUi` | `({ outDir?, minify? }) -> Promise<{ files, bytes, gzipBytes, digest }>`; CLI `node ui/build.mjs` writes `GW/assets/` |
| `UI/src/net/fragment.js` | `parseLocation` | `(location) -> { gateway, agent } \| { error: 'unconfigured' \| 'query' \| 'invalid' }` |
| `UI/src/net/connection.js` | `makeConnection` | `({ url, agent, WebSocket, timers, onState }) -> { powers() -> Promise<GatewayPowers>, close() }` with the R6-14 schedule |
| `UI/src/controller/index.js` | `makeController` | 9.1 |
| `UI/src/features.js` | `features`, `featuresFor` | the collected `UiFeature`s; `(slot) -> UiFeature[]` |
| `UI/src/shell/App.js` | `App` | Preact component `({ controller, features })` |
| `test/unit/_m3-fake-powers.js` (Node) | `makeFakePowers` | `({ sessions?, script?, operatorMethods?, presets?, extras? }) -> { powers, control }`: Far objects with the M2 methods of 3.3, a scripted turn driver and a fake `Live`; `operatorMethods` adds methods to the fake `Operator` (M4: `getSecrets`, accounts; M5: preset catalogue), `presets` replaces the `listPresets()` answer (objects with `describe()`), `extras` fills `GatewayPowers.extras`. Fixed signature: M4's and M5's component tests use it |

### W3.5, W3.6 (browser)

| file | export |
|---|---|
| `UI/src/sessions/index.js` | `Sidebar`, `NewSession` (Preact components over the controller) |
| `UI/src/conversation/index.js` | `Conversation`, `Composer`, `Queue`, `Recovery`, `StatusRow` |

### W3.7 (Node)

| file | export | signature |
|---|---|---|
| `GW/index.js` | `makeGatewayService` | `({ live, composer, content, history, blobs, timers, secretWriter, stateDir?, log? }) -> { binding: { bind(spec), unbind() }, attached(), close() }`; `bind(GatewaySpec)` listens, attaches `GatewayOps` to `spec.sink` and answers; `secretWriter: () => Promise<SecretWriter>` is passed to extensions as `GatewayContext.secretWriter` and called only after `attached()` |
| `scripts/gateway.mjs` (Node, operator) | CLI `serve <state> --port N [--origin O] [--proxy A]...`, `status <state>`, `rotate <state>`, `stop <state>`, `url <state> [--host H]` |
| `test/integration/_m3-gateway.js` | `serveGateway(state, options?) -> { url, origin, secret, admin, connect(options?) -> client }` |

### W3.8 (Node, browser tests)

| file | export | signature |
|---|---|---|
| `test/browser/_harness.mjs` | `startBrowserGateway` | `({ template, provision? }) -> Promise<{ page, url, client, close() }>`: serves `template` (a state template name, e.g. `'m2'`, `'m3-300'`) under the run lock, awaits `provision({ root, operator })` if given (the `HarnessRoot` and its `Operator` presences, for a lane's own set-up such as secrets or presets), before the gateway serves, builds the UI if `GW/assets/` is missing, serves the gateway on port 0, launches headless Chromium and opens `url` (the fragment sign-in URL) in `page` (a Playwright `Page`); `client` is a signed-in Node CapTP client (`serveGateway`'s `connect()`); `close()` closes the browser, the gateway and the supervisor. Callers gate their file on `THIX_HARNESS_BROWSER=1` (tag `[browser]`); called without it, it throws. This signature is fixed: M4's `m4-*.mjs` and M5's `m5-*.mjs` call it |
| `perf/_m3-client.mjs` | `ensureM3Template`, CLI `template` | `() -> Promise<templatePath>` (imports `m3-300` once and caches it) |
