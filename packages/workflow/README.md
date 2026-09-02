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
  In ask descriptions and forms, interpolated values render *delimited*
  (strings quoted JSON-style), so participant-supplied content reads as
  data to the human or LLM agent receiving the ask, never as
  instruction.
- **Composition**: compound states (`states` + `initial`, sharing the
  frame's context), parallel `regions` with `join: 'counts'` and the
  data-driven `{ $eachParam, chart, input }` expansion (each region is
  its own frame with its own params and context), and `spawn` effects
  that run child charts as full runs of their own.
- **Effects** are the only boundary with the world:

  | kind     | delivery                                                        |
  | -------- | --------------------------------------------------------------- |
  | `ask`    | daemon mail (`request` / `form`) — durable, exactly-once        |
  | `invoke` | eventual send to a named endowment — at-least-once, run-qualified `${runId}:${effectId}` idempotency key passed as the final argument |
  | `spawn`  | child run; the terminal outcome settles the parent              |
  | `after`  | deadline re-armed from its journaled absolute time              |
  | `emit`   | internal event                                                  |

A run's authority is exactly the `endowments` record granted at
`start`; the chart names endowments and never looks anything up.

Settlements are **fail-loud**: an ask answer, invoke result, or child
outcome that fires no transition fails the run (a failed run is visible
where a wedged one is silent), a kernel throw fails the run, and
`install` rejects charts whose effect outcomes no state on their path
handles (`chartDiagnostics` reports the same statically, with
reachability and deaf-timer warnings).

## Provisioning

The plugin module exports the standard unconfined-caplet maker.
Provision it through the daemon's generic pathway, with a dedicated
guest as its powers, and **pin it** so it wakes on restart:

```
# a dedicated agent for the service
endo mkguest workflow-powers workflow-agent

# provision the plugin from its entry module; pinning the result is
# what revives it at boot (--UNCONFINED takes a file path)
endo make --UNCONFINED node_modules/@endo/workflow/src/index.js \
  --powers workflow-agent --name workflow-service
endo cp workflow-service @pins/workflow-service
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
await E(run).explain(); // what the run is waiting on, in prose
const reader = await E(run).follow({ since: 0n }); // journal replay + live tail
await E(control).signal({ type: 'nudge' });
await E(control).cancel('changed my mind');
```

`cancel()` first delivers the reserved engine event `cancel-requested`.
Linked children receive and journal cancellation before the parent records its
own request, closing the crash window in the safe direction.
If the active chart handles the request, the run stays live while ordinary
durable states perform cleanup or collect an operator attestation.
Cancellation supersedes a pause atomically with that state transition, then
replays queued envelopes against the reconciliation state: routed stale
approvals miss their exited path, while already-settled compensation or child
work can still finish.
If no transition handles the event, the service retains its immediate
cancellation behavior: active exit effects are sent, the run becomes
`cancelled`, and children are cancelled.
Charts that can mutate the outside world should handle cancellation explicitly
rather than rely on fire-and-forget exit effects.

The facets split caretaker-style: `run` is observation only (status,
explain, journal, follow, chart) and freely shareable; `control` (held
by the starter) injects signals, pauses/resumes/cancels, mints
pattern-checked participant `port`s, and is the only holder that can
`resolveRef` a redacted capability out of the run's refs store — an
access that is itself journaled as an `admin` entry.
Control signals are external events: `signal` rejects `cancel-requested` and
statically named effect settlement, timer, emit, and region-join event types,
and strips engine-owned routing and settlement metadata (`path`, `effectId`,
`compensation`, and `delivers`).
Types containing interpolation syntax cannot be enumerated by this protection;
security-sensitive charts must use literal engine event types.

Asks land in the recipients' ordinary inboxes.
`endo resolve` / `endo reject` answer unstructured requests.
The current `endo submit --field name:value` CLI sends field values as strings,
so structured forms with boolean, bigint, or other non-string patterns require
a typed UI or programmatic submitter; the CLI is sufficient only for
string-pattern fields.

### Factories

A **factory** is a durable, revocable grant to start runs of one chart
with pre-bound params (capability-free data) and endowments (the
capability channel):

```js
const { fid, factory } = await E(service).makeFactory({
  chart: chartKey,
  params: { repo: 'endo' },
  endowments: { ci: ciHandle },
});
const { runId, run } = await E(factory).start({ params: { branch: 'main' } });
// `run` is the observer facet: a factory starter watches, never steers.
const narrower = await E(factory).with({ params: { branch: 'main' } });
await E(factory).revoke('rotation'); // cascades to derived factories and cancels their live runs
```

Factory records, bindings, and parent links live in the pet store, so
factories — including revocation — survive restarts.

## Layout and durability

```
workflow/
  charts/<name>-v<version>     installed chart snapshots
  factories/<fid>/
    record                     bindings, parent link, revocation state
    chart, params              the bound chart snapshot and data params
    endowments/<name>          the bound capabilities
  runs/<runId>/
    chart                      the run's self-contained chart snapshot
    endowments/<name>          the capabilities granted at start
    answers/<effectId>         ask answers (request responseName)
    refs/ref-<n>               capabilities redacted out of journal entries
    0, 1, 2, ...               the journal, one marshal entry per seq
```

Journal entries are capability-free data: any remotable in a settled
value (or in params) is **redacted** to a `ref-<n>` alias string and
durably parked under the run's `refs/` directory — the audit log stays
legible to any observer, the pet-store name keeps the capability alive
in the daemon's GC graph, and the control holder can recover it via
`resolveRef` (charts themselves must be capability-free; endowments are
the only capability channel).
Causally-coupled facts commit in ONE entry: an effect settlement rides
the same write as the transition it fires (`settles`), a step that
enters a final state carries its own `terminal` outcome, and the
internal events and `emit`s a step raises are journaled as delivery
obligations that recovery re-dispatches — no crash window separates a
durable cause from its durable consequence.
Recovery is isolated per run (one corrupt journal cannot block the
rest), spawn re-dispatch adopts its deterministically-named child
instead of duplicating it, and a crash mid-`resume` drains the
remaining queued events at the next boot.
One honest limit: a hash chain authenticates everything BEFORE its
tail, so an edit to the final entry of a stopped service's journal is
not detectable from the journal alone.
Every entry carries `prev`, the SHA-256 of the previous entry's
canonical encoding, so the journal is a hash chain: recovery verifies
it (a broken chain surfaces as `integrity` in status), clients can
re-verify it end-to-end, and because the canonical encoding refuses
remotables, hashing doubles as the enforcement that nothing
capability-shaped reaches the journal.
`foldJournal(entries)` reproduces `{ configuration, context, pending,
done, output }`; the live engine applies the same `applyEntry` as it
appends, so a recovered run and a live run cannot disagree.

## Tooling

- `@endo/workflow/machine.js` — the pure kernel (`assertChart`,
  `chartDiagnostics`, `initialStep`, `transition`, `exitEffects`),
  importable on its own; runs identically in a worker, a test, or a
  browser space.
- `makeSimulator(chart, { params })` (`src/simulate.js`) — the kernel
  plus the journal fold, minus the world: effects are recorded, the
  caller settles them, and the engine's policies (cascades, terminals,
  fail-loud) apply — for chart authoring and tests.
- `renderGraph` / `renderMermaid` / `externalEventTypes`
  (`src/graph.js`) — a chart's state graph as data or a Mermaid
  `stateDiagram-v2`.
- `makeRunSyncClient(run)` (`src/sync.js`) — a client-side mirror of a
  run built from its `follow` stream with the same fold the engine
  uses: `current()`, `stateAt(seq)` time travel, and client-side
  `verify()` of the hash chain. The `@endo/space-workflow` Chat space
  renders runs through it.
