# Survey: applications and client surfaces on Thixotrope

Scope: what already exists in `packages/thixotrope` (paths relative to
`/Users/xyz/Development/endo-thixotrope-harness` unless stated, `pkg/` = `packages/thixotrope/`)
that a harness chat UI, agent mail tools, admin CLI and workspace publishing could reuse.
Read-only survey; nothing in any repository was modified.

## 1. The `thix` CLI (`pkg/bin/thix.js`, 234 lines)

Connection: every command except `serve` opens `<state>/control.sock` with
`connectLocalControl` (`pkg/bin/thix.js:93-97`). That is an OCapN session (syrup codec, pipe
network) over a private Unix socket with 4-byte length-prefixed frames capped at 8 MiB
(`pkg/src/control/local-control.js:14-16,41-57`). The client fetches the bootstrap's `admin`
object with the fixed secret `"admin"` (`local-control.js:16,115-119`); authority is "can open the
0600 socket as the same OS user" (`pkg/README.md:110-112`). After connecting, it calls
`E(admin).selectWorkspace(name)` unless the command is daemon-wide (`local-control.js:147-150`,
`thix.js:38-45`). `client.call(method, ...args)` is `E(admin)[method](...args)` raced against
disconnection (`local-control.js:157-166`). Default state dir is `./.thix` (`thix.js:36`).
`--workspace NAME` / `--workspace=NAME` must come first (`thix.js:29-35`).

| Command | What it does | Where |
| --- | --- | --- |
| `serve DIR` | Foreground supervisor: opens store, restores workers, serves `control.sock` last; SIGINT/SIGTERM close | `thix.js:48-65`, `README.md:100-141` |
| `attach DIR` | Line-at-a-time JS REPL in the workspace vat via `admin.evaluate(source)`; result rendered by `display.describe`; nonzero exit on piped failure | `thix.js:201-206`, `supervisor.js:641-647`, `pkg/src/tui/attach-view.js` |
| `status DIR` | Worker states, cumulative delivery/snapshot/startup timings | `supervisor.js:626-639` |
| `stop DIR` | Asks supervisor to stop | `supervisor.js:606-609` |
| `workspaces`, `create-workspace NAME` | List/create workspaces (each a vat with inventory, address book, mailbox) | `supervisor.js:616-619` |
| `install DIR NAME module.js [power=key ...]` | CLI bundles the module locally, `admin.install(name, bundle, grants)`; root stored in inventory under NAME | `thix.js:164-184`, `supervisor.js:658-685` |
| `install-native DIR NAME resource-dir` | Bundles `durable.js`+`ephemeral.js`, installs a native resource; facet stored in inventory | `thix.js:103-119`, `supervisor.js:697-735` |
| `installations` | Registry listing: workspace, digest, grants, status | `supervisor.js:610-613` |
| `remove DIR NAME` | Retires the installation's vat/processes; frees the name | `thix.js:185-189`, `supervisor.js:745-789` |
| `inventory DIR` | Full-screen TUI redrawn from pushed inventory snapshots (`watchInventory`) | `thix.js:199-200`, `pkg/src/tui/inventory-view.js:27-51` |
| `invite NAME`, `accept NAME JSON`, `revoke-invite JSON` | Capability-mail introductions | `thix.js:139-145`, `pkg/src/control/workspace-client.js:37-47` |
| `contacts`, `inbox`, `outbox` | JSON listings (terminal-escaped) | `thix.js:155-163` |
| `send NAME text [key | proposed=key ...]` | Text plus inventory capabilities by key, resolved at the CLI edge | `thix.js:143-152`, `workspace-client.js:73-95` |
| `take ID INDEX KEY`, `discard ID` | Copy a received capability into the inventory / drop message | `thix.js:153-154`, `workspace-client.js:96-102` |
| `mail DIR` | Line-oriented mailbox TUI (`r`, `take`, `discard`, `q`); polls only on command | `pkg/src/tui/mailbox-view.js:19-56` |
| `alarms` | Pending/armed alarm counts from the clock | `thix.js:99-102`, `workspace-client.js:106` |
| `reachability`, `collect` | Vat reachability report / sweep unreachable vats | `supervisor.js:614-615` |

The full administration surface is listed in its own `help()` (`pkg/src/control/supervisor.js:605`):
daemon-wide `status, stop, installations, reachability, collect, workspaces, createWorkspace,
selectWorkspace, close`; per workspace `evaluate, install, installNative, remove, lookup(key),
keep(key, value), getAddressBook, getInventory, getMailUiToken, adopt(key, value),
inventoryStatus, watchInventory(listener)`. `lookup` hands out only remotables
(`supervisor.js:798-807`); `keep` replaces (`815-821`); `adopt` refuses to replace
(`847-852`, via `workspace-access.js:67`). A reference the client itself exports and keeps
breaks when the connection closes (`README.md:463-464`).

Separate scripts (not `thix` subcommands): `pkg/scripts/mail-ui.mjs` (browser mail bridge, `yarn
mail-ui`), `ironhorse-demo.mjs`, `measure-mail.mjs` and the profiling scripts.

## 2. How a browser talks to a Thixotrope app today

There is exactly one browser client: the confined mail UI. It does **not** run CapTP/OCapN in the
browser and does not talk to a guest-served HTTP app. A separate trusted Node process holds the
control-socket connection and serves a small JSON + SSE API.

- Launch and bundling: `pkg/scripts/mail-ui.mjs:32-70` builds two bundles at startup, the trusted
  host shell with esbuild (IIFE, `src/platform/browser/mail-ui-host.js`) and the untrusted
  component with `@endo/compartment-mapper` `makeBundle` (`src/web/mail-ui.js`), and holds HTML,
  JS and CSS as an in-memory `Map` of assets. It then connects to `control.sock`, fetches
  `getAddressBook`, `lookup('mailbox')`, `lookup('contacts')`, `getInventory`
  (`mail-ui.mjs:71-89`) and starts `serveMailUi` (`mail-ui.mjs:97-102`).
- Server: `pkg/src/platform/node/mail-ui-server.js` (Node `http`, binds `127.0.0.1` only, line 195;
  default port 8123). Routes: `GET /` and assets (no auth), `GET /api/events` (SSE),
  `GET /api/mail` (one snapshot), `POST /api/send`, `POST /api/adopt` (`mail-ui-server.js:53-186`).
- Transport: Server-Sent Events framed manually (`data: <json>\n\n`), consumed in the browser by
  `fetch` + `ReadableStream` reader, not `EventSource`, so the bearer header can be sent
  (`mail-ui-host.js:37-93`). Writes are `fetch` POSTs with JSON (`mail-ui-host.js:15-29`).
  No polling; 20 s comment heartbeat (`mail-ui-server.js:111-113`); backpressure is
  latest-wins: while a write is blocked only the newest snapshot is kept (`mail-ui-server.js:96-105`).
  Browser reconnect with exponential backoff 500 ms to 10 s (`mail-ui-host.js:86-89`).
  No WebSocket anywhere in the package (grep: only `mail-ui-server.js` mentions event-stream).
- Authentication: a 256-bit hex bearer secret in the URL fragment (`mail-ui-server.js:21-22,205`),
  sent as `Authorization: Bearer` on every `/api/` request (`mail-ui-server.js:60-67`), never as a
  cookie (`credentials: 'omit'`). Host and Origin must equal `http://127.0.0.1:<port>`
  (`mail-ui-server.js:44-52`). The secret lives in the workspace vat heap under
  `globalThis[Symbol.for('thixotrope.mailUiToken')]`, chosen on first use, stable across restarts
  (`supervisor.js:828-835`). Restrictive CSP: `default-src 'none'; script-src 'self'
  'unsafe-eval'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'` plus no-store,
  no-referrer, nosniff (`mail-ui-server.js:27-34`). POST bodies limited to 32 KiB JSON
  (`mail-ui-server.js:148-156`); `requestTimeout` 15 s (`191`).
- Live updates: `makeMailUiService` (`pkg/src/web/mail-ui-service.js`) maintains one projection per
  bridge, shared by all browser tabs (`pkg/src/web/mail-ui-subscription.js:15-52`). Upstream it
  holds ephemeral `subscribeEntries` subscriptions on inbox, outbox, inventory and the contacts map
  plus one `subscribeStatus` per contact (`mail-ui-subscription.js:151-178,106-150`). Entry
  streams send an initial reset then coalesced per-key changes (`pkg/src/observable-map.js:17-18,
  254-276`). A legacy full-reread path exists for old persisted objects (`mail-ui-service.js:132-221`),
  chosen via `__getMethodNames__()` introspection (`mail-ui-subscription.js:54-67`).
  Downstream the browser receives the **whole** projected `MailSnapshot` on every change
  (`mail-ui-subscription.js:87`, `designs/mail-ui-subscriptions.md:5` "incremental browser
  payloads remain desired").
- Capability handling at the browser edge: only descriptions and opaque per-bridge tokens reach
  the browser; tokens are minted from a `WeakMap` keyed by the reference (`mail-ui-service.js:41-55`).
  Sends carry `{token}` selections captured when offered, so renaming an inventory entry cannot
  redirect a draft (`mail-ui-service.js:344-375`). Adopt places an offered value in the
  inventory, refusing to replace a different value (`mail-ui-service.js:330-343`).
- Confinement of the UI code: the host shell runs `lockdown({overrideTaming:'severe'})`
  (`src/platform/browser/mail-ui-lockdown.js`), fetches `/component.js`, evaluates it in a fresh
  `Compartment({harden})` (`mail-ui-host.js:109-115`) and renders through
  `@endo/preact-container`'s `confineComponent` + `renderConfined` with an allowlist of tags
  (`mail-ui-host.js:116-196`). The component receives only Preact hooks and `{api, editor}`
  (`src/web/mail-ui.js:19`); DOM, fetch, location and storage stay with the shell. The rich
  editor (contentEditable with atomic reference pills, `@` completion) is trusted shell code that
  exposes only immutable part lists (`src/platform/browser/mail-editor.js`). The
  preact-container README calls itself best-effort, not a security boundary
  (`packages/preact-container/README.md:7-12`).

## 3. The mail system

Object model (all guest code shipped by source into vats):
- **Mailbox** (`pkg/src/mail/mailbox.js`), one per workspace, provided by the supervisor at every
  start under inventory key `mailbox` (`README.md:493-496`); placement `workspace` (colocated) or
  `separate` vat (`src/control/workspaces.js:40`). Inbox and outbox are observable maps of
  immutable records `{from|to: contactRef, content, status?, error?}` keyed by sequence strings
  (`mailbox.js:68-128`). `receive(contact, sequence, content)` is at-most-once per contact
  sequence (`89-96`). `send` records `sending`, invokes `E(contact).deliver(content)` exactly once,
  and replaces the record with `delivered`/`failed` (`101-129`); retries are the durable node
  outbox's job. Guards: up to 64 parts, strings ≤ 4,096 chars, names 1–128 chars, values must be
  remotable; promises and copy data rejected (`mailbox.js:29-37`, `README.md:537-547`).
- **Contact** (`pkg/src/mail/mail-contact.js`): per-correspondent object with `status()`,
  `subscribeStatus(listener)`, `invite`, `accept`, `revokeInvitation`, `deliver(content)`; the
  remote side holds only a `ContactInbox` submission facet (`mail-contact.js:41-56,110-118`).
- **Address book** (`pkg/src/mail/mail-address-book.js`): `invite(name)`, `accept(name, text)`,
  `revokeInvitation`, `contacts()`, `send(contactRef, content)` (requires status `ready`,
  `193-197`), `inbox/outbox/take/discard` delegated to the mailbox (`198-208`). Inventory holds the
  `contacts` map and the `mail` book, so `mail` can be granted to an app like any entry
  (`README.md:497-503`). Granting `mail` grants dialing any peer named in an accepted invitation.
- **Introductions** (`pkg/src/mail/introductions.js`): one host resource that publishes,
  withdraws and redeems invitation swissnums (`introductions.js:43-50,91-127`). Invitations are
  JSON containing the inviter's absolute `peers.sock` path (`README.md:488-491`); transport is a
  Unix socket between supervisors of the same OS user, 1 MiB fragments (`README.md:429-435`).

Attaching values: `send(contact, ['text', {name, value}, ...])`; `name` is only a suggestion
(`README.md:526-541`). Listings return `{name}` descriptions; the value is obtained with
`take(id, index, box?)` (`mailbox.js:150-162`) or through `subscribeInboxEntries`, which grants
values to the listener (`mailbox.js:19-21,181-188`). Adoption = the caller decides where to keep
it: CLI `take` → `keep`, browser `adopt` → `admin.adopt` (no overwrite).

Subscriptions: `subscribe(listener, ephemeral?)` sends display snapshots;
`subscribeEntries(listener, ephemeral?)` sends `{reset?, entries, deleted, revision}` coalesced
while the listener is busy (`observable-map.js:8-18,99-160,239-276`). Ephemeral subscriptions
are cut at supervisor restart by `disconnectEphemeral()` (`mailbox.js:190-193`,
`workspaces.js:157-163`).

Persistence: mailbox state is ordinary heap state in its vat (orthogonal persistence); sends while
the peer is offline stay `sending` across restarts of both supervisors (`README.md:509-511`).
Retention is unbounded: the outbox has no delete, the inbox shrinks only by `discard`, and the
per-contact `accepted` map grows with contacts (`mailbox.js:68-73,164`).

Performance work already done (`pkg/designs/mail-*.md`; all medians of 3–7 sequential local
sends on this class of Mac, not tail latency; provisional target 50 ms typical / 100 ms p99 is
still **unmet**, `mail-performance-plan.md:6-7`, `mail-gc-batching.md:122`):
- Baseline problem: a browser self-send took 12.08 s to the DOM; 793 full hub-state rewrites took
  7,554 ms; the bridge reread all history and discarded stale projections
  (`mail-ui-subscriptions.md:19-33`).
- Pushed entry streams + shared projection: 7,253 ms → 1,017 ms; batching head sequences 806 ms;
  colocating the mailbox in the workspace vat 423 ms (18 hub rewrites)
  (`mail-performance-plan.md:159-166`).
- Combined native deliver-v1 (dispatch + jobs + GC + extraction in one request, no
  post-extraction GC): 418 → 364 ms (`mail-latency-colocated.md:10-11`).
- Captured recipient reference instead of name lookup: 362 → 229 ms; experimental hub append log
  182 ms (`mail-optimization-strategies.md:13-20`).
- Completed-crank batching + deferred worker cleanup: 217 → 185 ms, 10 → 6 hub commits
  (`mail-durable-transfer-batching.md:19-28`).
- Disposable observer outboxes: 190 → 145 ms, 6 → 2 hub commits; budget now three host
  durability commits per send (2 hub + 1 journal) (`mail-observer-outbox.md:17-32`). Append-log
  133 ms and SQLite WAL 136 ms remain experimental backends.
- GC-stress workload: median 277 → 196 ms, worst sample 3,393 → 379–627 ms
  (`mail-gc-batching.md:26-32`).
- Where the remaining ~156 ms goes (`mail-vm-detail.md:10-47`): ~129 ms VM-only, of which
  ~59 ms execution (53.5 ms draining 51 promise reaction jobs) and ~67 ms in two full GC rounds;
  filesystem ~22 ms.
- Real HTTP bridge after a normal restart: 150, 236, 242 ms from POST to SSE push
  (`designs/mail-demo-reset-results.json`, `mail-performance-plan.md:87-88`).

Local performance check run during this survey: `corepack yarn ses-ava test/mail-ui.test.js
test/mailbox.test.js` (34 tests, in-process, no native worker) passed in 2.0 s wall; individual
mailbox tests 100–220 ms. The real-worker lane (`ava --config ava.ironhorse.config.mjs
test/ironhorse/http.js test/ironhorse/mailbox.js`) did not finish within 7 minutes (see the
result note at the end).

Result note: I stopped the real-worker lane after about 9 minutes. It was still in the two-supervisor
mailbox scenario (alice and bob ironhorse workers alive), and other agents' test runs were sharing
the machine, so no timing can be taken from it. That one mailbox scenario's state directory
(`/tmp/thix-mail-D1q3O8`) had grown to **420 MB** before I deleted it. With about 21 GB of disk
free, real-worker integration tests have to run one at a time and their state has to be cleaned up.
The harness needs a cheaper real-worker smoke test for its per-feature performance checks.

## 4. Persistent HTTP apps (`pkg/resources/http`)

- Install `thix install-native DIR web ./resources/http`, grant `http=web` to an app
  (`README.md:290-300`). Facet: `register(port, handler, policy?)` → handle with `status()`,
  `close()` (`resources/http/durable.js:72-93`). Desired registrations persist in the manager vat;
  the Node adapter process rebinds after restart (`README.md:339-345`).
- The guest implements `handle({method, path, body})` → `{status, body}`
  (`pkg/examples/http-counter.js:5-33`). Each request is one eventual send from the adapter to the
  guest (`resources/http/ephemeral.js:70-71`), so each request is at least one durable crank in the
  guest vat [inferred: same ~100+ ms class as a mail delivery].
- Limits, hard-coded in the adapter (`resources/http/ephemeral.js:60-69`): `127.0.0.1` only;
  request body 64 KiB, response body 64 KiB, headers 16 KiB; 16 concurrent requests (503 beyond);
  5 s deadline (504); keep-alive 1 ms. Bodies must be valid UTF-8 text (`listener.js:139-144`).
- No streaming: the response is a single string returned after the handler settles
  (`listener.js:145-161`). Every response is written by `reject()` with `content-type:
  text/plain; charset=utf-8` and `connection: close` (`listener.js:44-51,161`), so the guest cannot
  set status-independent headers, content types, cookies or cache headers. Request headers are
  collected (`listener.js:60-62`) but the adapter forwards only `{method, path, body}` to the guest
  (`ephemeral.js:70-71`). `upgrade` and `CONNECT` sockets are destroyed (`listener.js:199-200`), so
  no WebSocket. Admission (Host must be the loopback listener; Origin allowlist; `Sec-Fetch-Site`
  same-origin/none) is decided in the adapter, not by the guest (`ephemeral.js:28-49`).
- Port range 1024–65535 (`durable.js:81-82`).

## 5. Reuse map

(a) Chat UI (session list, streamed transcript events, compose box, audio):
- Reuse directly: the bridge pattern of `mail-ui.mjs` + `mail-ui-server.js` (loopback, bearer in
  fragment, Origin/Host checks, CSP, SSE with latest-wins backpressure and heartbeat, fetch-based
  SSE reader with backoff); the confined-component shell (`mail-ui-host.js` with
  `@endo/preact-container`); the shared-projection-per-bridge subscription fan-out
  (`mail-ui-subscription.js`); the per-bridge token minting for capability references; the
  `mail-editor.js` contentEditable with reference pills as a compose box; the durable bearer
  secret idea (`getMailUiToken`); observable maps for a session list.
- Missing: append/event-log semantics. Observable-map coalescing (latest value per key) and the
  whole-snapshot SSE payload are wrong for a transcript: each token delta would resend the full
  projection, and coalescing drops intermediate events. Needs an incremental, sequence-numbered
  event stream with resume-from-offset to the browser. No binary transport: no audio upload
  route, no `media-src`/`blob:` in CSP, `<audio>`/`<video>` not in `allowedTags`
  (`mail-ui-host.js:174-195`), component has no `getUserMedia`/`MediaRecorder` endowment, and JSON
  bodies are capped at 32 KiB. The bridge binds `127.0.0.1` only and has no TLS, so remote/phone
  access needs a proxy (out of scope) or a configurable bind. The bridge is a non-persistent Node
  process holding full admin on the control socket; a chat bridge should hold only the session
  objects it serves [inferred design need]. No generic asset pipeline: assets are a hand-built
  in-memory map per script.
- Performance warning: per-message durable crank latency is ~150–240 ms end to end today; model
  token streaming must not be one durable crank per delta. Stream deltas on an ephemeral path
  (host-side or ephemeral subscription) and commit coalesced transcript entries.

(b) Agent-to-agent mail tools:
- Reuse directly: `E(book).send(contactRef, [text, {name, value}])`, `subscribeInboxEntries`
  (pushes values), `take`, `discard`, contact `status`/`subscribeStatus`; grant the `mail` and
  `contacts` inventory entries to an agent vat like any power. Content is ordered text plus
  remotables, matching the object-passing principle; durable delivery across restarts exists.
- Missing: message kinds beyond text+caps (Endo's request/eval-proposal/reply threading);
  reply-to/threading ids; any bounded retention (outbox grows forever); introductions require the
  invite/accept JSON dance over `peers.sock` even for agents on the same daemon, unless the
  harness hands contact objects directly [inferred: a local in-daemon contact factory is easy since
  `deliver` is just a method on an object]. Limit inconsistency: bridge allows 256 parts but the
  mailbox guard allows 64 (`mail-ui-service.js:351` vs `mailbox.js:36`). The address book and
  contacts look up the mailbox by the string key `inventory.get('mailbox')` at each use
  (`workspaces.js:134-139`), a name lookup that conflicts with principle 1.

(c) Admin CLI:
- Reuse directly: `connectLocalControl` + `client.call` (`local-control.js:132-170`); the
  `--workspace` convention; `lookup(key)` to get a capability and then `E(cap).method(...)`, as
  `workspace-client.js` does for mail; `install` with grants for installing harness apps;
  `status`, `installations`, `remove`, `reachability`, `collect`; `attach` already is a full JS
  admin REPL; `terminalText`/`printJson` escaping for remote-controlled text
  (`pkg/src/tui/terminal-text.js`).
- Missing: no plugin/subcommand mechanism in `thix.js` (a long if/else chain); a harness CLI should
  be its own bin reusing `connectLocalControl`. No streaming log/tail command. Results of
  `evaluate` are descriptions only.

(d) Publishing a session workspace directory at a web address:
- Reuse: the HTTP native-resource shape (durable registration in a manager vat, Node adapter
  rebound on restart, Origin/Host admission) and `makeAdapter`/`makeManager` contract
  (`README.md:302-323`, `designs/native-resource-installation.md`).
- Missing: almost everything. No filesystem capability for guests exists in `resources/` (only
  clock, control, http). The HTTP resource cannot serve files: text-only UTF-8, 64 KiB cap, fixed
  `text/plain` content type, no response headers, loopback only, no range/streaming, every
  request is a guest crank. A publisher should be a new native resource whose adapter serves a
  directory capability straight from disk, with the guest only registering/revoking the mapping
  [inferred].

## 6. Fit notes for the journal

- Good fit: capability-by-reference mail (no name registry, `README.md:515-520`); confined UI with
  token edge; durable bearer secret in the heap; native resources with durable intent and
  disposable adapters; observable maps with ephemeral subscriptions cut at restart.
- Poor fit / incompatibilities: durable crank cost (~100+ ms floor, about 60 ms of it GC) versus
  streaming; HTTP resource designed as a toy (text, 64 KiB, 5 s, no headers/streaming/WebSocket);
  browser payloads are full snapshots; no binary/audio path; bridge holds full admin authority;
  mailbox found by string key; unbounded mailbox history; persisted guest code is frozen, so
  interface changes need migration or fresh state (`README.md:420-425,592-595`).
