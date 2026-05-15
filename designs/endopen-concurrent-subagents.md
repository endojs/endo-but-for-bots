# EndOpen: Concurrent Subagent UX

|             |                                              |
|-------------|----------------------------------------------|
| **Created** | 2026-05-15                                   |
| **Author**  | kriscendobot (prompted by kriskowal)         |
| **Status**  | Not Started                                  |
| **Source**  | [`endopen.md`](endopen.md) § Gap 1           |

## What is the Problem Being Solved?

OpenCode's `task` tool can spawn one subagent at a time and wait for it
to finish before the parent can do anything else.
The `background: true` flag (gated behind
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` at
[`packages/opencode/src/tool/task.ts`](../../external/opencode/packages/opencode/src/tool/task.ts)
line 113) lets the parent fire-and-forget,
but the result must be manually polled via `task_status` or arrives
as a toast notification when the background task completes.
This is a single-process constraint dressed up as a feature:
OpenCode's agent runs in one process with one event loop,
and "concurrent subagents" really means "context-switch between fibers".

Endo's structural model makes this trivial.
Every guest is its own *vat*:
its own message queue plus its own SES compartment plus its own worker
process when configured.
(A *vat* in the OCapN sense is the unit of isolation a guest runs in.
See [daemon-capability-filesystem](daemon-capability-filesystem.md) for
the capability-graph story and `formula-type.js` for the durable types.)
A guest spawning a sibling guest is a regular `formulateGuest` + `send`
interaction.
The runtime can have 10 guests in flight at once with no special flag.

The gap is **not** concurrency itself;
it is the **UX surface** that exposes the concurrency.
Today, a user who spawns guest A and guest B in Chat sees two adjacent
spaces with no parent-child relationship,
no panel widget, no aggregation of replies.
The OpenCode `task` shape (one tool call from a parent,
one folded result block in the parent's transcript) is good UX even if
its underlying mechanism is single-threaded;
Endo can offer the *same* UX while underneath running the children truly
in parallel.

## Design

### Concept: the "panel" guest pattern

A **panel** is a guest formula whose role is to coordinate `N`
sibling sub-guests, dispatch a prompt to each, await their replies,
and present the aggregated result to its parent.
The panel is a new guest *role* (its agent module shape),
not a new formula type;
from the daemon's perspective it is an ordinary guest.

Vocabulary:

- The coordinator guest itself is the **panel**.
- The guest that creates a panel is the **panel parent**.
- The sibling sub-guests a panel dispatches to are its **panel members**.
- The aggregated reply a panel returns to its parent is the **panel verdict**.

The panel parent calls `E(panel).deliberate(prompt, options)`. The
panel formulates `N` member guests (or reuses pre-existing pet-named
ones), sends each the prompt as a `request` message, gathers each
member's reply, and resolves the deliberate-promise with the
aggregated verdict.

### Chat UX: the panel widget

In `packages/chat`, panel deliberations render as a single
collapsible block in the panel-parent's space:

```
┌─ Panel: 3 members deliberating ────────────────────────┐
│ ▾ assessor   ✓ done (2.3s, 412 tok)    [view reply]    │
│ ▾ stylist    ⠋ thinking…                                │
│ ▾ archivist  ✓ done (1.8s, 287 tok)    [view reply]    │
│                                                         │
│ Verdict: 2 of 3 agree on the approach; stylist pending │
└─────────────────────────────────────────────────────────┘
```

Each row links to the member's own space (which has its own inbox
and transcript, addressable independently);
clicking "view reply" expands the inline part.
The widget updates in real time via the existing Chat WebSocket
subscription on the parent's inbox;
the parent receives one `value` message per member that resolves,
plus one final aggregated `value` when the panel concludes.

The OpenCode shape this borrows from: the `<task_result>` block in
[`task.ts`](../../external/opencode/packages/opencode/src/tool/task.ts)
lines 53 through 88 (`output()` and `backgroundMessage()` formatters)
collapses subagent output into a single block in the parent's transcript.
The Chat widget is the same shape, with the difference that the
underlying execution is genuinely concurrent.

### Daemon: the panel agent module

The panel is an agent module. Its `make(powers)` entry point
receives:
- `provideGuest`: to formulate panel members on demand.
- `inbox` / `submit`: standard guest plumbing for parent communication.
- `Timer`: for per-member deadlines ([endoclaw-timer](endoclaw-timer.md)).
- a `Lal` or `Fae` provider capability: to ask the LLM for an aggregation strategy (optional).

API (sketch):

```js
// @ts-check
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

export const make = ({ provideGuest, inbox, Timer }) =>
  makeExo(
    'Panel',
    M.interface('Panel', {
      deliberate: M.call(M.string()).optional(M.record()).returns(M.promise()),
    }),
    {
      async deliberate(prompt, options = {}) {
        const memberNames = options.members ?? ['assessor', 'stylist', 'archivist'];
        const deadline = options.deadlineMs ?? 60_000;
        const members = await Promise.all(
          memberNames.map((name) => E(provideGuest).provideGuest(name)),
        );
        const settled = await Promise.allSettled(
          members.map(async (member) => {
            const reply = await Promise.race([
              E(member).request(prompt),
              E(Timer).delay(deadline).then(() => { throw Error('panel-member-timeout'); }),
            ]);
            return reply;
          }),
        );
        return aggregate(settled);
      },
    },
  );

const aggregate = (settled) => harden({
  members: settled.length,
  agreed: settled.filter((s) => s.status === 'fulfilled').length,
  verdicts: settled.map((s) => s.status === 'fulfilled' ? s.value : { error: String(s.reason) }),
});
```

Each `E(member).request(prompt)` returns a promise that resolves when
the member's reply lands in the panel's inbox.
Because each member is its own guest (its own worker, its own SES
compartment), the `Promise.allSettled` over them is genuinely parallel;
there is no single event loop they share.
This is the "falls out of Endo trivially" the maintainer named.

### CLI surface

```
endo panel @code-review "review the diff in mount://workspace/wip"
endo panel @design-jury --members=critic,skeptic,copyeditor "design X"
```

The CLI subcommand creates a panel guest if one is not already named,
dispatches `deliberate`, and prints the verdict.

### Permission / capability story

The panel is a guest.
To formulate member sub-guests, it needs a `provideGuest` capability.
The panel parent grants this when it creates the panel;
the parent retains the right to revoke
(the caretaker pattern from
[daemon-capability-filesystem](daemon-capability-filesystem.md)).
Members hold whatever capabilities the panel was authorized to hand them;
the panel cannot escalate.

The Endo *advantage* is that the permission story is structural:
a member that the panel did not endow with a `Shell` cannot invoke a
shell, period.
OpenCode's `subagent-permissions.ts` derives a stricter ruleset for
the child
(at [`packages/opencode/src/agent/subagent-permissions.ts`](../../external/opencode/packages/opencode/src/agent/subagent-permissions.ts));
Endo derives a strictly smaller capability set,
which is the same idea expressed structurally.

### Reuse: the panel as the judge's tool

The garden's `judge` role already runs jury panels by dispatching
subordinate roles in sequence
(per `skills/pr-creation-flow/SKILL.md` § Jury composition).
The judge dispatches one of two panel kinds per PR:
a 12-seat **code panel** for source-touching PRs and a 5-seat
**design panel** for design-only PRs;
the two are dispatched independently, never as one 17-seat round.
If the garden's host daemon were Endo, the panel pattern would *be*
the judge:
each panel's seats deliberate concurrently, the judge aggregates.
This is a strong validation of the shape.

## Phased Implementation

1. **Daemon-level panel agent module**
   (`packages/lal/panel.js` or a new `packages/panel/`):
   the `Panel` exo, the `deliberate` method, the per-member timeout,
   the aggregation function.
   ~200 LOC.
   **Size: S-M.**
2. **Chat UX widget**:
   a new message-part type `panel-deliberation` rendered as a
   collapsible block;
   per-member status pulled via `followMessages` on each member's inbox.
   ~400 LOC in `packages/chat`.
   **Size: M.**
3. **CLI subcommand**:
   `endo panel <pet-name> <prompt>`;
   one new file under `packages/cli/src/`.
   ~100 LOC.
   **Size: S.**
4. **Permission view in Chat** (deferred but listed):
   a panel widget that lets the parent see which capabilities each
   member holds and revoke individually.
   **Size: M.**
   Cross-references [daemon-retention-paths](daemon-retention-paths.md).

Total: 3 to 4 weeks for phases 1-3; phase 4 is independent.

## Dependencies

| Design                          | Relationship                                         |
|---------------------------------|------------------------------------------------------|
| [endoclaw-timer](endoclaw-timer.md) | Provides the per-member deadline mechanism      |
| [daemon-capability-filesystem](daemon-capability-filesystem.md) | Provides the caretaker / revoke pattern for member capabilities |
| [daemon-form-request](daemon-form-request.md) | Members may use form-request to ask the parent for input mid-deliberation |
| [daemon-mount](daemon-mount.md) | Members may share a read-only mount as the deliberation target |

## Open Questions

- **Member identity**:
  do panel members survive the panel?
  Default proposal: yes, members are durable guests addressable by
  pet-name;
  the panel is a coordinator, not an owner.
  Alternative: panel-scoped ephemeral members that get GC'd with the panel.
  The first is more useful for repeat deliberations;
  the second is more hygienic.
- **Aggregation strategy**:
  does the panel apply a tally / majority / LLM-aggregation,
  or simply hand back all member verdicts?
  Proposal: hand back all verdicts plus a default `agreed` count;
  the parent's agent module decides how to use them.
  Custom panels can override `aggregate()`.
- **Streaming**:
  do member verdicts stream into the parent's transcript as they land,
  or only after all members complete?
  Proposal: stream, with the widget rendering progress;
  the final aggregated `value` is a separate trailing message.
- **Concurrency bound**:
  is there a daemon-level cap on the number of concurrent panel members?
  Proposal: no hard cap;
  rely on the formula-store back-pressure (worker provisioning fails
  gracefully when out of slots).
  Document the practical cap based on observed worker memory.

## Design Decisions

1. **Panel is a guest, not a new formula type.**
   The 30 formula types
   ([`packages/daemon/src/formula-type.js`](../packages/daemon/src/formula-type.js)
   lines 6 through 37) already cover everything the panel needs.
   Adding a 31st would constrain the design to one shape;
   making the panel a *role* (agent module) lets variants like the
   design-jury panel and the code-review panel coexist without
   daemon-side plumbing.

2. **Aggregation lives in JS, not in the LLM.**
   The default aggregator counts agreement;
   LLM-based aggregation (asking the panel's own LLM to summarize the
   members' replies) is an opt-in option, not the default.
   Reason: deterministic aggregation is cheaper and debuggable;
   LLM aggregation can be added per-panel.

3. **Considered and rejected: panels-as-formula-type.**
   Reason: a formula type per role explodes the type registry;
   the guest-with-capabilities pattern is sufficient and consistent
   with how Lal and Fae are modeled today.

## Related Designs

- [endopen](endopen.md) — primary comparative analysis.
- [endor-tui](endor-tui.md) — M6 Rust TUI; would render panels in the terminal idiom.
- [endopen-tui-shell](endopen-tui-shell.md) — browser-side
  opencode-shaped space that uses the panel widget.
- [judge role in the garden](../../../garden/roles/judge/AGENT.md) —
  informs the multi-member-deliberation shape.

## Prompt

> Concurrent subagent execution which would fall out of endo more trivially given its formula isolation + capability model.
>
> kriskowal, 2026-05-15
