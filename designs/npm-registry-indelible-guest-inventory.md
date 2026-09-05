# Indelible npm Registry in Every Guest Inventory

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Updated** | 2026-09-05 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Summary

Package resolution inside a guest must always begin from one known inventory
name, without a provisioning grant and without the guest being able to take that
name away.
This design gives every guest the package-registry directory tree from
[npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) under the
special name `@registry`, present when the guest is first formulated, surviving
daemon reincarnation, and impossible for the guest to remove, rename, overwrite,
or shadow.

The mechanism is a dedicated indelible slot: `GuestFormula` (the durable
per-guest formula record) gains a required `registry` formula identifier, and
guest construction projects that identifier as `@registry` through the existing
special-name overlay (the daemon-owned layer that already supplies reserved names
like `@self` and `@host` over the otherwise mutable pet store).
The formula field supplies persistence and reachability; the special-name
grammar supplies immutability.
An ordinary pet-store entry, a caller-supplied provisioning option, or a
process-global lookup would provide only part of this guarantee and is not used.

The mandatory capability is a credential-free public-read view.
It has the directory tree's `has`, `lookup`, `list`, and `getInfo` surfaces at
the nodes where the directory-tree design permits them, but no publish,
configuration, credential, raw-network, or content-store administration surface.
Once the underlying tree design ships, the Node-hosted Endo daemon projects this
name; Rust-hosted Endor will match the same *tree contract* at that point, and adds
the inventory projection once it grows an agent and guest model.
Endor is the Rust backend: today it is only an npm resolver and assembler, with no
agent, guest, formula-graph, or inventory model of its own, which is why the
Goals and Non-goals below stage every inventory-side requirement as Node-now and
Endor-later (see Node and Endor parity).

## The problem being solved

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
2. The guest cannot remove, rename, overwrite, or shadow `@registry`,
   while ordinary inventory names remain mutable.
3. The capability grants public registry reads and immutable package-tree reads,
   never publish authority or registry credentials.
4. Node and Endor present an identical tree contract at the registry root.
   The inventory projection of `@registry` is required of the Node daemon now,
   and of Endor once it grows an agent and guest model; until then Endor's tree
   adapter is held to the tree-only conformance suite and the inventory projection
   is a Node-only surface (see the parity section). The tree contract itself is
   Not Started (see Dependencies), so both projections build on it once it ships.
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
- Re-pointing an already-populated guest at a new default root (root rotation).
  The `registry` field is write-once: set at formulation, or filled by the
  one-shot migration when absent, and never rewritten thereafter. Rotating the
  shared default (a backend credential change, a tree-contract version bump)
  across already-seated guests is out of scope; the field is a durable dependency
  identity, deliberately kept distinct from mutable operator policy.
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
  // Unlike HostFormula.registry, this dependency is GC-reachability-only and is
  // deliberately not wired through thisDiesIfThatDies (the daemon's
  // cancel-this-context-when-its-dependency-dies wiring); see Persistence,
  // reachability, and inspection for the divergent cascade semantics.
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
"Shared" here means the same formula identifier is copied into each guest's
write-once `registry` slot at formulation, not a live alias each guest tracks.
Rotating the default (out of scope per Non-goals) therefore leaves already-seated
guests on their original identifier while newly formulated guests take the new
one. Because the `registry` field is write-once, there is no in-place
reconvergence for an already-seated guest: the migration pass (Phase 2, defined
below under Implementation phases and tests) fills only an *absent* field and by
construction skips a guest that already carries one. Reconverging an existing
guest onto a rotated default therefore means formulating a *fresh* guest against
it and migrating its ordinary pet names by hand (the broken-root recovery path in
Persistence, reachability, and inspection), not rewriting the seated field. This
copy-once fragmentation-after-rotation is a deliberate, named limitation, not a
silent one.
A daemon that needs guest-specific accounting may formulate attenuating roots
with the same tree interfaces, but the slot remains required and the guest
cannot select a wider root.
The formulation-time mechanism by which an operator seats a non-default per-guest
root (a guest-maker registry-root parameter or override argument) is what this
design calls the **root-seating hook**. Its exact API surface is left to the
implementation build and is not fully specified here; this design names only the
resulting capability shape, not the spelling that seats it. It does fix one
minimal element of that shape, because a later section leans on it: the
root-seating hook accepts, alongside the root override, an optional
cancellation-wiring callback. That callback lets an operator seating a 1:1
per-guest root opt that guest into dying when its root dies, wiring the cascade
explicitly at formulation rather than relying on the slot, which by default
leaves the guest alive-but-registry-dead (the rationale for that default, and why
the shared-root case wants it, is Persistence, reachability, and inspection). The
build chooses the callback's spelling; this design only requires that the seam
exists.

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
once, made a formula-graph root, and projected as `@none` in the **host's**
special names (where it backs the host-only `makeUnconfined` / `makeArchive`
power defaults). It is durable and GC-reachable with no per-guest field and no
migration.
That pattern alone would carry a purely shared registry root.
The shipped precedent is host-side only, though: the guest `specialNames` overlay
has no `@none` entry and no equivalent guest method consumes it, so projecting a
preformulated root into a *guest's* inventory (precisely what this design does)
is adjacent to the `@none` pattern rather than already demonstrated by it.
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

The chokepoint guarantees only *name indelibility*: that the `@registry` binding
cannot be removed, renamed, overwritten, or shadowed by the guest.
It does not, and cannot, guarantee the second headline property: that the seated
root is a guest-safe public view carrying no publish authority or credentials.
That property is enforced instead at formulation time (the operator seats a
guest-safe root, per Authority and attenuation) and checked by the negative
authority tests below; it is a formulation-policy and test guarantee, not a
special-name-grammar one.
A future per-guest attenuating-root path (see Placement and name) must therefore
preserve that formulation contract itself, since the chokepoint will not catch a
mis-seated root.

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

Where every guest shares one default root (the common case in Placement and
name), that root's lookup traffic is not attributable per guest, so per-caller
rate and resource accounting is not a property this design provides. This design
makes registry-reaching authority present-by-construction for every guest and, in
the shared-root common case, funnels their lookups through one origin, so that
aggregate exposure needs a bound and no landed design currently supplies one. The
sibling [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md)
design defines the tree shape, caching, and offline-error semantics but does *not*
itself specify a rate limit, concurrency cap, or per-caller quota. Bounding the
shared root's aggregate origin traffic is therefore a **required property of the
backend an operator seats at the mandatory slot** (it must carry the
daemon-owned cancellation, size, and concurrency limits named above), and this
design records it as an open constraint on the seated root rather than an
already-owned one. The test catalog gates that constraint (Implementation phases
and tests: a lookup exceeding the seated bound is refused or canceled at the root,
and no guest method relaxes it) so the requirement is asserted by a test rather
than by prose alone. An operator needing per-guest accounting seats a distinct
attenuating root per guest rather than the shared default.

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

Guest `@registry` and host `@registry` carry the *identical* tree-node interfaces:
the guest root is a strict attenuation of the host tree, presenting the same
method surfaces so that library code written against either resolves and fails
the same way.
Any credentialed or administrative registry view is not a wider `@registry`; it
occupies a different name, so the same spelling never resolves to two different
interfaces.

This is deliberate baseline authority, not ambient authority obtainable merely by
knowing the right name.
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

Node and Endor will share the registry tree contract once
[npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) ships: both
backends implement that design's adapters and pass its cross-backend, tree-only
conformance suite. That tree design is Not Started (see Dependencies) and today's
`@registry` is still the deprecated `makeEndoRegistry` exo, so the shared tree
contract is a prerequisite this design builds on, not an already-achieved state.
This design does not change that layer.

The inventory projection is different.
Node's daemon has agents, guests, formulas, and special names, so it can carry
the required guest-formula field and project `@registry` through the inventory.
Endor today has no agent, guest, formula-graph, or special-name model: its Rust
sources are the npm resolver and assembler, with no pet store or inventory to
project a name into.
The parity requirement is therefore staged:

1. **Once the tree design ships (both backends):** the registry root behind
   `@registry` conforms to the shared tree contract, so a resolved root, its
   `/npm` hub, package and version directories, and immutable leaves behave
   identically on either backend. This is a prerequisite, not a present-day
   state: the tree contract and its conformance suite are Not Started (see
   Dependencies).
2. **Then (Node only):** guest formulation records a registry-root identifier
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
the tree contract both backends satisfy once the tree design ships.

## Persistence, reachability, and inspection

`GuestFormula.registry` is a strong formula dependency, and this design takes
**garbage-collection reachability**, not cancellation propagation, as its
lifecycle mechanism.
The `guest` case of `extractLabeledDeps` emits the registry identifier so the
formula graph keeps the root reachable while the guest exists; the root is
deliberately not wired through `thisDiesIfThatDies`.
That wiring registers *this* context to be canceled when its dependency dies, so
wiring it would let a shared root's reformulation or cancellation cascade a
cancellation into every guest that named the root, never the reverse.
This is an intentional departure from the sibling `HostFormula.registry`, which
*is* wired through `thisDiesIfThatDies` today; the host holds its own registry
root, whereas one guest-safe root is shared across many guests, so the host's
cascade semantics are wrong for the guest slot.

This cascade-avoidance argument holds for the shared-default-root case, where one
root backs many guests. It does *not* hold for the per-guest distinct-root case
that the Placement and name and Authority and attenuation sections permit (an operator seating
a 1:1 attenuating root per guest for accounting), where the root has exactly one
namer and the `HostFormula.registry` cascade semantics would in fact fit. This
design nonetheless applies the GC-reachability (no-`thisDiesIfThatDies`) wiring
uniformly to both cases, and states that as a deliberate choice, not an oversight:
a permanently-broken per-guest root leaves the guest **alive-but-registry-dead**
(its `@registry` still resolves to the now-failing root and surfaces the
directory-tree design's registry failure family at each call) rather than
canceling the guest. Uniform wiring keeps the slot's lifecycle contract identical
regardless of which root an operator seats, so a caller never has to reason about
whether a given guest's root death is fatal. An operator who instead wants a
per-guest root's death to cancel its guest uses the root-seating hook's optional
cancellation-wiring callback (defined under Placement and name), opting into that
cascade explicitly at formulation rather than relying on the slot.
The write-once slot has no in-place repair for a permanently-broken per-guest
root: repointing that guest's `registry` field is out of scope (Non-goals, root
rotation), so recovery means formulating a fresh guest against a working root and
migrating its ordinary pet names by hand. This dead-end is accepted deliberately
for the rare 1:1 accounting path rather than adding a field-rewrite path that
would reintroduce the root rotation this design excludes.
The parallel normalized formula record used by `getFormula` and inspection also
reports the field.
Any equivalent Rust dependency and inspection table does the same once Endor
carries the field.

The per-guest edge keeps a root reachable only while at least one guest names it,
which is enough for a per-guest 1:1 root (it has exactly that one namer) but not
for the *shared default* root, which must stay reachable and locatable even when
zero guests currently reference it (a fresh daemon before its first guest, or one
whose guests were all transiently removed). The shared default root is therefore
pinned the way `leastAuthority` is: the daemon preformulates it once and makes it
a formula-graph root in its own right, independent of any consumer edge, exactly
the durability the Indelibility comparison table credits to the `leastAuthority` /
`@none` pattern. That independent anchor is what Migration step 1's "formulate or
locate the daemon's guest-safe public registry root" locates, and it is what keeps
"all guests may point to the same stable root formula" (Placement and name) true
across restarts and zero-guest windows: the shared default's identity never drifts
because it is never GC-eligible for lack of a guest. A per-guest 1:1 root carries
no such daemon-level pin and relies solely on its single guest edge, consistent
with its narrower, guest-scoped lifetime.

Because the root is kept reachable rather than tied to the guest's cancellation,
it does not disappear underneath a live guest.
If a root nonetheless fails to formulate at construction, construction fails
closed (the guest is not exposed without the slot).
A backend fault reached through an already-live root surfaces as the
directory-tree design's documented registry failure family
(`RegistryOfflineError` and its siblings) at the offending call, never as a
missing `@registry` inventory name.

## Migration and compatibility

Existing persisted guest formulas do not have a `registry` field.
The Node daemon runs an idempotent upgrade before exposing guests (Endor has no
persisted `GuestFormula` records to migrate under this design, per Node and Endor
parity, so it has no Phase 2 deliverable now):

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
Phase 2 (Implementation phases and tests, below) therefore builds the daemon's
first formula-rewriting upgrade: enumerate persisted guest formulas, rewrite each
in place, and update the graph transactionally.
It fills only an absent field, preserves an existing field, and makes a second
start a no-op.
The transactional boundary is per-guest, not per-enumeration: a single guest
formula that is permanently unmigratable (a corrupt record or an unrecoverable
write) quarantines only itself, leaving its own guest unexposed while every
sibling guest still migrates and reaches the agent map. A guest's upgrade failure
is therefore fatal for the exposure of that guest alone; it never leaves a guest
without the invariant and never blocks a sibling's exposure. A quarantined guest
is not merely silently absent: the migration pass emits an operator-visible
record for it, namely a logged migration-summary entry naming each quarantined
guest and its failure cause, and (mirroring how inspection reports a live guest's
registry dependency) an inspection-visible quarantine marker on the unmigrated
formula, so that a violation of the "present by construction" promise is
observable without manually diffing formula records. The test catalog covers this permanent-failure
case, not only the transient/resumable interruption below.

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
- two guests seated against two *distinct* attenuating roots each resolve
  `@registry` only to their own root: guest A's `@registry` lists and looks up
  A's seated view and never B's or the shared default's wider view, and
  symmetrically for B, confirming per-guest root isolation for the
  operator-chosen 1:1 seating path (the branch with no shared default to fall
  back on);
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
- one guest formula is permanently unmigratable (a corrupt record or an
  unrecoverable write): it stays unexposed while every sibling guest still
  migrates and reaches the agent map, proving per-guest isolation rather than a
  whole-batch abort, and the quarantined guest surfaces in the migration-summary
  record and carries the inspection-visible quarantine marker rather than
  vanishing silently;
- a migration interrupted mid-pass (a fault or restart after some but not all
  guest formulas are rewritten) exposes no half-migrated guest on the next start:
  the pass resumes and every guest is either fully migrated or unexposed, with no
  partially-rewritten record reaching the agent map;
- a credential-capturing registry stub observes no authorization material on a
  guest lookup, and a private-only package is reported as absent through the
  mandatory root, indistinguishable from an unpublished package (the deliberate
  confidentiality choice recorded under Design decisions);
- a guest lookup that would exceed the seated root's daemon-owned bound (a
  size, concurrency, or cancellation limit named under Authority and attenuation)
  is refused or canceled at the root rather than passed through unbounded to the
  origin, and the guest holds no tree method that relaxes that bound; this gates
  the "required property of the backend an operator seats" assumption the
  shared-root aggregate-exposure argument rests on, rather than leaving it merely
  asserted;
- reflection and method-guard tests find no publish, grant, credential,
  configuration, raw HTTP, registry-table mutation, or CAS-write method; and
- Node returns the tree contract's names, path objects, ordering, content
  identity, and failures for the shared fixture.

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
6. **Treat a withheld package as indistinguishable from an absent one.** When an
   operator seats a narrower root, a package outside its scope surfaces as the
   directory-tree design's missing-package error, the same shape an unpublished
   package produces. This is a deliberate confidentiality choice: it does not let
   a guest enumerate what a narrower root withholds.

## Dependencies

| Design | Relationship |
|---|---|
| [npm-registry-as-directory-tree](npm-registry-as-directory-tree.md) | Defines the exact capability placed at `@registry`, including Node and Endor adapters. **Blocking:** it is Not Started, and today's `@registry` is still the deprecated `makeEndoRegistry` exo, so Phases 1-2 cannot begin until the tree and its conformance suite ship. It must additionally supply a **concrete default aggregate-exposure bound** (a size, concurrency, or per-caller cancellation limit, the property Authority and attenuation records as an open constraint on the seated root) in the tree contract or its reference implementation; **Phase 3 cannot close** until that default exists, because the Phase-3 bound test has nothing to assert against otherwise. This design does not itself specify the bound's value, only that a mandatory-for-every-guest capability may not leave its principal safety property as an unowned assumption about a downstream backend. |
| [registry-capability](registry-capability.md) | Supplies the host special-name transport and the *design-only* required-field migration precedent; the shipped daemon fails fast instead, so Phase 2 is novel work. Its bespoke method API remains deprecated. |
| [npm-dev-publisher-attenuation](npm-dev-publisher-attenuation.md) | Defines the separate write authority that must never be reachable from the mandatory tree. |
| _root-rotation tooling (follow-up, not yet designed)_ | **Follow-up placeholder.** Root rotation is a Non-goal here (the `registry` field is write-once), but the triggers this design already anticipates (a backend credential change or a tree-contract version bump) make fleet-wide re-seating a foreseeable operational cost whose only recovery today is manual, per-guest re-formulation. A later design must own the rotation/re-seating tooling; this row records the obligation rather than leaving it as disclaimed prose. |

## Prompt

> On 2026-09-04, kriskowal requested a follow-up to the merged package-registry
> directory-tree design: make the npm registry capability an indelible member of
> every guest inventory, present by construction and impossible for the guest to
> delete or rename away.
