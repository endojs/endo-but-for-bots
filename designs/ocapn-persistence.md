# Goblins-Style Persistence over OCapN (`@endo/portrait`)

| | |
|---|---|
| **Created** | 2026-07-13 |
| **Author** | Aaron Kumavis (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Objects exported over our OCapN implementation are ephemeral.
`@endo/ocapn` has no persistence hooks of any kind
(`grep -riE 'persist|snapshot' packages/ocapn/src` is empty), and every
identity it manages is session-scoped: export positions are per-session
monotonic bigints (`packages/ocapn/src/client/ref-kit.js:120`), the
session manager's four tables are in-memory Maps
(`packages/ocapn/src/client/index.js:56`), and the default sturdyref
`locator` is a plain `Map`.

The consequence is visible in `packages/goblin-chat`: `host-room.js`
mints a sturdyref by `locator.set(swissStr, chatroom)` on an in-memory
Map, and its `state-store.js` remembers only the room's URI in a JSON
file.
A hosted chatroom therefore dies with the process while its sturdyref
URI lives on — the worst combination.

The Endo daemon solves durability for its own world with formulas and
reincarnation (`packages/daemon/src/daemon.js:601`), but that machinery
is daemon-shaped: it assumes the formula graph, pet stores, workers, and
a SQLite substrate owned by a long-running supervisor.
There is no *library-level* persistence a plain Node, XS, or browser
process can use to make its OCapN-exported objects survive restart.

Spritely Goblins solved exactly this problem with its persistence
subsystem, code-named **Aurie**.
This design documents how Aurie works (Part 1), surveys the seams and
gaps in this repository (Part 2), and plans an equivalent layered on
`@endo/exo`, `@endo/marshal`, and `@endo/ocapn` without wire-protocol
changes (Part 3).

## Part 1: How Goblins Does It (Research)

Sources: the Guile Goblins manual
([Persistence chapter](https://files.spritely.institute/docs/guile-goblins/latest/Persistence.html)),
the
[v0.13.0](https://spritely.institute/news/spritely-goblins-v0-13-0-object-persistence-and-easier-io.html)
and
[v0.14.0](https://spritely.institute/news/spritely-goblins-v0-14-0-libp2p-and-improved-persistence.html)
release notes, and the source at
[codeberg.org/spritely/goblins](https://codeberg.org/spritely/goblins)
(branch `main`, read 2026-07-13; file references below are into that
tree).

### 1.1 Manual persistence, not orthogonal persistence

Goblins deliberately rejects image-style orthogonal persistence
(Smalltalk snapshots, or Agoric-style full-vat transcript replay) in
favor of **manual persistence with good ergonomics**: each actor
describes its own durable state, and the host decides which behaviors
may be revived.
The design descends from E's "serialization is uneval/unapply" tradition
and Mark Miller's *Safe Serialization Under Mutual Suspicion*; the
v0.13 announcement describes Aurie as "a metacircular evaluator running
in reverse".
Two security properties fall out:

1. An object can only describe itself in terms of capabilities it
   actually holds, so restore can never grant more authority than the
   object had.
2. Only constructors the host explicitly registered in a
   *persistence environment* can ever run at restore time.

### 1.2 Core model: transactional heaps, churns, deltas

A Goblins **actormap** is a transactional heap mapping references to
behavior+state cells.
Each message delivery (a *turn*) runs in a copy-on-write
**transactormap**; a raised error discards the overlay.
A **churn** is one external delivery plus all resulting same-vat
deliveries run to quiescence.

Persistence hooks fire at **churn commit** (`goblins/vat.scm`,
`vat-maybe-persist-changed-objs!`): the committed transactormap's write
set (`transactormap-data-delta`) is exactly the dirty set, so
steady-state persistence is **per-churn, delta-based, and only ever
captures committed state**.
A crashed turn leaves both heap and store untouched.

### 1.3 Opt-in via portraits

An actor opts in by pairing its behavior with a **self-portrait
thunk** — a zero-argument closure returning the values needed to
reconstruct it (`portraitize`, `goblins/core-types.scm`).
The `define-actor` macro generates this: the default portrait is **the
list of constructor arguments**, which works because idiomatic Goblins
state change is `(bcom (^ctor bcom new-state))` — state *is*
re-invocation arguments.
Keywords refine the default:

- `#:portrait` — custom snapshot thunk.
- `#:version n` — tags portraits with a version.
- `#:restore proc` — custom rehydrator `(version . args) -> actor`.
- `#:upgrade migrator` — steps `(version, data)` forward one version at
  a time (the `migrations` macro).
- `#:frozen` — opt out of live code redefinition while remaining
  persistable.

Non-frozen constructors are wrapped in a `redefinable-object` so the
constructor value stays `eq?` while its code is redefined — the basis of
both REPL live-hacking and `actormap-replace-behavior!` (hot upgrade
that splices new behavior under the *old* reference).

### 1.4 The persistence environment

Closures are never serialized; **behavior is re-supplied at restore time
from a host-controlled registry**, the `persistence-env`: a
bidirectional map between stable names and
`(constructor, rehydrator)` pairs.
Names are conventionally module path + export symbol, e.g.
`'((goblins actor-lib cell) ^cell)`.
Environments compose (`make-persistence-env #:extends`,
`persistence-env-compose`); each library ships its own env (`cell-env`,
`captp-env`, per-netlayer envs).
The default rehydrator is `(apply spawn constructor portrait-args)`.

### 1.5 Serialization: slots and depictions

Per object, Goblins stores
`(spec-name debug-name portrait-version depiction)` where the depiction
encoder passes atoms through and tags everything else:

- **near ref** (same heap) → `(tagged 'near (slot))` where *slot* is an
  integer allotted from a per-actormap counter at spawn — slots are the
  identity system; the counter is recovered on restore as `max(slot)`;
- **local far ref** (another vat, same process) →
  `('far (vat-aurie-id object-aurie-id))`, restored as a promise
  resolved via a shared `^persistence-registry` rendezvous actor;
- **promise**: resolved → `('encase value)`; **unresolved → `('broken)`**
  (restored as a promise broken with a persistence error);
- **OCapN sturdyref** → `('ocapn-id "uri-string")` — durable by
  handle, re-enlivened by the application;
- **live remote OCapN refs → a hard `persistence-error`** — they are
  not serializable, on purpose.

A graph is `(portraits: slot -> portrait, root-slots)`; the reference
file store writes it as Syrup with atomic tmp-file+rename replacement.

### 1.6 Stores

The store abstraction is two message-dispatching procedures
(`make-persistence-store read-proc save-proc`) with four operations:

| Operation | Semantics |
|---|---|
| `graph-and-slots` | → `(vat-id, roots-version, portraits, roots)` |
| `object-portrait slot` | one portrait (for waking sleepy actors) |
| `save-graph ...` | full snapshot |
| `save-delta slot->portraits` | changed objects since last save |

Shipped stores: memory (generational log aimed at time-travel
debugging), single Syrup file, `bloblin` (append-oriented deltas with
interned symbols plus mark-sweep orphan removal on rewrite), and
browser localStorage/IndexedDB variants.
Full snapshots happen only at first spawn, after root upgrades, and on
demand; steady state is deltas.

### 1.7 Vat boot, upgrade, sleepy actors

`spawn-persistent-vat env spawn-roots-thunk store #:version #:upgrade
#:persist-on #:sleep-strategy` reads the store: if a graph exists it
restores roots-outward (never running `spawn-roots-thunk`); otherwise it
runs the thunk and takes a full portrait.
A stored `roots-version` older than `#:version` routes through the
`#:upgrade` procedure before the fresh snapshot.
Restore is roots-outward specifically to avoid resurrecting orphans,
and take-portrait is a BFS from roots — an object omitted from every
portrait simply is not saved.

With a sleep strategy, restore leaves objects as skeletal
`mactor:asleep` placeholders (just constructor-name plus a strong table
of the refs their portrait mentions); the first delivery wakes them by
reading one portrait from the store.
`sleep:always` and `sleep:lru` ship; bedtime is evaluated after each
churn.

### 1.8 What Goblins does NOT persist

In-flight messages and vat queues (lost on crash — persistence is
quiescent-state only), unresolved promises (break on restore), live
remote references (must be re-established from sturdyref data; the
sturdyref nonce registry is itself a persistable actor so issued
sturdyrefs keep working), and live OS resources (netlayers are ordinary
persistable actors whose portraits capture inert data — host, port,
TLS keys — and whose constructors re-open sockets on restore).

## Part 2: What We Have Today

### 2.1 Seams in `@endo/ocapn`

- **The `locator`** passed to
  `makeOcapn({ ..., locator })` (`src/client/index.js:197`) is the
  single revival hook: inbound `fetch(swissnum)` resolves through
  `sturdyRefTracker.lookup` → `locator.get(secret)`, which may return a
  Promise (`src/client/sturdyrefs.js:100`).
  Nothing assumes the locator is a Map — it can consult a store and
  reincarnate on demand.
- **Table hooks**: `makeOcapnTable({ importHook, exportHook,
  onSlotCollected })` (`src/captp/ocapn-tables.js:17`) observes every
  export/import; `grantTracker` (`src/client/grant-tracker.js:56`)
  already maintains remotable → `{ location, slot, type, swissNum }`.
- **`giftTable`** is caller-supplied (`src/client/index.js:203`) and
  could be durable already.
- The comms kit's
  `clearPendingRefCounts`/`commitSentRefCounts` bracketing
  (`src/client/ocapn.js:160`) marks the transaction-shaped point in the
  dispatch loop — the natural per-delivery commit hook.

### 2.2 Gaps

- `defineExoClass` state lives in a per-class WeakMap
  (`packages/exo/src/exo-makers.js:74`); `init` runs only at first
  creation; there is no durable-kind, baggage, liveslots, or vatstore
  analog anywhere in this repo.
- No stable local object identity: the only cross-session identity is
  `(location, swissnum)`.
- Session state, gift table contents, and ocapn-noise identity keys are
  ephemeral (the daemon persists its own root keypair separately,
  `packages/daemon/src/daemon-persistence-powers.js:79`).

### 2.3 Prior art in-repo

The daemon's formula graph is the same shape as Aurie viewed from a
different angle:

| Aurie | Endo daemon |
|---|---|
| portrait (state snapshot) | formula (construction recipe) |
| persistence-env (name → constructor) | formula types + `evaluateFormulaForId` |
| slot (integer per heap) | formula number (random 256-bit) |
| restore roots-outward | `provideController` memoized reincarnation |
| store (`save-graph`/`save-delta`) | SQLite `writeFormula` before visibility |
| eager wake of pinned roots | `revivePins()` at start |

The key difference: formulas describe *how a value was constructed*
(re-execution of a recipe), while portraits describe *what an object's
state currently is* (snapshot + rehydrate).
Portraits suit long-lived mutable objects; formulas suit derived
values.
Reusable substrate: `@endo/daemon`'s SQLite discipline,
`@endo/daemon-cas`, and `@endo/marshal`'s
`makeMarshal(convertValToSlot, convertSlotToVal)`
(`packages/marshal/src/marshal.js:44`) — the off-the-shelf mechanism
for serializing state records whose remotable-valued fields become
durable designators.

## Part 3: Design

A new package, `packages/portrait` (`@endo/portrait`), in four layers:
persistence environments, persistent exo classes, the heap (graph +
store), and OCapN wiring.
No changes to the OCapN wire protocol; integration is purely through
the existing `locator`, `giftTable`, and table hooks.

### 3.1 Concept mapping

| Goblins | `@endo/portrait` |
|---|---|
| `make-persistence-env` | `makePersistenceEnv(entries, { extends })` |
| `define-actor` + `portraitize` | `definePersistentExoClass(env, name, ...)` |
| `spawn-persistent-vat` | `makePersistentHeap({ env, store, ... })` |
| slot (aurie id) | slot (integer, allotted at first persist) |
| `versioned` / `migrations` | `version` / `upgrade` options |
| store (`graph-and-slots`, ...) | `PortraitStore` interface |
| sturdyref nonce registry actor | durable locator bindings in the heap |
| sleepy actors | Phase 5 (wake-on-fetch already free via locator) |

### 3.2 Persistence environments

```js
/** @typedef {`${string}#${string}`} BehaviorName  module specifier + '#' + export */

const makePersistenceEnv = (entries, { extend = [] } = {}) => { ... };
harden(makePersistenceEnv);
// entries: Array<[BehaviorName, PersistentClass]>
// PersistentClass carries its own restore/upgrade; env is the
// bidirectional map class <-> name, later entries win on collision.
```

Names are fully qualified specifier-plus-export strings, e.g.
`'@endo/portrait-demo#makeCounter'`, mirroring Goblins'
module-path-qualified symbols.
The env is the security boundary: `restoreHeap` only ever invokes
rehydrators reachable from the env the host passed in.
Library packages export their own envs for composition, exactly as
Goblins' `cell-env`/`captp-env` do.

### 3.3 Persistent exo classes

Goblins' default portrait is the constructor argument list because
Goblins state change is re-invocation (`bcom`).
Exo state change is mutation of the sealed state record, so our default
portrait is **the current state record** and the default restore
**re-creates the instance around that record without re-running
`init`**:

```js
const makeCounter = definePersistentExoClass(
  env,
  '@endo/portrait-demo#makeCounter',
  M.interface('Counter', {
    increment: M.call().returns(M.number()),
  }),
  (start = 0) => ({ count: start }), // init: first creation only
  {
    increment() {
      this.state.count += 1;
      return this.state.count;
    },
  },
  {
    version: 1,
    // portrait: (state) => Passable      — default: harden({ ...state })
    // restore: (version, depiction) => state — default: identity
    upgrade: {
      // one step per version, applied in sequence, as in Goblins'
      // `migrations` macro
      0: old => harden({ count: old.n }),
    },
  },
);
harden(makeCounter);
```

Implementation: a wrapper over `defineExoClass` that
(a) registers the class in the env under its name,
(b) interposes on the state record with accessor properties so every
write marks the instance dirty in its owning heap (the state record
`seal` in `exo-makers.js` seals the shape, not writability, so a
write-through record is compatible), and
(c) records `(class, instance) -> slot` in the heap when the instance
first becomes reachable from a root.
A `definePersistentExoClassKit` sibling follows the same pattern.

State-record fields must be Passable, with remotable-valued fields
restricted to the depiction-encodable set (§3.5).
`mustMatch` against an optional state shape runs on both portrait and
restore, giving schema checking at the store boundary for free via
`@endo/patterns`.

### 3.4 The heap

```js
const heap = await makePersistentHeap({
  env,
  store,
  version: 1,
  spawnRoots: () => harden({ counter: makeCounter(0) }),
  upgradeRoots: (oldVersion, roots) => ({ version: 1, roots }), // optional
  persistOn: 'commit', // or 'manual'
});
// heap: {
//   roots,                      // restored or freshly spawned
//   flush(),                    // Promise<void>: write pending deltas
//   takeSnapshot(),             // full graph rewrite (also compacts)
//   locator,                    // durable locator for makeOcapn (§3.7)
//   makeSturdyRefBinding(obj),  // mint + persist swissnum -> slot
//   close(),
// }
```

Boot mirrors `spawn-persistent-vat`: read `graphAndSlots()`; if a graph
exists, restore roots-outward and never call `spawnRoots`; else call
`spawnRoots`, BFS the reachable persistable graph, allot slots, and
`saveGraph`.
A stored roots version older than `version` routes through
`upgradeRoots` and then a fresh full snapshot.
The slot counter is recovered as `max(slot)`.

Restore is roots-outward (plus any slots pinned by sturdyref bindings,
§3.7) so orphaned portraits are never resurrected; they are dropped at
the next `takeSnapshot` compaction, matching Goblins' bloblin
mark-sweep.

### 3.5 Portrait encoding

Per-object stored record:

```js
{ name, version, body, slots } // body+slots from @endo/marshal capdata
```

Encoding uses `makeMarshal(convertValToSlot, convertSlotToVal)` with
smallcaps body format.
`convertValToSlot` maps:

| Value | Slot designator |
|---|---|
| persistent instance, same heap | `n:<slot>` (near) |
| sturdyref (`ocapn-sturdyref` CopyTagged) | `s:<uri>` |
| unresolved promise | `b:` (broken on restore) |
| anything else remotable (incl. live remote presences) | **throw** |

Copy-data passes through marshal untouched.
Throwing on live remote refs is deliberate Goblins parity: the durable
form of a remote capability is a sturdyref, and the application decides
when to re-enliven it (`enlivenSturdyRef` already exists,
`src/client/sturdyrefs.js:51`).
Goblins' `'far'` designator for same-process sibling heaps and its
`^persistence-registry` rendezvous are deferred to Phase 5; one heap
per process is the v1 model.

The store payload is plain JSON in v1 (debuggable, portable across
Node/XS/browser); a Syrup encoding of the same structure is a possible
later store variant, but store-format compatibility with Goblins is a
non-goal — interop happens over the wire via OCapN, not by sharing
store files.

### 3.6 Stores and commit points

```js
/**
 * @typedef {object} PortraitStore
 * @property {() => Promise<GraphAndSlots | undefined>} graphAndSlots
 * @property {(slot: number) => Promise<StoredPortrait>} objectPortrait
 * @property {(graph: Graph) => Promise<void>} saveGraph
 * @property {(delta: Map<number, StoredPortrait>) => Promise<void>} saveDelta
 * @property {() => Promise<void>} close
 */
```

Phase 1 ships `makeMemoryStore()` (generational log, as in Goblins —
useful for tests and eventual time-travel tooling) and
`makeFileStore(path, filePowers)` (single JSON file, atomic
tmp+rename, exactly the discipline of goblin-chat's `state-store.js`
and Goblins' syrup store).
Phase 4 adds a SQLite store borrowing `packages/daemon`'s
better-sqlite3/XS dual-driver pattern.

**Commit points.**
We do not have transactormaps, so v1 offers a weaker but honest
guarantee:

- Writes to persistent state mark the instance dirty.
- The heap flushes the dirty set as a `saveDelta`
  (1) after each inbound OCapN delivery completes its synchronous turn
  (hooked around `dispatchMessageData`), and
  (2) on a microtask-drain debounce for purely local mutation, and
  (3) on explicit `flush()`.
- Unlike Goblins, a method that throws after mutating state does not
  roll back; the mutation persists.

This divergence is documented loudly.
A later phase can recover turn-transactionality by snapshotting dirty
state records at turn start and restoring them on throw
(copy-on-write per turn), which is tractable precisely because state
records are Passable copy-data plus designators.

### 3.7 OCapN integration (no wire changes)

- **Durable locator.**
  `heap.locator` implements the `{ get(secret) }` contract of
  `makeOcapn`'s `locator`.
  `heap.makeSturdyRefBinding(obj)` mints a Goblins-compatible 24-byte
  swissnum, persists `swissnum -> slot` in the store, and returns the
  binding; `locator.get` looks up the slot and revives the object (and
  transitively its portrait graph) on demand — the analog of Goblins'
  persistable nonce registry, and lazy wake-on-fetch for free.
  Sturdyref-bound slots count as pinned roots for restore reachability.
- **Identity.**
  A `providePersistentIdentity(store)` helper persists the ocapn-noise
  Ed25519 keypair alongside the graph so the node's location (and
  therefore its issued sturdyref URIs) survives restart, mirroring the
  daemon's `provideRootKeypair`.
- **Gift table.**
  Optionally back `makeOcapn`'s caller-supplied `giftTable` with the
  store (later phase; gifts referencing live remote objects are subject
  to the same sturdyref-only rule).
- **Proving app: goblin-chat.**
  Convert `host-room.js` to a persistent heap: the chatroom, its
  message log cell, and its member registry become persistent exo
  classes; the room's sturdyref survives restart, closing the gap
  described in Part 0.

### 3.8 Versioning and upgrade

Per-class `version` plus stepwise `upgrade` maps, checked at restore;
heap-level `version`/`upgradeRoots` for root reshaping — both directly
transliterated from Goblins (`#:version`, `migrations`, vat
`#:upgrade`).
Goblins' `redefinable-object` live-code replacement
(`vat-replace-behavior!`) has no v1 analog; our upgrade story is
restart-with-new-code, which the version machinery already covers.

## Dependencies

| Design / package | Relationship |
|---|---|
| [ocapn-noise-network](ocapn-noise-network.md) (**Complete**) | provides the netlayer whose identity keys the heap persists |
| `@endo/ocapn` locator / table hooks | integration seam; no changes required beyond possibly exporting the delivery-commit hook |
| `@endo/exo`, `@endo/patterns`, `@endo/marshal`, `@endo/pass-style` | substrate for classes, schemas, and portrait encoding |
| `@endo/daemon` (reference) | SQLite discipline and reincarnation memoization prior art; not a dependency |
| `packages/goblin-chat` | first adopter / proving app (Phase 2) |
| [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) | complementary: reconnect handles session liveness, portrait handles process death |

## Phased Implementation

1. **Phase 1 — core (`@endo/portrait`).**
   `makePersistenceEnv`, `definePersistentExoClass(+Kit)`,
   `makePersistentHeap` with full-snapshot save/restore, memory and
   atomic-file stores, marshal-based portrait codec.
   Tests: round trip, near-ref graphs, sturdyref designators, broken
   promises, class and root version upgrade, orphan non-resurrection.
2. **Phase 2 — OCapN wiring.**
   Durable locator + sturdyref bindings, persistent noise identity
   helper, goblin-chat host-room adoption with a
   kill-and-restart-the-host integration test.
3. **Phase 3 — deltas and commit points.**
   Dirty tracking via write-through state records, `saveDelta`,
   delivery-turn flush hook around ocapn dispatch, `takeSnapshot`
   compaction with mark-sweep orphan removal.
4. **Phase 4 — upgrade ergonomics and SQLite store.**
   `migrations`-style helper, state-shape `mustMatch` at the store
   boundary, SQLite store on the daemon's dual-driver pattern.
5. **Phase 5 — stretch.**
   Sleepy instances with LRU bedtime, multi-heap `'far'` designators
   with a persistence-registry rendezvous, durable gift table,
   generational time-travel tooling over the memory store, turn
   rollback via copy-on-write state records.

## Design Decisions

1. **Manual persistence with portraits, not formula re-execution and
   not transcript replay.**
   Matches Goblins; suits long-lived mutable objects; keeps the store
   lean; makes upgrade first-class.
   The daemon's formula system remains the right tool for derived
   values and daemon-managed lifetimes — the two systems are
   complementary, not competing.
2. **Default portrait is the state record, not constructor args.**
   Goblins' args-default exists because `bcom` makes state
   re-invocation; exo state is a mutable record, so the record is the
   honest default and `init` runs exactly once, ever.
3. **The persistence env is the sole restore authority.**
   Name → class registry keyed by module-qualified names, composable,
   host-controlled — the Miller/Rees safe-serialization stance,
   verbatim.
4. **Live remote refs are a portrait error; sturdyrefs are the durable
   form.**
   Direct Goblins parity, and it keeps restore synchronous-ish and
   deterministic.
5. **Integer slots per heap, counter recovered as `max(slot)`.**
   Cheap, stable, matches Goblins; no content hashing.
6. **No wire-protocol changes.**
   Everything attaches at the `locator`, `giftTable`, and dispatch
   seams that `makeOcapn` already exposes.
7. **v1 accepts weaker-than-Goblins turn atomicity** (no rollback on
   throw), documented, with a designed path back (copy-on-write state
   records) rather than a transactional heap rewrite of exo.
8. **JSON store format in v1; Goblins store-file compat is a
   non-goal.**
   Interop is at the OCapN wire, where it already works
   (goblin-chat).
9. **Package name.**
   `@endo/portrait` names the mechanism.
   Alternatives considered: `@endo/aurie` (homage, but confusingly
   claims Goblins' internal codename for a non-identical system) and
   `@endo/persist` (generic).

## Known Gaps and TODOs

- [ ] Decide whether the ocapn dispatch loop should export an explicit
  per-delivery commit hook or whether the heap wraps
  `dispatchMessageData` from outside.
- [ ] Exo interposition detail: confirm the write-through state record
  composes with `defendPrototype` guards and `this.state` typing in
  `types-index.d.ts`.
- [ ] Encased resolved promises (`'encase'` in Goblins) — v1 breaks all
  promises; consider persisting settled ones.
- [ ] Cross-heap (`'far'`) designators and boot-order-tolerant
  rendezvous (Phase 5).
- [ ] Relationship to daemon formulas: a `portrait-heap` formula type
  so a daemon caplet can own a heap?

## Prompt

> research how Spritely Goblins does persistence and plan an
> implementation on top of our endo ocapn implementation
> https://codeberg.org/spritely/goblins/src/branch/main/goblins
