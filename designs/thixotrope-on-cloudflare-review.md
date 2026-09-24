# Thixotrope on Cloudflare: verification review

| | |
|---|---|
| **Created** | 2026-09-24 |
| **Updated** | 2026-09-24 |
| **Author** | Aaron Davis (prompted) |
| **Status** | Reference |

*Verification review of [Thixotrope on Cloudflare](thixotrope-on-cloudflare.md) (the base report)
and [Addendum A, Single-Vat Hubs](thixotrope-on-cloudflare-addendum-single-vat-hub.md).*

The base report was checked at `5663b155`, whose text differs from `075c0118` only by the
supersession notes; Addendum A was checked at `075c0118`.
Commit `d067226a` then added metadata, correction markers and `## Prompt` sections to both
documents without changing their text.
Every quote below is copied from the current text.
Claims were checked statically against the repository code, the workerd source and the Cloudflare
documentation, and by experiments in local workerd.
Each of ten claim groups over the base report had one verifier pass and one adversarial skeptic
pass, and a completeness critic followed; where the skeptic overturned the verifier, its verdict
and evidence are used.
A separate adversarial review of Addendum A ran three local workerd experiments (e1–e3); its
findings are cited as "finding 1" to "finding 20".
That review is not published on its own:
[Addendum A: findings by section](#addendum-a-findings-by-section) summarizes each finding where
it is cited.
All of it was re-checked against [WASM-BLOCKERS.md](../rust/engine/WASM-BLOCKERS.md) and
[STACK-DEPTH-REFACTOR.md](../rust/engine/STACK-DEPTH-REFACTOR.md) at `d152375e`, and later
revisions of this review follow those reports' own corrections.
*(inferred)* marks inference.
**local-workerd** marks results measured only in local workerd, which enforces no CPU or memory
limit and caps a value at 4 MiB where the documentation says 2 MB.
*(Node)* and *(native)* mark the wasm32 build run under Node 22 and the native build.

## Verdict

The platform half of the base report mostly holds: the SQL authorizer audit, the Hibernation API
rules, output gating, the synchronous crank and the limits table are accurate apart from
corrections 6, 13 and 14.
Ironhorse compiled to wasm runs in a SQLite-backed Durable Object: on fresh instances 24 of 25
recursion families match native, and every mismatch is a trap, never a wrong answer
(local-workerd).
The engine half does not hold.
The port is not one `HeapStore` backend: it needs an unstable-toolchain build with the compiler
on every delivery, a host stack the platform will not raise, a memory budget shared with
co-resident objects, and a host that drops the instance after any trap or rollback.
Lazy resume does not make a wake cost the pages a message touches, and the CapTP tables and host
obligations that the report places in the heap are host state today.
Addendum A's central idea, one vat and its routing tables committed in one `transactionSync` per
crank, is sound and removes the hub↔worker journal and replay.
Its protocols are not ready: counterexamples retire reachable hubs and lose a frame, local
collection cannot fire because Ironhorse vats never send GC messages, and the gifter role it
relies on does not exist.

Rows 1–3 can each rule the design out, rows 4–5 are prerequisite engineering for Phase 0, and
rows 6–11 block Phase 2.
"U" and "C" are the completeness critic's items.
U1–U7 are the seven of its twelve unstated blockers that the table cites: U1, the compiler runs
on every delivery; U2, the platform fixes the stack; U3, the instance must be dropped after any
exception; U4, the memory budget; U5, lazy resume; U6, exactly-once delivery and host state;
U7, engine identity and upgrades.
C1–C10 are its contradictions with WASM-BLOCKERS
([below](#contradictions-with-the-engine-reports)).

| # | Blocker | Affects | Evidence (short) | Blocks |
|---|---|---|---|---|
| 1 | The host call stack is fixed by the platform and too small: programs the engine accepts natively trap, at a depth that moves with V8 tier-up | Base §1, §8, §9 (not mentioned); Add. §6.4 | `JSON.stringify` of nested arrays traps from depth 1,343–1,529 where native accepts 2,000; only self-hosted `v8Flags` raise the stack (local-workerd; WASM-BLOCKERS B3 and Cloudflare section; STACK-DEPTH-REFACTOR §1.5). U2, C3 | Phase 0 go/no-go; Phase 2 until STACK-DEPTH-REFACTOR Phases 1–2 land, with the trapped-Proxy ceilings still trapping until its Phase 4 (B10) |
| 2 | 128 MB is per isolate and shared by co-resident objects; the default ceilings let a string heap reach 0.56–1.2 GB of linear memory, array items and side tables are bounded by no ceiling, and linear memory never shrinks | Base §1, §9, §10; Add. §1 | 11,468,800 B per instance before any heap; demo counter vat 42.13 MiB lazy, 60.31 MiB eager at wake, 59.56 / 77.75 MiB after one chunk-allocating crank *(Node)*; string push loops halt at the default chunk ceiling at 556,335,104 B *(Node)* and 599,392,256 B (local-workerd), and string doubling reaches 1.21 GB (Wasmtime); an overrun replaces the isolate (WASM-BLOCKERS B7, B8). U4, C4, finding 10 | Phase 0 (ceiling profile and admission); Phase 2 |
| 3 | Lazy resume does not make a wake cost the pages a message touches | Base §5.2, §8 Phase 0, §9 | 977 of 1006 slot pages resident right after opening the counter vat; wake 314–340 ms lazy against 321–397 ms eager on the real SQLite backend *(native)*; an allocating checkpoint re-reads every non-resident page (`value.rs:899-919`). U5 | Phase 0 go/no-go (latency) |
| 4 | Reusing the cached instance after a trap or rollback commits state that SQL rolled back | Base §5.3 `this.vat ??=`, §6.1 `tx`; Add. §4.2, §6.4 | with a JS stand-in for the vat, SQL count 3 while the stand-in held 4, then the next crank committed 5 (local-workerd); each trap leaks about 4.1 MiB of linear memory and some shadow stack, and every call fails after about ten traps; guests can trigger traps (B3, B7). Merges U3, finding 5 and WASM-BLOCKERS "A trap poisons the instance" | Phase 0 (host contract) |
| 5 | The engine the worker needs does not build on stable Rust, and the compiler runs on every delivery | Base §1, §2, §6.1 | `ironhorse-compile` refuses `panic=abort` (`lib.rs:30-31`); the worker compiles every eval (`main.rs:121-128`); two source-text evals per inbound frame (`ironhorse-engine.js:286, 297`); the working build needs `RUSTC_BOOTSTRAP=1 -Zbuild-std` (WASM-BLOCKERS B1). U1, C1 | Phase 0 (build) |
| 6 | Heaps cannot move between native and wasm32 or between engine versions: the profile pins one executable, the two targets still diverge, and a Worker cannot load another engine at run time | Base §1, §8 Phases 2–3 | The profile hashes the worker executable (`ironhorse-runtime.js:117-129`) and resume requires exact equality (`format.rs:437-438`); an audit found 27 native-versus-wasm32 divergence sites (WASM-BLOCKERS B7); workerd refuses runtime wasm compilation (`jsg/setup.c++:623-627`). U7, C5 | Phase 2: the first engine deploy orphans every hibernated heap; Phase 3 |
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
| 4 | "Cloudflare provides storage, compute and connection hosting, and heap images stay portable to" | Base §1 | Not with today's runtime profile: it hashes the worker executable and resume requires an exact match, so the native worker refuses a wasm-written heap and vice versa. Native and wasm32 also still diverge (B7), and in-DO export and import each add about 3–3.5× the container size in linear memory (the import run measured 4.3× because it also kept every imported row in an in-instance `MemoryStore`). | `ironhorse-runtime.js:117-129`; `format.rs:437-438`; WASM-BLOCKERS B7; 17,273,470 B container: export 11.00→68.81 MiB, import 11.31→82.56 MiB *(Node)* |
| 5 | "The one real port is a new `HeapStore` backend over the DO SQL API." | Base §1 | The worker also needs `ironhorse-compile`, on every delivery, which refuses `panic=abort`; `ironhorse-vm` refusals abort under `panic=abort`; and the port needs stack work (B3), heap ceilings (B8), a new worker loop and host ABI (B5), and adoption of lazy resume, which the worker does not use. | `ironhorse-compile/src/lib.rs:30-31`; `main.rs:121-128, 247`; WASM-BLOCKERS B1, B3, B5, B8 |
| 6 | "Never call `ws.accept()` or `addEventListener`, because registered listeners keep the isolate" | Base §5.1 | Only `ws.accept()` makes a socket non-hibernatable. On a socket passed to `acceptWebSocket`, `addEventListener` "does nothing" and does not pin the object. | `actor-state.h:666-671`; a DO with a listener registered was evicted after 13 s idle (local-workerd) |
| 7 | "slot pages and chunk extents are faulted in on demand." | Base §5.2 | Restore validation faults every page that holds a side-table owner or a directly referenced value, and the lazy chunk arena allocates the full chunk length at attach. | `persist.rs:69, 118`; `value.rs:1850`; 977 of 1006 slot pages resident after opening the counter vat |
| 8 | "A wake costs roughly the metadata plus the pages the message touches." | Base §5.2 | A wake also reads the whole small state twice and every page-edge row, restores every side table eagerly and faults the pages they reference; a crank that allocates then makes its checkpoint re-read every non-resident page. | `machine.rs:1332-1333, 1412-1415`; `value.rs:899-919`; wake 314–340 ms lazy against 321–397 ms eager *(native)* |
| 9 | "export class ThixotropeWorker extends DurableObject {" | Base §5.3 | `DurableObject` is not a global: import it from `cloudflare:workers`, and declare the class under `new_sqlite_classes`, or `transactionSync` throws "Durable Object is not backed by SQL." | `src/cloudflare/workers.ts:13`; `actor-state.c++:781`; `typeof DurableObject` is "undefined" (local-workerd) |
| 10 | "// crank + drain queue + commit dirty pages" | Base §5.3 | Inside `transactionSync` the store's commit only releases a savepoint; durability comes from the output-gated implicit commit after the callback returns, and a later throw in the callback rolls the "commit" back. | `actor-state.c++:751-776` |
| 11 | "Session identity is re-established from the attachment, and CapTP tables are rebuilt as heap" | Base §5.4 | Map, WeakMap and Array tables are small-state side tables restored eagerly on every wake, and the hub's tables are host state. A durable session is keyed by the resume token in the first `hello`, which arrives after `acceptWebSocket`, so the attachment must be rewritten after the handshake. | `machine.rs:1412-1415`; `durable-netlayer.js:387-397` |
| 12 | "This is a reentrant call into the guest, so hold no `RefCell` borrows (e.g. `root_cache`)" | Base §6.1 | `root_cache` is a plain `Option<RootLedger>` field. Under lazy resume the caller necessarily holds the store's `RefCell` borrow across the commit, so the rule cannot be met; drop the reentrant `tx` import instead. | `ironhorse-store-sqlite/src/lib.rs:214`; `machine.rs:581-584` |
| 13 | "`PRAGMA application_id / locking_mode / journal_mode / wal_autocheckpoint / synchronous`, `busy_timeout`" | Base §6.2 | `busy_timeout` is set through rusqlite's C API, not a PRAGMA; it has no DO counterpart and is dropped with the others. `user_version` is denied too, so a `meta` row is the only place for the stamp. | `lib.rs:276`; `sqlite.c++:562-591` |
| 14 | "Can exceed the 2 MB row cap on large heaps" | Base §6.2 | The Arrays section passes 2,000,000 B at about 83k array elements summed over the heap (24 B each), in a heap file of about 2 MB; Collections at about 50k entries. The counter vat's Functions section is already 1,376,481 B. An over-cap value fails the whole commit, so the row is ❌. | Row sizes measured through `SqliteHeapStore` *(native)* |
| 15 | "Lazy paging, evicting cold pages, sharding across DOs, Containers for outliers" | Base §9 | Lazy paging does not bound memory (corrections 7–8); no production code evicts; evicting a chunk extent frees nothing; wasm memory never shrinks; and DOs of one Worker may share an isolate and its 128 MB. | `store_suite.rs:246-293` (only callers); `value.rs:1914-1936`; DO in-memory-state docs |
| 16 | "O(dirty) commits already. Batch small frames; skip commits for read-only cranks" | Base §9 | Every crank dirties at least the Meter section and the manifest row, so no crank is read-only. A touched Arrays or Collections section is re-encoded whole, the free list is re-encoded at every checkpoint, and a dirty page with k outgoing edges costs about 4 + 3k billed rows. | `lib.rs:1332-1351, 1278-1283`; `machine.rs:1028-1052`; `rowsWritten` (local-workerd) |
| 17 | "Computron budgets already exist; split long work across alarm cranks" | Base §9 | A budget refusal ends the crank as a fatal halt; the engine cannot resume it in a later alarm. Computrons also do not bound CPU time: measured rates run from 0.119 M computrons/s (`indexOf` over a 2 MB string, *Node*) to about 37 M/s (a backtracking RegExp, local-workerd). | `interp.rs:2286-2287`; WASM-BLOCKERS Cloudflare section, "CPU"; `/^(a+)+$/` on 24 `a`s and a `b`: 184,549,438 computrons in 4.98–8.78 s (local-workerd) |
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
  The heap holds the guest graph and one pipe session; the hub, the netlayer records and the host
  endpoint hold the rest (`hub.js:17-20`; `daemon.js:46-53`).
  Direction: give each host table and obligation a DO home; Addendum A does so for hub tables only.
- **The build claim covers two crates, not the engine the worker runs.**
  `ironhorse-compile`, `ironhorse-runtime` and the `store-suite` feature
  (`ironhorse-snapshot/Cargo.toml:29`) do not build for wasm32 on stable, and under `panic=abort`
  even `ironhorse-vm` turns `HeapExhausted` into an abort (WASM-BLOCKERS B1).
  The report never links WASM-BLOCKERS and never mentions stack, trap, panic or unwinding.
  Direction: cite WASM-BLOCKERS as the prerequisite and list the port as in correction 5.
- **Cold wake and commit cost are not the only go/no-go numbers.**
  Stack determinism and peak memory per isolate (blockers 1–2) can each rule the design out first.
  Direction: measure them first ([What Phase 0 needs](#what-phase-0-needs)).
- **Heaps are not portable yet.**
  Boot fingerprints match native and wasm32 (`36855d7e…`, with `consensus` on both), but the
  profile hashes the executable (correction 4), and the targets still diverge at 27 audited sites,
  with fixes prototyped for 11 of them and validated on eight repros (WASM-BLOCKERS B7).
  Direction: a platform-neutral profile, the B7 fixes, container import in the local adapter,
  and an engine-upgrade plan.
- **"Cost scales with use" omits per-message charges (correction 3).**
  Each DO RPC call is a billed request while incoming WebSocket messages bill at 20:1, and an
  awaited RPC or fetch keeps the object billable until it settles (DO pricing).
  Direction: model cost per delivery, including RPC hops and acks.

### §2 Thixotrope today (baseline)

- **Only single-writer and commit-before-output have direct DO counterparts.**
  Exactly-once rests on a journal written before the duct and on replay regenerating frames under
  the same sequence numbers (`durable-worker-transport.js:20-36`).
  The per-crank commit is never a recovery baseline today (`ironhorse-engine.js:33-37`); on a DO
  it is the only one, so outbox, acks and watermark must commit in the crank's transaction.
  Direction: state this in §2; Addendum A §4.3 designs it, with the defects listed below.
- **Every delivery compiles JavaScript twice.**
  Each `eval` compiles under `catch_unwind` (`main.rs:121-128`), and the adapter sends a dispatch
  eval and a drain eval per frame (`ironhorse-engine.js:286, 297`), each checkpointed
  (`main.rs:282`).
  The VM's run entry points take only compiled code (`interp.rs:2403-2482`), so a byte-level
  `deliver` export is new VM work.
  Direction: keep two evals and two commits per delivery for Phase 0.
- **§2 omits the comms hub, the reifying endpoint and the worker's derivable key.**
  The hub rewrites every frame through per-session c-lists, serves sturdyref `fetch`, verifies
  handoffs, and commits watermark and outgoing frames together (`hub.js:17-35, 2126-2128`).
  The endpoint hosts system resources, the worker controller and pending host answers
  (`daemon.js:46-53`), and the worker's only OCapN private key derives from its id, so anyone
  can compute it (`pipe-network.js:40-41`).
  Direction: place each on Cloudflare; external sessions need secret keys and host randomness.
- **§2 gives no cost baseline for Phase 0.**
  The worker resumes eagerly (`main.rs:247`), and the adapter copies the whole database on every
  sleep and wake (`packages/thixotrope/README.md:275-276`); a crank on a SES-locked heap took a
  median of about 24 ms with a 1 KB frame, on a loaded host *(native)*.
  First boot is at least two cranks (`main.rs:249-255`; `ironhorse-engine.js:290`), and SES alone
  ran about 1.49M computrons in 6.6 s wall, on a loaded host *(Node)*.
  Direction: record these baselines on an unloaded machine, and consider a pre-booted image.

### §3 Cloudflare primitives used

- **DO RPC is a transport, not a comms hub.**
  "There are no ordering guarantees between different stubs", a stub must be recreated after an
  exception (DO stub docs), and a hibernated sender has lost its stubs.
  Direction: sequence numbers, acks and a receiver watermark on every DO-to-DO link.
- **R2 export and import are O(heap) in linear memory.**
  Both materialize the whole image (`store.rs:3284-3303`); correction 4 has the measured cost.
  Direction: stream them page by page, or run them outside the DO.
- **Containers do not keep a heap.**
  "All disk is ephemeral", and no instance is guaranteed to run for any set period (Containers
  FAQ).
  Direction: say where a Container vat's heap persists, such as the fronting DO's SQLite or R2.

### §4 Architecture (superseded by Addendum A)

- **The quarantine row is wrong, and rows for the journal and the netlayer are missing.**
  PITR methods "apply to the entire SQLite database contents", are typically followed by
  `ctx.abort()`, and are "not supported in local development"; a rollback also rewinds outbox and
  watermark tables, and peers holding a higher ack then refuse to resume
  (`durable-netlayer.js:172`).
  Quarantine today is a failure flag plus session retirement
  (`durable-worker-transport.js:185-190`).
  The durable netlayer already has sequence numbers, acks and resume tokens
  (`durable-netlayer.js:4-18`), but only tests instantiate it.
  Direction: a failure row committed outside the halted crank, PITR for operators only, and the
  netlayer's envelope for external sessions.

### §5 Crank lifecycle and hibernation

Corrections 6–11 apply here.

- **Rule 3 holds for the crank but not for the sends after it.**
  An awaited RPC "opens the input gate, allowing other requests to interleave" (Rules of Durable
  Objects); in e3 a second crank committed while hub A awaited B (local-workerd).
  Direction: keep one stub per peer, and make post-commit sends tolerate interleaved cranks.
- **Rules 4 and 5 map timers and a `fetch` that guests do not have.**
  In the engine `Date.now()` returns 0 (`natives/date.rs:50`) and `setTimeout` and `fetch` are
  undefined; the only timer is a host resource on Node `setTimeout` whose pending answer rejects
  on restart (`resources.js:34-50`).
  A DO has one alarm, delivered at least once with up to 6 retries.
  Direction: host resources backed by DO tables, a deadline table multiplexed onto the alarm and a
  request journal that retries only idempotent requests.
- **Rule 6 and the sketch key sessions by a per-socket UUID and never learn the peer.**
  The sketch stores `{ sessionId }`, not rule 6's `{sessionId, peerId}`, so under resumable
  sessions every reconnect orphans state (correction 11).
  Direction: pass the router's authenticated peer identity, and rewrite the attachment after the
  handshake.
- **Rule 7 answers only one exact text frame.**
  Binary frames always wake the object (`legacy-hibernation-manager.c++:559-562`), while protocol
  pings are answered without waking it (local-workerd).
  Direction: keep alive with protocol pings; data-bearing acks cannot use auto-response.
- **§5.2 misses most of the wake and first-commit cost (blocker 3).**
  Lazy resume reads every page-edge row and rebuilds the root ledger (`machine.rs:1332, 1350`),
  and the first checkpoint re-encodes restored side tables (a 60k-entry Map: 24.7 ms against
  2.6 ms for the next) *(native)*.
  With 180,000 free slots, reusing one slot made the checkpoint re-read 1,405 of 1,410 pages
  *(native)*.
  No production code calls `resume_from_store_lazy` (`machine.rs:1325`).
  Direction: deferred side-table validation, checks of reused or grown slots only, a sparse chunk
  arena, free-list dirty bits and a persisted ledger.
- **§5.2's constructor would restore host state on every wake.**
  A restart reloads the whole hub state (`hub.js:436`) and writes a new endpoint answer epoch,
  leaking hub answer rows (`worker-session-records.js:221-227`) *(inferred for a DO wake)*.
  Direction: keep the constructor to the auto-response pair, and resume inside the handler's
  error boundary as §5.3 does.
- **The §5.3 sketch has no error path, and its cached `vat` commits rolled-back state
  (blocker 4).**
  After a halt the engine keeps the crank's heap effects, queued jobs and metering for the next
  run (`interp.rs:2626-2633`).
  A store commit inside the callback advances the lazy pin (`machine.rs:1099-1102`); if the
  callback then throws, the next fault panics with "store advanced under this machine"
  (`machine.rs:1260-1266`).
  A throw from `webSocketMessage` is only logged and leaves the socket open
  (`hibernatable-web-socket.c++:103-110`), and a throwing `alarm()` is retried up to 6 times.
  Direction: on any exception drop the instance, commit a failure row separately, and close or
  nack the session.
- **The send loop drops committed frames.**
  `getWebSockets(sid)[0]?.send` does nothing for a closed session (found=0 with SQL advanced,
  local-workerd), and workerd ignores sends after close (`web-socket.c++:853-854`).
  Direction: an outbox written in the same transaction, deleted on ack and resent on resume.
- **Smaller sketch defects.**
  `webSocketClose` and `webSocketError` are missing, and local workerd did not answer a client
  Close until the handler called `ws.close()` (local-workerd).
  Resume runs outside `transactionSync`, so open-time writes commit even if the handler throws;
  after memory grows, `ws.send(view)` sent a zero-length frame; and an `async` callback's writes
  after its first `await` commit outside the transaction (local-workerd).
  Direction: add the handlers, copy frames out with `slice()`, and reject thenable callback
  results.
- **§5.4's #6087 argument holds for guest objects only.**
  Live host objects are the #6087 class, and they survive a restart only through re-seating by
  description and at-most-once rejection (`ocapn.js:683-686`).
  Direction: make host answer obligations durable, or list the host calls that may not span a
  hibernation.

### §6 Heap store port: `ironhorse-store-do`

Corrections 12–14 apply here.

- **The exec ABI needs a value and error contract.**
  `sql.exec` binds blobs, strings, doubles and null (`api/sql.h:29`) and returns integers as
  doubles (`sql.c++:376-380`); only the last statement of a batch may take parameters
  (`sqlite.c++:896-898`).
  A JS exception from an import escapes `catch_unwind`; through an `extern "C"` import it also
  skips Rust destructors and leaves a `RefCell` borrowed (local-workerd), while through
  `extern "C-unwind"` the destructors run (WASM-BLOCKERS Cloudflare section).
  Direction: one statement per call, integers as f64 within u32, error codes instead of throws,
  and, if any call re-enters wasm, `extern "C-unwind"` on the re-entered export and on the import
  that calls back.
- **The reentrant `tx(fn_id)` callback is avoidable (correction 12).**
  `commit_verified` does all its reads and the verifier (`lib.rs:1011-1098`) before its first
  write, and the §5.3 host already wraps the crank in `transactionSync`.
  Direction: reads, verify, then plain writes, with failure returned as an error the host throws.
- **The fresh-database gate would refuse an unstamped DO that has ever set an alarm.**
  It counts `sqlite_master` tables (`lib.rs:249-259`), which still list `_cf_*` names
  (`sql.c++:141-146`); `setAlarm()` and `getCurrentBookmark()` create `_cf_METADATA`, and
  `deleteAlarm()` leaves it (local-workerd).
  Direction: drop the gate on a DO, or exclude `_cf_%` names.
- **Local workerd cannot gate the 2 MB value cap.**
  It caps values at 4 MiB (`sqlite.c++:1406`) and accepted a 2,097,153-byte blob (local-workerd).
  Direction: assert at most 2,000,000 B per value and per row in the backend itself.
- **Chunking the small sections fixes the cap but not commit cost (correction 14).**
  A touched section is re-encoded whole (`machine.rs:1028-1039`): one `n.set(1,2)` beside a
  200k-entry Map grew the WAL from 8,272 to 8,083,472 B *(native)*.
  Direction: chunk by `(id, chunk)` from day one, and write only the chunks that changed.
- **The §6.3 item 3 rewrite needs two sets, a size cap and a `+`.**
  `reachable_within` needs `roots` and `within` as two JSON strings, each under the 2 MB cap
  (about 250–300k page numbers), a limit the TEMP tables avoided (`lib.rs:528-529`).
  As written the CTE (`lib.rs:754-760`) read 41,004,796 rows at |within| = 6,400; with
  `WHERE +e.target IN (SELECT value FROM json_each(?2))` it read 40,000 (local-workerd).
  Direction: specify the `+e.target` form, and apply it to `ironhorse-store-sqlite` too.
- **Rows written are higher than §6.2 implies.**
  `rebuild_edge_pairs` bills 3 rows per edge pair because the index write counts, and an
  identical replace still bills 2 (local-workerd).
  Direction: no rebuild on open (§6.3 item 5), and no rewrites of unchanged rows.
- **§6.2 leaves out rows that carry over, and a TEMP dependency.**
  `PRAGMA foreign_keys=ON` is allowlisted (`sqlite.c++:573`), parameterless batches and DDL work
  inside `transactionSync`, `side_tables` is dead schema, and the row-3 CTEs read TEMP tables.
  Direction: port only current-schema heaps, starting from the trait's dense defaults
  (`store.rs:2007, 2073, 2096`), which need neither item 3 nor item 5 of §6.3.
- **The §6.1 gate cannot run as written.**
  `store-suite` pulls in `ironhorse-compile` and builds each case on a fresh store, while a DO has
  one database; local workerd returns a synthetic all-zero PITR bookmark and cannot restore one
  (local-workerd).
  Direction: one DO per case with the B1 build, and PITR tests on a deployed DO.

### §7 Transport topology (superseded by Addendum A)

- **Deploys are one of several disconnect causes, and sever is the wrong recovery.**
  Runtime updates "a few times per week" and host moves also drop sockets (Workers limits and
  lifecycle docs), and Thixotrope holds that "A socket error alone is not such a disposition"
  (`designs/thixotrope.md:150`).
  Direction: accept-only DOs using the durable netlayer's envelope with batched acks.

### §8 Rollout

- **Phase 0's third bullet expects what blocker 3 already refutes.**
  Direction: an OCapN-shaped fixture (Map and WeakMap tables, promises, a free list, two
  allocating cranks per delivery), with the engine fixes as conditional Phase 0 work.
- **Phases 2 and 3 overstate portability.**
  Heaps cannot move yet (correction 4, B7), and ceilings are host policy not stored in the image
  (`value.rs:10-13`), so a Cloudflare ceiling profile halts cranks that complete locally.
  Direction: one ceiling profile everywhere, folded into the runtime profile.

### §9 Risks and open questions

Corrections 15–17 apply here.

- **A CPU overrun resets the object and loses the failure record.**
  Past 30 s "there is a heightened chance that the individual Durable Object is evicted and reset"
  (DO limits), and a marker written inside the crank rolls back with it *(inferred)*.
  One crank of 2,952,790,083 computrons took 80–139 s (local-workerd), so 30 s fits roughly
  6e8–1.1e9 computrons of simple work.
  Direction: reprice O(n) builtins, and persist a per-input reset counter before running it.
- **The cold-wake and interpreter rows understate cost.**
  The wake causes in §5 above are missing, and wasm runs 1.5–2.7× slower than native
  (WASM-BLOCKERS "Speed").
  Direction: extend both rows, and add blockers 1, 2 and 4 as risks.

### §10 Limits reference

- **§10 gives Workers Paid values without saying so, and omits limits the design meets.**
  On Free, CPU is 10 ms, an object holds 1 GB, and rows written stop at 100,000 per day.
  Missing: 32 MiB per received WebSocket message and per RPC; a soft 1,000 requests per second
  per object; 32 arguments per SQL function (the code allows 127); and the undocumented VDBE-op,
  expression-depth, compound-select and trigger-depth limits (`sqlite.c++:1404-1420`).
  The 128 MB figure comes from the Workers limits page, which Sources omits, and is per isolate.
  Direction: state the plan, and add these rows.

## Addendum A: findings by section

Findings 1–20 are the addendum review's; one more applies the base review's in-heap GC check.
Corrections 18–25 apply here.

### §1 Summary and §12 Rollout

- **One vat per DO multiplies a fixed memory cost inside a shared isolate (finding 10).**
  Each instance starts at 11,468,800 B, 8 MiB of it shadow stack that counts toward 128 MB
  (STACK-DEPTH-REFACTOR §1.7), and an accepted program used 2,611,856 B of that stack (§1.2).
  Direction: measure the per-instance floor and co-residency, derive per-vat ceilings, and
  recycle large instances.

### §4.2 Crank and §4.3 Hub-to-hub delivery

- **Exactly-once as specified loses a frame (finding 4).**
  Trace:
  1. Hub S commits frame k and calls `R.deliver(s, k)`; S is evicted before the ack.
  2. A new S instance wakes on another event, commits k+1 and sends it on a fresh stub ("There
     are no ordering guarantees between different stubs").
  3. R commits k+1 and moves its watermark to k+1, since §4.2 checks only `seq ≤ watermark`.
  4. R then receives k, from the dead call or a resend, and drops it as a duplicate: k is lost.

  Nothing wakes an evicted sender unless its resend alarm is armed, and a `setAlarm` inside a
  rolled-back transaction is undone (e2, local-workerd).
  Frames returned in `{ack, frames}` have no ack path, and workerd can retry a disconnected DO
  call (`api/actor-call-retry.h:75-77`), so duplicates are normal traffic.
  Direction: accept only `seq = watermark + 1`, re-ack older frames, refuse gaps with a retryable
  code, arm the resend alarm in the crank's transaction whenever the outbox is non-empty, and
  keep returned frames in the callee's outbox until acked.
- **One delivery in flight per session caps throughput and has no backpressure (finding 15).**
  A session moves one frame per RPC round trip, crank and commit; messages and RPCs may be
  32 MiB against a 2 MB row; an object is soft-limited to 1,000 requests per second.
  Direction: credit windows and outbox quotas, chunked frames, and backoff on "overloaded".
- **Step 1 refuses fenced sessions, and admin RPCs have no stated rule (findings 1, 7).**
  "Refuse the event if `meta.state ≠ active`" covers `webSocketMessage`, `deliver` and `alarm`,
  so a fenced hub refuses existing-session frames, though §7.3 fences only new sessions and
  withdrawals.
  The addendum never says whether `retire` and the other admin RPCs run on a fenced, failed or
  half-retired hub.
  Direction: exempt admin RPCs explicitly, and have fenced hubs defer with a retryable code.

### §4.4 External peers

- **External peers get neither exactly-once nor durable references (finding 16).**
  Standard OCapN peers have no sequence numbers or acks (the durable envelope is
  "Thixotrope-specific", `designs/thixotrope.md:173`), so a reset loses their frame and a deploy
  drops their references.
  Direction: close the socket after any failed crank, and refuse terminally on reconnect to a
  retired hub.

### §4.5 RPC surface and §8 Control DO

- **Control holds full authority, and reports to it are unauthenticated (finding 6).**
  Control supplies `boot` and can export every secret (correction 21); a DO sees only props fixed
  at creation (`io/worker.c++:4018`), so control cannot tell which hub sent a report, and a
  `failed` that names the wrong hub leads to its deletion.
  A lifecycle capability "exported by control" needs c-lists in control, contrary to "it never
  routes data frames".
  Direction: put control in each hub's trusted base, hash the token, re-verify with `report()`
  before acting, and host the lifecycle capability in the creator's hub.
- **`incarnate` is both refused and idempotent, and `create` has no request ID (finding 12).**
  §4.5 says "refused if already incarnated"; §6.1 says "idempotent for the same token".
  A `create` retried after control eviction mints a second hub, rooted forever by `shell`, and the
  table lacks the unfence and unpublish operations that §6.5 and §7.3 need.
  Direction: `create(requestId)`, a claim lease that reaps unclaimed hubs, and `incarnate`
  idempotent on (token, boot digest, profile).
- **`migrate` breaks every live reference (finding 13).**
  Sturdyrefs and c-lists name the retired ID, `export_to_container` carries only the heap image,
  and an R2 write lets other events run ("allows other requests to interleave"; e3).
  Direction: a forwarding redirect or clone semantics, and a frozen, chunked, resumable export
  that includes the hub tables.

### §5 Addressing, capabilities, handoff

- **Publishing `shell` roots every hub from birth and may hand out the evaluator (finding 3).**
  Locally the shell stays out of publications, "which roots vat GC" (`daemon.js:839-842`;
  `packages/thixotrope/README.md:604`), so here §7.1 never holds and "collection spreading along
  a chain" cannot pass.
  If the swissnum stays the constant `shell` (`daemon.js:104`; `worker-peer.js:86`), a bootstrap
  `fetch` (`hub.js:1381-1393`) gives the evaluator to anyone who knows the hub ID.
  Direction: introduce the shell as a live reference in the creator's session, or publish a
  random 128-bit swissnum on request.
- **The gifter role does not exist, and a failure path becomes the normal one (finding 8).**
  `hub.js` has the exporter role and a receiver role that redeems by dialing the exporter
  (`hub.js:74-82`), which hubs that "never dial out" cannot do for external exporters.
  Deposit and withdrawal use different sessions here, so pipelining onto an undeposited gift,
  which breaks (`hub.js:1600-1606`), becomes routine; and row identity is per origin session
  (`hub.js:529-531`), so two sessions between one pair of hubs split identity and E-order.
  Direction: design the gifter role, queue pipelined messages under the gift key, keep one
  session per hub pair, and promote Open Question 1 to a blocker.
- **Hub IDs cannot carry a location hint (finding 17; correction 20).**
  Direction: keep the hint in the registry, pass it on control's first `get()`, and keep control,
  hubs and the archive bucket in one jurisdiction.

### §6 Lifecycle

- **§6.2: resurrect-and-refuse writes, and its signal is too strong (finding 7).**
  Before compat date 2026-02-24, `deleteAll()` keeps the alarm: in e1 it fired on the emptied hub
  beside a leftover `_cf_METADATA` (local-workerd).
  With the base §5.2 constructor each refusal instantiates the engine and writes; in e2 a
  never-used ID's constructor committed its `CREATE TABLE` (local-workerd).
  A bug that reports `not-incarnated` makes every peer abandon a live hub, and a PITR restore
  rewinds one hub's watermarks under its peers.
  Direction: compat date 2026-02-24 or `deleteAlarm()` first, a read-only constructor, and
  `not-incarnated` confirmed with control before peers treat it as permanent.
- **§6.3: best-effort aborts leak export rows forever (finding 9).**
  A peer that only exported to the retired hub never sends to it again, so it never finds out.
  Direction: retire only after aborts are acked, or deliver them through control.
- **§6.4: host traps and platform resets are not deterministic halts (finding 5; blocker 4).**
  In e2 a trap rolled SQL back to 0 rows while wasm kept counter 1, and the next crank committed
  counter 2 against 1 row (local-workerd).
  Traps depend on host, tier and co-resident memory, so calling them fatal kills vats for
  transient reasons, and retrying them loops on a poison frame; `failed` must be written in a
  second transaction.
  Direction: classify halt, trap and reset; on a trap drop the instance, count traps per
  (session, seq) outside the crank, retry fresh, and after K traps park the session.

### §7.1 Local signal

- **"Collectible" misses three kinds of liveness (finding 2; correction 22).**
  Each trace ends with a hub deleted while it is still reachable or still owes an effect:
  1. Unacked outbox: H's crank sends toward slow hub C, and frame k waits unacked.
     The next crank processes G's `op:gc-exports`, H's counters reach zero, and retirement runs
     `deleteAll()` without draining (§6.3), losing a committed send.
  2. Answer owed: G sends `E(x).getY()` at answer position a, H settles a, and G drops x but
     keeps the promise.
     H has no exports or questions, so it is collectible, and G's pipelined send to answer a
     reaches a deleted hub; locally, answer routes retain until `op:gc-answers`
     (`vat-reachability.js:105-121`; `hub.js:1849-1877`).
  3. Gift certificate: gifter F's deposit was answered, so F is collectible while the recipient
     still holds the certificate.
     F's retirement clears its session identity at the exporter (`hub.js:1956`), and the
     withdrawal fails with "unknown gifter session" (`hub.js:1311-1312`) *(inferred mapping of
     "mark rows dead" to session retirement)*.

  Direction: count exports, answers until `op:gc-answers`, gifts and waiters, publications,
  pending work, guest timers, the outbox and pending `openSession`, the same list as §7.3's roots,
  and keep a gifter's identity until its gifts are withdrawn or expire.
- **"The check costs nothing" is not today's cost model (finding 18).**
  `hub.js` writes its whole state as JSON after every mutating frame (`hub.js:51-55`), each
  message is transcoded and booked twice, and an introduction costs four pure-JS Ed25519
  operations (`cryptography.js:164, 183`) and three RPCs.
  Direction: Phase 0 measures an introduction and idle GC at realistic c-list sizes.

### §7.2 Supporting rules

- **Guest GC never reports a release, so exports never drop (the base review's in-heap GC check;
  correction 23).**
  Without `WeakRef` and `FinalizationRegistry`, `makeFinalizingMap` keeps imports in a strong
  `Map` (`packages/ocapn/src/captp/finalize.js:56-58`), so `onSlotCollected` never runs
  (`pairwise.js:80-91`), and it is the only source of `op:gc-exports` and `op:gc-answers`
  (`ocapn.js:1168-1215`).
  Between Ironhorse vats export counts only grow, so the local signal never fires *(inferred)*.
  The cycle backstop cannot make up for it: it marks through `importsFrom`, which the same
  unreleased imports fill, so a hub that any live hub ever imported from stays marked, and that
  garbage leaks *(inferred)*.
  Direction: a deterministic release protocol or deterministic engine finalization; until then,
  drop "Collection is mostly local".
- **Session GC drops unacked frames, and reused IDs meet late duplicates (finding 14).**
  Dropping a session discards its outbox, including an unacked final GC frame.
  Direction: a close handshake, session IDs that are never reused, and a `session-closed` refusal.

### §7.3 Cycle backstop

- **The verify step retires a live hub (finding 1; correction 24).**
  Trace, with root P referencing Z and X, and X and Y referencing each other:
  1. Control reports Z, whose `importsFrom` is empty.
  2. P hands x to Z and drops its own reference to X.
  3. Control reports P (`[Z]`), X (`[Y]`) and Y (`[X]`).
  4. Marking from P reaches only P and Z, through Z's stale report, so X and Y fence: Z is a
     referrer, not a root.
  5. X has importers Y and Z, and Z is not fenced, so X is unfenced.
  6. Y's only importer, X, was fenced when checked, so Y is retired while Z → X → Y is live.

  A pass that ends in "unfence the rest" has also broken any withdrawal it refused, so "a handoff
  in flight surviving a cycle pass" cannot pass, and `retire` carries no pass ID.
  Direction: a greatest fixpoint over importer lists read after all fences, fences with a pass ID
  and a lease, and retryable deferral instead of refusal.

### §9 What goes away

- **Several rows move rather than disappear (finding 19).**
  Tombstones move to peers and the control registry, the idle policy returns as the idle-GC
  alarm, and the host endpoint is re-seated on every wake of every hub
  (`worker-session-records.js:215-228`) *(inferred)*.
  Direction: correct the table, and specify the per-hub endpoint and its per-wake cost.

### §10 Failure modes

- **Deploys mix versions, and one bad frame aborts a whole session (finding 11).**
  In a gradual deployment "each Durable Object is assigned a Worker version", while `hub.js`
  aborts a remote session on a bad frame (`hub.js:1898-1905`) and refuses unknown state versions
  (`hub.js:441-445`).
  Direction: versions in `openSession`, in every frame and in meta, with N/N−1 compatibility and
  a retryable "unsupported version".

### Observability and conventions

- **No metrics, and both documents miss conventions (finding 20).**
  Nothing measures outbox depth, retries, alarm exhaustion, traps, fence durations or gift waiters.
  When reviewed, the base report had changed in `075c0118` but still said Updated 2026-09-23, and
  neither document had the `## Prompt` section that designs/AGENTS.md asks for; `d067226a` fixed
  both.

## Contradictions with the engine reports

The completeness critic listed contradictions C1–C10 between the base report and
WASM-BLOCKERS.md at `a9e3b2ab`.
Rechecked against WASM-BLOCKERS.md at `d152375e`, with line numbers from that text:

| # | Base report | WASM-BLOCKERS.md (`d152375e`) | Which is right |
|---|---|---|---|
| C1 | §1: builds "as-is"; "one real port" | B1 hard; `ironhorse-compile` and `ironhorse-runtime` fail on both targets; `vm` and `regexp` refusals abort under `panic=abort` | WASM-BLOCKERS. The base report is wrong (correction 5). |
| C2 | §5.3 caches `this.vat` across events | "A trap poisons the instance, cumulatively": discard after any trap | WASM-BLOCKERS, since `e487f62e` corrected the "does not poison" heading. The base report is wrong. |
| C3 | Silent on the stack; picks workerd as host | B3 "hard in browsers and workerd"; the stack refactors are required | WASM-BLOCKERS; the base report must add the stack. WASM-BLOCKERS was imprecise at line 725: "in a Durable Object, 23" is one run after a request pass had tiered V8 up, and a fresh-instance DO run matched 24 of 25 (only `json-stringify-10k` trapped). With TurboFan pinned (`--no-liftoff`), 7 of the 25 trap in a request handler (STACK-DEPTH-REFACTOR §1.3), so it should say 18–24 of 25, depending on tier state. |
| C4 | §9: 128 MB mitigated by lazy paging, eviction and sharding | B8 "the ceilings do not bound memory", "hard under a 128 MB cap"; recycle the instance | WASM-BLOCKERS. The base report is wrong (correction 15). Two fixes to WASM-BLOCKERS: B8's "4–5× the chunk ceiling for string heaps" is the string-doubling worst case, since string push loops halted at 2.1–2.2× (556,335,104 B in Node, 599,392,256 B in workerd), so "up to 4–5×" is exact; and the Cloudflare "Memory" bullet (line 756) still asks only for lower ceilings, though B8 now says no ceiling bounds array items or side tables, so it must also require admitting them (B7). |
| C5 | §1, §8: heaps portable and "can move both ways" | Not investigated; a Thixotrope profile check refuses it first | Both incomplete. WASM-BLOCKERS is out of date: the verification restored two natively written Thixotrope heaps in a wasm32 instance *(Node)*, the SES boot heap (7,651,170 B container) and the counter vat (17,273,470 B), by passing the native profile string; each ran `1+1` and the outbound drain, lazily and eagerly. wasm32 → native was not run. The base report stays wrong until the profile is platform-neutral (correction 4). |
| C6 | §9: "Ironhorse is already an interpreter" | "Speed": 1.5–2.7× slower than native; "Not investigated" still lists performance (line 794) | WASM-BLOCKERS' measurement is right, and its "Not investigated" entry is stale. The base report understates the cost. |
| C7 | §5.2: "instantiate the WASM module" | Cloudflare section: the module must be bundled | Resolved: WASM-BLOCKERS no longer recommends `WebAssembly.compile` for workerd, and the base report never proposed runtime compilation. Engine upgrades remain (blocker 6). |
| C8 | §6.1: rusqlite "won't build" as the reason for a new backend | B5: bundled SQLite needs a WASI sysroot; keep persistence host-side | Neither is wrong, and both give the same remedy. The base report's reason holds only for the pinned rusqlite 0.31, since 0.40.2 depends on `sqlite-wasm-rs` for `wasm32-unknown-unknown` (crates.io). The real reason is that DO durability is reachable only through `ctx.storage.sql`. |
| C9 | §6.1, §9: hold no borrows across a reentrant `tx` | Cloudflare section: "A Durable Object's transaction callback re-enters wasm from JS"; use `extern "C-unwind"` | WASM-BLOCKERS on the mechanics; the base report's rule cannot be met (correction 12). WASM-BLOCKERS states re-entry as a given at line 742; it happens only if the host calls back into wasm from a transaction callback, which the design can avoid. |
| C10 | §4: quarantine through PITR; §5.3 has no fatal path | B1 option 3: drop the instance and restore from the last committed snapshot | WASM-BLOCKERS, for the engine. The base report is wrong: PITR is a whole-database rollback, and quarantine needs a failure row committed outside the halted crank, which Addendum A §6.4 also leaves out. |

Commit `ccd009f2` applied the WASM-BLOCKERS fixes that C3, C4, C5, C6 and C9 propose, and a
later revision widened C3's range to 18–24 of 25; the line numbers in the table refer to the
text at `d152375e`.
Outside C1–C10, STACK-DEPTH-REFACTOR §1.6 lists corrections to B3, all since applied.
The last of them, Blink's 500 KiB Worker limit in place of the thread's OS stack that
WASM-BLOCKERS.md:652 suggested, landed in `ccd009f2`.

## What Phase 0 needs

Prerequisites:

- A deployed Workers Paid account with `limits.cpu_ms` raised.
  Local workerd enforces no memory or CPU limit (`server.c++:3305-3310`, used at `:5729`),
  accepts values up to 4 MiB, cannot restore PITR bookmarks, and advances `Date.now()` during
  execution, which production does not; the Free plan allows 10 ms of CPU per event.
- A harness that reads `memory.buffer.byteLength` per instance, Cloudflare's per-isolate memory
  metric, CPU analytics and the cursors' `rowsRead` and `rowsWritten`, timing across I/O.

Work items, from the completeness critic, with Addendum A's additions:

1. Build one cdylib with `RUSTC_BOOTSTRAP=1`, `-Zbuild-std=std,panic_unwind`, `-C panic=unwind`,
   `-C target-feature=+exception-handling`, `-C llvm-args=-wasm-use-legacy-eh=false` (exnref),
   the `-zstack-size` of STACK-DEPTH-REFACTOR §4.7 (E1) and `consensus`, with
   `extern "C-unwind"` on any re-entered export and on the import that calls back into it, and a
   CI job (WASM-BLOCKERS B1, B2, B6); an exnref build made this way ran in local workerd.
2. Engine session exports that port `main.rs` without threads, `flock`, files or NDJSON: set the
   profile and ceilings, boot, resume lazily, `eval(source, budget)`, checkpoint, return the halt
   class; keep today's two evals per frame.
3. A minimal `ironhorse-store-do`: the 10 required `HeapStore` methods and `small_section_hashes`
   on the `MemoryStore` pattern (`store.rs:3378`), the dense reachability defaults, no `tx`
   import, the `IRON` stamp in a `meta` row, every value at most 2,000,000 B, integers as f64
   within u32, and one statement per `exec`.
4. A JS DO host: a static wasm import; lazy instantiation inside `try` in each handler; each crank
   in `transactionSync`; on any exception `this.vat = undefined`; a failure row in a separate
   transaction; a `sql.exec` shim returning error codes; frames copied out with `slice()`;
   `new_sqlite_classes`.
5. A portable runtime profile, `{boot_fingerprint, hostProtocol, bootstrap hashes, crankBudget,
   ceilings}`, shared by the native adapter and the DO.
6. A Cloudflare ceiling profile (`set_chunk_ceiling`, `set_slot_ceiling`) plus admission of array
   items and side tables, which no ceiling bounds today (WASM-BLOCKERS B7, B8), tested to halt
   with `HeapExhausted` below about 100 MiB of linear memory under string, array and Map growth,
   counting the baseline (11 MiB with an 8 MiB shadow stack, about 7 MiB with E1's 4 MiB) and 2×
   vector growth.
7. Test heaps: first boot inside the DO, the demo counter vat through `import_from_container`,
   and synthetic sweeps (a plain list, Map and WeakMap tables, arrays, closures, a large free
   list).
8. For a "go", the lazy-resume fixes (deferred side-table validation, checkpoint checks of reused
   or grown slots only, a sparse chunk arena, free-list dirty bits, a persisted ledger), and
   STACK-DEPTH-REFACTOR Phases 1–2 before production traffic, plus its Phase 4 decision (B10) for
   the trapped-Proxy ceilings, which still trap after Phase 2.
9. For Addendum A, a two-hub prototype of the deliver path (outbox, watermark and ack, with the
   §4.3 fixes).

Decisive measurements, ranked:

1. The production DO stack depth against the 25 recursion families and a `JSON.stringify` depth
   sweep; if it matches OSS workerd's 984 KiB, accepted programs trap by tier, and the heap-stack
   refactors of WASM-BLOCKERS B3 become mandatory before any heap is shared between local and
   cloud.
2. Peak linear memory per awake worker, co-residency per production isolate, and whether compiled
   wasm code counts toward 128 MB (locally: 11 MiB baseline with the 8 MiB shadow stack,
   42–78 MiB for the counter vat,
   67–83 MiB for first boot, export and import *(Node)*).
3. Cold wake for SES and OCapN heaps with today's engine, split into instantiate (Liftoff),
   resume, first crank and first commit (the lazy wasm wake of the counter vat took 781 ms
   *(Node)*).
4. CPU per crank against computrons (0.119 to 37 million per second), including first boot, which
   decides whether a budget halt can pre-empt the platform reset.
5. Hub-to-hub delivery (Addendum A §12): RPC round trip including the receiver's durable commit,
   and one crank with routing (c-list rewrite plus outbox) against one without.
6. Rows written and read per delivery (two checkpoints today) and for the first commit after a
   wake.
7. The production per-value cap and its error text (2 MB documented, 4 MiB in local workerd).

Acceptance gates, beyond Addendum A §12's six tests:

- the three counterexample traces ([§4.3](#42-crank-and-43-hub-to-hub-delivery),
  [§7.1](#71-local-signal), [§7.3](#73-cycle-backstop)), each as a test that must neither lose a
  frame nor retire a reachable hub;
- trap injection: after a trap or thrown error inside a crank, memory and SQL agree, the instance
  is discarded, and repeated traps park the session;
- a mixed-version deploy, with hubs on two Worker versions exchanging frames;
- a fresh DO that has set and deleted an alarm still opens its store.

## Verified as correct

- **Baseline (§2):** one Ironhorse machine and one SQLite store per process, with no XS; a result
  only after the crank and its promise jobs commit; a halted crank is not committed; outbound
  frames drained by a separate crank; the `flock` leases; the transport owns replay, sequences,
  image selection and quarantine; `close` folds the WAL.
- **Platform (§3, §5.1, §7, §10):** a DO is single-threaded and unique per ID, enforced at event
  start and on storage access; `ctx.storage.sql` is synchronous; one alarm per DO; PITR covers 30
  days; hibernated DOs accrue no duration; no hook runs before hibernation, and memory is
  discarded; the constructor reruns on wake; timers prevent hibernation; auto-response answers
  without waking; an attachment holds 16,384 bytes; outbound WebSockets do not hibernate and pin
  the object for up to 15 minutes; deploys drop sockets; a reset loses the inbound frame; every
  §10 value is right for Workers Paid.
- **Output gates** hold `ws.send` (`web-socket.c++:875`) and DO RPC calls and returns
  (`worker-rpc.c++:687-688, 1687-1692`) until writes are durable, so the "Result-after-commit"
  row is right.
- **`transactionSync`** is synchronous, returns the callback's value, nests through per-depth
  savepoints, and on a throw rolls back SQL, DDL and `setAlarm` (e2).
- **The §5.3 API usage** (`WebSocketPair`, `acceptWebSocket` with tags, `serializeAttachment`, a
  101 response) runs end to end, and attachments and tags survive hibernation (local-workerd).
- **The §6.2 audit:** rows 1, 2, 5, 6, 8, 9, 12 and 13 as written, row 3 after the TEMP rewrite,
  row 4 with the `_cf_` caveat, row 7 apart from correction 13, and row 11 inside
  `transactionSync`; every SQL literal of `lib.rs` run in a DO failed only as those rows predict
  (local-workerd).
- **§6.1 and §6.3:** `HeapStore` is synchronous and admits a single-writer contract; rusqlite
  0.31 with bundled SQLite fails for wasm32; `sql.exec` needs no Asyncify or JSPI; wasm → JS →
  `transactionSync` → wasm re-entry works (local-workerd); items 1, 2 and 4 hold as far as they
  go; `export_to_container` is backend-generic (item 6).
- **The engine:** both exception-handling encodings load in workerd with zero imports;
  `HeapExhausted` and the compiler-budget `SyntaxError`s of `eval-deep` are contained there; the
  boot fingerprint is identical on native and wasm32 builds.
- **Addendum A:** DO RPC does not identify the caller, so a token must separate control from
  data; a synchronous crank stays atomic while other events interleave during an awaited RPC
  (e3); `deleteAll()` empties the database, and a stub can then re-instantiate the ID empty (e1 at
  compat date 2026-03-01); pipelining onto an undeposited gift breaks; local `collectVats`
  rechecks between retirements; the reachability report omits secrets and fingerprints session
  identifiers; every introduction between vats is a handoff in this topology.

## Evidence

The verification ran in session scratch that does not survive the session, so the numbers this
review relies on are inlined above, and claims that could not be re-checked were dropped.
Repository `file:line` citations refer to commit `d152375e`; the code is unchanged since
`5663b155`, where the verification ran.
Quotes from the two design documents match their text at `075c0118`, which `d067226a` changed
only by adding metadata, markers and `## Prompt` sections.
WASM-BLOCKERS.md and STACK-DEPTH-REFACTOR.md are cited by section, as of this revision; the line
numbers in the contradictions table refer to WASM-BLOCKERS.md at `d152375e`.
workerd citations (`src/workerd/…`, `src/cloudflare/…`) refer to commit
`62935d76771b2361e507c7f18f064c5bab43c314` (2026-09-23).
Cloudflare documentation was fetched from developers.cloudflare.com on 2026-09-23 and 2026-09-24.
Runtimes: workerd 1.20260923.1 from npm (V8 15.4.80.5) and 1.20260921.1 under wrangler 4.137.0;
e1–e3 used Miniflare 4.20260730.0 with workerd 1.20260730.1; Node 22.22.2; Rust 1.91.1.

## Prompt

This review was produced by a verification workflow and an adversarial reviewer.
The workflow ran one verifier and one adversarial skeptic for each of ten claim groups of the base
report, then a completeness critic; a separate adversarial reviewer checked Addendum A.
They were prompted by the author's requests.
For the base report:

> add this report as well. its the primary goal, wasm compat work is a prerequisite

For Addendum A:

> heres an addition Thixotrope-on-Cloudflare design doc

And the standing request:

> do an adversarial subagent review loop
