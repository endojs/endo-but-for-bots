# Subagents

A Fae agent or Floot session may hand a self-contained piece of work to a
*subagent*: a separate agent with its own conversation, inbox, and pet-name
directory, addressed only by mail.

The parent gets three tools — `spawnSubagent`, `askSubagent`, `stopSubagent` —
and nothing else changes about how either harness runs a turn.

## Why the mailbox

The daemon already gives every agent a durable, capability-carrying,
order-preserving channel to every other agent.
Delegation therefore needs no new transport: `askSubagent` is `send` followed by
a wait for the matching `reply`.

That also means a subagent is reachable by anything else that can mail it, and
that a reply may carry capabilities as ordinary message attachments.

## Correlating a blocking ask with an asynchronous mailbox

The daemon posts every message a guest sends into that guest's *own* mailbox as
well as the recipient's, and publishes both to the same ordered topic.
A parent's single `followMessages` loop therefore observes its own outbound
delegation strictly before any reply to it.

`makeSubagentDelegations` exploits exactly that ordering:

1. `ask` registers the pending delegation, then sends.
2. The inbox loop offers every message to `claim`, before its own routing.
   The echo of the parent's own send teaches `claim` that delegation's
   `messageId`.
3. A later inbound message whose `replyTo` is that `messageId`, and whose `from`
   is the subagent, settles the `ask` and is *not* turned into a conversation
   turn.

Without step 3 a Floot parent would answer its subagent's reply, and the
subagent would answer that — an unbounded exchange between two models.

Nothing is written into the message text to make this work, so the subagent
never sees a correlation token, and a message from anyone else cannot settle a
delegation.

A message still marked `done: false` is left alone: a sender may reveal an
answer progressively and settle it later with `editMessage`, and claiming the
placeholder would hand the model "Thinking…" as the subagent's answer.
The daemon re-emits the settled revision under the same number, and that is what
claims the delegation.

### Locator identity

`locate()` decorates a locator with the transport hints `@nets` publishes at the
moment of the call, while the `from`/`to` locators stamped onto a message are
always hint-free.
String equality between the two therefore fails on any daemon with network
addresses configured.
`isSameFormula` compares the `{ number, node }` pair instead, and both harnesses
now use it for their own "is this my own outbound mail?" check as well.

## Authority

`SubagentSpawner` is the whole of the authority a parent gains:

```ts
interface SubagentSpawner {
  spawn(name: string, options?: { systemPrompt?: string }):
    Promise<{ name: string; locator: string }>;
  stop(name: string): Promise<void>;
  list(): Promise<string[]>;
  help(methodName?: string): string;
}
```

It can create, enumerate, and release agents named beneath one parent, and
nothing else.
It deliberately does **not** write into the parent's pet store: `spawn` returns
a locator and the parent binds it under `subagents/<name>` with its own
authority, so a compromised parent gains no writer for its own namespace.

Withholding the spawner is what withholds the tools.
An agent at the delegation bound is given none, so `makeSubagentTools` is never
called for it and `claim` has nothing to match.

A Floot session on a *hosted backend* has no subagent tools.
Its tool set is projected once, in `getAgent`, before the session agent — and
therefore the delegation registry — exists, so the backend's own tool loop sees
only the Endo tools.
Delegation is available to provider-backed sessions and to Fae agents.
Closing that gap belongs with exposing a hosted backend through the Floot
factory, which `packages/codex-sandbox/MERGE-BLOCKERS.md` records as
unreviewed.

### Bounds

| Bound | Default | Where |
|---|---|---|
| Delegation depth | 1 | `DEFAULT_MAX_SUBAGENT_DEPTH`; Floot reads `FLOOT_MAX_SUBAGENT_DEPTH` |
| Live subagents per parent | 8 | `DEFAULT_MAX_SUBAGENTS` |
| Ask timeout | 300 s, capped at 3600 s | `askSubagent`'s `timeoutSeconds` |
| Outstanding asks per subagent | 1 | `makeSubagentDelegations` |

A timed-out ask releases its timer and forgets the delegation, so a late reply
lands in the inbox as ordinary mail rather than settling a question nobody is
asking any more.
Teardown is depth-first, so raising the depth bound does not strand a subtree.

### Attachments

A reply may carry capabilities, and what happens to them follows each harness's
existing dismissal policy rather than inventing a new one.
Fae does not auto-dismiss, so `askSubagent` reports the reply's message number
and edge names and tells the model to `adopt` them.
A Floot session dismisses every message it handles, and a claimed reply is no
exception: leaving one would mean that after a restart, with no ask pending, the
reply replays as an ordinary message, the session answers it, and the subagent
answers back — two models in an unbounded exchange.
So Floot's `askSubagent` says plainly that the attachments were not retained and
suggests asking the subagent to store the object under a pet name instead.

## Durability

The two harnesses reach durability differently because their topologies differ.

**Fae** runs each agent's loop in its own `driver` caplet, which is revived
independently by `revivePins()`.
A spawner minted inside the factory would not survive that, so each delegating
agent gets its own `subagent-spawner` caplet — an ordinary `make-unconfined`
formula whose guest holds `llm-provider` and `host-agent` locators — and the
driver's namespace holds a locator to it.
Revival is then the ordinary formula path: the driver reincarnates, looks the
spawner up, and finds the same capability with the same bounds.

The spawner caplet resolves its own namespace lazily rather than in `make()`,
because it is reincarnated by the very lookup a reviving driver performs.

**Floot** rebuilds every session in-process in `getAgent`, so its spawner is an
ordinary object minted there and the durable record of the tree is the session
registry alone: a subagent session carries `parentSessionId`, `subagentName`,
and `subagentDepth`, and `listSessions` surfaces the first two so a client can
group or hide a delegated tree.
Those fields are minted by the spawner and stripped from public `createSession`
options, so a caller cannot declare itself somebody's subagent.

A Fae subagent is deliberately **not** pinned: subagents are working memory, and
a daemon restart should not resurrect a tree of them behind the user's back.
A Floot subagent session is revived with its siblings, because Floot revives
every session it has a registry entry for; releasing the parent releases it.
