# Indelible npm registry in every guest inventory

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Summary

Every guest has the package-registry directory tree from
[npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) under the
special name `@registry`.
The binding is present when the guest is first formulated, survives daemon
reincarnation, and cannot be removed, renamed, rebound, or shadowed.

The mechanism is a dedicated indelible slot: `GuestFormula` gains a required
`registry` formula identifier, and guest construction projects that identifier
through the existing special-name overlay as `@registry`.
The formula field supplies persistence and reachability; the special-name
grammar supplies immutability.
An ordinary pet-store entry, a caller-supplied provisioning option, or a
process-global lookup would provide only part of this guarantee and is not used.

The mandatory capability is a credential-free public-read view.
It has the directory tree's `has`, `lookup`, `list`, and `getInfo` surfaces at
the nodes where that design permits them, but no publish, configuration,
credential, raw-network, or content-store administration surface.
Node-hosted Endo and Rust-hosted Endor expose the same inventory name, tree
paths, method guards, and failure shapes.

## What is the problem being solved?

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
4. Node-hosted Endo and Rust-hosted Endor present an identical contract.
5. Existing guests acquire the slot before they are exposed after an upgrade.

## Non-goals

- Changing the tree shape, resolver, MVS algorithm, CAS layout, registry error
  family, or read-consistency rules defined by
  [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md).
- Giving every guest access to private packages or authenticated registry reads.
- Giving a guest a `PublishGrant`, `PublishGrantIssuer`, npm bearer token, or
  npmjs.com credential from
  [npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md).
- Letting a guest choose, replace, or remove its mandatory registry root.
- Implementing this design. A build follows design acceptance.

## Placement and name

The inventory name is the daemon-owned special name `@registry`, matching the
host spelling and avoiding a second concept for the same tree.
It is a special name, not a `PetName`, despite living in the inventory that is
often called the pet store.

Each guest formula carries the root directly:

```ts
type GuestFormula = {
  type: 'guest';
  // existing required fields
  registry: FormulaIdentifier;
};
```

Guest formulation obtains the daemon's mandatory guest registry root and writes
its identifier into the formula as part of the same formulation operation.
The dependency is pinned until the guest formula has been persisted and entered
in the formula graph, following the existing disk-before-graph rule.
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

## Indelibility

This design picks a **dedicated indelible slot**, implemented by the combination
of a required formula field and a reserved special name.
The distinction among the candidate mechanisms is:

| Candidate | Presence after restart and GC reachability | Mutation resistance | Disposition |
|---|---|---|---|
| Ordinary pet-store injection at formulation | Pet-store persistence only | None; the guest can remove, rename, or overwrite it | Rejected |
| A well-known process-global resolver for every guest | Not represented as a guest dependency | Bypasses inventory mutation, but becomes hidden ambient state | Rejected |
| A reserved `@registry` spelling without a formula slot | The live overlay can resolve it, but the guest formula does not retain or inspect it | The name is protected while live | Rejected |
| Required `GuestFormula.registry` projected as `@registry` | Explicit, durable, and visible to reachability and inspection | Protected by every special-name write boundary | Selected |

Inventory reads accept a `Name`, which includes special names.
Inventory writes require a `PetName` at the destination leaf.
The existing `petNamePathFrom` and `assertPetNamePath` boundaries therefore
reject `@registry` for `storeIdentifier`, `storeLocator`, `remove`, both sides of
`move` or `rename`, and the destination of `copy`.
The special-name overlay resolves its own record before the underlying mutable
controller, so an invalid or legacy backing-store entry cannot shadow the
formula-baked binding.
Nested ordinary names do not shadow a root name, and no introduced special name
may claim the daemon-owned bare spelling.

This protection is narrow.
Other inventory entries remain ordinary mutable pet names, and the guest may
still store another registry-like capability under another valid name.
It cannot make that capability replace what `lookup('@registry')` means.

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
Likewise, if a deployment supplies a narrower package or scope view, that view
may occupy another name or, by operator policy at formulation, the required slot,
but a guest cannot request a wider view.

This is deliberate baseline authority, not an unforgeable global discovered
behind a string.
The reference is visible in the guest's inventory, follows ordinary capability
passing rules, and is limited to a fixed public-read protocol.
Code that receives only some other capability does not gain registry access
unless it also has the guest inventory powers or receives the registry reference.

The write side stays disjoint.
[npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md) defines
`PublishGrant` and its bearer-token realization as separate, attenuated
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

The Node-hosted Endo daemon and Rust-hosted Endor daemon implement the same
logical guest-formula field and special-name projection.
In each implementation:

1. guest formulation records a registry-root identifier before exposing the
   guest;
2. guest construction presents that identifier as `@registry` through the
   inventory interface;
3. lookup returns the root `RegistryDirectory`, whose `/npm`, package, version,
   and immutable-leaf behavior is exactly the shared directory-tree contract;
4. the persisted guest record retains the root across restart and garbage
   collection; and
5. no guest method or backend-specific escape exposes Node fetch powers, Rust
   `HttpClient`, SQLite, registry-table mutation, CAS mutation, or credentials.

The existing cross-backend registry-tree conformance suite is extended with an
inventory fixture rather than creating a second Endor-specific protocol.
The fixture formulates equivalent guests on both daemons and compares the
`@registry` name, method guards, path results, ordering, content identity, and
documented failure shapes.
A Node-only implementation is incomplete even if the underlying Endor tree
adapter already passes the tree-only suite.

## Persistence, reachability, and inspection

`GuestFormula.registry` is a strong formula dependency.
The `guest` case of `extractLabeledDeps` emits the registry identifier so the
formula graph keeps the root reachable while the guest exists.
The parallel normalized formula record used by `getFormula` and inspection also
reports the field.
Any equivalent Rust dependency and inspection tables do the same.

The guest registers the same lifecycle relationship used for its other required
infrastructure dependencies.
Failure or collection of the mandatory registry root must not leave a live guest
whose `@registry` silently disappears: construction fails closed, and an already
live guest observes the registry capability's documented backend failure rather
than a missing inventory name.

## Migration and compatibility

Existing persisted guest formulas do not have a `registry` field.
Both daemons run an idempotent upgrade before exposing guests:

1. formulate or locate the daemon's guest-safe public registry root;
2. find each local `GuestFormula` without `registry`;
3. write that root identifier into the formula and update the formula dependency
   graph transactionally; and
4. only then permit the guest to reincarnate or appear in the agent map.

The pass mirrors the prior required-field migration for `HostFormula.registry`.
It fills only an absent field, preserves an existing field, and makes a second
start a no-op.
An upgrade failure is fatal for exposure of the affected guest rather than
producing a guest without the invariant.

An existing ordinary pet name such as `registry` remains untouched and mutable.
After migration it coexists with the special `@registry` name.
The pet-store grammar has never admitted `@registry` as an ordinary entry, so
there is no valid persisted ordinary binding to overwrite.

[registry-capability](registry-capability.md) is deprecated because its bespoke
`EndoRegistry` method API was superseded, not because the host special-name
transport must vanish.
The directory-tree design re-incarnates the host's existing `@registry` formula
identifier as the new root tree and keeps a separately obtained deprecated
method-call adapter for old callers.
This design gives guests only the new tree shape.
It does not install the deprecated adapter in a guest inventory and does not
forward guest lookup through the host special name.
Host and guest `@registry` may point to the same guest-safe root by default, but
a host-only credentialed or administrative registry view must remain distinct
from the mandatory guest slot.

## Implementation phases and tests

1. **Formula and construction.** Add the required guest field, thread the
   guest-safe root through formulation, project `@registry` in the special-name
   record, and update dependency and inspection tables in both daemons.
2. **Migration.** Add the pre-exposure, idempotent upgrade for existing guest
   formulas and a restart fixture that begins from the old record shape.
3. **Parity and security.** Extend the cross-backend conformance suite and add
   negative authority tests.

The tests cover:

- fresh guests list and resolve `@registry` without any provisioning option;
- the resolved root and exact package-version leaf retain identity across daemon
  restart;
- `storeIdentifier`, `storeLocator`, `remove`, `rename`, `move`, and `copy`
  cannot use `@registry` as a mutable leaf, while the same operations still work
  for an ordinary control name;
- the special overlay wins over a deliberately malformed backing-store fixture,
  proving the root cannot be shadowed;
- the registry formula remains reachable while only the guest formula names it,
  and inspection reports the dependency;
- migration fills a missing field once, preserves an existing field, and never
  exposes an unmigrated guest;
- a credential-capturing registry stub observes no authorization material on a
  guest lookup, and a private-only package is unavailable through the mandatory
  root;
- reflection and method-guard tests find no publish, grant, credential,
  configuration, raw HTTP, registry-table mutation, or CAS-write method; and
- Node and Endor return the same names, path objects, ordering, content identity,
  and failures for the shared fixture.

## Design decisions

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

## Dependencies

| Design | Relationship |
|---|---|
| [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) | Defines the exact capability placed at `@registry`, including Node and Endor adapters. |
| [registry-capability](registry-capability.md) | Supplies the host-special-name and required-formula-field migration precedent; its bespoke method API remains deprecated. |
| [npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md) | Defines the separate write authority that must never be reachable from the mandatory tree. |

## Prompt

> On 2026-09-04, kriskowal requested a follow-up to the merged package-registry
> directory-tree design: make the npm registry capability an indelible member of
> every guest inventory, present by construction and impossible for the guest to
> delete or rename away.
