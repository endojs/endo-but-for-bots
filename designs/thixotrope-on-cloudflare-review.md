# Thixotrope on Cloudflare: verification review

| | |
|---|---|
| **Created** | 2026-09-24 |
| **Updated** | 2026-09-24 |
| **Author** | Aaron Davis (prompted) |
| **Status** | Reference |

*Verification review of [Thixotrope on Cloudflare](thixotrope-on-cloudflare.md) (the base report)
and [Addendum A, Single-Vat Hubs](thixotrope-on-cloudflare-addendum-single-vat-hub.md).*

The base report was checked at `5663b155` and Addendum A at `075c0118`.
The base report's current text (`075c0118`) adds only the supersession notes, and every quote
below is copied from the current text of both documents.
Claims were checked statically against the repository code, the workerd source at `62935d7` and
the Cloudflare documentation, and by experiments in local workerd.
Ten claim groups over the base report each had one verifier pass and one adversarial skeptic
pass, followed by a completeness critic; where the skeptic overturned the verifier, its verdict
and evidence are used here.
Addendum A had a separate adversarial review with three local workerd experiments (e1–e3); its
findings are cited by that review's numbers, as "finding 1" to "finding 20".
Everything was then re-checked against the engine reports at `e487f62e`:
[WASM-BLOCKERS.md](../rust/engine/WASM-BLOCKERS.md) and
[STACK-DEPTH-REFACTOR.md](../rust/engine/STACK-DEPTH-REFACTOR.md).

Labels: *(inferred)* marks inference.
**local-workerd** marks results measured only in local workerd, which enforces no CPU or memory
limit and caps a value at 4 MiB where the documentation says 2 MB.
*(Node)* and *(native)* mark measurements of the wasm32 build under Node 22 and of the native
build.

## Verdict

The platform half of the base report holds: the SQL authorizer audit, the Hibernation API rules,
output gating, the synchronous crank and the limits table are accurate
([Verified as correct](#verified-as-correct)).
Ironhorse compiled to wasm runs in a SQLite-backed Durable Object: on fresh instances 24 of the
25 recursion families match native, and every mismatch is a trap, never a wrong answer
(local-workerd).
The engine half does not hold.
The port is not one `HeapStore` backend: it needs an unstable-toolchain build with the compiler
on every delivery, a host stack the platform will not raise, a memory budget shared with
co-resident objects, and a host that discards the instance after any trap or rollback.
Lazy resume does not make a wake cost the pages a message touches, and the CapTP tables and host
obligations that the report places in the heap are host state today.
Addendum A's central idea, one vat and its routing tables committed in one `transactionSync` per
crank, is sound and removes the hub↔worker journal and replay.
Its protocols are not ready: counterexample traces retire reachable hubs and lose a frame, local
collection cannot fire because Ironhorse vats never send GC messages, and the gifter role it
relies on does not exist.

Rows 1–3 can each rule the design out, rows 4–5 are prerequisite engineering for Phase 0, and
rows 6–11 block Phase 2.
"U" and "C" refer to the completeness critic's items, restated below.

| # | Blocker | Affects | Evidence (short) | Blocks |
|---|---|---|---|---|
| 1 | The host call stack is fixed by the platform and too small: programs the engine accepts natively trap, at a depth that moves with V8 tier-up | Base §1, §8, §9 (not mentioned); Add. §6.4 | `JSON.stringify` of nested arrays traps from depth 1,343–1,529 where native accepts 2,000; only self-hosted `v8Flags` raise the stack (local-workerd; WASM-BLOCKERS B3 and Cloudflare section; STACK-DEPTH-REFACTOR §1.5). U2, C3 | Phase 0 go/no-go; Phase 2 until STACK-DEPTH-REFACTOR Phases 1–2 land |
| 2 | 128 MB is per isolate and shared by co-resident objects; default ceilings allow about 0.5 GB of linear memory, which never shrinks | Base §1, §9, §10; Add. §1 | 11,468,800 B per instance before any heap; demo counter vat 42.13 MiB lazy, 60.31 MiB eager at wake, 59.56 / 77.75 MiB after one chunk-allocating crank *(Node)*; default chunk ceiling halts at 556–599 MB; an overrun replaces the isolate (WASM-BLOCKERS B8). U4, C4, finding 10 | Phase 0 (ceiling profile); Phase 2 |
| 3 | Lazy resume does not make a wake cost the pages a message touches | Base §5.2, §8 Phase 0, §9 | 977 of 1006 slot pages resident right after opening the counter vat; wake 260–340 ms lazy against 279–497 ms eager on the real SQLite backend *(native)*; an allocating checkpoint re-reads every non-resident page (`value.rs:899-919`). U5 | Phase 0 go/no-go (latency) |
| 4 | Reusing the cached instance after a trap or rollback commits state that SQL rolled back | Base §5.3 `this.vat ??=`, §6.1 `tx`; Add. §4.2, §6.4 | SQL count 3 while the vat held 4, then the next crank committed 5 (local-workerd); each trap leaks about 4.1 MiB of shadow stack and every call fails after about ten traps. Merges U3, finding 5 and WASM-BLOCKERS "A trap poisons the instance" | Phase 0 (host contract) |
| 5 | The engine the worker needs does not build on stable Rust, and the compiler runs on every delivery | Base §1, §2, §6.1 | `ironhorse-compile` refuses `panic=abort` (`lib.rs:30-31`); the worker compiles every eval (`main.rs:121-128`); two source-text evals per inbound frame (`ironhorse-engine.js:286, 297`); the working build needs `RUSTC_BOOTSTRAP=1 -Zbuild-std` (WASM-BLOCKERS B1). U1, C1 | Phase 0 (build) |
| 6 | Every heap is pinned to one engine binary, and a Worker cannot load another engine at run time | Base §1, §8 Phases 2–3 | The profile hashes the worker executable (`ironhorse-runtime.js:117-129`); resume requires exact equality (`format.rs:437-438`); workerd refuses runtime wasm compilation (`jsg/setup.c++:623-627`). U7, C5 | Phase 2: the first engine deploy orphans every hibernated heap |
| 7 | Host state lives outside the heap: routing tables (base report) and the host endpoint (both documents) | Base §1, §5.1–§5.4; Add. §9 | C-lists and sessions are `hub.js` state (`hub.js:17-20`); host resources and pending host answers live in a live endpoint (`daemon.js:46-53`) and reject on restart (`ocapn.js:683-686`); the in-heap client has no `crypto` for handshake keys (`cryptography.js:195`). U6 | Phases 1–2 |
| 8 | Exactly-once delivery is unsound: the base sketch drops committed frames, and the addendum lets frame k+1 overtake k | Base §5.3, §7; Add. §4.2–§4.3 | `?.send` to a closed session: found=0 with SQL advanced (local-workerd); workerd ignores sends after close (`web-socket.c++:853-854`); [trace](#42-crank-and-43-hub-to-hub-delivery). U6, finding 4 | Phase 2; the Phase 1 relay too |
| 9 | Collection can retire reachable hubs, and the local signal cannot fire | Add. §4.1, §5, §7.1–§7.3 | [Traces](#71-local-signal); `shell` is published at birth, rooting every hub; Ironhorse has no `WeakRef` or `FinalizationRegistry`, so vats never emit `op:gc-exports` (`captp/finalize.js:56-58`). Findings 1–3 | Phase 2 (deletion is irreversible) |
| 10 | The gifter role that makes every introduction a handoff does not exist | Add. §5, §9, §11 | `hub.js` answers `isThirdParty: false` (`hub.js:864, 869`) and proxies foreign references (`hub.js:918-944`); pipelining onto an undeposited gift breaks (`hub.js:1600-1606`). Finding 8 | Phase 2 |
| 11 | Lifecycle reports are unauthenticated and the tombstone is fragile | Add. §4.5, §6.2, §8 | Control cannot tell which hub sent `failed` or `collectible`, and `failed` ends in deletion; before compat date 2026-02-24 `deleteAll()` keeps the alarm (e1, local-workerd); one spurious `not-incarnated` makes peers abandon a live hub. Findings 6–7 | Phase 2 |

## Factual corrections

Each quote is copied from the current text, for use as an inline correction note.

| # | Quote (current text) | Doc § | Correction | Evidence |
|---|---|---|---|---|
| 1 | "All live object state, including CapTP session tables, lives in pages of the Ironhorse heap" | Base §1 | Only the guest object graph and the worker's half of its pipe session to the host are in the heap. C-lists, answer routes, publications, gifts and session identities are host hub state, written as one JSON document after every mutating frame. | `hub.js:17-20, 51-55`; `worker-peer.js:88-101` |
| 2 | "Nothing live is left in the JS isolate, so the failure mode in" | Base §1 | The host endpoint holds live objects by design: system resources, the worker controller and pending host-owed answers, which reject at-most-once after a restart. A DO wake after hibernation is such a restart *(inferred)*. | `daemon.js:46-53`; `ocapn.js:683-686` |
| 3 | "A worker costs something only while it processes a message." | Base §1 | Duration is billed only while running or unable to hibernate, but SQL storage ($0.20/GB-month beyond 5 GB) accrues while hibernated, and requests and rows written are billed separately. | DO pricing |
| 4 | "Cloudflare provides storage, compute and connection hosting, and heap images stay portable to" | Base §1 | Not with today's runtime profile: it hashes the worker executable and resume requires an exact match, so the native worker refuses a wasm-written heap and vice versa. In-DO export and import each need about 3–3.5× the container size in linear memory. | `ironhorse-runtime.js:117-129`; `format.rs:437-438`; 17,273,470 B container: export 11.00→68.81 MiB, import 11.31→82.56 MiB *(Node)* |
| 5 | "The one real port is a new `HeapStore` backend over the DO SQL API." | Base §1 | The worker also needs `ironhorse-compile`, on every delivery, which refuses `panic=abort`; `ironhorse-vm` refusals abort under `panic=abort`; and the port needs stack work (B3), heap ceilings (B8), a new worker loop and host ABI (B5), and adoption of lazy resume, which the worker does not use. | `ironhorse-compile/src/lib.rs:30-31`; `main.rs:121-128, 247`; WASM-BLOCKERS B1, B3, B5, B8 |
| 6 | "Never call `ws.accept()` or `addEventListener`, because registered listeners keep the isolate" | Base §5.1 | Only `ws.accept()` makes a socket non-hibernatable. On a socket passed to `acceptWebSocket`, `addEventListener` "does nothing" and does not pin the object. | `actor-state.h:666-671`; a DO with a listener registered was evicted after 13 s idle (local-workerd) |
| 7 | "slot pages and chunk extents are faulted in on demand." | Base §5.2 | Restore validation faults every page that holds a side-table owner or a directly referenced value, and the lazy chunk arena allocates the full chunk length at attach. | `persist.rs:69, 118`; `value.rs:1850`; 977 of 1006 slot pages resident after opening the counter vat |
| 8 | "A wake costs roughly the metadata plus the pages the message touches." | Base §5.2 | A wake also reads the whole small state twice and every page-edge row, restores every side table eagerly and faults the pages they reference; a crank that allocates then makes its checkpoint re-read every non-resident page. | `machine.rs:1332-1333, 1412-1415`; `value.rs:899-919`; wake 260–340 ms lazy against 279–497 ms eager *(native)* |
| 9 | "export class ThixotropeWorker extends DurableObject {" | Base §5.3 | `DurableObject` is not a global: import it from `cloudflare:workers`, and declare the class under `new_sqlite_classes`, or `transactionSync` throws "Durable Object is not backed by SQL." | `src/cloudflare/workers.ts:13`; `actor-state.c++:781`; `typeof DurableObject` is "undefined" (local-workerd) |
| 10 | "// crank + drain queue + commit dirty pages" | Base §5.3 | Inside `transactionSync` the store's commit only releases a savepoint; durability comes from the output-gated implicit commit after the callback returns, and a later throw in the callback rolls the "commit" back. | `actor-state.c++:751-776` |
| 11 | "Session identity is re-established from the attachment, and CapTP tables are rebuilt as heap" | Base §5.4 | Map, WeakMap and Array tables are small-state side tables restored eagerly on every wake, and the hub's tables are host state. A durable session is keyed by the resume token in the first `hello`, which arrives after `acceptWebSocket`, so the attachment must be rewritten after the handshake. | `machine.rs:1412-1415`; `durable-netlayer.js:387-397` |
| 12 | "This is a reentrant call into the guest, so hold no `RefCell` borrows (e.g. `root_cache`)" | Base §6.1 | `root_cache` is a plain `Option<RootLedger>` field. Under lazy resume the caller necessarily holds the store's `RefCell` borrow across the commit, so the rule cannot be met; drop the reentrant `tx` import instead. | `ironhorse-store-sqlite/src/lib.rs:214`; `machine.rs:581-584` |
| 13 | "`PRAGMA application_id / locking_mode / journal_mode / wal_autocheckpoint / synchronous`, `busy_timeout`" | Base §6.2 | `busy_timeout` is set through rusqlite's C API, not a PRAGMA; it has no DO counterpart and is dropped with the others. `user_version` is denied too, so a `meta` row is the only place for the stamp. | `lib.rs:276`; `sqlite.c++:562-591` |
| 14 | "Can exceed the 2 MB row cap on large heaps" | Base §6.2 | The Arrays section passes 2,000,000 B at about 83k array elements summed over the heap (24 B each), in a heap file of about 2 MB; Collections at about 50k entries. The counter vat's Functions section is already 1,376,481 B. An over-cap value fails the whole commit, so the row is ❌. | Row sizes measured through `SqliteHeapStore` *(native)* |
| 15 | "Lazy paging, evicting cold pages, sharding across DOs, Containers for outliers" | Base §9 | Lazy paging does not bound memory (corrections 7–8); no production code evicts; evicting a chunk extent frees nothing; wasm memory never shrinks; and DOs of one Worker may share an isolate and its 128 MB. | `store_suite.rs:246-293` (only callers); `value.rs:1912-1936`; DO in-memory-state docs |
| 16 | "O(dirty) commits already. Batch small frames; skip commits for read-only cranks" | Base §9 | Every crank dirties at least the Meter section and the manifest row, so no crank is read-only. A touched Arrays or Collections section is re-encoded whole, the free list is re-encoded at every checkpoint, and a dirty page with k outgoing edges costs about 4 + 3k billed rows. | `lib.rs:1332-1351, 1278-1283`; `machine.rs:1028-1052`; `rowsWritten` (local-workerd) |
| 17 | "Computron budgets already exist; split long work across alarm cranks" | Base §9 | A budget refusal ends the crank as a fatal halt; the engine cannot resume it in a later alarm. Computrons also do not bound CPU time (0.119–14.55 M computrons/s). | `interp.rs:2286-2287`; WASM-BLOCKERS Cloudflare section, "CPU" |
| 18 | "Hub-to-hub delivery (exactly once)" | Add. §4.3 | Not exactly once as specified: with no gap check, frame k+1 can commit before k, and k is then dropped as a duplicate. | [Trace](#42-crank-and-43-hub-to-hub-delivery) |
| 19 | "External nodes dial in through the edge router, which calls `acceptWebSocket` on the hub." | Add. §4.4 | `acceptWebSocket` is a method of the object's own `ctx`; the router forwards the upgrade with `stub.fetch(request)`, and the hub accepts the socket. | `actor-state.h:586, 675`; DO WebSockets best practices |
| 20 | "`newUniqueId({ locationHint })`" | Add. §5 | `newUniqueId` takes only `{ jurisdiction }`. `locationHint` is an option of `get()`, honoured best-effort on the first `get()` only. | `api/actor.h:203-213, 230-249`; DO namespace and data-location docs |
| 21 | "Control can end a hub but has no path to the vat's objects." | Add. §5 | Control supplies `boot` at `incarnate`. `export(controlToken)` either includes the hub tables, and so every publication swissnum and session private key, or is `export_to_container`, which omits them and breaks archive and migrate. | `hub.js:376-392, 2050-2061`; `store.rs:3284-3288` |
| 22 | "**The condition, once true, stays true**, so there's no race between reporting and retiring." | Add. §7.1 | False: an unacked outbox frame, an answer owed to a peer and an outstanding gift certificate each let a "collectible" hub still be reached or still owe effects. | [Traces](#71-local-signal) |
| 23 | "Hubs run Ironhorse GC at idle, for example on an alarm after a period of quiet, so the" | Add. §7.2 | Ironhorse has no `WeakRef` or `FinalizationRegistry`, so the vat's OCapN client keeps imports in strong maps and never sends `op:gc-exports` or `op:gc-answers`; guest GC releases nothing on the wire. | `packages/ocapn/src/captp/finalize.js:4, 56-58`; `pairwise.js:80-91`; `typeof WeakRef` is "undefined" in the wasm engine |
| 24 | "**Verify:** every importer of a fenced hub must itself be fenced or retired." | Add. §7.3 | A one-level check against fence state that later changes retires hubs that are still reachable. | [Trace](#73-cycle-backstop) |
| 25 | "the handoff and gift machinery" | Add. §9 | `hub.js` implements the exporter and receiver roles only: it never acts as gifter, and it proxies references from other sessions through itself. | `hub.js:864, 869, 918-944` |

## Base report: findings by section

### §1 Summary

Corrections 1–5 apply here.

- **"Hibernation works" rests on state placements that are wrong today.**
  The worker's heap holds its guest graph and one pipe session; the hub, the netlayer session
  records and the host endpoint hold everything else (`hub.js:17-20`; `daemon.js:46-53`).
  If the endpoint runs in the DO, each wake after the 10 s hibernation is a restart that rejects
  pending host-owed answers *(inferred; the report does not place the endpoint)*.
  Direction: give each host table and obligation a DO home; Addendum A does this for the hub
  tables only ([its §9](#9-what-goes-away)).
- **The build claim covers two crates, not the engine the worker runs.**
  `ironhorse-vm` and `ironhorse-snapshot` build on stable 1.91.1; `ironhorse-compile`,
  `ironhorse-runtime` and the `store-suite` feature (`ironhorse-snapshot/Cargo.toml:29`) do not.
  Under `panic=abort` even `ironhorse-vm` turns `HeapExhausted` into an instance abort
  (WASM-BLOCKERS B1).
  The report never links WASM-BLOCKERS and never mentions stack, trap, panic or unwinding.
  Direction: cite WASM-BLOCKERS as the prerequisite and list the port as in correction 5.
- **Cold wake and commit cost are not the only go/no-go numbers.**
  Stack determinism (blocker 1) and peak memory per isolate (blocker 2) can each rule the design
  out before latency or commit cost matter.
  Direction: rank them first in Phase 0 ([What Phase 0 needs](#what-phase-0-needs)).
- **"Lock-in stays low" holds for the protocol but not for heaps.**
  Boot fingerprints already match native and wasm32 (`36855d7e…`, `consensus` on both), so only
  the executable hash in the profile blocks moving a heap (blocker 6).
  Direction: a platform-neutral profile, an `import_from_container` path in the local adapter, and
  an engine-upgrade plan (bundle past engines, migrate heaps, or freeze the engine).
- **"Cost scales with use" omits per-message charges.**
  Every DO RPC call is a billed request while incoming WebSocket messages bill at 20:1, and an
  awaited RPC or fetch keeps the object billable until it settles (DO pricing and lifecycle docs).
  Direction: model cost per delivery, including RPC hops and ack traffic.

### §2 Thixotrope today (baseline)

- **"Most of these disciplines already have a direct counterpart" holds only for single-writer
  and commit-before-output.**
  Exactly-once rests on a journal written before the duct and on replay regenerating outbound
  frames under the same sequence numbers, which the hub's watermark deduplicates
  (`durable-worker-transport.js:20-36`).
  The per-crank commit is never a recovery baseline today: recovery starts at the sleep image
  paired with the journal cut (`ironhorse-engine.js:33-37`).
  On a DO it is the only baseline, so outbox retention, acks and the inbound watermark must
  commit inside the crank's `transactionSync`.
  Direction: say so in §2 and design it; Addendum A §4.3 tries ([findings](#42-crank-and-43-hub-to-hub-delivery)).
- **§2 omits that every delivery compiles JavaScript twice.**
  Each NDJSON `eval` compiles source under `catch_unwind` (`main.rs:121-128`), and the adapter
  sends a dispatch eval and a drain eval per inbound frame (`ironhorse-engine.js:286, 297`), each
  followed by a checkpoint (`main.rs:281-282`).
  The VM's public entry points take only compiled code (`interp.rs:2403-2482`), so a byte-level
  `deliver` export is new VM work, and guest `eval` and `Function` need the compiler anyway
  (`main.rs:151`).
  Direction: keep the two-eval protocol for Phase 0 and budget two commits per delivery.
- **§2 omits what the comms hub does, and the worker has no secret identity.**
  The hub transcodes every frame through per-session c-lists, answers sturdyref `fetch` from its
  publications table, verifies gift handoffs and commits watermark, reference changes and
  outgoing frames together (`hub.js:17-35, 2126-2128`).
  Heap-queue frames are pipe-session frames that mean nothing to another worker or an external
  peer until the hub rewrites them.
  The worker's only OCapN key is derived from its worker id, so anyone can compute it
  (`pipe-network.js:40-41`).
  Direction: Addendum A puts the hub tables in each DO; external sessions still need per-hub
  secret keys and a host randomness source.
- **§2 does not give today's costs, which Phase 0 needs as its baseline.**
  The worker resumes eagerly (`main.rs:247`; `machine.rs:1151-1152`), and the adapter hashes and
  copies the whole database on each sleep and wake (`packages/thixotrope/README.md:275-276`).
  On a SES-locked heap a crank took a median of about 24 ms with a 1 KB frame, on a loaded host
  *(native)*.
  First boot is at least two cranks, the boot files and then the `init` dispatch with its 1e9
  budget (`main.rs:249-255`; `ironhorse-engine.js:290`); SES alone ran about 1.49M computrons in
  6.6 s wall, on a loaded host *(Node)*.
  Direction: record these as the comparison baseline, measured on an unloaded machine, and
  consider shipping a pre-booted image through `import_from_container`.
- **§2 omits the reifying endpoint.**
  The daemon hosts system resources, the worker controller and pending host answers in one
  in-process OCapN client (`daemon.js:46-53`); the base report gives these roles to no Cloudflare
  component.
  Direction: Addendum A gives creation and retirement to control; host resources and the
  endpoint's session records still need a home.

### §3 Cloudflare primitives used

- **DO RPC is a transport, not a replacement for the comms hub.**
  Calls on one stub arrive in order, but "There are no ordering guarantees between different
  stubs", and after an exception the stub must be recreated (DO stub docs); a hibernating sender
  recreates its stubs on every wake.
  Direction: sequence numbers, acks and a receiver watermark on every DO-to-DO link (Addendum A
  §4.3, with the fixes below).
- **R2 export and import of heap images are O(heap) in linear memory.**
  `export_to_container` materializes the whole image and then the container bytes
  (`store.rs:3284-3288`), and `import_from_container` decodes the whole image
  (`store.rs:3298-3303`); correction 4 has the measured cost.
  Direction: stream exports and imports page by page, or run them outside the DO.
- **Containers do not keep a heap.**
  "All disk is ephemeral", and "Cloudflare does not guarantee that any container instance will
  run for any set period of time" (Containers FAQ).
  Direction: say where a Container vat's heap persists, for example the fronting DO's SQLite or R2.

### §4 Architecture (superseded by Addendum A)

- **The mapping rows for the comms hub and quarantine are wrong, and rows for the journal and the
  netlayer are missing.**
  "Heap queue → DO RPC call or WebSocket `send`" skips the hub's c-list rewrite (§2 above);
  Addendum A fixes this by putting the hub in the DO.
  PITR cannot quarantine: its methods "apply to the entire SQLite database contents", need
  `ctx.abort()`, and are "not supported in local development" (DO SQLite API docs); quarantine
  today is a durable failure flag plus session retirement (`durable-worker-transport.js:185-190`).
  A PITR restore also rolls back any outbox and watermark tables in the same database, and peers
  holding a higher ack then refuse to resume (`durable-netlayer.js:172`).
  The durable netlayer already has sequence numbers, acks and resume tokens
  (`durable-netlayer.js:4-18`) but is instantiated only by tests.
  Direction: quarantine as a failure row committed outside the halted crank; PITR for operator
  recovery only; reuse the durable netlayer's envelope for external sessions.

### §5 Crank lifecycle and hibernation

Corrections 6–11 apply here.

- **Rule 3 holds for the crank but not for the sends that follow it.**
  Post-commit DO RPC sends must be awaited, and awaiting "opens the input gate, allowing other
  requests to interleave" (Rules of Durable Objects); in e3 a second crank committed on hub A
  while A awaited B (local-workerd).
  Direction: treat post-commit sends as asynchronous work that tolerates interleaved cranks, and
  keep one stub per peer while awake.
- **Rule 4 maps a timer queue that guests do not have.**
  In the engine `Date.now()` returns 0 (`natives/date.rs:50`) and `setTimeout` is undefined; the
  only timer is the host `timer` resource on Node `setTimeout`, whose pending answer rejects
  at-most-once on restart (`resources.js:34-50`; `packages/thixotrope/README.md:655-657`).
  A DO has one alarm, delivered at least once with up to 6 retries, and a non-hibernatable idle
  object is evicted after 70–140 s, killing any `setTimeout` (lifecycle docs).
  Direction: a host timer resource backed by a deadline table multiplexed onto the one alarm,
  with idempotent delivery and a durable answer obligation.
- **Rule 5 describes a `fetch` power that does not exist.**
  No HTTP fetch is exposed to guests (`typeof fetch` is "undefined" in the engine), so an
  in-flight request would be host endpoint state, not heap state.
  Direction: design it as a host resource with a request journal in DO SQL, retrying only
  idempotent requests.
- **Rule 6 and the sketch key sessions by a per-socket UUID and never receive the peer's
  identity.**
  The sketch stores only `{ sessionId }`, not rule 6's `{sessionId, peerId}`, and nothing passes
  the router's authenticated identity to the DO.
  Under Addendum A's resumable sessions a per-socket key orphans state on every reconnect
  (correction 11).
  Direction: keep the random connection id, pass the authenticated peer identity from the router,
  and re-serialize the attachment after the handshake.
- **Rule 7 answers only one exact text frame.**
  Auto-response matches text frames equal to the configured string
  (`legacy-hibernation-manager.c++:559-562`); binary frames always wake the object, while
  protocol-level pings are answered without waking it (local-workerd).
  Direction: use WebSocket protocol pings for keepalive; data-bearing acks cannot use
  auto-response.
- **§5.2 misses most of the wake and first-commit cost (blocker 3).**
  Lazy resume reads every page-edge row and rebuilds the root ledger (`machine.rs:1332, 1350`),
  and the first checkpoint after a wake re-encodes the side-table sections restore marked dirty
  (a 60k-entry Map: 24.7 ms, against 2.6 ms for the next checkpoint) *(native)*.
  With 180,000 free slots, reusing one slot made the checkpoint re-read 1,405 of 1,410 pages, and
  resume took 15.3 ms against 4.0 ms without the free list *(native)*.
  Each fault costs about 3–4 `sql.exec` calls if the DO backend copies the SQLite backend's
  manifest checks *(inferred)*.
  The worker does not use lazy resume (`main.rs:247`), and no production code calls
  `resume_from_store_lazy` (`machine.rs:1325`).
  Direction: before relying on it, defer side-table validation, validate only reused or grown
  slots at checkpoint, make the chunk arena sparse, add per-segment free-list dirty bits, and
  persist or seed the ledger.
- **§5.2's constructor also restores host state on every wake.**
  A restart today reloads the whole hub state (`hub.js:436`) and writes a new answer epoch for the
  endpoint, leaking hub answer rows from every earlier incarnation
  (`worker-session-records.js:221-227`); each DO wake would repeat both *(inferred)*.
  §5.2 opens the store in the constructor while §5.3 resumes lazily in the handler; a constructor
  that throws breaks every event.
  Direction: keep the constructor to the auto-response pair, resume inside the handler's error
  boundary, and persist the question counter instead of bumping an epoch per incarnation.
- **The §5.3 sketch has no error path, and its cached `vat` commits rolled-back state
  (blocker 4).**
  The engine keeps a halted crank's effects: it "retains its activation" and keeps queued jobs
  and metering (`interp.rs:2626-2633`).
  A store commit inside the callback advances the lazy pin (`machine.rs:1099-1102`); if the
  callback then throws, SQL rolls back and the next fault panics with "store advanced under this
  machine" (`machine.rs:1260-1266`).
  An exception from `webSocketMessage` is only logged, and the socket stays open
  (`hibernatable-web-socket.c++:103-110`); a throwing `alarm()` is retried up to 6 times.
  Direction: in every handler, on any exception set `this.vat = undefined` and drop the instance,
  commit a failure row in a separate transaction for deterministic halts, and close or nack the
  session; never throw a deterministic halt out of `alarm()`.
- **The sketch's send loop drops committed frames.**
  Frames leave the heap in the commit that sends them, and `getWebSockets(sid)[0]?.send` is a
  no-op when the socket is gone (found=0 with SQL advanced, local-workerd); workerd also silently
  ignores sends after close (`web-socket.c++:853-854`).
  Direction: a per-session outbox written in the same `transactionSync`, deleted on ack and resent
  on resume (Addendum A §4.3 adopts this).
- **Smaller sketch defects.**
  `webSocketClose` and `webSocketError` are missing although rule 1 names them, and local workerd
  did not answer a client Close on a hibernatable socket until the handler called `ws.close()`
  (local-workerd).
  `Ironhorse.resume` and `vat.deliver` are new APIs, and resume runs outside `transactionSync`, so
  its open-time writes commit even if the handler then throws (local-workerd).
  Views into linear memory detach when memory grows, and `ws.send(view)` then sent a zero-length
  frame without error (local-workerd).
  An `async` `transactionSync` callback is not rejected, and its writes after the first `await`
  commit outside the transaction (local-workerd).
  Direction: add the two handlers, copy frames out with `slice()`, check that `data` is binary,
  and reject a thenable callback result.
- **§5.4's #6087 argument holds for guest objects only.**
  Live host objects are exactly the #6087 class; today they survive a restart only because
  exports are re-seated by description and pending answers reject (`daemon.js:46-53`;
  `ocapn.js:683-686`).
  Direction: make host answer obligations durable, or document which host calls may not span a
  hibernation.

### §6 Heap store port: `ironhorse-store-do`

Corrections 12–14 apply here.

- **The exec/tx ABI needs a stated value and error contract.**
  `sql.exec` binds only blobs, strings, doubles and null (`api/sql.h:29`) and returns integers as
  doubles (`sql.c++:376-380`): a BigInt throws, and `SELECT 9007199254740993` returns
  9007199254740992 (local-workerd).
  A multi-statement `exec` accepts parameters only on its last statement (`sqlite.c++:896-898`).
  A JS exception thrown by an import unwinds through Rust frames without destructors, is not
  caught by `catch_unwind`, and leaves a `RefCell` borrowed, so every later call traps
  (local-workerd; WASM-BLOCKERS Cloudflare section).
  Direction: one statement per `exec`; integers as f64 within u32; a shim that catches every JS
  exception and returns an error code; `extern "C-unwind"` on any import that can re-enter wasm.
- **The reentrant `tx(fn_id)` callback is avoidable (correction 12).**
  `commit_verified` finishes its reads and the verifier (`lib.rs:1011-1098`) before its first
  write, and the §5.3 host already wraps the crank in `transactionSync`, which nests by savepoint.
  A `tx_body` export has no safe way to reach the outer frame's `&mut self` and its non-`'static`
  verifier.
  Direction: reads, verify, then plain writes; report failure as an error that the JS wrapper
  throws.
- **The fresh-database gate refuses a DO that has ever set an alarm.**
  The gate counts `sqlite_master` tables (`lib.rs:249-259`), and `_cf_*` names are blocked for
  access but still listed, case-insensitively (`sql.c++:141-146`).
  `setAlarm()` creates `_cf_METADATA`, which stays after `deleteAlarm()`, and
  `getCurrentBookmark()` creates it too (local-workerd).
  Direction: drop the gate on a DO, or exclude `_cf_%`; stamp the `meta` row at first open.
- **Local workerd cannot gate the 2 MB value cap.**
  It caps values at 4 MiB (`sqlite.c++:1406`) and accepted a 2,097,153-byte blob and a row of two
  1.5 MB blobs (local-workerd); the documented cap is 2 MB.
  Direction: enforce at most 2,000,000 B per bound value and per row in `ironhorse-store-do`,
  with a store-suite case at the boundary.
- **Chunking the small sections fixes the row cap but not commit cost (correction 14).**
  A touched Arrays or Collections section is re-encoded and re-hashed whole
  (`machine.rs:1028-1039`): one `n.set(1,2)` on a small Map, in a heap that also holds a
  200k-entry Map, grew the WAL from 8,272 to 8,083,472 B *(native)*.
  Direction: chunk sections by `(id, chunk)` from day one and write only chunks whose hash changed.
- **The §6.3 item 3 rewrite needs two sets, a size cap and a one-character fix.**
  `reachable_within` takes `roots` and `within`, so it needs two JSON parameters, each a string
  bounded by the 2 MB cap (about 250–300k page numbers), a limit the TEMP tables avoided
  (`lib.rs:528-529`).
  The region-bounded CTE (`lib.rs:754-760`) is quadratic as written: 41,004,796 rows read at
  |within| = 6,400, against 40,000 with `WHERE +e.target IN (SELECT value FROM json_each(?2))`
  and no writes (local-workerd).
  The same `+` takes the native TEMP-table query from 6,946.6 ms to 12.8 ms at that size.
  Direction: specify the `+e.target` form, and fix `ironhorse-store-sqlite` too.
- **Rows written per wake and per page are higher than §6.2 implies.**
  `rebuild_edge_pairs` bills 3 rows written per edge pair, one delete plus an insert that also
  writes the `edge_pairs_by_page` index, and an identical replace still bills 2 (local-workerd).
  Direction: skip the rebuild on open (§6.3 item 5) and never rewrite unchanged rows.
- **§6.2 misses rows that carry over and one that does not.**
  `PRAGMA foreign_keys=ON` is allowlisted and already the default (`sqlite.c++:573`);
  parameterless multi-statement batches and DDL inside `transactionSync` work; `side_tables` is
  never read or written; and the monolithic `small_state` row of schemas before 28 would pass the
  cap sooner.
  The row-3 CTEs read TEMP tables today, so they run only after the item 3 rewrite.
  Direction: port only current-schema heaps, imported through a container, and drop `side_tables`.
- **A minimal Phase 0 store can skip most of §6.3.**
  The trait's dense defaults for `reachable_page_set`, `externally_referenced` and
  `reachable_within` (`store.rs:2007, 2073, 2096`) need no TEMP tables, `json_each` or
  `edge_pairs`, at the cost of reading every page edge per call.
  Direction: implement the 11 required `HeapStore` methods on the `MemoryStore` pattern
  (`store.rs:3378`) first.
- **The rusqlite build failure is the wrong reason for a new backend.**
  It holds for the pinned rusqlite 0.31, but rusqlite 0.40.2 depends on `sqlite-wasm-rs` for
  `wasm32-unknown-unknown` (crates.io).
  Direction: give the real reason: DO durability is reachable only through `ctx.storage.sql`, and
  a SQLite in linear memory would count against the isolate cap.
- **The §6.1 gate cannot run as written.**
  `store-suite` pulls in `ironhorse-compile` (B1) and builds each case on a fresh store, while a
  DO has one database.
  Local workerd cannot restore PITR bookmarks, and `getCurrentBookmark()` returns a synthetic
  all-zero bookmark there (local-workerd).
  Direction: one DO per store-suite case, built with the B1 recipe; PITR tests on a deployed DO.

### §7 Transport topology (superseded by Addendum A)

- **Deploys are one cause of disconnects among several, and sever is the wrong recovery.**
  Runtime updates ("a few times per week") and host moves also terminate WebSockets (Workers
  limits and lifecycle docs).
  Thixotrope's contract is that "A socket error alone is not such a disposition"
  (`designs/thixotrope.md:150`), and the durable netlayer already keeps references alive across
  socket loss.
  Every received frame is acked, so a port doubles wakes per frame, and auto-response cannot
  absorb acks that carry sequence numbers.
  Direction: DOs accept only; the durable netlayer's envelope; batched acks.

### §8 Rollout

- **Phase 0's third bullet expects a result that local measurement already refutes (blocker 3).**
  Direction: use an OCapN-shaped fixture (Map and WeakMap tables, promises, a free list, two
  allocating cranks per delivery), and treat the engine fixes as conditional Phase 0 work.
- **Phase 0 cannot measure memory, CPU or the value cap under local workerd.**
  Direction: see [What Phase 0 needs](#what-phase-0-needs).
- **Phases 2 and 3 overstate portability.**
  "Heaps can move both ways" fails on the profile (correction 4).
  Phase 3's "a peer can't tell where a worker runs" fails because heap ceilings are host policy,
  not stored in the image (`value.rs:10-13`): a Cloudflare ceiling profile halts cranks that
  complete locally, and stack traps differ by host.
  Direction: one ceiling profile everywhere, folded into the runtime profile.

### §9 Risks and open questions

Corrections 15–17 apply here.

- **The cold-wake row lists too few causes.**
  It omits page edges (read twice), restore-validation faults, free-list length and the first
  commit after a wake; "trusting DO storage more" removes none of the VM's restore validation.
  Direction: extend the row and the Phase 0 fixture.
- **A CPU overrun resets the object and loses the failure record.**
  Nothing preempts a synchronous wasm call, and beyond 30 s "there is a heightened chance that the
  individual Durable Object is evicted and reset" (DO limits); a failure marker written inside the
  crank rolls back with it *(inferred; local workerd enforces no CPU limit)*.
  One crank of 2,952,790,083 computrons took 80–139 s (local-workerd), so a 30 s event fits
  roughly 6e8–1.1e9 computrons of simple work and far fewer of underpriced builtins.
  Direction: reprice O(n) builtins so computrons track CPU, and persist a per-input reset counter
  before running the input.
- **"Ironhorse is already an interpreter" hides the wasm slowdown.**
  A RegExp-backtracking workload ran 1.5–2.7× slower than native (WASM-BLOCKERS "Speed").
  Direction: carry the measured factor into the CPU budget and the Containers threshold.
- **§9 misses the stack, traps and guest-driven memory growth.**
  Direction: add blockers 1, 2 and 4 as risks.

### §10 Limits reference

- **§10 gives Workers Paid values without saying so, and omits limits the design meets.**
  On Free, CPU is 10 ms, an object holds 1 GB, and rows written stop at 100,000 per day, with
  failures rather than overage.
  Also missing: 32 MiB per received WebSocket message and per RPC payload; a soft 1,000 requests
  per second per object; 32 arguments per SQL function in the docs (the code allows 127); and the
  undocumented VDBE-op 25,000, expression-depth 100, compound-select 5 and trigger-depth 10 limits
  (`sqlite.c++:1404-1420`).
  The 128 MB row comes from the Workers limits page, which Sources omits, and it is per isolate.
  Direction: state the plan and add these rows.

## Addendum A: findings by section

Findings 1–20 are the addendum review's; one more comes from the base review's check of
in-heap import GC.
Corrections 18–25 apply here.

### §1 Summary and §12 Rollout

- **One vat per DO multiplies a fixed memory cost inside a shared 128 MB isolate (finding 10).**
  Each instance starts at 11,468,800 B of linear memory, 8 MiB of it shadow stack that counts
  toward the limit (STACK-DEPTH-REFACTOR §1.7), and one isolate can host several DOs.
  An accepted program used 2,611,856 B of shadow stack (STACK-DEPTH-REFACTOR §1.2), which bounds
  how far the stack can shrink before the refactors land.
  Direction: measure the per-instance floor and co-residency in Phase 0, derive per-vat ceilings,
  instantiate lazily, recycle instances above a threshold, stream exports.

### §4.2 Crank and §4.3 Hub-to-hub delivery

- **Exactly-once as specified loses a frame (finding 4).**
  Trace:
  1. Hub S commits frame k for session s and calls `R.deliver(s, k)`; S is evicted before the ack.
  2. A new S instance wakes on an unrelated event, commits frame k+1 and sends it on a fresh stub
     ("There are no ordering guarantees between different stubs").
  3. R commits k+1 and advances its watermark to k+1; §4.2 checks only `seq ≤ watermark`.
  4. R receives k, from the dead instance's call or from S's resend, and drops it as a duplicate.
     Frame k is lost, and E-order is broken.

  Nothing wakes an evicted sender unless its resend alarm is already armed, and a `setAlarm` made
  inside a transaction that rolls back is undone (e2: `alarm: null`, local-workerd).
  "Resends everything" contradicts "one delivery in flight", and frames returned in
  `{ack, frames}` have no ack path, so they are lost if the caller dies after the callee commits.
  workerd has an automatic retry path for disconnected DO calls (`api/actor-call-retry.h:75-77`),
  so duplicates are normal traffic.
  Direction: accept only `seq = watermark + 1`; re-ack `seq ≤ watermark`; refuse a gap with a
  retryable code; resend from the lowest unacked frame; arm the resend alarm in the crank's
  transaction whenever the outbox is non-empty, multiplexing resends, guest timers, idle GC and
  leases onto the one alarm; keep returned frames in the callee's outbox until a later call acks
  them; define refusal codes (`not-incarnated`, `retired`, `failed`, fenced-retry,
  `unknown-session`, `overloaded`).
- **One delivery in flight per session caps throughput and has no backpressure (finding 15).**
  A session moves at most one frame per RPC round trip plus crank plus durable commit, and a hub
  awaiting an ack stays billable.
  Received WebSocket messages and RPC payloads may be 32 MiB while a row holds 2 MB, and an object
  is soft-limited to 1,000 requests per second before it answers "overloaded" (DO limits).
  Direction: credit windows and outbox quotas that push back into the vat, frame-size limits or
  chunked rows, backoff on `overloaded`, and throughput in Phase 0.
- **Step 1 blocks admin RPCs and fenced sessions (findings 1, 7).**
  "Refuse the event if `meta.state ≠ active`" refuses `retire` on a fenced or failed hub, and
  refuses existing-session frames while fenced, though §7.3 fences only new sessions and gift
  withdrawals.
  Direction: exempt admin RPCs, and have fenced hubs defer with a retryable code.

### §4.4 External peers

- **External peers get neither exactly-once nor durable references (finding 16).**
  Standard OCapN peers have no sequence numbers or acks; the durable envelope is
  "Thixotrope-specific, not an OCapN standard" (`designs/thixotrope.md:173`).
  A mid-crank reset silently loses their frame, and every deploy drops their live references.
  Direction: close the socket on any failed crank of an ephemeral session, and refuse terminally
  on reconnect to a retired hub; correction 19 fixes the API wording.

### §4.5 RPC surface and §8 Control DO

- **Control holds full authority over its hubs, and reports to it are unauthenticated
  (finding 6).**
  Control supplies `boot` and can export every secret (correction 21).
  A DO sees only per-instance props fixed at creation (`io/worker.c++:4018`), so control cannot
  tell which hub sent `failed(hubId, reason)` or `collectible(hubId, epoch)`, and a `failed` that
  names the wrong hub ends in deletion after retention.
  `deliver(sessionId, …)` and `openSession(peerHubId, …)` carry self-asserted identities.
  A lifecycle capability "exported by control" needs OCapN sessions and c-lists in control,
  contrary to "it never routes data frames".
  Direction: state that control is in each hub's trusted base, or redact exports; store only a
  hash of the control token and compare it in constant time; have control re-verify with
  `report()` before acting; unguessable session IDs; host the lifecycle capability in the
  creator's hub.
- **`incarnate` is both refused and idempotent, and `create` has no request ID (finding 12).**
  §4.5 says `incarnate` is "refused if already incarnated"; §6.1 says it "is idempotent for the
  same token".
  A `create` retried after control eviction mints a second hub, rooted forever by its `shell`
  publication, that nobody holds a lifecycle capability for; the guest's `createWorker` is an
  at-most-once host operation, so its promise may reject while the hub exists.
  The RPC table lacks the unfence and unpublish operations that §7.3 and §6.5 need.
  Direction: `create(requestId)` idempotent; reap created-but-unclaimed hubs after a claim lease;
  `incarnate` idempotent on (token, boot digest, profile); complete the table.
- **`migrate` breaks every live reference (finding 13).**
  Sturdyrefs are `(hub ID, swissnum)` and all name the retired ID, and c-list state is bound to
  it; `export_to_container` carries only the heap image (`store.rs:3284-3288`).
  Writing to R2 lets other events run ("Non-storage I/O like fetch() or writing to R2 allows
  other requests to interleave"; e3), so an unfrozen export is torn.
  Direction: a forwarding redirect, or document `migrate` as clone plus publications; freeze
  during export; include the hub tables; a chunked, resumable export.

### §5 Addressing, capabilities, handoff

- **Publishing `shell` roots every hub from birth and may hand out the evaluator (finding 3).**
  Local Thixotrope keeps the shell out of publications on purpose: "never via the publications
  table, which roots vat GC" (`daemon.js:839-842`), and "evaluator shells do not independently
  root workers" (`packages/thixotrope/README.md:604`).
  With `shell` published, §7.1's "no publications (including `shell`)" never holds, so the test
  "collection spreading along a chain" cannot pass.
  If the publication keeps today's constant swissnum `shell` (`daemon.js:104`;
  `worker-peer.js:86`), a `fetch` on the hub bootstrap (`hub.js:1381-1393`) gives the evaluator to
  anyone who knows the hub ID, and hub IDs appear in every sturdyref.
  Direction: introduce the shell as a live reference in the creator's session; if a sturdyref is
  wanted, publish a random swissnum of at least 128 bits on request.
- **The gifter role does not exist, and a failure mode becomes the normal path (finding 8).**
  `hub.js` implements the exporter role and a receiver role that redeems by dialing the exporter
  (`hub.js:74-82`), which hubs that "never dial out" cannot do for external exporters.
  Deposit and withdrawal travel on different sessions here, so pipelining onto an undeposited
  gift, which breaks (`hub.js:1600-1606`), becomes routine.
  Row identity is per origin session (`hub.js:529-531`), so two sessions between one pair of hubs
  split object identity and E-order; `openSession` is neither idempotent nor ordered with the
  first `deliver`.
  Direction: design the gifter role; queue pipelined messages under the gift key, bounded and
  broken on gifter abort or TTL; one session per hub pair with a tie-break for crossed opens; an
  idempotent `openSession` with an opener-chosen ID; relay-based redemption for external
  exporters; promote Open Question 1 to a blocker.
- **Hub IDs cannot carry a location hint (finding 17; correction 20).**
  Direction: `newUniqueId({ jurisdiction })`; keep the hint in the registry and pass it on
  control's first `get()`, the `incarnate` call; keep control, hubs and the archive bucket in one
  jurisdiction.

### §6 Lifecycle

- **§6.2: resurrect-and-refuse writes, and its signal is too strong (finding 7).**
  With a compat date before 2026-02-24, `deleteAll()` keeps the alarm: after retirement the alarm
  fired on the emptied hub, and `_cf_METADATA` remained (e1 at 2025-06-01; at 2026-03-01 storage
  and alarm were gone; local-workerd).
  The base §5.2 constructor instantiates the module and opens the store, and in e2 a never-used
  ID's constructor ran and committed its `CREATE TABLE` (local-workerd), so each refusal
  instantiates the engine and writes.
  A schema or version bug that reports `not-incarnated` would make every peer abandon a live hub
  for good, and a PITR restore (base §6.3 item 6) rewinds one hub's watermarks under its peers.
  Direction: compat date 2026-02-24 or later, or `deleteAlarm()` before `deleteAll()`; a
  read-only, lazy constructor; `not-incarnated` only when the user schema is empty, confirmed
  with control before peers treat it as permanent; PITR only as restore, new epoch and abort of
  every session.
- **§6.3: best-effort aborts leak export rows forever (finding 9).**
  A peer that only exported to the retired hub never sends to it again, so resurrect-and-refuse
  never tells it, and its export rows pin objects indefinitely; if that peer is rooted, the cycle
  pass never cleans them.
  Direction: retire only after aborts are acked, or deliver them through control using
  `report().importsFrom`; probe sessions idle past a lease.
- **§6.4: host traps and platform resets are not deterministic VM halts (finding 5; blocker 4).**
  In e2 a trap arrived as `RangeError: Maximum call stack size exceeded`: SQL rolled back to 0
  rows, wasm memory kept counter 1, and the next crank on the same instance committed counter 2
  against 1 row (local-workerd).
  Stack traps depend on host and tier (blocker 1), memory overruns on co-resident objects, and a
  CPU overrun resets the object: treating these as fatal kills vats for transient reasons, and
  treating them as retryable loops on a poison frame.
  The `failed` state has to be written in a second transaction, since the halted crank's
  transaction rolls back.
  Direction: classify outcomes as engine halt, host trap or platform reset; on a trap discard the
  instance, do not ack, count traps per (session, seq) in a separate transaction and retry in a
  fresh instance; after K traps park the session as host-limited rather than aborting it; make
  STACK-DEPTH-REFACTOR Phases 1–2 and the ceiling profile Phase 0 gates.

### §7.1 Local signal

- **"Collectible" misses three kinds of liveness, so the condition does not stay true
  (finding 2; correction 22).**
  Traces; each ends with a hub deleted while it is still reachable or still owes an effect:
  1. Unacked outbox: H's crank for `E(x).bye()` runs `E.sendOnly(c).log()` toward hub C, and
     frame k waits unacked because C is slow.
     The next crank processes G's `op:gc-exports`, H's counters reach zero, and H reports
     collectible; retirement runs `deleteAll()` without draining (§6.3), so a committed send is
     lost.
  2. Answer owed: G sends `E(x).getY()` at answer position a, H settles a to y, and G drops x but
     keeps the promise.
     H has no exports and asked no questions, so it is collectible, and G's later pipelined
     delivery to answer a reaches a deleted hub.
     Local Thixotrope treats answer routes as retention edges until `op:gc-answers`
     (`vat-reachability.js:105-121`; `hub.js:1849-1877`).
  3. Gift certificate: gifter F's deposit was answered, so F is collectible while the recipient
     still holds the certificate.
     When F retires, the exporter marks F's session dead and clears its identity
     (`hub.js:1956`), and the withdrawal fails with "unknown gifter session"
     (`hub.js:1311-1312`) *(inferred mapping of "mark rows dead" to session retirement)*.

  A deposit still in the gifter's outbox is invisible at the exporter, so "Gifts in flight count
  as roots in the receiving hub" cannot hold for it.
  Direction: collectible means no export rows (promises included), no answer rows until
  `op:gc-answers`, no gift rows or waiters, no publications, no own pending questions, listens or
  host operations, no guest timers, an empty outbox including control-bound frames, and no
  pending `openSession` or withdrawals: the same list as §7.3's roots.
  Exporters keep a gifter's session identity until every gift keyed to it is withdrawn or
  expires; each trace becomes an acceptance test.
- **"The check costs nothing" is not the cost model of today's hub (finding 18).**
  The counters do not exist: `hub.js` writes its whole state as JSON on every mutating frame
  (`hub.js:51-55`).
  Each message is transcoded twice and booked twice, in the vat's own OCapN tables and in the
  hub rows; trimming the outbox on ack takes another transaction; and an introduction costs four
  pure-JS Ed25519 signatures or verifications (`cryptography.js:164, 183`) plus three RPCs.
  Direction: Phase 0 measures an introduction and idle GC as well as a plain crank, at realistic
  c-list sizes.

### §7.2 Supporting rules

- **Guest GC never reports a release, so exports never drop (from the base review's in-heap GC
  check; correction 23).**
  Ironhorse implements neither `WeakRef` nor `FinalizationRegistry`, so `makeFinalizingMap` falls
  back to a strong `Map` (`packages/ocapn/src/captp/finalize.js:56-58`), and the import table
  never calls `onSlotCollected` (`pairwise.js:80-91`), the only source of `op:gc-exports` and
  `op:gc-answers` (`ocapn.js:1168-1215`).
  Between hubs whose vats both run Ironhorse, export counts only grow, so the local signal fires
  only for hubs no vat ever referenced, and all other garbage waits for the cycle backstop
  *(inferred)*.
  Direction: a deterministic release protocol, for example collecting at a crank boundary and
  releasing unreachable imports, or engine finalization with deterministic timing; until then,
  drop "Collection is mostly local" from §1.
- **Session GC drops unacked frames, and reused IDs meet late duplicates (finding 14).**
  Dropping a session "once both of its c-lists are empty" discards its outbox, including an
  unacked final GC frame, so the peer's count never reaches zero; late duplicates from platform
  retries or stale instances can land on a reused session ID.
  Direction: a close handshake, session IDs never reused (or ID plus epoch), and a
  `session-closed` refusal.

### §7.3 Cycle backstop

- **The verify step retires a live hub (finding 1; correction 24).**
  Trace, with root P holding references into Z and X, and X and Y referencing each other:
  1. Control reports Z, whose `importsFrom` is empty.
  2. P hands x to Z and drops its own reference to X.
  3. Control reports P (`[Z]`), X (`[Y]`) and Y (`[X]`).
  4. Marking from P reaches only P and Z, using Z's stale report, so X and Y are candidates, and
     both fence, since Z is a referrer, not a root.
  5. Verify X: its importers are Y and Z, and Z is not fenced, so X is unfenced.
  6. Verify Y: its only importer, X, was fenced when checked, so Y is retired.
  7. Z → X → Y is live, and X's references to Y now break.

  If fencing refuses gift withdrawals, a pass that ends in "unfence the rest" has already broken
  a live handoff, so the test "a handoff in flight surviving a cycle pass" cannot pass.
  `retire(controlToken, {archive})` carries no pass ID, so a stale control step can retire a hub
  whose fence was lifted.
  Direction: compute the verified set as a greatest fixpoint, repeatedly dropping any fenced hub
  with an importer outside the set, from importer lists read after all fences are in place;
  fences carry a pass ID and a lease; `retire` and unfence carry the pass ID; fenced hubs defer
  withdrawals, `openSession` and frames with a retryable code.

### §9 What goes away

- **Several rows move rather than disappear (finding 19).**
  Tombstones move to peers ("mark rows dead") and to the control registry, which grows without
  bound for eval-per-worker patterns; the idle policy returns as the idle-GC alarm; and the vat
  still speaks OCapN to its in-DO hub.
  The host endpoint must be re-seated on every wake of every hub
  (`worker-session-records.js:215-228`), and its pending answers reject each time *(inferred)*.
  External durable sessions still need sequence numbers and watermarks, not "only between hubs".
  Direction: correct the table, and specify the per-hub host endpoint and its per-wake cost.

### §10 Failure modes

- **Deploys mix versions, and one bad frame aborts a whole session (finding 11).**
  During a gradual deployment "each Durable Object is assigned a Worker version", so hubs on
  versions N and N−1 exchange frames.
  `hub.js` aborts a remote session on any bad frame (`hub.js:1896-1905`) and refuses unknown
  persisted state versions (`hub.js:441-445`), and neither meta nor the RPCs carry a version.
  A single budget-exhausting message quarantines the whole vat (§6.4).
  Direction: a protocol version in `openSession` and in every frame, with N/N−1 compatibility;
  "unsupported version" retryable, not an abort; `schema_version` in meta, with migrations that
  never meet a rollback; for budget exhaustion, roll back and break only the one message.

### Observability and conventions

- **No metrics, and both documents miss conventions (finding 20).**
  Nothing measures outbox depth, retries, alarm exhaustion, traps, fence durations or gift
  waiters.
  The base report was edited in `075c0118` (2026-09-24) but still says Updated 2026-09-23, and
  neither document has the `## Prompt` section that designs/AGENTS.md asks for.

## Contradictions with the engine reports

The completeness critic listed contradictions C1–C10 between the base report and
WASM-BLOCKERS.md at `a9e3b2ab`.
Rechecked against WASM-BLOCKERS.md at `e487f62e`:

| # | Base report | WASM-BLOCKERS.md (`e487f62e`) | Which is right |
|---|---|---|---|
| C1 | §1: builds "as-is"; "one real port" | B1 hard; `ironhorse-compile` and `ironhorse-runtime` fail on both targets; `vm` and `regexp` refusals abort under `panic=abort` | WASM-BLOCKERS. The base report is wrong (correction 5). |
| C2 | §5.3 caches `this.vat` across events | "A trap poisons the instance, cumulatively": discard after any trap | WASM-BLOCKERS, since `e487f62e` corrected the "does not poison" heading. The base report is wrong. |
| C3 | Silent on the stack; picks workerd as host | B3 "hard in browsers and workerd"; the stack refactors are required | WASM-BLOCKERS; the base report must add the stack. WASM-BLOCKERS is imprecise at line 610: "in a Durable Object, 23" is one run after a request pass had tiered V8 up, and a fresh-instance DO run matched 24 of 25 (only `json-stringify-10k` trapped). It should say 23–24 of 25 in either context, depending on tier-up. |
| C4 | §9: 128 MB mitigated by lazy paging, eviction and sharding | B8 "hard under a 128 MB cap"; set ceilings well below the defaults; recycle the instance | WASM-BLOCKERS. The base report is wrong (correction 15). B8's "4–5×" is the string-doubling worst case; push loops halted at 2.1–2.3× (556,335,104 B in Node, 599,392,256 B in workerd), so "up to 4–5×" is more exact. |
| C5 | §1, §8: heaps portable and "can move both ways" | Not investigated; a Thixotrope profile check refuses it first | Both incomplete. WASM-BLOCKERS is out of date: the verification restored two natively written Thixotrope heaps in a wasm32 instance *(Node)*, the SES boot heap (7,651,170 B container) and the counter vat (17,273,470 B), by passing the native profile string; each ran `1+1` and the outbound drain, lazily and eagerly. wasm32 → native was not run. The base report stays wrong until the profile is platform-neutral (correction 4). |
| C6 | §9: "Ironhorse is already an interpreter" | "Speed": 1.5–2.7× slower than native; yet "Not investigated" still lists performance (line 679) | WASM-BLOCKERS' measurement is right and its "Not investigated" entry is stale. The base report understates the cost. |
| C7 | §5.2: "instantiate the WASM module" | Cloudflare section: the module must be bundled | Resolved: WASM-BLOCKERS no longer recommends `WebAssembly.compile` for workerd, and the base report never proposed runtime compilation. Engine upgrades remain (blocker 6). |
| C8 | §6.1: rusqlite "won't build" as the reason for a new backend | B5: bundled SQLite needs a WASI sysroot; keep persistence host-side | Neither is wrong, and both give the same remedy. The base report's reason holds only for rusqlite 0.31; the real reason is that DO durability is reachable only through `ctx.storage.sql`. |
| C9 | §6.1, §9: hold no borrows across a reentrant `tx` | Cloudflare section: "A Durable Object's transaction callback re-enters wasm from JS"; use `extern "C-unwind"` | WASM-BLOCKERS on the mechanics; the base report's rule cannot be met (correction 12). WASM-BLOCKERS states re-entry as a given at line 627; it happens only if the host calls back into wasm from a transaction callback, which the design can avoid. |
| C10 | §4: quarantine through PITR; §5.3 has no fatal path | B1 option 3: drop the instance and restore from the last committed snapshot | WASM-BLOCKERS, for the engine. The base report is wrong: PITR is a whole-database rollback, and quarantine needs a failure row committed outside the halted crank, which Addendum A §6.4 also leaves out. |

Outside C1–C10, STACK-DEPTH-REFACTOR §1.6 lists corrections to B3.
One is still unapplied: the Chromium Worker limit is Blink's 500 KB constant, not the thread's
OS stack that WASM-BLOCKERS.md:537 suggests.

## What Phase 0 needs

Prerequisites:

- A deployed Workers Paid account with `limits.cpu_ms` raised.
  Local workerd enforces no memory or CPU limit (`server.c++:3305-3310`, used at `:5729`),
  accepts values up to 4 MiB, does not implement PITR, and advances `Date.now()` during
  execution, which production does not.
  The Free plan allows 10 ms of CPU, 1 GB per object and 100,000 rows written per day.
- A harness that reads `memory.buffer.byteLength` per instance, Cloudflare's per-isolate memory
  metric and CPU analytics, and the cursors' `rowsRead` and `rowsWritten`, timing across I/O
  rather than with `Date.now()` inside the isolate.

Work items, from the completeness critic, with Addendum A's additions:

1. Build one cdylib with `RUSTC_BOOTSTRAP=1 -Zbuild-std=std,panic_unwind`,
   `-C panic=unwind -C target-feature=+exception-handling`,
   `-C llvm-args=-wasm-use-legacy-eh=false` (exnref) and the `-zstack-size` of
   STACK-DEPTH-REFACTOR §4.7 (E1); `ironhorse-vm` with `consensus`; `extern "C-unwind"` on any
   import that can re-enter wasm; and a CI job (WASM-BLOCKERS B1, B2, B6).
   An exnref build made this way ran in local workerd.
2. Engine session exports that port `main.rs` without threads, `flock`, files or NDJSON: set the
   profile and ceilings, boot, resume lazily, `eval(source, budget)` with the source compiler
   installed, checkpoint, and return the halt class.
   Keep today's two evals per frame for Phase 0.
3. A minimal `ironhorse-store-do`: the 11 required `HeapStore` methods on the `MemoryStore`
   pattern, the dense reachability defaults, `commit_verified` as reads, verify, then plain
   writes with no `tx` import, the `IRON` stamp in a `meta` row with a fresh-DB check that ignores
   `_cf_*`, every value asserted at most 2,000,000 B, integers as f64 within u32, and one
   statement per `exec`.
4. A JS DO host: a static wasm import; instantiate and resume lazily inside `try` in each
   handler; each crank in `transactionSync`; on any exception `this.vat = undefined` and the
   instance dropped; a failure row in a separate transaction for deterministic halts; a
   `sql.exec` shim that returns error codes; fresh memory views after every export call and frames
   copied out with `slice()`; a thenable callback result rejected; `new_sqlite_classes`.
5. A portable runtime profile, `{boot_fingerprint, hostProtocol, bootstrap hashes, crankBudget,
   ceilings}`, used by both the native adapter and the DO.
6. A Cloudflare ceiling profile through `set_chunk_ceiling` and `set_slot_ceiling`, with a test
   that `HeapExhausted` fires below about 100 MiB of linear memory, counting the 11 MiB baseline
   and the 2× growth of the arena vectors.
7. Test heaps: first boot inside the DO from the bundled boot files, the demo counter vat through
   `import_from_container`, and synthetic sweeps (a plain list, Map and WeakMap tables, arrays,
   closures, a large free list).
8. Conditional on the results, engine fixes for a "go": deferred side-table validation; checkpoint
   validation of reused or grown slots only, or installing the validated pages; a sparse or
   headroomed chunk arena; per-segment free-list dirty bits; a persisted or seeded root ledger;
   STACK-DEPTH-REFACTOR Phases 1–2 before production traffic.
9. For Addendum A, a two-hub prototype of the deliver path (outbox, watermark and ack, with the
   §4.3 fixes).

Decisive measurements, ranked:

1. The production DO stack depth against the 25 recursion families and a `JSON.stringify` depth
   sweep.
   If it matches OSS workerd's 984 KiB, accepted programs trap by tier, and the B3 heap stacks
   become mandatory before any heap is shared between local and cloud.
2. Peak linear memory per awake worker, co-residency per production isolate, and whether compiled
   wasm code counts toward 128 MB.
   Local figures: 11 MiB baseline, 42–78 MiB for the counter vat, 67–83 MiB for first boot,
   export and import *(Node)*.
3. Cold wake on production for SES and OCapN heaps with today's engine, split into instantiate
   (Liftoff), resume, first crank and first commit.
   The lazy wasm wake of the counter vat took 781 ms *(Node)*.
4. CPU per crank against computrons (0.12 to 37 million per second), including first boot; it
   decides whether a budget halt can pre-empt the platform reset.
5. Hub-to-hub delivery (Addendum A §12): RPC round-trip latency including the receiver's durable
   commit, and one crank with routing (c-list rewrite plus outbox) against one without.
6. Rows written and read per delivery (two checkpoints today) and for the first commit after a
   wake.
7. The production per-value cap and its error text (2 MB documented, 4 MiB in local workerd).

Acceptance gates, beyond Addendum A §12's six tests:

- the three counterexample traces ([§4.3](#42-crank-and-43-hub-to-hub-delivery),
  [§7.1](#71-local-signal), [§7.3](#73-cycle-backstop)), each as a test that must neither lose a
  frame nor retire a reachable hub;
- trap injection: a trap or thrown error inside a crank leaves memory and SQL in agreement, the
  instance is discarded, and repeated traps park the session;
- a mixed-version deploy: hubs on two Worker versions exchange frames during a gradual
  deployment;
- a fresh DO that has set and deleted an alarm still opens its store.

## Verified as correct

- **Baseline (§2):** one Ironhorse machine and one SQLite store per process, with no XS; a result
  only after the crank and its promise jobs commit; a halted crank is not committed; outbound
  frames are drained by a separate crank; the `flock` leases; the transport owns replay,
  sequences, image selection and quarantine; `close` folds the WAL.
- **Platform (§3, §5.1, §7, §10):** a DO is single-threaded and unique per ID, enforced at event
  start and on storage access; `ctx.storage.sql` is synchronous; one alarm per DO, at least once
  with up to 6 retries; PITR covers 30 days; hibernated DOs accrue no duration; no hook runs
  before hibernation, and in-memory state is discarded; the constructor reruns on wake;
  `setTimeout` and `setInterval` prevent hibernation; auto-response answers without waking; an
  attachment holds 16,384 bytes; outbound WebSockets do not hibernate and pin the object for up
  to 15 minutes; deploys drop sockets; a reset loses the inbound frame; every §10 value is right
  for Workers Paid.
- **Output gates:** they hold `ws.send` (`web-socket.c++:875`) and DO RPC calls and returns
  (`worker-rpc.c++:687-688, 1687-1692`) until writes are durable, and a failed write resets the
  object and discards outgoing messages; the base report's "Result-after-commit" row is right.
- **`transactionSync`:** synchronous; returns the callback's value; nests through per-depth
  savepoints; a throw rolls back SQL, DDL and `setAlarm` (e2).
- **The §5.3 API usage** (`WebSocketPair`, `acceptWebSocket` with tags, `serializeAttachment`, a
  101 response) runs end to end, and attachments and tags survive hibernation (local-workerd).
- **The §6.2 audit:** rows 1, 2, 5, 6, 8, 9, 12 and 13 as written; row 3 after the TEMP rewrite;
  row 4 with the `_cf_` caveat; row 7 apart from correction 13; row 11 inside `transactionSync`.
  Running every SQL literal of `lib.rs` in a DO failed only the 7 PRAGMA literals, the 3 TEMP
  batches and the statements that read those TEMP tables (local-workerd).
- **§6.1 and §6.3:** `HeapStore` is synchronous, with 11 required methods and a documented
  single-writer contract; rusqlite 0.31 with bundled SQLite fails for wasm32 (`stdio.h` not
  found); `sql.exec` is synchronous, so no Asyncify or JSPI is needed; wasm → JS →
  `transactionSync` → wasm re-entry works (local-workerd); items 1, 2, 4 (the section hash covers
  the whole payload) and 6 (`export_to_container` is backend-generic).
- **The engine in workerd:** both exception-handling encodings load with zero imports;
  `HeapExhausted` and early `SyntaxError`s are contained; the boot fingerprint is identical on
  native and wasm32 (`36855d7e…`).
- **Addendum A:** DO RPC does not identify the caller, so a token must separate control from
  data; other events interleave while a hub awaits an RPC, but a synchronous crank stays atomic
  (e3); `deleteAll()` empties the database and any stub can then re-instantiate the ID empty (e1
  at 2026-03-01); pipelining onto an undeposited gift breaks (`hub.js:1600-1606`); local
  `collectVats` rechecks between retirements; the reachability report omits secrets and
  fingerprints session identifiers; every introduction between vats is a handoff in this
  topology.

## Evidence

The verification ran in session scratch that does not survive the session, so the numbers this
review relies on are inlined above, and claims that could not be re-checked were dropped.
Repository `file:line` citations refer to commit `e487f62e`; the code is unchanged since
`5663b155`, where the verification ran.
Quotes from the two design documents match their current text (`075c0118`).
WASM-BLOCKERS.md citations use its text at `e487f62e`, and STACK-DEPTH-REFACTOR.md citations use
its text at `11781239`, which is current at `e487f62e`.
workerd citations (`src/workerd/…`, `src/cloudflare/…`) refer to commit
`62935d76771b2361e507c7f18f064c5bab43c314` (2026-09-23).
Cloudflare documentation was fetched from developers.cloudflare.com on 2026-09-23 and 2026-09-24.
Runtimes: workerd 1.20260923.1 from npm (V8 15.4.80.5) and 1.20260921.1 under wrangler 4.137.0;
Addendum A's experiments e1–e3 used Miniflare 4.20260730.0 with workerd 1.20260730.1; Node
22.22.2; Rust 1.91.1.

## Prompt

This review was produced by a verification workflow and an adversarial reviewer.
The workflow ran one verifier and one adversarial skeptic for each of ten claim groups of the
base report, then a completeness critic; a separate adversarial reviewer checked Addendum A.
They were prompted by the author's requests.
For the base report:

> add this report as well. its the primary goal, wasm compat work is a prerequisite

For Addendum A:

> heres an addition Thixotrope-on-Cloudflare design doc

And the standing request:

> do an adversarial subagent review loop
