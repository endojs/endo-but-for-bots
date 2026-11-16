# Thixotrope programming model: a builder's guide

Scope: `packages/thixotrope` in `/Users/xyz/Development/endo-thixotrope-harness` (branch
`claude/thixotrope-harness`, HEAD `48d6f3e08b`). Paths are relative to that work tree unless stated.
"README" means `packages/thixotrope/README.md`; "main design" means `designs/thixotrope.md`
(the normative document, per `packages/thixotrope/designs/README.md:3-4`).
Claims I could not confirm in code are marked [inferred].
I measured nothing in this pass: neither native worker binary is built
(`target/release/thixotrope-ironhorse-worker` and `target/release/thixotrope-xs-worker` are absent),
and building them was out of scope for a read-only survey on a nearly full disk. The performance
figures below come from the package's own design notes. Section 11 lists the checks to run first.

---

## 1. What persists, and how

### 1.1 The unit: a vat's whole heap

- A **vat** is one guest heap behind one OCapN endpoint, run by one worker process (main design
  vocabulary, `designs/thixotrope.md:79`). The guest's objects, closures, variables, pending
  promises and suspended `async` activations persist without serialization code
  (`designs/thixotrope.md:12-14`; README 684-686).
- Each vat is a single SES `Compartment` created once at first boot. The prelude is copied onto its
  `globalThis` (`src/core/worker-peer.js:61-62`). Everything reachable from that compartment
  persists, including `globalThis.x = ...` assignments (README 143-146).
- Default engine: **Ironhorse** (`makeIronhorseEngine`, README 962). It is a Rust VM with a SQLite heap
  store, one process per vat (`designs/thixotrope.md:59`). The alternative is **XS** (`makeXsEngine`),
  whose heap snapshots go into a CAS (README 965-971). The supervisor composes Ironhorse.

### 1.2 Cranks, journal, snapshots

- **Crank / delivery.** The host sends a worker one OCapN frame, and the guest runs to quiescence:
  the dispatch plus all promise jobs (`src/core/worker-engine.js:34-36`, `designs/thixotrope.md:179`).
  After each crank the Ironhorse worker runs a full GC plus finalizer callbacks
  (`rust/thixotrope-ironhorse-worker/src/main.rs:185-190`, `sweep_and_notify` at `:240`).
- **Journal first.** The transport appends every host-to-worker frame to `workers/<id>/journal.jsonl`
  and fsyncs it before the worker sees it (`src/core/durable-worker-transport.js:306-320`;
  `src/platform/node/sync-files.js:59-66` uses `fs.fsyncSync`). The write is synchronous, on the
  supervisor's single Node thread.
- **Heap commits are not per crank.** The incarnation's private SQLite copy is committed only in
  `close_heap` (`main.rs:426-435`, comment `:523`). Production cost model 1.1
  (`packages/thixotrope/designs/production-cost-model.md:121-148`) explains why. Durability comes
  from *image + journal replay*, not from the live heap.
- **Snapshot (checkpoint).** The worker closes, the SQLite file is hashed and copied into
  `heaps/snapshots/<sha256>.sqlite`, `{ref, cut}` is recorded, the journal prefix is truncated, and
  the worker relaunches or terminates (`durable-worker-transport.js:382-430`; README 691-702). A
  checkpoint happens:
  - on idle sleep (30 s in the supervisor, `src/control/supervisor.js:141`);
  - every `snapshotEveryDeliveries` deliveries (256 by default, `supervisor.js:142`;
    `durable-worker-transport.js:345-356`);
  - on explicit `sleep()` or on `shutdown()`.
  The cost grows with heap size, because the whole DB file is copied (README 700-701). In
  production it averaged 6.7 s (`production-cost-model.md:21-22`, measured before later fixes).
- **Replay determinism is load-bearing.** The hub drops replayed output by frame number
  (`outboundBase + seenOutbound`). The same journal must therefore produce the same outbound frames
  (`production-cost-model.md:70-72`). Everything nondeterministic has to enter as a journaled
  inbound frame. This is why guests have no clock or entropy (section 3.2).

### 1.3 kill -9 mid-crank

- Recovery restores the last image paired with its journal cut and replays the journal suffix. It
  never adopts the abandoned incarnation's newer DB (README 695-698, 886-888;
  `src/ironhorse/ironhorse-engine.js:17-23`).
- The hub commits its input watermark, c-list changes and outbox together before forwarding. Output
  regenerated during replay is dropped by sequence number, so delivery is "exactly once, never lost,
  never twice" (README 875-884, 697-702; `designs/thixotrope.md:161-171`).
- CI tests SIGKILL at four boundaries (after journal append, heap commit, output acceptance, and
  snapshot metadata publication) and checks for exactly one increment (README 663-678). These tests
  do not cover power loss or disks that ignore fsync (README 677-678).
- On daemon startup, workers with a journal suffix are woken and replayed so that accepted work
  resumes; workers that are fully checkpointed or quarantined stay asleep
  (`designs/thixotrope.md:156-157`).
- **Deterministic halt.** Exceeding the crank budget or a heap ceiling *quarantines* the vat. The
  last image and journal are kept, the comms session is retired so pending calls reject, and the
  poison input is not replayed again (README 704-710). Raising limits does not un-quarantine it
  (README 749). A quarantined workspace vat cannot be repaired by any command (README 221-226).

### 1.4 What is NOT persistent

- **OS resources.** Sockets, processes, file descriptors and timers live in native-resource adapter
  processes that are expected to die (`designs/thixotrope.md:269-278`).
- **Answers the host owes.** A pending host-resource or host-endpoint answer is at-most-once and
  *rejects* after a restart (README 1201-1203, 1257-1266). This includes any call through the
  host-mediated `facade.evaluate` (section 2.6).
- **Transient sessions.** Transient clients, native adapter sessions and peer connections without a
  resume token are discarded at startup (`designs/thixotrope.md:80`; README 901-916).
- **View/UI subscriptions.** These are cancelled when the connection or the supervisor ends
  (README 201-210).
- **Ephemeral workers.** The heap is discarded at the next start, and holders meet tombstones
  (`src/core/daemon.js:635-650`, `:692-742`).
- **Code upgrades.** A closure installed in a heap is frozen there. The supervisor bumps
  `WORKSPACE_VERSION` (currently 21, `supervisor.js:112`) whenever a closure it ships by source
  changes shape, and older state directories are rejected (README 420-425). There is no live
  upgrade (`designs/thixotrope.md:200-201`; `packages/thixotrope/designs/README.md:44-60`).

---

## 2. Structural pieces

### 2.1 Workers and vats

- `daemon.createWorker({ debugLabel?, ephemeral?, allocationKey? })` returns a worker admin object.
  Ids are unguessable, generated by the host, and confer no authority (README 30-40;
  `daemon.js:529-560`). `allocationKey` (128-bit hex) makes allocation idempotent.
- Worker admin object: `workerId`, `debugLabel`, `evaluate`, `isAwake`, `wake`, `sleep`, `retire`,
  `notifyOnStart`, `clearStartNotice` (`daemon.js:579-599`).
- Sleep is embedder policy and invisible to the guest (README 23-28). Any message to any of the
  vat's presences wakes it.
- `resident` workers never sleep and are not snapshotted on cadence. Ephemeral workers are resident
  (`daemon.js:225-230`; `production-cost-model.md:238-239`).

### 2.2 Hub

- `src/net/hub.js` (2,362 lines) is a non-reifying forwarder. It keeps per-session c-lists, answer
  routes and publications as plain JSON tables and rewrites slots structurally (README 14-21,
  923-937).
- Every vat-to-vat message passes through the hub, including between local vats
  (`designs/thixotrope.md:32-35`).
- The whole hub state is written as **one file, `hub.json`, through an atomic rewrite with fsync**
  (`hub.js:355-364`; `src/store/store-fs.js:229-235`; `sync-files.js:40-57`). A delivery that sends
  k frames costs 1 + 2k whole-table writes (`production-cost-model.md:343-348`, deferred D.1). In
  production `hub.json` grew to 11.5 MB and was rewritten about once a second
  (`production-cost-model.md:19-20`). The cause was missing import GC, now fixed (section 6).
- Promises are not special: `op:listen` is forwarded like any message, and a settlement wakes a
  sleeping worker (README 935-937, 954-956).

### 2.3 Supervisor, workspaces, inventory, attach

- `thix serve DIR` is a foreground supervisor. It owns the state directory and holds a kernel lease
  through a helper process (README 100-141). It serves `control.sock` (mode 0600, full local admin)
  last, after workers are restored, so clients should retry on `ECONNREFUSED` (README 139-141).
- **Workspace.** A state directory holds a table of workspaces. Each one is a vat with an
  `inventory`, an address book and a mailbox vat (README 114-131). The workspace vat's globals are
  set once, through `globalThis.x ??= ...` evaluations:
  - `vats` is a worker-controller resource (`src/control/workspaces.js:288-290`);
  - `inventory` is the observable map, shipped by `makeObservableMap.toString()`
    (`workspaces.js:311-312`).
- **Inventory.** A string-keyed observable Map (`src/observable-map.js`):
  `get/has/set/delete/clear/keys/entries/getSize/keyOf/snapshot/subscribe/subscribeEntries`. It is
  an ordinary reference holder with no GC role (README 165-171). Keys are human labels, which fits
  principle 1.
- **Attach.** `thix attach` evaluates one line at a time in the workspace vat. Top-level `const` and
  `let` are scoped to a single evaluation; use `globalThis.name = v` to keep a binding. A lost
  connection reports an uncertain outcome and is never retried (README 143-149).

### 2.4 Publications and sturdy refs

- `daemon.publish(value, secret?)` returns a swissnum. A peer combines `daemon.location` (or
  `makeSturdyRefDetails(secret)`) with the swissnum into an OCapN sturdy ref (README 846-848,
  1229-1240). `unpublish` removes the locator and its root, but does not revoke references already
  fetched (`designs/thixotrope.md:491-498`). `daemon.importReference(location, secret)` fetches a
  remote publication (`daemon.js:113`).
- A publication is a GC root (README 1121).

### 2.5 Sessions

| Kind | Holder | Survives | Ref |
|---|---|---|---|
| durable | worker, remote peer, host endpoint | sockets, processes, daemon restart | README 897-899 |
| transient | `daemon.openTransientClient()`, native adapter incarnation, non-resumable peer | nothing; key prefix `transient:`, discarded at start, keys never reused | README 901-916; `designs/thixotrope.md:80` |
| view | TUI over control socket | ends with its connection; durable guest listeners unaffected | README 917-921 |

### 2.6 Workers creating workers

- The `worker-controller` resource offers `createWorker(debugLabel?)` and
  `createEphemeralWorker(debugLabel?)`, and returns a **worker facade** (`daemon.js:626-651`).
- Facade methods: `getId()`, `getEvaluator()`, `evaluate(source, endowments)`, `retire()`,
  `notifyOnStart(target)`, `clearStartNotice()` (`daemon.js:602-625`).
- **Important nuance.** `facade.evaluate` is host-mediated (`daemon.js:570-573`), so its answer is
  host-owed and *rejects on restart*. `facade.getEvaluator()` returns the guest shell itself
  ("so pending guest answers stay guest-to-guest", `daemon.js:608-609`). Use the shell for anything
  whose result may still be pending across a restart. The registry does this for install factories
  (`designs/thixotrope.md:420-422`).
- `notifyOnStart(target)` has the host call `E(target).started()` at every daemon start
  (`daemon.js:414-445, 618-622`). This is the hook for "rebuild external state after restart"
  (relevant to the dormant-after-restart requirement).
- Endowments become named arguments of a wrapper arrow. Endowment names must be identifiers, and the
  result is `harden`ed (`worker-peer.js:71-88`). **The returned value is frozen**, so never return
  mutable internal state from `evaluate`.
- Cross-worker links are recorded in session records and re-seated on restart without waking either
  worker (README 1035-1038).

### 2.7 Remote peers

- `peers.sock` is a Unix socket for same-user, same-machine peers only (README 429-436). Logical
  messages are fragmented at 1 MiB.
- `makeDurableNetLayer` wraps a base netlayer with resumable logical connections (resume tokens,
  sequenced envelopes, retransmission). It survives restarts when given the `resumption` power
  (README 1040-1085). Resume tokens are bearer secrets. The TCP transport is testing-only (README
  1084-1085).
- Known limits: unbounded retransmit buffers, dormant sessions kept forever, no session GC
  (README 1087-1090; `packages/thixotrope/designs/README.md:142-143`).

### 2.8 Native resources (the only route to OS effects)

- A native resource is a directory with two modules (README 302-323; `designs/thixotrope.md:267-340`;
  `src/native/contract.js`):
  - `durable.js` exports a synchronous `make({ makeManager, ...grants })` that returns
    `{ facet, lifecycle }` and runs in a dedicated manager vat;
  - `ephemeral.js` exports `make()` returning an adapter, which runs in a fresh Node process with
    full Node powers.
- The manager↔adapter protocol is **registration-shaped**: `bind(key, spec, epoch)`,
  `unbind(key)`, `restore([...])` (`contract.js:60-65`). Desired state is replayed into each new
  adapter incarnation. Pending external operations are never replayed (`designs/thixotrope.md:352-353`).
- The durable module receives only `makeManager` plus its grants (`src/native/manager.js:31-38`). It
  has no raw adapter handle, so **request/response or streaming operations, such as an outbound LLM
  HTTP call, do not map onto the kit directly**. See section 10.
- The adapter can call guest objects through its transient session. HTTP calls the application's
  `handle()` (README 333-335, 913-915), so callbacks from adapter to vat work.
- Shipped resources:
  - `resources/http` is a loopback HTTP server only: 64 KiB text bodies, 16 concurrent requests,
    5 s deadline (README 338-339).
  - `resources/clock` provides alarms (README 368-418).
  - `resources/control` serves the control socket.
- There is no outbound HTTP client, no process or container launcher, and no filesystem resource
  for guests.
- Install with `thix install-native DIR NAME DIRECTORY`. The bundle pair digest is the identity:
  changed source becomes a new installation, and the old one must be removed first (README 347-359).

---

## 3. What guest code may and may not do

### 3.1 Environment

- Ironhorse boot (`packages/thixotrope/scripts/bundle-ironhorse-worker.mjs:36-53`):
  - JS polyfills for `TextEncoder`/`TextDecoder`;
  - the Ironhorse prologue;
  - the SES shim;
  - `lockdown({ errorTaming: 'safe', reporting: 'none', overrideTaming: 'min' })`.
- Guests evaluate in a Compartment with frozen shared intrinsics (README 987-990).
- **Prelude globals**, the same on every engine (`src/guest/prelude.js:43-64`; README 245-252):
  `E, Far, harden, makeExo, defineExoClass, defineExoClassKit, M, matches, mustMatch, passStyleOf,
  Fail, q, makeError, makePromiseKit, makeSerialQueue, describeError, isRemotable, HEX128_PATTERN,
  assertWorkspaceName, assertInstallationName`. Bundled code destructures these off `globalThis`,
  typed with `GuestGlobals` from `@endo/thixotrope/guest.js`, and must not bundle them again.
- No ambient Node powers, filesystem, network or process access (README 248-249;
  `designs/thixotrope.md:109-111`).

### 3.2 Clock, randomness, timers

- `Date.now()` and `new Date()` throw "secure mode" in compartments
  (`packages/ses/src/tame-date-constructor.js:18-22, 44-69`). `Math.random()` throws
  (`packages/ses/src/tame-math-object.js:19-23`). Determinism requires both.
- **No timer queue.** Workers have no `setTimeout`; frame silence is exact dormancy (README 1210-1216;
  `durable-worker-transport.js:63-67`).
- Time comes from the daemon **clock** in the inventory:
  - `at(deadline)`, `after(delay)`, `arm({at}|{after})` with a canceller;
  - there is deliberately no `now()`;
  - bigint milliseconds;
  - an alarm still being armed during a crash is rejected; an armed alarm survives
    (README 388-418).
- An application that needs "now" receives it as data in a message, or through a host resource like
  the README's example timer (README 1157-1177). Host-resource answers are at-most-once.
- Entropy: only the bootstrap reads `crypto.getRandomValues`, for the OCapN client
  (`src/core/worker-peer-xs.js:40-50`). Guests get none [inferred: nothing in the prelude exposes it].
  Ids must come from the host or an adapter, as data.
- `console`, `WeakRef` and `FinalizationRegistry` are probably not available inside the guest
  compartment, because SES keeps WeakRef/FinalizationRegistry in the start compartment only
  (`packages/ses/src/permits.js:~195`) [inferred; not tested here]. Do not rely on them in guest code.

### 3.3 Promises, async, generators across restarts

- Pending promises held guest-to-guest, `.then` listeners, and `async` locals or `finally` across
  awaits persist (CI scenarios 2, 9-11, README 648-661; `designs/thixotrope.md:953-956`).
- **README conflict.** README 761-762 and `designs/thixotrope.md:563` say suspended async generators
  and `Array.fromAsync` are refused by the persistence gate. The engine's tests now say both carry:
  `rust/engine/ironhorse-snapshot/tests/persist_gates.rs:458`
  (`a_live_async_generator_persists_in_every_verb`) and `:496`
  (`a_mid_flight_array_from_async_no_longer_refuses_any_persist_verb`). Treat this as unverified for
  the shipped worker until a scenario test proves it. Until then, avoid holding a suspended async
  generator across deliveries. A refused checkpoint would block sleep and snapshot [inferred
  consequence].

### 3.4 Module loading, install, upgrade

- There is no `import()` at runtime. Code arrives in one of two ways:
  - `evaluate(source)`: expressions;
  - `thix install DIR NAME module.js grant=key...`: the CLI bundles the static module graph with
    compartment-mapper `makeBundle` (`src/platform/bundler.js:37-42`). The module must export
    `make(powers)` (README 232-273).
- **Staging is chunked** into 1,024-character `evaluate` calls (`src/core/evaluate-source.js:24-50`).
  Each chunk is one journaled delivery, so a 1 MB bundle means about 1,000 deliveries plus about 4
  cadence snapshots. The final `globalThis.eval(source)` runs in one crank under the crank budget
  (`src/control/installer.js:64-92`). A large bundle can exceed the 10 M-computron budget, which
  quarantines the vat [inferred; measure].
- Grants: only remotables from the inventory; data and promises are rejected (README 253-256). The
  same name, code and grants returns the original result. Changing anything requires `thix remove`
  plus reinstall, which retires the vat and breaks every reference into it (README 270-286).
- **No upgrade.** "This initial version provides installation, not live code upgrades"
  (README 286). Candidate designs are in `packages/thixotrope/designs/vat-replacement.md` and are
  not implemented. Production cost model decision 3 is "No backward compatibility"
  (`production-cost-model.md:52-55`).
- Factories that the supervisor ships by `fn.toString()` may reference only prelude names, because
  module-level bindings are `undefined` in the vat (`designs/thixotrope.md:142-144`;
  `prelude.js:29-36`).

### 3.5 Limits

Daemon-wide limits, set through environment variables. There are no per-vat overrides
(README 712-753; `packages/thixotrope/designs/ironhorse-limits.md`):

| Setting | Default | Max | Notes |
|---|---|---|---|
| crank budget | 10,000,000 computrons | 2^64-1 | per delivery; exceeding it quarantines |
| bootstrap budget | 1e9 | 2^64-1 | trusted boot only |
| slot ceiling | 1,000,000 records | 44,739,242 | lifetime arena; may only increase |
| chunk ceiling | 256 MiB | 512 MiB | lifetime arena; may only increase |
| request watchdog | 60 s | 2^31-1 ms | per worker request |

Separate engine limit: property-key space is exhausted at about 1.05 M keys
(`ironhorse-limits.md:74-77`).

- **Strings are quadratic in Ironhorse.** "Ironhorse's current text decoder copies every prefix of
  a message, so a single message costs the square of its length in scratch heap: at the default
  256 MiB chunk ceiling the crank halts a little under sixteen thousand characters"
  (`src/core/evaluate-source.js:5-9`). The decoder is the JS polyfill
  `rust/endo/xsnap/src/polyfills.js:106-160`, which builds the string with `out += String.fromCharCode(...)`
  per code point (`:156`). Read literally, **any string in one OCapN message larger than about
  16 k chars can halt (quarantine) the receiving vat**. This conclusion is drawn from the code and
  comments and is **not measured here**. It is the single most important performance check to run
  for a harness that carries prompts, transcripts and tool output.

### 3.6 Synchronous vs eventual calls

- Within a vat, calls are ordinary synchronous JS. Across vats, use `E(x).m()` only; every result is
  a promise (`designs/thixotrope.md:111`).
- A cross-vat round trip goes guest → hub → guest and back, with journal fsync, crank, GC and a
  `hub.json` rewrite at each hop. Measured mail sends were 130-420 ms median, with outliers of
  1.6-19 s (`packages/thixotrope/designs/mail-latency-colocated.md:10-11`;
  `packages/thixotrope/designs/mail-performance-plan.md:157-176, 268-271`). The provisional 50-100 ms
  target is unmet (`mail-performance-plan.md:174`).

### 3.7 Streaming and async iterators across vats

- OCapN cannot pass an async iterator. Model a stream as remotable objects:
  - a pull form, `E(stream).next()`;
  - a push form, `E(sink).push(batch)`.
  `observable-map.js` is the in-tree pattern: one outstanding notification per listener, coalesced
  latest snapshot, plus `subscribeEntries` for incremental changes (`src/observable-map.js:8-19`;
  README 193-199). The mail UI's browser bridge layers SSE on top
  (`src/web/mail-ui-subscription.js`, README 561-566).
- Each push or pull costs one delivery per hop (section 3.6). Each 256 deliveries also triggers a
  snapshot. Token-by-token streaming through a durable vat is therefore a non-starter.

### 3.8 Binary data

- `byteArray` (immutable ArrayBuffer) is a pass style encoded as syrup bytes
  (`packages/ocapn/src/codecs/passable.js`). XS needs a hand-written emulation
  (`src/ironhorse/boot-immutable-arraybuffer-xs.js.txt`).
- On the duct, every frame is base64 inside JSON, decoded in-guest by JS `decodeBase64`
  (`src/core/worker-peer-xs.js:61-91`), and journaled as base64 (`durable-worker-transport.js:314-320`).
- Expect binary such as audio or images to be expensive and heap-bound. Keep large blobs in
  adapters or a host CAS and pass handles [inferred; measure].

---

## 4. Retirement, GC, retention

- `retire()` on a worker or facade is permanent. The session aborts, publications drop, the store
  and snapshot are deleted, launched adapter processes close, and old references meet tombstones
  (README 1092-1099; `designs/thixotrope.md:545-548`). Other sessions' answer routes toward the
  retired session are broken and released (`hub.js:1950-1975`; `production-cost-model.md:266-285`).
- `daemon.collectVats({keep})` and `thix collect` mark from these roots: publications, awake
  workers, `keep`, remote sessions (attached or not), pending host operations, gifts. They mark along
  cross-session references and worker facades and retire the rest (README 1101-1133;
  `src/core/vat-reachability.js`).
- `inspectReachability` and `thix reachability` explain retention at vat level, not heap level, and
  do not wake guests (README 1109-1144).
- Import GC inside vats depends on the engine's `WeakRef`/`FinalizationRegistry` (#1446). The worker
  sweeps after every crank and runs finalizer callbacks before outbound is taken, so `op:gc-*`
  frames ride with the delivery (README 1000-1007; `production-cost-model.md:296-339`). A gc frame is
  sent only on collection, never on settlement (`production-cost-model.md:42-46`).
- Caveats:
  - dropping a reference does not free the vat until guest GC reports it; idle-sleep and inspect
    again (README 1137-1142);
  - registered host resources that internally retain workers need an explicit `keep` (README 1143-1144);
  - 5,384 export tombstones held by workers were still unexplained (`production-cost-model.md:337-339`).

---

## 5. Concurrency model

- **Single-threaded per vat, one crank at a time.** The transport serializes deliveries, wake, sleep,
  crash and retirement on one queue (`durable-worker-transport.js:44-49, 121-124, 175-190`). A
  delivery runs the guest to quiescence under the crank budget and the 60 s watchdog.
- **Many vats, one host thread.** All journal fsyncs and `hub.json` rewrites are synchronous in the
  single Node supervisor (`sync-files.js:40-66`). Every vat's I/O serializes there [inferred: no
  worker threads in the host].
- **A vat cannot block or poll.** Long work is a chain of deliveries. The guest sends a request,
  returns, and is woken by settlement or callback frames. Between frames the vat may be put to sleep
  after 30 s idle, and the next frame wakes it (wake = image copy + replay; the production average
  was 40 s per wake *before* fixes 1.1/2.1, `production-cost-model.md:21`).
- **A minutes-long streaming LLM turn should be structured as follows:**
  1. A native adapter (Node) owns the HTTP stream, the parser and the deadlines.
  2. Live tokens go adapter → UI on an ephemeral path that never enters a durable vat.
  3. The durable session vat receives *coalesced* deltas, for example one per sentence, tool-call
     boundary, or about 1 s, and the final assistant message, each as one call.
  4. The adapter awaits each `E(sink).push(...)` answer before sending the next, which gives
     natural back-pressure.
  5. A restart mid-turn rejects the host- or adapter-owed answer. The guest's `started()` hook or
     rejection handler records "turn interrupted" and decides whether to resume. Nothing is
     replayed automatically.
- **Back-pressure in the platform is weak.** There is no OCapN flow control, remote retransmit
  buffers are unbounded, and each host→worker frame is a delivery (README 1087-1090, 1271-1274). The
  rule is to batch into one message (README 1271-1274; `production-cost-model.md:403-422`: "give a
  Thixotrope chat one or two powers, not the root set").
- Use `makeSerialQueue` (prelude) to serialize turn processing inside a session vat.

---

## 6. Prior art: a hosted chat already ran on Thixotrope

`production-cost-model.md:10-33` describes an operator who ran "a hosted chat application" on this
branch for five days: 67 workers, one user. Their findings bear directly on this build:

| Finding | Status |
|---|---|
| `hub.json` grew to 11.5 MB; 2.95 TB written | fixed by import GC under Ironhorse |
| delivery average 2.4 s | before fix 1.1 |
| snapshot 6.7 s; wake 40 s | snapshot cost remains, since it is a whole-DB copy |
| a never-idle worker replayed 3,744 entries (30 min) | fixed by 2.1, the 256 cadence |
| a 73-power endowment sent in about 650-byte frames took 20 min | still a cost; send one message |
| "a cancelled turn left the chat's guest refusing every later program" | application bug (their bd-1992) |
| the host could not tell slow from dead | 2.2 deferred: control socket absent while warming |

---

## 7. Public JS API

Exports (`packages/thixotrope/index.js:10-15`; `package.json` `exports`: `.`, `./native-adapter.js`,
`./node-powers.js`, `./guest.js`):

| Export | Signature / members | Notes |
|---|---|---|
| `makeThixotropeDaemon(powers, opts)` | `opts: { store, engine, codec, makeNetlayer, resources?, idleSleepMs?, snapshotEveryDeliveries?, verbose? }` | README 1210-1216 |
| daemon `.createWorker` | `({debugLabel?, ephemeral?, allocationKey?}) → Promise<WorkerAdmin>` | README 1218-1221 |
| daemon `.getWorker(id)` / `.listWorkerIds()` | admin/debug, by id | README 1222-1224 |
| daemon `.makeResource(name, {workerId?, key?})` / `.retireResource` | interned host resources; built-ins `worker-controller`, `worker-facade`, `native-adapter` | README 1179-1199; `daemon.js:686-690` |
| daemon `.publish(value, secret?)` / `.unpublish` / `.lookup` | swissnum publications | README 1229-1232 |
| daemon `.importReference(location, secret)` | fetch a remote publication | `daemon.js:113` |
| daemon `.openTransientClient()` | disposable reifying host client | README 901-911 |
| daemon `.collectVats({keep})` / `.inspectReachability({keep})` | vat GC | README 1101-1133 |
| daemon `.sweepBundles(keep)` | free stored bundles | README 1235-1238 |
| daemon `.location` / `.makeSturdyRefDetails(secret)` | sturdy-ref minting | README 1239-1240 |
| daemon `.shutdown()` / `.crash()` | sleep all / simulate power loss | README 1241-1244 |
| WorkerAdmin | `workerId, debugLabel, evaluate(src, endow?), sleep(), wake(), isAwake(), retire(), notifyOnStart(t), clearStartNotice()` | `daemon.js:587-598` |
| `makeIronhorseEngine(powers, {workerBinary, bootPaths, storePath, crankBudget?, bootstrapBudget?, slotCeiling?, chunkCeiling?, requestTimeoutMs?})` | default engine | README 681-689; `ironhorse-engine.js:42-60` |
| `makeXsEngine(powers, {workerBinary, bootPath, bundlePath, casPath})` | alternative engine | README 828-834 |
| `makeFsStore(powers, path)` | durable store | README 828 |
| `makeDurableNetLayer(powers, {handlers, logger, resumption, makeBaseNetlayer})` | resumable peer sessions | README 1055-1064 |
| `inspectIronhorseStore(path)` | read-only offline inspection | README 785 |
| `native-adapter.js` `makeAdapter({label, bind, unbind, resolve?})` | ephemeral half of a native resource | `designs/thixotrope.md:302-305` |
| `node-powers.js` `makeNodePowers()` | platform powers | README 823-825 |
| `guest.js` | type `GuestGlobals` only | `guest.js:1-8` |
| guest-visible facade (`worker-controller`) | `createWorker(label?)`, `createEphemeralWorker(label?)` → facade `{getId, getEvaluator, evaluate, retire, notifyOnStart, clearStartNotice}` | `daemon.js:602-651` |

The CLI is `bin/thix.js`, with commands `serve, attach, status, stop, workspaces, create-workspace,
inventory, install, install-native, installations, remove, alarms, reachability, collect, invite,
accept, contacts, send, mail, inbox, outbox, revoke-invite`. The control-admin methods are listed
at `supervisor.js:605`.

---

## 8. Caveats from the README and design docs

1. Prototype: experimental, local, single supervisor (README 755, 1259).
2. Host-owed answers reject after restart (README 1201-1203, 1261-1263).
3. A listen on the sender's own export breaks; pipelining onto an undeposited gift breaks
   (README 1263-1266).
4. Every host→worker frame is a delivery, so send large endowments as one message (README 1271-1274).
5. There are no live code upgrades. Changes to supervisor-shipped closures require a fresh state
   directory (README 420-425).
6. Slot and chunk ceilings may only increase. Lower budgets only after a clean shutdown, because
   replay runs under the current budget (README 741-749).
7. Remote retransmit buffers are unbounded; dormant sessions are never GC'd; TCP is testing-only
   (README 1084-1090).
8. Unix socket path is limited to 103 bytes (`sun_path`), so keep the state directory path short
   (README 488-491).
9. Lock files must never be unlinked (README 759). Run under systemd `KillMode=mixed` (README 133-134).
10. Whole-image copy on every sleep and wake (`designs/thixotrope.md:562`).

## 9. Caveats found in code, not stated in the README

1. **Quadratic string decode in Ironhorse; a single message over about 16 k chars may halt the vat**
   (`src/core/evaluate-source.js:5-9`; `rust/endo/xsnap/src/polyfills.js:156`). Not measured.
2. **Full GC after every crank** (`main.rs:185-190, 240-270`), so per-delivery cost grows with heap
   size. A large transcript held in a vat taxes every message to that vat [inferred; measure].
3. **Synchronous fsync on the shared host thread** for every journal append and every `hub.json`
   rewrite (`sync-files.js:40-66`; `store-fs.js:229-235`).
4. **Bundle staging is about 1 delivery per KB** (`evaluate-source.js:32-41`), and the final eval
   is one budgeted crank.
5. **`facade.evaluate` is host-owed (it rejects on restart); `getEvaluator()` is not**
   (`daemon.js:570-573, 608-615`).
6. **`evaluate` results are hardened (frozen)** (`worker-peer.js:76, 87`).
7. **The README is stale about async generators** (section 3.3).
8. **The native-resource kit only does registrations.** Durable modules receive no raw adapter
   handle (`src/native/manager.js:31-38`; `contract.js:24-27`).
9. The control socket is absent until warm-up finishes (`production-cost-model.md:253-264`).

---

## 10. Implications for building an agent harness

### Do

- **One durable vat per long-lived agent session or space.** Keep the model-and-tool loop, the
  transcript index and the session state *inside that vat* as ordinary JS. Cross vats only to use a
  capability. Each cross-vat hop costs about 100-400 ms plus fsyncs (section 3.6).
- **Put every external effect in a native resource adapter**: LLM provider HTTP and streaming,
  container exec, git, filesystem, secrets fetch, TTS/STT. The adapter owns sockets, buffers and
  deadlines. The durable side keeps only *desired state* and *outcomes*.
- **Plan a new native resource kit shape for operations**, such as a Thixotrope-side extension for
  a request/stream operation handle, or an adapter-pulls-work pattern. The current kit is
  registration-only. Apply the generation rule: an old operation must never reach a replacement
  adapter (`designs/thixotrope.md:316-322`).
- **Tee streams.** Send live tokens adapter → UI ephemerally. Send the durable vat coalesced deltas
  and final messages, and await each push for back-pressure.
- **Keep big text and binary out of vat messages.** Pass strings of at most a few KB per message, or
  keep large blobs (tool output, images, audio, transcripts for export) in an adapter-side or host
  CAS and hand the vat a remotable handle or digest. Re-check after measuring the decoder; if it is
  confirmed quadratic, fix the polyfill (`rust/endo/xsnap/src/polyfills.js`) with array+join.
- **Make every interrupted external operation visible.** On restart, a host- or adapter-owed answer
  rejects. Catch it, record "interrupted", and stay dormant until the user acts. Use
  `notifyOnStart(target)` for the start hook. This matches the owner's dormant-after-restart
  decision.
- **Use guest shells (`getEvaluator`) and guest-to-guest promises** for results that may outlive a
  restart. Use `facade.evaluate` only for one-shot admin.
- **Pass objects.** Facades, contact objects, sinks and handles, never worker ids or inventory keys.
  Inventory keys are human labels only (principle 1). This model fits well: workers have no names
  (README 30-36), and mail takes contact objects (README 522-549).
- **Design for no upgrade.** Keep behaviour thin and state as plain data behind a small, stable
  facade. Prepare an explicit export/import (snapshot-to-data) path per session so a new code
  version can rebuild a vat from data. Expect to `thix remove`/reinstall, and to start from a fresh
  state directory whenever shipped closures change.
- **Batch endowments and configuration into single messages.** Give a session vat few powers, for
  example one "tools" facade, rather than dozens (`production-cost-model.md:420-422`).
- **Feed nondeterminism in as data**: time, ids, randomness from the host or an adapter. Use the
  clock resource for timeouts and reminders (`after(delay)`).
- **Watch per-vat heap.** The chunk ceiling maximum is 512 MiB, and a full GC runs per crank. Cap
  transcript retention in the vat (bounded retained state, not lifetime caps, per the owner's
  rule 1248).
- **Use serial queues** (`makeSerialQueue`) for turn processing, and cancellation records per turn.
  A cancel must free the session at once (lesson from bd-1992).

### Don't

- Don't stream tokens one delivery at a time into a durable vat. 256 deliveries trigger a
  whole-heap snapshot.
- Don't hold OS-resource proxies, request closures or socket state in durable vats. Use an adapter,
  or `createEphemeralWorker` for guest-side scratch state that should die at restart.
- Don't use `Date`, `Math.random`, `setTimeout`, `console` or dynamic `import()` in guest code.
- Don't rely on suspended async generators across deliveries until verified (section 3.3).
- Don't assume a connection error means "did not run". Treat a sent call as possibly processed
  (`packages/thixotrope/designs/README.md:62-66`). Retries need application idempotency keys.
- Don't install huge bundles, and don't bundle prelude libraries. Keep guest code small. Provider
  SDKs belong in adapters, where Node resolves imports normally.
- Don't lower slot or chunk ceilings, and don't lower budgets except after a clean shutdown.
- Don't expect the control socket while the supervisor warms; back off on `ECONNREFUSED`.
- Don't build Forgejo, proxy, NixOS or browser-relay equivalents (out of scope, principle 2). The
  loopback HTTP resource and the mail-UI bridge pattern (`src/web/mail-ui-service.js`) are enough
  for a local chat UI shell.

---

## 11. Performance checks to run first

1. **String size per message into an Ironhorse vat.** Find the halt point and the per-KB cost at
   1 k, 4 k, 8 k, 16 k and 64 k chars, at the default and the 512 MiB chunk ceiling. This decides
   the transcript and tool-output design.
2. **Delivery cost against heap size.** Measure the per-crank GC cost with a vat holding 1, 10 and
   50 MB of transcript text.
3. **Snapshot and wake time against heap size** (whole-DB copy).
4. **Coalesced streaming.** Run N pushes per second through adapter → vat for a 3-minute turn, and
   record the snapshot pauses.
5. **Bundle install time and crank budget** for a realistic harness bundle (100 KB-1 MB).
6. **Cross-vat round trip** (session vat ↔ tool vat) and the `hub.json` size after a day of
   simulated use.
7. **Startup and warm time** with about 50 session vats.
