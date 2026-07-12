# Agent Follow-Stream Tool

| | |
|---|---|
| **Created** | 2026-05-12 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | Steward dispatch 2026-05-12: agent-side analog of the Monitor harness tool |

## What is the Problem Being Solved?

> Please dispatch a designer to propose a tool for our lal and fae
> agents that will enable them to "follow" an exo stream (currently a
> passable async iterator), receiving messages from a program that is
> running in the background until cancelled.
> The agent would see the Justin representation of the passable data
> that transits the stream, as it arrives.
> This could be used for event monitoring, analogous to the Monitor
> tool.

The unmistakable goal: an agent (lal or fae) needs a way to *attend*
to a long-running passable stream without giving up its turn.
Streams in the daemon (e.g. `followMessages`, `followNameChanges`,
`followPeerChanges`, `followCommands`, `followRetentionSet`, channel
`followMessages`, the just-introduced `streamBase64` from
`@endo/exo-unzip`, and any user-authored exo that returns
`makeIteratorRef(asyncGenerator())`) emit passable values over time.
Today an agent has no idiomatic way to consume them.

The mental model to mirror is Claude Code's `Monitor` tool: arm a
background watcher whose stdout-line-per-event surfaces as a
`<task-notification>` between tool calls.
The agent stays free to do other work, and each event arrives as a
side-channel notification it can read when the harness next consults
its message queue.

## Status quo

Inside the agent (see `packages/lal/agent.js` and
`packages/fae/agent.js`), the only current way to consume a stream is
to issue an `evaluate`/`exec` tool call whose body opens the iterator,
drains it inline, and returns the buffered list as the tool result.
The pattern looks like:

```js
// Today, via fae's exec or lal's evaluate:
const iter = E(target).followMessages();
const messages = [];
for await (const msg of iter) {
  messages.push(msg);
  if (messages.length >= 50) break;  // arbitrary cutoff
}
return messages;
```

This has four user-visible failures:

1. **Eager drain.** The `for-await-of` only returns when the iterator
   ends or a hard cap fires.
   For `followMessages` (which is intended to run for the lifetime of
   the inbox), the call never returns.
2. **Tool-call blocking.** Even with a cap, the agent's turn stalls on
   the loop.
   The LLM cannot interleave other reasoning, cannot reply to a
   parallel inbox message, and cannot cancel.
3. **Loss of the live signal.** Once buffered into a returned list,
   the events lose their temporal ordering relative to the agent's
   own actions.
   The agent cannot react to event N before event N+1 has been
   produced because it does not see N until the loop completes.
4. **No cancellation handle.** A subsequent tool call has no way to
   say "stop the iterator I started two turns ago."
   The only way to free the producer is to crash the worker.

The `daemon-message-streaming` design covers an analogous gap on the
*sender* side.
This design covers the gap on the *consumer* side, specifically for
agents that do not block their tool-loop.

## Proposed tool

### Tool name

`monitor` (per the maintainer's naming call on the PR review; see the
resolved tool-name decision under "Open questions" below).
The name mirrors Claude Code's `Monitor` tool, whose mental model this
design deliberately transfers to the agent (see "Comparison to
Monitor").
A complementary `cancelMonitor` tool releases an active subscription.
`peekMonitor` is reserved for a future read-without-cancel surfacing of
a frame buffer, but is out of scope for the MVP.

### Inputs

```jsonc
{
  "name": "monitor",
  "description": "Subscribe to a passable async-iterator capability ...",
  "parameters": {
    "type": "object",
    "properties": {
      "petNameOrPath": {
        "oneOf": [
          {"type": "string"},
          {"type": "array", "items": {"type": "string"}}
        ],
        "description": "The pet name or path of the iterator-returning capability to follow."
      },
      "method": {
        "type": "string",
        "description": "Method name to invoke on the capability that returns the async iterator (default 'followMessages')."
      },
      "args": {
        "type": "array",
        "description": "Optional arguments to pass to the method, decoded as SmallCaps."
      },
      "label": {
        "type": "string",
        "description": "Short label that appears at the head of every notification from this stream."
      },
      "maxFramesPerNotification": {
        "type": "integer",
        "description": "Coalesce up to N frames into one notification (default 16)."
      },
      "frameBudget": {
        "type": "integer",
        "description": "Cancel automatically after this many frames (default unbounded)."
      },
      "filter": {
        "type": "string",
        "description": "Optional pattern guard (M.* expression), parsed as SmallCaps; only frames matching the guard are surfaced."
      }
    },
    "required": ["petNameOrPath"]
  }
}
```

The result of a successful `monitor` call is a small record:

```js
{
  handle: 'monitor-7',         // opaque, monotonic per worker
  capability: 'my-counter',   // echo of the resolved input
  method: 'followMessages',
}
```

The handle is used by `cancelMonitor` and identifies which subscription
a notification belongs to.

### `cancelMonitor`

```jsonc
{
  "name": "cancelMonitor",
  "description": "Stop following a stream and release the iterator (calls iter.return()).",
  "parameters": {
    "type": "object",
    "properties": {
      "handle": {"type": "string", "description": "The handle returned by monitor."}
    },
    "required": ["handle"]
  }
}
```

Cancellation is idempotent.
A `cancelMonitor` against an unknown handle returns
`{ already: 'closed' }` rather than throwing, so the LLM does not have
to know the precise close-state of every stream it ever opened.

### Notification shape

Each event surfaces in the agent's chat transcript as a single `tool`
or `system`-role message (depending on which tool harness convention
the model expects), structured as:

```
<monitor-notification handle="monitor-7" label="my-counter">
[depth:N seq:42 ts:2026-05-12T17:04:33Z]
{Justin-rendered passable}
</monitor-notification>
```

When `maxFramesPerNotification > 1`, multiple frames are concatenated
inside one notification block, each on its own line, with a shared
prefix:

```
<monitor-notification handle="monitor-7" label="my-counter" frames="3">
[seq:42 ts:2026-05-12T17:04:33Z] { type: 'add', name: 'counter-7' }
[seq:43 ts:2026-05-12T17:04:33Z] { type: 'add', name: 'counter-8' }
[seq:44 ts:2026-05-12T17:04:34Z] { type: 'remove', name: 'counter-3' }
</monitor-notification>
```

Two terminal notification kinds close the stream:

```
<monitor-notification handle="monitor-7" terminal="done">
Stream completed cleanly after 244 frames.
</monitor-notification>

<monitor-notification handle="monitor-7" terminal="error">
Error{message: "lost connection to remote daemon"}
</monitor-notification>
```

The XML-ish framing is chosen for two reasons.
First, it parallels the `<tool_call>` extraction already in
`packages/lal/agent.js` (`extractToolCallsFromContent`), so the same
stripping logic applies on round-trip.
Second, modern LLMs reliably treat opening tags they did not author
as data, not as instruction; the `<monitor-notification>` wrapper
prevents prompt injection from a hostile producer (a remote sender
who emits `</tool_call>` cannot escape the surrounding tag because the
content is rendered through `passableAsJustin`, which JSON-quotes
strings).

## Lifecycle

```
agent                                follow harness               iterator producer
  │                                         │                              │
  ├─ tool: monitor(my-iter) ──────────────► │                              │
  │                                         ├─ E(cap).followMessages() ──► │
  │ ◄───────── handle="monitor-7" ──────────┤                              │
  │                                         │ ◄─── { value, done:false } ──┤
  │                                         │ (buffer / coalesce)          │
  │ ◄ <monitor-notification>... </> (queued)┤                              │
  ├─ tool: someOtherWork() ───────────────► │                              │
  │ ◄──────── result + queued frames ───────┤                              │
  ├─ tool: cancelMonitor("monitor-7") ────► │                              │
  │                                         ├─ iter.return() ─────────────►│
  │ ◄────── { handle, status: "closed" } ───┤                              │
```

Steady state:

1. The agent calls `monitor(petName)`.
2. The agent's worker resolves the pet name to a remote
   capability and calls the configured method (`followMessages` by
   default), wrapping the returned iterator-ref with
   `makeRefIterator` from `@endo/daemon/ref-reader.js`.
   The wrapper is parked in a per-worker `Map<handle, subscription>`.
3. A background pump reads the iterator and pushes each frame into a
   queue keyed by handle.
   The pump is structured to never block on the agent: a slow LLM
   does not exert backpressure on the producer past the configured
   buffer size.
4. Between the agent's tool calls (the natural quantum where the
   harness composes the next prompt), the harness drains the queue,
   coalesces frames per the per-stream
   `maxFramesPerNotification`, renders each batch with
   `passableAsJustin`, and prepends the resulting
   `<monitor-notification>` blocks to the next user-role turn the
   LLM sees.
5. When the iterator yields `{ done: true }`, the harness emits a
   terminal notification with `terminal="done"` and removes the
   subscription.
   When the iterator throws, the harness emits a terminal
   notification with `terminal="error"` and the
   `passableAsJustin`-rendered error.
6. `cancelMonitor(handle)` calls `iter.return()` and, on success,
   removes the subscription.
   No terminal notification is emitted for an agent-initiated
   cancellation; the caller already knows.
7. When the worker loop exits (cancellation, agent removal,
   process shutdown), every still-open handle is cancelled
   automatically.

The lifecycle integrates into the existing `runAgenticLoop` in
`packages/lal/agent.js` at the same join point that already polls
`notificationQueue` (line 1387) and `pendingProposals` (line 1390):
a third condition, `subscriptions.size > 0 && frameQueue.length > 0`,
keeps the loop alive long enough to surface late-arriving frames.

## Justin rendering

Each frame is rendered with
`passableAsJustin(frame, /* shouldIndent */ false)` from
`@endo/marshal`.
The same renderer the lal agent already uses for tool-call arguments
and tool results (see `agent.js:1307` and `agent.js:1313`), so the
visual grammar is consistent across all agent-visible passable values.

Justin handles the passable space as follows (cross-checked against
`packages/marshal/src/marshal-justin.js`):

| Passable kind        | Justin rendering                                                |
|----------------------|-----------------------------------------------------------------|
| string               | `"hello\nworld"` (JSON-quoted, so newlines escape)              |
| number               | `42`, `3.14`, `NaN`, `Infinity`, `-Infinity`                    |
| bigint               | `123n`                                                          |
| boolean / null       | `true`, `false`, `null`                                         |
| undefined            | `undefined`                                                     |
| symbol               | `Symbol.for("name")` or `Symbol.asyncIterator` etc.             |
| array                | `[1, "two", 3n]`                                                |
| copyRecord           | `{ name: "alice", age: 30 }`                                    |
| copyTagged           | `makeTagged("tagName", payload)`                                |
| remotable            | `slot(0, "Iface")` — a numeric slot reference, with iface name  |
| promise              | `slot(1)` — slot reference (no special iface)                   |
| error                | `Error("oops")` (or `TypeError(...)`, etc.)                     |
| async iterator       | `slot(2, "Alleged: AsyncIterator")` (slot, no special syntax)   |

Slots are rendered with their interface name when known, which gives
the agent a useful hint about what kind of remote value just arrived.

Per the Endo project guideline on diagnostic discipline (see root
`CLAUDE.md`: "When rendering a passable value for a log message, use
`passableAsJustin` from `@endo/marshal` rather than `JSON.stringify`,
which produces ambiguous output for remotables and promises"), Justin
is the right rendering for this surface and not, say, `JSON.stringify`
or `util.inspect`.

### Truncation policy

Justin output for a single frame is truncated at 4 KiB by default
(per stream, configurable via `maxFrameChars`).
The truncation marker is placed inside the
`<monitor-notification>` wrapper:

```
<monitor-notification handle="monitor-7" truncated="true">
[seq:42] { large: { many: [...
... 12 KiB of Justin elided (frame seq 42 was 16 KiB) ...
] } }
</monitor-notification>
```

This matches Claude Code's existing `Bash` and `Read` output
truncation policy for non-stream tools, which the agent already
expects to sometimes see.

`Uint8Array` payloads (the most common reason a frame would be very
large, e.g. `streamBase64` from `@endo/exo-unzip`) are rendered with
their length and a base64-of-prefix preview, not the full body.
A producer that wants the agent to see full bytes can pass them as
strings; the Justin rendering of an inline `Uint8Array` would not be
readable to an LLM regardless.

## Backpressure and buffering

The harness maintains a per-handle frame queue with these defaults:

- **Bounded depth.** Each subscription has a `bufferDepth` (default
  256 frames).
  When the queue is full, new frames are dropped from the *oldest*
  end (a "ring drop") and a single counter `droppedSinceLastDrain`
  is incremented.
- **Coalesced surfacing.** When the agent's tool loop polls the
  queue, all queued frames for a stream surface in a single
  `<monitor-notification>` block per the
  `maxFramesPerNotification` limit; if the queue holds more than
  the limit allows, multiple notifications are emitted in order.
- **Drop annotation.** If `droppedSinceLastDrain > 0`, the first
  notification of the next drain prepends a sentinel:
  ```
  <monitor-notification handle="monitor-7" dropped="14">
  ... 14 older frames were dropped because the buffer overflowed.
  </monitor-notification>
  ```

### Why ring-drop-oldest is the default

Three policies were considered:

| Policy                     | Pro                                          | Con                                              |
|----------------------------|----------------------------------------------|--------------------------------------------------|
| **A. Buffer all**          | Lossless                                     | Unbounded memory; breaks "agent does not block producer" |
| **B. Drop oldest (ring)**  | Bounded; fresh signal preserved              | Old frames lost; producer never paused           |
| **C. Coalesce-and-summarize** | Lossless in summary; bounded                | Summaries are domain-specific; hard to make general |

**The MVP picks Option B** (drop oldest with a counter).
Rationale: the producer must not be blocked on agent attention; "what
is happening *now*" is almost always more useful to an agent than
"what happened earlier"; and the dropped-counter sentinel preserves
the *fact* of loss so the agent does not silently skip events.

For producers that genuinely cannot tolerate loss (audit log,
financial events), the agent can request a higher `bufferDepth` per
subscription, or implement Option C in their own handler by piping
the stream through a `coalesce` exo before subscribing.

This decision is one of two specifically called out under "Open
questions" because it bears on user-visible behaviour.

## Failure modes

| Trigger                        | Surfaces as                                                                   |
|--------------------------------|-------------------------------------------------------------------------------|
| Iterator throws                | `<monitor-notification terminal="error">` with the Justin-rendered error.      |
| Iterator yields `done: true`   | `<monitor-notification terminal="done">` with the final frame count.           |
| Network drop on remote stream  | Underlying CapTP rejection bubbles through to `terminal="error"`.             |
| Slow agent attention           | Ring-drop oldest; `dropped="N"` annotation on next surfaced notification.     |
| `petNameOrPath` does not exist | Synchronous tool-call rejection (no handle issued).                           |
| Capability lacks the method    | Synchronous tool-call rejection from the `E(cap).method()` send.              |
| Worker process exit            | All open subscriptions are cancelled (`iter.return()`), no notifications.    |
| Agent loop exits normally      | All open subscriptions are cancelled before the loop returns.                 |

The "synchronous" rejections in the table are observable to the LLM
as ordinary tool-call errors (e.g. the `{ error: errorMessage }` shape
that `processToolCalls` already returns at `agent.js:1317`); the LLM
can decide whether to retry with a different name.

## Integration with lal/fae existing tool harness

### lal

`packages/lal/agent.js` registers tools as flat entries in the `tools`
array (line 28) and dispatches via `executeTool` switch (line 1004).
This design adds two new cases to that switch (`monitor`,
`cancelMonitor`) and one new piece of per-worker state inside
`spawnWorkerLoop` alongside the existing `nodeCache`,
`activeLeafNode`, etc.:

```js
/** @type {Map<string, Subscription>} */
const subscriptions = new Map();

/** @type {Array<{handle: string, frame: unknown, seq: number, ts: string}>} */
const frameQueue = [];

let nextHandle = 0;
let nextSeq = 0;
```

The harness loop in `runAgenticLoop` (line 1336) gains a fourth
condition for whether to keep looping:

```js
} else if (frameQueue.length > 0 || subscriptions.size > 0) {
  // Drain the queue; if empty but subscriptions are still open, wait
  // briefly for a frame before returning to chat.
  await drainFramesIntoNextTurn(leafNode);
}
```

`drainFramesIntoNextTurn` formats one or more
`<monitor-notification>` blocks and pushes them as a single `user`-role
message into `leafNode.messages`, mimicking the way `formatInboundMessage`
introduces inbox messages today.

### fae

`packages/fae/src/tool-makers.js` exports per-tool factories
(`makeReplyTool`, `makeExecTool`, etc.) that return objects matching
the `FaeTool` interface (`schema()`, `execute()`, `help()`).
Two new factories follow the same shape:

```js
export const makeFollowStreamTool = (powers, registry) => harden({ ... });
export const makeCancelStreamTool = (powers, registry) => harden({ ... });
```

The `registry` argument is a small object that owns the
`subscriptions` Map and the `frameQueue` so the two factories share
state, and so the agent's outer loop can also access them for drain-
on-exit cleanup.

The fae agent's loop (`packages/fae/agent.js`) needs an analogous
drain hook between tool calls.
The exact shape is symmetric to lal's; both packages share enough
behaviour that the registry, drain function, and notification
formatter could be lifted into a shared module
(`packages/agent-stream-follow/`?) in a follow-up.
The MVP lands the implementation per-agent and defers consolidation.

## Comparison to Monitor

| Dimension              | Monitor (Claude Code)                       | monitor (this design)                          |
|------------------------|---------------------------------------------|-----------------------------------------------------|
| What it watches        | A child process's stdout                    | A passable async iterator over CapTP                |
| Frame format           | One stdout *line* per notification          | One *passable value* per notification               |
| Rendering              | Raw text                                    | `passableAsJustin` rendering                        |
| Identity               | Process pid                                 | Per-worker opaque handle                            |
| Authority              | Inherits the agent harness's process rights | Authority is in the capability the petname resolves to |
| Cancellation           | Kill child; harness teardown                | `cancelMonitor(handle)` calls `iter.return()`        |
| Buffering              | Harness-internal, line-based                | Per-handle frame queue with ring-drop-oldest        |
| Coalescing             | Implicit (chunks of stdout)                 | Explicit `maxFramesPerNotification`                 |
| Side-channel surfacing | `<task-notification>` between tool calls    | `<monitor-notification>` between tool calls          |
| Termination signal     | Process exit                                | Iterator `done: true` or thrown error               |

The mental model the LLM forms for Monitor transfers directly: "I
asked for it, the harness will surface frames between my actions, and
I cancel when I am done."
The implementation underneath is entirely different (no fork, no pipe,
no shell quoting); the *interface* is the part that needs to be
familiar.

## Phased plan

### Phase 1 (MVP)

- `monitor(petNameOrPath, [method], [label],
  [maxFramesPerNotification])` returning a `handle`.
- `cancelMonitor(handle)`.
- Per-worker subscription registry and frame queue with
  ring-drop-oldest.
- Drain hook in the agent loop that surfaces queued frames as
  `<monitor-notification>` user-role messages.
- Justin rendering with the 4 KiB per-frame truncation policy.
- Terminal notifications for `done` and `error`.
- Cleanup on worker exit.

### Phase 2 (followups)

- `filter` parameter accepting a serialised `M.*` pattern that the
  harness applies to each frame before queueing.
- `frameBudget` parameter for auto-cancel after N frames.
- A `peekMonitor(handle)` tool that returns the current queued frames
  without consuming them, for explicit polling.
- Cross-conversation persistence: a subscription opened in transcript
  T1 can be inherited by transcript T2 if the same agent reincarnates,
  by storing handle metadata under a `streams/` pet name.
- Lifting the registry, drain, and formatter into a shared
  `@endo/agent-streams` package consumed by both lal and fae.
- A daemon-side `coalesce` exo that fronts an iterator with a
  user-controllable summarising rule (count, time-window, key-grouped
  digest) and can be subscribed-to in place of the raw iterator.

### Out of scope

- Replay-from-snapshot of an iterator's history.
  The iterator contract has no notion of "rewind"; the daemon's
  `followNameChanges` is the closest thing (yields current state
  before subsequent changes), and that behaviour is the producer's
  contract, not the harness's.
- Multi-stream merge (one notification block interleaving frames from
  several handles).
  Per-handle blocks already give the LLM enough to reconstruct order
  via the `seq` and `ts` annotations; merging is rendering preference
  and can be done downstream.
- Producer-side acknowledgement.
  The harness drains by reading the iterator; whether the producer
  needs to know "the agent saw this frame" is a contract between the
  agent and the producer's domain protocol, not a transport feature.

## Open questions

1. **Tool-name pick — RESOLVED: `monitor`.** The maintainer's call on
   the PR review is to name the tool `monitor`, and the design adopts
   it throughout (companions `cancelMonitor` and the reserved
   `peekMonitor`). The name leans directly on Claude Code's `Monitor`
   tool, whose mental model this design mirrors, so an LLM that knows
   Monitor discovers it immediately.

   The candidates originally weighed here, for the record:
   - `followStream` — verb form matched the daemon's own `follow*`
     family of methods and read as "subscribe to a stream until I
     cancel," but did not carry the Monitor mental model in its name.
   - `subscribeStream` — clearer to readers who do not know
     `followMessages`/`followNameChanges`, but stutters with the verb
     phrase the agent already says ("subscribe to the stream
     subscription").
   - `monitorCapability` — discoverable for an LLM that knows Monitor,
     but "capability" is too broad (the tool only accepts
     iterator-returning methods) and the verb-noun word order is
     inconsistent with the rest of the lal/fae tool set. The chosen
     bare `monitor` keeps the Monitor association without those
     drawbacks.

2. **Buffer discipline default.** The MVP picks **drop-oldest with a
   counter** (rationale above).
   The alternatives were:
   - *Buffer all* would let an agent miss nothing but lets a chatty
     producer exhaust worker memory.
   - *Coalesce-and-summarize* needs a per-domain summarizer to be
     useful, which the harness cannot supply generically.

   This is the most consequential choice in the design; the maintainer
   should affirm that "live signal beats lossless history" is the
   right default before MVP ships.

3. **Lal/fae-specific or shared?** The MVP lands in each package
   independently to avoid blocking on a packaging decision; a Phase-2
   followup proposes lifting it into
   `@endo/agent-streams`.
   Maintainer call: is the right consolidation point a new package,
   an addition to `@endo/lal`'s exported surface, or a section of
   `@endo/exo-stream`?

4. **Stream handle representation.** Three options:
   - **Opaque per-worker token** (recommended; e.g. `"monitor-7"`):
     simple, no daemon round-trip, no formula identifier leaked.
   - Pet name: would let the agent `lookup(handle)` later, but
     conflates a transient subscription with a persistent name and
     would require the agent to clean up.
   - Formula id: precise, but exposes daemon internals to the LLM
     and ties a transient subscription to the permanent formula
     graph.

5. **Authorization model.** The proposed semantics are
   "authority-by-capability": if the agent's pet name resolves to a
   capability that exposes the requested method, the agent can
   subscribe.
   No additional grant is required.
   This matches every other agent tool that takes a pet name
   (`evaluate`, `inspect`, `readText`, `writeText`).
   Maintainer should confirm this is the right boundary; an alternative
   would be a per-capability "follow" grant that the host issues
   separately, but that adds friction for the common case.

6. **Cross-worker delivery.** If an agent is sharded across multiple
   worker loops (the manager pattern in `packages/lal/agent.js` and
   `packages/fae/agent.js`), should `monitor` opened in worker
   A be visible to worker B?
   The MVP says no (subscription registry is per-worker), but a
   future "agent monitor inbox" could surface them centrally.

## References

- `packages/lal/agent.js` — current lal tool registration and dispatch
  surface; the worker loop and `runAgenticLoop` integration point.
- `packages/fae/agent.js`, `packages/fae/src/tool-makers.js` — current
  fae tool factory pattern.
- `packages/exo-stream/README.md`,
  `packages/exo-stream/DESIGN.md`,
  `packages/exo-stream/PROTOCOL.md` — the Exo Stream Protocol that
  passable async iterators ride on.
- `packages/marshal/src/marshal-justin.js` — `passableAsJustin`
  semantics used for frame rendering.
- `packages/daemon/src/daemon.js` — the canonical follow-stream
  producers (`followMessages`, `followNameChanges`,
  `followLocatorNameChanges`, `followPeerChanges`,
  `followRetentionSet`).
- `packages/daemon/src/pet-store.js` — `followNameChanges` on the
  pet-store side.
- `packages/chat/microblog-component.js` — channel `followMessages`
  consumer (an existing in-tree client that this design's harness
  could replace if the chat client were rewritten to use it).
- [`daemon-message-streaming.md`](daemon-message-streaming.md) — the
  *sender*-side complement of this design (incremental message
  composition).
- [`daemon-agent-tools.md`](daemon-agent-tools.md) — the umbrella
  design for agent tool surfaces (`fs`, `shell`, `git`); this
  proposal adds a `monitor` tool to the same surface.
- [`chat-slot-slash-commands.md`](chat-slot-slash-commands.md) —
  another design that surfaces ephemeral, agent-driven values
  through the same pet-store boundary, illustrating the existing
  precedent for "transient handle, no permanent name."
- [`endor-bus-tui.md`](endor-bus-tui.md) — analogous problem on the
  TUI side: a worker contributes UI through a CapTP-mediated
  notification stream rather than direct access; same architectural
  shape, different surface.

## Prompt

> Please dispatch a designer to propose a tool for our lal and fae
> agents that will enable them to "follow" an exo stream (currently a
> passable async iterator), receiving messages from a program that is
> running in the background until cancelled.
> The agent would see the Justin representation of the passable data
> that transits the stream, as it arrives.
> This could be used for event monitoring, analogous to the Monitor
> tool.
