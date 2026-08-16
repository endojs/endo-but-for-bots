# Endo Workflow: Durable Composable State Machines

| | |
|---|---|
| **Created** | 2026-08-16 |
| **Updated** | 2026-08-16 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Endo agents can already do long-running collaborative work, but every
multi-step, multi-party process is coordinated ad hoc.
The motivating use case:

1. A user (or agent) requests that an AI agent (floot, lal) implement a
   feature against a git Endo object.
2. The implementation agent makes changes on a branch and submits a change
   set.
3. Review begins, potentially fanning out to many specialist reviewers
   (security, style, types, domain).
4. If any reviewer requests changes, the reviews return to the
   implementation agent and the loop repeats.
5. After passing review, CI runs.
6. After passing CI, the user is prompted for approval.
7. After approval, the change set is merged and applied.

Nothing in the daemon today owns that process.
Each hop is possible in isolation — lal can implement, a guest can review, a
shell capability can run tests, a form can ask the user, `Git.merge` can
land the result — but the *process* lives nowhere.
If the daemon restarts mid-review, no component knows to resume the loop.
There is no audit record of who approved what and when.
There is no single object a UI can subscribe to in order to render "where is
this change in its lifecycle?"

The example is only an example.
The system must be a **generic, composable, durable workflow engine**:

- **Generic** — workflows are data (definitions), not hardcoded processes;
  the feature-review flow is one definition among many (onboarding an
  agent, rotating a credential, a multi-agent research pipeline, a
  scheduled backup-verify-prune loop).
- **Composable** — a workflow can invoke other workflows as sub-workflows,
  run parallel regions, and be assembled from reusable state fragments.
- **Durable** — a run survives daemon restarts; in-flight steps resume; no
  acknowledged event is lost.
- **Auditable** — every run yields an append-only audit log of events,
  transitions, effects, and the identity of every actor who influenced it.
- **Observable** — current status is queryable and subscribable, suitable
  for rendering in a Chat UI space.

## Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | Declarative workflow definitions | Passable, hardened data; inspectable and renderable |
| R2 | Runs survive daemon restart | Resume in-flight effects; re-arm timers |
| R3 | Append-only audit log per run | Exportable; the log *is* the source of truth |
| R4 | Query current status | State name, context, pending effects |
| R5 | Subscribe to status and events | Lossy latest-state topic and lossless event stream |
| R6 | Human-in-the-loop gates | Reuse daemon forms/messages |
| R7 | Agent-in-the-loop steps | Reuse durable promises and mail requests |
| R8 | Parallel fan-out and join | Many specialist reviewers |
| R9 | Sub-workflow composition | Child runs report completion to parents |
| R10 | Ocap discipline | A run can reach only its named participants; no ambient authority |
| R11 | Failure handling | Per-state error transitions, declarative retry, terminal `failed`, admin override |
| R12 | UI space rendering | A `space-workflow` Chat space showing graph + timeline |

## Substrate Survey

The daemon and its satellite packages already provide almost every primitive
a workflow engine needs.
The engine should be a thin, principled composition of these, not a new
kingdom:

| Primitive | Where | Role in the engine |
|-----------|-------|--------------------|
| Durable promise/resolver formulas | `packages/daemon/src/manager.js` (`formulatePromise`, `makePromise`, `makeResolver`) | Cross-restart settlement of any asynchronous step. The promise re-derives its settlement from a numbered pet store after restart, so an engine awaiting one resumes for free. |
| Messages: `request`, `package`, `form`, `value` | `mail.js`, [daemon-form-request](daemon-form-request.md), [daemon-value-message](daemon-value-message.md) | Human gates (forms) and agent gates (requests with attached durable promises). Messages are formulas and survive restarts. |
| `@pins` revival | `revivePins()`; [reminder](../packages/reminder/README.md) "@pins recipe" | Wakes the engine caplet on daemon boot so recovery runs without daemon-core changes. |
| Unconfined plugin pattern | `@endo/reminder` | The precedent this design follows: durable store on the virtual file system, no new formula type, integration-owned revival. |
| Virtual file system | `@endo/platform/fs/extended`, daemon mounts, directories | Backing for the journal and snapshots; atomic write-then-`move` contract established by the reminder store. |
| Pubsub topics | `@endo/pubsub` (`makeChangeTopic`, `makeLatestTopic`) | Lossless event feed; lossy latest-status feed. |
| Exo streams | `@endo/exo-stream` | Carries both feeds over CapTP to CLI and Chat. |
| Message scheduler | `@endo/reminder` ([endo-reminder](endo-reminder.md)) | Durable timeouts and retry backoff without engine-local timers. |
| Git capability trio | `@endo/exo-git`, daemon `git`/`git-remote` formulas, mounts | The "git endo object" in the motivating use case, with reader/writer/rewriter attenuation for per-role grants. |
| Agents | `@endo/lal`, `@endo/floot`, `@endo/fae`, `@endo/agentry` | Workflow participants; already inbox-driven. |
| Chat spaces | `@endo/space-*` packages | The UI plug-in shape for `space-workflow`. |
| JSONL transcripts | `@endo/jsonl-transcript` | Precedent for greppable on-disk append logs; the audit-log export format follows it. |

## Architecture

`@endo/workflow` is an **unconfined daemon plugin** in the mold of
`@endo/reminder`: provisioned with `makeUnconfined`, pinned via `@pins`,
holding a virtual-file-system directory for durable state and a guest
namespace for participant capabilities.
No new formula type and no daemon-core change — the reminder design set
this precedent and this engine follows it, so the daemon core stays small
and engine iteration does not require daemon releases.

Workflow **definitions are hardened data** (a conservative statechart
subset); the engine is an **event-sourced interpreter**: an append-only
journal of events is the source of truth, current state is a pure fold over
the journal, and effects are executed at the boundary and re-enter as
events.
The audit log falls out of the architecture (the journal *is* the audit
log, R3); restart recovery is journal replay plus effect resumption (R2);
definitions-as-data are renderable as a graph (R12) and validatable with
`@endo/patterns`.
The trade-offs accepted: retention is engine-owned (names in the engine
guest's pet store) rather than formula-graph-native, and the declarative
definition language must stay disciplined to avoid becoming a bad
programming language (addressed below with powerless confined reducers).

### Formalism choice

| Formalism | Fan-out/join | Renderable | Upgrade-safe | Complexity |
|-----------|--------------|------------|--------------|------------|
| Flat FSM | poor (state explosion) | yes | yes | low |
| Statechart subset (hierarchy + parallel regions + guards) | good | yes | yes | medium |
| Petri net | excellent | yes, but unfamiliar | yes | high |
| Deterministic replayed code | excellent | no | hard | low to write, high to operate |

A **conservative statechart subset** is chosen: atomic states, compound
(hierarchical) states, parallel regions with join, guarded transitions,
entry effects, and final states.
No history states, no internal transitions, no activities — additions can
be considered later against real definitions.
Petri nets are strictly more expressive for join patterns but the
statechart's parallel-region join covers R8, and statecharts render as the
familiar boxes-and-arrows diagram Chat should draw.
Workflow-as-replayed-code (the Temporal shape) is rejected as the engine
model: the process is opaque — no data structure to render as a graph, no
uniform status surface — and code upgrade of long-lived runs is the
hardest version of the upgrade problem (replay divergence).
Nothing prevents an agentry code-mode agent from *generating* definitions,
and a later `defineWorkflow` builder could compile a restricted JS DSL to
the data schema (see Known Gaps).

### The reducer problem: patterns for guards, powerless code for updates

Pure-data definitions hit a wall at context updates ("append this verdict
to the list") and computed guards ("all verdicts are approve").
Encoding these as an ever-growing vocabulary of declarative operators
recreates a bad programming language in JSON.
Hardened JavaScript offers a better trade: **guards and reducers are small
pure expressions carried as strings in the definition and evaluated in a
powerless SES compartment** — no globals beyond `Object`/`Array`
lexical-safe intrinsics, no authority, deterministic by construction, and
`harden`ed inputs (`{ context, event }`) so they cannot communicate.
`@endo/patterns` remains the preferred guard form (declarative, cheap,
diagnosable); expression guards are the escape hatch.
Effects are **never** expressible in reducers; the only way a definition
touches the world is the closed effect vocabulary below, aimed at declared
participants.
This preserves replay: reducers are pure functions of `(context, event)`,
so folding the journal always reproduces the same state.

### Storage

The journal is backed by virtual-FS event-segment files plus a snapshot,
over `@endo/platform/fs/extended` like the reminder store: backing-agnostic
(host directory, mount, or in-memory tree for tests), greppable, and free
of daemon schema changes.
Layout under the engine's store root:

```
workflow-store/
  config.json                     # engine limits, retention policy
  definitions/
    <hash>.json                   # content-addressed, immutable definitions
    names.json                    # petname -> hash
  runs/
    <runId>/
      meta.json                   # definitionHash, parent, createdAt, participants
      events/
        00000001.json             # one event per file, write-then-move atomic
        00000002.json
      snapshot.json               # { throughSeq, state, context, pending }
```

Events are written write-then-`move` (the reminder store's atomicity
contract).
`snapshot.json` is refreshed every N events; recovery loads the snapshot
and folds the tail.
Compaction may fold acknowledged event files into the snapshot and delete
them once an export/retention policy allows; the audit export
(`exportJournal()`) streams the full event sequence as JSONL in the
`@endo/jsonl-transcript` spirit before any deletion.
If the engine ever proves load-bearing enough to warrant it, promoting the
journal into another backing is a migration of the storage seam, not of
the model.

## Design

### Definitions

A `WorkflowDefinition` is hardened, passable data, validated against a
`@endo/patterns` shape at registration and content-addressed by the SHA-256
of its canonical marshalling.

```js
const featureChange = harden({
  name: 'feature-change',
  version: 1,
  // Participant slots: names bound to capabilities at start().
  participants: {
    implementer: { description: 'coding agent handle' },
    reviewers: { description: 'specialist reviewer handles', many: true },
    ci: { description: 'CI runner (e.g. shell capability wrapper)' },
    approver: { description: 'human agent handle for the approval form' },
    repo: { description: 'Git writer facet scoped to the feature branch' },
  },
  // Pattern for the initial context supplied at start().
  input: { request: 'M.string()', branch: 'M.string()' },
  initial: 'implementing',
  states: {
    implementing: {
      entry: [{
        effect: 'request',
        to: 'implementer',
        description: 'Implement: ${context.request} on ${context.branch}',
        attach: ['repo'],
        as: 'implementation',
      }],
      on: {
        'task.settled': {
          when: { as: 'implementation' },
          assign: '({ context, event }) => ({ ...context, changeSetId: event.valueId })',
          target: 'reviewing',
        },
        'task.rejected': { when: { as: 'implementation' }, target: 'failed' },
      },
    },
    reviewing: {
      entry: [{
        effect: 'fanout',
        to: 'reviewers',
        description: 'Review change set ${context.changeSetId}',
        attach: ['repo:readOnly'],
        as: 'reviews',
        join: 'all',
      }],
      on: {
        'fanout.joined': [
          {
            when: { as: 'reviews' },
            guard: '({ event }) => event.results.every(r => r.verdict === "approve")',
            target: 'testing',
          },
          {
            when: { as: 'reviews' },
            assign: '({ context, event }) => ({ ...context, feedback: event.results })',
            target: 'implementing',
          },
        ],
      },
    },
    testing: {
      entry: [{ effect: 'call', to: 'ci', method: 'run',
                args: ['${context.branch}'], as: 'ci-run',
                retry: { max: 2, backoff: 'exponential' } }],
      on: {
        'task.settled': { when: { as: 'ci-run' }, target: 'approving' },
        'task.rejected': { when: { as: 'ci-run' }, target: 'implementing' },
      },
    },
    approving: {
      entry: [{
        effect: 'form',
        to: 'approver',
        description: 'Merge ${context.branch}? Reviews and CI passed.',
        fields: [{ name: 'decision', label: 'Approve merge?' }],
        as: 'approval',
      }],
      on: {
        'form.value': [
          { when: { as: 'approval' },
            guard: '({ event }) => event.values.decision === "yes"',
            target: 'merging' },
          { when: { as: 'approval' }, target: 'abandoned' },
        ],
      },
      after: { ms: 604800000, target: 'abandoned' },
    },
    merging: {
      entry: [{ effect: 'call', to: 'repo', method: 'merge',
                args: ['${context.branch}'], as: 'merge' }],
      on: {
        'task.settled': { when: { as: 'merge' }, target: 'done' },
        'task.rejected': { when: { as: 'merge' }, target: 'failed' },
      },
    },
    done: { final: 'succeeded' },
    abandoned: { final: 'abandoned' },
    failed: { final: 'failed' },
  },
});
```

Notes on the schema:

- `guard` and `assign` are powerless-compartment expressions (see above);
  `when` is a pattern match on the event.
  `${...}` in strings is template substitution from `context`, not
  evaluation.
- `attach` grants a participant capability along with a message; the
  `repo:readOnly` form calls the named attenuator (`readOnly()` on the git
  facet) before attaching, so reviewers get the reader facet while the
  engine holds the writer (R10).
- Compound states (`states` nested under a state) and parallel regions
  (`regions: { a: {...}, b: {...} }` with a `join` completion transition)
  are part of the schema; the example needs only `fanout`, the common
  idiom that fans one effect over a `many` participant and joins with
  `all` / `any` / `{ quorum: n }`.

### Runs and the event journal

`E(service).start(definitionName, { input, participants })` creates a run:
a `runId`, a `meta.json`, and the first journal event.
Every change to a run is an event:

```
{ seq, at, type, ...payload }

run.started        { input, participants: { name: locator... } }
effect.issued      { as, effect, to, idempotencyKey }
effect.settled     { as, valueId | value }
effect.rejected    { as, reason }
fanout.joined      { as, results }
form.value         { as, values, from }
transition.fired   { from, to, on, guardIndex }
signal.injected    { name, payload, actor }
admin.forced       { action, actor, detail }
run.finished       { final }
```

The journal is the audit log (R3): `at` timestamps and actor identities are
recorded at append time, and replay is a *fold*, never a re-execution —
effects are only issued by live transition processing, never during
recovery replay of already-journaled transitions.

### The effect vocabulary and durability protocol

Effects are the only channel from a definition to the world.
Each is issued with a deterministic idempotency key
(`${runId}:${seq}:${as}`) and journaled `effect.issued` **before**
execution.

| Effect | Mechanism | Settlement path |
|--------|-----------|-----------------|
| `request` | Daemon mail request (or package) to the participant's handle, with a durable promise/resolver pair attached | The daemon promise formula settles from its pet store even across restarts; the engine awaits it and journals `effect.settled` / `effect.rejected` |
| `form` | Daemon form message to a handle | The `value` reply message becomes `form.value`; forms and replies are formulas, so the gate is durable |
| `call` | `E(participant).method(...args)` wrapped in a formulated durable promise: the engine resolves the resolver with the call's result id | If the daemon dies mid-call, the promise is unsettled; recovery re-issues the call with the same idempotency key |
| `fanout` | One `request`/`call` per member of a `many` participant, plus a join record | Joins per the policy; partial results journaled as they arrive |
| `spawn` | Start a child run of another definition | Child's `run.finished` re-enters the parent as `child.finished` (R9) |
| `after` (timeout) | A reminder scheduled via `@endo/reminder` | Delivery injects a `timeout` event; reminder's catch-up policy covers downtime |
| `emit` | Publish a custom event on the run's topic | For external observers; no settlement |

Delivery semantics are **at-least-once** for `call` (documented; targets
receive the idempotency key as a call context argument when they opt in via
`idempotent: true`, otherwise recovery marks the effect `indeterminate` and
routes to the state's `onError`), and **exactly-once-observed** for
`request`/`form`/`spawn`/`after`, whose settlement is externalized into
durable daemon state (promise stores, message formulas, reminder store)
rather than the engine's memory.

### Composing workflows

Composition happens at two times — authoring time (fragments) and run
time (children) — plus a third, free mechanism: runs are capabilities.

**Authoring-time: fragments.**
A fragment is a definition of kind `fragment`: a named group of states
with declared boundary events (how control enters and leaves), declared
participant slots, and declared context reads/writes.
A definition inlines one with `use`:

```js
review: {
  use: {
    fragment: 'review-fanout',        // resolved by name -> content hash
    bind: { reviewers: 'reviewers', subject: 'changeSetId' },
    on: { approved: { target: 'testing' },
          'changes-requested': { target: 'implementing' } },
  },
},
```

Inlining happens at `define()` time: fragment states are namespaced under
the using state (`review.collect`, `review.tally`), the bound slots are
checked against the fragment's declared requirements, and the resulting
flattened definition is what gets content-addressed — a run never knows
fragments existed.
Fragments are the standard-library seam: `approval-gate`,
`retry-with-backoff`, `review-fanout` ship with the engine, and any agent
can publish more; because inlining is by content hash, a fragment upgrade
never mutates existing definitions.

**Run-time: child runs (`spawn`).**

- **Input mapping in**: `input` on the spawn effect is built from parent
  context (template substitution or a reducer expression); the child
  validates it against its own `input` shape.
- **Participants are passed explicitly** by slot name, never inherited
  ambiently; the parent may pass an attenuation (`repo:readOnly`) exactly
  as with any effect.
  The child's authority is therefore always a visible subset of the
  parent's.
- **Output mapping out**: a child's final state may declare
  `output: '<expression over child context>'`; the marshalled result
  arrives in the parent as
  `child.finished { as, final, output }`.
  Child failure is not special — it is the same event with
  `final: 'failed'`, handled by parent transitions or `onError`.
- **Cancellation cascades down, not up.**
  Aborting a parent aborts its descendants (journaled on both sides);
  a child's failure or abort never terminates the parent except through
  an explicit parent transition.
- **Many children**: `spawn` over a `many`-shaped array fans out child
  runs and joins with the same `all` / `any` / `{ quorum: n }` policies
  as `fanout` — reviewers who are themselves workflows cost no new
  mechanism.
- **Linkage is queryable**: `meta.json` records `parent`; `RunSummary`
  carries it, so the UI renders run trees, and `exportJournal` of a
  parent can optionally interleave child journals for a whole-tree audit.
- **Limits**: engine config bounds spawn depth, children per run, and
  total live runs; breaching a bound rejects the spawn effect (an
  ordinary `effect.rejected`, visible in the journal).

**Runs are capabilities.**
A `WorkflowRun` (or its observer facet) can itself be a *participant* of
another workflow: a monitoring workflow can `call` `status()` on the runs
it watches, or `call` `signal()` to nudge a sibling — long-running
processes coordinate through the same ocap discipline as everything else,
with no engine-level "cross-workflow messaging" subsystem to design or
secure.

### Participants, naming, and retention

At `start()`, participant capabilities are stored under the engine guest's
namespace at `workflow/runs/<runId>/participants/<name>` via
`storeIdentifier`, which keeps them reachable in the formula graph for the
life of the run (the engine plugin's pin anchors the chain).
The run object never accepts capabilities mid-flight except through
`signal` payloads explicitly declared in the definition.
When a run reaches a final state, participant names are released after the
configured retention window; the journal (or its JSONL export) outlives
the capabilities.

### Configurations and factories

`start()` demands a lot of its caller: the definition name, the full
participant roster, and possession of every participant capability.
That is the right primitive for the host, and the wrong everyday surface
for everyone else — a guest that should be able to *request a feature
change* must not thereby hold the repo writer facet.

A **`WorkflowFactory`** is a durable capability that closes over a
definition (by hash) plus a partial or total participant binding, input
defaults, and start policy:

```
WorkflowService
  makeFactory({ definition, participants?, input?, limits? })
    -> { factory, factoryAdmin }

WorkflowFactory
  start(input?, participants?)  -> { run, observer }   # fills unbound slots only
  describe()                    -> { definition, boundSlots, openSlots,
                                     inputShape, limits }
  with({ participants?, input? }) -> WorkflowFactory    # derived, narrower

WorkflowFactoryAdmin
  bind(slot, capability) / setLimits({ maxConcurrent, maxStartsPerDay })
  runs() -> [RunSummary]        # every run this factory started
  revoke()
```

Design properties:

- **Factories are the attenuation unit.**
  Granting a factory grants "start this workflow with these bindings" —
  the bound capabilities (the git writer, the CI shell) never pass
  through the caller.
  By default `start` returns the run's **observer** facet; the admin facet
  stays with the factory owner.
- **Derivation is non-escalating.**
  `with()` may fill open slots, narrow input defaults, or tighten limits;
  it can never rebind a bound slot or loosen a limit.
  This mirrors the `exo-git` `scope`/`readOnly` discipline: a chain of
  `with()` calls only ever descends.
- **Factories are durable and nameable.**
  Each factory persists as `factories/<id>.json` in the engine store with
  its bound participant ids held in the engine guest's namespace, revives
  with the engine, and can be stored in any pet store, sent in a message,
  or listed in inventory like any other capability.
- **Start policy lives on the factory, not the definition.**
  Concurrency caps, rate limits, and retention overrides are deployment
  concerns; the same definition can back a tightly-limited guest-facing
  factory and an unlimited host-facing one.
- Every `factory.start` journals the factory id and the caller's handle in
  `run.started`, so the audit log records *which grant* was exercised, not
  merely that a run began.

For the motivating use case: the host mints a
`feature-change-on-endo-repo` factory binding `repo`, `ci`, `reviewers`,
and `approver`, and grants it to lal.
Lal starts runs supplying only `{ request, branch }` and observes
progress; it never touches the writer facet, and the host can revoke or
re-limit the factory without disturbing in-flight runs.

### Query and subscription surface

The engine exposes exos with `M.interface` guards:

```
WorkflowService (host-facing)
  define(name, definition)            -> definitionHash
  definitions()                       -> [{ name, hash, version }]
  makeFactory({...})                  -> { factory, factoryAdmin }
  start(name, { input, participants }) -> { run, observer, admin }
  run(runId) / runs({ status? })      -> WorkflowRun / [RunSummary]
  followRuns()                        -> Reader<RunSummary>       # lossless

WorkflowRun (observer facet unless noted)
  status()          -> { runId, definition, state, context, pending,
                         throughSeq, updatedAt }
  stateAt(seq)      -> same shape, folded through seq        # time travel
  history(fromSeq?) -> Reader<Event>                # gapless replay + live
  followStatus()    -> Reader<Status>               # lossy latest topic
  explain()         -> StuckReport                  # see Debuggability
  signal(name, payload)                             # declared external events
  exportJournal(fromSeq?) -> EndoReadable (JSONL)   # audit export (R3)

WorkflowRunAdmin (attenuation; host or factory owner)
  pause() / resume()
  abort(reason) / retryEffect(as) / forceTransition(target) / injectEvent(e)
```

Every admin method journals `admin.forced` with the caller's handle
identity — overrides are audited, not hidden.

### State syncing

All observation reduces to **one sync primitive**: a run is a monotonic
sequence of journal events, and every view is a pure fold over a prefix.

- **Snapshot + resume token.**
  `status()` carries `throughSeq`.
  A client that wants live state calls `status()` once and then
  `history(throughSeq + 1)`; applying events with the shared fold yields
  exactly the engine's state at every step.
  There is no separate "state channel" to drift out of sync with the
  event channel.
- **Gapless splice.**
  `history(fromSeq)` is implemented as: subscribe the run's
  `makeChangeTopic` spring *first*, then stream journal segments from
  `fromSeq`, then drain the spring discarding events with
  `seq <= ` the last replayed seq.
  Because events are seq-keyed, the overlap dedupe is exact and the
  reader observes each event exactly once, in order.
- **Reconnect is resume.**
  Exo-stream readers die with their connection.
  The client remembers the last applied seq and re-calls
  `history(lastSeq + 1)`; apply is idempotent by seq comparison, so
  crash-looping clients converge.
  This is the same shape as daemon restart recovery — the engine and its
  observers use one protocol.
- **Shared fold module.**
  The pure fold (`applyEvent(state, event)`) ships as an authority-free
  module in `@endo/workflow` importable in the browser.
  The Chat space computes state locally from events rather than trusting
  a second server-side projection; `followStatus()` (a `makeLatestTopic`)
  remains for cheap dashboards that want one small object per change and
  can tolerate loss.
- **Run-set syncing.**
  `followRuns()` emits `RunSummary` deltas keyed by `runId`
  (`{ runId, definition, state, final?, throughSeq, updatedAt }`);
  consumers dedupe by runId with last-writer-wins on `throughSeq`.
  Creation and finish summaries are always published (lossless); interior
  progress summaries are lossy.
- **Backpressure falls out of pubsub.**
  Springs hold per-subscriber cursors, so a slow subscriber costs itself,
  not the engine; a very-behind subscriber is served from journal
  segments on disk rather than from memory.
- **Cross-peer mirroring (future).**
  Because the journal is plain data, a run can be mirrored read-only to
  another peer by shipping `exportJournal(fromSeq)` increments; the
  daemon's synced-store machinery is a candidate carrier, deferred until
  a concrete remote-dashboard need arrives.

### Restart recovery

On daemon boot, `revivePins()` wakes the engine caplet; `make()` runs
recovery before serving:

1. For each run directory: load `snapshot.json`, fold `events/` tail,
   rebuild `{ state, context, pending }`.
2. For each pending effect: re-`provide` its durable promise id and
   re-await (promises settle from their stores — no work is repeated);
   re-issue unsettled idempotent `call`s; route indeterminate calls to
   `onError`; reconcile `after` timers against the reminder store.
3. Re-open topics; new subscribers see current status immediately and
   history from any `fromSeq`.

### Failure handling

Each state may declare `onError` (a transition target for
`effect.rejected` events not otherwise matched) and effects may declare
`retry` (reusing `@endo/reminder` backoff).
An unhandled rejection drives the run to the implicit `failed` final
state.
Terminal states are `succeeded` / `failed` / `abandoned` / `aborted`; the
`final` tag on a state names which.

### Definition immutability and upgrade

A run pins its definition by content hash; definitions are immutable.
Publishing `feature-change` v2 does not disturb in-flight v1 runs; an
operator may `abort` and re-`start`, or use `forceTransition` for a manual
migration — both audited.
This sidesteps replay-divergence entirely: the fold semantics for a run
are fixed at start.

### Live UI: the workflow space

`@endo/space-workflow` is a Chat space in the `space-*` pattern
(pure confined Preact components like `space-floot`, styles shipped via
the package export map).

**Data flow.**
A `makeWorkflowSyncClient(run)` helper (shipped by `@endo/workflow`, used
by both the space and the CLI's `--watch` mode) implements the State
Syncing contract: one `status()`, then `history(throughSeq + 1)` applied
through the shared fold, with seq-resume on reconnect.
Components subscribe to the client's store; there is no component-level
polling and no second source of truth.

**Layout: three panes.**

- **Runs rail (left).**
  Dashboard fed by `followRuns()`: grouped by definition, deduped by
  runId, live badges (`state`, age, pending-gate indicator), run trees
  indented under their parents via the `parent` linkage.
  Final states use one consistent color language (succeeded / failed /
  abandoned / aborted) shared with the timeline.
- **Statechart (center).**
  The definition rendered by a **deterministic pure layout function**
  (`renderDefinition(def) -> graph model`): compound states as nested
  boxes, parallel regions as lanes, transitions as edges labeled with
  their event types.
  Definitions are small (tens of states), so a layered
  longest-path-then-order layout in the space package suffices — no
  external layout dependency.
  Live overlays from the sync store: the active state configuration
  highlighted; each in-flight effect drawn as a spinner on its state's
  border with elapsed time and retry count; `fanout` progress as `3/5`
  member counters; a `spawn` state deep-links to the child run's view.
- **Timeline (right).**
  Virtualized event list from the sync store, newest last, filterable by
  event type and actor; each entry expands to its full journal record.
  Pending gates render as actionable cards: a `form` gate embeds the
  shipped inbox form component (submission flows through the ordinary
  mail path — the space holds no special write authority, R6); a
  `request` gate shows recipient and age.

**Time travel.**
A scrubber under the statechart binds to `stateAt(seq)` semantics —
implemented client-side by re-folding the already-synced prefix, so
scrubbing is instant and offline.
Scrubbed-to state renders solid, live state as a ghost outline, and the
timeline auto-scrolls to the scrub point; this doubles as the
post-mortem review UI for finished runs.

**Authority-scoped affordances.**
The space renders what its capability can do: with an observer facet it
is read-only; if granted the admin facet, `pause` / `resume` / `abort` /
`retryEffect` appear, and every use round-trips through the journaled
admin methods so UI actions are audited like any other.

**Degradation.**
On disconnect the space shows a stale-since badge and resumes from
`lastSeq + 1` on reconnect; nothing is lost and nothing reloads from
scratch.

The CLI grows matching verbs over the same surface:
`endo workflow define|list|start|status|watch|log|graph|simulate|explain|signal|pause|resume|abort`.

## Definition Developer Experience

Definitions are data, so the authoring loop is: write, validate,
simulate, preview — all without a daemon.

**Authoring.**
A definition is a plain hardened JS module (or JSON document) —
`endo workflow define feature-change ./feature-change.js` evaluates the
module in a powerless compartment and registers the exported definition.
JS authoring gets constants, comments, and shared fragments for free
without any new language.
`WorkflowDefinition` TypeScript types ship in the package's `types.ts` so
editors check the shape as it is written.

**Validation with diagnostics, not just verdicts.**
`validateDefinition(def)` runs at `define()` time and returns structured
diagnostics (path, severity, message), not a bare pattern failure:

- dangling transition targets and unreachable states;
- `to`/`attach` references to undeclared participants, and attenuator
  suffixes (`repo:readOnly`) not in the attenuator table;
- `when: { as }` correlations that no effect in scope issues;
- events no state handles (warning) and final states with outgoing
  transitions (error);
- guard/reducer expressions **parsed in the compartment at define time**,
  so syntax errors surface immediately rather than at first transition;
- fragment `use` bindings checked against the fragment's declared slots
  and context reads/writes.

Shape mismatches render through
[patterns-diagnostic-feedback](patterns-diagnostic-feedback.md)'s
`explainMismatch` when it lands, giving line-per-mismatch output sized
for both humans and coding agents.

**Simulation is the unit-test surface.**
`simulateRun(definition, script)` ships in the core package: effects are
recorded, never executed; the script injects events and asserts on state,
context, and issued effects.

```js
const sim = simulateRun(featureChange, { input, participants: stubs });
sim.expectEffect('request', { to: 'implementer' });
sim.inject('task.settled', { as: 'implementation', valueId: 'x' });
t.is(sim.state, 'reviewing');
```

Because the fold is pure, simulation is exact — not a mock of the engine
but the engine's own reducer under a scripted event source.
Definition authors test in plain ava with no daemon, in milliseconds.

**Preview.**
`endo workflow graph <name>` emits Mermaid `stateDiagram-v2` from the
same `renderDefinition` model the space uses, so a definition can be
reviewed as a picture in any markdown surface (PRs, designs) before it
ever runs.

**Evolution.**
`define` under an existing name appends a version (names.json maps name
to an ordered hash list); `endo workflow diff <a> <b>` is a structural
data diff of two definitions — no code archaeology to see what changed
between versions.
A `defineWorkflow` builder DSL remains future work (Known Gaps).

## Debuggability

The journal makes the engine explainable after the fact; these tools make
it explainable while it runs.

**Read the ground truth.**
`endo workflow log <run> [--from seq] [--follow]` pretty-prints journal
events (with `--json` for the raw records); `exportJournal(fromSeq)`
serves the same bytes to programs.
Effect entries carry idempotency keys and issue/settle timestamps;
`effect.rejected` records the marshalled error rendered via
`passableAsJustin`, so remotable-bearing failures stay legible.

**Time travel.**
`stateAt(seq)` folds the journal prefix — `endo workflow status <run>
--at <seq>` and the space's scrubber both use it.
Any historical claim about a run ("it was in `testing` when the daemon
restarted") is checkable, because state *is* the fold.

**Explain stuck runs.**
`explain()` answers the operator's actual question — *why is nothing
happening?* — with a `StuckReport`:

- each pending effect with its age, retry count, and target participant
  (including liveness of the target's formula where knowable);
- the event types the current state configuration is waiting for;
- for recent events that matched no transition: per-transition verdicts —
  pattern mismatches explained via `explainMismatch`, expression guards
  reported as their boolean or thrown error.

With a per-run `trace: true` flag (set at start or toggled by admin),
guard evaluations are journaled as `guard.evaluated` events — off by
default to keep journals lean, priceless when a definition misbehaves.

**Pause, poke, resume.**
`pause()` stops effect issuance while events continue to journal and
queue; `resume()` processes the queue.
Paused runs are the safe context for `injectEvent` and `retryEffect`.
All of it is journaled with actor identity — debugging leaves footprints
in the same audit log it reads.

**Fork to sandbox.**
`forkSimulation(runId, { atSeq })` copies a journal prefix into a
simulator: test a candidate fix — an injected event, a forced
transition — against the run's real history without touching the live
run.
This is the debugging payoff of keeping the fold pure and the journal
plain data.

**The engine debugs itself.**
Recovery appends a `recovery.completed` event recording what it resumed,
re-issued, and marked indeterminate — restart behavior is audited, not
folklore.
Engine-internal diagnostics go to stderr per the repo's diagnostic
discipline, gated by `ENDO_WORKFLOW_TRACE=1`, and never into the journal.

## The Motivating Use Case, End to End

Wiring the example with existing capabilities:

1. **Provision**: `endo workflow define feature-change ./feature-change.js`
   (validated and simulateable before it ever runs), then the host mints a
   factory binding the sensitive slots:
   `endo workflow make-factory feature-change feature-changes`
   `--bind implementer=lal-coder --bind reviewers=sec-reviewer,style-reviewer`
   `--bind ci=repo-ci --bind approver=SELF --bind repo=repo-writer`.
   `repo-writer` is an `@endo/exo-git` writer facet scoped to the branch;
   `repo-ci` is a small caplet wrapping a `Shell` capability that runs the
   test command in a checkout.
   Starting a run now needs only the factory and the input:
   `endo workflow start feature-changes --input request='add dark mode',branch=feat/dark-mode`
   — and because the factory is a grantable capability, that start could
   equally come from an agent that holds none of the bound facets.
2. **Implementing**: lal receives an inbox request with the writer facet
   attached; it commits to the branch and resolves the request with the
   change-set reference (`filesystemAt(ref)` / a commit range).
3. **Reviewing**: each reviewer receives a request with the *reader* facet
   (attenuated by the engine via `repo:readOnly`); verdict objects join
   under `all`.
   A changes-requested verdict loops back with feedback in context.
4. **Testing**: the CI `call` runs with retry; a red run loops back to
   implementing with the failure attached.
5. **Approving**: the user sees a form in their inbox (and inline in the
   workflow space); the reply is a durable `value` message.
6. **Merging**: the engine — sole holder of the writer facet during review
   — calls `merge`; `run.finished { final: 'succeeded' }` closes the
   journal.
7. At any point, `endo workflow status` answers R4; a restart between any
   two steps resumes silently per R2; `exportJournal` yields the audit
   trail per R3.

## Dependencies

| Design / package | Relationship |
|------------------|--------------|
| Daemon promise/resolver formulas | **Complete** — the durability keystone for `request`/`call` settlement |
| [daemon-form-request](daemon-form-request.md), [daemon-value-message](daemon-value-message.md) | **Complete** — human gates |
| `@endo/pubsub`, `@endo/exo-stream` | **Complete** — subscription surface |
| `@endo/platform/fs/extended`, daemon mounts | **Complete** — journal backing |
| [endo-reminder](endo-reminder.md) | Not Started — `after` timeouts and retry backoff; until it lands, the unconfined engine may use worker-local timers with journal-recorded deadlines (recovery re-arms from `at` + `ms`) |
| [daemon-git-capability](daemon-git-capability.md) / `@endo/exo-git` | Landed capability trio — the worked example's repo participant |
| [daemon-agent-tools](daemon-agent-tools.md), [agentry-agent-builder](agentry-agent-builder.md) | Parallel lane — supplies the implementer/reviewer agents; no hard dependency |
| [daemon-commands-as-messages](daemon-commands-as-messages.md) | Sibling audit concern; workflow journals its own admin actions regardless |

## Phased Implementation

1. **Core interpreter and devex substrate (`@endo/workflow`, host-agnostic).**
   Definition schema + `validateDefinition` structured diagnostics;
   powerless-compartment guard and reducer evaluation (parse at define
   time); the pure shared fold; `simulateRun`; journal store over
   `fs/extended` with write-then-move segments and snapshots; ava tests
   over an in-memory tree, no daemon.
   The simulator ships first because every later phase tests through it.
2. **Daemon integration.**
   Unconfined plugin `make(powers)`; participant binding via the guest
   namespace; `request`/`form`/`call` effects over mail and durable
   promises; `@pins` recovery with the `recovery.completed` journal
   event; serial-jobs discipline around journal appends.
3. **Composition.**
   `fanout`/join, compound states, parallel regions, `spawn` child runs
   with input/output mapping and abort cascade, fragments with
   define-time inlining (plus the initial `approval-gate` /
   `retry-with-backoff` / `review-fanout` fragment library), `after` via
   reminder (or the interim timer shim).
4. **Surface: sync, factories, CLI.**
   `WorkflowService`/`WorkflowRun`/`WorkflowRunAdmin`/`WorkflowFactory`
   exo guards; the State Syncing contract (`status` + gapless
   `history(fromSeq)` splice, `followStatus`, `followRuns`,
   `makeWorkflowSyncClient`); `stateAt` / `explain` / `pause` / `resume`
   / `forkSimulation`; `exportJournal`; factories with non-escalating
   `with()` derivation; the full `endo workflow` verb set
   (`define|list|start|status|watch|log|graph|simulate|explain|signal|pause|resume|abort`).
5. **UI space.**
   `@endo/space-workflow`: runs rail with run trees, deterministic
   statechart layout with live effect/fanout overlays, virtualized
   timeline, time-travel scrubber over the client-side fold, inline form
   gates, authority-scoped admin affordances.
6. **Worked example as integration test.**
   The feature-change definition end to end with a scripted "agent"
   (deterministic stub) for CI, then a live lal wiring behind an
   env-gated test, exercising restart-mid-review, factory-mediated
   start, and a fork-to-sandbox debugging drill.

## Design Decisions

1. **Plugin, not formula type.** Follows the reminder precedent; daemon
   core is untouched; `endor` is unaffected.
2. **Event sourcing, not state mutation.** The audit log is the primary
   artifact, state a derived fold; recovery and observability both read
   the same journal.
3. **Statechart subset, not flat FSM, petri net, or code.** Covers
   fan-out/join and hierarchy while remaining renderable data; code
   workflows deferred to a future authoring layer that compiles to this
   schema.
4. **Powerless-compartment reducers.** Guards prefer `@endo/patterns`;
   arbitrary context math uses pure hardened expressions with no
   authority, keeping definitions data-like without inventing an operator
   zoo.
5. **Closed effect vocabulary aimed at declared participants.** The only
   authority a run wields is what was named at `start()`; attenuation
   (`repo:readOnly`) happens at effect issue time.
6. **Externalized settlement for durability.** Wherever possible, effects
   settle through daemon-durable state (promise stores, message formulas,
   reminder store) so the engine can crash at any instant and resume by
   re-providing ids.
7. **Idempotency keys with an honest `indeterminate` path.** At-least-once
   is admitted, not papered over; non-idempotent calls route to `onError`
   after a crash instead of silently re-firing.
8. **Content-addressed immutable definitions.** Runs pin their semantics
   at start; upgrade is explicit and audited.
9. **Journal layout follows the reminder store's atomicity contract.**
   Write-then-move segments; the store backing is swappable
   (host dir, mount, memory).
10. **Factories are the grant unit.** Routine starts go through a durable
    `WorkflowFactory` that closes over participant bindings, so callers
    start workflows without holding the underlying capabilities, and
    derivation (`with()`) is strictly non-escalating.
11. **One sync primitive.** Every view — engine, CLI, space — is a fold
    over the seq-addressed journal; `status()` hands out the resume
    token, `history(fromSeq)` is gapless, reconnect is resume, and the
    fold module ships authority-free for client-side use.
12. **Simulator-first devex.** The engine's own reducer runs under
    scripted events with recorded effects; definitions are unit-tested
    without a daemon, and `forkSimulation` reuses the same machinery for
    live-run debugging.
13. **Debugging leaves footprints.** Pause/resume, injected events,
    forced transitions, trace toggles, and recovery itself are journal
    events with actor identity; there is no unaudited side door.
14. **Composition without new subsystems.** Fragments flatten at define
    time; children are ordinary runs with explicit participant passing
    and downward-only cancellation; cross-run coordination is just runs
    holding each other's facets as participants.

## Known Gaps and TODOs

- [ ] Pin the exact definition-schema pattern (`WorkflowDefinitionShape`)
      including the compound/parallel grammar.
- [ ] Decide the powerless-compartment expression budget (length caps,
      evaluation metering) and its error diagnostics.
- [ ] Reviewer verdict shape for `fanout` joins (free object vs. a
      conventional `{ verdict, comments }` pattern).
- [ ] Reminder-service integration details once
      [endo-reminder](endo-reminder.md) lands (per-run reminder budget,
      catch-up policy mapping for `after`).
- [ ] Journal compaction and retention policy defaults; interaction with
      `exportJournal` guarantees.
- [ ] Whether `WorkflowRunAdmin` should be grantable to non-host agents
      (a "workflow steward" role) and under what guard.
- [ ] Fragment namespacing details: collision rules when a definition
      `use`s the same fragment twice, and whether fragment-internal
      events are hidden from the outer definition or prefixed.
- [ ] The initial fragment library's exact contracts (`approval-gate`,
      `retry-with-backoff`, `review-fanout` boundary events and slots).
- [ ] Factory limit vocabulary (`maxConcurrent`, `maxStartsPerDay`, what
      else) and where breaches surface (reject at `start` vs. queue).
- [ ] `explain()` participant-liveness probing: how much the engine may
      infer about a target formula without generating noisy CapTP calls
      (respect the `__getMethodNames__` introspection convention).
- [ ] A `defineWorkflow` JS builder — workflow-as-code ergonomics compiled
      to the data schema — future design.

## Prompt

> for endo daemon, design a workflow system, like a composeable finite
> state machine. one motivating use case: request for ai agent (floot,
> lal) to implement feature on a git endo object. changes are made and
> submitted. review begins, potentially by many specialist reviewers. if
> changes requested, reviews returned to implementation agent. after
> passing reviews, ci runs. after passing ci, user is prompted for
> approval. after approval, change set is merged and applied.
> but this is just an example use case, the system should be generic and
> composeable and durable and survive restarts. should result in an audit
> log. should be able to query and subscribe to current status and render
> in a Ui space. explore and plan out the implementation options
