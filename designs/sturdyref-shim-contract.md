# The `SturdyRef` Shim Contract (Layer 1)

| | |
|---|---|
| **Created** | 2026-09-30 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Endo has no shared, realm-wide notion of a *sturdy reference*: an offline
reference that can be revived into a live one later. Each layer has invented
its own. `@endo/ocapn` ships a `WeakMap`-backed `ocapn-sturdyref` tagged record
([`packages/ocapn/src/client/sturdyrefs.js`](../packages/ocapn/src/client/sturdyrefs.js)). Draft PR
[#774](https://github.com/endojs/endo-but-for-bots/pull/774) proposes a global
`SturdyRef` namespace that maps opaque tokens to locator records
(`fromLocation`/`toLocation`); its global was deliberately withheld from child
compartments. The maintainer's layering directive on
[#695](https://github.com/endojs/endo-but-for-bots/pull/695#issuecomment-5903472512)
(2026-09-30) replaces both with a nine-layer, bottom-up stack. This document
specifies layer 1, the shim that every higher layer builds on. The tracking
issue for the arc is
[kriscendobot/garden#47](https://github.com/kriscendobot/garden/issues/47).

The stack, bottom-up:

1. The `SturdyRef` shim contract (this document; the build reworks #774).
2. SES: permit `SturdyRef` and propagate it to child compartments.
3. Pass-style: SturdyRefs become passable, analogous to presences.
4. Marshal: a representation of SturdyRefs in each encoding.
5. CapTP: mint SturdyRefs and carry them over the wire.
6. CapTP: construct a SturdyRef from data (peer id, object id, designator,
   hints).
7. OCapN: enliven through the bootstrap / nonce locator.
8. Daemon: a SturdyRef for a formula, without incarnating it.
9. Agent API: revisit #695 and #871.

The directive borrows the shape of the `HandledPromise` shim from
`@endo/eventual-send`. That shim installs a `HandledPromise` constructor on
`globalThis` once per realm, and each `HandledPromise` is built with a
*handler*, an object whose methods (traps) define what happens when the
promise is sent a message. `Proxy` uses the same pattern: the object has no
behavior of its own, and the handler supplies it. The directive fixes the
shape, and this document does not reopen it:

- A global `SturdyRef` shim, analogous to the `HandledPromise` shim: each copy
  races to define `SturdyRef` globally, and the first definer wins.
- A `SturdyRef` is **constructed** the way a `Proxy` or `HandledPromise` is,
  with a **handler** whose `enliven` hook defines both what the ref captures
  and how it is revived. What a SturdyRef captures is defined **entirely** by
  that handler.
- `SturdyRef.enliven(ref)` sends an `enliven` message to the ref, which
  dispatches to its handler's hook. A higher layer, such as a CapTP, uses this
  hook to define the enlivening procedure from the ref's content.

## Design

### Surface

Items marked *provisional* are the proposed answers to the matching entries in
[Open questions](#open-questions). They are the defaults a layer-1 build
implements unless the maintainer decides otherwise, and no higher layer may
depend on them until they are settled.

```js
const ref = new SturdyRef(handler); // handler: { enliven(ref) => value | Promise }
SturdyRef.enliven(ref);             // => Promise<live reference>
SturdyRef.isSturdyRef(value);       // => boolean, a brand check that confers no authority
```

A handler author's view, end to end:

```js
const locator = 'ocapn://peer.example/s/abc123';
const handler = {
  enliven(_ref) {
    return connectAndFetch(locator); // any value or promise
  },
};
const ref = new SturdyRef(handler);
SturdyRef.isSturdyRef(ref); // true
Reflect.ownKeys(ref);        // [] (the locator is not reachable from the ref)
const live = await SturdyRef.enliven(ref); // the value connectAndFetch resolved to
```

- **`new SturdyRef(handler)`** requires `handler` to be an object whose
  `enliven` property is a function, and throws `TypeError` otherwise. It reads
  `handler.enliven` once, at construction (*provisional*, Open question 3:
  read once or on every call). That protects only the dispatch target. The
  constructor does not harden or freeze the handler (*provisional*, Open
  question 4: harden the handler or not), so state the hook reads through
  `this` or its closure stays mutable and is the handler author's to protect.
  A handler that keeps mutable state on `this` works; a handler that needs
  stability hardens itself. It returns a fresh object that is frozen and has no own properties. The
  object inherits from a hardened `SturdyRef.prototype`, which carries only
  `constructor` and `Symbol.toStringTag: 'SturdyRef'` (*provisional*, Open
  question 5: prototype or `null` prototype). The handler is kept in a closely held
  `WeakMap<SturdyRef, handler>` inside the realm's single `SturdyRef`
  constructor. It is never reachable from the ref. Calling `SturdyRef` without
  `new` throws, as it does for `Proxy`.
- **`SturdyRef.enliven(ref)`** returns a promise.
  - Timing: the hook runs in a later turn (*provisional*, Open question 1:
    later turn or synchronous).
  - Call form: the shim invokes the captured hook as
    `enliven.call(handler, ref)` (*provisional*, Open question 2: pass the ref
    or not) and resolves the promise with the result. Because this is an
    ordinary promise resolution, a hook that returns a thenable has it
    assimilated.
  - Failure: if the hook throws, the promise rejects with that error. A
    non-SturdyRef argument rejects the promise with a `TypeError` whose
    message begins `SturdyRef.enliven: not a SturdyRef`; it does not throw
    synchronously. An un-awaited `SturdyRef.enliven(undefined)` therefore
    surfaces only as an unhandled rejection.
  - Why the asymmetry with the constructor: `enliven` is the "send" in the
    directive, eventual-send semantics without depending on
    `@endo/eventual-send`. A send reports every failure through its promise,
    so a caller handles a mistyped argument and a revoked ref on one path. The
    constructor is not a send and fails synchronously, like `new Proxy`.
  - No caching: each call dispatches afresh, so a ref can be enlivened any
    number of times, and each call runs the hook again. The handler owns
    idempotence and identity. If two concurrent enlivens must not both open a
    connection, or must yield the same presence, the handler memoizes; the
    shim does not.
- **`SturdyRef.isSturdyRef(value)`** checks whether `value` is in the
  constructor's `WeakMap`. It reveals no captured content. Layer 3
  (pass-style) needs exactly this to recognize refs. It does not use
  `instanceof`: a prototype chain can be forged with `Object.create`, and an
  object that inherits from `SturdyRef.prototype` is not thereby a ref. A
  later simplification must not collapse the brand check into `instanceof`.
  The brand check proves only that *some* caller built the ref with this
  realm's constructor. It says nothing about who minted it or whether its
  handler is trustworthy; see [Provenance](#provenance).

The ref is **opaque**: `Reflect.ownKeys(ref)` is empty, and nothing on the ref
or its prototype reaches the handler. Refs have **no identification**: two
refs built from the same handler are distinct and not equal. Each ref has its
own object identity, as any object does, but the shim offers no equality
based on what the ref refers to. Any notion of "same referent" belongs to the
handler, which can close over whatever it likes (a locator, a swiss number,
which is the unguessable secret that names an object at an OCapN peer, or a
formula id).

**Name overlap with `@endo/ocapn`.** Until layer 5, `@endo/ocapn` keeps its own
free functions `isSturdyRef(value)` and `enlivenSturdyRef(sturdyRef, ...)`,
which operate on the `ocapn-sturdyref` tagged record, not on a `SturdyRef`
instance. The overlap is accepted for that window: the shim's functions are
always spelled as statics (`SturdyRef.isSturdyRef`, `SturdyRef.enliven`), and
the OCapN functions are always imported by name. Layer 5 retires the OCapN
record and its functions. Because a wrong import silently returns `false`
rather than throwing, the layer-1 build also records this overlap as a known
trap in the `@endo/sturdyref` README, not only here.

### Packaging (Kept from #774)

The package stays `@endo/sturdyref`, with `index.js` as the ponyfill (a
module that exports the implementation without touching `globalThis`) and
`shim.js` as the entry that installs it on `globalThis`. It keeps #774's
first-wins mechanics:

- `selectSturdyRef` adopts an existing `globalThis.SturdyRef` if it is valid.
  Here that means a function with `enliven` and `isSturdyRef` statics. If the
  existing global lacks either static, it throws. If there is no global, it
  installs this copy's constructor with `writable: false`,
  `configurable: false`, `enumerable: false`. Eval twins (two copies of the
  package loaded in one realm, for example from two versions in
  `node_modules`) therefore share one constructor and one `WeakMap`, so a ref
  minted by one twin is recognized and enlivened by another. The shape check
  cannot detect semantic drift between twins: the first definer's behavior
  (timing, call form, hook read time) governs every copy. Layer 1 accepts
  that, because the provisional answers are settled before `@endo/sturdyref`
  is first published, so every released copy implements one contract. A later
  change to those semantics must add a contract marker (for example a
  `SturdyRef.contract` version static) to the shape check rather than rely on
  first-wins.
- `provideSturdyRef` installs lazily; nothing is installed at import time
  except through the eager `shim.js` entry.
- Installation may happen before or after `lockdown`, as for the
  `HandledPromise` shim. Importing the shim before `lockdown` is the ordering
  layer 2 needs, because SES must see `SturdyRef` at `repairIntrinsics` time
  to share it with child compartments.
- The shim wants its constructor, prototype, and statics tamper-proof as soon
  as they are installed, because every ref in the realm trusts them, and
  after `lockdown` that means `harden`. Before `lockdown`, though, the shim
  must not call `@endo/harden`: that installs `Object[@harden]`, and
  `lockdown` then throws "Cannot lockdown (repairIntrinsics) if a prior harden
  implementation has been used and installed".
- So the shim hardens with `@endo/harden` only when a harden is already
  present (`globalThis.harden` or `Object[Symbol.for('harden')]`). Otherwise
  it freezes the constructor, its prototype, and its statics, and leaves
  hardening to `lockdown`. Refs are frozen at construction either way.
- **The `@endo/pass-style` dependency is dropped.** #774 minted each token
  with `Far('SturdyRef', {})`. That makes layer 1 depend on layer 3 and
  classifies refs as remotables, which is a claim layer 3 must make, not
  layer 1. At layer 1, `passStyleOf(ref)` rejects a SturdyRef, the same way it
  rejects any other frozen, non-passable object.

### Child Compartments (Reconciling #774's "Withheld" Property with Layer 2)

#774 withheld the global from child compartments deliberately. The global
there was an **amplifier**: `toLocation` turned any token into its locator, so
propagating it would have leaked authority. The handler construction removes
that reason. The global confers no authority. `new SturdyRef` only builds refs
around handlers the caller already has (the same as `new Proxy`).
`isSturdyRef` is a brand check. `enliven` only runs the hook of a ref the
caller already holds, and holding a sturdy ref is exactly the authority to
revive it. That argument covers what the global lets a holder *do*. It does
not cover what a recipient may *believe* about a ref it is handed, which is
the next section.

### Provenance

Dropping the withholding moves a risk rather than removing it. Once layer 2
propagates `SturdyRef`, a guest can call `new SturdyRef(evilHandler)`, and the
result passes `SturdyRef.isSturdyRef`. If a host or a CapTP enlivened such a
ref, the guest's hook would run in the host's turn with the host's ref as its
argument. The brand check cannot prevent that: it proves "built by this
realm's constructor", never "built by a party I trust".

Minter provenance is therefore not a layer-1 property, and layer 1 does not
claim it. It belongs to the layer that accepts refs across a trust boundary.
Layer 5 owns it for CapTP: a CapTP serializes or enlivens on a peer's behalf
only refs it finds in its own side table (see
[Forward sketch](#forward-sketch-layers-35-no-implementation)), which is a
provenance check, not a brand check. Layer 8 owns it for the daemon. Until
those layers exist, the rule for callers is plain: enlivening a ref runs its
minter's code, so enliven only refs from a source you would let run code in
your turn, exactly as with calling a function you were handed.

**Stance:** the shim takes no position of its own on propagation. It installs
on `globalThis`, and SES decides what child compartments see. Before layer 2,
SES has no permit for `SturdyRef`, so even a pre-lockdown install is not
admitted as an intrinsic, and a post-lockdown install is never present at
`repairIntrinsics`.

What a child compartment sees today is read from source, not yet from a run:
`setGlobalObjectMutableProperties` in
[`packages/ses/src/global-object.js`](../packages/ses/src/global-object.js)
populates a new compartment's global only from the `universalPropertyNames`
table in [`packages/ses/src/permits.js`](../packages/ses/src/permits.js),
looked up in the permitted intrinsics, never by copying the start
compartment's `globalThis`. So a `SturdyRef` with no entry in that table
should be absent from child compartments however it was installed. This is
believed, to be confirmed by the layer-1 build's test, and it is a default,
not a security property. Layer 2 adds the permit and the
pre-`repairIntrinsics` install ordering, following `HandledPromise`, and
propagates the global.

**Test change:** #774's `withheld: a child compartment does not see the
SturdyRef global` becomes a temporary characterization test, named
`characterization (flips in layer 2): without a SES permit, a child
compartment does not see SturdyRef`. Its comment says it pins today's
default, not a guarantee, and that layer 2 replaces it with
`present at repairIntrinsics → propagated`. The source comment "withheld from
confined guests by construction" in #774's `sturdyref-shim.js` is removed.

### #774 Test Disposition

| #774 test | Layer 1 |
|---|---|
| installed after lockdown: hardened and functioning | kept; now covers the constructor and statics |
| locators are objects, not strings | dropped (there is no locator); replaced by *capture is handler-defined* |
| no location: passStyleOf-opaque, leaks no locator | rewritten: frozen, no own keys, handler unreachable; `passStyleOf` rejects |
| no identification: same locator mints distinct refs | kept, keyed on the same handler |
| withheld from child compartments | becomes a characterization test that layer 2 flips (see above) |
| first-wins: selections converge on one mapping | kept: a twin's ref passes `isSturdyRef` and `enliven` in the other twin |
| malformed pre-existing global is rejected | kept, with the new shape check |
| *(new)* | installed before lockdown: `lockdown()` does not throw (no prior harden installed); afterward `globalThis.SturdyRef` is still the installed constructor, and it and its prototype are frozen. (SES leaves an unpermitted start-compartment global in place and does not reject it; checking against a SES permit waits for layer 2, which adds one.) |
| *(new)* | enliven dispatches to the hook in a later turn; enlivening one ref twice runs the hook twice and yields both results (no cached settlement); hook throw → rejection; non-ref → `TypeError` rejection; handler without `enliven` throws at construction; call without `new` throws; an object created with `Object.create(SturdyRef.prototype)` fails `isSturdyRef` |

### Disposition of the Withdrawn HandledPromise-Enliven Vision

Before the #695 layering directive, a garden design job,
`endo-sturdyref-enliven-design`, set out to add sturdy refs to Endo by
modeling them as HandledPromises that an `enliven` trap could revive. The
job was withdrawn when the directive replaced it. Its parts are disposed of
here so that none of them is lost or silently reintroduced:

- **Sturdyref-as-HandledPromise: rejected.** A promise settles once and is
  thenable. A sturdy ref can be revived any number of times, and it must not
  be assimilated by `await` or by `Promise.resolve`. Pass-style would also
  classify such a ref as a promise. The directive makes `SturdyRef` a distinct
  global.
- **An `enliven` meta-trap: absorbed.** The trap moves off the HandledPromise
  handler and becomes the SturdyRef handler's `enliven` hook.
- **`HandledPromise.enliven`: rejected.** `SturdyRef.enliven` is the
  call-through, and HandledPromise is not involved. **`E.enliven`: deferred.**
  `@endo/eventual-send` could later add a sugar alias for `SturdyRef.enliven`
  (see Open questions).
- **The `Promise.delegate` / `Promise[Symbol.for('enliven')]` stopgap:
  deferred and orthogonal.** `SturdyRef` does not depend on the native-promise
  trajectory. If it is standardized, it would be its own proposal.
- The vision's side questions go to the layers that own them. Revocation
  belongs to the handler, which can reject. The identity of an enlivened
  presence belongs to the handler or CapTP, which can memoize. Persistence
  belongs to layers 5–8.

### Ownership Map

| Boundary | Mechanism | Policy / durable state | Value crossing |
|---|---|---|---|
| shim ↔ handler author | shim: construct, brand, dispatch | handler: what is captured, how it is revived, revocation, memoization, its own mutability | the ref (object identity only, no content); the hook's result |
| shim ↔ SES (layer 2) | shim: install on `globalThis`; freeze, or harden if a harden is already present | SES: permit, harden at `lockdown`, propagate | the `SturdyRef` constructor |
| shim ↔ pass-style (layer 3) | shim: `isSturdyRef` | pass-style: classification | a boolean |
| shim ↔ CapTP / daemon (layers 5, 8) | shim: brand only | CapTP / daemon: minter provenance | the ref |

The shim owns no durable state and no restart or replay. It only evaluates
and dispatches. Commit and persistence belong to CapTP and the daemon
(layers 5–8).

### Forward Sketch (Layers 3–5, No Implementation)

Layer 3 (pass-style) recognizes a SturdyRef using `SturdyRef.isSturdyRef`
alone and admits it as its own passable category, analogous to a presence.
Like a remotable, it has object identity and no data. Marshal (layer 4) represents
it as a slot of a distinct kind: `convertValToSlot` receives the ref, and the
marshal encodings (capdata, smallcaps, CBOR) gain a sturdyref marker that sits
alongside remotable and promise slots. The shim is not needed for either
step.

A CapTP (layer 5) keeps one table, a `WeakMap` from ref to data (peer id,
swiss number, connection hints), and one shared handler for all the refs it
mints. It mints with `new SturdyRef(sharedHandler)` and records the ref's data
in the table. The shared handler's hook receives the ref (Open question 2's
proposed answer is what makes one handler serve many refs), looks up its data
in the table, and revives it through the bootstrap / nonce locator (layers
6–7). Serialization reads the same table. The data therefore lives once, as
data, and the handler is a function over it. This subsumes `@endo/ocapn`'s
`ocapn-sturdyref` tagged record. Finding a ref in the table is also the
CapTP's provenance check (see [Provenance](#provenance)).

Only the minting CapTP holds the table, so only it can serialize the ref.
Construct, brand, and dispatch are enough for layers 3 and 4, and for a CapTP
that carries only its own refs. A ref minted by CapTP A and handed to CapTP B
(Open question 7) reduces to whether B may consult A's table, which is a
question between two CapTPs, not a question about the shim's contract. If
layer 5 instead wants a handler hook that yields serializable data, that hook
is optional and additive: refs whose handlers lack it keep working, and the
shim continues to dispatch only `enliven`. Either answer therefore fits the
layer-1 surface, and layer 1 can freeze without waiting for Open question 7.

## Open Questions

1. Should the hook run in a later turn (proposed, to match eventual send), or
   synchronously inside `SturdyRef.enliven` with its result wrapped in a
   promise?
2. Should the hook receive the ref as its argument (proposed, so one handler
   can serve many refs, as the layer-5 sketch relies on), or no argument, the
   way a per-ref closure would?
3. Should `enliven` be read once at construction (proposed; the dispatch
   target is immune to a later swap of `handler.enliven`), or on every call,
   as `Proxy` looks up its traps? Decide together with question 4: reading
   once does not protect the rest of the handler, which the hook still reads
   through `this`.
4. Should the constructor harden the handler it captures (proposed: no, and
   document it)? Hardening would make the whole handler stable, but it would
   make a handler that keeps mutable state on `this` fail at first use, far
   from the cause. The proposal leaves the handler's mutability to its author,
   as the Surface section states.
5. Should instances inherit from `SturdyRef.prototype` (proposed; gives a
   readable `toStringTag`) or have a `null` prototype?
6. Should `E.enliven` land as sugar in `@endo/eventual-send`, and if so, at
   which layer?
7. If a ref minted by CapTP A is passed to CapTP B, may B carry it? Layer 5
   answers this. It does not block layer 1: as the forward sketch shows, the
   answer is either a table-sharing arrangement between CapTPs or an optional,
   additive handler hook, and both fit the layer-1 surface.

## Prompt

> Layer 1 (design) — the SturdyRef shim contract. A global `SturdyRef` shim
> analogous to the HandledPromise shim: each copy races to define `SturdyRef`
> globally; first definer wins. A SturdyRef is constructed after the fashion
> of a Proxy/HandledPromise, with a handler whose `enliven` hook defines both
> what the ref captures and the procedure for reviving it.
> `SturdyRef.enliven(ref)` sends an `enliven` message to the sturdyref. The
> design must reconcile #774, the withdrawn HandledPromise-enliven vision,
> #774's "withheld from child compartments" property versus layer 2, and
> sketch layers 3–5. (kriskowal, #695, 2026-09-30, via orchestration
> `ebfb-sturdyref-layering-20260930`.)
