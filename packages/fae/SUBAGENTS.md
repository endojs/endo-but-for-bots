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

`claim` consumes two more kinds of message, for the same reason:
a further reply to an ask that is already over — answered, or timed out — and
any mail from a subagent the registry has asked that answers no ask at all.
Either one, left to fall through, would be answered by the parent, and the
subagent would answer that: a subagent speaks to its parent by answering asks,
and nothing else it sends starts a turn.

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
  spawn(name: string, options?: {
    systemPrompt?: string;
    capabilities?: { name: string; value: unknown }[];
  }):
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

Floot provider and hosted backends both receive the built-in Endo delegation
tools from the same tool registry.
Harness-native subagent tools are disabled so helpers remain ordinary Endo
sessions with capability grants and recovery records.

### Prompts

A subagent's standing prompt is its parent's: the operator prompt the root
agent was created with (Floot's preset prompt, Fae's `createAgent`
`systemPrompt`) reaches every level of the tree — a Fae spawner caplet carries
it as `SUBAGENT_SYSTEM_PROMPT` — and the parent model's `systemPrompt` for the
child is *appended* beneath it by `composeSubagentSystemPrompt`.
A delegation is therefore extra context under the deployment's instructions,
never a way out of them.

Floot workers are explicitly told to do their assigned work themselves by default,
including when the parent omits a role prompt.
Delegate only distinct, bounded tasks with a narrower scope and a stopping
condition; do not recursively delegate the same question to fact checkers.
Helpers do not supply missing research tools, source access, or independent
evidence merely by being separate agents.
State uncertainty, reuse helpers, and synthesize their answers.
The spawn tool's schema and `help()` repeat this guidance.

### Bounds

| Bound | Default | Where |
|---|---|---|
| Delegation depth | 2 | `FLOOT_MAX_SUBAGENT_DEPTH` / `FAE_MAX_SUBAGENT_DEPTH` |
| Live Floot descendants per root session | 8 | `FLOOT_MAX_SUBAGENTS` |
| Live standalone Fae children per parent | 8 | `FAE_MAX_SUBAGENTS` |
| Ask timeout | 86400 s, capped at 604800 s | `askSubagent`'s `timeoutSeconds` |
| Outstanding asks per subagent | 1 | `makeSubagentDelegations` |

Root sessions have depth zero: two levels permit children and grandchildren.
Agents at the depth limit receive no spawner, and Floot also checks depth at
admission against the registry ancestry.
Setting the depth to zero disables delegation; that is not the default.

Floot counts all descendants together, including provisioning reservations and
failed cleanup records, so branching and concurrent calls cannot multiply the
budget or reuse an occupied name.
The registry restores the live count after restart.
Failed provisioning releases its reservation; stopping a helper releases its
entire subtree after cleanup succeeds.
Deleting a parent first fences new spawns, drains and rolls back in-flight
creations, and then deletes descendants.
Restart recovery finishes fenced subtrees before reviving inboxes.
Unrelated root sessions have separate budgets.
Limits are a backstop: reaching one means finish with available results, not
stop and respawn a chain of equivalent helpers.

A timed-out ask releases its timer and forgets the delegation, so a reply that
arrives afterwards settles nothing.
It is still *consumed* rather than delivered to the model: left to fall through,
it would be ordinary inbound mail, the parent would answer its subagent, the
subagent would answer that, and two models would bill an unbounded exchange
nobody asked for.
An answered ask is closed the same way, so a subagent that replies twice — a
progress note and then its answer — does not start that exchange either.
The registry remembers the last 65536 closed asks for that purpose, and the last
65536 subagents it has asked, whose unsolicited mail it consumes as well; past
either bound a very late message does land in the inbox.
Teardown is depth-first, so raising the depth bound does not strand a subtree.

### Attachments

Each child keeps its own inventory and environment.
Neither spawning nor chatting implicitly copies the parent's inventory or native
checkout.
Both `spawnSubagent` and `askSubagent` accept explicit attachments:

```json
{
  "name": "researcher",
  "attachments": [
    { "name": "project", "petName": ["repository", "readonly"] }
  ]
}
```

For `spawnSubagent`, the parent resolves each local `petName` before creating the
child, and the spawner stores that value in the child's inventory under `name`.
Names must be distinct ordinary pet names; existing inventory entries cannot be
replaced.
Spawning with attachments does not send a message or start a model turn.
For `askSubagent`, add `task` to the same argument object.
Its attachments travel with that correlated task as mail edges; the child uses
`adopt` with the incoming message number and attachment name to retain them.
Later asks may supply additional capabilities in the same way.

Ordinary `send` accepts the recipient path `["subagents", "researcher"]`, and
each entry in its `petNames` array may likewise be a name or an array of path
segments.
A slash-containing string is not a path.
Providing Git or filesystem authority does not mount the parent's absolute
native path inside the child's separate shell environment.
Supply a readable snapshot for analysis or prepare a child checkout for shell
work explicitly.

A reply may carry capabilities, and both harnesses dismiss a claimed reply as
soon as it is claimed: leaving one would mean that after a restart, with no ask
pending, the reply replays as an ordinary message, the harness answers it, and
the subagent answers back — two models in an unbounded exchange.
So `askSubagent` says plainly that the attachments were not retained and
suggests asking the subagent to store the object under a pet name and report
the name instead.
A harness that keeps claimed replies in its inbox may pass
`retainsAttachments: true` to `makeSubagentTools`, and only then does the tool
tell the model to `adopt`.

## Durability

The two harnesses reach durability differently because their topologies differ.

### Names

Every formula an agent owns is named by appending to the agent's own name, and
a subagent's name is derived by infixing its parent's: agent `p`'s subagent `x`
is the host agent `p.sub.x`, whose driver caplet is `p.sub.x-driver`.

The infix delimiter is a dot because an agent name may not contain one
(`agentNamePattern` is `^[a-z][a-z0-9-]{0,62}$`, and the rule applies to root
agents as well as subagents).
That is what makes the parse unambiguous rather than merely unlikely: with a
hyphenated infix, root agents `p` and `p-sub` both derive the host name
`p-sub-sub-x`, and either could enumerate, count against its own bound, and
*tear down* the other's subagent.
A subagent name may additionally not end in `-driver`, `-spawner`, or
`-handle`, so a subagent's handle cannot be mistaken for a sibling's caplet.

Provisioning checks every name an agent will own before it creates anything, so
a collision is a refusal rather than a takeover — and so a failed provisioning
can roll back by name without removing something it did not create.

Teardown is all-or-nothing on names: it attempts every cancellation, because a
spawner caplet left running holds `host-agent`, but it drops no name unless
every one of them succeeded.
A name is the only way back to whatever survived, and cancelling is idempotent,
so a failed release leaves the tree reachable and a retry converges.

> **Upgrading from an earlier commit of this branch.** The infix was `-sub-`
> before it was `.sub.`, and there is no migration.
> A daemon that ran the earlier scheme should release its subagents before
> upgrading: afterwards their host names are no longer enumerable, so nothing
> lists, counts, or releases them.
> A legacy matcher would have to reopen the ambiguity the delimiter closed, so
> there is deliberately none.

### Revival

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
The consequence, not yet addressed, is that a revived parent still holds
`subagents/<name>` for each of them and its spawner still lists them, while
their loops are gone: an `askSubagent` to one waits out its whole timeout, and
the dead entries count against the live-subagent bound until the parent's model
stops them.
A Floot subagent session is revived with its siblings, because Floot revives
every session it has a registry entry for; releasing the parent releases it.
