# Goblins-Style Persistence over OCapN (`@endo/portrait`)

| | |
|---|---|
| **Created** | 2026-07-13 |
| **Updated** | 2026-07-13 |
| **Author** | Aaron Kumavis (prompted) |
| **Status** | In Progress |

## Status

Phases 1–4 are implemented as `@endo/portrait` at `packages/portrait`
(same-day as the design; 24 passing tests, package lint/types clean):

- **Phase 1 (complete):** `makePersistenceEnv` /
  `persistenceEnvCompose` (`src/env.js`), `definePersistentExoClass`
  and `definePersistentExoClassKit` (`src/class.js`) over
  `defineExoClass` with a write-observing accessor state record —
  `init` runs once ever, restore fills hollow instances so cyclic
  graphs rebuild with identity preserved — smallcaps-marshal portrait
  codec with `n:<slot>[.<facet>]` and broken-promise designators
  (`src/codec.js`, `src/heap.js`), stepwise class upgrades, roots
  versioning/upgrade, orphan-sweeping `takeSnapshot`, and the
  library-env exemplar `@endo/portrait/cell.js`.
- **Phase 2 (complete):** `src/ocapn.js` — `makeOcapnSpecials`
  (sturdyrefs in state portray as `(location, secret)` data,
  re-minted on restore; live remote presences are a capture error),
  `makeHeapLocator` (backs `makeOcapn`'s locator with persisted
  swissnum→slot bindings), `provideSturdyRefBinding` (awaits flush
  before releasing the ref — P2). `@endo/ocapn` now exports
  `isSturdyRef`/`getSturdyRefDetails` from its main entry.
  Integration test kills and restores a host over real ocapn TCP
  sessions. Adoption of goblin-chat's host-room remains open.
- **Phase 3 (complete):** delta flushes of the dirty set at microtask
  commit points (P1: synchronous capture, atomic ordered writes),
  `heap.turn(fn)` copy-on-write rollback with nesting, async-body
  rejection with rollback. The full P2 outbound-message embargo
  still awaits an ocapn dispatch hook.
- **Phase 4 (complete):** `src/stores/sqlite.js` over an injected
  better-sqlite3-compatible handle (O(dirty) delta upserts);
  `stateShape` `mustMatch` at init/portrait/restore boundaries.
- **Phase 5 (partial):** the memory store is generational with
  `graphAtGeneration` time travel. Deferred with reasons: durable
  gift table (ocapn gift keys embed ephemeral session ids — pointless
  until [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md)-style
  session resumption), sleepy instances (restore is eager; needs
  store-backed lazy wake), multi-heap `'far'` designators.
- **Phase 6 (blocked in this checkout):** the `c/moddable` submodule
  is uninitialized (`cargo check -p xsnap` fails in its build
  script), and the worker bundle generator
  (`bundle-bus-worker-xs.mjs`) referenced by
  `rust/endo/xsnap`'s `include_str!` artifacts exists neither in the
  tree nor in git history — the XS worker runtime is not reproducible
  from a clean checkout until that in-flight work (see
  [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md)) lands.

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

This divergence is documented loudly; §3.9 states exactly what
soundness survives it and §3.10 evaluates recovering full turn
atomicity from the engine.

### 3.9 Soundness without the transactional heap

"Sound" splits into three separately achievable guarantees.
The transactional heap buys only the third.

**Invariant P1 — consistent cuts.**
The store only ever holds states the live heap actually passed
through, i.e. every persisted snapshot is a consistent cut taken at a
quiescent point.
This requires, and the implementation MUST treat as named invariants:

1. *Synchronous portrait capture.*
   Portraits of the dirty set are serialized synchronously at the
   commit point; only the I/O is deferred.
   Lazy capture (an async writer reading state records later) can
   interleave with subsequent turns and produce a fuzzy snapshot — a
   mixture of states that never coexisted — which is genuinely
   unsound and is the easiest mistake to make in JS.
2. *Atomic store writes.*
   Tmp+rename or a SQLite transaction; a delta applies entirely or
   not at all.
3. *Flush only at turn boundaries.*
   Never mid-delivery.

**Invariant P2 — output commit.**
Outbound OCapN messages produced during a delivery are buffered and
released only after the delta that produced them is durably written.
Otherwise a crash between send and flush means the world saw effects
the restored state does not remember.
With persist-before-release, the failure mode flips to the safe side —
"my state remembers something the world may not have seen" — which
applications can repair idempotently.
(Goblins itself dispatches far messages *before* persisting the
churn, so this is a point where we can be stronger than the
original.)

**P3 — turn atomicity: not guaranteed in v1.**
A method that mutates field A and throws before mutating B leaves a
torn state, and we persist the tear.
But this is a weakness of live JavaScript semantics, not of the
persistence layer: the in-memory heap is equally torn and the program
continues against it either way.
Persistence-without-rollback is exactly as sound as not crashing; it
makes an existing hazard durable without creating a new one.
Under P1+P2, restart restores a state the process really was in and
never worse than survival.

Corollary hazard: an async exo method spans multiple turns from the
heap's perspective, so its intermediate state commits at every
quiescent point it awaits across.
The discipline is the standard ocap-JS one — do not hold invariants
broken across an `await` — and a debug mode SHOULD flag an instance
dirtied both before and after an await within one method activation.

Two recovery paths for P3, in increasing strength:

- *Copy-on-write state records* (Phase 3): on the first write to an
  instance within a turn, stash a copy of its state record; restore
  the stashes on throw, discard on completion.
  Nearly free because persistent state is constrained to Passable
  copy-data plus designators; piggybacks on the dirty-tracking
  interposition Phase 3 needs anyway.
  Protects persistent state only — ordinary heap objects and
  non-persistent closures still tear.
- *Engine-level heap snapshots* (§3.10): whole-heap, Goblins-grade
  "failed turn leaves no trace", at the cost of running the heap
  inside an XS worker.

### 3.10 Engine-level rollback: XS heap snapshots (endor)

Investigated 2026-07-13: Moddable XS's snapshot machinery
(`xs/sources/xsSnapshot.c`, upstream in
[Moddable-OpenSource/moddable](https://github.com/Moddable-OpenSource/moddable),
not an Agoric fork), Agoric's
[`@agoric/xsnap`](https://github.com/Agoric/agoric-sdk/tree/master/packages/xsnap)
harness and SwingSet's use of it, and this repo's own XS embedding in
`rust/endo/xsnap`.

**Mechanics.**
`fxWriteSnapshot` runs a full GC then linearly serializes the entire
machine — heap slots, closures, module records, symbol/keys tables,
value stack — to a stream; `fxReadSnapshot` always boots a *fresh*
machine from the stream (there is no in-place rewind).
Preconditions: quiescent machine (xsnap only snapshots between
commands), no host objects with native destructors, no external
strings, and every native callback registered in an append-only table
shared by writer and reader.
Snapshots hard-check XS version, architecture, and a build signature
on restore.

**How SwingSet really does rollback (confirmed).**
SwingSet never rolls back the XS heap in place.
Per-crank atomicity of *effects* comes from SQLite savepoints around
the syscall log (`establishCrankSavepoint`/`rollbackCrank` in
`kernel.js`); the heap is a disposable cache rebuilt by killing the
worker and replaying the transcript span since the last snapshot
(every `snapshotInterval = 200` deliveries).
Replay is what drags in the whole determinism discipline — liveslots,
no `Date.now`/`Math.random`, GC-timing sensitivity, the
"anachrophobia" failure class
([agoric-sdk#4617](https://github.com/Agoric/agoric-sdk/issues/4617)).

**The pivotal simplification: snapshot at *every* commit.**
Agoric needs transcript replay only because its snapshots are sparse
(and consensus demands reproducibility).
If the heap is snapshotted at every churn commit, the replay gap is
empty: rollback = kill worker, respawn from the last commit snapshot,
discard the failed turn's buffered outputs, answer the failed
delivery with an error.
**No determinism requirements on guest code at all** — nothing is
ever replayed, only restored.
That is Goblins' transactormap semantics ("a failed turn leaves no
trace"), achieved at the engine layer, and it also covers meter
faults: a metering abort mid-turn leaves the machine unreliable, and
respawn-from-last-commit is precisely the recovery the in-repo
metering design already assumes.

**Costs and constraints.**

- O(heap) full write per commit; XS has no incremental snapshot.
  Data points: empty heap ~430 kB raw; mainnet vats 2–20 MB
  compressed; Agoric's observed 2.5–3.8 s saves include gzip, SHA-256,
  forced GC, and an old file pipeline
  ([#5507](https://github.com/Agoric/agoric-sdk/issues/5507),
  [#6742](https://github.com/Agoric/agoric-sdk/issues/6742)).
  A raw, uncompressed write to a pipe or SQLite blob for a 1–5 MB
  agent-scale heap should land in the low tens of milliseconds;
  ~50 MB heaps cost ~100 ms+ per turn.
  Fine for agent- and human-paced OCapN messaging; wrong for
  high-throughput hot paths.
  Loads are fast (hundreds of MB/s; "a typical 2 MB compressed
  snapshot loads in milliseconds"), and fresh-from-snapshot workers
  measurably beat aged ones on RSS and CPU
  ([#6661](https://github.com/Agoric/agoric-sdk/issues/6661)).
- **Snapshots are ephemeral rollback artifacts, never durable ground
  truth.**
  They are pinned to XS version + architecture + build signature —
  Agoric halted a chain on a gcc-9/gcc-10 `__has_builtin` divergence
  ([#7829](https://github.com/Agoric/agoric-sdk/issues/7829)), and
  treats "new xsnap cannot load old snapshots" as the default
  ([#6361](https://github.com/Agoric/agoric-sdk/issues/6361)).
  Portraits remain the sole durable, upgradeable representation;
  engine upgrade = discard snapshot, restore the heap from portraits
  (the analog of Agoric's vat-upgrade-via-baggage).
  This division preserves the manual-persistence rationale (§1.1)
  while borrowing the engine's transactionality: snapshot = the
  transactormap, portraits = the store.
- Heap rollback covers only the VM.
  P2's output embargo becomes mandatory, enforced by the supervisor:
  buffer outbound messages during the crank; on commit, write the
  portrait delta, then snapshot, then release; on fault, discard.
  (The in-repo metering design rejected an output embargo for *quota*
  enforcement in favor of admission control; embargo for *rollback*
  is different and sound — discarded outputs are never replayed.)
- Session-table reconciliation is clean under
  snapshot-every-commit + embargo: the restored heap is exactly the
  state the peer last observed, because the failed turn's exports
  were never released.
  One known leak (not unsoundness): imports the worker received
  *during* the aborted turn are forgotten by the rollback, so the
  supervisor must emit the corresponding `op:gc-exports` on the
  worker's behalf or the peer retains those exports forever.

**What exists in this repo already.**
`endor`'s XS embedding (`rust/endo/xsnap`, mainline Moddable submodule
built with `mxSnapshot` + `mxMetering` + `mxLockdown`; the platform
layer is modeled on Agoric's xsnap-pub but reimplemented in-repo) has
most of the machinery built and unit-tested:

- non-destructive `write_snapshot` (in-memory) and streaming
  `write_snapshot_to_file` / `suspend_to_cas` with SHA-256 CAS
  storage (`rust/endo/xsnap/src/lib.rs:375,646,728`);
- `from_snapshot` / `resume_from_cas` restore, `endo-xs 1` signature,
  append-only deterministic callback table
  (`worker_snapshot_callbacks()`, lib.rs:505);
- round-trip unit tests including closures and host functions, and
  suspend/resume-cycle tests (lib.rs:3652–3996);
- a metered crank pump that already brackets exactly the commit
  boundary this design needs — one envelope plus promise-job drain to
  quiescence (lib.rs:1603–1730), per
  [daemon-xs-worker-metering](daemon-xs-worker-metering.md)
  (Complete);
- supervisor suspend/resume verbs and suspended-worker bookkeeping
  per [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md)
  (In Progress).

Remaining build work for the transactional-heap profile:
snapshot-after-successful-crank trigger (mechanically supported —
`write_snapshot` does not destroy the machine; today snapshots fire
only on explicit suspend), the supervisor outbound-message embargo,
platform-aware resume for child-process workers (`handle_resume` is
in-process only today), the missing end-to-end suspend/resume
integration test, CAS GC-root bookkeeping, the missing worker-bundle
generator (`bundle-bus-worker-xs.mjs` is referenced but absent — a
reproducibility gap), and plumbing `@endo/ocapn` deliveries to a heap
hosted inside an XS worker (today workers speak daemon-internal CapTP
over CBOR envelopes, not OCapN).

**Resulting architecture: two execution profiles, one durable
format.**

| | Node profile | XS profile (endor) |
|---|---|---|
| turn rollback | COW state records (persistent state only) | engine snapshot per commit (whole heap) |
| commit point | ocapn dispatch wrapper + microtask drain | metered crank boundary |
| output commit | heap buffers outbound sends | supervisor embargo |
| durable state | portraits | portraits (snapshots ephemeral) |
| metering | none | computron quotas per turn |

Both profiles share the portrait store, the persistence env, and the
class API; a heap can move between them by restoring from portraits.

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
| [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md) (In Progress) | supplies the engine snapshot/restore machinery the XS profile (§3.10, Phase 6) builds on |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) (**Complete**) | its crank pump defines the XS profile's commit boundary; its fault model assumes respawn-from-last-snapshot |
| [daemon-endor-architecture](daemon-endor-architecture.md) (Active) | worker lifecycle, envelope bus, and CAS the XS profile plugs into |

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
3. **Phase 3 — deltas, commit points, and COW rollback.**
   Dirty tracking via write-through state records, `saveDelta`,
   delivery-turn flush hook around ocapn dispatch honoring the P1/P2
   invariants (synchronous capture, atomic writes, persist before
   releasing buffered outbound sends), copy-on-write turn rollback of
   persistent state records (restore stashes on throw), `takeSnapshot`
   compaction with mark-sweep orphan removal.
4. **Phase 4 — upgrade ergonomics and SQLite store.**
   `migrations`-style helper, state-shape `mustMatch` at the store
   boundary, SQLite store on the daemon's dual-driver pattern.
5. **Phase 5 — stretch.**
   Sleepy instances with LRU bedtime, multi-heap `'far'` designators
   with a persistence-registry rendezvous, durable gift table,
   generational time-travel tooling over the memory store.
6. **Phase 6 — XS transactional-heap profile (§3.10).**
   Run a portrait heap inside an endor XS worker: snapshot after each
   successful crank, supervisor outbound-message embargo, respawn
   from last commit snapshot on fault or meter exhaustion, gc-exports
   reconciliation for aborted turns, OCapN delivery plumbing into the
   worker.
   Gated on the remaining
   [daemon-xs-worker-snapshot](daemon-xs-worker-snapshot.md) work
   (platform-aware resume, integration test, worker-bundle
   generator).

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
   throw), documented, with two designed paths back — copy-on-write
   state records in Phase 3 and the XS engine-snapshot profile in
   Phase 6 — rather than a transactional heap rewrite of exo.
   §3.9's P1 (synchronous capture, atomic writes, boundary-only
   flush) and P2 (persist-before-release output commit) are
   non-negotiable invariants in every profile; P2 is deliberately
   stronger than Goblins, which dispatches far messages before
   persisting.
8. **JSON store format in v1; Goblins store-file compat is a
   non-goal.**
   Interop is at the OCapN wire, where it already works
   (goblin-chat).
9. **Package name.**
   `@endo/portrait` names the mechanism.
   Alternatives considered: `@endo/aurie` (homage, but confusingly
   claims Goblins' internal codename for a non-identical system) and
   `@endo/persist` (generic).
10. **Engine snapshots are the transactormap, never the store.**
    XS heap snapshots taken at every crank commit give Goblins-grade
    turn rollback with zero determinism/replay requirements on guest
    code (the failed turn is restored over, never re-executed) — the
    key divergence from SwingSet, whose sparse snapshots force
    transcript replay and the liveslots discipline.
    But snapshots are pinned to engine version, architecture, and
    build signature, so they are ephemeral rollback artifacts and
    warm-boot caches only; portraits remain the sole durable,
    upgradeable representation, and engine upgrade = discard
    snapshot, rehydrate from portraits.
11. **Rollback strength is an execution-profile choice, not an API
    choice.**
    Node profile: COW state records (portable, persistent state
    only).
    XS/endor profile: whole-heap snapshot per commit plus supervisor
    output embargo and per-turn computron metering.
    Both share the portrait store, env, and class API, so a heap can
    migrate between profiles through the durable format.

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
- [ ] XS profile: outbound-embargo protocol details (where buffered
  messages live, interaction with promise pipelining and answers to
  the faulted delivery).
- [ ] XS profile: supervisor-emitted `op:gc-exports` for imports
  received during an aborted turn (leak, not unsoundness, if
  skipped).
- [ ] XS profile: snapshot cadence policy for heaps too large for
  per-crank writes (fall back to COW records? snapshot every N
  cranks *without* replay by accepting N-turn rollback windows?).
- [ ] Async-method dirty-across-await detection in debug mode
  (§3.9).

## Prompt

> research how Spritely Goblins does persistence and plan an
> implementation on top of our endo ocapn implementation
> https://codeberg.org/spritely/goblins/src/branch/main/goblins

Revised same day (§3.9, §3.10, Phase 6, Decisions 10–11) per
follow-ups:

> can this be sound without the transactional heap?

> investigate using moddablesdk xs / agoric xsnap for thr
> transactional heap
