# Thixotrope on Cloudflare

| | |
|---|---|
| **Created** | 2026-09-23 |
| **Updated** | 2026-09-23 |
| **Author** | Aaron Davis (prompted) |
| **Status** | Proposed |

*Design report: running Thixotrope workers (an Ironhorse machine plus its SQLite heap store) as
hibernating Durable Objects, with OCapN over WebSockets.*

*[Addendum A, Single-Vat Hubs](thixotrope-on-cloudflare-addendum-single-vat-hub.md) supersedes
§4 (Architecture) and §7 (Transport topology) and adds lifecycle and collection.*

---

## 1. Summary

Thixotrope runs well on Cloudflare if **each worker is a SQLite-backed Durable Object (DO) running
Ironhorse compiled to WASM**, with the heap store moved onto the DO's built-in SQLite.

- **Hibernation works.**
  All live object state, including CapTP session tables, lives in pages of the Ironhorse heap that
  are committed after every crank.
  The WebSocket is a byte pipe owned by Cloudflare's WebSocket Hibernation API.
  Nothing live is left in the JS isolate, so the failure mode in
  [workerd#6087](https://github.com/cloudflare/workerd/issues/6087) doesn't apply.
- **Cost scales with use.**
  Hibernated DOs accrue no billable duration.
  A worker costs something only while it processes a message.
- **Lock-in stays low.**
  OCapN remains the only protocol.
  Cloudflare provides storage, compute and connection hosting, and heap images stay portable to
  local Thixotrope.
- **The engine builds for `wasm32-unknown-unknown` as-is** (`ironhorse-snapshot` and
  `ironhorse-vm`, verified).
  The one real port is a new `HeapStore` backend over the DO SQL API.
  The data model maps directly; the connection setup and a few query patterns need changes (§6).

The two numbers that decide viability, to measure first: **cold-wake latency** (instantiate plus
lazy resume on a realistic heap) and **commit cost per crank**.

---

## 2. Thixotrope today (baseline)

From `rust/thixotrope-ironhorse-worker`:

- A worker is one process containing **one Ironhorse machine and one SQLite heap store**, with no
  XS dependency.
- A supervisor drives it over a trusted **NDJSON** stdin/stdout interface (`eval`, `result`,
  `fatal`, `close`).
- A result is emitted **only after the complete crank, including promise jobs, commits to
  SQLite**.
  A deterministic halt exits without committing that crank.
- Guest **OCapN output stays in a queue inside the heap** until a separate crank drains and commits
  it.
  The adapter then releases those frames to the comms hub.
- The only-one-writer guarantee comes from leases and `flock`: a kernel lease, one shared active
  lease per worker, and exclusive leases for reclaiming incarnations.
- The daemon transport owns replay, sequence numbers, choosing a sleep image and quarantining
  failures.
  `close` folds the WAL so the heap is a single self-contained file before an image is copied.

Most of these disciplines already have a direct counterpart on Durable Objects.

---

## 3. Cloudflare primitives used

| Primitive | Role in Thixotrope on Cloudflare |
|---|---|
| **Durable Object (SQLite-backed)** | One per Thixotrope worker. Single-threaded, one instance globally, synchronous `ctx.storage.sql`, alarms, point-in-time recovery. |
| **WebSocket Hibernation API** | OCapN netlayer ingress. Sockets stay open at the edge while the DO is evicted. |
| **Workers (stateless)** | Edge router: authenticates, then routes a connection to the right DO by node or worker ID (`idFromName`). |
| **DO RPC (stubs)** | Worker-to-worker transport *inside* Cloudflare, replacing the comms hub and outbound sockets. |
| **Alarms** | Guest timers and deferred cranks. |
| **R2** | Exported heap images (`export_to_container`), large content-addressed bundles. |
| **Containers** | Optional fallback for vats that outgrow the isolate memory cap or need native speed. |

**Not used for the core design:** Workers RPC `RpcTarget`s and Cap'n Web as the object layer,
since those are what hit #6087, and Dynamic Workers facets.
Guests run as SES compartments inside Ironhorse, not as isolates Cloudflare manages.

---

## 4. Architecture

*Superseded by [Addendum A](thixotrope-on-cloudflare-addendum-single-vat-hub.md).*

```
          external OCapN peers / browsers
                     │  WebSocket (dial in)
                     ▼
         ┌───────────────────────┐
         │  Edge router Worker    │  auth, route by node/worker id
         └──────────┬────────────┘
                    │ acceptWebSocket handoff
                    ▼
  ┌──────────────────────────────────────────┐
  │ Durable Object  = one Thixotrope worker   │
  │  ┌────────────────────────────────────┐   │
  │  │ Ironhorse (WASM)                   │   │
  │  │  SES compartments / guest vats     │   │
  │  │  CapTP session tables (in heap)    │   │
  │  │  outbound OCapN queue (in heap)    │   │
  │  └──────────────┬─────────────────────┘   │
  │    host imports │ exec / tx / blob copy   │
  │  ┌──────────────▼─────────────────────┐   │
  │  │ DO SQLite: ironhorse heap store    │   │
  │  └────────────────────────────────────┘   │
  └───────────────┬───────────────────────────┘
                  │ DO RPC (byte frames)
                  ▼
        other Thixotrope worker DOs
```

### Mapping from local Thixotrope

| Local Thixotrope | On Cloudflare |
|---|---|
| Worker process | Durable Object instance |
| NDJSON supervisor interface | DO class methods: the trusted host, not exposed to guests |
| `heap.sqlite` file | DO's built-in SQLite (up to 10 GB per object) |
| `flock` / kernel and active leases | DO single-instance guarantee: only one live instance per ID, so single-writer holds by construction |
| Result-after-commit discipline | Commit inside `transactionSync`; **output gates** hold outgoing messages until the write is durable |
| Heap queue → comms hub | Heap queue → DO RPC call or WebSocket `send` after commit |
| `close` folds WAL for a single-file image | Not needed. Use `export_to_container` to R2 for portable images, and PITR bookmarks for rollback |
| Sleep image selection / quarantine | PITR bookmark (`getBookmarkForTime`, `onNextSessionRestoreBookmark`) plus R2 exports |
| Guest timers | `ctx.storage.setAlarm()` |

---

## 5. Crank lifecycle and hibernation

### 5.1 Rules

1. **Use only the Hibernation API.**
   Call `ctx.acceptWebSocket(ws)` and implement `webSocketMessage` / `webSocketClose` /
   `webSocketError`.
   Never call `ws.accept()` or `addEventListener`, because registered listeners keep the isolate
   from hibernating.
2. **Commit at the end of every delivery.**
   There is no hook that runs just before hibernation, and memory is discarded when it happens.
   Each inbound frame runs as restore (if cold), deliver, drain queue, commit, send.
   This is the result-after-commit rule Thixotrope already follows.
3. **Keep the crank fully synchronous.**
   WASM calls, `sql.exec` and `transactionSync` are all synchronous, so a crank is one
   uninterrupted event.
   No other event interleaves, and nothing is left pending that would block hibernation.
4. **No JS timers.**
   `setTimeout` and `setInterval` prevent hibernation.
   Map guest timers to DO alarms.
5. **Host I/O is messages.**
   An outbound `fetch` is recorded in the heap and its response delivered as a later crank.
   If the DO is evicted while a request is in flight, reissue unfinished requests on wake; make them
   idempotent or break the promise.
6. **The socket attachment holds only a session ID.**
   `serializeAttachment` holds up to 16 KB.
   Store `{sessionId, peerId}` and keep all CapTP state in the heap, keyed by that ID.
7. **Answer keepalives at the edge.**
   `ctx.setWebSocketAutoResponse` answers heartbeats without waking the DO.

### 5.2 Wake path

- The constructor runs again on every wake, so keep it minimal: instantiate the WASM module and
  open the store.
- Use Ironhorse's **lazy resume**.
  Validation at open reads the manifest, small state, free-list segments and the leaf and inventory
  metadata; slot pages and chunk extents are faulted in on demand.
  A wake costs roughly the metadata plus the pages the message touches.
- Take `rebuild_edge_pairs`-on-every-open off this path (see §6.3).

### 5.3 Sketch

```js
export class ThixotropeWorker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {                       // edge router hands over the upgrade
    const [client, server] = Object.values(new WebSocketPair());
    const sessionId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [sessionId]);
    server.serializeAttachment({ sessionId });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    const { sessionId } = ws.deserializeAttachment();
    const vat = (this.vat ??= Ironhorse.resume(this.ctx.storage)); // lazy restore
    const out = this.ctx.storage.transactionSync(() =>
      vat.deliver(sessionId, data)          // crank + drain queue + commit dirty pages
    );
    for (const [sid, frame] of out) {       // held by output gate until durable
      this.ctx.getWebSockets(sid)[0]?.send(frame);
    }
  }

  alarm() { /* deliver timer crank, same transaction shape */ }
}
```

### 5.4 Why this avoids workerd#6087

#6087 exists because Cap'n Web (a) registers listeners on the socket, which pins the isolate, and
(b) keeps `RpcTarget` instances that can't survive the isolate being rebuilt.
Thixotrope on Cloudflare has neither problem:

- Sockets go through the Hibernation API, with no listeners registered.
- The object graph lives in the **Ironhorse heap**, and every crank commits it to DO SQLite.
  Session identity is re-established from the attachment, and CapTP tables are rebuilt as heap
  pages fault in.

The fix #6087 is waiting for, a runtime-level way to persist objects across hibernation, is what
Thixotrope's heap store already provides.

---

## 6. Heap store port: `ironhorse-store-do`

### 6.1 Approach

- The engine's persistence seam is the `HeapStore` trait
  (`rust/engine/ironhorse-snapshot/src/store.rs`).
  The existing backend is `rust/endo/ironhorse-store-sqlite`, which uses rusqlite with bundled
  SQLite C and won't build for `wasm32-unknown-unknown`.
- Write a new backend that implements `HeapStore` over a small host-import ABI:
  - `exec(sql, params) → rows`: maps to `ctx.storage.sql.exec`, which is **synchronous**, so no
    Asyncify or JSPI is needed.
  - `tx(fn_id)`: host calls `ctx.storage.transactionSync(() => wasm.tx_body(fn_id))`.
    This is a reentrant call into the guest, so hold no `RefCell` borrows (e.g. `root_cache`)
    across it.
  - blob copy in and out between `ArrayBuffer` and linear memory.
- Gate the new backend with the existing `store-suite` acceptance suite (metamorphic determinism,
  checkpoint locks), run under local workerd.

### 6.2 Compatibility audit

Checked against the SQL authorizer in workerd (`src/workerd/util/sqlite.c++`) and the DO limits.

| Backend usage | DO SQLite | Notes |
|---|---|---|
| Tables, composite primary keys, `WITHOUT ROWID`, `CREATE INDEX` | ✅ | Schema carries over as-is |
| `ON CONFLICT … DO UPDATE`, `INSERT OR REPLACE/IGNORE` | ✅ | |
| `WITH RECURSIVE` reachability CTEs | ✅ | `SQLITE_RECURSIVE` authorized |
| Reading `sqlite_master` | ✅ | Only names starting with `_cf_` are blocked |
| Blob sizes: slot page 5 KB (256 × 20 B), chunk extent 64 KB, free-list segment 16 KB, leaf hash 32 B | ✅ | Well under the 2 MB row cap |
| Bound parameters (≤ 3 per statement) | ✅ | Limit is 100 |
| `PRAGMA application_id / locking_mode / journal_mode / wal_autocheckpoint / synchronous`, `busy_timeout` | ❌ | Not allowlisted; the backend currently **refuses to open** when these fail |
| `BEGIN IMMEDIATE`, `unchecked_transaction`, migration transactions | ❌ | Transaction statements are rejected; use `transactionSync` |
| `CREATE TEMP TABLE` in reachability and generational-GC queries | ❌ | All TEMP objects are denied |
| Small-state section payloads (u32 length, include bulk side tables) | ⚠️ | Can exceed the 2 MB row cap on large heaps |
| `rebuild_edge_pairs` on every open | ⚠️ | Legal, but rewrites all edge rows on each wake |
| `close()` WAL fold | n/a | No file handoff on DO |
| `TEMP TRIGGER` fault injection in tests | ❌ (tests only) | Replace with host-level fault injection |

### 6.3 Required changes

1. **Pragmas.**
   Drop them.
   Move the `IRON` application stamp into a `meta` row.
   The DO single-instance guarantee replaces EXCLUSIVE locking, and output gates plus DO durability
   replace WAL and `synchronous=FULL`.
2. **Transactions.**
   Restructure `commit_verified` (take the cache → run the verifier inside the transaction → write
   → commit, or throw to roll back) as a `transactionSync` callback.
   Do the same for `rebuild_edge_pairs` and the migration steps.
3. **TEMP tables.**
   Pass root and target sets as one JSON parameter:
   `WITH roots(p) AS (SELECT value FROM json_each(?1)) …`
   This removes the scratch writes and stays under the parameter limit.
4. **Section size.**
   Split `small_sections` rows into chunks keyed by `(id, chunk)`, and keep the per-section hash
   over the whole payload so the seal inputs don't change.
5. **Edge-index rebuild.**
   The reason for rebuilding on open (not trusting edits made while the file was closed) mostly
   disappears when nothing outside the DO can write its SQLite.
   Rebuild only after a migration or when a generation marker changes.
6. **Close and handoff.**
   Replace the WAL fold with `export_to_container` to R2 for portable images, and PITR bookmarks
   for rollback.

---

## 7. Transport topology

*Superseded by [Addendum A](thixotrope-on-cloudflare-addendum-single-vat-hub.md).*

| Link | Transport | Hibernates? |
|---|---|---|
| External peer or browser → worker | WebSocket, peer dials in via the edge router | ✅ (DO is the server) |
| Worker → worker (both on Cloudflare) | DO RPC calls carrying opaque OCapN frames | ✅ (no socket held open) |
| Worker → external peer | **Avoid outbound WebSockets.** Have the peer dial in, or go through a relay DO the peer connects to | ❌ if dialed out: outbound sockets don't hibernate and keep the DO alive up to 15 min per connection |
| Home Thixotrope ↔ cloud Thixotrope | Home node dials in (Cloudflare Tunnel optional) | ✅ |

**Deploys disconnect every WebSocket.**
OCapN's sever semantics cover this: sessions break, promises reject, peers reconnect through
sturdyrefs.
State isn't lost, because every crank is committed.

**Lost inbound frames.**
If a DO is reset mid-crank, the inbound frame is dropped, since WebSockets have no
application-level acks.
Thixotrope's transport already owns sequence numbers and replay.
Carry that discipline into the netlayer (sequence and ack on frames, resend on reconnect) rather
than relying on sever alone.

---

## 8. Rollout

**Phase 0: measure (go/no-go).**

- Ironhorse WASM in a DO, backed by a minimal `ironhorse-store-do`.
- Measure cold-wake latency across heap sizes, commit cost and rows written per crank, and resident
  memory against the isolate cap.
- Confirm lazy resume holds up in practice: wake cost should track pages touched, not heap size.

**Phase 1: relay.**

- Local Thixotrope stays the host.
- Cloudflare adds an edge router plus a mailbox and rendezvous DO per node, for store-and-forward
  while home nodes are offline.
- Cheap, low-risk, and exercises the netlayer and hibernation path without moving any heaps.

**Phase 2: native workers.**

- Full `ironhorse-store-do` passing `store-suite`.
- One DO per Thixotrope worker, DO RPC between workers, alarms for timers, R2 image export.
- Heaps can move both ways between local and cloud via `export_to_container` /
  `import_from_container`.

**Phase 3: hybrid and fallback.**

- Workers are placed per user or agent: at home, on Cloudflare, or in Containers for heavy vats
  that exceed memory limits.
- Same protocol and heap format everywhere; a peer can't tell where a worker runs.

---

## 9. Risks and open questions

| Risk | Mitigation / question |
|---|---|
| **Cold-wake latency** grows with metadata size (leaf hashes, inventory, small state) | Measure in Phase 0. Consider caching validated metadata, or trusting DO storage more than an arbitrary file |
| **128 MB isolate memory** includes WASM linear memory | Lazy paging, evicting cold pages, sharding across DOs, Containers for outliers |
| **Rows written per crank** (billing) | O(dirty) commits already. Batch small frames; skip commits for read-only cranks |
| **Interpreter in WASM** has no JIT | Ironhorse is already an interpreter; benchmark compute-heavy vats and send outliers to Containers |
| **CPU limit per event** (30 s default, up to 5 min) | Computron budgets already exist; split long work across alarm cranks |
| **Transaction reentrancy** (host → guest callback) | Keep the guest ABI reentrant-safe; no borrows held across `tx` |
| **DO placement** is pinned near the first caller | Location hints and jurisdictions; accept extra latency for travelling users, or migrate the worker |
| **Guest-facing security** of host imports | Host imports are the trusted supervisor boundary; guests only ever see SES-mediated capabilities |

---

## 10. Limits reference (SQLite-backed Durable Objects)

| Limit | Value |
|---|---|
| Storage per object | 10 GB |
| Max row / string / BLOB | 2 MB |
| Max SQL statement length | 100 KB |
| Max bound parameters | 100 |
| CPU per event | 30 s default, configurable to 5 min |
| `serializeAttachment` | 16 KB |
| PITR window | 30 days |
| Isolate memory | 128 MB (includes WASM memory) |

---

## Sources

- [workerd#6087: hibernatable RPC targets / capnweb hibernation](https://github.com/cloudflare/workerd/issues/6087)
- [workerd `sqlite.c++` SQL authorizer](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++)
  · [workerd `sql.c++` (`_cf_` name rule)](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.c++)
- [DO SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  · [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  · [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  · [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cap'n Web](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)
  · [JavaScript-native RPC on Workers](https://blog.cloudflare.com/javascript-native-rpc/)
- `endojs/endo-but-for-bots@llm`:
  [`rust/engine/ironhorse-snapshot/src/store.rs`](https://github.com/endojs/endo-but-for-bots/blob/llm/rust/engine/ironhorse-snapshot/src/store.rs)
  · [`rust/endo/ironhorse-store-sqlite/src/lib.rs`](https://github.com/endojs/endo-but-for-bots/blob/llm/rust/endo/ironhorse-store-sqlite/src/lib.rs)
  · [`rust/thixotrope-ironhorse-worker/README.md`](https://github.com/endojs/endo-but-for-bots/blob/llm/rust/thixotrope-ironhorse-worker/README.md)
