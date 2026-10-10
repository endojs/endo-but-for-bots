# @endo/hosted-agent

The provider-neutral seam a hosted agent backend plugs into.

A *hosted backend* runs a conversation somewhere Endo does not: a Codex
app-server in a sandbox slice, a Claude Code CLI, a future adapter for something
else. Floot drives all of them the same way, so what they share belongs here —
the contracts they satisfy, the data shapes that cross the boundary, and the
protocols that are the same for every provider and easy to get subtly wrong.

What is genuinely provider-specific stays in the adapter: how to dispatch a
turn, how to read the latest checkpoint, how to revert.

## Contracts

`src/hosted-backend.js` holds the interfaces and the exact projectors for the
capability-free records that cross the seam:

| | |
|---|---|
| `HostedBackendFactoryInterface` | provision and destroy sessions |
| `HostedTurnBackendInterface` | run a turn, interrupt it, acknowledge it |
| `HostedTurnBackendAdminInterface` | tear a session down |
| `HostedToolSetInterface` | the only Endo authority a backend receives |
| `assertHostedBackendDescriptor`, `normalizeHostedModelDescriptor` | project the two catalogs Floot selects from |

The projectors match on an exact key set and rebuild the record from validated
fields, so a backend cannot smuggle a capability, an accessor, or an unbounded
structure into Floot's metadata.

## Turn durability

`turn-ledger.js` is the protocol between dispatching a turn and the consumer
acknowledging it. A hosted turn is not durable because the provider says it
finished: Floot commits its own conversation on the terminal event and
acknowledges afterwards, so in between the backend owes three things.

1. **Write-ahead.** Record what is about to be dispatched *before* dispatching
   it, so a crash leaves a marker naming the checkpoint the provider's history
   must be rolled back to.
2. **Exactly one terminal outcome.** A provider that keeps talking after a
   failure — a `completed` notification already in flight when the session was
   quarantined — must not be able to rewrite a settled turn's marker or hand
   the consumer a second terminal event. The ledger latches the first outcome
   *synchronously*, before its first `await`, and reports a later one as a
   duplicate carrying the outcome that won, so the caller declines to deliver
   it.
3. **Reconciliation.** Until the consumer acknowledges, the recorded turn is
   outstanding: either it is rolled out of the provider's history or the session
   is quarantined. `reconcile` takes the two provider calls it needs and owns
   the rest, including refusing to revert when history has moved on.

```js
const ledger = makeTurnLedger({ persist, audit, recovery: savedRecovery });

const turn = await ledger.begin({ baseCheckpoint: await readLatestCheckpoint() });
await turn.observe(providerTurnId);          // once the provider names it
const { accepted } = await turn.settle({ type: 'completed', checkpoint });
if (accepted) deliverTerminalEvent();        // a loser never reaches here

await ledger.acknowledge(checkpoint);        // the consumer committed
await ledger.reconcile({ readLatestCheckpoint, revertBefore });
```

`persist` must not resolve before the write is durable; the whole protocol rests
on it. The record it stores is the ledger's, and a backend is free to project it
into its own persisted shape — `@endo/codex-sandbox` does, so existing durable
state keeps loading.

Both defects this module exists to prevent were found in a real adapter, and
both are covered by `test/turn-ledger.test.js`.

## Account visibility

`account.js` and `account-oracle.js` answer what plan a credential is on, how
much of the rate limit is left, and what a token count costs — without holding
the credential. See [ACCOUNT-ORACLE.md](./ACCOUNT-ORACLE.md).
