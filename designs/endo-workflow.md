# Endo Workflow: Durable Composable State Machines

| | |
|---|---|
| **Created** | 2026-08-16 |
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

## Implementation Options

Three architectures were considered for where the engine lives and what a
workflow *is*, plus two cross-cutting choices (formalism and storage).

### Option A: Engine in daemon core (new formula types)

Add `workflow-definition` and `workflow-run` formula types.
The manager incarnates runs, persists state in SQLite alongside formulas,
and exposes host methods (`formulateWorkflow`, `provideWorkflowRun`).

- **Pros:** first-class GC/retention integration; visible in the formula
  inspector; single durability story (the formula graph); no separate
  revival recipe.
- **Cons:** grows the daemon core precisely when the project direction is
  to shrink it (the reminder design explicitly rejected a new formula type;
  [daemon-rename-to-manager](daemon-rename-to-manager.md) and `endor`
  aim at a smaller core).
  Every workflow schema evolution becomes a daemon schema migration.
  Iteration is slow: engine bugs require daemon releases.
  The Rust `endor` port would have to reimplement it.

### Option B: Unconfined plugin, event-sourced statechart interpreter (recommended)

`@endo/workflow` is an unconfined daemon plugin in the mold of
`@endo/reminder`: provisioned with `makeUnconfined`, pinned via `@pins`,
holding a virtual-file-system directory for durable state and a guest
namespace for participant capabilities.
Workflow **definitions are hardened data** (a conservative statechart
subset); the engine is an **event-sourced interpreter**: an append-only
journal of events is the source of truth, current state is a pure fold over
the journal, and effects are executed at the boundary and re-enter as
events.

- **Pros:** matches the repo's plugin direction; the audit log falls out of
  the architecture (the journal *is* the audit log, R3); restart recovery
  is journal replay plus effect resumption (R2); definitions-as-data are
  renderable as a graph (R12) and validatable with `@endo/patterns`;
  daemon core is untouched.
- **Cons:** retention is engine-owned (names in the engine guest's pet
  store) rather than formula-graph-native; the declarative definition
  language must be designed carefully to avoid becoming a bad programming
  language (addressed below with powerless confined reducers).

### Option C: Workflow-as-code caplet (durable execution)

Each workflow is a confined caplet whose *code* is the process — the
Temporal/Restate shape: deterministic code replayed against a journal of
recorded effect results, `await`ing durable promises at each step.
Endo is unusually well positioned for this (deterministic SES compartments,
[ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) journal
replay, XS heap snapshots).

- **Pros:** arbitrary control flow with no definition language; maximal
  composability (it is just code calling code).
- **Cons:** the process is opaque — no data structure to render as a graph,
  no uniform status surface (R4/R5/R12 need bespoke instrumentation per
  workflow); code upgrade of long-lived runs is the hardest version of the
  upgrade problem (replay divergence); determinism discipline is a
  per-author burden the engine cannot check.

### Formalism choice

| Formalism | Fan-out/join | Renderable | Upgrade-safe | Complexity |
|-----------|--------------|------------|--------------|------------|
| Flat FSM | poor (state explosion) | yes | yes | low |
| Statechart subset (hierarchy + parallel regions + guards) | good | yes | yes | medium |
| Petri net | excellent | yes, but unfamiliar | yes | high |
| Deterministic code (Option C) | excellent | no | hard | low to write, high to operate |

A **conservative statechart subset** is chosen: atomic states, compound
(hierarchical) states, parallel regions with join, guarded transitions,
entry effects, and final states.
No history states, no internal transitions, no activities — additions can
be considered later against real definitions.
Petri nets are strictly more expressive for join patterns but the
statechart's parallel-region join covers R8, and statecharts render as the
familiar boxes-and-arrows diagram Chat should draw.

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

### Storage choice

| Backing | Pros | Cons |
|---------|------|------|
| Virtual-FS event-segment files + snapshot (recommended) | Backing-agnostic (host dir, mount, memory for tests); greppable; reminder-store atomicity precedent; no daemon schema change | One file per event until compaction |
| Daemon SQLite | Transactions, queries | Couples the plugin to daemon internals; Option A by the back door |
| Marshal formulas per event | Formula-graph GC | Thousands of formulas per run; wrong tool |

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

### Recommendation

**Option B**, with Option C acknowledged as a future *authoring layer*:
nothing prevents an agentry code-mode agent from *generating* definitions,
and a later `defineWorkflow` builder could compile a restricted JS DSL to
the data schema.
Option A is rejected for daemon-core footprint; if the engine proves
load-bearing, promoting the journal into the manager database is a
migration of the storage seam, not of the model.

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

### Query and subscription surface

The engine exposes exos with `M.interface` guards:

```
WorkflowService (host-facing)
  define(name, definition)            -> definitionHash
  definitions()                       -> [{ name, hash, version }]
  start(name, { input, participants }) -> WorkflowRun
  run(runId) / runs({ status? })      -> WorkflowRun / [RunSummary]
  followRuns()                        -> Reader<RunSummary>       # lossless

WorkflowRun
  status()          -> { runId, definition, state, context, pending, since }
  history(fromSeq?) -> Reader<Event>                # replay then live (R5)
  followStatus()    -> Reader<Status>               # lossy latest topic
  signal(name, payload)                             # declared external events
  exportJournal()   -> EndoReadable (JSONL)         # audit export (R3)

WorkflowRunAdmin (attenuation of run; host-only by default)
  abort(reason) / retryEffect(as) / forceTransition(target) / injectEvent(e)
```

`history` composes a replay of journaled events with a `makeChangeTopic`
subscription; `followStatus` uses `makeLatestTopic`; both travel over
`@endo/exo-stream`.
Every admin method journals `admin.forced` with the caller's handle
identity — overrides are audited, not hidden.

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

### UI space

`@endo/space-workflow` is a Chat space in the `space-*` pattern:

- Left: run list from `followRuns()` with status badges.
- Center: the definition rendered as a statechart diagram (definitions are
  data, so the renderer is a pure function; parallel regions as swim
  lanes) with the current state highlighted from `followStatus()`.
- Right: the event timeline from `history()`, each entry expandable to its
  journal record; pending forms deep-link to the existing inbox form
  rendering, so approval happens through the already-shipped form UI
  (R6, R12).

The CLI grows `endo workflow define|start|status|watch|log|signal` verbs
over the same surface.

## The Motivating Use Case, End to End

Wiring the example with existing capabilities:

1. **Provision**: `endo workflow define feature-change ./feature-change.json`;
   `endo workflow start feature-change --input request='add dark mode',branch=feat/dark-mode`
   `--participant implementer=lal-coder --participant reviewers=sec-reviewer,style-reviewer`
   `--participant ci=repo-ci --participant approver=SELF --participant repo=repo-writer`.
   `repo-writer` is an `@endo/exo-git` writer facet scoped to the branch;
   `repo-ci` is a small caplet wrapping a `Shell` capability that runs the
   test command in a checkout.
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
| [ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) | Reference for the rejected Option C replay shape |

## Phased Implementation

1. **Core interpreter (`@endo/workflow`, host-agnostic).**
   Definition schema + pattern validation; powerless-compartment guard and
   reducer evaluation; the pure fold; journal store over
   `fs/extended` with write-then-move segments and snapshots; ava tests
   over an in-memory tree, no daemon.
2. **Daemon integration.**
   Unconfined plugin `make(powers)`; participant binding via the guest
   namespace; `request`/`form`/`call` effects over mail and durable
   promises; `@pins` recovery; serial-jobs discipline around journal
   appends.
3. **Composition.**
   `fanout`/join, compound states, parallel regions, `spawn`
   sub-workflows, `after` via reminder (or the interim timer shim).
4. **Surface.**
   `WorkflowService`/`WorkflowRun`/`WorkflowRunAdmin` exo guards;
   `followStatus`/`history`/`followRuns` topics; `exportJournal`; `endo
   workflow` CLI verbs.
5. **UI space.**
   `@endo/space-workflow`: run list, statechart renderer, event timeline,
   inline form gates.
6. **Worked example as integration test.**
   The feature-change definition end to end with a scripted "agent"
   (deterministic stub) for CI, then a live lal wiring behind an
   env-gated test, exercising restart-mid-review.

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
- [ ] A `defineWorkflow` JS builder (Option C's ergonomics compiled to the
      Option B schema) — future design.

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
