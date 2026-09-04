# Endow a new agent with indelible special names on provisioning

| | |
|---|---|
| **Created** | 2026-08-31 |
| **Updated** | 2026-09-04 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Source** | Narrowed from a broader Claude-agent provisioning proposal at maintainer request ([#1102](https://github.com/endojs/endo-but-for-bots/pull/1102) review) to just the generic daemon mechanism. |

## What is the Problem Being Solved?

A host provisions a guest with `E(host).provideGuest(petName, opts)`.
Today the only way to seed the new agent's namespace is `opts.introducedNames`,
which maps names held by the providing host to **ordinary pet names** in the new
agent.
Ordinary pet names are mutable: the recipient can rename or remove them and can
rebind the name to a different capability, so an `introducedNames` entry is a
starting convenience, not a durable grant.

Some deployments need to endow a new agent with a capability the agent can look
up by a well-known name but **cannot remove or rebind** — a *special name*.
The daemon owns a small, closed set of special names, all `@`-prefixed, that it
binds itself at agent construction: for a guest, `@agent`, `@self`, `@host`,
`@mail`, `@nets`, and `@planes` (`packages/daemon/src/guest.js:94-104`); for a
host, a larger set including `@registry`, `@endo`, `@pins`, `@none`, `@main`,
`@node`, and the conditional `@secrets` (root host) and `@mail` (mail hub)
(`packages/daemon/src/host.js:504-524`).
These daemon-owned special names are currently the *only* special names, and
none can be introduced from a providing host through the provisioning call.
This is the gap [#982](https://github.com/endojs/endo-but-for-bots/issues/982)
records — letting the provisioning party designate a guest's special worker
names, including an alternative `@main` — the driving requirement this design
answers.

This design adds one generic mechanism.
It defines an `introducedSpecialNames` option on the provisioning call that maps
host-held source names to `@`-prefixed destination names bound indelibly in the
new agent.
Each source name is resolved once at provisioning time; the resulting identifier
is persisted in the new agent's *formula* (the durable record from which the
daemon reconstructs the agent) and re-supplied on every daemon reincarnation
(the reconstruction of a live agent from its formula that follows a daemon
restart).

It is deliberately narrow.
It defines no package, no factory, no credential model, and nothing
Claude-specific.
Any deployment that wants to hand a new agent a durable capability under a
reserved name uses this one seam — a scoped provisioner, an account status facet,
or a policy object being typical capabilities to endow.
The policy of *which* names to introduce, and *what* capabilities sit behind
them, belongs to the deployment, not to this daemon feature.

## The option

`introducedSpecialNames` joins `introducedNames` on the existing shared options
bag `MakeHostOrGuestOptions` (`packages/daemon/src/types.d.ts:1444`), which both
`provideGuest` and `provideHost` already accept. It builds directly on the
retained-guest provisioning API landed by
[#1042](https://github.com/endojs/endo-but-for-bots/pull/1042) (`feat(daemon):
retain guests with introducedNames and code-mode globals`) — its
`EndoHost.provideGuest(name, options)` seam, `introducedNames` grammar, and
idempotent reacquisition of a retained guest — rather than introducing a parallel
provisioning path; this design adds one new option field to that same bag:

```js
await E(host).provideGuest(childName, {
  introducedSpecialNames: {
    // source name held by the providing host -> @-prefixed name in the new agent
    'some-scoped-cap': '@x-scoped-cap',
  },
});
```

The keys are single local names the **providing host** can resolve in its own
pet store; the values are the `@`-prefixed names bound in the **new agent**.

The keys use the same grammar as `introducedNames`, whose keys the sibling
resolves through `petStore.identifyLocal(parentName)`
(`packages/daemon/src/host.js:1864`) — single-segment local names only.
`introducedSpecialNames` deliberately matches that grammar rather than accepting
name paths, so the two options in the same bag share one key grammar and a
caller cannot discover a divergence as a failed provisioning call.
A deployment that needs to introduce a capability reached by a path can bind it
to a single local name first and introduce that.

Honoring the option on the shared `MakeHostOrGuestOptions` — and thus for both
`provideHost` and `provideGuest` — is a deliberate widening, not an oversight.
A host is an agent with a pet store just as a guest is, and is equally entitled
to receive an indelible special name.
Keeping the option on the shared type avoids splitting `MakeHostOrGuestOptions`
(and the single normalizer `normalizeHostOrGuestOptions` at
`packages/daemon/src/host.js:83`) into per-agent-kind variants.
If a later design needs a guest-only or host-only provisioning option, that
split is its work to justify; this mechanism does not require it.

## The introduced sub-namespace and the forward-compatibility contract

A destination name must not collide with a name the daemon owns.
The daemon's owned set is not fixed for all time, though: it is the closed set
enumerated in `guest.js` and `host.js` above, and the daemon may add to it in a
later release.
A collision check run once at provisioning time, against the set as it stands
that day, would silently break when a later daemon version claims a name an
existing agent formula already binds.
Because both the daemon-owned binding and the introduced binding are indelible,
neither side could then be dropped to resolve the collision, and the merge order
in the special-name store (`specialNames` is assembled by literal-plus-assignment
in `guest.js:94-104`) would alone decide the winner.

The design therefore reserves a **statically disjoint sub-namespace** for
introduced names rather than checking against a moving set.
Introduced destination names are drawn from a reserved introduction prefix that
the daemon promises never to use for its own special names — the `@x-` prefix in
the example above (`@x-scoped-cap`), pinned to its final spelling in
implementation.
The daemon's own special names are single unprefixed words (`@self`, `@host`,
`@planes`); an introduced name carries the reserved prefix.
Collision-freedom is then a **structural** property — prefix membership, checkable
without knowing the agent kind or the daemon version — not a point-in-time set
comparison, and it holds across every future daemon release without
reincarnation-time re-validation.
This also removes the ergonomic trap of an introduced `@scoped-cap` being
indistinguishable in form from a daemon-owned `@planes`: the reserved prefix
makes the two visibly distinct at every call and inspection site.

## Resolution, validation, and rejection

Provisioning resolves each source name **once**, against the providing host's pet
store, and records the resulting formula identifier.
Validation runs before any side effect and **rejects** (does not silently
degrade) when:

- a destination is not a well-formed `@`-prefixed name in the reserved
  introduction sub-namespace;
- two entries map to the same destination name (duplicate destination); or
- a **source name does not resolve** in the providing host's pet store.

The daemon-owned-collision case that a flat reserved namespace would need is
subsumed by the sub-namespace rule above: a destination outside the reserved
prefix is malformed and rejected, and one inside it can never name a
daemon-owned special name.

The last case is the load-bearing departure from `introducedNames`.
The existing `introduceNamesToAgent` helper silently `return`s when a source name
is unresolvable (`packages/daemon/src/host.js:1867-1869`): the ordinary-name path
can afford to no-op because those names are mutable hints.
An indelible special name must not follow that path.
A silent skip would mint an agent that is *missing* a capability the caller
believes it granted and that the agent can never acquire afterward, which is the
exact failure this mechanism exists to prevent.
An unresolvable source name therefore **fails the provisioning call loudly**,
before the agent is created.

## Provisioning against an existing agent

`provideGuest` and `provideHost` are *provide* (get-or-create) verbs, not
create-only verbs: `makeChildHost` (`packages/daemon/src/host.js`) returns an
existing agent unchanged on a name hit and formulates a new one only on the miss.
`introducedNames` survives this because it is re-applied post-hoc on every call;
an indelible, formula-baked special name cannot be re-applied, because the
existing agent's formula is already written.
The behavior on the existing-agent branch must therefore be stated, not left to
whichever binding merges last.

On a name hit that returns an existing agent:

- an `introducedSpecialNames` map that is byte-identical to the one persisted in
  that agent's formula is a **no-op** — provisioning is idempotent for a repeated
  provide of the same agent with the same introductions; and
- an `introducedSpecialNames` map that **differs** from the persisted one
  **rejects** the call, rather than silently endowing nothing (the differing
  entries can never take effect on an indelible binding) or silently rebinding
  (indelibility forbids it).

A caller that intends to change an agent's introduced special names cannot: the
grant is fixed for the agent's lifetime (see § Revocation).

## Persistence and reincarnation

The resolved formula identifiers are stored in the new agent's **formula**, not
merely applied to its live pet store.
On every daemon reincarnation the daemon re-supplies the special-name bindings to
the agent from the persisted formula, so the grant survives restart without the
providing host being present or re-running provisioning.

Because the identifiers now live in the guest (and host) formula, they become
part of the daemon's reachability graph and must be enumerated where every other
formula-held identifier is, or the garbage collector will reclaim a capability
the agent formula still names.
Two hand-maintained tables read the formula and must both learn the new field:

- `extractLabeledDeps` (`packages/daemon/src/manager.js:717`), whose `'guest'` and
  `'host'` cases (`manager.js:734-761`) enumerate each formula-held identifier;
  the graph `makeFormulaGraph` builds from it (`manager.js:1162-1165`) drives
  reachability and `onCollect`; and
- the parallel normalized-formula table in
  `packages/daemon/src/formula-record.js` (the `'guest'` and `'host'` cases at
  lines 55 and 80) that `EndoHost.getFormula` and the inspector read.

Both tables gain the persisted `introducedSpecialNames` identifiers.
A retention test then asserts that an introduced capability is still reachable —
not collected — after a daemon restart while the agent formula names it.

Following the pet-store precedent, the introduced identifiers enter the
dependency graph under a single generic label carrying the map as data (as
`extractLabeledDeps` already does with its `'petName'` token, rewritten to
`pet:<name>` downstream at `manager.js:7019-7033`), rather than splatting the
caller-supplied `@`-names into the fixed label vocabulary.

## Indelibility

The recipient can **look up** an introduced special name through ordinary naming
machinery (it resolves like any `@`-prefixed name) but cannot **remove** or
**rebind** it, exactly as it cannot remove or rebind daemon-owned special names.
The property comes from the special-name store, which rejects writes to
`@`-prefixed names, not from the introduction itself.
An ordinary `introducedNames` entry offers neither property; that difference is
the entire point of the new option.

From the recipient's side the endowment is visible and usable but immovable:

```js
// inside the newly provisioned guest
const cap = await E(agent).lookup('@x-scoped-cap'); // resolves
await E(agent).remove('@x-scoped-cap');             // rejects: indelible
await E(agent).write(['@x-scoped-cap'], otherId);   // rejects: cannot rebind
```

## Revocation

An introduced special name is indelible for the **lifetime of the agent** and is
not independently revocable by this mechanism.
The resolved identifier is a `thisDiesIfThatDies` dependency of the agent and is
rooted by the agent's formula, so the only way to withdraw the endowment through
the daemon is to destroy the agent.
Removing the introduced identifier from an existing formula is **not** a supported
operation: the formula is written once at provisioning, and reincarnation always
re-supplies every persisted introduced binding.

A deployment that needs a *revocable* endowment does not remove the introduced
name; it introduces a **caretaker or attenuating forwarder** as the capability
behind the introduced name and revokes through that forwarder, exactly as with
any other durable grant.
The introduced name stays bound and resolvable; what it forwards to becomes
inert.
Providing that caretaker is the deployment's responsibility, not this daemon
feature's — the feature guarantees only that the *name* is indelible, deliberately
leaving revocation policy to the capability the name points at.

## Security invariants

1. `introducedSpecialNames` can only introduce capabilities the **providing host
   already holds and can resolve** in its own pet store; it grants no way to name
   a capability the host cannot itself reach.
2. Destination names are constrained to well-formed `@`-prefixed names in the
   reserved introduction sub-namespace, which is statically disjoint from the
   daemon's own special names now and in every future release, and may not
   duplicate each other.
3. An unresolvable source name aborts provisioning; the mechanism never produces
   an agent silently missing an intended indelible capability.
4. A repeat provide of an existing agent with a differing `introducedSpecialNames`
   map aborts, rather than silently endowing nothing or rebinding an indelible
   name.
5. An introduced special name is indelible to the recipient — lookup-only, not
   removable or rebindable — and survives daemon reincarnation from the persisted
   formula.
6. Persisted introduced identifiers are enumerated in the daemon's reachability
   and formula-record tables, so an introduced capability is neither collected
   while named nor invisible to the inspector.

## Phased implementation and tests

1. **Guard and normalizer.**
   Add `introducedSpecialNames` to `MakeHostOrGuestOptions` and the shared options
   normalizer, with the validation above.
   Test malformed destinations (outside the reserved sub-namespace), duplicate
   destinations, and — distinctly — an **unresolvable source name that rejects**
   the call rather than skipping.
2. **Provisioning and formula.**
   Resolve source names once, persist the resulting identifiers in the agent
   formula, and bind them as special (indelible) names in the new agent.
   Test that the recipient can look the name up but cannot remove or rebind it;
   that a repeat provide of the same agent with an **identical** map is idempotent;
   and that a repeat provide with a **differing** map rejects.
3. **Reincarnation and GC.**
   Re-supply bindings from the persisted formula on restart, and extend
   `extractLabeledDeps` and the formula-record tables.
   Test identity preservation of the introduced capability across a daemon
   restart, and add a retention test asserting the capability is not collected
   while the agent formula names it.

## Surfacing the option (help and CLI)

`provideHost` documents no options in its `help()` entry today (`help.md:365-370`,
`help-text-data.js:116`), and the `introducedNames` help text spells the mapping
direction **backwards** (`{ guestName: hostName }`, while `host.js:1863` maps
`[parentName, childName]`, that is source→destination, and the CLI spells
`--introduce myPetname:theirPetname`).
Phase 1 therefore also:

- documents `introducedSpecialNames` in the `provideHost`/`provideGuest` help
  entries, stating the source→destination direction and that an unresolvable
  source rejects the call while `introducedNames` silently skips; and
- corrects the inverted existing `introducedNames` help entry to match the
  implementation and the CLI; and
- names a CLI spelling for the new option, `--introduce-special
  cap:@x-scoped-cap`, the sibling of the existing `--introduce`
  (`cli/src/endo.js`).

## Design decisions

1. **Reuse the existing options bag rather than a new provisioning verb.**
   The grant is a property of provisioning; a separate call would let an agent
   exist for a window without its intended indelible capability.
   The cost of reusing a get-or-create verb — defining the existing-agent branch —
   is paid explicitly in § Provisioning against an existing agent.
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
