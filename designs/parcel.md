# Parcel: A Primitive for Dormant Capabilities

| | |
|---|---|
| **Created** | 2026-10-14 |
| **Updated** | 2026-10-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Status

This is a proposal.
Nothing is built here.
It renames and reshapes the in-flight SturdyRef layering stack
([#695](https://github.com/endojs/endo-but-for-bots/pull/695#issuecomment-5903472512),
tracking issue [kriscendobot/garden#47](https://github.com/kriscendobot/garden/issues/47))
and reconciles it with
[`sturdyref-shim-contract.md`](https://github.com/endojs/endo-but-for-bots/pull/1389)
(layer 1, draft PR #1389).
An earlier draft of this argument was circulated as an essay, "Passing Parcels".
That draft was written against the `llm` tip and wrongly described `@endo/ocapn`'s private side table as the open problem.
The stack already moves the realm-wide brand and open hook into the layer-1 shim.
Its layer-7 branch retains a narrower `sturdyRefDetails` table only so the OCapN
codec can recover peer and swiss-number coordinates from values it minted.
The Parcel pivot removes that remaining duplication: trusted OCapN code calls
`Parcel.locate` and parses the location instead.

## What is the Problem Being Solved?

Programs need a third kind of reference.

- A **live** reference is a Remotable, a Promise, or a presence.
  It has identity, and it lasts only as long as the session that carries it.
- A **data** reference is a string, a record, or some bytes.
  It lasts, and it can be copied and logged, but it has no authority and no marker that says it is special.
- A **dormant** reference names a capability without manifesting it.
  It survives partition, restart, and storage.
  It can be woken once or many times by someone who can reach the peer that vouches for it.
  Neither of the other two kinds can be this, and the codebase tentatively approximates it with whichever is nearest, either a remotable or tagged data, and neither is suitable for Distributed Confinement or durable across partition.

E called the dormant kind a SturdyRef.
"Sturdy" names one property, durability, and not what the thing is.
The word has since spread over three different things:

| People say "sturdyref" and mean | What it is |
|---|---|
| the bytes of an `ocapn://.../s/...` URI | a **locator**: data, copyable, dangerous to leak |
| the object a program holds and passes | a **box** around a locator, opaque, with a way to open it |
| the capability obtained after fetching | a **target**: a live reference with a different lifetime |

Arguments about one then get settled with facts about another.
This repository shows the diffusion.
`@endo/ocapn` calls the box a SturdyRef and the locator a "secret".
The daemon calls nearly the same idea a locator or a formula.
The retention designs call a SturdyRef an "inert data box", which is the best description in the pile and does not appear in the name.

This design proposes the name **Parcel** for the box, and proposes the changes to the stack's contract that the name makes visible.

## Design

### Surface

```js
const parcel = new Parcel(location, open);
// location: string
// open: (location: string, parcel: Parcel) => Passable | Promise<Passable>

passStyleOf(parcel);        // 'parcel'
Parcel.open(parcel);        // Promise<Passable>
E.open(parcel);             // Promise<Passable>, convenience spelling
Parcel.isParcel(value);     // boolean, a brand check that confers no authority
Parcel.locate(parcel);      // string, present on %InitialParcel% only
```

- `new Parcel(location, open)` requires a string `location` and a function `open`, and throws `TypeError` otherwise.
  It throws without `new`, as `Proxy` does.
  It returns a fresh frozen object with no own properties, inheriting from a hardened `Parcel.prototype` that carries only `constructor` and `Symbol.toStringTag: 'Parcel'`.
  The location and hook live in a closely held `WeakMap` inside the realm's single constructor.
  They are not reachable from the parcel.
- `Parcel.open(parcel)` returns a promise.
  The hook runs in a later turn, as `open.call(undefined, location, parcel)`, and the promise resolves with its result.
  A hook that throws rejects the promise.
  A non-parcel argument rejects with a `TypeError` whose message begins `Parcel.open: not a Parcel`; it does not throw synchronously.
  Each call dispatches afresh and runs the hook again.
  The hook owns idempotence.
- `Parcel.isParcel(value)` consults the `WeakMap`.
  It must not be collapsed into `instanceof`, because a prototype chain can be forged with `Object.create`.
- `Parcel.locate(parcel)` returns the location string.
  It exists only on `%InitialParcel%` (below).
  A non-parcel argument throws a `TypeError` synchronously, exposing a failed invariant rather than returning an optional value that every caller must narrow.
- `E.open(parcel)` is the `@endo/eventual-send` convenience spelling of `Parcel.open(parcel)`, following `E.resolve`.
  The former `E.enliven` spelling does not survive because it has not shipped and the Parcel vocabulary is `open`.

The `open` hook receives the parcel as a second argument so that one hook function can serve many parcels and still apply identity-keyed policy.

### Semantics

| Property | Parcel |
|---|---|
| Pass style | the string `'parcel'` |
| Equality | no pass-invariant equality, like a Promise. Two parcels for one capability may be unequal. |
| Opening | opening twice need not yield the same referent, especially if the referent is a target |
| Partition | a parcel survives it and can reestablish a connection to the capability across sessions |
| Matching a grant | a parcel cannot be used to match a grant; it asserts nothing about identity |
| Confinement | holding a parcel does not reveal where it points; reading the location is a separate authority |

The last row is the reason for the authority split below.
A location carries the cryptographic information needed to establish a session and use the capability directly.
Showing it to a confined principal, even indirectly through a bot's transcript, hands over an exfiltratable key.
A parcel lets a confined principal carry, store, and open a reference without being able to read it.

### Authority split: `%InitialParcel%` and `%SharedParcel%`

SES already splits `Date`, `Symbol`, and `URL` into a powered start-compartment constructor and a powerless shared one, and `Parcel` follows the same pattern.

- `%InitialParcel%` is `globalThis.Parcel` in the start compartment.
  It has the constructor, `open`, `isParcel`, and `locate`.
  Endowing it confers the authority to read the cryptographic information in a location.
- `%SharedParcel%` is `Parcel` in every later compartment.
  It has the constructor, `open`, and `isParcel`, but not `locate`.
  A guest can build a parcel from a location it already holds and can open any parcel it is given, but it cannot learn what a parcel says.
- Both share one `Parcel.prototype`, so `instanceof` and the brand check agree across the boundary.
- `lockdown()` hardens both.
  The `initialGlobalPropertyNames` loop in `packages/ses/src/lockdown.js` already hardens start-compartment globals; the shared constructor is hardened with the other shared intrinsics.

The shared constructor is derived from the initial one using only its public surface, as `%SharedURL%` is in `packages/ses/src/tame-url-constructor.js`.
SES therefore needs no access to the shim's table.

```js
const SharedParcel = function Parcel(location, open) {
  if (new.target === undefined) throw TypeError('Parcel requires new');
  return construct(InitialParcel, [location, open], new.target);
};
defineProperties(SharedParcel, {
  prototype: { value: InitialParcel.prototype },
  open: { value: InitialParcel.open },
  isParcel: { value: InitialParcel.isParcel },
});
defineProperties(InitialParcel.prototype, {
  constructor: { value: SharedParcel },
});
```

Permits gain `Parcel: '%InitialParcel%'` in `initialGlobalPropertyNames`, `Parcel: '%SharedParcel%'` in `sharedGlobalPropertyNames`, and entries for both constructors and the shared prototype.
An absent `Parcel` is not an error, so hosts that never installed the shim keep working.

### Packaging

The first-wins packaging shape of layer 1 carries over under the new name and
with the initial/shared authority split.

- The package is `@endo/parcel`, with a ponyfill (`index.js`), an installing entry (`shim.js`), and a no-side-effect constructor-kit entry (`no-shim.js`).
- First definer wins.
  Every evaluation races to select `globalThis.Parcel`; `selectParcel` adopts an existing valid constructor and installs its own only if none exists.
  Eval twins therefore share one constructor and one table.
- The defining shim must run before `lockdown()` so that SES sees `Parcel` at `repairIntrinsics` time.
  A later evaluation of the shim, including one inside a compartment after `lockdown()`, races by shape-checking and adopting the constructor already visible there.
  It neither replaces the winner nor rejects it based on a version or contract marker.
- The initial bootstrap installs the powered constructor, including `locate`, before lockdown.
  An evaluation after lockdown in a child compartment cannot replace that binding and instead adopts the existing `%SharedParcel%`, which has `open` and `isParcel` but no `locate`.
  A late evaluation fails only if no Parcel global is present to adopt.
- Every later version silently adopts the first valid constructor, without a
  contract or version marker.
  An incompatible future primitive would need a new spelling instead of
  weakening first-wins.
- Before `lockdown()` the shim must not call `@endo/harden`, because that installs a harden implementation and `lockdown` then throws.
  It freezes the constructor, prototype, and statics, and leaves hardening to `lockdown`.
- The shim does not depend on `@endo/pass-style`.
  Pass style recognizes parcels, not the reverse.

### Pass style

`@endo/pass-style` gains `'parcel'` as a `PassStyle`.
The in-flight layer 3 does not register a SturdyRef helper in `HelperTable`; `passStyleOf.js` calls `isSturdyRefObject` immediately before its remotable fallback.
The pivot preserves that proven ordering under the name `isParcelObject`, returning `'parcel'` before a frozen empty Parcel can be rejected as an object with no methods.
`Parcel.prototype` must not carry a `PASS_STYLE` tag.
The brand check is the only recognition path.

### Marshal

A marshal whose owner holds `locate` represents a parcel as inline data.
The original CapData format uses this encoding and no slot:

```json
{
  "body": "{\"@qclass\":\"parcel\",\"location\":\"#ocapn=1&peer=ed25519hex&value=rand256hex\"}",
  "slots": []
}
```

Smallcaps reserves the apostrophe prefix for a parcel followed immediately by its location.
For the same parcel, the complete CapData body is `#"'#ocapn=1&peer=ed25519hex&value=rand256hex"` with an empty `slots` array.
Ordinary strings beginning with an apostrophe remain escaped by Smallcaps with `!`, so the representation is unambiguous.

On decode, the marshal uses its supplied parcel maker to bind the location to that endpoint's `open` hook.
A marshal without `locate` cannot encode a parcel.
A relay may instead translate the inline representation into a protocol slot when the receiving protocol needs hosted identity, but a parcel does not occupy a slot merely to cross a marshal boundary.

Syrup and CBOR tentatively retain the existing `ocapn-sturdyref` record.
Their protocol codec translates that structured locator to and from a parcel rather than delegating this representation to generic marshal.

The generic marshal does not receive location authority ambiently.
Its `encodeParcel*` callback is installed only by a trusted owner that holds `%InitialParcel%`, and its `decodeParcel*` callback supplies the open hook appropriate for that transport or location resolver.
The decoder rejects an inline Parcel encoding when no resolver is supplied.
This keeps `@endo/marshal` ignorant of location grammar and prevents an unprivileged caller from turning a Parcel into a string merely by selecting a public serializer.
The ordered passable encoding keeps the existing `t` category prefix, renamed
from `sturdyRef` to `parcel`.
All Parcels remain tied in rank because they have no pass-invariant equality.

### CapTP and OCapN

OCapN is trusted code that is endowed `%InitialParcel%`.

- On send, OCapN reads `Parcel.locate(parcel)`, parses the location, and writes the existing `ocapn-sturdyref` wire record carrying the peer and swiss number.
- On receive, OCapN builds `new Parcel(formatLocation(peer, swissNum), open)` with an `open` hook bound to the receiving client, and hardens the result.
  The hook establishes or reuses a session to the designated peer, fetches through the bootstrap, and returns the promise for the referent.
- The **wire tag `ocapn-sturdyref` does not change.**
  It is defined by the OCapN specification and is how Goblins and other peers interoperate.
  The on-wire value is a structured capability locator, not a parcel, and the OCapN specification need not adopt the JavaScript-facing name.
  A non-normative mapping from the OCapN data model to Endo may mention parcels.

Because every OCapN instance in the process shares one constructor, a parcel built by one instance can be located, serialized, and opened by another.
Under the old layer-1 contract, only the minting CapTP could serialize a ref, because only it held the table, and carrying a ref through a second CapTP was left as a protocol-compatibility question.
`locate` on the initial constructor is what lets a trusted forwarder carry a parcel that it did not mint, while a confined guest still cannot read it.
The authority is necessary because `Parcel` sits beneath any particular OCapN instance: multiple later instances must be able to recognize and forward one another's parcels without giving the location to confined code.

Parcel itself deliberately assigns no grammar to locations.
The likely OCapN-layer spelling is a URL fragment whose fields parse as `URLSearchParams`, for example `#ocapn=1&peer=ed25519hex&value=rand256hex&at=transportAndAddress&at=transportAndAddress`.
Such a fragment can be appended to any HTTPS URL in a federation: software without OCapN support follows the HTTPS location, while OCapN-aware software intercepts the fragment and avoids pinging a potentially untrusted federated host.
This scheme assumes that the first introduction to a capability comes from a trustworthy source and that operating-system OCapN hooks handle later uses.
The OCapN layer, not the Parcel contract, will settle that grammar.

The in-flight CapTP-specific `s+` / `s-` slot kind is therefore not renamed to `d+` / `d-` for ordinary carriage.
Direct Parcel carriage uses the inline marshal representation and survives the carrying connection.
A relay may introduce a connection-bound slot only when it intentionally translates that slot back into a durable location; that is relay policy, not the Parcel encoding.

### Provenance

Layer 1's provenance analysis survives intact.
Once `Parcel` is propagated to child compartments, a guest can call `new Parcel(location, evilOpen)`, and the result passes `Parcel.isParcel`.
If a host enlivens such a parcel, the guest's hook runs in the host's turn.
The brand check proves "built by this realm's constructor", never "built by a party I trust".

`locate` adds one consequence.
A trusted forwarder that locates and transmits a guest-forged parcel transmits only the location string the guest chose, not the guest's hook, and a recipient reconstructs its own hook.
That is safe for the sender and is the intended behavior.
The recipient's own `open` hook for a given location scheme is its authority to interpret the string.

The rule for callers is unchanged.
Opening a parcel runs its minter's code, so open only parcels from a source that you would let run code in your turn.
Provenance for parcels that cross a trust boundary belongs to the layer that accepts them: the CapTP at layer 5 and the daemon at layer 8.

### Relation to Proxy and HandledPromise

`Proxy` lets a program supply behavior for the operations on an object.
`HandledPromise` lets a program supply behavior for the eventual operations on a promise.
`Parcel` lets a program supply behavior for acquisition, the step from a dormant name to a live reference.
All three bind a hook at construction that cannot be inspected from the language, and what each object means depends on the trusted code that installed the hook.
That shared shape is why the shim follows the `HandledPromise` pattern, and why the state that must be shared lives in a first-wins global.

### What a Parcel is for

- **Distributed confinement.**
  A confined guest can store, return, and open a parcel without reading it.
  A bot's transcript that handles a parcel contains `Parcel {}` and nothing more.
- **Durable capabilities.**
  A parcel stored today can be opened by a process that has never spoken to the peer, for as long as the peer honors it.
  Opening promises no convergence, so the peer remains free to hand out a fresh attenuated facet each time, or to refuse.
- **Formulas without manifestation.**
  A parcel whose hook runs a formula describes how to obtain a capability and causes none of the effects of obtaining it.
  Builder-pattern APIs can compose such descriptions out of parcels, and the single `Parcel.open` is where cost is incurred and authority exercised.
  This is layer 8's "SturdyRef for a formula without incarnation".

## Reconciliation with the Layer-1 Contract

| Topic | Layer-1 contract (#1389) | This design | Why |
|---|---|---|---|
| Name | `SturdyRef` | `Parcel` | the old name describes durability, not the object |
| Construction | `new SturdyRef(handler, locator)` | `new Parcel(location, open)` | a handler object with one hook is a single function. A shared hook is a shared function. |
| Revive | `SturdyRef.enliven(ref)` | `Parcel.open(parcel)` | "open" matches the box; "enliven" implies the referent is a live thing awakened, which it may not be |
| Eventual-send spelling | `E.enliven` adopted | `E.open` | retain the convenience spelling under the Parcel vocabulary; `E.enliven` is not entrenched |
| Hook timing | later turn | later turn, unchanged | an `async` function body runs synchronously until its first `await`, so the implementation must defer explicitly |
| Hook call form | `enliven.call(handler, ref, locator)` | `open.call(undefined, location, parcel)` | no handler object, so no receiver |
| Location access | locator never reachable; only the minting CapTP's side table serializes | `Parcel.locate` on `%InitialParcel%` only; throws for a non-Parcel | lets a trusted forwarder serialize parcels it did not mint, while guests cannot read them; throwing keeps a narrow `string` result |
| Authority | one constructor; propagation decided by layer 2 | initial and shared constructors | the missing powerless variant is what layer 2's propagation decision needs |
| Brand check | `SturdyRef.isSturdyRef` | `Parcel.isParcel` | unchanged in kind |
| First-wins packaging, harden-if-present, no pass-style dependency | as described | unchanged | settled by layer 1 |
| Provenance | section in layer 1 | carried over, with the `locate` note above | |

## The Layer Map After the Rename

| Layer | Draft | Rename and behavior change |
|---|---|---|
| 1 | #1389, based on #774 | Replace `@endo/sturdyref` and `SturdyRef` with `@endo/parcel` and `Parcel`; use the single `open` hook; expose `open`, `isParcel`, and initial-only `locate`; add `E.open`; preserve later-turn dispatch and first-shim-wins installation. |
| 2 | #1391 | Replace the single SES accommodation with `%InitialParcel%` and `%SharedParcel%`, derived like `%SharedURL%`; withhold `locate` from children and harden both constructors at lockdown. |
| 3 | #1392 | Rename the pass style to the literal `'parcel'` and the special pre-remotable brand check to `isParcelObject`; do not add a helper or prototype tag. |
| 4 | #1393 | Replace slot-index CapData and Smallcaps forms with the inline `@qclass: 'parcel'` plus location and apostrophe plus location forms; retain the ordered `t` category with no meaningful order within it. |
| 5 | #1394 | Do not rename `s+` / `s-` to `d+` / `d-`; ordinary Parcel carriage is inline and transport callbacks hold locate/open authority. A relay-specific durable slot remains a separate policy. |
| 6 | #1396 | Rename `makeSturdyRef` to `makeParcel`, construct from received location data with the connection's open hook, and remove the private minting-connection serialization restriction. |
| 7 | #1397 | Rename the JavaScript object and helpers to Parcel; remove the transitional private coordinates table in favor of privileged `locate`; open through bootstrap and nonce location; preserve `ocapn-sturdyref` on the wire. |
| 8 | #1398 | Rename daemon locator/formula helpers to Parcel and return a dormant formula Parcel without incarnating it; keep provenance checks at the daemon boundary. |
| 9 | #1399 | Rename the agent and worker API to Parcel and `open`; base it on the canonical contract here. Slot Machine carriage and communications-vat opening follow [`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md); named-call, tool-consumer, and weak-import ownership questions remain review gates. |

[`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md) now specifies the
transport boundary this language design leaves open: Slot Machine copies a
Parcel inline, opens it through a closely held communications vat, and assigns
live retention only to the opened result. It is an input to the worker-facing
layer 9 and the daemon export/revocation work in layer 8.

## Dependencies

| Dependency | Kind | What this design takes from it |
|---|---|---|
| #774 | precedent | First-shim-wins installation, later-turn opening, and a shared realm-wide brand. |
| #1389 | layer 1 draft | The shim contract this design renames and supersedes where the surface differs. |
| #1391–#1399 | implementation stack | Nine ordered layers that must consume the contract and layer map above. |
| #695, #697, #511, #539, #1404 | related designs | Retention, revocation, daemon, and guest-boundary requirements; their old SturdyRef spellings are prior art, not the canonical contract. |
| `%SharedURL%` | SES precedent | A powered initial constructor and a shared constructor with the same prototype but less authority. |

## Ownership map

| Concern | Owner | Why |
|---|---|---|
| Brand, hidden location, open hook, first-wins selection | `@endo/parcel` | One realm-wide table must define what a Parcel is. |
| Initial/shared split and lockdown hardening | `@endo/ses` | SES decides which globals and authorities each compartment receives. |
| Pass-style recognition and generic representations | `@endo/pass-style`, `@endo/marshal` | These packages classify and encode language-level passables without understanding location grammar. |
| Location interpretation and `ocapn-sturdyref` records | `@endo/ocapn` | OCapN owns its protocol grammar, connections, and interoperable wire form. |
| Formula construction, provenance, retention, revocation | daemon and worker boundary | These are application lifetime and trust decisions, not language-primitive semantics. |

The boundary rule is that only trusted transport or daemon code receives
`%InitialParcel%` or an equivalent encode callback.
Moving `locate` into a generic serializer or `%SharedParcel%` would silently move
cryptographic-location authority across that boundary and is therefore out of
scope for an implementation convenience.

## Objections

- **It is just a string.**
  A string is copyable by whatever touches it, prints by default, and is indistinguishable from other strings.
  A parcel prints as an empty frozen object, has its own pass style, and keeps its location behind an authority.
- **It is just a tagged record.**
  Any code can call `makeTagged('ocapn-sturdyref', ...)`.
  A pass style backed by a shared brand makes the distinction real and process-wide.
- **Renaming breaks OCapN interop.**
  The wire tag stays.
- **Why not a Remotable with an `open` method?**
  A Remotable is a live target.
  It must be hosted, it has identity, and it dies with its session.
  A dormant capability needs none of those to exist, and hosting it would keep it alive.
- **The metaphor is imperfect.**
  A paper parcel is opened once.
  A Parcel may be opened again and may yield something different.
  The name is chosen for the properties that are most often misunderstood: boxed, addressed, not yet manifest, carried by hands that cannot see inside.

## Design Decisions

1. `%InitialParcel%` has `locate` because the realm-wide abstraction must sit beneath individual OCapN instances and let trusted instances recognize one another's parcels.
2. Parcel is an Endo language representation, not an OCapN wire-model term.
   The OCapN specification retains its structured capability locator and may describe the Endo mapping non-normatively.
3. The package is `@endo/parcel`.
4. Eventual send exposes `E.open`; `E.enliven` is replaced before it becomes entrenched.
5. Smallcaps and CapData carry the location inline as specified above.
   A relay may translate that data into a slot when its protocol requires one.
6. Shim evaluation is a first-wins race.
   Every later evaluation adopts the existing valid constructor, including after `lockdown()`, without imposing a version marker.
7. `Parcel.locate` throws for a non-parcel, so successful return has the narrow `string` type and invariant failures surface immediately.

## Prompt

> I mean to introduce a language feature called Parcel which has some design properties related to Proxy and HandledPromise.
> There would be different Parcel globals in a SES initial compartment and subsequent Compartments, such that the initial Parcel would implement `new Parcel(location, openHook)`, `Parcel.open(parcel) => Promise<Passable>`, `Parcel.locate(parcel) => location:string`.
> The `%SharedParcel%` would not provide `locate`, but would otherwise be the same.
> Lockdown would harden `%InitialParcel%` and `%SharedParcel%`, such that endowing `%InitialParcel%` would be safe, but confer the authority to see the cryptographic information in a parcel location.
> Parcels would be passable over CapTP, particularly OCapN, where they are passed as data and reified as opaque Parcel instances.
> The pass-style of a Parcel would be literally "parcel".
> The semantics of Parcel passing are that parcels do not have pass-invariant equality (like Promise) and opening a Parcel twice does not guarantee that the promises converge on the same referent.
> A Parcel may survive partition with the originating peer, but can't be used to match a grant.
> The purpose of a Parcel is to support distributed confinement and durable capabilities.
> It must be a first-shim-wins race, similar to the patterns for lockdown and harden, and HandledPromise.
> (kriskowal, liaison session 2026-10-14; sketch at https://gist.github.com/kriskowal/b266d5ab8ba047ccea9097b39f271114.)
> "Let's start with a reviewable design taken from the proposed essay."
