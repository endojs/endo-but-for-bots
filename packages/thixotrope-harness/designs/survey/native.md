# How Thixotrope reaches the outside world (native resources, engines, limits)

Survey for the Endo harness build. Work tree: `/Users/xyz/Development/endo-thixotrope-harness`
(branch `claude/thixotrope-harness`, HEAD `48d6f3e08b`). Paths are relative to
`packages/thixotrope/` unless they start with `rust/` or `/`. Guesses are marked [inferred].
Measurements were taken on this Mac (16 cores, load average about 4 from other survey agents
running Ironhorse at the same time), with the release Ironhorse worker that is already built at
`target/release/thixotrope-ironhorse-worker`. The probe scripts are next to this file:
`perf-native.mjs`, `perf-engine.mjs`, `perf-engine3.mjs`, `perf-engine4.mjs`, `fetch-lockdown.mjs`,
with logs `perf-engine3.log` and `perf-engine4.log`. All state they created has been deleted.

## 0. Headline findings (read this first)

1. **Strings above about 12–16 K characters cannot enter a vat in one message.** If a vat gets one,
   its crank stops with `HeapExhausted`, the vat is **quarantined permanently**, and everything
   that holds a reference to it gets "ocapn hub: the target session has been retired".
   Measured: a 2 KB string argument took 318 ms, 8 KB took 1.4 s, 12 KB took 2.1 s, and 16 KB
   halted the vat (`perf-engine4.log`, `perf-engine3.log`). The cost grows with the square of the
   length.
   The code already says this: `src/core/evaluate-source.js:5-10` ("a single message costs the
   square of its length in scratch heap: at the default 256 MiB chunk ceiling the crank halts a
   little under sixteen thousand characters"). The installer works around it by sending source
   in 1024-character chunks (`src/core/evaluate-source.js:32-41`).
   The cause is the pure-JS `TextDecoder` polyfill in the worker boot
   (`dist-ironhorse/boot.js:107-140`, which builds the result one character at a time; its source
   is `rust/endo/xsnap/src/polyfills.js`, read through
   `@endo/ironhorse-prelude/codec-polyfill.js` by `scripts/bundle-ironhorse-worker.mjs:8,35`).
   Ironhorse does not collect garbage inside a crank (`rust/engine/README.md`, "Garbage
   collection": only when `Interp::is_quiescent()`), so every intermediate string stays alive.
   This is the biggest single incompatibility with an agent harness. Model replies, tool outputs,
   file contents and transcript pages often exceed 16 KB. The shipped HTTP resource accepts
   64 KiB request bodies and hands them to a vat as one string (`resources/http/ephemeral.js:63,70-71`),
   so a POST of more than about 15 KB would quarantine the application vat [inferred from the
   measured limit, not run end to end].
2. **One delivery to a warm vat costs about 100–300 ms.**
   Measured: host to warm vat `E(t).ping()` p50 190 ms (min 118 ms); 20 pipelined pings took
   3.8 s, so deliveries to one vat run one after another; control-socket `evaluate('1')` in the
   workspace vat p50 560 ms; an HTTP request through the native adapter into a vat handler and
   back p50 128 ms, p95 158 ms; `clock.after(0n)` from the workspace (three vat hops plus the
   process) p50 989 ms.
   A token-by-token stream through vats is therefore not feasible. Streams must be grouped into
   batches (hundreds of ms or several KB per delivery) or kept out of vats completely.
   The production report on this branch measured "115,872 deliveries averaging 2.4 s" for a hosted
   chat app before its fixes (`designs/production-cost-model.md:17-24`).
3. **The crank budget allows about 600 K simple loop iterations.** At the default 10 M computrons
   (`src/ironhorse/ironhorse-limits.js:46`), a loop of 600 K iterations passed and one of 1 M
   stopped with `MeterAbort`. Summing a 1 MB `Uint8Array` stopped with `MeterAbort`. Building
   320 KB by `+=` in 8000 steps stopped with `HeapExhausted` (2000 steps passed). Any of these
   **quarantines the vat for good** (README.md:704-711: "records a failure in worker metadata, and
   retires the logical comms session"; "Failed vats do not replay the same poison input").
   Parsing, SSE framing, base64, image handling and large JSON must happen in native (Node)
   adapters, not in vats.
4. **No resource exists for outbound HTTP, child processes, the filesystem, secrets or
   WebSocket.** The package ships three native resources: `resources/http` (inbound loopback
   HTTP), `resources/clock` (alarms) and `resources/control` (the admin socket). Every harness
   need except timers needs a new native resource. All of them can be installable native
   resources, with no change to Thixotrope core. Two small kit additions would make one-shot
   operations and streaming cleaner (section 3.0).
5. **The adapter half of a native resource is unconfined Node.** It has the full OS authority of
   the daemon's user, including read access to every vat heap and journal. Only the operator can
   install one (`thix install-native` over the control socket). This matches the spec's
   "unconfined caplet". The durable half runs confined in a vat.
6. **Ironhorse is the only engine the supervisor can run.** The XS engine has no
   `acquireStore`, which the supervisor requires (`src/control/supervisor.js:203-204`). It has
   no metering. Its `c/moddable` submodule is empty here, and its binary is not built. It is a
   test alternative only.

## 1. The resource model

There are two mechanisms. A harness builder should use the second.

### 1.1 Host resources (daemon-internal, in-process)

- These are makers registered with the daemon by the embedder: `makeThixotropeDaemon(powers, { resources })`
  (`src/core/daemon.js:148,167`; README.md:1151-1206). The supervisor registers `installer`,
  `installation-index` and `control-admin` (`src/control/supervisor.js:356-380`). The daemon adds
  `native-adapter`, `worker-facade` and `worker-controller` (`src/core/daemon.js:686-690`).
- `daemon.makeResource(name, { workerId, key })` interns an instance. When the instance is
  exported into a worker, its name and binding are recorded against the export slot and
  re-instantiated at the same slot on restart, so presences in the vat's heap keep working
  (README.md:1179-1196). A resource bound to a worker is retired with that worker.
- Answers the daemon itself owes are at-most-once: a resolver pending across a restart rejects
  (README.md:1201-1204).
- These run inside the supervisor process. Adding one means editing `src/control/supervisor.js`,
  which is a core change. **Do not use this for harness features.**

### 1.2 Native resources (installable; the right tool)

Contract: `src/native/contract.js:1-105`; design: `designs/native-resource-installation.md`;
README.md:288-366.

- **Definition.** A directory holds `durable.js` and `ephemeral.js`, and both must be files, not
  links (`src/native/locate-resource.js:32-44`).
  - `durable.js` exports a synchronous `make({ makeManager, ...grants })`. It runs **once** in a
    dedicated manager vat, with only the guest prelude as globals, and returns
    `{ facet, lifecycle }` (`src/native/manager.js:18-62`; `contract.js:24-37`).
  - `ephemeral.js` exports `make()` and returns the adapter root. It runs in a fresh Node process
    each time the manager needs an adapter (`contract.js:16-20,39-41`). It usually builds the root
    with `makeAdapter({ label, bind, unbind, resolve? })` from `native-adapter.js`
    (`src/native/adapter-kit.js:50-154`).
- **Installation.** `thix install-native STATE NAME DIR` bundles both modules. The ephemeral
  module becomes a CommonJS functor in which only Node builtins remain live `require` exits
  (`src/platform/bundler.js:44-53`). The ephemeral bundle is stored as `bundles/<sha256>.cjs`.
  The installation's identity is the pair of bundle digests, and the directory is never read
  again (README.md:355-366; design "Installation identity").
  - The ephemeral module can import npm packages, which are frozen into the bundle [inferred:
    nothing in the shipped resources does this]. A default import of a builtin has no binding;
    import builtins by name or as a namespace (README.md:361-364).
  - Packages with native addons (`.node`) cannot be bundled [inferred].
- **Granting.** The facet goes into the workspace inventory under NAME (README.md:290-297), and
  an application gets it with `thix install STATE app ./app.js http=web`.
  - After that the application holds the facet as an object, which fits the owner's "pass
    objects" principle. The name appears only at the CLI boundary.
  - A native durable module can itself receive grants and host-provided powers by name; the
    control resource gets `admin` this way (`src/control/supervisor.js:1003`;
    `src/native/manager.js:15-17,31-39`).
- **The manager kit** (`src/native/manager-kit.js:63-307`). This is a desired-state reconciler.
  - `register(key, spec)` stores `{spec, epoch}` in the vat heap and reconciles it against the
    adapter with `bind(key, spec, epoch)`. It returns a `RegistrationHandle` with
    `status()`/`close()` (lines 210-292).
  - `close` withdraws the durable record first, then unbinds; if the unbind is uncertain, it
    retires the whole process (lines 225-254).
  - `lifecycle.started()`/`exited()` rebuild the adapter and `restore` every desired registration
    (lines 139-172, 302-305).
  - A spec must be data plus the manager's own remotables, because it outlives the process
    (`contract.js:51-58`).
  - The durable module never sees the adapter itself: the keeper is bound inside the kit
    (`src/native/manager.js:33-39`).
- **Process.** `makeNativeAdapters` (`src/native/adapters.js:43-293`) forks
  `src/platform/node/adapter-process-entry.js` through `child_process.fork`, with stdout ignored,
  stderr inherited and a 30 s startup timeout (`src/platform/node/adapter-processes.js:20-70`).
  - The child runs `@endo/init` (SES lockdown) (`adapter-process-entry.js:2`), checks the bundle
    digest (lines 32-37), `require`s the bundle (line 38), calls `make(harden({}))` (line 41), and
    serves the root over OCapN.
  - Frames travel as base64 inside JSON over the Node IPC channel
    (`adapter-process-entry.js:20-26`; `adapter-processes.js:96,110`).
  - The process is a transient hub session, `transient:native:<random>`, attached with
    `discardOnRestart: true` (`adapters.js:138,211-218`).
  - If an adapter exits on its own, its owner is notified after a backoff. A life of 10 s or more
    counts as long and is reported at once; quick exits double the delay from 1 s up to 30 s
    (`adapters.js:20-22,74-96`).
- **What survives a restart.**
  - Survives: the manager vat's heap (desired registrations, epochs, handles), the consumer vats'
    heaps, and the facet references.
  - Does not survive: the adapter process, its sockets, timers and buffers, and any pending call
    into it.
  - At start the host calls `lifecycle.started()`, which builds a new process and restores the
    registrations. For example, HTTP listeners come back on the same ports (README.md:340-345),
    and alarms re-arm with past deadlines firing at once (README.md:401-411).
- **In-flight operations across a restart or adapter death.**
  - When a native session is forgotten, the hub runs `retireSessionInternal` (`src/net/hub.js:1892-1950`).
    It tombstones the process's exports and breaks pending listens with "ocapn hub: the target
    session has been retired" (`hub.js:1947`).
  - A vat awaiting `E(adapterObject).x()` sees a rejection; nothing is replayed into the new
    process (design: "nothing pending is replayed into it").
  - An HTTP request in progress loses its TCP connection. "Already accepted calls into durable
    application vats may still complete" (README.md:344), but the answer goes nowhere.
  - An alarm still being armed is rejected rather than retried (README.md:411-413).
  - So a model stream in progress at a restart is lost mid-stream. The harness must record
    "interrupted" durably and resume or replay at the application level, as the Endo harness
    does.
- **How results re-enter the heap.** An adapter calls a remotable in a vat, for example
  `E(handler).handle(req)` (`resources/http/ephemeral.js:70-71`) or `E(spec.sink).fire(key, now)`
  (`resources/clock/ephemeral.js:52-54`), or answers a vat's call.
  - Either way the data arrives as an OCapN frame. The transport appends it to the vat's
    `journal.jsonl` with fsync before delivery (`designs/production-cost-model.md:57-76`), so a
    nondeterministic source stays replayable.
  - Each such frame is one delivery: one crank, under the crank budget and the string limit of
    section 0.
  - In-heap state needs no serialization. A snapshot is taken every 256 deliveries or when the
    vat is idle (`src/control/supervisor.js:141-142`).
- **Gaps in the kit for harness work.**
  - (a) No one-shot operation verb. The kit models long-lived registrations, so a request/response
    call (fetch, exec, git) has no direct path from the durable facet to the adapter.
  - (b) No collection hook: when a durable handle is dropped, nothing is released in the adapter
    or on disk. This is designed but not built (`designs/host-managed-resources.md` section 9).
  - (c) `restore` re-binds every desired registration after a restart. That is wrong for
    non-idempotent work unless the spec says "already started" (section 3.0).

## 2. Existing resources

| Resource | Interface | Limits / behaviour | Streaming | Binary | WebSocket |
|---|---|---|---|---|---|
| `resources/http` | facet `register(port, handler, policy?)` → handle `status()/close()` (`durable.js:72-93`); app implements `handle({method, path, body})` → `{status, body}` | ports 1024–65535 (`durable.js:81-82`); bound to `127.0.0.1` only (`ephemeral.js:62`); body ≤ 64 KiB, response ≤ 64 KiB, headers ≤ 16 KiB, 16 concurrent requests (others get 503), 5 s deadline, keep-alive 1 ms (`ephemeral.js:60-69`); Host/Origin/Sec-Fetch-Site checks (`ephemeral.js:28-49`); request **headers are not passed** to the handler (`ephemeral.js:70-71`); **every response is `text/plain; charset=utf-8` with `connection: close`**, because success also goes through `reject()` (`listener.js:44-51,83-93,161`); body must be valid UTF-8 or the request gets 400 (`listener.js:138-144`) | none: whole body in, whole string out | none: string bodies only | refused: `upgrade` and `connect` sockets are destroyed (`listener.js:199-200`) |
| `resources/clock` | `at(deadline)`, `after(delay)`, `arm({at}|{after})` → canceller, `status()` (`clock/durable.js:41-57`) | bigint Unix ms; a delay is resolved to a deadline at arm time and adopted (`clock/ephemeral.js:36-45,77-79`); re-arms past the 2^31-1 ms timer limit (`clock/ephemeral.js:14,47-61`); **no `now()`** (README.md:391); no recurrence (README.md:418); measured `after(0n)` round trip from the workspace p50 989 ms | n/a | n/a | n/a |
| `resources/control` | the operator's admin socket `control.sock`; one OCapN session per connection from `E(admin).connect()` (`designs/host-managed-resources.md` 8.2) | admin only | n/a | n/a | n/a |
| (not a resource) `src/platform/node/mail-ui-server.js` | a control-socket **client** process serving a browser UI with SSE (`text/event-stream`, line 72) from subscriptions (`src/web/mail-ui-subscription.js`) | precedent for "gateway is a host-side client of the daemon", run by `scripts/mail-ui.mjs` | SSE | — | no |

There is no fetch, filesystem, process, git, secret or WebSocket resource.
Platform powers for files, processes and sockets exist (`src/platform/{files,processes,sockets}.js`;
Node versions in `src/platform/node/`). Only host code uses them: they are not exposed to guests,
and the ephemeral `make()` receives `{}`. An adapter imports `node:*` directly instead.

Fit with the owner's object-passing principle: good. Handlers, sinks and handles are objects; the
resource never asks for a name or id from a guest. The only text keys are a port number (a
URL/config boundary) and the alarm's internal random key.

## 3. What each harness need requires

### 3.0 Shared patterns (decide once)

- **One-shot operations** (fetch, exec, git, fs read/write).
  - Option A, no core change: the durable module registers a single "service" key whose spec
    carries a manager-owned `sink` exo. The adapter's `bind` calls `E(spec.sink).attach(opsFacet)`,
    and the durable facet forwards operations to the current `opsFacet`. After a restart,
    `restore` re-attaches a new one. Calls in flight reject with "target session has been
    retired". The trade-off: the manager vat holds a reference into a transient process.
  - Option B, a small change to `src/native/manager-kit.js` and `src/native/manager.js`: expose
    `operate(fn)` = `keeper.provide()` then `E(adapter)...`, with at-most-once semantics.
    About 40 lines plus tests. **Recommended.**
- **Streaming into vats.**
  - The adapter pushes `E(sink).chunk(text)` batches, or the vat pulls with `E(stream).next()`.
  - Each delivery costs about 100–300 ms and must stay **well under 8 KB** of string at today's
    decoder. Group events by time (about 250–500 ms) and size.
  - Async generators that suspend across deliveries are refused by the persistence gate
    (README.md:761-762). A vat-side `for await` over a remote stream must therefore be written as
    explicit `next()` promise chains, not async generators.
- **Keep heavy and streaming paths out of vats.** SSE parsing, tool-call JSON assembly, base64,
  audio and file bytes belong in Node adapters. Vats should receive coarse, already-parsed
  records, and the browser should get token streams from the gateway process (3.2) directly.
  The vat is the system of record (transcript, session state), not the data path.
- **Fix the decoder in the engine boot (Thixotrope repo, outside core daemon logic).** Replace
  the O(n²) `TextDecoder.decode` in `rust/endo/xsnap/src/polyfills.js`: decode in slices with
  `String.fromCharCode.apply` and join.
  - This changes the boot digest, so heaps from the old runtime are refused (README.md:770-790).
    That is acceptable before production.
  - Size: small to medium. **It lifts the 16 KB ceiling and should be the first task.**
  - Raising `THIXOTROPE_CHUNK_CEILING` to its 512 MiB maximum buys only about 1.4×, because the
    cost is quadratic (README.md:731).

### 3.1 Outbound HTTPS with streaming responses (model providers, SSE)

- **Status:** nothing exists.
- **To add:** a native resource `resources/fetch`. Global `fetch` works in the adapter process
  under SES lockdown on Node 22.23.4: a streamed SSE body arrived as 5/5 events, abort raised
  `AbortError`, and a refused connection gave `fetch failed`, although `e.cause` was not
  readable (`fetch-lockdown.mjs`).
  - The test suite warns that Node 24's fetch cleanup breaks under lockdown
    (`test/_http-integration.js` comment before `request`). Pin Node 22 or use `node:https`.
- **Shape:** a durable facet `request({ url, method, headers, body, credential? })` → a response
  object with status and headers plus a batched `next()` stream, or a `sink` the adapter pushes
  batches to.
  - Provider SSE parsing and tool-call delta assembly should run in the adapter. A provider
    adapter per backend, returning parsed events, fits much better than raw bytes.
- **Restart:** a stream in flight is lost (section 1.2). The session must record the partial
  reply durably as it arrives, in batches, and mark the turn interrupted.
- **Effort:** medium for a generic fetch with batched streaming, plus medium for provider
  adapters. No core change, or option B.

### 3.2 Inbound HTTP/WebSocket gateway for the browser chat UI

- **Status:** `resources/http` is unusable as a chat gateway. It has no WebSocket, no request
  headers in the handler, a fixed text/plain response, a 5 s deadline, 64 KiB limits, 16
  concurrent requests, loopback only, and one vat crank per request (about 130 ms).
- **To add:** a new native resource `resources/gateway`, with a Node server in the adapter that
  does WebSocket upgrade (or SSE plus POST).
  - `ws` is in the tree as a dependency of `packages/ocapn` (`packages/ocapn/node_modules/ws`;
    used by `packages/ocapn/src/netlayers/websocket.js:4`), not of thixotrope.
  - Bundling `ws` into the CJS functor is untested; its optional `bufferutil`/`utf-8-validate`
    requires may trouble the bundler [inferred]. A hand-written RFC 6455 frame layer over
    `node:http` `upgrade` plus `node:crypto` is about 200 lines.
- **Shape:** a registration per listener (port, origin policy, handler or session-router object).
  Authentication (bearer token or cookie) is checked in the adapter, as `mail-ui-server.js` does.
  Per-connection state stays in the adapter. Messages go to vats as parsed records, and
  token/delta streams fan out to sockets inside the adapter, never through a vat.
- **Restart:** sockets drop and clients reconnect. The UI must resubscribe and re-read the
  durable transcript from the vat. This matches the memory note "Floot UI subscribes; daemon owns
  the queue".
- **Effort:** medium to large. Installable, with no core change.

### 3.3 Static asset serving on a separate origin

- **To add:** an adapter-served static file server on its own port or host: a registration of
  `{port, routeTable}`, with files read from disk by the adapter and no vat on the request path.
  - The current HTTP resource cannot serve correct `content-type`, binary data or more than
    64 KiB (section 2).
  - The publish operation (the vat says "publish this workspace subtree at an unguessable path")
    is a registration whose key the manager mints.
  - Principle: the route is an object handle returned to the publisher; the unguessable URL path
    is a URL boundary, which the principle allows.
- **Effort:** small to medium. Installable.

### 3.4 Child processes: rootless Podman with exec, Moonshine STT, Piper TTS

- **Status:** nothing for guests. The adapter can `import * as cp from 'node:child_process'`
  freely (unconfined).
- **Container:** a registration means "desired running container"
  (`{image, mounts, network policy}`). This fits the kit's desired-state model well: restart
  re-runs `restore`, which re-attaches to or restarts containers.
  - `exec` is a one-shot operation (section 3.0) with batched stdout/stderr. A 16 KB output limit
    into vats applies until the decoder fix. Truncate or summarize in the adapter.
  - Use one installation for all sessions' containers (registrations per container), not one
    installation per session, since each installation is one Node process.
- **Speech:** a long-lived engine process per model is a registration. Audio bytes must never
  go through vats (binary support unverified; strings are capped; about 200 ms per delivery).
  Route audio browser → gateway adapter → speech adapter. Cross-adapter calls go through the
  hub but run no vat crank [inferred: cost not measured]. A simpler alternative is to make
  gateway plus speech one installation, one process.
- **Effort:** container medium to large; speech medium. Both installable.

### 3.5 Git working tree, per-session filesystem area

- **Filesystem:** a native resource whose registration is a directory, `{root}` under a
  daemon-owned path. Its facet returns objects (directory/file handles) whose methods forward to
  the adapter, for example `readText`, `writeText`, `list` and `subdir`.
  - Without collection hooks (`designs/host-managed-resources.md` section 9, not built), storage
    is released only by explicit `close()`/`remove()`. The spec's "removal plus GC" semantics
    need that hook, or explicit retirement.
- **Git:** the same adapter, or a sibling, runs `git` in that directory and tracks branches. The
  owner says a branch-tracking git capability in the session workspace is sufficient.
- **Effort:** filesystem small to medium; git small to medium. Installable. Text contents above
  about 12 KB must be chunked until the decoder fix.

### 3.6 Timers

- **Status:** `clock` exists and is provided to every workspace (README.md:368-426).
- **Missing:**
  - **Wall-clock `now()`**. It is deliberately absent (README.md:391), and in a vat `Date.now()`
    and `new Date()` throw ("secure mode", measured), and `setTimeout` is undefined.
    Harness journals and messages need timestamps. Options: the adapter stamps events it
    delivers (best: it is free), or a small `now` facet. `after(0n)` returns host time but costs
    about 1 s.
  - **Recurring schedules** (README.md:418), which can be built in a vat from `arm`.
- **Randomness:** `Math.random()` throws in vats and there is no `crypto` (measured). Ids and
  idempotency keys must come from an adapter, or from a per-vat seed delivered once.
- **Effort:** small.

### 3.7 Secret storage

- **Status:** nothing exists.
- **Hazard:**
  - Vat heaps are plaintext SQLite snapshots under `heaps/`, and every inbound frame to a vat is
    appended to `journal.jsonl` (`designs/production-cost-model.md:57-76`), so a secret value
    delivered to a vat persists on disk in clear.
  - Frames toward a `discardOnRestart` session sit in the hub queue when `persist()` writes
    `hub.json` (`src/net/hub.js:928-937`) [inferred: transiently persisted].
- **To add:** a native resource whose durable side holds only opaque handles. The adapter stores
  the values in a 0600 file, or keychain or systemd credentials.
  - The consumer that needs a secret, the fetch/provider adapter, should be **in the same
    installation (same process)**, so the value never crosses the hub or a vat. Example: one
    "providers" resource with secrets plus fetch plus SSE parsing.
  - This is also how the Endo spec keeps tokens out of sessions ("sessions receive endpoints,
    never tokens", spec R3-237).
- **Effort:** medium. Installable.

## 4. Engines

| | Ironhorse worker (`rust/thixotrope-ironhorse-worker`, engine `rust/engine`) | XS worker (`rust/thixotrope-xs-worker`) |
|---|---|---|
| Status | **Default and only supervisor engine** (README.md:962; `src/control/supervisor.js:184-204`); release binary built here (11.4 MB); CI lane `test:ironhorse` with about 23 scenarios plus HTTP/alarm crash suites (README.md:640-676) | Alternative heap-snapshot engine (README.md:964-994); `makeXsEngine` lacks `acquireStore`, so the supervisor refuses it (`supervisor.js:203-204`); `c/moddable` submodule empty, binary not built; tests skip without artifacts |
| Heap | SQLite heap store; whole-image copy on sleep/wake ("This MVP pays for a whole database copy on sleep/wake", README.md:700-701) | XS heap snapshot into a CAS |
| Metering | 10 M computrons per crank by default, 1 G for bootstrap, 60 s watchdog (`src/ironhorse/ironhorse-limits.js:45-51`; README.md:704-731); exceeding it quarantines the vat | none in `main.rs` [inferred: no budget code found] |
| Ceilings | slot ceiling 1 M (max 44.7 M), chunk ceiling 256 MiB (max 512 MiB); may only increase for an existing state dir (`designs/ironhorse-limits.md` "Restart policy"); per-vat overrides not implemented | none configured |
| GC | full collection after every crank; finalizers run in the crank (`designs/production-cost-model.md` section 3); **no collection inside a crank** | XS GC |
| JS surface in vats (measured) | `TextEncoder`/`TextDecoder` (pure-JS polyfills, O(n²) decode), `Proxy`, `Date` (but `Date.now`/`new Date()` throw), Unicode regexps, lookbehind, async/await, and async generators within one crank work. **Absent:** `URL`, `fetch`, `setTimeout`, `crypto`, `structuredClone`, `atob`, `WeakRef`/`FinalizationRegistry` (in the compartment), `Intl`, `Uint8Array.fromBase64`, `SharedArrayBuffer`, `Atomics`. `Math.random` throws. **Refused across a suspension:** async generators, `Array.fromAsync` (README.md:761-762) | same polyfills; XS lacks Web APIs (`dist-ironhorse/boot.js:6`) |
| Measured costs | new vat (create plus first evaluate of the 0.6 MB boot and 1.5 MB worker-peer bundles): about 2.0–2.6 s; warm delivery p50 about 190–300 ms; snapshot of a small vat 0.2–0.8 s, a 10 K-record vat 0.34 s; wake plus one eval 0.17–0.33 s; `JSON.parse` of 170 KB fine, 1.7 MB about 1.4 s over baseline; building 20 K records of 260 chars in one crank: `HeapExhausted`; empty-store daemon start 0.1–0.7 s; fresh supervisor start (registry, workspace, mail, clock, control installs) **107 s**; `installNative http` 13 s; `install` of a small app 9.7 s (both because of 1024-char staging chunks) | not measured (not buildable here) |

Limits that will hurt an agent harness:

- the 16 KB string ceiling per message;
- 100–300 ms per delivery, serial per vat;
- about 600 K loop iterations per crank, with quarantine on overrun (consider raising
  `THIXOTROPE_CRANK_BUDGET` for harness vats; it can be changed in either direction, README.md:745-748);
- no GC within a crank, so heavy string building fails;
- no `URL`, randomness or wall clock in vats;
- async generators cannot be persisted while suspended;
- about 2 s to create a vat, which argues against one vat per tool call or per message: use one
  vat per session and keep work in it;
- installing code is slow (about 10 s), so do not install per session;
- a quarantined vat stays dead until its operator removes and reinstalls it (README.md:796-799).
  Every harness vat needs defensive bounds on its input sizes, enforced at the adapter before a
  frame is sent.

## 5. Security: what a native resource holds

- **Ephemeral half = unconfined Node.**
  - A forked `node` with the daemon's environment and user. Lockdown freezes intrinsics but grants
    nothing and takes nothing away. Builtins are live `require` exits (`src/platform/bundler.js:44-53`),
    globals such as `fetch` and `process` are ambient (measured), and `make()` gets `{}`.
  - It can read the state directory: every vat heap snapshot, journals, `hub.json`, and any
    secrets file.
  - It runs no sandbox and no resource limits. stdout is discarded and stderr is inherited
    (`adapter-processes.js:63-70`).
  - Its code is pinned by digest and verified at each launch (`adapter-process-entry.js:32-37`).
    The directory must be trusted (README.md:302).
- **Durable half = confined.** It runs in a vat with only the prelude (`src/guest/prelude.js:43-64`)
  plus explicit grants (`src/native/manager.js:31-39`). It has no Node powers, and it is metered
  and quarantinable like any vat.
- **Who can install.** Only an operator holding the control socket (`thix install-native`;
  `resources/control`). A guest cannot install native code or obtain `worker-controller` or the
  inventory unless granted (README.md:253-256).
- **Mapping to the spec.**
  - Spec R3-220 "unconfined caplet" (full OS authority of the service user) corresponds to the
    native **ephemeral** module.
  - Spec R3-221 "confined caplet" corresponds to a Thixotrope application installed into a vat.
  - Spec R3-219 confined evaluation corresponds to vat `evaluate`. Thixotrope's globals differ
    from the spec's list: `URL` and `console` are absent [`console` not probed].
  - The main structural difference: an Endo unconfined caplet is itself a persistent object,
    while Thixotrope's unconfined half has no persistent identity or state. All durable state
    lives in the confined manager vat as specs (data plus manager remotables).
  - So the spec's unconfined components (session factory, brokers, environment runner, asset
    server, speech; R3-233..245) each split into a confined durable manager or application vat
    and an unconfined disposable adapter.
  - The model's authority (spec R3-4 layer b) maps onto the objects the session vat holds.
    Adapters are layer (a).

## 6. Journal seeds (fits, misfits, incompatibilities)

**Fits well**

- Desired-state resources: listeners, containers, speech engines, published sites and alarms are
  registrations restored after a restart for free.
- Object-passing facets: handlers and sinks are objects.
- Durable session state with no serialization.
- Digest-pinned adapter code.
- Confined/unconfined split.

**Does not fit, or costs a lot**

- Strings over about 16 KB into vats (engine decoder).
- Per-delivery latency of 100–300 ms.
- Crank budget and no GC inside a crank, with permanent quarantine on overrun.
- No one-shot operation verb in the kit.
- No collection hooks.
- Streams lost at a restart.
- No wall clock or randomness in vats.
- Async generators not persistable.
- Install and vat-creation latency (10 s and 2 s).
- Fresh supervisor start of 107 s.

**General incompatibilities**

- The HTTP resource's text/plain-only, header-less, 5 s, 64 KiB, no-WebSocket profile.
- Binary (byteArray) into or out of vats is unverified: my probe could not encode an
  `ArrayBuffer` from the host, and the vat-side return path hung; see `perf-engine4.log`.
- Node 24 fetch breaks under lockdown.
- Secret values persist in journals and heaps if they ever reach a vat.

**First tasks this suggests**

1. Fix the O(n²) `TextDecoder` and re-measure string limits.
2. Measure per-delivery cost and find where the ~150 ms goes (journal fsync, per-crank full GC,
   whole `hub.json` writes; `designs/production-cost-model.md` D.1 and D.4) [inferred causes].
3. Add a kit `operate` verb.
4. Build the gateway, fetch/provider and secrets resources, with streaming that never enters a
   vat per token.
