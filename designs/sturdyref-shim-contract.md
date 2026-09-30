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
(`fromLocation`/`toLocation`). The maintainer's layering directive on
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

The directive fixes the shape, and this document does not reopen it:

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

- **`new SturdyRef(handler)`** requires `handler` to be an object whose
  `enliven` property is a function, and throws `TypeError` otherwise. It reads
  `handler.enliven` once, at construction (*provisional*, Open question 3).
  It returns a fresh object that is frozen and has no own properties. The
  object inherits from a hardened `SturdyRef.prototype`, which carries only
  `constructor` and `Symbol.toStringTag: 'SturdyRef'` (*provisional*, Open
  question 5). The handler is kept in a closely held
  `WeakMap<SturdyRef, handler>` inside the realm's single `SturdyRef`
  constructor. It is never reachable from the ref. Calling `SturdyRef` without
  `new` throws, as it does for `Proxy`.
- **`SturdyRef.enliven(ref)`** returns a promise. In a later turn
  (*provisional*, Open question 1) it invokes the captured hook as
  `enliven.call(handler, ref)` (*provisional*, Open question 2) and resolves
  with the result. If the hook throws, the promise rejects. A non-SturdyRef
  argument also produces a rejected promise; it does not throw synchronously.
  This is the "send" in the directive: eventual-send semantics, without
  depending on `@endo/eventual-send`. The asymmetry with the constructor is
  deliberate. `enliven` is a send, and a send reports every failure the same
  way, through its promise, so a caller handles a mistyped argument and a
  revoked ref on one path. The constructor is not a send and fails
  synchronously, like `new Proxy`. Each call dispatches afresh: the shim
  caches nothing, so a ref can be enlivened any number of times, and each
  call runs the hook again.
- **`SturdyRef.isSturdyRef(value)`** checks whether `value` is in the
  constructor's `WeakMap`. It reveals no captured content. Layer 3
  (pass-style) needs exactly this to recognize refs. It does not use
  `instanceof`: a prototype chain can be forged with `Object.create`, and an
  object that inherits from `SturdyRef.prototype` is not thereby a ref. A
  later simplification must not collapse the brand check into `instanceof`.

The ref is **opaque**: `Reflect.ownKeys(ref)` is empty, and nothing on the ref
or its prototype reaches the handler. Refs have **no identification**: two
refs built from the same handler are distinct and not equal. Each ref has its
own object identity, as any object does, but the shim offers no equality
based on what the ref refers to. Any notion of "same referent" belongs to the
handler, which can close over whatever it likes (a locator, a swiss number, a
formula id).

**Name overlap with `@endo/ocapn`.** Until layer 5, `@endo/ocapn` keeps its own
free functions `isSturdyRef(value)` and `enlivenSturdyRef(sturdyRef, ...)`,
which operate on the `ocapn-sturdyref` tagged record, not on a `SturdyRef`
instance. The overlap is accepted for that window: the shim's functions are
always spelled as statics (`SturdyRef.isSturdyRef`, `SturdyRef.enliven`), and
the OCapN functions are always imported by name. Layer 5 retires the OCapN
record and its functions.

### Packaging (kept from #774)

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
  minted by one twin is recognized and enlivened by another.
- `provideSturdyRef` installs lazily, and hardening is applied by
  `@endo/harden` after lockdown. Nothing is installed at import time.
- **The `@endo/pass-style` dependency is dropped.** #774 minted each token
  with `Far('SturdyRef', {})`. That makes layer 1 depend on layer 3 and
  classifies refs as remotables, which is a claim layer 3 must make, not
  layer 1. At layer 1, `passStyleOf(ref)` rejects a SturdyRef, the same way it
  rejects any other frozen, non-passable object.

### Child compartments (reconciling #774's "withheld" property with layer 2)

#774 withheld the global from child compartments deliberately. The global
there was an **amplifier**: `toLocation` turned any token into its locator, so
propagating it would have leaked authority. The handler construction removes
that reason. The global confers no authority. `new SturdyRef` only builds refs
around handlers the caller already has (the same as `new Proxy`).
`isSturdyRef` is a brand check. `enliven` only runs the hook of a ref the
caller already holds, and holding a sturdy ref is exactly the authority to
revive it.

**Stance:** the shim takes no position of its own on propagation. It installs
on `globalThis`, and SES decides what child compartments see. Before layer 2,
SES has no permit for `SturdyRef`, and the lazy post-lockdown install is never
present at `repairIntrinsics`. A new `Compartment` builds its global object
from the intrinsics that `repairIntrinsics` captured and permitted, not from
the start compartment's `globalThis`, so a global added later is absent from
child compartments. That is an
observed default, not a security property. Layer 2 adds the permit and the
pre-`repairIntrinsics` install ordering, following `HandledPromise` in
[`packages/ses/src/permits.js`](../packages/ses/src/permits.js), and
propagates the global.

**Test change:** #774's `withheld: a child compartment does not see the
SturdyRef global` is renamed and rescoped to `default: installed after
lockdown without a SES permit, a child compartment does not see SturdyRef`. Its
comment no longer claims confinement. Layer 2 owns the flip, which adds
`present at repairIntrinsics → propagated`. The source comment "withheld from
confined guests by construction" in #774's `sturdyref-shim.js` is removed.

### #774 test disposition

| #774 test | Layer 1 |
|---|---|
| installed after lockdown: hardened and functioning | kept; now covers the constructor and statics |
| locators are objects, not strings | dropped (there is no locator); replaced by *capture is handler-defined* |
| no location: passStyleOf-opaque, leaks no locator | rewritten: frozen, no own keys, handler unreachable; `passStyleOf` rejects |
| no identification: same locator mints distinct refs | kept, keyed on the same handler |
| withheld from child compartments | rescoped (see above) |
| first-wins: selections converge on one mapping | kept: a twin's ref passes `isSturdyRef` and `enliven` in the other twin |
| malformed pre-existing global is rejected | kept, with the new shape check |
| *(new)* | enliven dispatches to the hook in a later turn; enlivening one ref twice runs the hook twice and yields both results (no cached settlement); hook throw → rejection; non-ref → rejection; handler without `enliven` throws at construction; call without `new` throws; an object created with `Object.create(SturdyRef.prototype)` fails `isSturdyRef` |

### Disposition of the withdrawn HandledPromise-enliven vision

Before the #695 layering directive, a garden design job,
`endo-sturdyref-enliven-design`, set out to add sturdy refs to Endo by
modeling them as HandledPromises that an `enliven` trap could revive. The
job was withdrawn when the directive replaced it. Its parts are disposed of
here so that none of them is lost or silently revived:

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

### Ownership map

| Boundary | Mechanism | Policy / durable state | Value crossing |
|---|---|---|---|
| shim ↔ handler author | shim: construct, brand, dispatch | handler: what is captured, how it is revived, revocation | the ref (object identity only, no content); the hook's result |
| shim ↔ SES (layer 2) | shim: install on `globalThis` | SES: permit, harden, propagate | the `SturdyRef` constructor |
| shim ↔ pass-style (layer 3) | shim: `isSturdyRef` | pass-style: classification | a boolean |

The shim owns no durable state and no restart or replay. It only evaluates
and dispatches. Commit and persistence belong to CapTP and the daemon
(layers 5–8).

### Forward sketch (layers 3–5, no implementation)

Layer 3 (pass-style) recognizes a SturdyRef using `SturdyRef.isSturdyRef`
alone and admits it as its own passable category, analogous to a presence.
Like a remotable, it has object identity and no data. Marshal (layer 4) represents
it as a slot of a distinct kind: `convertValToSlot` receives the ref, and the
marshal encodings (capdata, smallcaps, CBOR) gain a sturdyref marker that sits
alongside remotable and promise slots. The shim is not needed for either
step. A CapTP (layer 5) mints refs as `new SturdyRef(handler)`, where the
handler closes over the CapTP's own data (peer id, swiss number, connection
hints). The hook it installs revives the ref through its bootstrap / nonce
locator (layers 6–7). This subsumes `@endo/ocapn`'s `ocapn-sturdyref` tagged
record.

Serialization is the one place this sketch reaches past the handler
contract. To serialize a ref, the CapTP looks it up in its own side table, a
`WeakMap` from ref to data, because the shim deliberately gives no way to
read a ref's content back out of its handler. The data therefore lives twice:
in the handler's closure, to revive the ref, and in the minting CapTP's side
table, to serialize it. Only the CapTP that minted a ref can serialize it.
Construct, brand, and dispatch are enough for layers 3 and 4, and for a CapTP
that carries only its own refs. Whether they are enough for layer 5 as a
whole depends on Open question 7.

## Open questions

1. Should the hook run in a later turn (proposed, to match eventual send), or
   synchronously inside `SturdyRef.enliven` with its result wrapped in a
   promise?
2. Should the hook receive the ref as its argument (proposed, so one handler
   can serve many refs), or no argument, the way a per-ref closure would?
3. Should `enliven` be read once at construction (proposed; stable, and
   immune to later handler mutation), or on every call, as `Proxy` looks up
   its traps?
4. Should the constructor harden the handler it captures, or leave that to
   the handler's author?
5. Should instances inherit from `SturdyRef.prototype` (proposed; gives a
   readable `toStringTag`) or have a `null` prototype?
6. Should `E.enliven` land as sugar in `@endo/eventual-send`, and if so, at
   which layer?
7. If a ref minted by CapTP A is passed to CapTP B, may B carry it? Layer 5
   has to answer this; it is flagged here because it decides whether the
   handler needs any affordance beyond `enliven`, such as a hook that yields
   serializable data in place of the minting CapTP's side table.

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
