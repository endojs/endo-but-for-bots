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
  `agent-lifecycle` name and stays quiescent once removal begins.
- `makeChildAgentCoordinator({ host, rootPolicy })` and
  `prepareChildAgentCoordinator` run the coordinator over any `PrivateHost`
  port; `makeDaemonPrivateHost(powers)` adapts an `EndoHost` to it.

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

## Driver and spawner adapters

`makeInferenceAgentDriverMaker` closes over an `InferenceBackend` and a
function that derives a `GuestToolProjection` from the child guest.
It installs a narrower `ChildInference` capability in the private driver
guest.
Every `infer` call derives a new projection, which pins the tool catalog for
that turn, while the backend retains its `CredentialSource` and releases each
grant at its own boundary.

`makeChildAgentSpawner` maps each logical child to a fresh derived namespace.
The namespace contains one child named `agent` and may receive a recursively
attenuated spawner as an ordinary endowment.
`stop(name)` revokes that namespace, removing the child and all descendants
without giving any child an `EndoHost`.
Fae preserves its existing `SubagentSpawner` methods with an adapter over this
surface; Lal uses its landed worker loop; and the Claude CLI and Agent SDK
makers compose the corresponding `@endo/claude` backends rather than copying
their turn logic.

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

Facets are durable.
`bind`, `attenuate`, and each runner's lifecycle are `evaluate` formulas in
the coordinator's private directory, whose source calls
`E(coordinator).boundFacet(nsId)` or `E(coordinator).lifecycleFor(opKey)`.
The daemon re-evaluates them against the live coordinator after a restart,
so a held facet keeps working without being re-issued, and a revoked one
keeps rejecting.
At start the pinned coordinator replays its journals, reconciles, and then
looks up every committed child's runner, so each resumes with no holder call
and no mail.
A child's own `@pins` plays no part, so a child cannot defeat its revival.

## Status

This package holds the coordinator state machine, its capability surface,
its daemon wiring, the keyed driver turn ledger, and reader-side reply
collapse.
The state machine and the turn ledger are tested against an in-memory daemon
with crash injection at every effect, and the restart rows of the design's
recovery matrix are tested against a real daemon.
The child topology and the `@endo/inference`, Fae, Lal, Claude CLI, and Claude
Agent SDK maker adapters are present.
