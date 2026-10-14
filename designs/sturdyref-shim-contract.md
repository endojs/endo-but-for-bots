# The `Parcel` Shim Contract (Layer 1)

| | |
|---|---|
| **Created** | 2026-09-30 |
| **Updated** | 2026-10-14 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Summary

This document specifies `Parcel`, an opaque, passable box around a location and the procedure for opening it into a live capability.
It replaces the JavaScript-facing `SturdyRef` name and contract throughout the in-flight nine-layer stack while preserving the OCapN specification's `ocapn-sturdyref` wire tag.
The historical filename stays in place so the existing draft PR, review links, and layer references remain stable.
The canonical cross-layer contract is the
[`parcel.md` draft](https://github.com/endojs/endo-but-for-bots/pull/1460).
This document owns layer 1 and records the consequences for its existing stack.

A Parcel is neither locator data nor a live presence.
It can survive serialization and a network partition, but opening it may fail and repeated opens need not produce the same live reference.
The location is cryptographic authority, so the ability to read it is separate from the ability to hold, pass, or open the Parcel.

The design is derived from the maintainer's immutable essay, [Passing Parcels](https://4mudvrv2lxvf556yxjyudkilwqadmclfx736ym3u77bfro4huoka.ocap.site/), and reconciles that proposal with the already-built SturdyRef stack.
The original layering directive is on [#695](https://github.com/endojs/endo-but-for-bots/pull/695#issuecomment-5903472512), and the layer-1 implementation is the existing draft [#774](https://github.com/endojs/endo-but-for-bots/pull/774).

## Semantics

The pass style is literally `"parcel"`.
A Parcel has ordinary local object identity, but the pass style provides no pass-invariant equality and no location-based equality.
Two Parcels for one capability may be unequal, and two equal location strings are not proof that two grants are the same.

`Parcel.open(parcel)` always returns a promise.
It invokes the captured hook in a later turn, assimilates the hook's returned promise or thenable, and turns a thrown error into a rejection.
Opening the same Parcel repeatedly dispatches repeatedly and need not converge on one referent.
Memoization, attenuation, cancellation, revocation, and connection reuse belong in the open hook or the protocol layer that supplies it.

A Parcel survives a partition because its location can be serialized and a later process can construct an equivalent Parcel with an appropriate open hook.
Survival does not guarantee that the peer remains reachable or continues to honor the location.

A Parcel cannot be used to match a grant.
Its public surface exposes no location, grant identity, or equality predicate, and a brand check proves only construction by the realm's selected Parcel implementation.

Every Parcel instance is frozen and has no own properties.
After `lockdown()`, `%InitialParcel%`, `%SharedParcel%`, their statics, and their shared prototype are hardened.
The Parcel shim must be installed before `lockdown()` so SES can sample, split, and harden the two constructors.

## Surface

```js
const parcel = new Parcel(location, openHook);

Parcel.isParcel(parcel); // true
Parcel.open(parcel); // Promise<Passable>
Parcel.locate(parcel); // string, only on %InitialParcel%
```

The constructor has the following contract.

- `location` must be a string.
- `openHook` must be a function.
- The constructor reads and captures both values once.
- The constructor rejects subclassing and calls without `new`.
- The instance inherits from the shared hardened `Parcel.prototype`, has `Symbol.toStringTag: 'Parcel'`, has no own properties, and is frozen.
- The location and hook live in the selected constructor's private `WeakMap` and are not reachable through the instance or prototype.

The open hook has the call shape `openHook(location, parcel)`.
The shim invokes it with `this === undefined` in a later turn.
A single function can therefore serve every Parcel minted by a CapTP or OCapN client, while the location and Parcel arguments identify the particular request.
The hook may close over mutable policy or connection state, and the shim does not harden that closed-over state.

`Parcel.open(parcel)` rejects with a `TypeError` for a non-Parcel rather than throwing synchronously.
This keeps argument errors and hook failures on the one promise-returning path.
The semantic result is a `Passable`, but layer 1 does not depend on `@endo/pass-style` merely to validate the hook's result.

`Parcel.isParcel(value)` is a non-authoritative brand check against the selected constructor's private table.
It does not use `instanceof`, because a forged prototype chain is not a Parcel.
It does not assert who minted the Parcel, whether its location is valid for a particular protocol, or whether opening it is safe.

`Parcel.locate(parcel)` synchronously returns the captured string and throws a `TypeError` for a non-Parcel.
This static exists only on `%InitialParcel%`.
Code that can call it has explicit authority to reveal cryptographic location data and must treat the returned string as a capability.

The operation is named `open`, not `enliven`, because it opens a dormant box rather than sending an eventual message to a live or promised target.
`SturdyRef.enliven` is replaced by `Parcel.open`.
`E.enliven` does not survive the pivot.
`E.open(parcel)` is added as the eventual-send convenience spelling, following
the precedent of `E.resolve`, and delegates to `Parcel.open(parcel)`.

The contract uses one open function rather than a handler object.
There is only one trap, so a handler adds dynamic shape, `this` binding, and mutation questions without providing a second dispatch operation.
The function still provides the sharing property the old handler was selected for: one open hook can serve every Parcel minted by a transport.

## Initial and shared authority split

SES exposes two constructors over one brand table and one prototype.

- `%InitialParcel%` is the first-wins constructor installed on the start compartment's global before lockdown.
  It has `open`, `locate`, and `isParcel` statics.
- `%SharedParcel%` is the tamed constructor installed on every compartment created after lockdown.
  It has `open` and `isParcel`, but deliberately has no `locate` static.

The split follows `%InitialURL%` and `%SharedURL%` in [`packages/ses/src/tame-url-constructor.js`](../packages/ses/src/tame-url-constructor.js).
SES adds `tame-parcel-constructor.js`, samples the valid pre-lockdown global, creates a function named `Parcel` whose construction delegates to `%InitialParcel%`, and registers both constructors as intrinsics.
The shared constructor returns an instance made by the initial constructor and points its own `prototype` property at the same `Parcel.prototype`.
Both `instanceof` checks and `Parcel.isParcel` therefore agree across the compartment boundary.

Before hardening, SES repoints the shared prototype's `constructor` property to `%SharedParcel%`, exactly as URL and Date avoid a powered constructor back-reference.
Without that step, a child could reach `%InitialParcel%` as `Parcel.prototype.constructor` and recover `locate`.
The start compartment consequently also observes `parcel.constructor === %SharedParcel%`; its powered constructor remains available as its global `Parcel` binding.

Endowing `%InitialParcel%`, or merely its `locate` function, confers location-revelation authority.
Endowing `%SharedParcel%` does not.
A child that already holds a location may construct a new Parcel from that string and its own hook, just as it may construct a Proxy from a handler it already holds, but it cannot extract the location from a Parcel it receives.

This split reconciles two earlier choices.
[#774](https://github.com/endojs/endo-but-for-bots/pull/774) withheld `SturdyRef` from children because its `toLocation` global was an authority amplifier.
The previous layer-1 contract removed all location-revealing authority and [#1391](https://github.com/endojs/endo-but-for-bots/pull/1391) consequently shared one constructor universally.
Parcel instead retains the safe propagation property for `%SharedParcel%` while making the host's separately named `%InitialParcel%` the explicit amplifier.
[#1404](https://github.com/endojs/endo-but-for-bots/pull/1404)'s rule that guests neither produce nor consume identifiers or locators remains intact because guests receive only `%SharedParcel%` and Agent APIs never return `Parcel.locate` results.

## Packaging and first-shim-wins installation

The package is renamed from `@endo/sturdyref` to `@endo/parcel`, and the package directory becomes `packages/parcel`.
It has an explicit `shim.js` entry for installation and a no-side-effect `no-shim.js` entry for constructor-kit use and tests, following `@endo/eventual-send`.
Endo bootstrap code imports `@endo/parcel/shim.js` before `lockdown()`.

The shim installs `globalThis.Parcel` only when the property is absent.
A later copy adopts an existing initial constructor after validating own data
properties for `open`, `locate`, `isParcel`, and `prototype`, or an existing
shared constructor after validating the same shape without `locate`.
The global binding is non-writable, non-configurable, and non-enumerable, so all eval twins converge on one brand/location/hook table.

A second shim, including a different version, silently adopts the first valid
constructor without a contract or version marker.
An incompatible future primitive needs a new spelling rather than weakening
first-wins.

The defining installation must happen before lockdown.
A later evaluation after lockdown, including evaluation in a child compartment,
adopts the Parcel constructor already visible there and does not attempt to
replace the frozen global.
A late evaluation fails only when there is no existing Parcel to adopt.
The pre-lockdown constructor and prototype remain bootstrap-mutable only long enough for SES to construct `%SharedParcel%` and repoint the shared prototype's constructor.
`lockdown()` then hardens both constructors and the prototype as one intrinsic graph.
Parcel instances are frozen immediately even before lockdown.

## Location ownership and the current stack

The essay's prior-art paragraph describes `@endo/ocapn`'s private `sturdyRefDetails` table as though it were still the sole brand and open table.
That is true of the `llm` baseline the essay examined, but not of the in-flight stack as a whole.

The stack already separates the responsibilities.
Layer 1's selected global constructor owns the process-wide brand and open dispatch table.
Layers 5 and 6 retain narrower protocol tables: OCapN's `sturdyRefDetails` records `(location, secret)` only for refs that its codec may serialize, and CapTP's `sturdyRefData` records reconstruction coordinates.
Those tables are provenance and serialization-authority checks, not the JavaScript brand.
This distinction is why refs from eval twins already share `isSturdyRef` and opening behavior even though an unrelated OCapN tracker refuses to serialize them.

The Parcel pivot deliberately changes that second decision.
The canonical location moves into the selected Parcel table, and trusted serializers in the start compartment use `%InitialParcel%.locate` to recover it.
The OCapN `sturdyRefDetails` coordinate table and CapTP `sturdyRefData` coordinate table are removed where they merely duplicate that string.
An OCapN codec serializes only a Parcel whose location parses as an OCapN sturdyref URI, while another CapTP protocol may recognize its own location scheme.
Protocol recognition replaces module-instance provenance as the serialization admission rule.

This does not expose locations to child compartments.
It does mean that every start-realm component endowed with `%InitialParcel%` can inspect and serialize any Parcel whose location syntax it understands.
That is the explicit authority conferred by `%InitialParcel%`, and host bootstrap code must endow `%SharedParcel%` instead when that authority is not intended.

## Naming and encoding ledger

All JavaScript-facing SturdyRef names in the nine-layer stack become Parcel names.
The historical design filenames and PR numbers remain stable review anchors.

| Surface | Parcel name |
|---|---|
| Package and global | `@endo/parcel`, `packages/parcel`, `globalThis.Parcel` |
| Constructor types and helpers | `Parcel`, `ParcelConstructor`, `makeParcelConstructor`, `provideParcel`, `selectParcel` |
| Static operations | `Parcel.open`, `Parcel.locate`, `Parcel.isParcel` |
| Pass style and pattern | `"parcel"`, `isParcelObject`, `M.parcel()`, `ParcelShape` |
| Capdata | inline `{"@qclass":"parcel","location":"<location>"}` and Parcel encode/decode callbacks |
| Smallcaps | apostrophe plus the inline location string; ordinary leading apostrophes remain escaped |
| Encode-passable ordering | the existing compact prefix `t`, keyed as `parcel`; the one-character ordering code is not a public semantic name |
| Justin rendering | inline Parcel rendering and reconstruction with no slot index |
| CapTP | `ParcelData`, `makeParcelFromData`, `locateParcel`; ordinary carriage is inline, not a renamed `d+` / `d-` slot |
| OCapN JavaScript | `parcels.js`, `ParcelDetails`, `ParcelTracker`, `makeParcel`, `openParcelDetails`, `parcelDataToDetails`, `parcelDetailsToData`, `OcapnParcelCodec` |
| OCapN wire | `ocapn-sturdyref` stays unchanged |
| Daemon | `formula-parcel.js`, `makeFormulaParcelKit`, `parcelForFormula`, `ParcelShape`, `NameOrPathOrParcelShape` |

The capdata discriminator and all type, option, callback, variable, test, fixture, changeset, and documentation names use `parcel`, `Parcel`, or `PARCEL` consistently.
The smallcaps apostrophe and compact-order `t` prefixes remain because they are encoding code points rather than English identifiers, and changing them would add wire and ordering churn with no naming benefit.

The OCapN record tag `ocapn-sturdyref` is specification-defined and stays byte-for-byte unchanged for Goblins and other implementation interoperability.
The JavaScript codec can be named `OcapnParcelCodec` while reading and writing that legacy wire tag.
Whether the OCapN specification's prose should call the value a Parcel while retaining the tag is a separate maintainer and specification-community decision.

## Layer map

| Layer | Existing PR | Parcel pivot owned by the layer |
|---|---|---|
| 1 | [#774](https://github.com/endojs/endo-but-for-bots/pull/774), contract [#1389](https://github.com/endojs/endo-but-for-bots/pull/1389) | Rename the package/global/types; change constructor to `(location, openHook)`; add `open`, privileged `locate`, `isParcel`, and `E.open`; remove handler and `enliven`; define before lockdown and let later shims adopt the visible winner. |
| 2 | [#1391](https://github.com/endojs/endo-but-for-bots/pull/1391) | Replace the universal `SturdyRef` accommodation with `%InitialParcel%` / `%SharedParcel%`, `tame-parcel-constructor.js`, the shared-prototype constructor repair, and lockdown hardening of both constructors. |
| 3 | [#1392](https://github.com/endojs/endo-but-for-bots/pull/1392) | Rename the special pre-remotable brand check, types, patterns, tests, and docs; return the literal pass style `"parcel"`; preserve no pass-invariant equality. |
| 4 | [#1393](https://github.com/endojs/endo-but-for-bots/pull/1393) | Use inline capdata `@qclass: "parcel"` plus location and Smallcaps apostrophe plus location; retain the ordered-encoding `t` code point and update Justin/rank names. |
| 5 | [#1394](https://github.com/endojs/endo-but-for-bots/pull/1394) | Rename CapTP/OCapN APIs and tests; carry Parcels inline instead of renaming `s+` / `s-`; give transport callbacks locate/open authority; retain wire tag `ocapn-sturdyref`. |
| 6 | [#1396](https://github.com/endojs/endo-but-for-bots/pull/1396) | Rename reconstruction APIs to Parcel; format validated data as a canonical location string; construct with the connection-bound open hook; use privileged locate instead of duplicate coordinate tables. |
| 7 | [#1397](https://github.com/endojs/endo-but-for-bots/pull/1397) | Rename enlivening to opening; make the open hook resolve local locators or fetch through the remote bootstrap and nonce locator; preserve secret-redacting failures. |
| 8 | [#1398](https://github.com/endojs/endo-but-for-bots/pull/1398) | Rename the formula module and kit; expose `parcelForFormula(id)` without incarnation; keep formula identifiers closely held and locations available only to the host's initial constructor. |
| 9 | [#1399](https://github.com/endojs/endo-but-for-bots/pull/1399) | Rename the Agent API design and all guards/method references to Parcel; produce, accept, and retain Parcels without giving guests identifier or locator authority. |

The pivot build updates the existing branches in this order so every downstream layer rebases on the renamed API rather than carrying compatibility aliases.
The packages are unreleased and the stack is in flight, so no deprecated SturdyRef JavaScript aliases are added.

## Related designs

The Parcel stack supersedes the JavaScript representation and naming assumed by [#511](https://github.com/endojs/endo-but-for-bots/pull/511), [#539](https://github.com/endojs/endo-but-for-bots/pull/539), [#695](https://github.com/endojs/endo-but-for-bots/pull/695), and [#697](https://github.com/endojs/endo-but-for-bots/pull/697).
Those designs remain useful records for retention, on-demand acquisition, the Agent provide/accept surface, and cross-peer handoff, respectively, and are not rewritten by this design.
Where they say a passable is an inert `'sturdyref'` record, a per-OCapN brand, or a guest-visible locator, this design is authoritative instead.

[#1404](https://github.com/endojs/endo-but-for-bots/pull/1404) is complementary rather than superseded.
Its prohibition on guest identifier and locator production/consumption is enforced by giving guests `%SharedParcel%` and keeping `locate` and formula-id conversion in the host.

[`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md) remains a historical retention design.
Its SturdyRef representation is superseded, while its retention alternatives remain input to layers 8 and 9.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Parcel shim -> SES | Install and sample one initial constructor and private table | SES decides which constructor each compartment receives | None | SES creates the shared constructor and hardens the intrinsic graph at lockdown | `%InitialParcel%`, `%SharedParcel%`, and their shared prototype |
| Parcel -> open hook | Later-turn dispatch with captured location and Parcel | Hook owner decides admission, revocation, memoization, deadlines, and cancellation | Protocol or daemon, not the shim | Hook owner decides connection reuse and reacquisition | location string and Parcel in; a promise for a live Passable out |
| Parcel -> marshal / CapTP / OCapN | Brand classification, privileged location extraction, and protocol encoding | Each protocol decides whether it recognizes the location syntax | Protocol or daemon persistence store | Protocol session owns send/drop; remote peer decides whether opening succeeds | opaque Parcel in memory; protocol-specific encoding on the wire |
| Daemon -> guest | `%SharedParcel%`, Agent guards, and retention edges | Daemon decides which formulas may be opened and retained | Daemon formula graph and store | Daemon owns collection, restart, replay, and formula incarnation | Parcel or live Passable, never a formula id or location string |

The shim owns no durable state.
The protocol or daemon that persists a location owns durable state.
The hook owner makes the open/refuse decision, while the daemon or transport owns commit, drop, and retention decisions for its own resources.
The protocol or daemon owns restart and replay.
The open hook classifies acquisition success or failure, while a receiving runtime independently decides what to do with that result.

The inner/outer naming check is satisfied.
The inner mechanism is named `open`, `Parcel`, and `location`; it does not claim outer daemon concepts such as formula retention, persistence, restart, replay, or commit.

## Test plan

Layer 1 tests the constructor validation, rejected subclassing, frozen empty instances, forged-prototype rejection, captured-once location and hook, later-turn opening, repeated non-convergent opens, hook rejection, non-Parcel rejection, synchronous privileged locate, and first-shim-wins eval twins.
The previous `E.enliven` tests become `E.open` tests.

Layer 2 tests that an absent shim remains valid, a malformed pre-lockdown global is rejected without invoking accessors, the initial constructor has `locate`, the shared constructor does not, both constructors share one prototype and brand, the prototype's constructor cannot recover `%InitialParcel%`, and lockdown hardens both constructors.
It also reverses #774's withholding test into the precise rule: child compartments receive `%SharedParcel%`, not `%InitialParcel%`.

Layers 3 and 4 test the literal `"parcel"` pass style, lack of pass-invariant equality, inline capdata and Smallcaps round trips, rank stability, and refusal to decode without an authorized Parcel maker.
Layers 5 through 7 test inline carriage, construction from canonical location data, local and remote opening, partition-and-reconnect behavior, rejection of unsupported location schemes, secret-redacting errors, and Goblins-compatible `ocapn-sturdyref` bytes.
Layers 8 and 9 test no incarnation before open, no guest access to locations or formula ids, Agent acceptance, retention and drop behavior, and repeated opens that may return distinct live references.

## Rejected alternatives

Keeping `SturdyRef` as a JavaScript alias is rejected because the stack is unreleased and dual naming would preserve the semantic diffusion the pivot is intended to remove.
Keeping a handler object is rejected because Parcel has one acquisition operation and a function expresses it directly.
Keeping `enliven` or `E.enliven` is rejected because the Parcel vocabulary is
`open`; `E.open` retains the convenience without the old metaphor.
Giving every compartment `locate` is rejected because a location is exfiltratable cryptographic authority.
Removing `locate` entirely is rejected because trusted serializers need a principled way to recover the wire representation without recreating package-private coordinate tables.
Changing the `ocapn-sturdyref` wire tag is rejected because it would break the specification and Goblins interoperability for a JavaScript naming change.

## Design decision

Parcel is the Endo language representation, while OCapN's on-wire value remains
a structured capability locator with the specification-defined
`ocapn-sturdyref` tag.
The OCapN specification need not adopt the JavaScript-facing term; a
non-normative Endo mapping may mention Parcels separately.

## Prompt

> Layer 1 (design) — the SturdyRef shim contract.
> A global `SturdyRef` shim analogous to the HandledPromise shim: each copy races to define `SturdyRef` globally; first definer wins.
> A SturdyRef is constructed after the fashion of a Proxy/HandledPromise, with a handler whose `enliven` hook defines both what the ref captures and the procedure for reviving it.
> `SturdyRef.enliven(ref)` sends an `enliven` message to the sturdyref.
> The design must reconcile #774, the withdrawn HandledPromise-enliven vision, #774's “withheld from child compartments” property versus layer 2, and sketch layers 3–5.

> Revision, 2026-10-14: rename SturdyRef to Parcel across the nine-layer stack and reconcile the contract with the maintainer's “Passing Parcels” essay, including its authority split, preserved semantics, naming consequences, prior-art framing, and open questions.
