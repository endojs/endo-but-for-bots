# Parcels in the Agent API (Layer 9)

| | |
|---|---|
| **Created** | 2026-09-30 |
| **Updated** | 2026-10-16 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Summary

This is layer 9 of the Parcel stack requested by kriskowal on [#695](https://github.com/endojs/endo-but-for-bots/pull/695#issuecomment-5903472512).
The historical filename remains in place so the existing draft PR and review links stay stable.
The canonical primitive and cross-layer map are in [`parcel.md`](parcel.md)
([#1460](https://github.com/endojs/endo-but-for-bots/pull/1460)).
Carriage and opening across vat boundaries follow
[`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md), the Slot Machine
design that #1460 transformed.
This document owns the Agent API and the daemon/worker boundary at layer 9.

Layers 1 through 8 provide the substrate.

- `@endo/parcel` installs a first-wins `Parcel` before lockdown.
- SES gives the start compartment `%InitialParcel%` with `locate` and child compartments `%SharedParcel%` without it.
- Pass style recognizes the literal `"parcel"` style, and marshal, CapTP, and OCapN carry it.
- The daemon's `parcelForFormula(id)` makes a Parcel for a formula without incarnating it.

This layer changes the daemon's `EndoHost` and `EndoGuest` Agent APIs in three ways.

1. **Produce.**
   A formula-creating method can return a Parcel instead of immediately incarnating the formula.
2. **Accept.**
   An argument that names an existing formula by pet name or path can also accept an appropriate Parcel.
3. **Open and retain.**
   A worker opens a Parcel by ordinary delivery to a closely held communications capability.
   Possessing a Parcel retains nothing; only the opened result participates in live retention.

This document replaces the representation and naming assumed by [#695](https://github.com/endojs/endo-but-for-bots/pull/695), but preserves its provide/accept intent.
It also composes with [#1404](https://github.com/endojs/endo-but-for-bots/pull/1404): guests neither produce nor consume formula identifiers or location strings.

## What is the problem being solved?

Today a formula-creating Agent method either gives the formula a pet name and returns an incarnated value, or creates an unnamed formula that is transiently pinned while returning an incarnated value.
Neither outcome lets a caller hold a formula durably without a pet name and without paying the cost or authority effects of incarnation.

A Parcel closes that gap.
It is an opaque dormant capability that can be passed and retained, and `Parcel.open(parcel)` incarnates or reacquires the target only on demand.
The guest can hold, forward, and open the Parcel but cannot read its location because it sees `%SharedParcel%`, not `%InitialParcel%`.

## Design

### Produce: unnamed formula creation returns a Parcel

The recommended rule is that a formula-creating method called without a pet name returns `parcelForFormula(id)` instead of an incarnated value.
A call with a pet name keeps its current behavior: it names the formula and returns the incarnated value.

This rule changes nothing for CLI paths and other callers that already supply names.
It gives an unnamed formula a concrete retention answer: the Parcel is the dormant handle that keeps it reachable.
It also limits lazy incarnation to callers that deliberately omit a durable name.

The in-scope `EndoHost` and `EndoGuest` groups are the same groups identified by the original layer-9 design.

| Group | Methods |
|---|---|
| Evaluation | `evaluate`, `makeUnconfined`, `makeArchive`, `makeFromTree`, `makeUnconfinedFromTree` |
| Agents and workers | `provideWorker`, `provideGuest`, `provideHost` |
| Storage | `storeValue`, `storeBlob`, `storeTree` |
| Mounts and adapters | `provideMount`, `provideScratchMount`, `provideSubMount`, `provideGit`, `provideGitRemote`, `provideGitClone`, `provideShell`, `provideHttpClient`, `provideHostPath` |
| Miscellaneous | `makeChannel`, `makeTimer`, and credential providers |

Where a method's pet-name argument is required today, the build makes it optional with `M.or(NameOrPathShape, M.undefined())`.
A `provide*` call remains idempotent when named and creates a new formula when unnamed.
Each affected doc comment must state that distinction.

The daemon returns a Parcel over the worker connection using layer 4's inline
representation and transport-owned encode/decode callbacks, as described in
§ Carriage and opening below.
Opening it delivers to the daemon's communications capability, which resolves
the export to its formula and calls `provide(id)`.
Guest code never receives the formula identifier or location string.

Repeated calls to `Parcel.open` need not converge.
The daemon may return the same live presence, a new presence or attenuated facet, or a rejection according to current formula and connection policy.
No Agent API may treat Parcel object identity or location equality as a grant-matching predicate.

### Accept: a Parcel where an existing formula is named

Every argument position that resolves a pet name or path to an existing formula identifier also accepts a Parcel.
Positions that create a new pet name do not.

The guard shape is `NameOrPathOrParcelShape = M.or(NameOrPathShape, ParcelShape)`.
`ParcelShape` matches `passStyleOf(value) === 'parcel'`.
The camel-case `'sturdyRef'` and lower-case `'sturdyref'` spellings are not compatibility aliases.

For a Parcel minted by the daemon's own formula kit, the resolver uses the closely held `formulaIdOf(parcel)` association.
That association does not inspect the Parcel's location and is never exposed to a guest.

A Parcel the local daemon did not mint has no local formula identifier.
It is accepted only where the method already accepts an arbitrary live or passable value, such as `storeValue`, `endow`, or `sendValue`.
Every existing-formula position rejects it with an argument-specific error rather than opening it silently.

Holding a Parcel is authority to request opening it, but the Parcel is not evidence that it matches a local grant.
The daemon's private `formulaIdOf` association is the provenance check for the local fast path.

### Location authority stays outside the Agent API

The start compartment's `%InitialParcel%.locate(parcel)` is a host-bootstrap capability.
The child compartment's `%SharedParcel%` has no `locate` static, and neither `EndoHost` nor `EndoGuest` grows an identify, locate, decompose, or to-location operation for Parcels.

The daemon may use privileged `Parcel.locate` internally when it must persist or serialize a protocol location.
It must never return that string through an Agent method, diagnostic, transcript, rendered value, or error.
This resolves the previous layer-9 question about accepting a Parcel in directory `identify` or `locate`: the answer is no.

This boundary is consistent with [#1404](https://github.com/endojs/endo-but-for-bots/pull/1404).
A guest can produce and consume Parcels as opaque capabilities, but cannot produce or consume the identifiers and locators the daemon uses to implement them.

### Carriage and opening: the Slot Machine shape

The daemon/worker connection is a CapTP variant, and layer 9 adopts the
transport shape that [`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md)
specifies for Slot Machine.
There is no Parcel-specific syscall, envelope verb, or descriptor kind.

- **Inline carriage.**
  A Parcel crosses the connection inline in the Smallcaps body.
  It allocates no c-list entry, so sending, storing, or forwarding it creates no
  live reference and no import to drop.
- **Export-table locations.**
  A formula Parcel's daemon-internal location is its formula identifier, which
  must not leave the daemon.
  When the daemon-side endpoint encodes such a Parcel for a worker, it obtains
  the formula through the closely held `formulaIdOf` association, finds or mints
  an entry in a persistent export table keyed by
  `(peer key, swiss number)`, and writes the location of that entry.
  The location names the communications service and the swiss number, not the
  formula and not the worker.
- **Key topology.**
  By default the daemon owns one host peer key, or one key per deliberately
  isolated guest shard so that one guest's exports are not linkable to another
  guest's peer key.
  Per-worker key pairs are optional policy for workers that need their own
  identity, revocation, or migration domain.
- **Endpoint authority.**
  Each worker's endpoint codec keeps `%InitialParcel%` from its bootstrap and
  gives guest code only `%SharedParcel%`.
  On decode it builds `new Parcel(location, open)` with an endpoint-owned hook.
- **Opening by ordinary delivery.**
  The hook closes over a communications capability that the worker receives
  during bootstrap and does not pass to guest code:

  ```js
  const open = location => E(comms).openParcel(location);
  ```

  `Parcel.open(parcel)` therefore becomes an ordinary delivery whose result
  comes back as an ordinary reply promise.
  The communications service looks up the export.
  For a local formula it calls `provide(formulaId)`.
  For an export held by another local worker it translates the export to that
  worker's reference.
  For a remote peer it fetches through OCapN, which writes the unchanged
  `ocapn-sturdyref` wire record only at that boundary.

Parcels decoded in the daemon from a worker are rebuilt with the daemon's own
hook, so the worker's hook never crosses.
The daemon recovers a formula from such a Parcel only by looking up its location
in its own export table, so the Accept rules above apply unchanged: an export the
daemon minted resolves to its formula, and any other location is a foreign
Parcel.

### Lifetime, retention, and revocation

Possessing a Parcel does not retain an incarnation.
This replaces the earlier proposal that a worker-held Parcel keep its target
reachable through `formulaGraph.addRetention` until the worker dropped the
import or terminated.
The `d+` / `d-` slot with `CTP_DROP`, the Parcel-specific `retain` / `release`
syscalls, and `ephemeral:` or `retained:` graph edges for Parcel possession are
all rejected.

| State | Retains an incarnation? | Keeps the formula? | Revocation surface |
|---|---:|---:|---|
| Parcel held, stored, or forwarded by a worker | no | through its export-table entry | the export entry |
| `openParcel` in flight | only the protocol work for the request | yes | request or session cancellation |
| Opened presence or promise retained | yes, under existing live-reference rules | yes | the worker or session that holds it |

- **Dormant exports.**
  The export-table entry is the durable root that keeps an unnamed formula
  available to be opened later.
  It is attributed to the agent whose call produced it, so retention paths can
  show it, but it is reported as a dormant export and not as a live
  incarnation root.
  Revoking the entry makes later opens reject and lets the formula graph collect
  the formula if nothing else holds it.
- **Live retention.**
  The opened result is an ordinary reference.
  The daemon's existing per-agent `formulaGraph.addRetention` /
  `removeRetention` edges, CapTP `drop`, and worker termination apply to it
  exactly as they apply to any other value the worker acquired.
- **Duplicates and restart.**
  Copies of a Parcel are indistinguishable dormant data and need no reference
  counting.
  The export table persists across daemon and worker restart, so a stored Parcel
  remains openable while its entry exists.
  Repeated opens may return different presences.

## Relationship to earlier designs

| Earlier design | Parcel disposition |
|---|---|
| [#511](https://github.com/endojs/endo-but-for-bots/pull/511) | Its FinalizationRegistry retention analysis remains prior art; its inert `'sturdyref'` representation is superseded. |
| [#539](https://github.com/endojs/endo-but-for-bots/pull/539) | On-demand acquisition survives as `Parcel.open`; a closely held OCapN enlivener is no longer the public spelling. |
| [#695](https://github.com/endojs/endo-but-for-bots/pull/695) | The provide and accept goals survive; the pass style, escrow representation, and locator-facing names are replaced, and possession-based retention is dropped. |
| [#697](https://github.com/endojs/endo-but-for-bots/pull/697) | Cross-peer carriage and handoff remain inputs; JavaScript names become Parcel while the OCapN tag stays `ocapn-sturdyref`. |
| [`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md) | Controlling for transport: inline carriage, opening through a communications capability, host or guest-shard keys with a persistent export table, and no `retain` / `release` syscalls. |
| [#1404](https://github.com/endojs/endo-but-for-bots/pull/1404) | Complementary and controlling at the guest seam: Parcels cross it, identifiers and locations do not. |
The model-facing Lal, Fae, and `@endo/agent-tools` render-map and handle-grammar work remains a consumer follow-up.
It must render an opaque Parcel without exposing a location.

## Build plan

The implementation remains one draft PR stacked on this design, with the existing five-part shape renamed and adjusted for Parcel.
This sequence is planning, not authorization to implement an open choice.
The pivot builder may proceed through layers 1–8 but must not start a layer-9
slice whose corresponding question below remains open.

1. **Memoize Parcels per formula.**
   `makeFormulaParcelKit` returns one live Parcel per id with a weak memo table and tests same-id reuse and reminting after collection.
2. **Accept.**
   Add `ParcelShape` and `NameOrPathOrParcelShape`, switch existing-formula positions, and resolve locally minted Parcels through `formulaIdOf`.
3. **Produce.**
   Make the applicable pet-name arguments optional and return `parcelForFormula(id)` when omitted, with a test proving no incarnation before open.
4. **Export table and opening.**
   Add the persistent `(peer key, swiss number)` export table under a host key,
   the worker endpoint codec, and the bootstrap communications capability with
   `openParcel`.
   Encode formula Parcels for workers through the table and route opens through
   ordinary delivery.
5. **Document.**
   Update daemon README and type docs, and add an `@endo/daemon` changeset using Parcel names only.

Tests cover:

- a Parcel crossing the worker connection with no c-list entry;
- a worker holding a Parcel without incarnating its formula;
- opening that Parcel through `openParcel` with an ordinary reply promise;
- an opened reference retained, then released by `drop` and by worker termination;
- a revoked export rejecting later opens and allowing collection;
- the export table surviving daemon restart;
- foreign Parcel rejection at existing-formula positions;
- no guest path to a formula identifier, export location, or the communications capability.

## Naming map for this layer

| Previous name | Parcel name |
|---|---|
| `formula-sturdyref.js` | `formula-parcel.js` |
| `makeFormulaSturdyRefKit` | `makeFormulaParcelKit` |
| `sturdyRefForFormula` | `parcelForFormula` |
| `SturdyRefShape` | `ParcelShape` |
| `NameOrPathOrSturdyRefShape` | `NameOrPathOrParcelShape` |
| `sturdyRef` variables and fields | `parcel` |
| pass style `'sturdyRef'` | pass style `'parcel'` |
| CapTP `s+` / `s-` | no renamed slot for ordinary inline Parcel carriage |
| `retain` / `release` syscalls | none; opening is a delivery to the communications capability |

No daemon alias retains a SturdyRef JavaScript name.
The only surviving sturdyref spelling in the implementation stack is the OCapN wire tag `ocapn-sturdyref` and references to that specification term.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| formula kit -> Agent facet | `parcelForFormula` and private `formulaIdOf` | Agent method decides when to return or accept a Parcel | Formula store and graph belong to daemon | Daemon owns incarnation, cancellation, collection, and commit | Parcel outward; local formula id only inward through private association |
| daemon -> worker connection | Inline Parcel encoding; daemon endpoint locates through the export table, worker endpoint decodes with its own hook | Daemon decides which formulas to export and under which peer key | Export table keyed by `(peer key, swiss number)` | Daemon owns minting, revocation, and restart of exports; carriage implies no retention | Opaque Parcel to guest code; export location only to the worker endpoint codec |
| worker endpoint -> communications capability | `E(comms).openParcel(location)` as an ordinary delivery | Communications service resolves the export and applies admission policy | Export table | Opened result follows ordinary live-reference retention, `drop`, and termination | Location in; promise for live Passable out |
| guest -> shared Parcel constructor | `%SharedParcel%.open` and brand check | Guest chooses whether to open; daemon hook decides whether to honor | None in the guest | Daemon owns restart and formula lifecycle | Parcel in; promise for live Passable out |
| daemon -> `%InitialParcel%` | Privileged `locate` for persistence and protocol serialization | Host bootstrap decides which code receives location authority | Protocol-specific location persistence | Daemon and protocol own replay and reconnection | Location string remains inside trusted host boundary |

The daemon owns all durable formula state, export entries, and retention edges.
The daemon owns the decision to keep or collect a formula, while the guest controls only whether it opens a Parcel and keeps the opened result.
The daemon owns restart and replay.
The open hook classifies acquisition success or failure, and the Agent caller decides how to react to the result.

The inner/outer naming check is satisfied.
The transport mechanism uses Parcel and inline-encoding vocabulary, while
formula retention, collection, incarnation, restart, and replay remain
daemon-layer names.

## Security considerations

Returning a Parcel instead of a live value grants no immediate operation beyond the holder's ability to request opening.
Accepting a Parcel requires the caller already to hold it.

The formula id and location remain closely held.
A guest sees an opaque Parcel and `%SharedParcel%`, and errors must not contain either secret.

`Parcel.isParcel` is not a provenance check.
Only `formulaIdOf` establishes that the local daemon minted a Parcel for a local formula, and a foreign Parcel is never silently opened to discover what it is.

A Parcel cannot match a grant.
Object identity is local and non-invariant, location strings are unavailable to the guest, and the daemon does not infer grant identity from either.

The worker endpoint codec sees export locations because it is the transport's
trusted boundary; it receives them only for exports the daemon chose to give
that worker, and it never sees formula identifiers.
Guest code receives neither `%InitialParcel%` nor the communications capability.

Opening a canceled, collected, or revoked formula rejects and does not resurrect it.
Repeated opens may return different live references and must not be used as an equality oracle.

## Open questions

1. **Produce rule.**
   Should the build take the recommended “unnamed returns a Parcel; named behaves as today” rule, make every formula-creating method return a Parcel, or add an options bag such as `{ parcel: true }`?
2. **Named calls that also want a Parcel.**
   Should a named call optionally return a Parcel, or is naming followed by passing the name sufficient?
3. **Tool-layer consumer.**
   Should the Lal, Fae, and `@endo/agent-tools` rendering, handle grammar, and escrow behavior be a separate follow-up design, or join the layer-9 build?
4. **Export lifetime.**
   An unnamed formula now lives as long as its export entry.
   Which command revokes a dormant export, should removing the producing agent
   revoke its exports, and how does revocation report opened references that
   survive it?
   This question is shared with the Slot Machine design's open questions on key
   rotation and revocation.

The worker-retention question is resolved by adopting the Slot Machine design:
possession is dormant, the export table is the durable root, and only opened
results participate in live retention.
The previous question about an Agent `identify` or `locate` operation is resolved negatively by the `%InitialParcel%` / `%SharedParcel%` authority split and [#1404](https://github.com/endojs/endo-but-for-bots/pull/1404).

## Stack index

1. [#774](https://github.com/endojs/endo-but-for-bots/pull/774), contract [#1389](https://github.com/endojs/endo-but-for-bots/pull/1389): `@endo/parcel`, `new Parcel(location, openHook)`, `open`, privileged `locate`, and `isParcel`.
2. [#1391](https://github.com/endojs/endo-but-for-bots/pull/1391): `%InitialParcel%` / `%SharedParcel%` SES split and lockdown hardening.
3. [#1392](https://github.com/endojs/endo-but-for-bots/pull/1392): literal `"parcel"` pass style and `M.parcel()`.
4. [#1393](https://github.com/endojs/endo-but-for-bots/pull/1393): Parcel marshal discriminators and encoding callbacks.
5. [#1394](https://github.com/endojs/endo-but-for-bots/pull/1394): inline Parcel carriage with transport-owned authority and OCapN's unchanged `ocapn-sturdyref` wire tag.
6. [#1396](https://github.com/endojs/endo-but-for-bots/pull/1396): construct a Parcel from canonical location data.
7. [#1397](https://github.com/endojs/endo-but-for-bots/pull/1397): open through the bootstrap and nonce locator.
8. [#1398](https://github.com/endojs/endo-but-for-bots/pull/1398): `parcelForFormula(id)` without incarnation.
9. **This design:** Agent APIs produce and accept Parcels, and workers open them through a communications capability, without exposing identifiers or locations.

## Prompt

> Revisit the daemon Agent API after the SturdyRef substrate lands: produce a durable reference for a formula without incarnation, accept it where an existing formula is named, and specify retention for references held by a worker.

> Revision, 2026-10-14: pivot the complete stack from SturdyRef to Parcel, follow the maintainer's “Passing Parcels” essay, preserve the OCapN `ocapn-sturdyref` wire tag, and keep guest identifier and locator authority out of the Agent API.

> Revision, 2026-10-16: apply the accepted Parcel design (#1460), including its transformed Slot Machine design: Parcels pass inline, open by ordinary delivery to a closely held communications vat, and only the opened result participates in live retention; use a host or guest-shard peer key with a persistent export table, and do not add Parcel-specific `retain` / `release` syscalls.
