# Thixotrope on Cloudflare: Addendum A, Single-Vat Hubs

| | |
|---|---|
| **Created** | 2026-09-24 |
| **Updated** | 2026-09-24 |
| **Author** | Aaron Davis (prompted) |
| **Status** | Proposed |

*Addendum to [Thixotrope on Cloudflare](thixotrope-on-cloudflare.md).
It supersedes §4 (Architecture) and §7 (Transport topology) of the base report and adds
lifecycle and collection.
The crank lifecycle and hibernation rules (§5) and the heap store port (§6) still apply
unchanged.*

---

## 1. Summary

The unit of deployment is a **single-vat hub**: one Durable Object holding one Ironhorse vat
**and** its own OCapN hub (c-lists, answer routes, gifts, publications, peer sessions).
Wherever local Thixotrope would call `createWorker`, Thixotrope on Cloudflare creates a
single-vat hub that can take part in third-party handoffs.

A small **control DO** per tenant manages the hubs' lifecycle.
It creates and incarnates hubs, retires them, manages leases, and runs a rare
cycle-collection pass.
**Hubs never end themselves.**
They report conditions to control, and only control deletes them.

What this buys:

- **One transaction per crank covers routing and the vat.**
  There's no hub↔worker protocol, no frame journal, no sleep images, no incarnation leases.
- **No central hop or serialization point.**
  Vats talk to each other directly, hub to hub, over DO RPC.
  Control is off the message path.
- **Collection is mostly local.**
  A hub detects on its own when nothing can ever reach it again, and that condition, once
  true, stays true.
  The global pass shrinks to occasional cycle collection.

---

## 2. Terms

| Term | Meaning |
|---|---|
| **Hub** | A single-vat hub DO: Ironhorse vat + OCapN hub tables in one SQLite database |
| **Control** | The per-tenant control DO: registry and lifecycle authority over hubs |
| **Edge router** | Stateless Worker: TLS, auth, routes external WebSockets to hubs |
| **Session** | A durable OCapN session between a hub and one peer (another hub or an external node) |
| **Incarnate** | Control's one-time call that boots a heap in an empty hub |
| **Collectible** | A hub's local condition that no referrer can ever reach it again (§7.1) |

---

## 3. Topology

```
 external peers ──WebSocket──► Edge router ──acceptWebSocket──┐
                                                              ▼
 ┌──────────── tenant ───────────────────────────────────────────────┐
 │                                                                    │
 │   ┌──────────────┐   DO RPC (OCapN frames)   ┌──────────────┐      │
 │   │  Hub DO  A   │◄─────────────────────────►│  Hub DO  B   │      │
 │   │ vat + hub    │                           │ vat + hub    │      │
 │   └──────┬───────┘                           └──────┬───────┘      │
 │          │  lifecycle reports / admin RPC           │              │
 │          └──────────────►┌──────────────┐◄──────────┘              │
 │                          │  Control DO  │  registry, leases,       │
 │                          │  (off path)  │  retirement, cycle GC    │
 │                          └──────────────┘                          │
 └────────────────────────────────────────────────────────────────────┘
```

- **Data path:** hub ↔ hub (DO RPC) and external ↔ hub (WebSocket through the edge router).
  Control is never on it.
- **Control path:** hub → control (reports) and control → hub (admin RPC).
  This traffic is rare and wakes control only briefly.

---

## 4. Hub DO

### 4.1 Storage

All in the hub's DO SQLite, written in one transaction per crank:

| Group | Contents |
|---|---|
| Heap store | Ironhorse `HeapStore` tables (see base report §6) |
| Sessions | `session(id, peer, kind, durable, state, lease_expiry, inbound_watermark, next_out_seq)` |
| C-lists | Per-session position ↔ reference rows (from `hub.js`) |
| Answer routes | Pending questions/answers, promise listeners |
| Gifts | Deposited gifts, withdrawal waiters |
| Publications | Swissnum → export (including the creator's `shell`) |
| Outbox | `outbox(session, seq, frame)`, trimmed on peer ack |
| Liveness counters | `live_exports`, `gifts`, `publications`, `pending_questions`, `listens`, `host_ops`, `alarms` (§7.1) |
| Meta | `incarnated`, `control_id`, `control_token`, `state` (`active` / `fenced` / `failed` / `retired`), `engine_profile` |

### 4.2 Crank

One `webSocketMessage`, RPC `deliver`, or `alarm` event runs exactly one crank, synchronously
and inside `transactionSync`:

1. Refuse the event if `meta.state ≠ active`, or if the hub isn't incarnated.
2. Drop the frame if `seq ≤ session.inbound_watermark` (a duplicate).
3. Decode the frame against the session's c-list, deliver it to the vat, run to quiescence,
   and drain the vat's outbound queue.
4. Re-encode the outbound frames per destination session and append them to the outbox with
   the next sequence numbers.
5. Advance the inbound watermark, update the liveness counters, and commit the heap's dirty
   pages.
6. If the hub has just become collectible, append `collectible(epoch)` to the control outbox.

After the transaction commits (output gates guarantee durability), send the outbox frames: RPC
for hubs, `ws.send` for sockets.

### 4.3 Hub-to-hub delivery (exactly once)

- The sender keeps each frame in its outbox until the receiver acknowledges it.
  The acknowledgement is the RPC return value, carrying the receiver's new watermark.
- The receiver deduplicates on `(session, seq)` against a watermark committed in the same
  transaction as the crank's effects.
- If the sender is evicted mid-call, an alarm on wake resends everything that hasn't been
  acknowledged.
- **One delivery in flight per session** preserves E-order.
  Different sessions can have deliveries in flight at the same time.

### 4.4 External peers

- External nodes dial in through the edge router, which calls `acceptWebSocket` on the hub.
  The attachment holds `{sessionId}` and nothing else.
- Hubs **never dial out** WebSockets, because outbound sockets don't hibernate.
  To reach an external node, use a relay the node connects to.
- Deploys drop all sockets.
  Durable sessions resume by reconnecting and exchanging watermarks.

### 4.5 RPC surface

| Method | Caller | Purpose |
|---|---|---|
| `deliver(sessionId, seq, frame)` → `{ack, frames}` | peer hubs | Data path |
| `openSession(peerHubId, handshake)` | peer hubs | New session (e.g., after a handoff) |
| `incarnate(boot, controlToken, profile)` | control | One-time boot; refused if already incarnated |
| `report(controlToken)` → `{epoch, counters, importsFrom[]}` | control | Collection and diagnostics |
| `prepareRetire(controlToken, epoch)` | control | Recheck collectible; set `fenced` |
| `retire(controlToken, {archive})` | control | Retirement procedure (§6.3) |
| `export(controlToken)` → R2 key | control | Archive or migration |

`controlToken` is generated by control at incarnation and stored in hub meta.
DO RPC doesn't identify the caller, so the token is what separates the control path from the
data path.

---

## 5. Addressing, capabilities, handoff

- **Hub ID** = `newUniqueId({ locationHint })`.
  It is a routing address only; only the tenant's own Worker code can turn it into a stub.
- **Sturdyref** = `(hub ID, swissnum)`.
  The swissnum is the capability.
- **Creating a worker** returns two separate capabilities:
  - the hub's **shell/evaluator**, exported by the hub itself (the `shell` publication);
  - a **lifecycle capability** (`retire`, `getId`), exported by control.

  Control can end a hub but has no path to the vat's objects.
- **Handoff:** the gift table lives in the receiving hub's SQLite.
  The recipient presents a certificate signed with the gifter's session key, the receiving hub
  opens a session through `openSession`, and the recipient withdraws the gift.
  Hubs keep OCapN keypairs for signing certificates even though transport between DOs is
  internal.
- **Known limitation carried over:** pipelining onto a gift that hasn't been deposited yet
  breaks rather than queueing.
  It matters more here, because every introduction between vats is now a handoff, so it's a
  priority fix.

---

## 6. Lifecycle

### 6.1 Create

1. Control generates a hub ID with a location hint and a `controlToken`, and writes the
   registry row `state = creating`.
2. Control calls `hub.incarnate(boot, controlToken, profile)`.
   The hub boots its heap and publishes `shell`.
3. The registry row becomes `active`.
   The caller receives the shell capability and the lifecycle capability.

The same sequence runs again if control is evicted partway through.
`incarnate` is idempotent for the same token.

### 6.2 Never create implicitly

The hub constructor never boots a heap.
A message to an ID that hasn't been incarnated, or has been retired, **creates an empty DO that
refuses the message without writing anything** and returns a distinguishable `not-incarnated`
error.
Senders treat this as permanent retirement, not a temporary failure.
This **resurrect-and-refuse** behavior is the tombstone, so peers don't need tombstone rows of
their own.
Control never reuses an ID.

### 6.3 Retire

```
Control                          Hub (target)                      Peers
───────                          ────────────                      ─────
registry: → retiring (+ alarm)
  retire(token) ───────────────► state = retired (refuse input)
                                 drop publications
                                 op:abort → every session ──────► mark rows dead; holders reject
                                 ws.close(sever)  ──────────────► external peers
                                 [archive → R2]
                                 deleteAll()
  ◄──────────────── ok ─────────
registry: → retired (tombstone, archive key)
```

- **Resumable:** control records `retiring` before the call.
  A retry against an already-empty hub gets `not-incarnated`, which control treats as done.
- **Aborts are best-effort** and go out before `deleteAll()`.
  Unreachable peers find out later through resurrect-and-refuse.

### 6.4 Fatal halt

A deterministic VM halt, including budget exhaustion:

- The hub sets `state = failed`, aborts all sessions (holders reject), keeps its heap for
  inspection, and reports `failed` to control.
- The poison input is not replayed.
- Control marks the registry row `failed`.
  Deletion follows operator action or a retention period.

### 6.5 Triggers for retirement

| Trigger | Initiator | Path |
|---|---|---|
| Explicit `retire()` | Holder of the lifecycle capability | Control → §6.3 |
| Local collection (§7.1) | Hub reports `collectible` | Control → `prepareRetire` → §6.3 |
| Cycle collection (§7.3) | Control alarm | Control → fence → §6.3 |
| Lease or quota expiry | Control alarm | Policy: archive, retire, or unpublish |
| Fatal halt | Hub reports `failed` | Control → retention → §6.3 |

---

## 7. Collection

### 7.1 Local signal

A hub is **collectible** when all of the following hold:

> no live exports on any session
> ∧ no deposited gifts or withdrawal waiters
> ∧ no publications (including `shell`)
> ∧ no pending questions, listens, or host operations
> ∧ no scheduled alarms

**Why it's safe:** a hub can gain a referrer only through an existing session, a sturdyref, or a
gift withdrawal.
With none of those, and no pending work of its own that could act, the hub can never be reached
or have visible effects again.
**The condition, once true, stays true**, so there's no race between reporting and retiring.

**Mechanics:**

- The counters are updated in the crank transaction, so the check costs nothing.
- The transition to collectible appends `collectible(epoch)` to the control outbox.
- Control calls `prepareRetire`, which rechecks the counters, then runs §6.3.
  No fence coordination between hubs is needed.
- Retiring a hub releases its imports, which can make the hubs it referenced collectible in
  turn, one step at a time.

### 7.2 Supporting rules

1. **Session GC.**
   Drop a session once both of its c-lists are empty, no answers are pending in either
   direction, and no gifts reference it.
   This keeps empty durable sessions from pinning hubs.
2. **Leases on disconnected durable sessions.**
   A resumable external session that stays disconnected past its lease is retired, and its
   imports are released.
   The lease length is tenant policy.
3. **Guest GC cadence.**
   Exports drop only after the peer's guest GC reports the release.
   Hubs run Ironhorse GC at idle, for example on an alarm after a period of quiet, so the
   release messages actually go out.

### 7.3 Cycle backstop

Mutual references between hubs keep the local signal from firing.
Control occasionally runs mark and sweep:

1. **Scope:** only hubs whose remaining referrers are all hubs in the same tenant.
   Hubs with publications, external sessions, gifts, or pending work are roots.
2. **Mark:** `report()` each in-scope hub for `{epoch, importsFrom[]}` and mark from the roots.
3. **Fence:** `prepareRetire(epoch)` on each candidate.
   The hub confirms no roots newer than `epoch` and sets `fenced`, refusing new sessions and
   gift withdrawals.
4. **Verify:** every importer of a fenced hub must itself be fenced or retired.
   Retire the verified hubs and unfence the rest.

Gifts in flight count as roots in the receiving hub, so a reference that's partway through a
handoff can't look like garbage.

### 7.4 Diagnostics

`inspectReachability` becomes a control-side merge of hub `report()`s.
It keeps today's redactions: publication secrets are omitted, and session identifiers appear as
fingerprints.

---

## 8. Control DO

**State:**

- registry: `hub_id → {owner, created, profile, state, lease, archive_key, control_token}`
- lease schedule
- GC epochs

**It never holds** capabilities to vat objects, and it never routes data frames.

| Operation | Notes |
|---|---|
| `create({locationHint, boot})` | §6.1 |
| lifecycle capability `retire()` | §6.3 |
| `collectible(hubId, epoch)` | from hubs; §7.1 |
| `failed(hubId, reason)` | from hubs; §6.4 |
| alarm: leases, retention, cycle pass | §6.5, §7.3 |
| `migrate(hubId, locationHint \| profile)` | export → incarnate a new ID → forward publications → retire the old ID |

**Scale:** one control DO per tenant.
It wakes only for lifecycle events and hibernates otherwise.

**Durability:** every multi-step operation writes its intent to the registry first and finishes
on an alarm, so it's idempotent across control evictions.

---

## 9. What local Thixotrope machinery goes away

| Local Thixotrope | Single-vat hub DO |
|---|---|
| Central hub in the daemon routing all traffic between workers | Per-vat hub; direct hub-to-hub traffic |
| Hub↔worker durable transport, frame journal, replay suffix | Gone: hub and vat commit in one transaction |
| Sleep = fold WAL, copy image, record `{ref, cut}` | Platform hibernation |
| `idleSleepMs` policy | Platform eviction |
| Kernel, incarnation and active leases; reclaiming abandoned copies | DO single-instance guarantee |
| Hub-local `collectVats` mark and sweep | Local collectible signal + rare cycle pass in control |
| Retired-worker tombstones in hub tables | Resurrect-and-refuse |

**What stays:**

- per-session sequence numbers and watermarks (now only between hubs)
- the endpoint's at-most-once host obligations (now per hub)
- computron budgets
- fatal-halt quarantine
- the handoff and gift machinery

---

## 10. Failure modes

| Failure | Outcome |
|---|---|
| Hub evicted mid-crank | Crank not committed; nothing visible (output gates). Sender resends; the receiver's watermark deduplicates |
| Hub evicted with unacknowledged outbox | Alarm on wake resends; the receiver deduplicates |
| Control evicted mid-lifecycle operation | Registry intent + alarm resumes; hub operations are idempotent under the token |
| Deploy | All sockets drop; durable sessions resume; data between hubs is unaffected |
| Message to a retired hub | Empty DO refuses with `not-incarnated`; sender marks the session permanently retired |
| Peer never runs guest GC | Hub stays referenced; handled by guest GC cadence and session leases, not correctness |
| Deterministic VM halt | `failed`, sessions aborted, heap kept, no poison replay |

---

## 11. Open questions

1. **Handoff to undeposited gifts.**
   Queue the pipelined messages instead of breaking.
   This is higher priority now that all introductions are handoffs.
2. **Push or pull for cycle-pass edges.**
   Pull is simpler (wakes every in-scope hub once per pass); push is cheaper per pass but adds
   control traffic.
3. **Hubs referenced across tenants.**
   Proposed rule: the control DO that created the hub owns its lifecycle, and other tenants'
   references are external-session roots.
4. **Host resources that retain hubs internally.**
   Decide whether control or the using hub reports them as roots, replacing today's explicit
   `keep`.
5. **Lease defaults.**
   Disconnected-session lease length, retention for failed hubs, archive-on-retire policy.
6. **Placement.**
   Initial location hint per hub (creator, first peer, or user), and whether to migrate hubs
   that talk mostly to remote peers.

---

## 12. Rollout changes

- **Phase 0** (base report) additionally measures: hub-to-hub RPC latency, and one crank
  including routing (c-list rewrite + outbox) against one crank without it.
- **Phase 2** becomes single-vat hubs + control DO.
  The multi-vat central-hub design is not built.
- **New acceptance tests:**
  - exactly-once hub-to-hub delivery under injected evictions
  - resurrect-and-refuse
  - collection spreading along a chain
  - a two-hub cycle collected by the backstop
  - a handoff in flight surviving a cycle pass
  - control-eviction resumability for create, retire and migrate
