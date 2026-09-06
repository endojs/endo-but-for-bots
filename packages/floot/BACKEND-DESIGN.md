# Floot and FAE backend design

Floot and FAE share one agentic capability model but have different drivers.
FAE follows durable mailboxes; Floot adds a direct pull-streaming session UI.
Provider and hosted backend differences belong below that driver boundary.

## Backend seam

A backend factory describes itself, lists its current models, and provisions one
backend session for one logical Floot session.
The canonical provider-neutral guards and descriptor validator are exported by
`@endo/hosted-agent`; Floot validates every endowed factory's
descriptor against that contract.
Descriptors are projected to the exact five capability-free fields `id`,
`title`, `kind`, `continuity`, and `toolOwnership`; backend-supplied metadata is
never forwarded to the UI.
Each provider adapter translates its native model schema before the seam.
`@endo/hosted-agent` then validates and projects one exact neutral DTO containing
bounded `id`, `title`, and `description` strings, a `default` boolean, a
string-only `reasoningEfforts` array, and a `defaultReasoningEffort` drawn from
that array (or `null`).
This keeps provider protocol names out of Floot while preserving the provider's
declared defaults for the dynamic model UI.
The same package owns the `HostedToolSet` guard for the only Endo authority
passed into a backend: `describe`, `execute`, and `help`.
The provisioned backend is split into two facets:

- The run facet exposes `send`, `interrupt`, commit-checkpoint acknowledgement,
  and status/model observation.
- The admin facet exposes retryable teardown and is retained only by the Floot
  factory.

`interrupt()` is a terminal barrier: it resolves only after the backend can no
longer emit events or mutate its opaque conversation for that turn.
The factory-level `destroy({ sessionId })` operation is idempotent and is used
when lifecycle recovery has no surviving admin facet.

Codex implements this seam in `@endo/codex-sandbox/backend-factory.js`.
Claude Code should implement the same seam instead of adding another branch to
Floot's logical-turn persistence.
The existing Claude raw-event translator is a compatibility adapter until that
migration lands.

Every backend emits the same normalized stream: phase, commentary delta, answer
delta, tool intent, tool result, usage, and exactly one end or abort terminal.
Only answer deltas contribute to spoken or persisted assistant text.
Backends execute one turn; they do not own the UI, presets, inbox, conversation
tree, cumulative usage, or session registry.

## Endo tools

`src/tool-registry.js` is the single catalog for API-provider and hosted turns.
It snapshots tool names, schemas, and executable Endo capabilities together.
API providers receive the OpenAI-compatible schemas and run the shared
`@endo/fae/src/turn-engine.js` state machine.
Codex receives the corresponding app-server `dynamicTools` descriptors and can
call only the pinned `EndoToolSet` capability.

This is the intended Endo-to-Codex bridge.
No MCP socket, bearer path, runtime-mounted daemon socket, host lookup power, or
account/session-management API is projected into the sandbox.
Possession of a tool in the snapshot is the approval; the outer Endo sandbox
and the tool capability itself enforce authority.

## Session and model lifecycle

The factory supports both the legacy positional creation call and a record:

```js
createSession({
  title,
  presetId,
  backendId,
  modelId,
  reasoningEffort,
});
```

`listBackends()` returns live backend descriptors.
`listModels(backendId)` asks that backend for its current model and reasoning
catalog; the no-argument form returns a flattened compatibility catalog for the
existing UI.
A session pins the exact backend, model, reasoning effort, prompt, and Endo tool
set.
Catalog refresh never silently substitutes another choice for an existing
session.

Creation persists `creating`, provisions preset objects and the backend, then
persists `ready`.
Deletion persists `deleting`, terminates the backend through its admin facet,
destroys its durable state through the factory, removes the session guest, then
removes the registry entry.
Termination alone is a stop: it releases the slice, the mount, and the lease
but keeps the workspace and Codex state, which is what lets a session whose
revival failed part-way be revived again with its contents intact.
A cleanup failure persists `error` and remains retriable rather than falsely
reporting deletion.
On revival, `creating` entries finish provisioning, `ready` entries revive,
and `deleting` or `error` entries automatically retry cleanup.
Before reprovisioning a recovered `creating` entry, Floot idempotently destroys
resources under its stable session ID so an uncertain prior creation cannot
leak a second slice.
An agent shutdown first rejects new turns, aborts and awaits active UI or inbox
turns, and closes its inbox iterator; the guest is not removed while those
operations or a host-side Endo tool call remain unsettled.

Lifecycle persistence is an append-only sequence of complete registry
snapshots.
A crash can therefore leave either the previous complete snapshot or the next
one, but cannot erase the sole registry value between a remove and store.
The old single petstore value is read only as a migration source when no
journal snapshot exists.

## Atomic turns and recovery

The conversation tree commits a hosted logical turn as one node after the
backend terminal succeeds.
Failed and cancelled turns are not presented as successful history.
Provider-backed turns use the same rule: intermediate assistant/tool messages
remain in memory and the complete logical turn plus cumulative usage is added
to the tree once, only after a final answer is available.
Opaque hosted backends must reconcile their own history before accepting the
next turn.
Before dispatch, Codex durably records the previous backend turn ID.
It then records the new turn ID as soon as `turn/start` returns.
A successful terminal carries that ID into the Floot conversation node; only
after that node and cumulative usage are durable does Floot acknowledge the
checkpoint to Codex.
If no matching acknowledgement is recovered, Codex compares the app-server's
latest turn to the write-ahead marker and uses the pinned app-server's
`thread/revert({ beforeTurnId })` before the next send.
It verifies the restored turn ID before clearing the marker.
This is idempotent across a crash before dispatch, during the turn, after the
terminal, after revert, or after the Floot commit but before acknowledgement.
Unexpectedly advanced history quarantines the session instead of deleting an
unknown turn.
This rollback is conversation-only; all tool side effects remain and are
visible in the workspace and durable audit journal.

The checkpoint-addressed endpoint prevents a numeric rollback from deleting an
unexpected later turn.
The protocol pin and tests make schema migration explicit instead of silently
allowing divergent history.

## Shared turn engine

`@endo/fae/src/turn-engine.js` owns the provider/tool sequencing invariant used
by both FAE and Floot: discover the current tools, obtain context, invoke the
model, run every tool call, commit that complete step, and repeat until one
toolless assistant message is committed or the round bound is reached.
It has no Pi, daemon, provider, UI, mailbox, or persistence dependency.

FAE retains its Smallcaps boundary, inbox policy, sequential tool execution,
and conversation commits.
Floot retains streaming, parallel tool execution, reply-channel behavior,
cumulative usage, and session lifecycle.
Hosted backends implement one normalized turn below this engine because their
native runtimes own the internal model/tool loop; they still commit through the
same Floot atomic-turn boundary.
