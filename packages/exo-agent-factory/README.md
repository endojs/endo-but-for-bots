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
  driver guest's `agent-lifecycle` name and stays quiescent once removal
  begins.

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

## Turn publication

`makeTurnLedgerDriver` supplies the durable mailbox loop shared by provider
adapters.
It keys `TurnStarted`, `TurnResult`, and `Published` records by the durable
message number in the driver's private directory.
After a result is recorded, replay republishes that result without another
inference call.
A crash before `TurnResult` deliberately calls inference again, including any
provider or tool effect the first call completed.

Replies use the daemon mailbox's `reply` operation.
That operation addresses the original sender and carries the answered
message's id in the existing wire `replyTo` field, without adding metadata or
requiring the sender to be named in the child directory.
If a crash lands after the reply but before `Published`, replay may emit a
byte-identical duplicate with the same `replyTo`; conversation views collapse
that pair in the next implementation slice.

## Provider-backed deployment

[`examples/provider-backed-agent.js`](./examples/provider-backed-agent.js) is
an executable issuance example for a consumer such as the API-key provider
registry proposed by
[PR #1543](https://github.com/endojs/endo-but-for-bots/pull/1543).
The deploying host composes an already-held `InferenceProviderUse` with a Lal
or Fae adapter to mint an `AgentDriverMaker`, binds the root factory, and gives
the owner only the attenuated bound facet.
The owner uses that facet to create a child and stores only the child's mailbox
handle.
Neither the provider-use facet, the maker, nor the root factory crosses into
the owner guest.

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

## Status

This package holds the coordinator state machine, its capability surface, and
the keyed driver turn ledger, tested against an in-memory daemon with crash
injection at every effect.
The daemon-backed wiring (the pinned coordinator formula and durable facet
formulas), the `@endo/inference`, Fae, and Lal maker adapters, and reader-side
reply collapse are later steps of the design's implementation plan.
