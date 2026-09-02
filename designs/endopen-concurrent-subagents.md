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
[`packages/opencode/src/tool/task.ts`](https://github.com/anomalyco/opencode/blob/d59d9966/packages/opencode/src/tool/task.ts)
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
A guest does not spawn a sibling directly: `formulateGuest` /
`provideGuest` are host powers, not guest powers
(`packages/daemon/src/interfaces.js` defines them on the host
interface, absent from the guest interface). A guest that needs to
create siblings holds an *attenuated, host-constructed guest-creation
facet* (see § Permission / capability story for how it is granted and
bounded); given that facet, spawning a sibling and messaging it is a
regular `send` interaction.
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

The panel parent calls `E(panel).deliberate(prompt, options)`. Using
its host-constructed guest-creation facet (§ Permission / capability
story), the panel formulates `N` member guests (or reuses pre-existing
pet-named ones), sends each the prompt as a `request` message, gathers
each member's reply, and resolves the deliberate-promise with the
aggregated verdict.

The operation is spelled `deliberate`, not `request`, even though a
panel is itself a guest and every ordinary guest (each panel member
included) answers `request(prompt)`. The divergence is deliberate and
carries meaning: `request` is the single-prompt / single-reply verb,
whereas `deliberate` denotes a different reply cardinality: a fan-out
to `N` members returning one *aggregated verdict* envelope, with an
`options` bag selecting members and deadlines. The panel deliberately
does **not** alias `request` to `deliberate`. The two return different
reply shapes — `request` a single reply, `deliberate` an aggregate
`{ members, agreed, verdicts }` envelope — so a caller that reaches a
guest through the uniform `request(prompt)` contract must get the
single-reply shape every other guest returns, not an aggregation
envelope smuggled under the same verb. A generic caller (the ACP
adapter, or any code composing against the plain-guest verb) therefore
special-cases a panel-shaped guest and calls `deliberate` explicitly;
the distinct verb name is the signal that the reply cardinality differs.
Aliasing the two would complect the uniform guest-request contract with
the panel's fan-out aggregation — the same "hidden, unadvertised
precondition" trap [`endopen-acp-server`](endopen-acp-server.md) Design
Decision 9 names and rejects.

### Chat UX: the panel widget

In `packages/chat`, panel deliberations render as a single
collapsible block in the panel-parent's space. The following is an
illustrative UI mockup (literal rendered output, not an architecture
diagram), with ASCII stand-ins for the status glyphs:

```
+- Panel: 3 members deliberating ------------------------+
| [v] assessor   [done] 2.3s, 412 tok      [view reply]  |
| [v] stylist    [thinking...]                           |
| [v] archivist  [done] 1.8s, 287 tok      [view reply]  |
|                                                        |
| Verdict: 2 of 3 agree on the approach; stylist pending |
+--------------------------------------------------------+
```

Each row links to the member's own space (which has its own inbox
and transcript, addressable independently);
clicking "view reply" expands the inline part.
The widget updates in real time via the existing Chat WebSocket
subscription on the parent's inbox;
the parent receives one `value` message per member that resolves,
plus one final aggregated `value` when the panel concludes.

The OpenCode shape this borrows from: the `<task_result>` block in
[`task.ts`](https://github.com/anomalyco/opencode/blob/d59d9966/packages/opencode/src/tool/task.ts)
lines 53 through 88 (`output()` and `backgroundMessage()` formatters)
collapses subagent output into a single block in the parent's transcript.
The Chat widget is the same shape, with the difference that the
underlying execution is genuinely concurrent.

### Daemon: the panel agent module

The panel is an agent module. Its `make(powers)` entry point
receives:
- `guestFacet`: the host-constructed, attenuated guest-creation facet
  (deliberately *not* named `provideGuest`, since it is not the host's
  own `provideGuest`; see § Permission / capability story) used to
  formulate panel members on demand.
- `inbox` / `submit`: standard guest plumbing for parent communication.
- `Timer`: for per-member deadlines ([endoclaw-timer](endoclaw-timer.md)).
- a `Lal` or `Fae` provider capability (Fae is Lal's sibling
  LLM-provider capability): to ask the LLM for an aggregation strategy
  (optional).

API (sketch):

```js
// @ts-check
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

export const make = ({ guestFacet, inbox, Timer }) =>
  makeExo(
    'Panel',
    M.interface('Panel', {
      // No `request` alias: a panel's reply shape (an aggregate
      // envelope) differs from the plain-guest `request` contract, so
      // callers reach it through the distinctly named `deliberate`.
      deliberate: M.call(M.string()).optional(M.record()).returns(M.promise()),
    }),
    {
      async deliberate(prompt, options = {}) {
        const memberNames = options.members ?? ['assessor', 'stylist', 'archivist'];
        const deadline = options.deadlineMs ?? 60_000;
        // Each member is formulated as a distinct guest; the panel must
        // ensure each lands in its own worker (not the shared main
        // worker) so the deliberation below is genuinely parallel rather
        // than interleaved on one event loop.
        const members = await Promise.all(
          memberNames.map((name) => E(guestFacet).provideGuest(name)),
        );
        const settled = await Promise.allSettled(
          members.map(async (member) => {
            let timedOut = false;
            const reply = await Promise.race([
              E(member).request(prompt),
              E(Timer).delay(deadline).then(() => {
                timedOut = true;
                throw Error('panel-member-timeout');
              }),
            ]).finally(() => {
              // Promise.race only stops the panel *waiting* on the loser;
              // it does not stop the member's in-flight work. On timeout
              // cancel the member, so a timed-out branch cannot keep
              // running (and, if it holds an LLM capability, keep burning
              // tokens). cancel() is the deterministic-stop verb every
              // guest agent module implements (endopen-acp-server §
              // Design Decision 9); dismissing the member guest is the
              // fallback when it is ephemeral.
              if (timedOut) E(member).cancel('panel-member-timeout');
            });
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
When each member is formulated as its own guest in its own worker (its
own SES compartment, its own message loop), the `Promise.allSettled`
over them runs the members genuinely in parallel rather than interleaved
on one event loop.
This parallelism is not automatic, though: a guest's eval path falls
back to a shared main worker when no distinct worker is named
(`packages/daemon/src/guest.js`, the `workerName` / `mainWorkerId`
path), so the panel must formulate each member in its own worker rather
than co-locating it.
When it does, the concurrency is the "falls out of Endo trivially" the
maintainer named; when it does not, the members share one worker and the
panel is mechanically no better off than OpenCode's single-process
fibers.

### CLI surface

```
endo panel @code-review "review the diff in mount://workspace/wip"
endo panel @design-jury --members=critic,skeptic,copyeditor "design X"
```

The CLI subcommand creates a panel guest if one is not already named,
dispatches `deliberate`, and prints the verdict.

### Permission / capability story

The panel is a guest, and guests cannot mint guests: `formulateGuest` /
`provideGuest` are defined on the host interface, not the guest
interface (`packages/daemon/src/interfaces.js`), and the daemon's
maker-pattern rule restricts creation to the host, with guests holding
only attenuated instances (see
[daemon-capability-bank](daemon-capability-bank.md)). So the panel does
*not* receive `provideGuest` from its parent: the panel parent, being
an ordinary guest, does not hold it to give.
Instead, the **host** constructs an attenuated guest-creation facet at
panel-formulation time (a scoped maker that formulates panel members
whose capability sets are no broader than the panel parent's own) and
grants that facet to the panel. The panel parent requests panel
formulation from the host (the same host mediation every guest already
relies on to be formulated at all); the parent retains the right to
revoke the panel via the caretaker pattern from
[daemon-capability-filesystem](daemon-capability-filesystem.md).
Members hold whatever capabilities that host-scoped facet was
authorized to hand them; the panel cannot escalate beyond the parent's
own authority.

The Endo *advantage* is that the permission story is structural:
a member that the panel did not endow with a `Shell` cannot invoke a
shell, period.
OpenCode's `subagent-permissions.ts` derives a stricter ruleset for
the child
(at [`packages/opencode/src/agent/subagent-permissions.ts`](https://github.com/anomalyco/opencode/blob/d59d9966/packages/opencode/src/agent/subagent-permissions.ts));
Endo derives a strictly smaller capability set,
which is the same idea expressed structurally.

### Reuse: the panel as the garden's review panel

The garden runs jury panels as a scripted review workflow: a
supervising worker dispatches one of two panel kinds per PR (a
12-seat **code panel** for source-touching PRs and a 5-seat
**design panel** for design-only PRs), and the two are dispatched
independently, never as one 17-seat round.
If the garden's host daemon were Endo, the panel pattern here would
*be* that review workflow:
each panel's seats would deliberate concurrently, and a coordinator
would aggregate their verdicts.
This is a strong validation of the shape.

## Phased Implementation

1. **Daemon-level panel agent module**
   (`packages/lal/panel.js` or a new `packages/panel/`):
   the `Panel` exo, the `deliberate` method (no `request` alias — see
   § Concept), the per-member timeout **and its cancel-the-loser step**,
   the concurrency bound, the aggregation function.
   This phase also includes the **host-side attenuated guest-creation
   facet** the panel depends on: a scoped maker on the host interface
   that formulates panel members bounded by the panel parent's
   authority. That facet is new daemon-core plumbing (guests cannot
   supply it for themselves; see § Permission / capability story), so it
   is scoped here explicitly rather than assumed to exist.
   ~200 LOC panel module plus ~100-150 LOC host-facet plumbing.
   **Size: M** (raised from S-M once the host facet is counted).
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

Total: 3 to 4 weeks for Phases 1-3; Phase 4 is independent.

## Dependencies

| Design                          | Relationship                                         |
|---------------------------------|------------------------------------------------------|
| [endoclaw-timer](endoclaw-timer.md) | Provides the per-member deadline mechanism      |
| [daemon-capability-bank](daemon-capability-bank.md) | Establishes the host-mediated maker pattern the panel's attenuated guest-creation facet extends (guests hold attenuated instances; creation stays with the host) |
| [daemon-capability-filesystem](daemon-capability-filesystem.md) | Provides the caretaker / revoke pattern for member capabilities |
| [daemon-form-request](daemon-form-request.md) | Members may use form-request to ask the parent for input mid-deliberation |
| [daemon-mount](daemon-mount.md) | Members may share a read-only mount as the deliberation target |

## Open Questions

- **Member identity**:
  do panel members survive the panel?
  Default proposal (resolved): **panel-scoped ephemeral members**,
  re-formulated (or re-attenuated from the current panel parent's
  authority) on each `deliberate` call and GC'd with the panel.
  This keeps the § Permission / capability story invariant — "the panel
  cannot escalate beyond the parent's own authority" — true for *every*
  invocation: because a member's capability set is re-derived from the
  authority of the parent driving *this* call, a later, lower-authority
  panel parent never inherits a member still holding capabilities an
  earlier, higher-authority parent granted.
  Durable, pet-name-addressable members reused across calls remain an
  *explicit* opt-in, permitted only when each reuse is guarded by a
  narrower-or-equal-authority check (the reused member's held
  capabilities must fall within the reusing parent's authority); absent
  that check, reuse is forbidden, since it would silently widen a weaker
  parent's reach. So the trade-off the earlier draft weighed
  (durable-and-reusable vs. hygienic) now folds in this authority
  consequence, not GC hygiene alone.
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
  Note first that the daemon has **no** worker-pool cap or
  worker-provisioning back-pressure today — the only `back-pressure`
  marker in `packages/daemon/src/*.js` is an unrelated
  `// TODO Respect back-pressure signal` on accepting network
  connections — so "worker provisioning fails gracefully when out of
  slots" is *not* a property this design can lean on as written; without
  a bound, an unbounded fan-out (compounded by orphaned timed-out
  members before the cancel-the-loser step above frees their workers)
  would silently degrade to members sharing one worker, the exact
  OpenCode-parity failure this design exists to avoid.
  Resolution: the panel enforces its **own** explicit
  `options.maxConcurrent` bound (default a small N, e.g. 8) in
  `deliberate` by chunking the fan-out, so member creation never outruns
  worker capacity regardless of daemon-level provisioning; the
  cancel-the-loser step frees a timed-out member's worker promptly so
  the bound is not consumed by orphans.
  Document the practical cap based on observed worker memory, and treat
  the exhaustion path as a Verification item (below), not an assumed
  graceful degradation.

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

## Verification

The design's central empirical claim (that panel members run genuinely
in parallel rather than interleaved on one event loop) is checkable and
must be checked, since it holds only when each member is formulated in
its own worker (see § Daemon: the panel agent module):

- **Parallelism.** A test dispatches a panel of `N` members whose
  `request` handlers each block on a barrier that releases only once all
  `N` have entered it. If the members share one worker / event loop the
  barrier deadlocks; genuine per-worker isolation lets it release. This
  distinguishes real parallelism from cooperative interleaving.
- **Worker isolation.** A test asserts each member guest is pinned to a
  distinct worker (not the shared main worker), so a member that crashes
  or blocks its worker does not stall its siblings.
- **Capability containment.** A test grants a member no `Shell` and
  asserts it cannot invoke one, confirming the structural (not
  list-based) permission story of § Permission / capability story.
- **Timeout cancels the loser.** A test dispatches a panel whose member
  blocks past the per-member deadline; after the deadline fires the test
  asserts the member's in-flight work actually *stops* — its `cancel()`
  was invoked and it makes no further progress / releases its held LLM
  capability — not merely that the panel stopped waiting on it. This
  distinguishes a genuine cancel from `Promise.race`'s wait-only
  semantics.
- **Exhaustion path.** A test requests more members than
  `options.maxConcurrent` (or more than the available workers) and
  asserts the panel *bounds* the fan-out (chunking to the cap) and still
  returns an aggregate verdict, rather than silently degrading to
  members sharing one worker.

## Related Designs

- [endopen](endopen.md): primary comparative analysis.
- [endor-tui](endor-tui.md): M6 Rust TUI; would render panels in the terminal idiom.
- [endopen-tui-shell](endopen-tui-shell.md): browser-side
  opencode-shaped space that uses the panel widget.
- The garden's scripted review panel (a supervising worker
  dispatching juror seats) informs the multi-member-deliberation
  shape.

## Prompt

> Concurrent subagent execution which would fall out of endo more trivially given its formula isolation + capability model.
>
> kriskowal, 2026-05-15
