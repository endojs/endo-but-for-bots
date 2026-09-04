# Introduced special names: indelible `@`-prefixed endowments on provisioning

| | |
|---|---|
| **Created** | 2026-08-31 |
| **Updated** | 2026-09-04 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

Narrowed from a broader Claude-agent provisioning proposal to just the generic
daemon mechanism, at maintainer request on the
[#1102](https://github.com/endojs/endo-but-for-bots/pull/1102) review.

## Dependencies

This design builds on the retained-guest provisioning API of
[#1042](https://github.com/endojs/endo-but-for-bots/pull/1042) (the
`provideGuest(name, options)` seam and its idempotent reacquisition), records the
gap raised in
[#982](https://github.com/endojs/endo-but-for-bots/issues/982) (see § What is the
Problem Being Solved?), and supplies the generic daemon seam the confined in-guest
agent of [#1015](https://github.com/endojs/endo-but-for-bots/pull/1015)
(`endo-claude`) needs for its provisioning half.

## What is the Problem Being Solved?

A host provisions a guest with `E(host).provideGuest(petName, opts)`.
Today the only way to seed the new agent's namespace is `opts.introducedNames`,
which maps names held by the providing host to *ordinary pet names* in the new
agent.
Ordinary pet names are mutable: the recipient can rename or remove them and can
rebind the name to a different capability, so an `introducedNames` entry is a
starting convenience, not a durable grant.

Consider the concrete driver.
A deployment provisions a child guest and wants that guest to hold a scoped
account facet under a name the guest can look up but can never remove or rebind,
so a later prompt inside the guest cannot lose or shadow the capability.
Today the deployment can only introduce it as an ordinary pet name, which the
guest can drop.
The guest needs a *special name*: a well-known `@`-prefixed name the daemon binds
and the recipient cannot mutate.

The daemon owns a small, closed set of special names, all `@`-prefixed, that it
binds itself at agent construction.
For a guest: `@agent`, `@self`, `@host`, `@mail`, `@nets`, and `@planes`
(`packages/daemon/src/guest.js:94-104`).
For a host: a larger set including `@registry`, `@endo`, `@pins`, `@none`,
`@main`, `@node`, and the conditional `@secrets` (root host) and `@mail` (mail
hub) (`packages/daemon/src/host.js:504-524`).
These daemon-owned special names are currently the *only* special names, and none
can be introduced from a providing host through the provisioning call.

This is the gap
[#982](https://github.com/endojs/endo-but-for-bots/issues/982) records: letting
the provisioning party designate a guest's indelible special worker names.
That issue names an "alternative `@main`" as one motivating case.
This design addresses the general requirement (provisioning-party-designated
indelible names) but deliberately does *not* let a caller bind the bare name
`@main`: as § The introduced sub-namespace explains, introduced names live under a
reserved prefix that is statically disjoint from the daemon's own names, and
`@main` is daemon-owned.
A literal alternative `@main` (rebinding a name the daemon already owns) would
need its own daemon carve-out and is out of scope here; #982 is therefore
*partially* addressed, with the general mechanism landed and the specific
`@main`-override left as separate work.

This design adds one generic mechanism.
It defines an `introducedSpecialNames` option on the provisioning call that maps
host-held source names to `@`-prefixed destination names bound indelibly in the
new agent.
Each source name is resolved once at provisioning time.
The resulting identifier is persisted in the new agent's *formula* (the durable
record from which the daemon reconstructs the agent) and re-supplied on every
daemon reincarnation (the reconstruction of a live agent from its formula that
follows a daemon restart).

It is deliberately narrow.
It defines no package, no factory, no credential model, and nothing
Claude-specific.
Any deployment that wants to hand a new agent a durable capability under a
reserved name uses this one seam.
A scoped provisioner, an account-status facet, or a policy object are typical
capabilities to endow.
The policy of *which* names to introduce, and *what* capabilities sit behind
them, belongs to the deployment, not to this daemon feature.

## The option

`introducedSpecialNames` joins `introducedNames` on the existing shared options
bag `MakeHostOrGuestOptions` (`packages/daemon/src/types.d.ts:1444`), which both
`provideGuest` and `provideHost` already accept.
It builds directly on the retained-guest provisioning API landed by
[#1042](https://github.com/endojs/endo-but-for-bots/pull/1042) (`feat(daemon):
retain guests with introducedNames and code-mode globals`): its
`EndoHost.provideGuest(name, options)` seam, its `introducedNames` grammar, and
its idempotent reacquisition of a retained guest.
Rather than introducing a parallel provisioning path, this design adds one new
option field to that same bag.

Destination names are drawn from the reserved introduction sub-namespace defined
in § The introduced sub-namespace: they must carry the reserved `@intro-` prefix.

```js
await E(host).provideGuest(childName, {
  introducedSpecialNames: {
    // source name held by the providing host -> @intro- name in the new agent
    'some-scoped-cap': '@intro-scoped-cap',
  },
});
```

The keys are single local names the *providing host* can resolve in its own pet
store.
The values are the `@intro-`-prefixed names bound in the *new agent*.

The keys use the same grammar as `introducedNames`.
`introducedNames` resolves its keys through
`petStore.identifyLocal(parentName)` (`packages/daemon/src/host.js:1864`), single
local names only.
`introducedSpecialNames` deliberately matches that grammar rather than accepting
name paths, so the two options in the same bag share one key grammar and a caller
cannot discover a divergence as a failed provisioning call.
A deployment that needs to introduce a capability reached by a path can bind it
to a single local name first and introduce that.

Honoring the option on the shared `MakeHostOrGuestOptions`, and thus for both
`provideHost` and `provideGuest`, is a deliberate widening rather than an
oversight.
A host is an agent with a pet store just as a guest is, and is equally entitled
to receive an indelible special name.
Keeping the option on the shared type avoids splitting `MakeHostOrGuestOptions`
(and the single normalizer `normalizeHostOrGuestOptions` at
`packages/daemon/src/host.js:83`) into per-agent-kind variants.
If a later design needs a guest-only or host-only provisioning option, that split
is its work to justify; this mechanism does not require it.

## The introduced sub-namespace and the forward-compatibility contract

A destination name must not collide with a name the daemon owns.
The daemon's owned set is not fixed for all time, though.
It is the closed set enumerated in `guest.js` and `host.js` above, *plus* an
embedder-supplied set: `host.js:505` spreads `...platformNames`, built at
`packages/daemon/src/manager.js:645-654` from the `specials` bag passed to
`makeDaemon` (`packages/daemon/src/manager.js:7578`, `specials = {}`; type
`Specials` at `packages/daemon/src/types.d.ts:697`), and today those keys pass
through with no validation, not even `assertSpecialName`.
The daemon may also add to its own set in a later release.
A collision check run once at provisioning time, against the set as it stands that
day, would silently break when a later daemon version, or a deployment's
`specials` bag, claims a name an existing agent formula already binds.
Because both the daemon-owned binding and the introduced binding are indelible,
neither side could then be dropped to resolve the collision, and the merge order
in the special-name store (assembled by literal-plus-assignment in
`guest.js:94-104`, then spread over `platformNames` in `host.js:505`) would alone
decide the winner.

The design therefore reserves a *statically disjoint sub-namespace* for
introduced names rather than checking against a moving set.
Introduced destination names are drawn from the reserved introduction prefix
`@intro-`, pinned to that spelling here (it is a permanent, formula-baked
contract, not a free choice for the implementation to revisit; `@x-` was rejected
because the deprecated `X-` convention of RFC 6648 teaches that an "experimental"
marker becomes permanent).
The daemon's own special names are single unprefixed words (`@self`, `@host`,
`@planes`).
An introduced name carries the `@intro-` prefix.
Collision-freedom is then a *structural* property, prefix membership, checkable
without knowing the agent kind or the daemon version, not a point-in-time set
comparison, and it holds across every future daemon release without
reincarnation-time re-validation.
This also removes the ergonomic trap of an introduced `@scoped-cap` being
indistinguishable in form from a daemon-owned `@planes`: the reserved prefix makes
the two visibly distinct at every call and inspection site.

The contract has two sides, and only one is structural for free.
The introduced side is enforced by validation (§ Resolution).
The daemon-owned side is a promise that no daemon-owned or embedder-supplied
special name uses the `@intro-` prefix, and nothing enforces that promise today
because `specials` keys are unvalidated.
Phase 1 therefore adds an assertion that no daemon-owned special name and no
`specials` key carries the reserved prefix, so a deployment cannot register
`@intro-scoped-cap` as a platform special and win by merge order.
That assertion is what makes invariant 2's "statically disjoint in every future
release" true rather than a human promise.

## Resolution, validation, and rejection

Provisioning resolves each source name *once*, against the providing host's pet
store, and records the resulting formula identifier.
Validation runs before any side effect and *rejects* (does not silently degrade)
when:

- a destination is not a well-formed `@intro-`-prefixed name (it must match the
  existing special-name grammar `validSpecialNamePattern`,
  `/^@[a-z][a-z0-9-]{0,127}$/` at `packages/daemon/src/pet-name.js:25`, and carry
  the reserved prefix);
- two entries map to the same destination name (duplicate destination); or
- a *source name does not resolve* in the providing host's pet store.

The daemon-owned-collision case that a flat reserved namespace would need is
subsumed by the sub-namespace rule above.
A destination outside the reserved prefix is malformed and rejected, and one
inside it can never name a daemon-owned special name (given the Phase 1 assertion
that keeps the prefix off the daemon-owned and embedder-supplied sets).

The last case is the load-bearing departure from `introducedNames`.
The existing `introduceNamesToAgent` helper silently `return`s when a source name
is unresolvable (`packages/daemon/src/host.js:1867-1869`): the ordinary-name path
can afford to no-op because those names are mutable hints.
An indelible special name must not follow that path.
A silent skip would mint an agent that is *missing* a capability the caller
believes it granted and that the agent can never acquire afterward, which is the
exact failure this mechanism exists to prevent.
An unresolvable source name therefore *fails the provisioning call loudly*, before
the agent is created.

## Provisioning against an existing agent

`provideGuest` and `provideHost` are *provide* (get-or-create) verbs, not
create-only verbs.
`makeChildHost` (`packages/daemon/src/host.js`) returns an existing agent
unchanged on a name hit and formulates a new one only on the miss.
`introducedNames` survives this because it is re-applied on every call.
An indelible, formula-baked special name cannot be re-applied, because the
existing agent's formula is already written.
The behavior on the existing-agent branch must therefore be stated, not left to
whichever binding merges last.

Because callers supply *source names* but the formula persists *resolved
identifiers* (Design decision 4), the comparison on the existing-agent branch is
defined over the resolved value, not over the caller's surface syntax.
Resolve the supplied `introducedSpecialNames` map first, producing a
`{destination -> identifier}` set, and compare that set, order-insensitively,
against the set already persisted in the agent's formula.
"Byte-identical over the caller's record" is deliberately *not* the rule: a
`Record<string,string>` has no canonical byte form or key order, and comparing
resolved identifiers is what makes idempotence independent of caller-side syntax.

On a name hit that returns an existing agent:

- an omitted `introducedSpecialNames` option is a *no-op*: the bare reacquire
  `provideGuest(name, { agentName })` that a retained guest issues on every
  startup returns the existing agent unchanged, exactly as #1042 established.
  Omitting the option never compares against, nor disturbs, the persisted set;
- a supplied map whose resolved `{destination -> identifier}` set equals the
  persisted set is a *no-op* (idempotent repeat provide); and
- a supplied map whose resolved set *differs* from the persisted one *rejects*
  the call, rather than silently endowing nothing (the differing entries can never
  take effect on an indelible binding) or silently rebinding (indelibility forbids
  it).

Two caller-visible consequences follow, and both are intended.
A repeat provide after the host *rebinds* a source pet name to a *different*
capability resolves a different identifier and therefore rejects, surfacing the
divergence instead of silently doing nothing.
A repeat provide after a mere *rename* that preserves the identifier resolves the
same identifier and is a clean no-op.
A caller that intends to *change* an agent's introduced special names cannot: the
grant is fixed for the agent's lifetime (see § Revocation).

## Persistence and reincarnation

The resolved formula identifiers are stored in the new agent's *formula*, not
merely applied to its live pet store.
On every daemon reincarnation the daemon re-supplies the special-name bindings to
the agent from the persisted formula, so the grant survives restart without the
providing host being present or re-running provisioning.

Because the identifiers now live in the guest (and host) formula, they become part
of the daemon's reachability graph and must be enumerated where every other
formula-held identifier is, or the garbage collector will reclaim a capability the
agent formula still names.
Two hand-maintained tables read the formula and must both learn the new field:

- `extractLabeledDeps` (`packages/daemon/src/manager.js:717`), whose `'guest'` and
  `'host'` cases (`packages/daemon/src/manager.js:734-761`) enumerate each
  formula-held identifier; the graph `makeFormulaGraph` builds from it
  (`packages/daemon/src/manager.js:1162-1165`) drives reachability and
  `onCollect`; and
- the parallel normalized-formula table in
  `packages/daemon/src/formula-record.js` (the `'guest'` and `'host'` cases at
  `packages/daemon/src/formula-record.js:55` and `:80`) that `EndoHost.getFormula`
  and the inspector read.

Both tables gain the persisted `introducedSpecialNames` identifiers.
A retention test then asserts that an introduced capability is still reachable,
not collected, after a daemon restart while the agent formula names it.

`extractLabeledDeps` returns `Array<[string, FormulaIdentifier]>`: one label maps
to exactly one identifier, and a label carries no other data.
Because a single agent can hold several introduced identifiers, the design emits
one `[label, identifier]` pair per introduced binding, deriving each label from
its destination name (for example `introduced:@intro-scoped-cap`).
This keeps each identifier individually enumerated for reachability and matches
the table's one-label-one-identifier shape rather than inventing a data-carrying
label.
A same-round test that the two tables agree on the introduced identifiers caps the
cost of the two hand-maintained enumerations.

## Indelibility

The recipient can *look up* an introduced special name through ordinary naming
machinery (it resolves like any `@`-prefixed name) but cannot *remove* or
*rebind* it, exactly as it cannot remove or rebind daemon-owned special names.
The property comes from the name grammar, not from the introduction itself: a pet
store rejects any write to an `@`-prefixed name because every write path runs the
injected `assertValidName` (`packages/daemon/src/pet-store.js:20,49,66,79,86`),
and `isValidName` (`packages/daemon/src/pet-name.js:15`) excludes `@`-prefixed
names.
`makePetSitter` passes `storeIdentifier`, `remove`, and `rename` straight through
to the underlying controller (`packages/daemon/src/pet-sitter.js:110`) and rejects
nothing itself, so the guarantee is anchored in the grammar and its callers, not
in the pet-sitter wrapper.
An implementer must therefore assert indelibility against the *whole* write
surface a name has (`storeIdentifier`, `storeLocator`, `move`, `copy`, `remove`,
`rename`), not only `remove` and `rename`.
An ordinary `introducedNames` entry offers neither property; that difference is the
entire point of the new option.

The recipient discovers which introduced names it holds by enumeration, since it
did not choose them: `makePetSitter.list` returns special names sorted ahead of
ordinary ones (`packages/daemon/src/pet-sitter.js:48-55`), so an introduced name
appears there, and the reserved `@intro-` prefix makes it visibly distinct from a
daemon-owned special name in that listing.

From the recipient's side the endowment is visible and usable but immovable:

```js
// inside the newly provisioned guest
await E(agent).lookup('@intro-scoped-cap');                  // resolves
await E(agent).list();                                       // includes @intro-scoped-cap
await E(agent).remove('@intro-scoped-cap');                  // rejects: indelible
await E(agent).storeIdentifier(otherId, '@intro-scoped-cap'); // rejects: cannot rebind
```

## Revocation

An introduced special name is indelible for the *lifetime of the agent* and is not
independently revocable by this mechanism.
The resolved identifier is rooted by the agent's formula (the reachability edge of
§ Persistence and reincarnation).
Provisioning also registers the introduced identifier as a `thisDiesIfThatDies`
dependency: `context.thisDiesIfThatDies(dep)`
(`packages/daemon/src/context.js:115-118`) makes the *agent* die if `dep` dies
(the term names a daemon lifetime edge whereby one formula's destruction cancels a
dependent).
The direction matters and cuts the wrong way if misread: destroying the introduced
capability cancels the *whole recipient agent*, so the providing host retains an
agent-wide kill switch through any introduced name.
The only intended way to withdraw the endowment through the daemon is to destroy
the agent; removing the introduced identifier from an existing formula is *not* a
supported operation, because the formula is written once at provisioning and
reincarnation always re-supplies every persisted introduced binding.

A deployment that needs a *revocable* endowment does not remove the introduced
name.
It introduces a *caretaker or attenuating forwarder* as the capability behind the
introduced name and revokes through that forwarder, exactly as with any other
durable grant.
Because of the `thisDiesIfThatDies` edge above, the forwarder must be *neutered*
(made to stop forwarding), never *destroyed*: destroying it would cancel the whole
agent.
The introduced name stays bound and resolvable; what it forwards to becomes inert.
Providing that caretaker is the deployment's responsibility, not this daemon
feature's.
The feature guarantees only that the *name* is indelible, deliberately leaving
revocation policy to the capability the name points at.

## Security invariants

1. `introducedSpecialNames` can only introduce capabilities the *providing host
   already holds and can resolve* in its own pet store; it grants no way to name a
   capability the host cannot itself reach.
2. Destination names are constrained to well-formed `@intro-`-prefixed names,
   statically disjoint from the daemon's own and the embedder-supplied special
   names now and in every future release (enforced by the Phase 1 assertion that
   keeps the reserved prefix off both sets), and may not duplicate each other.
3. An unresolvable source name aborts provisioning; the mechanism never produces an
   agent silently missing an intended indelible capability.
4. A repeat provide of an existing agent with a resolved `introducedSpecialNames`
   set that differs from the persisted set aborts, rather than silently endowing
   nothing or rebinding an indelible name; an omitted option and an equal set are
   both no-ops.
5. An introduced special name is indelible to the recipient: lookup-only across the
   whole write surface (`storeIdentifier`, `storeLocator`, `move`, `copy`,
   `remove`, `rename`), and it survives daemon reincarnation from the persisted
   formula.
6. Persisted introduced identifiers are enumerated in the daemon's reachability and
   formula-record tables, so an introduced capability is neither collected while
   named nor invisible to the inspector.

## Phased implementation and tests

1. **Guard and normalizer.**
   Add `introducedSpecialNames` to `MakeHostOrGuestOptions` and the shared options
   normalizer, with the validation above, and add the assertion that no
   daemon-owned or embedder-supplied (`specials`) special name carries the reserved
   `@intro-` prefix.
   Test malformed destinations (outside the reserved sub-namespace), duplicate
   destinations, and, distinctly, an *unresolvable source name that rejects* the
   call rather than skipping.
2. **Provisioning and formula.**
   Resolve source names once, persist the resulting identifiers in the agent
   formula, and bind them as special (indelible) names in the new agent.
   Test that the recipient can look the name up and see it in `list` but cannot
   remove or rebind it across the whole write surface; that a repeat provide whose
   resolved set is *equal* is idempotent; that an *omitted* option on a bare
   reacquire is a no-op; and that a repeat provide whose resolved set *differs*
   rejects.
3. **Reincarnation and GC.**
   Re-supply bindings from the persisted formula on restart, and extend
   `extractLabeledDeps` and the formula-record tables.
   Test identity preservation of the introduced capability across a daemon restart,
   assert the two tables agree on the introduced identifiers, and add a retention
   test asserting the capability is not collected while the agent formula names it.

## Surfacing the option (help and CLI)

The `provideGuest` help entry documents its options as
`{ introducedNames: { guestName: hostName } }` (`packages/daemon/src/help.md`),
which spells the mapping direction *backwards*.
`host.js:1863` maps `[parentName, childName]`, that is source->destination, and the
CLI spells the same direction `--introduce myPetname:theirPetname`
(`packages/cli/src/endo.js:733,749`).
Phase 1 therefore also:

- documents `introducedSpecialNames` in the `provideHost` and `provideGuest` help
  entries, stating the source->destination direction and that an unresolvable
  source rejects the call while `introducedNames` silently skips;
- corrects the inverted existing `introducedNames` help entry to match the
  implementation and the CLI, and adds the same "silently skips" note there so a
  caller reading only that older entry meets the divergence in documentation
  rather than as a surprise; and
- names a CLI spelling for the new option, `--introduce-special
  cap:@intro-scoped-cap`, the sibling of the existing `--introduce`
  (`packages/cli/src/endo.js:733,749`).

## Design decisions

1. **Reuse the existing options bag rather than a new provisioning verb.**
   The grant is a property of provisioning; a separate call would let an agent
   exist for a window without its intended indelible capability.
   The cost of reusing a get-or-create verb, defining the existing-agent branch, is
   paid explicitly in § Provisioning against an existing agent.
2. **Make the mechanism generic and Claude-agnostic.**
   A hard-coded daemon name for one deployment's capability would not be reusable;
   deployments supply their own source capabilities and destination names.
3. **Reject an unresolvable source instead of inheriting `introducedNames`'s
   silent skip.**
   Indelibility means the recipient can never recover from a missed grant, so the
   miss must be a loud provisioning failure, not a quiet absence.
4. **Persist resolved identifiers, not source names.**
   Re-resolving source names at reincarnation would depend on the providing host
   still holding them and would let a later rebind on the host silently change the
   recipient's indelible capability.
   The existing-agent idempotency check (§ Provisioning against an existing agent)
   therefore compares resolved identifiers, not caller-supplied source names.
5. **Draw introduced names from a reserved, statically disjoint sub-namespace.**
   A flat collision check against the daemon's owned set is only valid at the
   instant it runs; a reserved prefix makes collision-freedom structural and
   forward-compatible without reincarnation-time re-validation of an indelible
   binding.

## Prompt

> Narrow the earlier `@endo/exo-claude-agents` provisioning proposal, at the
> maintainer's request, to just the one generic daemon mechanism it needed:
> endowing a newly provisioned agent with indelible special names supplied on the
> provisioning options bag.
> Drop the package, factory, credential-lease, and lifecycle content; keep the
> daemon `introducedSpecialNames` seam, its validation and rejection rules,
> persistence across reincarnation, garbage-collection reachability, and a phased
> test plan.
> Implementation is out of scope.
