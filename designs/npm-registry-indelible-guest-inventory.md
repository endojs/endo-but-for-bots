# Indelible npm registry in every guest inventory

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Summary

Package resolution inside a guest must always begin from one known inventory
name, without a provisioning grant and without the guest being able to take that
name away.
This design gives every guest the package-registry directory tree from
[npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) under the
special name `@registry`, present when the guest is first formulated, surviving
daemon reincarnation, and impossible for the guest to remove, rename, rebind, or
shadow.

The mechanism is a dedicated indelible slot: `GuestFormula` gains a required
`registry` formula identifier, and guest construction projects that identifier
through the existing special-name overlay as `@registry`.
The formula field supplies persistence and reachability; the special-name
grammar supplies immutability.
An ordinary pet-store entry, a caller-supplied provisioning option, or a
process-global lookup would provide only part of this guarantee and is not used.

The mandatory capability is a credential-free public-read view.
It has the directory tree's `has`, `lookup`, `list`, and `getInfo` surfaces at
the nodes where the directory-tree design permits them, but no publish,
configuration, credential, raw-network, or content-store administration surface.
The Node-hosted Endo daemon projects this name today; Rust-hosted Endor matches
the underlying tree contract now and the inventory projection once it grows an
agent and guest model.

## What is the Problem Being Solved?

The directory-tree registry design settles the capability shape but places its
root only at the host's `@registry` special name.
Guests do not receive it by construction.
A host can copy that capability into a guest's ordinary pet store, but the guest
can then remove or rename the entry, and every caller must branch on whether the
grant happened.
That is weaker than the requested platform invariant: package resolution inside
a guest must always begin from one known inventory name.

The daemon already has two pieces of the required mechanism.
`makePetSitter` overlays daemon-owned special names such as `@self`, `@host`,
`@nets`, and `@planes` over the otherwise mutable pet store.
Separately, `GuestFormula` records required formula identifiers so construction,
reincarnation, garbage collection, and inspection agree about a guest's durable
dependencies.
The registry needs both properties together.

## Goals

1. `E(guest).lookup('@registry')` succeeds for every newly formulated or
   migrated guest without a provisioning grant.
2. The guest cannot remove, rename, replace, copy over, or shadow `@registry`,
   while ordinary inventory names remain mutable.
3. The capability grants public registry reads and immutable package-tree reads,
   never publish authority or registry credentials.
4. Node and Endor present an identical *tree contract* at the registry root.
   The inventory projection of `@registry` is required of the Node daemon now,
   and of Endor once it grows an agent and guest model; until then Endor's tree
   adapter satisfies the tree-only conformance suite and the inventory projection
   is a Node-only surface (see the parity section).
5. After an upgrade, existing guests acquire the slot before they are exposed.

## Non-goals

- Changing the tree shape, resolver, MVS (Minimum Version Selection) algorithm,
  CAS (content-addressed store) layout, registry error family, or
  read-consistency rules defined by
  [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md).
- Giving every guest access to private packages or authenticated registry reads.
- Giving a guest a `PublishGrant`, `PublishGrantIssuer`, npm bearer token, or
  npmjs.com credential from
  [npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md).
- Letting a guest choose, replace, or remove its mandatory registry root.
- Building an agent or guest model in Endor. This design scopes Endor to tree
  parity and defers the inventory projection to that later work.
- Implementing this design. A build follows design acceptance.

## Placement and name

The inventory name is the daemon-owned special name `@registry`, matching the
host spelling and avoiding a second concept for the same tree.
It is a special name, not a `PetName`, despite living in the inventory that is
often called the pet store.
Inventory names are path-structured: a name is a sequence of segments, and
resolution walks from a root segment down to a leaf, so `@registry` is a root
segment that a nested ordinary segment cannot shadow.
A concrete resolution: `E(guest).lookup('@registry')` yields the registry root
directory, `lookup(['@registry', 'npm', 'ses', '1.2.3'])` yields that exact
version's immutable content tree, and a further path names a file inside it.

Each guest formula carries the root directly:

```ts
type GuestFormula = {
  type: 'guest';
  // existing required fields
  registry: FormulaIdentifier;
};
```

Guest formulation obtains the daemon's mandatory guest registry root (the
distinct guest-safe public view defined under Authority and attenuation) and
writes its identifier into the formula as part of the same formulation
operation.
The dependency is pinned until the guest formula has been persisted and entered
in the formula graph, following the existing rule that a formula is written to
disk before it is added to the graph.
On construction and reincarnation, the guest maker adds
`'@registry': formula.registry` to the `specialNames` record passed to
`makePetSitter`.

The root is a direct guest dependency.
Lookup does not traverse `@host`, and the guest does not depend on the host
retaining an ordinary name for the registry.
All guests may point to the same stable root formula when they share
one public registry policy.
A daemon that needs guest-specific accounting may formulate attenuating roots
with the same tree interfaces, but the slot remains required and the guest
cannot select a wider root.

The floor contract at the required slot is fixed regardless of which root an
operator seats there, so a caller never branches on coverage: `@registry` always
resolves to an enumerable registry root whose `list()` may return an empty set,
and a miss (a package or version the seated root does not carry) raises the
directory-tree design's registry error family rather than a missing-name error.
An operator may seat a narrower view, including a deny-all root that lists
nothing, but the name and its resolution behavior are always present.

## Indelibility

This design picks a **dedicated indelible slot**, implemented by the combination
of a required formula field and a reserved special name.
The candidates compare as follows:

| Candidate | Presence after restart and GC reachability | Mutation resistance | Disposition |
|---|---|---|---|
| Ordinary pet-store injection at formulation | Pet-store persistence only. | None; the guest can remove, rename, or overwrite it. | Rejected. |
| A well-known process-global resolver for every guest | Not represented as a guest dependency. | Bypasses inventory mutation but becomes hidden ambient state. | Rejected. |
| A reserved `@registry` spelling without a formula slot | The live overlay can resolve it, but the guest formula does not retain or inspect it. | The name is protected while live. | Rejected. |
| A single preformulated root projected as a special name (the shipped `leastAuthority`/`@none` pattern) | Durable and GC-reachable as a daemon formula-graph root. | Protected while projected, but one shared value with no per-guest field. | Partial; sufficient for a purely shared root, but see below. |
| Required `GuestFormula.registry` projected as `@registry` | Explicit, durable, and visible to reachability and inspection. | Protected by every special-name write boundary. | Selected. |

The daemon already ships the fourth pattern: `leastAuthority` is preformulated
once, made a formula-graph root, and projected as `@none` in every agent's
special names, durable and GC-reachable with no per-guest field and no migration.
That pattern alone would carry a purely shared registry root.
This design still adds the per-guest `registry` field for two reasons the shared
pattern cannot express: an operator may seat a *different* attenuating root per
guest (see Placement and name), and per-guest inspection and reachability should
report each guest's actual root as its own dependency.

Enforcement rests on a single chokepoint rather than an enumerated call list.
Inventory reads accept a `Name`, which includes special names, but inventory
writes require a `PetName` at the destination leaf, and every write funnels
through `petNamePathFrom` / `assertPetNamePath`, which reject `@registry` because
its `@` spelling is not a valid `PetName`.
The following list is therefore illustrative, not exhaustive: `storeIdentifier`,
`storeLocator`, `remove`, both sides of `move` or `rename`, and the destination
of `copy` all reject `@registry`, and any future guest method that names a value
inherits the same rejection by going through the same boundary.
The special-name overlay resolves its own record before the underlying mutable
controller, so an invalid or legacy backing-store entry cannot shadow the
formula-baked binding.
Nested ordinary names do not shadow a root name, and no
`introducedSpecialNames` entry (the `@intro-` sub-namespace defined below) may
claim the daemon-owned bare spelling.

This protection is narrow.
Other inventory entries remain ordinary mutable pet names, and the guest may
still store another registry-like capability under another valid name.
The guest cannot make that capability replace what `lookup('@registry')` means.

## Authority and attenuation

Indelibility does not turn a read capability into a write capability, but a
read-only registry is still authority: lookup can contact a configured registry
origin, observe current public metadata, populate the daemon cache, and consume
network, CPU, and disk resources.
The mandatory root is therefore a distinct **guest-safe public view**, with all
of these constraints:

- it exposes only the directory-tree interfaces and the exact path layout from
  [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md);
- its backend may contact only operator-configured registry origins and accepts
  no URL, header, token, `.npmrc`, or transport object from the guest;
- it performs no authenticated reads and carries no private-registry credential;
- version leaves are immutable CAS readable trees, and cache population is an
  internal effect that yields no CAS writer or eviction authority;
- daemon-owned cancellation, size, concurrency, and resource limits remain
  outside the guest capability and cannot be relaxed through tree calls.

The first configured child is `npm`, backed by unauthenticated public reads.
A daemon may add another child to the mandatory root only if that child satisfies
the same guest-safe rule.
A private or credentialed registry tree is an additional, explicitly granted
capability under another name; it is never silently added to every guest's
`@registry` root.

If a deployment supplies a narrower package or scope view, that view may occupy
another name.
By operator policy at formulation, it may instead occupy the required slot, but a
guest can never request a wider view.

Guest `@registry` and host `@registry` carry the *identical* node interfaces:
the guest root is a strict attenuation of the host tree, presenting the same
method surfaces so that library code written against either resolves and fails
the same way.
Any credentialed or administrative registry view is not a wider `@registry`; it
occupies a different name, so the same spelling never resolves to two different
interfaces.

This is deliberate baseline authority, not an unforgeable global discovered
behind a string.
The reference is visible in the guest's inventory, follows ordinary capability
passing rules, and is limited to a fixed public-read protocol.
Code that receives only some other capability does not gain registry access
unless it also has the guest inventory powers or receives the registry reference.

The write side stays disjoint.
The [npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md) design
defines `PublishGrant` and its bearer-token realization as separate, attenuated
capabilities.
Neither that grant nor its issuer is reachable from the registry tree, and a
tree node has no method that accepts or derives one.
Possession of indelible `@registry` therefore cannot be escalated into publishing,
tag mutation, credential recovery, or grant issuance.

The in-flight
[`introducedSpecialNames` design](https://github.com/endojs/endo-but-for-bots/pull/1102)
is complementary, not the placement mechanism here.
It lets a provisioner persist optional caller-selected capabilities under the
reserved `@intro-` sub-namespace.
The mandatory registry instead occupies the daemon-owned bare name `@registry`
and a dedicated required field, so it does not depend on that option landing and
cannot be omitted by a provisioner.
If both designs land, their formula dependency enumeration may share helpers,
but an `@intro-registry` binding neither collides with nor shadows `@registry`.

## Node and Endor parity

Node and Endor already share the registry *tree contract*: both implement the
directory-tree design's adapters and pass its cross-backend, tree-only
conformance suite. This design does not change that layer.

The inventory projection is different.
Node's daemon has agents, guests, formulas, and special names, so it can carry
the required guest-formula field and project `@registry` through the inventory.
Endor today has no agent, guest, formula-graph, or special-name model: its Rust
sources are the npm resolver and assembler, with no pet store or inventory to
project a name into.
The parity requirement is therefore staged:

1. **Now (both backends):** the registry root behind `@registry` conforms to the
   shared tree contract, so a resolved root, its `/npm` hub, package and version
   directories, and immutable leaves behave identically on either backend.
2. **Now (Node only):** guest formulation records a registry-root identifier
   before exposing the guest; guest construction presents that identifier as
   `@registry` through the inventory interface; the persisted guest record
   retains the root across restart and garbage collection; and no guest method or
   backend escape exposes Node fetch powers, SQLite, registry-table mutation, CAS
   mutation, or credentials.
3. **Deferred (Endor):** the equivalent inventory projection lands when Endor
   grows an agent and guest model. Until then, a Node-only inventory projection is
   *complete* for this design; it is not blocked on Endor building an agent model.

The existing cross-backend registry-tree conformance suite is extended with an
inventory fixture that runs on the Node backend rather than by creating a second
Endor-specific protocol.
The fixture formulates guests, then compares the `@registry` name, method guards,
path results, ordering, content identity, and documented failure shapes against
the tree contract both backends already satisfy.

## Persistence, reachability, and inspection

`GuestFormula.registry` is a strong formula dependency, and this design takes
**garbage-collection reachability**, not cancellation propagation, as its
lifecycle mechanism.
The `guest` case of `extractLabeledDeps` emits the registry identifier so the
formula graph keeps the root reachable while the guest exists; the root is not
wired through `thisDiesIfThatDies`, so a shared root is never cancelled by any one
guest's cancellation.
The parallel normalized formula record used by `getFormula` and inspection also
reports the field.
Any equivalent Rust dependency and inspection table does the same once Endor
carries the field.

Because the root is kept reachable rather than cancelling the guest, it does not
disappear underneath a live guest.
If a root nonetheless fails to formulate at construction, construction fails
closed (the guest is not exposed without the slot).
A backend fault reached through an already-live root surfaces as the
directory-tree design's documented registry failure family
(`RegistryOfflineError` and its siblings) at the offending call, never as a
missing `@registry` inventory name.

## Migration and compatibility

Existing persisted guest formulas do not have a `registry` field.
Both daemons run an idempotent upgrade before exposing guests:

1. formulate or locate the daemon's guest-safe public registry root;
2. find each local `GuestFormula` without `registry`;
3. write that root identifier into the formula and update the formula dependency
   graph transactionally; and
4. only then permit the guest to reincarnate or appear in the agent map.

This is a novel formula-rewriting pass, not a copy of an existing one.
The sibling [registry-capability](registry-capability.md) design specified a
required-field migration for `HostFormula.registry`, but the shipped daemon chose
the opposite policy and fails fast when a host formula lacks `registry`
(`manager.js` throws `Host formula missing registry (@registry required)`); there
is no migration runner in the codebase today.
Phase 2 therefore builds the daemon's first formula-rewriting upgrade:
enumerate persisted guest formulas, rewrite each in place, and update the graph
transactionally.
It fills only an absent field, preserves an existing field, and makes a second
start a no-op.
An upgrade failure is fatal for exposure of the affected guest; it never leaves a
guest without the invariant.

An existing ordinary pet name such as `registry` remains untouched and mutable.
After migration it coexists with the special `@registry` name.
The pet-store grammar has never admitted `@registry` as an ordinary entry, so
there is no valid persisted ordinary binding to overwrite.

The [registry-capability](registry-capability.md) design is deprecated because
its bespoke `EndoRegistry` method API was superseded, not because the host
special-name transport must vanish.
The directory-tree design reincarnates the host's existing `@registry` formula
identifier as the new root tree and keeps a separately obtained deprecated
method-call adapter for old callers.
This design gives guests only the new tree shape.
It does not install the deprecated adapter in a guest inventory and does not
forward guest lookup through the host special name.
Host and guest `@registry` may point to the same guest-safe root by default, but
a host-only credentialed or administrative registry view must remain distinct
from the mandatory guest slot, under a different name.

## Implementation phases and tests

1. **Formula and construction.** Add the required guest field, thread the
   guest-safe root through formulation, project `@registry` in the special-name
   record, update dependency and inspection tables in the Node daemon, and update
   the discoverability surfaces where a user learns the name (the guest
   help-text special-name list in `help-text-data.js`, currently stale for
   `@nets` / `@planes` / `@mail`).
2. **Migration.** Add the pre-exposure, idempotent formula-rewriting upgrade for
   existing guest formulas and a restart fixture that begins from the old record
   shape.
3. **Parity and security.** Extend the cross-backend conformance suite with the
   Node inventory fixture and add negative authority tests.

The tests cover:

- fresh guests list and resolve `@registry` without any provisioning option;
- the resolved root and exact package-version leaf retain identity across daemon
  restart;
- `storeIdentifier`, `storeLocator`, `remove`, `rename`, `move`, and `copy`
  cannot use `@registry` as a mutable leaf, and a single asserted catalog item
  confirms rejection across *every* guest method that names a value, while the
  same operations still work for an ordinary control name;
- the special overlay wins over a deliberately malformed backing-store fixture,
  proving the root cannot be shadowed;
- the registry formula remains reachable while only the guest formula names it,
  and inspection reports the dependency;
- migration fills a missing field once, preserves an existing field, and never
  exposes an unmigrated guest;
- a credential-capturing registry stub observes no authorization material on a
  guest lookup, and a private-only package is reported as absent through the
  mandatory root, indistinguishable from an unpublished package (the deliberate
  confidentiality choice recorded under Design Decisions);
- reflection and method-guard tests find no publish, grant, credential,
  configuration, raw HTTP, registry-table mutation, or CAS-write method; and
- Node returns the tree contract's names, path objects, ordering, content
  identity, and failures for the shared fixture.

## Design Decisions

1. **Use `@registry`, not `registry` or `@intro-registry`.** The host already
   establishes the concept under `@registry`; the `@` grammar gives the guest an
   indelible name, while `@intro-` is reserved for optional provisioner-supplied
   endowments.
2. **Use a dedicated required field, not the generic provisioning options bag.**
   Every guest must have the slot even when the provisioner supplies no options,
   and formula reachability must not depend on re-running provisioning.
3. **Grant only credential-free public reads.** A capability can be read-only
   and still reveal private data or consume backend resources. The mandatory
   view therefore excludes credentials, caller-selected transport, and resource
   policy controls.
4. **Keep publishing as a separate capability family.** Adding publish methods
   to a directory tree would make an indelible baseline reference carry mutable
   external authority and would defeat attenuation.
5. **Migrate before exposure.** A lazy fallback would make the formula record,
   reachability graph, and live inventory disagree during upgrade.
6. **A withheld package is indistinguishable from an absent one.** When an
   operator seats a narrower root, a package outside its scope surfaces as the
   directory-tree design's missing-package error, the same shape an unpublished
   package produces. This is a deliberate confidentiality choice: it does not let
   a guest enumerate what a narrower root withholds.

## Dependencies

| Design | Relationship |
|---|---|
| [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) | Defines the exact capability placed at `@registry`, including Node and Endor adapters. **Blocking:** it is Not Started, and today's `@registry` is still the deprecated `makeEndoRegistry` exo, so phases 1-2 cannot begin until the tree and its conformance suite ship. |
| [registry-capability](registry-capability.md) | Supplies the host special-name transport and the *design-only* required-field migration precedent; the shipped daemon fails fast instead, so Phase 2 is novel work. Its bespoke method API remains deprecated. |
| [npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md) | Defines the separate write authority that must never be reachable from the mandatory tree. |

## Prompt

> On 2026-09-04, kriskowal requested a follow-up to the merged package-registry
> directory-tree design: make the npm registry capability an indelible member of
> every guest inventory, present by construction and impossible for the guest to
> delete or rename away.
