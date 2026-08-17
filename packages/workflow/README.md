# `@endo/workflow`

A durable, composable workflow system for the Endo daemon.

Workflow definitions ("charts") are passable, hardened statechart data —
states, `@endo/patterns`-guarded transitions, and declarative effect
descriptions — interpreted by a pure, synchronous kernel.
The service gives charts durable runs: every event, transition, and
effect outcome is journaled as numbered immutable marshal entries in the
service agent's pet store (the daemon's mailbox-store idiom), so a run's
state is a fold over its journal, the journal doubles as the attributed
audit log, and a daemon restart is recovered by refolding — never by
resuming a suspended computation.

See [designs/endo-workflow.md](../../designs/endo-workflow.md) for the
full design, including the implementation options considered and the
motivating use case (an AI agent implements a feature on a git-backed
workspace; specialist reviewers review in parallel; CI runs; the
operator approves; the change lands).

## Charts

```js
import { M } from '@endo/patterns';

const chart = harden({
  name: 'draft-review',
  version: 1,
  params: M.splitRecord({ title: M.string() }),
  context: { attempts: 0 },
  initial: 'draft',
  states: {
    draft: {
      entry: [
        {
          kind: 'ask',
          to: 'writer',
          what: { description: 'Draft {$params.title}' },
          outcome: 'drafted',
        },
      ],
      on: {
        drafted: [{ target: 'review', assign: { draft: { $event: 'value' } } }],
      },
    },
    review: {
      entry: [
        {
          kind: 'ask',
          to: 'reviewer',
          form: {
            description: 'Approve {$params.title}?',
            fields: [{ name: 'approved', label: 'Approve?', pattern: M.boolean() }],
          },
          outcome: 'reviewed',
        },
        { kind: 'after', ms: 86_400_000, emit: { type: 'review-timed-out' } },
      ],
      on: {
        reviewed: [
          {
            when: M.splitRecord({ value: M.splitRecord({ approved: M.eq(true) }) }),
            target: 'done',
          },
          { target: 'draft', assign: { attempts: { $inc: 1 } } },
        ],
        'review-timed-out': [{ target: 'draft' }],
      },
    },
    done: { final: true, output: { draft: { $ctx: 'draft' } } },
  },
});
```

- **Guards** are patterns over the whole event envelope
  `{ type, value, by, at, ... }`; the engine enriches join envelopes with
  computed `counts` / `outcomes` so quorum guards stay total.
- **Templates** — `{ $params: 'path' }`, `{ $ctx: 'path' }`,
  `{ $event: 'path' }`, `{ $inc: n }` in `assign`, and `{$params.x}`
  string interpolation — are total, structural, and non-evaluating.
  Charts contain no code.
- **Composition**: compound states (`states` + `initial`, sharing the
  frame's context), parallel `regions` with `join: 'counts'` and the
  data-driven `{ $eachParam, chart, input }` expansion (each region is
  its own frame with its own params and context), and `spawn` effects
  that run child charts as full runs of their own.
- **Effects** are the only boundary with the world:

  | kind     | delivery                                                        |
  | -------- | --------------------------------------------------------------- |
  | `ask`    | daemon mail (`request` / `form`) — durable, exactly-once        |
  | `invoke` | eventual send to a named endowment — at-least-once, `effectId` idempotency key passed as the final argument |
  | `spawn`  | child run; the terminal outcome settles the parent              |
  | `after`  | deadline re-armed from its journaled absolute time              |
  | `emit`   | internal event                                                  |

A run's authority is exactly the `endowments` record granted at
`start`; the chart names endowments and never looks anything up.

## Provisioning

The plugin module exports the standard unconfined-caplet maker.
Provision it through the daemon's generic pathway, with a dedicated
guest as its powers, and **pin it** so it wakes on restart:

```
# a dedicated agent for the service
endo mkguest workflow-powers workflow-agent

# provision the plugin; pinning the result is what revives it at boot
endo make-unconfined --UNCONFINED @endo/workflow \
  --powers workflow-agent --name workflow-service
endo cp workflow-service @pins:workflow-service
```

The daemon eagerly revives exactly one caplet collection at boot: the
`@pins` directory.
On the next start, `revivePins()` provides the pinned identifier, the
worker incarnates the plugin, and `make()` recovers every stored run —
refolding journals, adopting ask answers that arrived while the daemon
was down, re-dispatching unsettled invokes under their original effect
ids, and re-arming deadlines.
Unpinning decommissions: the service does not wake on the next boot; its
journals remain until removed.

Then, from any holder of the service:

```js
const chartKey = await E(service).install(chart); // 'draft-review-v1'
const { runId, run, control } = await E(service).start(chartKey, {
  params: { title: 'Adder' },
  endowments: { writer: writerHandle, reviewer: reviewerHandle },
});

await E(run).status(); // passable snapshot: configuration, context, pending, prompts
const reader = await E(run).follow({ since: 0n }); // journal replay + live tail
await E(control).signal({ type: 'nudge' });
await E(control).cancel('changed my mind');
```

Asks land in the recipients' ordinary inboxes — `endo inbox`, `endo
resolve` / `endo reject`, and `endo submit` are the human approval
surface; nothing new to learn.

## Layout and durability

```
workflow/
  charts/<name>-v<version>     installed chart snapshots
  runs/<runId>/
    chart                      the run's self-contained chart snapshot
    endowments/<name>          the capabilities granted at start
    answers/<effectId>         ask answers (request responseName)
    0, 1, 2, ...               the journal, one marshal entry per seq
```

Journal entries are immutable passables; because marshal slots are
formula identifiers, an entry that references a formula-backed
capability retains it in the daemon's GC graph — the audit log keeps its
own evidence alive.
`foldJournal(entries)` reproduces `{ configuration, context, pending,
done, output }`; the live engine applies the same `applyEntry` as it
appends, so a recovered run and a live run cannot disagree.

The pure kernel (`assertChart`, `initialStep`, `transition`,
`exitEffects`) is importable on its own via `@endo/workflow/machine.js`
and runs identically in a worker, a test, or a browser space.
