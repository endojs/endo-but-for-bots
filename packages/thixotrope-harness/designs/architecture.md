# Architecture: the Endo daemon harness on Thixotrope

Status: plan, 2026-11-16. Author: architect step of the harness build workflow.
Inputs: the six survey reports in `scratchpad/thix/survey/` (core, native, apps, tooling, reuse,
spec-digest), the feasibility and coverage reviews in `scratchpad/thix/plan/critique-*.md` with the
probe `scratchpad/thix/critique/probe.mjs`, spec Part I sections 1, 4 and 10, Appendix A.4 and
Appendix F of `endo-harness-spec.md` (called SPEC). Thixotrope paths are relative to
`/Users/xyz/Development/endo-thixotrope-harness` (called T). `pkg/` = `packages/thixotrope/`.
Endo reference paths are read from T's object store with `git -C T show 1315bef86:<path>`
(never from the Endo checkout, never from T's pre-move `packages/floot/src`).
Guesses are marked [inferred]. Decisions are numbered D-1.. so milestones and the journal can cite them.

---

## 0. The facts that shape everything

Measured (tooling.md section 4, native.md section 0, reuse.md section 3.2, the feasibility probe) and
confirmed in code.

1. **A durable crank costs about 65 ms (82 ms in a workspace vat), one at a time per vat.** About
   50 ms of it is the worker's full GC after every crank
   (`rust/thixotrope-ironhorse-worker/src/main.rs:185-190,240-265`); treated as fixed (journal asks
   whether a conditional GC is the largest available core speed-up). One vat handles about 15
   deliveries per second. Pipelining gains nothing. An answered `E()` costs a second delivery when
   the answer comes back; `E.sendOnly` does not.
2. **Every byte of a message into a vat is decoded twice in metered JavaScript, and the decode can
   halt the vat for good.** Inbound frames arrive as base64 inside JSON and are decoded by
   `decodeBase64` (`pkg/src/core/worker-peer-xs.js:79`). `@endo/base64` uses the native
   `Uint8Array.fromBase64` only if it exists when the module loads
   (`packages/base64/src/decode.js:86,160`); in a vat it is `undefined` although the VM implements it
   (`rust/engine/ironhorse-vm/src/interp/boot.rs:800-808`) and SES permits it
   (`packages/ses/src/permits.js:1341`), so the pure-JS loop runs. Each Syrup string is then decoded
   by the polyfill `TextDecoder` (`rust/endo/xsnap/src/polyfills.js:106-160`), which builds the
   result with `out += String.fromCharCode(...)` per code point (line 156) and ignores `{fatal}` and
   `{stream}`. With no GC inside a crank the polyfill is quadratic in heap: 16-20 k characters
   quarantine the vat (`pkg/src/core/evaluate-source.js:4-10`). Even a linear JS decoder is metered
   at about 100-150 computrons per byte, and the JS base64 loop at about 75-100: at the default
   10 M-computron budget a linear UTF-8 decode alone halted at 96 KiB and the base64 decode alone at
   128 KiB, and an array of 8 strings of 4,096 characters halted today (feasibility review B-1).
   The ceiling is per frame, not per string. **Outbound frames are metered too**: a vat returning
   60 k characters worked, 250 k killed it (the encoder is a JS loop, `polyfills.js:22-70`).
3. **A crank is bounded by the crank budget (default 10 M computrons, about 600 k loop iterations)
   and the heap ceilings; going over quarantines the vat for good**
   (`pkg/src/ironhorse/ironhorse-limits.js:45-51`). The budget is a daemon-wide setting
   (`THIXOTROPE_CRANK_BUDGET`, README 704-748) that may change in either direction across restarts.
   More than about 250 eventual sends in one crank also MeterAborts at the default budget.
4. **Answers owed by the host or an adapter break after a restart; guest-to-guest promises
   survive.** At startup the hub forgets stale transient sessions (`pkg/src/core/daemon.js:825`) and
   breaks every pending answer they owed with "ocapn hub: the target session has been retired"
   (`pkg/src/net/hub.js:1932-1947`; also :1522, :1968); each break is a delivery that wakes the waiting vat. The error
   text is the only discriminator. Sends to objects of a retired session break silently for
   `E.sendOnly` (tombstoned rows, `hub.js:1917-1931`).
5. **Startup replays every worker whose journal runs past its last snapshot**
   (`pkg/src/core/daemon.js:826-847`), independent of the application. Vats checkpoint at idle sleep
   (default 30 s, configurable as `idleSleepMs`, `pkg/src/control/supervisor.js:141`), every 256
   deliveries, or clean shutdown.
6. **Guests have no clock, randomness, timers, URL, fetch, console, WeakRef, and cannot pass bytes**
   (`Uint8Array` is not passable over OCapN in this build). The clock resource costs about 1 s per
   alarm (`clock.after(0n)` p50 989 ms from the workspace, native.md section 0.2). Vat creation costs
   about 4.4 s, 18 MB of snapshot and up to 160 MB resident while awake. There is no live code upgrade
   (`pkg/src/control/supervisor.js:112` `WORKSPACE_VERSION = 21`).
7. **The hub rewrites `hub.json` whole, with fsync, 1 + 2k times per delivery** (`pkg/src/net/hub.js:354-364`;
   `pkg/designs/production-cost-model.md:341-347`), and every exo exported across the gateway is a
   row in it. All journal and hub writes run on the supervisor's single Node thread (about 15 ms of
   host time per delivery), which caps the daemon at roughly 60-70 deliveries per second [inferred].

Everything below follows from one rule derived from these: **vats are the system of record and the
decision makers; Node adapters are the data path.** A vat sees a coarse, small, already-parsed message
at most a few times per second per session. Token streams, audio, bytes, SSE parsing, context
projection, large text, secrets and files never pass through a vat; a vat holds handles to them.

---

## 1. Where the code lives

**D-1. A new package `packages/thixotrope-harness` in T** (npm name `@endo/thixotrope-harness`,
private). Nothing harness-specific goes into `packages/thixotrope`. The harness consumes Thixotrope
through its public surface: `thix install`, `thix install-native`, the control socket
(`pkg/src/control/local-control.js` `connectLocalControl`), the prelude globals
(`pkg/src/guest/prelude.js:43-64`), `@endo/thixotrope/native-adapter.js` `makeAdapter`, and the
worker-controller (`vats`) resource (`pkg/src/core/daemon.js:602-651`).

Layout (each milestone owns named subtrees; see milestones.md):

```
packages/thixotrope-harness/
  package.json, README.md, JOURNAL.md            # JOURNAL.md is the running fit/perf journal
  guest/                     # confined code that runs in Ironhorse vats; prelude globals only
    lib/                     # copied-and-adapted pure Endo modules (turn engine, records, queue...)
    factory/                 # the harness root + factory vat (installed with `thix install`)
    session/                 # the per-session vat program (sent as source by the factory)
    exec/                    # the per-session exec-scope vat program
  resources/                 # Thixotrope native resources
    agent-host/              # durable.js (thin) + ephemeral.js (thin loader) + impl/ (loaded at run time, D-14)
    workspace/               # per-session directories, git, publishing / asset server
    containers/              # rootless Podman runner, egress proxy (fake runtime for tests)
  ui/                        # browser client (Preact), built with esbuild into impl/ assets
  bin/harness.js             # admin CLI (attach-only, control socket)
  scripts/                   # bundle-guest.mjs, provision.mjs + provision-steps.js, serve.mjs, run-lock.mjs
  test/                      # unit (Node), adapter (Node), integration (real Ironhorse) tests
  test/fixtures/             # scripted provider scripts, SSE recordings, fake binaries
  perf/                      # <feature>.perf.mjs + _harness.mjs (section 11)
  tmp/                       # git-ignored state for tests and perf (short paths, 0700)
```

Guest modules read `E, Far, harden, makeExo, M, mustMatch, Fail, q, makePromiseKit,
makeSerialQueue ...` from `globalThis` (the `GuestGlobals` pattern, `pkg/guest.js`) and are
bundled by `scripts/bundle-guest.mjs` with compartment-mapper `makeBundle`. Pure Endo modules are
**copied and adapted into `guest/lib/`** (header comment: source path at 1315bef86), not imported
as workspace dependencies, because `makeBundle` would bundle second copies of `@endo/*` libraries
that the prelude already provides (reuse.md section 4). Node-side code imports Endo packages normally.

### 1.1 Core changes to Thixotrope (each flagged; only these; each in its own commits)

| id | change | files | why unavoidable | when |
|---|---|---|---|---|
| **CORE-1a** | Make `Uint8Array.fromBase64` visible in vats before `@endo/base64` loads, so `decodeBase64` takes the native path. Trace where the static method is lost between VM boot and the vat compartment [inferred: an install defect for static methods pushed through `proto_methods`]. | `rust/engine/ironhorse-vm/src/interp/boot.rs:800-808` and/or the boot/lockdown path; rebuild worker | Removes the JS base64 half of the per-byte inbound cost (fact 2). | M0 |
| **CORE-1** | Native UTF-8 decode and encode for the polyfills: a VM native `decodeUtf8(bytes, fatal) -> { text, consumed }` and `encodeUtf8Into(text, bytes)`; the `TextDecoder` polyfill keeps only the `{stream:true}` carry of an incomplete tail in JS and throws a `TypeError` on malformed input when constructed with `{fatal:true}` (Syrup does, `packages/ocapn/src/syrup/decode.js:28`), else emits U+FFFD; `TextEncoder.encode/encodeInto` call the native encoder. Rebuild `pkg/dist-ironhorse`. | `rust/endo/xsnap/src/polyfills.js:20-160`; a native in `rust/engine/ironhorse-vm`; `pkg/scripts/bundle-ironhorse-worker.mjs:8,35` | A linear JS decoder still halts below 96 KiB (fact 2). Without native decode no frame larger than about 32 KB can enter a vat, and every oversize frame is a permanent quarantine, including frames the harness does not control (settlements, admin calls). | M0 |
| **CORE-1b** | Raise the staging chunk in `evaluateSource` from 1,024 characters to `frameBytes / 3` characters (section 9). | `pkg/src/core/evaluate-source.js:32` | Install stages about 1 delivery per KB: a 300 k factory bundle is 40-60 s (feasibility 4), the session program is shipped to every spare vat. | M0 (after CORE-1) |
| CORE-2 | Kit `operate(fn)` verb for one-shot adapter operations. | `pkg/src/native/manager-kit.js`, `manager.js` | **Not planned.** D-7 uses the attach pattern. Becomes CORE-2 only if spike S2 fails. | conditional |
| CORE-3 | Booted-image templates for fast vat creation. | `pkg/src/ironhorse/ironhorse-engine.js` | **Not planned.** D-4 uses a spare-vat pool. | conditional |

**Configuration, not core: the crank budget.** The harness serve wrapper (`scripts/serve.mjs`) sets
`THIXOTROPE_CRANK_BUDGET`. M0 spike S1 measures frame cost, send ceiling and runaway-loop wall time at
10 M, 50 M and 100 M and picks the value (planning value 50 M; at about 80 ms per 10 M computrons
[inferred from `survey/perf-engine3.log`] a runaway exec crank still ends within about 0.5 s). The
budget may be lowered only after a clean shutdown (README 747-748); the wrapper refuses to lower it
otherwise.

Changing the boot bundle changes the boot digest, so existing state directories are refused
(README 770-790). Acceptable: nothing is in production. Every builder uses fresh state.

---

## 2. Processes, vats and where state lives

```
 browser (UI, CapTP over WebSocket, audio over a second WS route)
    |  https origin (reverse proxy out of scope; adapter binds loopback, trusts configured proxies)
    v
 agent-host ADAPTER (Node, unconfined, one process)          workspace ADAPTER      containers ADAPTER
   gateway: HTTP shell + WS CapTP + auth + CSP + frame guard   dirs, git, asset HTTP   podman / fake, egress
   gateway-local services: Live, Content, Composer
   providers: HTTP+SSE, parsing, context projection cache, pools, timers
   secrets backend (encrypted file), sign-in secret
   channels (session events, session list, accounts, home), turn fold
   blob store (staged large text, partial text, native context), speech engines (child processes)
    |  OCapN through the hub (each arrow into a vat = 1 durable crank)
    v
 agent-host MANAGER vat     workspace MANAGER vat     containers MANAGER vat
   (registrations, Secret/Backend/Blob exos, last-served records, refusal marks, start listener)
    ^
 factory VAT (harness root, operator object, session index, presets, settings, vat pool, operator inbox)
    |  owns
 session VAT x N (one per session and per subagent)  --- exec VAT x N (one per session, lazy)
```

**D-2. Engine: Ironhorse only.** The supervisor requires `acquireStore`, which XS lacks
(`pkg/src/control/supervisor.js:203-204`); the XS worker does not build here (missing `c/moddable`).

**D-3. State placement.**

| State | Lives in | Why |
|---|---|---|
| Session index (rows: title, activity, backend, model, effort, counts) | factory vat heap | list without waking session vats |
| Presets (built-in table + user presets, revision counter), voice preferences, spaces, settings, operator inventory | factory vat heap | small, shared across devices, orthogonally persistent |
| Session record (resolved backend and model fixed at creation), preset snapshot, composed system prompt, queue, receipts, turn records, current turn state, usage, network policy, label map, inbox | session vat heap | one conversation's system of record; one vat per session isolates quarantine and load |
| Any text field larger than `inlineBytes` (message bodies, tool arguments and results, partial text, submissions), opaque native context (signed thinking, encrypted reasoning) | blob files in the agent-host adapter's directory, fsynced before their handle enters a vat; the vat holds a manager-minted `Blob` handle plus a bounded preview | keeps every frame small (fact 2) and the vat heap and snapshots small |
| Model-written code's persistent scope (`globalThis` bindings) | exec vat heap | runaway code quarantines only the exec vat (section 6) |
| Secret values, sign-in secret, OAuth tokens, the secrets audit log | agent-host adapter's encrypted file (key file outside the state dir) | heaps and journals are plaintext on disk; no secret may enter any vat or transit the hub in clear |
| Secret, Backend, Blob, Route, Environment handle objects | the relevant manager vat | durable identities the vats hold; values stay adapter-side |
| Provider stream state, SSE parser, per-session context projection cache, live turn fold, channels, WebSocket connections, timers, speech engine processes, model catalogue cache | agent-host adapter memory | ephemeral by nature; lost at restart by contract (R4-67) |
| Pool refusal marks, last-served records (R4-63 says durable; at most 256, keyed by the Session object in a manager-vat Map) | agent-host manager vat, updated by coalesced `E.sendOnly` from the adapter (at most once per refusal or member change) | must survive restart; tiny |
| Session workspace files, git repositories, home volumes | workspace adapter's directory tree / container runtime | files; the vat holds a `Workspace` object |

**D-4. One durable vat per session, plus a lazily created exec vat; a factory-held spare pool hides
creation cost.** A vat is the unit of quarantine and of serial execution. One harness vat for all
sessions would serialize every session's cranks and one bad input would kill every session. Cost:
4.4 s to create, about 18 MB of disk per vat (tooling.md 4.1). The factory keeps `poolSize` (default
2) spare session vats already loaded with the session program and 1 spare exec vat, refilled in the
background after each take, so `createSession` costs a wake plus one `make(config)` call. Spares are
discarded when the program digest changes. Idle session vats sleep. The pool exposes
`whenSettled()` so tests can wait for refills before a SIGKILL (fact 5).

**D-5. Dormant after restart; sessions recover themselves (owner's decision, G-01).** No session vat
registers a start notice, and nothing wakes idle sessions at startup. A session learns about a
restart only from its own pending calls:

- **Turn lease.** Every running turn holds one answered call `E(endpoint).holdTurn(turnHandle)` that
  the adapter settles only when the session ends the turn (`E.sendOnly(endpoint).releaseTurn(...)`).
  A restart breaks the lease (fact 4), and that break is a delivery that wakes the session, which then
  runs `recoverAfterRestart()` (section 4.4). Cost: 1 extra delivery per turn.
- **Any adapter call on the turn path** (round dispatch handshake, `runCommand`, blob reads) that
  rejects with the retired text is classified `outcome-unknown` and routed to the same idempotent
  recovery; it is never recorded as an ordinary tool failure, and the session never calls a
  tombstoned Endpoint after it (feasibility section 3.1).

The factory's only start listener (registered on the agent-host manager, whose `lifecycle.started()`
runs at every start) refreshes the factory's channel publishers, restarts pool refills and completes
factory-owned work interrupted by the restart: a half-made session creation is completed if its vat was
made and rolled back otherwise, so nothing half-made is listed (R4-6, R4-65), and
interrupted deletes are completed (R4-9). Recovery therefore never depends on the factory's index rows
being current (coverage 22, feasibility A-3). Idle sessions stay asleep until a message reaches them;
mail that arrived before the restart is handled when the session is next woken. This departs from
R4-65's "every session resumes serving its inbox at once" (owner decision, journal J-0015).

---

## 3. Object model (object-passing style)

Rules (Appendix F.1, spec-digest section 6): factories return objects; per-item operations are on the
item; authority is passed as objects at construction; strings only for F.2 reasons (a)-(e). Interface
sketches below are the contract builders implement; method sets grow per milestone. All are `makeExo`
with `M.interface` guards that bound every string and array (sizes in section 9). **A guard does not
protect a vat from an oversize frame** (decoding happens before the guard runs), so every path into a
vat is also bounded on the sending side (section 9).

### 3.1 Factory vat

```js
// Installed once: thix install STATE harness guest/factory/main.js \
//   host=agentHostAdmin workspace=harnessWorkspace containers=harnessContainers vats=vats
make({ host, workspace, containers, vats }) -> HarnessRoot

HarnessRoot            // inventory label 'harness'; operator-only via control socket
  getOperator() -> Operator
  configure(settingsRecord) -> settings       // workload limits, pool size, defaults (section 9)
  status() -> { sessions, pool: { spareSessions, spareExec, refilling }, version }
  exportState() / importState(data)           // data-only, M2 (A-2): session records, queue, presets

Operator               // the ONE object the gateway publishes (F.1 #10)
  getFactory() -> SessionFactory
  getSecrets() -> SecretsAdmin                // agent-host manager facet; never returns values
  getAccounts() -> Accounts                   // M4
  getVoice() -> VoiceServices                 // M11
  getHome() -> Home                           // M12: operator inbox, inventory view (minimal inventory in M5)

SessionFactory
  createSession({ title?, preset?: Preset, backend?: Backend, modelId?: string, reasoningEffort?: string,
                  systemPrompt?: string, networkPolicy?, userInitiated?, spoken? }) -> Session
                  // option names follow A.4 (SPEC:1551); `model` is rejected (R4-6).
                  // The resolved backend and model are stored at creation; a later change of the
                  // factory default does not move an existing session (R4-22).
  listSessions({ after?, limit? }) -> { rows: [SessionRow], rev, next? }   // pages of <= 50 rows
  sessionListFeed() -> { rev }                // viewers subscribe in the gateway (D-8); no viewer objects here
  findSession(key) -> Session                 // only for page reload (F.2 d)
  deleteSession(session) -> undefined         // factory-level authority takes the object
  listBackends() -> [Backend]; listModels(backend?) -> [ModelRow]
  listPresets() -> [Preset]; getPresetConfiguration() -> { presets, revision }
  savePreset(record, expectedRevision) -> Preset; deletePreset(preset, expectedRevision); resetPreset(preset, ...)

SessionRow = { session, key, title, activity, backendTitle, modelId, effort, messageCount, queuedCount }
Preset     // exo in the factory vat; record holds { label, value } endowments (F.1 #4)
  describe() -> record ; snapshot() -> frozen PresetSnapshot (data + object references)
```

The factory keeps `sessions: Map<Session, Row>` and `byKey: Map<string, Session>` (key = `s<counter>`).
Each session holds a per-session **`RowReporter`** facet (not the factory) that can only update that
session's row: `E.sendOnly(rowReporter).changed(patch)`, sent **only on a row-visible transition**
(activity, title, message count at turn settle, queued count), not once per crank. The factory pushes
one coalesced `E.sendOnly(listPublisher).publish({ rev, diff })` per crank that changed rows to an
adapter-side channel (D-8); it never holds browser viewers (feasibility B-4). After a restart the old
publisher is a tombstone; the factory's start listener obtains a new one. Viewers detect gaps by
`rev` and re-read `listSessions`.

### 3.2 Session vat

```js
// Session program `guest/session/main.js`, delivered to a spare vat; make() called once.
make({ config, services: SessionServices, rowReporter }) -> { session: Session, internal: SessionInternal }

SessionServices        // per-session, attenuated; built by the factory, never contains admin facets
  backend: Backend                 // this session's backend only; open() -> Endpoint
  host: SessionHostFacet           // manager-minted for this session: liveChannel() -> LivePublisher,
                                   //   content() (Blob reads by handle only)
  workspace?: Workspace, shell?: Shell, envControl?: EnvironmentControl   // M6, per session
  execVat: ExecHandle              // from the factory pool: run(), retire(); no evaluate, no notifyOnStart

Session
  getInfo() -> record ; rename(title)
  watch() -> { snapshot, rev }      // settled page + queue + execution + usage + current turn record;
                                    //   viewers subscribe to live events in the gateway (D-8)
  enqueueOnce(submission, requestId, at) -> Receipt   // called by the gateway's Composer (D-12);
                                    //   submission = { text } (<= inlineBytes) or { blob, preview, bytes };
                                    //   requestId is an idempotency key (e); `at` stamped by the gateway
  getSubmissionReceipt(requestId) -> Receipt | undefined
  listPending() -> { entries: [{ entry: QueueEntry, key, preview, state }], hold }
  startTurn(input) -> Turn          // refused with the R4-10 text while a turn is active
  getCurrentTurn() -> { input, turn: Turn, history } | undefined      // reload re-attach (R4-62)
  getHistoryPage(cursor?) -> { turns: [TurnRecordPreview], nextCursor }   // cursor is text (d)
  getTurnContent(ref) -> { text } | { blob, preview, bytes }          // ref is a page-local marker (F.1 #15)
  getUsage() -> totals ; getAccount(refresh?) -> accounts (M4)
  emergencyStop() / resume()                                          // shell presets (M6)
  getNetworkPolicy() / requestNetworkPolicyChange(...)                // M7

QueueEntry   edit(submission) ; cancel() -> boolean ; sendNow() ; describe()   // key kept for reload (d)
Turn         getStatus() ; cancel() ; whenFinished() ; resolve(note)  // acknowledge outcome-unknown while idle
```

`SessionInternal` (held only by the factory): `rowSnapshot()`, `deleteSelf()`, `deliverMail(package)`
(M9), `exportState()`, `importState(chunk)`.

### 3.3 Agent-host native resource (manager vat facets)

```js
AgentHostAdmin (facet installed as 'agentHostAdmin'; held only by the factory)
  serveGateway({ port, operator, publicOrigin, trustedProxies }) -> Registration
                                              // operator remotable in the spec (allowed:
                                              //   pkg/resources/http/durable.js:85-91 keeps a foreign handler)
  makeBackend({ kind, label, keyGrant?, pool?, options }) -> Backend   // kind: 'scripted'|'openrouter'|'anthropic'|'claude-pool'|'codex-pool'
  forSession(session) -> SessionHostFacet     // minted per session; given only to that session's vat
  listPublisher() -> ChannelPublisher          // session list, accounts, home (adapter-side, D-8)
  onStart(listener) -> Registration            // the factory registers; called from lifecycle.started()
  getSecrets() -> SecretsAdmin
  speech() -> VoiceServices (M11)

Backend          describe() ; listModels() ; open() -> Endpoint          // Endpoint is adapter-side (transient)
Endpoint         holdTurn(turnHandle) -> settles at turn end (lease, D-5) ; releaseTurn(turnHandle)
                 startRound(roundRequest)  (sendOnly) ; cancelRound()   ; revoke() (subscription backends, R4-49)
                 armDeadline({ opId, ms }) / disarm(opId)  (sendOnly; adapter timers, section 8)
                 blobWriter() -> BlobWriter   // for the exec vat's large results (section 6)
TurnSink         (session-vat exo passed in startRound) dispatching(round) ; progress({ partial: Blob, tail })
                 roundFinal(RoundResult) ; roundFailed(reason) ; deadline(opId)
ContextSource    (session-vat exo passed in startRound) page(cursor) -> { records, next }   // records only, no projection
SecretsAdmin     list() ; create({ label, description }) -> Secret ; openWriter() -> SecretWriter (adapter-local)
Secret           describe() ; makeReadGrant() -> ReadGrant ; revoke() ; delete() ; audit(limit)
SecretWriter     replace(secret, value | sealedBox, expectedGeneration)  // adapter-local; values never in a vat;
                                              //   resolves secret -> entry by rights amplification inside the
                                              //   resource (manager WeakMap), never by a public entryRef
Blob             describe() -> { bytes, preview }   // manager-minted handle; content read through Content
BlobWriter       append(piece) -> undefined ; close() -> Blob             // adapter-local, answered per piece
ChannelPublisher publish({ rev, events }) ; SessionHostFacet.liveChannel() -> LivePublisher (same shape)
```

**D-6. Secrets never enter a vat or the hub in clear.** The secret store (values, generation,
revoked flag, audit) is the adapter's encrypted file; the wrapping key is a separate 0600 file
outside the state directory (default `~/.config/thixotrope-harness/secrets.key`, path from
configuration), fixing W-4 in part. The manager vat's `Secret` exo holds an entry reference that only
the resource can map (a manager-side WeakMap from `Secret` to entry, consulted by the adapter through
its attach sink). Values are written through `SecretWriter`, an adapter-local object: from the browser
the call stays inside the gateway process; from the CLI the value is sealed to the adapter's X25519
public key (`node:crypto`) before it crosses the control socket and hub. Provider code reads values
in-process at each round (R4-82). The sign-in secret is an entry in the same store.

**D-15. Blob handles are manager-minted and pre-minted.** The adapter keeps a stock of minted, empty
`Blob` handles (minted 32 at a time with one manager crank through its attach sink); it writes and
fsyncs a file and binds it to a stock handle **before** passing that handle into any vat (feasibility
A-8). Hot paths therefore cost no manager crank. Within one adapter incarnation the adapter maps
handle presence to file in a WeakMap; after a restart it resolves handles in batches
(`E(sink).resolveBlobs([blob])`, one manager crank per batch). Handles never bound to a file are
discarded by the manager at the next start. Blobs are deleted when their session is deleted (M2).

### 3.4 Workspace and containers native resources (M6, M10)

```js
WorkspaceService   createWorkspace({ session-scoped options }) -> Workspace
Workspace          git() -> Git ; readOnlyGit() -> Git ; files() -> Dir ; publish() -> Route ; release()
Git                listBranches(), createBranch(name), switch(name), rename, delete, status(), diff(opts),
                   log(opts), stage(paths), commit(message), merge(name, {ffOnly}), stash(), trackingStatus()
Route              url() ; revoke() ; describe()
ContainerService   createEnvironment(recipe, { workspace }) -> { shell: Shell, control: EnvironmentControl }
Shell              runCommand(argv, { timeoutMs, cwd, stdin?: Blob }) -> ToolResult ; inspect()
EnvironmentControl stop() ; emergencyStop() ; resume() ; setNetworkPolicy(policy) ; retire()
```

**D-16. Containers are lazy desired state.** A container registration means "this environment may
run", not "keep it running". The containers adapter's `restore` re-binds registrations without
starting containers (`restore` re-binds every desired registration at every start,
`pkg/src/native/manager-kit.js:148-160`; native.md section 1 gap (c)); a container starts on the first
`runCommand` and stops after `envIdleStopMs` (default 15 min) without commands. A stop that fails is
retried by the manager at the next adapter start instead of quarantining the session (improves on
G-31 / R4-81). Restart cost is therefore independent of how many sessions have environments.

**D-7. One-shot and streaming operations use the attach pattern, no kit change.** Each native
resource registers one service key whose spec carries a manager-owned `attach` sink. The adapter's
`bind` calls `E(spec.sink).attach(opsFacet)`; the manager forwards `open()`-style calls to the current
`opsFacet` and returns adapter-side objects (Endpoint, SecretWriter, BlobWriter, publishers, Shell
ops) that the caller then uses directly, so the manager vat is on the path once per turn or per
object, not per operation. After a restart those references are tombstones; calls break; callers
re-`open()`. Spike S2 in M0 verifies (a) a durable vat can hold and call a transient-session
reference, (b) it breaks cleanly after restart, (c) restore re-attaches, (d) the adapter sees one
stable presence for one vat object within an incarnation (needed by the channel keying, D-8). If S2
fails, fall back to CORE-2.

**D-14. Thin installed modules, implementation loaded at run time.** An installation's identity is
its bundle digest pair (native.md section 1.2), and a reinstall breaks every reference into its
manager vat (Secrets, Backends, Blobs, Routes). Therefore `durable.js` is small and changes rarely,
and `ephemeral.js` is a loader that `import()`s its implementation and the UI assets from a
configured, operator-owned directory (`implDir`, mode 0700, path fixed at install). A provider, parser,
gateway or UI fix is a file change plus a daemon restart, not a reinstall. Cost: the implementation is
no longer pinned by digest; the directory is trusted operator input (journal).

---

## 4. How a turn runs

The session vat drives the loop (it decides and records); the agent-host adapter does the heavy text
work (it projects context, calls the provider and streams). The loop body is Fae's `runAgenticTurn`
(`fae/src/turn-engine.js`, 86 lines, callback-only) copied into `guest/lib/turn-engine.js`, with
hook tables (`guest/session/turn-hooks.js`: `beforeRound`, `onCancel`, `onSettle`, turn sources) so
later milestones plug in without editing `turn.js`.

### 4.1 Sequence for one turn

```
browser --E(composer).submit(session, text, reqId)--> gateway (adapter): stage text > inlineBytes
   as a Blob; E(session).enqueueOnce(submission, reqId, at)                 [crank 1: receipt + queue entry;
                                                                          if idle: claim = remove entry AND
                                                                          record TurnStarted{input} (atomic),
                                                                          publish (sendOnly), RowReporter change,
                                                                          E(endpoint).holdTurn(t) (lease),
                                                                          E.sendOnly(endpoint).startRound(req0)]
agent-host adapter: project the provider request from its context cache + req0.append; then
   E(turnSink).dispatching(0) and WAIT for the answer                   [crank 2: record Dispatched]
   then send HTTP; parse SSE in Node; every delta -> session channel (in-process) -> WS clients
   every 10 s or 16 KiB of new text: stage the partial text so far as a Blob;
   E.sendOnly(turnSink).progress({ partial, tail })                    [crank per checkpoint; replaces the
                                                                          single partial record]
   end of round: stage oversize fields; E.sendOnly(turnSink).roundFinal({ message, toolCalls,
   nativeContext: Blob, usage, at })                                     [crank 3: record round; record all
                                                                          intents (one record, <= maxCallsPerRound);
                                                                          publish tool_call events; issue the first
                                                                          callWindow calls]
tool results: one crank per result; record it, publish tool_result, issue the next waiting call
after the last result of the round: E.sendOnly(endpoint).startRound(reqN)   [same crank as the last result]
... final round without tool calls -> record TurnSettled, usage; publish final/usage/end;
    RowReporter change; E.sendOnly(endpoint).releaseTurn(t)               [lease answer: 1 more delivery]
```

Turn start costs 2 durable cranks before the HTTP request. A round costs 1 (final) + one per tool
result + one per progress checkpoint. A turn costs one extra delivery for the lease answer.

**Calls per round (coverage 18).** At most `maxCallsPerRound` (default 64) tool calls of one round
are run; extras get the error result "Too many tool calls in one round (N); only the first 64 were
run." (R4-45 style). At most `callWindow` (default 16) are in flight; each result crank issues the
next waiting call. No crank therefore sends more than about `callWindow` + 3 messages.

### 4.2 Streamed deltas without a durable commit per token

**D-8. Channels live in the agent-host adapter; no durable vat holds a browser viewer.** A channel is
an adapter-side object with two facets: a **publisher** (held by exactly one vat) and a
**subscriber** side reached only through the gateway-local `Live` service. Kinds: one per session
(events of its turns and queue), one for the session list, later accounts and home. The adapter
assigns a sequence number to every event, keeps the fold of the current turn (Fae `reply-fold.js`
copied to the adapter), fans out to WebSocket subscribers in Node and drops a subscriber when its
socket closes. Text deltas are published in-process by the provider code (zero durable deliveries per
token). Events that originate in a vat (turn start, tool_call, tool_result, phase, usage, final, end,
abort, queue changes, row diffs) are sent with one `E.sendOnly(publisher).publish({ rev, events })`
per crank, batched, at most 64 events and `frameBytes`. Order is natural: the adapter publishes a
round's deltas before it sends `roundFinal`, and the vat publishes tool events only after receiving it.

Viewing: the browser calls `E(session).watch()` for the durable snapshot and `rev`, then
`E(live).subscribe(session, rev)` on the gateway's `Live` service, which keys the session channel by
the session presence (S2 (d)), sends the current-turn fold, then live events. A gap in `rev` makes the
client re-watch. Late joiners and reloads get the same view (P-09).

Staleness after a restart: inside a turn the publisher is obtained with the turn's Endpoint (same
incarnation), so `sendOnly` is safe; a stale Endpoint shows up as a broken lease. Outside a turn
(queue edits, renames) the session publishes with an answered `E(publisher).publish(...)`; a break
makes it obtain a fresh publisher with `E(services.host).liveChannel()` and publish again. These are
rare, so the extra delivery does not matter. The factory refreshes its list publisher in its start
listener.

### 4.3 What is recorded before and after each step (intent before effect)

The heap is made durable by image + journal replay, and the hub commits a crank's outbound frames
before forwarding them (core.md 1.2-1.3; README 875-884). Therefore **state written to the heap in the
same crank that emits an outbound call is durably recorded before the call can have any effect**: if
the daemon dies, replay regenerates the crank (and its heap record) and the hub drops the duplicate
output. M0 spike S9 verifies this for a call to a transient adapter session (coverage 17).

| Step | Recorded in the crank that... | Record |
|---|---|---|
| Turn start | claims the queue entry | `TurnStarted { turnId, input, at }`; the entry is **removed in the same crank** (atomic claim; no `dispatching` or `interrupted` entry state can exist) |
| First dispatch | receives `dispatching(0)` (adapter awaits the answer before HTTP) | `Dispatched { turnId, round: 0 }` |
| Partial text | receives `progress` | replaces the single `Partial { round, blob, tail }` record |
| Round result | receives `roundFinal` | `RoundSettled { message (inline or Blob), toolCalls, nativeContext: Blob, usage, servedBy }` |
| Tool intents | same crank as round result, before issuing calls | one `ToolIntents { [{ opId: turnId/round/ordinal, name, args (inline or Blob) }] }` |
| Tool result | receives each answer | `ToolResult { opId, result (inline or Blob, cut to the tool limit), failed }` |
| Compaction | `beforeRound` hook decides (M8) | `CompactionStarted { boundary }` before the summary round; `Compaction { summary, boundary }` after |
| Turn end | receives final round / cancel / failure | `TurnSettled { status, error?, usage }` |

A refusal found in the claim crank itself (backend revoked, session stopped, deadline) writes no
`TurnStarted`: the entry stays queued with the `refused` hold ("Not sent: ...", A.4 SPEC:1624). A
failure after the claim closes the turn as failed with its input visible; it is never re-queued.
A crash after `Dispatched` is recorded but before the adapter received the answer is reported as
outcome-unknown although no HTTP request was sent (conservative, documented).

### 4.4 Restart with a turn in flight (P-14, R4-66)

`recoverAfterRestart()` is idempotent and runs on the first retired break the session receives
(D-5: the lease, or any adapter call on the turn path). It inspects the current turn:

- no `Dispatched` record: close it "Interrupted before dispatch; no backend execution was started."
  The input stays in the transcript, marked interrupted; nothing is re-queued (the entry was removed at
  claim); like Endo, a never-dispatched turn is left out of later context (R4-32), so the user resends it.
- `Dispatched` recorded: mark the turn `outcome-unknown`; every tool intent without a result gets
  "Tool outcome unknown; do not automatically retry."; never re-send.
- in-flight work that survives the restart is stopped or abandoned: child asks are cancelled with
  `E.sendOnly(childTurn).cancel()` and recorded (each child also recovers its own turn through its own
  lease, so a parent's ask settles as failed, R4-67); a pending exec call is abandoned by turn
  generation (its late result is ignored; the exec vat is not retired).
- if the queue is non-empty, hold it `restart` (A.4 text, SPEC:1621; R4-56).
- report the row change.

The turn is acknowledged with `turn.resolve(note)` while idle; the next context includes the
outcome-unknown turn and its "Tool outcome unknown" texts (R4-32). **Builders must not follow
reuse.md:353** ("an interrupted provider call must be recorded and re-issued by the guest"): it
contradicts R4-66.

### 4.5 Context building: records in the vat, projection in the adapter

**D-9. The vat owns the records; the adapter owns the only projection.** The session vat sends
records, never projected text. `startRound({ turnSink, contextSource, base: { count, epoch },
append: [records], tools, options })` carries the records added since the last round (small: large
fields are Blob handles). The adapter keeps one context cache per session (record list + loaded blob
text + provider-format projection). If its `{count, epoch}` differs from `base` (adapter restarted,
cache evicted, first round), it pulls records from `E(contextSource).page(cursor)` (pages of at most
`frameBytes`, outbound from the vat) starting at the latest `Compaction` boundary, resolves blob
handles in batches, and rebuilds. Projection logic (Fae `journal-transcript.js`,
`context-transcript.js`, `transcript-records.js`) runs once, in Node, so there is no second
implementation to keep in byte-for-byte agreement (feasibility A-6). Native context is replayed from
its Blob, so a rebuild after a restart replays faithfully (R4-31).

Compaction (P-36, M8): the vat decides from the previous usage reading (R4-34) and records
`CompactionStarted` before a tool-less summary round; the adapter plans the retained tail on its cache
and returns the summary as an ordinary round result; the vat records `Compaction`. A restart during
compaction is an ordinary outcome-unknown round. Unknown outcomes stay in the retained context (R4-35).

---

## 5. Keeping transcripts from slowing cranks and snapshots

Measured: 20 M characters of strings in a heap move crank latency only from 64 to 66 ms, but grow the
snapshot by about 3.3 bytes per character and the state directory roughly doubles while running
(tooling.md 4.4). The chunk ceiling (256 MiB, max 512 MiB) is a hard wall that quarantines.

**D-10. Small records in the vat; large text in blobs from the moment it arrives.**

- Any text field over `inlineBytes` is a Blob plus a preview (section 9), staged by whoever produced
  it (gateway for submissions, provider code for model output, the callee for tool results, the exec
  vat through a `BlobWriter` for large exec results). Content is never deleted (R4-64); session delete
  releases its blobs.
- A settled turn is therefore a few KB in the vat. 10,000 turns are tens of MB of heap, below the
  chunk wall. **No archive in M2.** M2 measures snapshot time and size at 1,000, 10,000 and 30,000
  turns (`journal.snapshot`); only if that misses its budget does M13 add an adapter-written archive
  (the adapter writes chunks from its cache, the vat drops resident records only after receiving the
  chunk's Blob for a matching turn range: 1-2 deliveries per 256 turns).
- History pages are 32 turns and at most `frameBytes`; a turn larger than that returns a summary with
  refs (`getTurnContent(ref)`). The browser reads blob content through the gateway's `Content`
  service in-process (0 vat deliveries; one manager crank to resolve handles after a restart).
- Guest code never builds strings with `+=` in loops; it uses arrays and `join` (lint check in
  `guest/` and the "too big" perf probes).

---

## 6. Confinement

**D-11. Model-written code runs in a per-session exec vat, in one persistent Compartment.** The exec
vat is created lazily on the first `exec` call (from the spare pool). It holds one `Compartment` whose
global object persists across calls and restarts (Appendix F.1 #5: `globalThis.x = 5` survives;
probe confirmed nested compartment globals persist across deliveries). Endowments: `E`, `harden`,
`sleep(ms)` (an adapter timer passed per call), `console` (a bounded per-call log returned with the
result, W-13), and `powers`, a **live** read facet over the session's label map (`get(label)`,
`list()`), not a copy (coverage 34). No `Date`, `Math.random`, `import`, filesystem. Each call is
wrapped as an async function body so top-level `await` and `return` work; top-level `const`/`let`
are per call, `globalThis.name = v` persists. The R4-26 guest prompt text ("each call is a fresh
function body") is rewritten to describe the persistent scope (M5; journal).

The source travels inline when small; above `inlineBytes` the exec vat reads it from its Blob in
pages; above `execSourceBytes` (default 262,144, S3 may lower it) the call fails with "exec source too
large (N bytes; limit L)". A result over `inlineBytes` is cut to the tool limit (R4-46) inside the exec
vat and written in pieces of at most `frameBytes / 2` to the `BlobWriter` passed with the call, one
answered piece per crank.

Lifetimes:

- **Synchronous runaway** exceeds the crank budget and quarantines the exec vat. The session sees
  its pending call break (guest-to-guest calls survive restarts, so a retired break from the exec vat
  means the exec vat halted, not a restart), records "exec scope terminated: it exceeded the per-step
  compute budget; bindings from earlier calls are gone", **retires the quarantined vat explicitly**
  through `ExecHandle.retire()` (18 MB or more each, feasibility A-4) and takes a fresh one on the next
  call. The compute ceiling per crank is about 600 k simple iterations at 10 M computrons, more at the
  configured budget (journal: weaker than Endo's exec).
- **Asynchronous runaway or hang** is bounded by `execDeadlineMs` (default 120 s, fixing G-18; a
  departure from R4-48, open decision 10): the session arms an adapter timer
  (`E.sendOnly(endpoint).armDeadline`) in the crank that issues the call; on `deadline(opId)` it
  records the timeout and retires the exec vat (the only way to stop it).
- **Cancel does not retire the exec vat** (R4-49: a running tool is not interrupted). The pending
  answer is abandoned by turn generation. If the exec vat is still busy when the next exec call
  arrives (the exec program answers `{ busy }` at once), the session retires it and tells the model
  "the previous exec call was still running; the scope was reset". Every scope loss is stated in the
  tool result and journaled when first seen.

W-6 is fixed: the exec scope shares no worker with tokens.

Tools other than `exec` are exos in the session vat that call capabilities. Their outputs are bounded
by the callee **per field** so the serialised result stays valid JSON under the tool limit (fixing
G-19): `runCommand` returns `{ exit, stdout, stderr, truncated }` where stdout and stderr are each cut
(with the R4-46 marker inside the field) so the whole JSON fits 32,768 units; `readSources` and
`askSubagent` budget their fields the same way. Granted tools are remotables with `describe()` and
`execute(args)` (P-65); built-in names are protected.

Reachability: neither a session vat nor an exec vat can reach `AgentHostAdmin`, `SecretsAdmin`, any
`Secret` admin or value, the factory, the gateway or another session's facets. M4 tests this with
`thix reachability` from both vats (coverage 28).

Native adapters are unconfined Node with the daemon user's authority (native.md section 5); only the
operator can install them. They correspond to the spec's unconfined caplets; the durable halves and
all harness vats are confined. One agent-host process holds gateway, providers, channels, secrets,
blobs and speech: a crash drops every socket, stream and context cache at once. Mitigations: errors
are caught per connection and per round; speech engines run as supervised child processes; context
caches rebuild lazily per session (journal: blast radius).

---

## 7. Browser client, transport and auth

**D-12. The gateway is part of the agent-host adapter and speaks CapTP over WebSocket.**

- Registration: `host.serveGateway({ port, operator, publicOrigin, trustedProxies })`; the adapter
  binds `127.0.0.1:<port>` (the reverse proxy and TLS are out of scope). Any non-upgrade GET returns
  the app shell; static assets are served from `implDir` (D-14) with correct content types and a
  strict CSP (W-15). WebSocket upgrade on `/ws` only; Origin must equal `publicOrigin` (W-1).
- Protocol: `@endo/captp` JSON text frames. The bootstrap offers only `fetch(secret)`; a correct
  secret returns `{ operator, live, content, composer }`: the `Operator` presence imported from the
  factory vat plus three gateway-local services (`Live` subscriptions, `Content` blob reads, `Composer`
  submissions and queue edits that stage large text). The browser keeps the secret in the URL fragment
  and sends it only inside the WebSocket.
- **Failed sign-in limiter (W-8):** +1,000 ms per failure (R6-76), keyed by client address. When the
  socket peer is in `trustedProxies` the client address is the right-most `X-Forwarded-For` entry not
  in `trustedProxies`; otherwise the socket peer. A global ceiling (default 20 failures per minute)
  bounds guessing through many addresses.
- **Frame guard:** the CapTP bridge measures every call it forwards to a vat (sum of string bytes,
  estimated as UTF-16 units x 3) and refuses one over `frameBytes` with "message too large; use the
  composer" before it reaches the hub. Max WS message 1 MiB.
- Objects the adapter owns (`Live`, `Content`, `Composer`, `SecretWriter`, audio streams) are local
  exports of the same process, so their traffic never leaves the adapter; a returned own export
  resolves to the local object (`pkg/src/net/hub.js:804-812`).
- Audio uses a second WebSocket route `/audio` authenticated by a short-lived capability token minted
  by `VoiceServices.openAudio()` (binary frames, never CapTP JSON), with inactivity timeouts (M11).
- UI: copy and adapt `space-floot` (presentational Preact) and `chat/floot-component.js` +
  `floot-*.js` helpers from 1315bef86, replacing pet-name lookups with `Operator` methods and
  `watch()` pulls with `Live` subscriptions; extract client audio (l.2019-2774) into `ui/src/voice/`.

Restart: sockets drop; the client shows the reconnect overlay (0, 1, 2, 5, 10, 30 s backoff),
rebuilds from `watch` snapshots, re-subscribes and re-attaches a running turn through `getCurrentTurn`
(R4-62).

**D-13. Native reinstall indirection.** D-14 makes reinstalls rare. When one is needed, objects minted
by the old manager vat (Secrets, Backends, Blobs, Routes) break; sessions receive their
`SessionServices` from the factory, which can rebuild and push them (`SessionInternal.importState` path
in M13). During development builders use fresh state directories.

---

## 8. Time, ids and randomness

- Ids are counters in the owning vat: session key `s<n>`, turn id `t<n>`, op id `t<n>/r<round>/c<ordinal>`,
  queue entry key `q<n>`. No randomness needed in vats.
- Unguessable tokens (sign-in secret, asset path tokens, audio tokens) are minted in adapters
  (`node:crypto`).
- Time is data: every adapter-to-vat message carries `at` (ms), including `enqueueOnce`, which only the
  gateway's Composer calls, so the submission window check (24 h window, 5 min skew, R4-98) always has
  a fresh time (coverage 13). The session keeps `lastKnownTime` for other uses.
- **Interactive timers are adapter timers**, not the clock resource (about 1 s per alarm, fact 6):
  exec deadlines, `sleep` in exec, turn deadline, subagent ask timeouts. They die with the adapter, which
  is correct because the turn they belong to dies too. The clock resource is used only for durable
  alarms that must outlive a restart (none planned before M9's mail backlog timers [inferred]); when
  used, it is `arm()` with cancel, one alarm per owner, never `after()` without cancel (feasibility A-13).

---

## 9. Limits that protect vats

Every vat-facing input and output has a bound enforced **on the sending side** (adapter, gateway, or
the vat's own message builders) and again by the exo guard. Sizes are **UTF-8 bytes** unless stated;
guest code estimates a string's bytes as UTF-16 units x 3 (no per-character loop). Values are harness
settings with these defaults.

| Bound | Default | Spec default it replaces |
|---|---|---|
| `frameBytes`: string content of one message into or out of a vat | 24,576 until M0 S1 measures with CORE-1a/CORE-1 and the chosen crank budget; then half the measured halt point (target >= 196,608) | n/a |
| `crankOutBytes`: all messages sent in one crank | 2 x `frameBytes` (S1 measures several messages in one crank) | n/a |
| `inlineBytes`: larger text fields are Blobs | 8,192 | n/a |
| previews (messages / tool calls and results) | 1,024 / 256 | n/a |
| Message string (submission, through the Composer) | 200,000 characters (staged as a Blob; the limit is now WS message size and context, not frame cost) | 100,000,000 (R4-97) - lower; open decision 1 |
| Tool output into the model | 32,768 UTF-16 units with the R4-46 marker, per-field for structured results; staged as a Blob when over `inlineBytes` | same (R4-100) |
| Container output per stream (adapter) | 64 KiB, then per-field budget | same (R3-47) |
| Tool calls per round / in flight | 64 / 16 | none - open decision 11 |
| Live publish batch from a vat | 64 events and `frameBytes` | n/a |
| Eventual sends per crank (guest code rule) | 100 | n/a (250 ok, 500 MeterAbort at 10 M) |
| History page | 32 turns and `frameBytes` | 32 turns |
| Context page to adapter, session list page | `frameBytes`; 50 rows | n/a |
| Exec source | 262,144 (S3 may lower) | none |
| Exec deadline | 120 s; compute bound = crank budget | none (G-18; R4-48) - open decision 10 |
| Turn wall-clock deadline | off (configurable) | none (R4-48; G-06) |
| Queue | 100 waiting, 4,096 receipts | same (R4-98) |
| Crank budget (`THIXOTROPE_CRANK_BUDGET`, daemon-wide) | chosen in M0 S1 (planning value 50 M) | n/a |

---

## 10. Test strategy

- **Scripted fake model provider (no credentials).** Backend kind `scripted` in the agent-host
  adapter takes a script as data: rounds of `{ chunks: [text], chunkDelayMs, toolCalls: [{name, args}],
  usage, error?, stall?: 'untilCancel' }`. A scripted **adapter tool** `echo({ text, delayMs, bytes })`
  whose delay lives in the adapter is used for parallelism and size tests. `test/fixtures/fake-provider-server.mjs`
  is a local HTTP server that speaks the four wire formats (Anthropic Messages SSE, OpenRouter chat
  completions streamed, OpenAI Responses SSE, Claude subscription Messages SSE) from recorded fixtures,
  including 429 with rate-limit headers, 401, 5xx, overload and mid-stream disconnect.
- **Fake container runtime** (`resources/containers/runtime-fake.js`): runs allowlisted argv as
  child processes in the session directory under a scratch HOME with the same result shape, timeouts
  and output caps. Real Podman steps are tagged `[real-podman]`.
- **Fake speech** (`fake-stt`, `fake-tts`, plus hanging variants for timeout tests). `[real-moonshine]`,
  `[real-piper]` steps are tagged.
- **Layers.**
  1. Unit (Node, `ses-ava` lockdown): `guest/lib` and `guest/session` logic with in-memory fakes;
     ported Endo tests (reuse.md section 5). Fast; run often.
  2. Adapter (Node): providers against the fake server, secrets backend, blob store, channels,
     gateway auth and frame guard, fake container runtime, git via the real `git` binary.
  3. Integration (real Ironhorse supervisor, `concurrency: 1`, state under
     `packages/thixotrope-harness/tmp/<6-char>` mode 0700, deleted in `finally`, supervisor stopped and
     awaited first): end-to-end turns, SIGKILL of the supervisor child and restart. Integration tests
     start from a **pre-provisioned state template** copied per file (M0 spike S8; if state directories
     are not path-independent, provision once per file) and run with `idleSleepMs: 2000` so idle
     sessions checkpoint quickly (fact 5). Budget: **each integration file** under 5 minutes with the
     template; at most 300 MB of state.
  4. Browser (Playwright from `packages/exo-playwright` or the built-in browser pane) against a local
     gateway with the scripted backend: reconnect, reload, phone width, voice with synthetic audio.
- **Run lock.** Integration tests and perf checks take an exclusive lock (`scripts/run-lock.mjs`,
  `H/tmp/.run.lock`, `O_EXCL`, holder pid recorded, stale lock broken only when the pid is gone).
  Parallel builders wait on it; the PM holds it for milestone sign-off runs. Never run the full T suite
  concurrently with integration tests (tooling.md 2.1).
- Acceptance tests check observable behaviour through the public API, the browser or the network.
  Implementation counts (resident records, wake counters, journal contents) are perf/gate checks.

---

## 11. Performance-check method and budgets

**Method** (adapted from tooling.md section 5):

1. Scripts `packages/thixotrope-harness/perf/<feature>.perf.mjs`, sharing `perf/_harness.mjs`
   (start supervisor via `serveThixotrope` with chosen `idleSleepMs`, provision from the template,
   `stats`, `emit`, `restart`, engine counter deltas from `status().timings`, `hub.json` size,
   a CapTP WebSocket client). Start from `scratchpad/thix/survey/baseline.mjs`.
2. Run under the run lock, one at a time, release worker, fresh bundles, never alongside tests:
   `cd packages/thixotrope-harness && node perf/<feature>.perf.mjs`. State in `tmp/pf<pid>`, removed in
   `finally` (`KEEP_STATE=1` keeps it).
3. Output: one JSON line per metric:
   `{"metric":"<feature>.<op>","unit":"ms","n","median","p95","p99","max","deliveries":{"count","perOp"},"hubJsonBytes","snapshot":{...},"budget":{"median","p95","deliveriesPerOp"},"pass","commit","workerSha256","crankBudget","loadAvg"}`.
   Exit 1 when a median exceeds 1.25 x budget or deliveries per op exceed the budget. At least 200
   samples for latencies, 5 runs for start/restart.
4. Every feature that moves data into a vat has a "too big" probe (string bytes, list length, sends
   per crank, calls per round) proving the sending-side bound fires before the vat would halt.
5. Results go into `JOURNAL.md` with the commit and the load average.
6. Bulk fixtures (hundreds of sessions or thousands of turns) are built with `importState` (one crank
   per `frameBytes` of records), never by running turns.

**Budgets** (M3 Max class machine; deliveries = durable vat deliveries):

| Metric | Budget |
|---|---|
| `frames.inbound` / `frames.outbound` at `frameBytes` | no halt; <= 300 ms over the ping floor |
| `frames.halt` (S1): halt point with and without CORE-1a/CORE-1, at each crank budget | recorded; sets `frameBytes` |
| Turn start: submit accepted to provider request sent (scripted backend) | median <= 350 ms; <= 3 deliveries |
| Live delta: provider chunk in adapter to WS frame out | median <= 5 ms; 0 deliveries per delta |
| Deliveries per model round | <= 1 + ceil(round seconds / 10) + tool results |
| Tool intents per round | in the round-final delivery, 0 extra |
| Turn lease | 1 delivery per turn |
| `exec` trivial call (session -> exec vat -> session) | median <= 250 ms |
| `exec` first call in a session (spare exec vat) | <= 1.5 s |
| `exec` 100 answered sends / 100 `sendOnly` | <= 8 s / <= 1 s |
| Session create with spare pool / without | <= 1.5 s / <= 6 s |
| Session list, 100 sessions | <= 200 ms per 50-row page; 0 session vats woken |
| Session watch snapshot, 1,000-turn session | <= 300 ms; <= `frameBytes` |
| History page (32 turns) | <= 300 ms |
| Queue enqueue while a turn runs, round trip from the browser | median <= 150 ms |
| Concurrent: 10 sessions streaming with tool rounds at once | per-session turn start <= 2 x single; crank p95 <= 200 ms; row push <= 500 ms |
| Daemon throughput: deliveries per second at saturation | recorded; journal if < 50/s |
| `hub.json` after 1,000 turns with a UI attached / after 50 sessions | <= 2 MB; ms per delivery <= 1.25 x fresh |
| Checkpoint stall: turn latency while a busy session vat snapshots | p99 <= 1 s |
| Restart to serving, 50 idle sessions (checkpointed) | <= 15 s; 0 idle session vats woken |
| Restart with 20 sessions that have environments | <= 15 s; 0 containers started |
| Clean shutdown, 50 sessions | <= 5 s |
| Disk per idle session (session vat only / with exec vat) | <= 25 MB / <= 50 MB |
| Session vat snapshot with 10,000 turns | <= 1 s; decides whether M13 builds an archive |
| Secret read per round | in-process, <= 1 ms, 0 deliveries |
| Container `runCommand(['true'])` harness overhead over runtime | <= 150 ms |
| git `status` on 10 k-file repo through the capability | <= 1 s |
| Asset request first byte | <= 20 ms; 0 deliveries |
| Audio frame path | 0 deliveries; STT partial <= 300 ms after 0.5 s of new audio (real engine) |
| TTS first audio after first sentence (warm) | <= 1 s (real engine) |
| Factory install of the bundled program (CORE-1b) | <= 30 s |

---

## 12. Guest coding rules (enforced in review)

1. No `Date`, `Math.random`, `setTimeout`, `console`, dynamic `import`, `WeakRef` in `guest/`.
2. No string `+=` in loops; no unbounded `slice` chains; build with arrays and `join`.
3. No more than 100 eventual sends per crank; fan-out to many receivers is an adapter's job.
4. No suspended async generators or `Array.fromAsync` across deliveries (README 761-762 vs
   `rust/engine/ironhorse-snapshot/tests/persist_gates.rs:458,496` disagree; spike S5 settles it).
5. Every exo method guard bounds string length and array size; every message builder checks
   `frameBytes` and `crankOutBytes` (estimate: units x 3) and splits or stages before sending.
6. Objects, not ids, except F.2 (a)-(e); every retained collection has a bound or a delete path
   (owner's PR 1248 rule: bound retained state, not lifetime counts).
7. Durable vats never hold browser viewers or other per-connection objects; they publish to an
   adapter channel.
8. A retired break from an adapter object on the turn path means "restart": route it to recovery,
   never record it as a tool failure. Test with `isRetiredBreak(error)` (matches the hub text,
   `pkg/src/net/hub.js:1947`), kept in one helper.
9. Code shipped into vats is frozen there: keep vat programs thin, state as plain records, so
   `exportState`/`importState` (M2) can move it to a new program version.

---

## 13. Open decisions (need the owner; the default in brackets is what builders implement meanwhile)

1. Submission message limit 200 k characters instead of the spec's 100 M (R4-97 is [default]).
   [200 k]
2. Dormant-after-restart (D-5) replaces R4-65's eager inbox resumption: inbox mail received before a
   restart waits until the session's next wake. [dormant]
3. Transcripts at rest (W-16, G-33): unencrypted heaps and blobs in a 0700 state directory, or encrypt
   blobs; retention policy. [0700, retain until session delete]
4. Secrets wrapping key custody: key file outside the state dir (D-6, W-4 partly fixed: same-user
   adapters can read it) now; macOS Keychain / systemd credentials later? [key file]
5. `full-control` preset (W-3): which attenuated operator facet does it get? [not built until decided;
   network `off` by default when built]
6. Upgrade policy: data-only `exportState`/`importState` exists from M2; automated upgrade in M13, or
   fresh state per release until the harness stabilises? [M13]
7. Occasional items P-59 (workflows), P-60 (Android), P-62 (daemon-to-daemon peers), P-63 (other
   spaces): build after M13, or drop? Parity is not complete until this is ruled on. [after M13]
8. Codex reset-credit redeem (R4-86, wire format never exercised): build behind a flag or defer. [defer]
9. Per-session disk cost (two vats, about 36 MB) with about 21 GB free: session count cap (G-13)?
   [cap 200 sessions, configurable]
10. Exec deadline 120 s (fixes G-18, departs from R4-48) and turn deadline off (R4-48, G-06). [as stated]
11. Tool calls per round capped at 64 (no spec bound). [64]
12. G-05: retry Claude subscription overload (529) like Codex (R4-75) while nothing was delivered,
    departing from R4-76. [retry]
13. Compaction window from configuration for Claude and the Anthropic API so compaction can fire
    (fixes G-04/G-05, departs from R4-37). [configured window]
14. G-10 spending limits, G-11 voice preset pinning a model that may leave the catalogue (fall back to
    the factory default with a warning), G-15 date in the prompt, G-26 backend for agent-built apps.
    [none / fall back and warn / no date / none]
15. Crank budget raised daemon-wide (M0 S1 picks the value). [50 M pending S1]
