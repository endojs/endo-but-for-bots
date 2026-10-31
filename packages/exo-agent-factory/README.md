# `@endo/exo-agent-factory`

`@endo/exo-agent-factory` turns a held `AgentDriverMaker` capability into
durable child-agent guests, inside a namespace and policy the holder's facet
embodies.
It implements the core of
[`designs/endo-child-agent-factory.md`](../../designs/endo-child-agent-factory.md).

Holding a facet is the authorization.
The factory never compares owner, caller, provider, or formula identifiers.
A child receives exactly the endowments its creator names, and never the
maker, a credential, the root host, or the coordinator's private directory.

## Surface

- `prepareChildAgentCoordinator({ host, rootPolicy })` revives (or creates)
  the coordinator over its private host and returns `{ rootFacet, faults,
  boundFacet }`.
  It replays every namespace's journal and reconciles each nonterminal record
  before returning, so no facet call observes a half-made child.
- The root facet (`ChildAgentFactory`) offers `bind(maker, policy?)`,
  `listDerived()`, and `revokeDerived(name)`.
- A bound facet (`BoundChildAgentFactory`) offers `create`, `lookup`, `list`,
  `remove`, `attenuate`, `listDerived`, and `revokeDerived`.
- `bind` and `attenuate` intersect their policy with the issuer's, so quota,
  instruction size, and admitted endowment names only shrink.
  A child created in a derived namespace reserves a quota slot in every
  ancestor.
- Each child's runner receives a read-only `AgentLifecycle` facet under the
  driver guest's `agent-lifecycle` name (exported as `LIFECYCLE_NAME`) and
  stays quiescent once removal begins.
  A revived coordinator rebinds that name to its own facet before it starts
  any runner, so a revived runner observes removal and revocation made after
  the restart.

The entry point also exports the pieces a deployment or an adapter needs to
check its own values against the same rules:

- `makeRootPolicy(policy)` validates and normalizes a root policy, and
  `intersectPolicy(issuer, requested)` computes the narrowed policy that
  `bind` and `attenuate` apply.
- `isOrdinaryName(name)` is the daemon's ordinary pet-name rule, which child,
  endowment, and derived-namespace names must satisfy.
- `ChildAgentPolicyShape`, `CreateOptionsShape`, `ChildAgentSummaryShape`, and
  `DerivedNamespaceSummaryShape` are the patterns facet arguments and results
  must match.
- `AgentDriverMakerInterface`, `ChildAgentFactoryInterface`,
  `BoundChildAgentFactoryInterface`, and `AgentLifecycleInterface` are the
  interface guards of the maker a holder supplies and of the facets the
  coordinator issues.
- The types `ChildAgentPolicy`, `RootPolicy`, `EffectivePolicy`, and
  `PrivateHost` describe the policy arguments and the coordinator's host port.

```js
const { rootFacet } = await prepareChildAgentCoordinator({
  host: agentFactoryHost,
  rootPolicy: {
    maxChildren: 8,
    maxInstructionBytes: 16_384,
    endowmentNames: ['notes', 'workspace'],
  },
});
const forUi = await E(rootFacet).bind(maker, { maxChildren: 4 });
const { handle } = await E(forUi).create('helper', {
  instructions: 'Summarize new notes.',
  endowments: { notes },
});
```

## Durability

Each namespace keeps an append-only journal of numbered pet names in the
coordinator's private directory.
A child moves through `Intended`, `GuestCreated`, `Endowed`,
`DriverCreated`, `Pinned`, and `Committed`, and leaves through `Removing` and
`Removed`.
Every creation step checks its derived name first and adopts an existing
value only after proving its formula type, because neither `provideGuest` nor
`makeUnconfined` is a safe adopting primitive on its own.
A derived name holding the wrong type fails closed: the record stays
reserved, nothing is deleted, and `faults()` reports it.
A responder a maker has just returned gets the same proof before the child
commits; a responder that is not an unconfined caplet over its driver guest
is cancelled and the child is rolled back.

## Status

This package holds the coordinator state machine and its capability surface,
tested against an in-memory daemon with crash injection at every effect.
It is the first pull request of the design's implementation plan.
The daemon-backed wiring (the pinned coordinator formula and durable facet
formulas), the Fae `SubagentSpawner` adapter, the `@endo/inference`, Fae, and
Lal maker adapters, the driver turn ledger, and reader-side reply collapse
follow in the plan's second pull request.
