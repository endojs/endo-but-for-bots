# SturdyRefs in `@endo/pass-style`, Enlivened On Demand by OCapN

| | |
|---|---|
| **Created** | 2026-06-23 |
| **Updated** | 2026-06-26 |
| **Author** | endolinbot (prompted) |
| **Status** | Not Started |

## Direction (maintainer decision 2026-06-26)

We pursue SturdyRefs as **inert, pass-by-copy data** that are **enlivened on
demand** by the **closely-held OCapN network capability** (`enlivenSturdyRef`).
A SturdyRef carries only the off-band `(location, secret)` needed to re-acquire
the live capability; the bearer enlivens it to a presence and then sends to the
presence.

We **explicitly do not** pursue, at this time:

- `FinalizationRegistry`-based release of SturdyRefs or presences (in any role —
  neither as a retention mechanism nor as a leak detector),
- daemon-side ephemeral retention tables for worker-held references,
- a `retain` / `release` `endor` worker-syscall pair,
- proactive per-turn `deleteExport` retention determinism, or
- any worker-local SturdyRef retention machinery.

Nothing is "retained" by workers on the daemon's behalf and nothing is observed
by GC; a SturdyRef is simply data that the closely-held OCapN capability can turn
back into a live capability when asked.
The earlier paired-design framing (a `FinalizationRegistry` plan and an
`endor`-syscall retention plan competing to solve a retention dilemma) is
withdrawn; there is no competition and no retention dilemma to resolve here.

## Summary

This design lands SturdyRef support in `@endo/pass-style` and threads SturdyRefs
through the daemon's pet-name-path surface.
A SturdyRef is an **inert, opaque, pass-by-copy data box** that carries the
parsed OCapN locator and, off-band, the swiss number needed to re-acquire the
live capability it names.
It is **not** a presence and is **not** registered with `HandledPromise`.
To act on the capability a SturdyRef names, the bearer **enlivens** it to an
ordinary CapTP presence via the closely-held OCapN-provided capability, and then
sends to the presence with the existing, unchanged eventual-send path.

The work has three legs that are solved together:

1. **`@endo/pass-style` learns about SturdyRefs** as a first-class pass-style
   category.
2. **CapTP and OCapN box and unbox SturdyRefs** at the marshaling layer.
3. **Any daemon agent method that accepts a pet-name-path also accepts a
   SturdyRef**, so a confined guest or subagent that should never see a locator
   can still refer to a formula without a pet name.

There is no retention machinery in this design.
A SturdyRef is data; enlivenment happens on demand against the closely-held
capability; nothing in pass-style or the worker boundary observes, retains, or
releases references on a worker's behalf.

## What is the Problem Being Solved?

The maintainer's directive on PR #500 comment `4775973308` describes three needs
that have to be solved together:

1. **`@endo/pass-style` learns about SturdyRefs.**
   A SturdyRef is an opaque object that corresponds to an OCapN locator
   (`peer + swiss-num`).
   The maintainer's directive first described it as "similar to a presence …
   registered with `HandledPromise`"; PR #521's review corrected that (see
   *A SturdyRef is inert* below): a SturdyRef is an inert data box, not a
   presence, and `@endo/eventual-send` is unchanged.
   The on-wire form is already specified in the OCapN spec (`ocapn-sturdyref`
   tagged record carrying a peer locator and a swiss number); pass-style needs a
   category for it so `passStyleOf` has an answer and so marshaling layers can
   route it.
   Today `@endo/ocapn` shims this by using a `tagged` value with tag
   `'ocapn-sturdyref'` and a side WeakMap (`sturdyRefDetails`), with
   `ocapnPassStyleOf` upgrading the answer from `'tagged'` to `'sturdyref'`.
   That shim is the thing this design promotes to a real pass-style category.

2. **CapTP and OCapN box and unbox SturdyRefs.**
   A SturdyRef is a passable, not a wire-format primitive.
   The marshaling layer is responsible for boxing on send and unboxing on
   receive.
   OCapN exposes (via the bootstrap object) the closely-held capability to
   associate a SturdyRef with its locator (mint) or to reveal the locator for a
   SturdyRef (decompose).
   On other CapTP transports the same role is played by an explicit
   side-channel; the pass-style category is the same.

3. **Any daemon agent method that accepts a pet-name-path also accepts a
   SturdyRef.**
   This is the second-stage payoff.
   A confined guest or subagent that should never see a locator (the long-lived
   authority granting access to the capability) can still refer to a formula by
   holding an opaque SturdyRef.
   No host pet name need be allocated.

The retention question the directive also raised (how the user retains agency to
revoke a formula a worker holds without a name to point at) is answered without a
retention table.
We do not introduce a retention table, a worker syscall, or GC observation.
The daemon revokes a sturdyref by **forgetting** the swiss number it carried, so
it can never again be enlivened, and revokes a live value by partitioning or
terminating the process holding the reference (see *Revocation*).
The pet-name affordance (write the locator under a pet name via `writeLocator`)
remains available for the case where the user chose to name the locator, but it
is not the only revocation root.

## Background

### The OCapN locator (parsed representation)

Per the OCapN spec section *Sturdyref Locator* (held at `kriscendobot/ocapn`
commit `f7005c12`, the snapshot the journal indexes), a sturdyref carries a peer
locator and a swiss number.
The peer locator carries a designator, a transport (also called network), and an
optional hashmap of hints; two peer locators are the same peer if and only if
designator and transport match.
The swiss number is a string identifying the object at that peer.

The package `@endo/ocapn` already shapes the parsed peer locator as the
`OcapnLocation` typedef in `src/codecs/components.js`:

```typescript
type OcapnLocation = {
  type: 'ocapn-peer';
  designator: string;
  transport: string;       // legacy field
  network?: string;        // replaces transport during migration
  hints: false | Record<string, string>;
};
```

This design adopts that shape verbatim and proposes that `@endo/pass-style`
re-exports the locator typedef (or a structurally equivalent narrowing of it) so
non-OCapN marshaling layers do not have to take a runtime dependency on
`@endo/ocapn` just to name the type.
The exported brand `OcapnLocation` (or its renamed equivalent) is treated as a
`copyRecord` at the pass-style layer, deep-frozen, and compared by structural
equality.
The on-wire serialization of the locator is owned by OCapN, not by pass-style;
pass-style only knows the parsed shape.

The swiss number is a string in the spec.
The current `@endo/ocapn` implementation already supports two runtime types for
it (a printable ASCII string or a `Uint8Array` of arbitrary bytes, the second
case present for interop with Spritely Goblins' 24-byte random secrets).
This design narrows the **passable** representation to `string` (per the spec)
and treats the byte-array case as an implementation-internal extension owned by
`@endo/ocapn`'s sturdyref tracker, not part of the pass-style surface.

### What `@endo/pass-style` currently knows

`passStyleOf` returns one of:
`'undefined' | 'null' | 'boolean' | 'number' | 'bigint' | 'string'
| 'byteArray' | 'symbol' | 'copyArray' | 'copyRecord' | 'tagged'
| 'remotable' | 'error' | 'promise'`.
The helper machinery in `passStyle-helpers.js` reads a `PASS_STYLE` symbol off
the value (or a `Symbol.toStringTag` on the tag-record prototype) and dispatches
by a `HelperTable` keyed on the style name.
Adding a new style means adding a new helper that recognises the value, refusing
to pass-style any value that is not a properly constructed SturdyRef, and
slotting into `passStyleOf`'s table.

The closest existing precedent is `'remotable'`: a passable whose runtime
payload (its identity) is what the marshaler turns into a wire slot.
A SturdyRef is similarly identity-bearing but, unlike a presence, it carries a
**resolvable** identity (the locator) rather than a slot established at session
bootstrap.

### A SturdyRef is inert; it is enlivened, not sent to

The maintainer's original framing described a SturdyRef as "an opaque object,
similar to a presence, that must be registered with `HandledPromise`."
The implementation slice (PR #521, the shared base this design builds on)
discovered and the maintainer confirmed a correction:
a SturdyRef is **not** a presence and is **not** registered with
`HandledPromise`.
It is an **inert, opaque, pass-by-copy data box** that carries only the off-band
`(location, secret)` needed to *re-acquire* the live capability.
`E(sturdyRef).foo()` is **not** a valid operation, and `@endo/eventual-send`
needs **no change** for SturdyRefs.

To act on the capability a SturdyRef names, the bearer first **enlivens** it to
an ordinary CapTP presence and then sends to the presence:

```js
const presence = await enlivenSturdyRef(sturdyRef);
const result = await E(presence).method(...args);
```

`enlivenSturdyRef` is the closely-held OCapN-provided capability (described under
*Boxing and unboxing* and *OCapN's closely-held capability* below): it reads the
locator off-band, then for a local locator flows to the daemon's own formula
store and for a remote locator dials the peer via `provideSession(location)` and
`bootstrap.fetch(secret)`.
The enlivened presence is an ordinary presence; from there `E(presence)` is the
existing, unchanged eventual-send path.
The pass-style layer never calls into eventual-send.
Enlivenment does **not** cache: each enlivenment goes through the closely-held
capability afresh, and no enlivenment cache is kept in `@endo/ocapn` or in
`HandledPromise`.

This is the whole lifecycle this design commits to: a SturdyRef is inert data,
and the only way to act on it is on-demand enlivenment through the closely-held
capability.
There is no step in which a worker or the daemon retains the SturdyRef or the
enlivened presence on anyone's behalf.

### How the OCapN codec already boxes SturdyRefs

`@endo/ocapn/src/codecs/ocapn-pass-style.js`:

```js
export const ocapnPassStyleOf = value => {
  if (isSturdyRef(value)) {
    return 'sturdyref';
  }
  // ... handoff cases ...
  return passStyleOf(value);
};
```

`@endo/ocapn/src/client/sturdyrefs.js`:
the tracker mints a SturdyRef via `makeTagged('ocapn-sturdyref', undefined)` and
squirrels `{ location, secret }` away in a `WeakMap`.
The on-wire codec reads `(peer, swiss-num)` and asks the tracker to materialise a
SturdyRef in the receiving world; the secret is **not** a property on the object.
The closely-held bootstrap capability `enlivenSturdyRef` resolves a SturdyRef to
either a local capability (via `locator.get(secret)`) or a remote reference (via
`provideSession(location)` and `getRemoteBootstrap().fetch(secret)`).

This design promotes that shim by:

- Moving the `PASS_STYLE` answer for sturdyrefs from `ocapnPassStyleOf` (an
  OCapN-specific upgrade of the answer) into `passStyleOf` itself.
  This also obviates the `makeTagged('ocapn-sturdyref', ...)` tag entirely: a
  SturdyRef is no longer a tagged value at all.
  It is literally a pass-style object whose `passStyleOf` answer is `'sturdyref'`
  (an instance carrying `[Symbol.for('passStyle')]: 'sturdyref'`), and that
  object has a meaningful identity to the CapTP session manager.
- Replacing the side-`WeakMap` carrier with a real pass-style category that
  names its content: a **locator**.
  `@endo/pass-style` defines the **shape** of that category (its
  recognition and validation), but it does **not** construct sturdyrefs.
  Construction is the role of the CapTP session manager (see *Pass-style defines
  the shape; the CapTP session manager constructs* below).
- Keeping the close-held nature of the secret: even when pass-style knows about
  the category, **the secret is not a property the worker can read**; reveal goes
  through the OCapN-provided capability.

A SturdyRef's pass-style identity is **scoped to one OCapN instance** (or other
CapTP session), not global.
A SturdyRef minted by one OCapN network instance is **not** expected to be
recognised by another, and `enlivenSturdyRef` may **reject** the returned promise
when handed a SturdyRef it cannot resolve in the current instance — that
rejection is **by design**, not an error to prevent.
This is why an **opaque pass-style object suffices** for every sturdy reference:
because recognition is per-instance, the pass-style layer needs no global
coordination of a shared `WeakMap` from SturdyRef objects to locators.
Each instance's enlivener owns its own carrier and resolves only the SturdyRefs
it minted (or that a peer it dialed minted); a SturdyRef that does not resolve
there simply rejects on enliven.

### Daemon: where pet-name-paths land today

The host facets accept pet-name-paths in many places: `lookup`, `identify`,
`locate`, `write`, `remove`, `move`, `makeDirectory`, `makeUnconfined`'s
`petNamePaths` array, `evaluate`'s `codeNames`/`petNamePaths` (`host.js` line 361
onward), and so on.
The canonical entry shape is `(string | string[])` per segment.
`writeLocator` already accepts either a locator string or a raw formula
identifier and internalises it before delegating to `write` (see
`daemon-locator-reference.md` § Writing).
This design proposes the symmetric extension on the **read** side:
any of those methods that today accept a pet-name-path also accept a SturdyRef.

The internal resolution is:
`SturdyRef -> { location, swissNum }` (via the closely-held capability that OCapN
provides to the daemon at construction time)
`-> formulaIdentifier` (via the daemon's existing `internalizeLocator` flow for
local-peer locators, or a remote peer connection for non-local ones).
Crucially, this rewriting happens **at the daemon's outer surface** (the facet
boundary), not inside the worker.
A guest or worker never sees the swiss number.

## Design

### Pass-style integration

#### A new pass-style category, `'sturdyref'`

A new pass-style category, joining `'remotable'` and `'tagged'`.
A SturdyRef is its own pass-style category with an identity meaningful to the
CapTP session manager: it is **not** a tagged value and carries no
`makeTagged('ocapn-sturdyref', ...)` tag.
`@endo/pass-style` defines the **shape** of the category (the recognition and
validation a value must satisfy for `passStyleOf` to answer `'sturdyref'`) and
exposes a validator, but it does **not** construct sturdyrefs.
Construction is the role of the CapTP session manager (see *Pass-style defines
the shape; the CapTP session manager constructs* below).
A constructed SturdyRef satisfies the shape so that `passStyleOf` answers
`'sturdyref'`:

```js
import { passStyleOf } from '@endo/pass-style';
// sessionManager constructs the instance; pass-style only recognises it.
const sturdyRef = sessionManager.makeSturdyRef(location);
passStyleOf(sturdyRef); // 'sturdyref'
```

A SturdyRef value has:

- `[Symbol.for('passStyle')]: 'sturdyref'`, marking it as an instance of its own
  pass-style category whose identity is meaningful to the CapTP session manager.
  It is not a tag-record and not a tagged value.
- `[Symbol.toStringTag]: 'SturdyRef'`.
- A non-enumerable `location` accessor returning the deep-frozen parsed
  `OcapnLocation`.
  (The accessor shape, rather than a data property, lets the helper assert that
  the prototype's own descriptor is the only source of `location`.)
- A non-enumerable, optional `type` accessor: a **flexible hint** string carried
  alongside the locator.
  Per the maintainer's note, this is the formula type (or another hint) that a
  holder of a **remote** SturdyRef can read without enlivening it — for example
  to decide whether to bother dialing the peer, or to render the box in a UI.
  It is advisory only: it never authorises anything (the secret is still
  off-band) and a consumer must tolerate its absence (a SturdyRef minted without
  a hint, or one whose minter chose not to disclose a type, has no `type`).
  The CapTP session manager takes it as an optional second argument when it
  constructs a SturdyRef; the pass-style validator (`assertValid`) checks only
  that, when present, it is a string.
  Because it is purely a hint and not part of the locator's identity, it is
  **excluded from the structural-equality** comparison that decides whether two
  SturdyRefs designate the same object: equality is on `location` (and the
  off-band swiss number), never on `type`.

The secret (swiss number) is **not** a property.
The SturdyRef object on its own is not enough to mint a CapTP reference; the
closely-held capability (next subsection) is.

This shape composes with `makeExo` and pattern-matchers (`M.kind` gains an entry
for `'sturdyref'`) without surprise.

#### Pass-style defines the shape; the CapTP session manager constructs

`@endo/pass-style` owns the **definition** of the `'sturdyref'` category but not
its **construction**.
Concretely, `@endo/pass-style` supplies:

- recognition: `passStyleOf(value) === 'sturdyref'` for any value that satisfies
  the shape,
- validation: an `assertValid` (and the `SturdyRefHelper` below) that asserts a
  candidate is structurally a SturdyRef (a `location` that is a passable
  `OcapnLocation`, an optional string `type` hint, and no secret as a property),
- the `M.kind('sturdyref')` and `M.sturdyRef()` patterns that admit the category.

Construction (minting an instance that satisfies the shape) is the role of the
**CapTP session manager**, not `@endo/pass-style`.
The session manager is what associates a freshly minted SturdyRef instance with
its closely-held `(location, swissNum)` tuple, so it is the natural owner of
construction.
This is a deliberate reversal of an earlier draft that gated construction
through a `makeSturdyRef` maker exported by `@endo/pass-style`: pass-style stays
the definer of the shape, and the session manager constructs.
Where this document writes `sessionManager.makeSturdyRef(location, type?)`, the
maker is the session manager's, not pass-style's.

#### Helper: `SturdyRefHelper`

A new file `packages/pass-style/src/sturdyRef.js` adding:

```js
export const SturdyRefHelper = harden({
  styleName: 'sturdyref',
  canBeValid: (candidate, reject) => { /* sturdyref-instance check */ },
  assertValid: (candidate, passStyleOfRecur) => {
    // 1. The candidate is structurally a SturdyRef: an instance carrying
    //    [Symbol.for('passStyle')]: 'sturdyref', not a tagged value.
    // 2. The location passes a passable-location check
    //    (copyRecord with the right keys, designator/transport/
    //    optional network/hints).
    // 3. The location is hardened (deep-frozen).
  },
});
```

This helper only **recognises and validates**; it does not construct sturdyrefs
(construction is the CapTP session manager's role per *Pass-style defines the
shape; the CapTP session manager constructs*).
It joins `CopyArrayHelper`, `CopyRecordHelper`, `TaggedHelper`,
`RemotableHelper`, and the others in `passStyleOf.js`'s helper table.

#### Interface guards

`@endo/patterns` gains a matcher `M.sturdyRef()` that admits any SturdyRef.
A SturdyRef can appear anywhere a `Passable` may today.
Method guards that want to accept a SturdyRef where they previously took a
pet-name-path use a sum:

```js
M.or(M.arrayOf(M.string()), M.string(), M.sturdyRef())
```

(or a named alias `M.petNamePathOrSturdyRef()`, defined once in the daemon's
`interfaces.js`).

#### Boxing and unboxing across marshaling layers

Pass-style does **not** marshal.
The mechanism is:

- **On send (boxing).**
  The marshaler asks `passStyleOf(value)`.
  When the answer is `'sturdyref'`, the marshaler asks the layer's *sturdyref
  dispatcher* for a wire representation.
  For OCapN, the dispatcher inspects the locator and either emits the
  `ocapn-sturdyref` tagged record (peer + swiss-num) directly (when the locator
  is to a peer the session can reach) or rejects (when the locator is
  unreachable).
  For non-OCapN CapTP layers (the legacy `@endo/captp` over a single transport),
  the dispatcher uses an out-of-band side-channel reveal-locator capability that
  the session acquires at construction time.

- **On receive (unboxing).**
  The wire form (`ocapn-sturdyref(peer, swiss-num)` for OCapN, the equivalent
  for other layers) is handed to the layer's sturdyref *unboxer*, which:
  1. asks the CapTP session manager to construct a SturdyRef from
     `parsedLocation`,
  2. records `{ swissNum }` in the layer's side-table keyed by SturdyRef identity
     (the off-band `(location, secret)` map),
  3. returns the inert SturdyRef to the application.
  No `HandledPromise` registration occurs: the SturdyRef is an inert data box
  (see *A SturdyRef is inert*).
  The application that wants the live capability calls `enlivenSturdyRef(sturdyRef)`
  to obtain a presence and then `E()`s the presence; the OCapN-provided
  `enlivenSturdyRef` is the only path that reads the swiss number.

#### OCapN's closely-held capability

The closely-held capability OCapN supplies to the daemon is the *identity* of
the layer's sturdyref dispatcher and enlivener.
The capability provides three operations:

- `associate(sturdyRef, location) -> swissNum?` (mint side):
  returns the swiss number bound to a SturdyRef the daemon already holds, or
  undefined if not bound.
- `reveal(sturdyRef) -> { location, swissNum }` (decompose side):
  returns the closely-held tuple for a SturdyRef the holder is authorised to
  inspect.
- `enlivenSturdyRef(sturdyRef) -> Promise<Presence>` (enliven side):
  reads the locator off-band and resolves the SturdyRef to a live presence — a
  local capability for a local locator, or a remote reference (via
  `provideSession(location)` and `bootstrap.fetch(secret)`) for a remote one.
  This is the only sanctioned way to act on a SturdyRef, and it is performed on
  demand, each time the bearer wants the live capability.

Workers never see this capability; the daemon does.

### Daemon: SturdyRef as pet-name-path substitute

Every daemon agent method whose signature today accepts `...petNamePath` (or
`petNameOrPath: string | string[]`) gains an overload that accepts a SturdyRef in
place of the pet-name-path:

| Method | Today | After |
|---|---|---|
| `lookup(...path)` | `name -> value` | `name | sturdyRef -> value` |
| `identify(...path)` | `name -> id` | `name | sturdyRef -> id` |
| `locate(...path)` | `name -> locator` | `name | sturdyRef -> locator` |
| `reverseLookup(value)` | `value -> name[]` | unchanged |
| `reverseIdentify(id)` | `id -> name[]` | unchanged |
| `reverseLocate(locator)` | `locator -> name[]` | unchanged |
| `list(...path)` | `name -> name[]` | `name | sturdyRef -> name[]` |
| `listIdentifiers(...path)` | unchanged on path side | sturdyRef allowed where leaf is a directory |
| `listLocators(...path)` | unchanged | sturdyRef allowed |
| `write(path, id)` | `(name, id) -> void` | unchanged (write target is still a pet-name) |
| `writeLocator(path, locOrId)` | accepts locator or id | additionally accepts SturdyRef |
| `remove(...path)` | `name -> void` | unchanged (removal is by name) |
| `move(src, dst)` | both pet-name-paths | unchanged (rename is by name) |
| `makeUnconfined(spec, opts)` | `petNamePaths: (string|string[])[]` | each entry may be a SturdyRef |
| `evaluate(...)` | `petNamePaths` | each entry may be a SturdyRef |

The internal flow at the facet boundary is:

1. The facet receives a `SturdyRef | string | string[]` argument.
2. If it is a SturdyRef, the facet asks the daemon's `revealSturdyRef`
   capability (an alias of the closely-held capability above, scoped to the
   host's authority) for `{ location, swissNum }`.
3. The locator is internalised via the existing `internalizeLocator` flow.
   For a locator pointing at a local peer, the result is a local
   `FormulaIdentifier`.
   For a locator pointing at a remote peer, the result is the already-existing
   remote formula representation (a `remote`-typed formula identifier).
4. From here the facet's existing pet-name-path code path applies, with the
   SturdyRef having been resolved to a formula identifier.

The reverse methods (`reverseIdentify`, `reverseLocate`, `reverseLookup`) do
**not** gain SturdyRef forms.
A pet name is a one-way affordance from the user's namespace; a SturdyRef has no
name (that is the point).
`reverseLocate(locator)` is the existing answer to "what SturdyRef-shaped
questions can the user ask".

### Enlivenment is on demand

The whole model is that a SturdyRef is inert until someone needs the capability,
at which point they enliven it.
There is no implicit retention, no ephemeral edge, and no syscall:

- A worker that receives a SturdyRef and wants to use the capability calls
  `enlivenSturdyRef` to obtain a presence for that turn and sends to the presence.
  If the worker wants the capability again later, it enlivens again; the
  closely-held capability is the only path, and re-enlivenment is the sanctioned
  way to re-acquire.
  Re-enlivenment is **not idempotent**: two `enlivenSturdyRef` calls on the same
  SturdyRef within one instance return two **distinct** promises.
  Those promises do, however, **converge on the same value**, because the
  provider of the target remotable vends only one instance per session.
  Convergence on a single value, not promise identity, is the guarantee a bearer
  may rely on.
- A worker that wants to stash a reference for later stashes the **inert
  SturdyRef box** (pass-by-copy data), not a live presence.
  The box on its own retains nothing: re-enlivening still needs the closely-held
  capability, and the underlying formula's liveness is governed by the daemon's
  existing retention roots (pet names and the daemon's own `formulaGraph`
  edges), not by the worker holding the box.
- Enlivenment of a remote SturdyRef is a **daemon-side act**: the remote dial
  (`provideSession(location)` + `bootstrap.fetch(secret)`) happens on the
  daemon's side of the boundary, and what the worker imports is a daemon-local
  presence the daemon proxies to the remote target.
  The swiss number never crosses into the worker.

#### Revocation

The daemon revokes both sturdyrefs and live values, by distinct mechanisms and
without a retention table.

- **Revoking a sturdyref** is the daemon **forgetting** the nonce, identifier, or
  swiss number the sturdyref carried.
  Once the daemon has forgotten it, the sturdyref can never again be enlivened: a
  later `enlivenSturdyRef` call has nothing to resolve against and rejects.
- **Revoking a live value** is either **partition** or **termination** of the
  process holding the reference.

This is the revocation agency for a SturdyRef that has only ever been enlivened
on demand, with no pet name and no retention table.
The pet-name affordance (`writeLocator`) remains available for the case where the
user chose to name the locator, but it is not required: forgetting the
sturdyref's swiss number is itself the revocation root.
What governs the lifetime of an already-enlivened presence (as opposed to the
ability to enliven again) is still open (see *Open questions*).

### Local-only at the boundary

Every reference that crosses the daemon↔worker boundary is **local to that
boundary**.
The worker's CapTP session only ever imports presences the *daemon* exports, and
only ever receives SturdyRefs as inert, local-only boxes.
A worker never holds a reference that directly designates a remote peer:
enlivenment of a remote SturdyRef is a daemon-side act, and what the worker
imports is a daemon-local presence the daemon proxies to the remote target.
Cross-peer GC stays the daemon's concern, handled by the existing `formulaGraph`
cross-peer machinery; it is never exposed as a worker-held remote slot.

### Migration / staged adoption

The change lands in four cuts.
Each cut is independently mergeable; the cuts share a chronological order but are
not all in one PR.

| Cut | Change | Risk |
|---|---|---|
| 1 | Add the `'sturdyref'` shape to `@endo/pass-style` with `SturdyRefHelper`, an `assertValid` recogniser, the `M.sturdyRef()`/`M.kind('sturdyref')` patterns, and a passing test suite. Pass-style defines the shape only; it exposes no maker. No daemon change. `@endo/ocapn` continues to use its `tagged`-with-WeakMap shim; nothing else has to migrate yet. | Low. Internal-only addition. |
| 2 | `@endo/ocapn` migrates from `tagged`-with-WeakMap to the new pass-style category, dropping the `makeTagged('ocapn-sturdyref', ...)` tag: the CapTP session manager constructs sturdyref instances that satisfy the pass-style shape. `ocapnPassStyleOf` collapses to `passStyleOf`. Existing tests stay green. | Low. One package, well-covered. |
| 3 | Daemon's existing pet-name-path-accepting methods grow the `M.or(M.petNamePath(), M.sturdyRef())` guard. Initially they reject `M.sturdyRef()` at the facet (returning a "not yet implemented" error), so the guard ships before the resolution does. | Low. Type-surface only. |
| 4 | Daemon `revealSturdyRef` closely-held capability lands; the facets actually resolve SturdyRefs to formula identifiers and dispatch. Per-method tests prove `lookup`/`identify`/`locate`/`evaluate`/`makeUnconfined` all accept SturdyRefs. Existing pet-name-path-only callers are unaffected. | Medium. Touches every facet; per-method coverage matters. |

Existing formulas with petname-only retention are untouched: pet names continue
to be retention roots; existing pet-name-path callers continue to work; the
SturdyRef path is purely additive on the input side.

### Failure modes and tradeoffs

#### `enlivenSturdyRef` cannot resolve the SturdyRef

A SturdyRef's pass-style identity is scoped to one OCapN instance.
When `enlivenSturdyRef` is handed a SturdyRef it cannot resolve in the current
instance (it was minted by a different instance, or names a peer the session
cannot reach), it **rejects**, by design.
The bearer is expected to tolerate that rejection.

#### Worker stashes a SturdyRef box and enlivens it later

This is supported and is the only sanctioned cross-turn pattern.
The worker keeps the inert box (pass-by-copy data) and calls `enlivenSturdyRef`
again when it next needs the live capability.
The box retains nothing on its own; if the underlying formula is no longer live
(the user revoked it), the re-enlivenment rejects.

#### Worker holds a SturdyRef *and* calls a daemon method that resolves it

This is the central design payoff.
The worker passes the SturdyRef as an argument; the facet recognises
`passStyleOf === 'sturdyref'`, resolves to a formula identifier via the
closely-held capability, and dispatches.
No swiss number ever crosses into the worker.

#### Daemon restarts

A SturdyRef is data, so the box itself can be re-materialised, but a presence
enlivened from it does not survive a restart (neither does the worker; workers
are terminated on shutdown and reincarnated from their formula on next start).
After restart, the reincarnated worker re-enlivens whatever it needs on demand.
Persistent designation across restart is a pet name (write the locator under a
name via `writeLocator`); the user already has that affordance.

## Test plan

Pass-style:

- `passStyleOf(sessionManager.makeSturdyRef(location)) === 'sturdyref'`, where
  the session manager (not pass-style) constructs the instance.
- A SturdyRef survives `harden` and `passStyleOf` is idempotent.
- A SturdyRef whose location is not a valid `OcapnLocation` fails `assertValid`.
- A SturdyRef can be embedded in a `copyRecord`, a `copyArray`, and a
  `CopyTagged` payload (a SturdyRef-bearing record passes `passStyleOf`).
- The pattern matcher `M.sturdyRef()` admits SturdyRefs and rejects presences,
  copyRecords, and tagged values that look like SturdyRefs.
- `sessionManager.makeSturdyRef(location, 'some-type')` yields a SturdyRef whose
  `type` is `'some-type'`; `sessionManager.makeSturdyRef(location)` yields one
  with no `type`; `assertValid` rejects a non-string `type`.
  Two SturdyRefs with equal `location` but different `type` are treated as
  designating the same object (the `type` hint is excluded from identity).

OCapN integration:

- `@endo/ocapn` round-trips a SturdyRef minted by the CapTP session manager
  across a session and back to a SturdyRef whose `location` deeply equals the
  original.
- The receiving side's SturdyRef is inert; `E(sturdyRef)` is **not** valid, and
  `enlivenSturdyRef(sturdyRef)` yields a presence whose `E(presence).foo()`
  reaches the remote target.
- `enlivenSturdyRef` rejects, by design, for a SturdyRef it cannot resolve in the
  current instance.
- `@endo/eventual-send` is unchanged: no `HandledPromise` surface is added for
  SturdyRefs.
- `ocapnPassStyleOf` collapses to `passStyleOf` with no behaviour change for
  SturdyRefs.

Daemon facets:

- `E(host).lookup(sturdyRef)` resolves to the same value as
  `E(host).lookup(petName)` when both point at the same formula.
- `E(host).identify(sturdyRef)` returns the formula identifier.
- `E(host).locate(sturdyRef)` returns a locator equal to the SturdyRef's original
  locator (round-trip invariant).
- `E(host).makeUnconfined(spec, { petNamePaths: [sturdyRef] })` threads through.
- A confined guest that received a SturdyRef can pass it back to the host as an
  argument; the host facet resolves it; the guest never sees the swiss number.

## Acceptance criteria

- `@endo/pass-style` exports a SturdyRef pass-style category: a recogniser
  (`passStyleOf` answers `'sturdyref'`), a validating helper, and a pattern,
  with full tests. It defines the shape and does **not** export a maker;
  construction is the CapTP session manager's role.
- The SturdyRef value carries `location` and an optional flexible `type` hint (a
  string, advisory only, excluded from structural equality); the secret swiss
  number is never a property.
- `@endo/eventual-send` is unchanged: a SturdyRef is inert and is enlivened to a
  presence before any `E()`; no `HandledPromise` surface is added for SturdyRefs
  (per #521).
- A SturdyRef's pass-style identity is scoped to one OCapN instance (or other
  CapTP session), not global; `enlivenSturdyRef` may reject by design for a
  SturdyRef it cannot resolve, and no global SturdyRef→locator coordination is
  required.
- `@endo/ocapn` no longer needs `ocapnPassStyleOf` for SturdyRefs.
- Every daemon facet method that today accepts a pet-name-path also accepts a
  SturdyRef (per the table in *Daemon: SturdyRef as pet-name-path substitute*).
- The closely-held OCapN capability is the only path that reads the swiss number
  and the only path that enlivens a SturdyRef to a presence; enlivenment is on
  demand.
- No `FinalizationRegistry`, no `retain` / `release` `endor` syscall, and no
  daemon-side ephemeral retention table is introduced; the SES `lockdown`
  posture is unchanged.

## Open questions

One item remains genuinely open.
The abandoned paired-design mechanism (retention table, `retain` / `release`
syscall, proactive per-turn export drop, `FinalizationRegistry`) is withdrawn,
and this design does **not** substitute new mechanism in its place.

- **Lifetime of an enlivened presence.**
  When a worker enlivens a SturdyRef to a presence and then yields, what governs
  the lifetime of that presence (and the underlying formula's liveness) absent a
  retention table?
  This design states the presence is an ordinary CapTP presence subject to the
  existing `formulaGraph` and CapTP slot machinery, but it does **not** specify a
  deterministic teardown boundary; whether one is needed, and what enforces it
  without GC observation, is open.
  This is distinct from revocation, which is decided (see *Revocation*): the
  daemon forgets the swiss number to revoke a sturdyref, and partitions or
  terminates the holding process to revoke a live value.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-locator-reference](daemon-locator-reference.md) | Source of the locator format and the `internalize`/`externalize` flow this design reuses. |
| [daemon-locator-terminology](daemon-locator-terminology.md) | Source of the *Peer Key* / *Formula Address* terminology in flight. |
| #521 | `feat(pass-style): first-class 'sturdyref' pass-style; ocapn defers to it` — the in-flight implementation of the shared base problem (item 1), which established the inert-data-box correction this design adopts. |

## Prompt

This design was produced from the maintainer's directive on
`endojs/endo-but-for-bots#500` comment `4775973308` (2026-06-23), then
**repurposed** per the maintainer's 2026-06-26 decision (see *Direction*).
The 2026-06-26 directive:

> It was not my intention that this design branch land at all. Please reuse this
> pull request, rewriting the title, description, and content, and remove the
> design file. We will not pursue FinalizationRegistry release of sturdyrefs or
> retain/release syscalls for sturdyrefs or presences at this time. We will
> pursue sturdyrefs that can be enlivened on demand by the closely-held ocapn
> network capability.

The original 2026-06-23 directive (the source for the pass-style, locator,
boxing, and pet-name-path-substitute portions retained here):

> First, we need pass-style to support sturdy refs. Please look for relevant
> issues in Endo to inform the design. A sturdy ref is an opaque object, similar
> to a presence, that must be registered with HandledPromise, that corresponds
> to an OCapN locator. We'll need to design the parsed representation of a
> locator. A CapTP implementation including OCapN will be responsible for boxing
> and unboxing SturdyRefs. OCapN will in turn be responsible for providing the
> closely-held capability to either associate a SturdyRef with its locator or
> reveal the locator for a SturdyRef. SturdyRefs will be serialized in band in
> all of the supported marshaling layers, notably as already specified for
> OCapN.
>
> Then, it will naturally follow that a SturdyRef can be used as a place-holder
> for a pet-name, without having to designate a name. Any daemon agent method
> that currently accepts a pet-name-path should also be able to accept a
> sturdy-ref. This allows a confined guest or subagent, who should never see a
> locator, to refer to a formula without naming it.

The retention-dilemma portion of the original directive (the
`FinalizationRegistry` versus `retain`/`release`-syscall pair) is **not**
pursued, per the 2026-06-26 decision above.
Revocation is expressed without a retention table (the daemon forgets the swiss
number to revoke a sturdyref, and partitions or terminates the holding process
to revoke a live value; see *Revocation*).
Only the lifetime of an already-enlivened presence remains open (see *Open
questions*).
