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

- `installChildAgentFactory(host, { rootPolicy, name? })` installs the
  factory in a deploying host and returns its root facet.
  It creates the dedicated `agent-factory` child host, formulates the
  coordinator with `makeUnconfined('@main', specifier, { powersName:
  'agent-factory' })`, pins it in the deploying host's `@pins`, and
  formulates the root facet as an `evaluate` over the coordinator.
  Every step checks its name first, so re-running it converges.
- `makeChildAgentCoordinator({ host, rootPolicy })` runs the coordinator over
  any `PrivateHost` port and returns
  `{ rootFacet, coordinatorFacet, faults, boundFacet }` at once, with
  `replayed`, `ready`, and `runnersStarted` promises; every facet call waits
  for `ready`.
  `prepareChildAgentCoordinator` waits for `runnersStarted`.
  The coordinator replays every namespace's journal and reconciles each
  nonterminal record before it answers, so no facet call observes a
  half-made child.
  `makeDaemonPrivateHost(powers)` adapts an `EndoHost` to the port.
- The root facet (`ChildAgentFactory`) offers `bind(maker, policy?)`,
  `listDerived()`, and `revokeDerived(name)`.
- A bound facet (`BoundChildAgentFactory`) offers `create`, `lookup`, `list`,
  `remove`, `attenuate`, `listDerived`, and `revokeDerived`.
- `bind` and `attenuate` intersect their policy with the issuer's, so quota,
  instruction size, and admitted endowment names only shrink.
  A child created in a derived namespace reserves a quota slot in every
  ancestor.
- A maker's `installDriver({ agent, driverGuest, lifecycle, instructions })`
  puts the capabilities its loop needs in the driver guest's directory and
  returns `{ specifier, env? }`.
  The coordinator formulates that module as the child's runner, with the
  driver guest as its powers.
- Each runner finds a read-only `AgentLifecycle` facet under its powers'
  `agent-lifecycle` name (exported as `LIFECYCLE_NAME`) and stays quiescent
  once removal begins.
  In a daemon deployment that name holds a durable formula over the
  coordinator facet.
  Without one, a revived coordinator rebinds the name to its own facet
  before it starts any runner, so a revived runner observes removal and
  revocation made after the restart.
- The `ChildAgentCoordinator` facet (`coordinatorFacet`) is the target of
  durable facet formulas and belongs only in the factory's private directory.
  `boundFacet(namespaceId)` re-derives a namespace's facet from the live
  incarnation; a revoked namespace's id is never reissued, so its facet
  rejects every call after any number of restarts.
  `lifecycleFor(operationId)` re-derives a child's lifecycle; a key the
  journal has passed but no longer retains (a removed or revoked child)
  yields a lifecycle that is never active.
  Either method fails closed on an id the coordinator never issued.

The entry point also exports the pieces a deployment or an adapter needs to
check its own values against the same rules:

- `makeRootPolicy(policy)` validates and normalizes a root policy, and
  `intersectPolicy(issuer, requested)` computes the narrowed policy that
  `bind` and `attenuate` apply.
- `MAX_POLICY_COUNT` (`2**32 - 1`) bounds both policy counts.
  The package profiles quota and instruction bytes to four bytes, a choice
  about the deployments it serves rather than a JavaScript limit.
- `isOrdinaryName(name)` is the daemon's ordinary pet-name rule, which child,
  endowment, and derived-namespace names must satisfy.
- `ChildAgentPolicyShape`, `CreateOptionsShape`, `ChildAgentSummaryShape`, and
  `DerivedNamespaceSummaryShape` are the patterns facet arguments and results
  must match.
- `AgentDriverMakerInterface`, `ChildAgentFactoryInterface`,
  `BoundChildAgentFactoryInterface`, and `AgentLifecycleInterface` are the
  interface guards of the maker a holder supplies and of the facets the
  coordinator issues.
- The types `ChildAgentPolicy`, `RootPolicy`, `EffectivePolicy`,
  `PrivateHost`, and `DriverDescriptor` describe the policy arguments, the
  coordinator's host port, and what a maker's `installDriver` returns.

```js
const root = await installChildAgentFactory(host, {
  rootPolicy: {
    maxChildren: 8,
    maxInstructionBytes: 16_384,
    endowmentNames: ['notes', 'workspace'],
  },
});
const forUi = await E(root).bind(maker, { maxChildren: 4 });
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
The fault is journaled, so a removal or revocation resumed by a later
incarnation leaves the record reserved too.
Values retained before the journal entry that records them (a namespace's
registry entry and maker before the issuer's `Derived` entry, a child's
endowments before its `Intended` entry) are reclaimed on revival, and
revoking a bound namespace releases its maker.
A maker cannot choose its runner's powers: the coordinator formulates the
runner over the driver guest itself, and a maker that names no driver
specifier is refused and the child rolled back.

Facets are durable.
`bind`, `attenuate`, and each runner's lifecycle are `evaluate` formulas in
the coordinator's private directory, whose source calls
`E(coordinator).boundFacet(namespaceId)` or
`E(coordinator).lifecycleFor(operationKey)`, answered by the
`ChildAgentCoordinator` facet.
The daemon re-evaluates them against the live coordinator after a restart,
so a held facet keeps working without being re-issued, and a revoked one
keeps rejecting.
At start the pinned coordinator replays its journals, reconciles, and then
looks up every committed child's runner, so each resumes with no holder call
and no mail.
A child's own `@pins` plays no part, so a child cannot defeat its revival.

## Status

This package holds the coordinator state machine, its capability surface,
and its daemon wiring.
The state machine is tested against an in-memory daemon with crash injection
at every effect, and the restart rows of the design's recovery matrix are
tested against a real daemon.
The `@endo/inference`, Fae, and Lal maker adapters, the driver turn ledger,
and reader-side reply collapse are later steps of the design's
implementation plan.
