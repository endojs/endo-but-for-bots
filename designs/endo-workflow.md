# `@endo/workflow`: A Durable Workflow System for the Endo Daemon

| | |
|---|---|
| **Created** | 2026-08-17 |
| **Updated** | 2026-09-02 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Status

Phases 1–4 are implemented as `packages/workflow` (`@endo/workflow`),
with Phase 5's status feeds, the `@endo/space-workflow` Chat space, and
a fake-daemon realization of Phase 6's acceptance flow; the package test suite
and lint pass.
A cross-review against the parallel implementation on
`claude/endo-workflow-system-5u7764` folded that branch's best ideas
into this one (hardening round below).

- **Phase 1 (kernel)** — `src/machine.js` (`assertChart`, `initialStep`,
  `transition`, `exitEffects`, `activePaths`), `src/template.js` (total
  substitution + string interpolation), `src/journal.js` (entry shapes,
  `applyEntry`, `foldJournal`, `effectRecordsFor`). Pure and synchronous;
  importable standalone via `@endo/workflow/machine.js`.
- **Phase 2 (service plugin)** — `src/service.js` + `src/index.js`
  (`make(powers, context, { env })`): runs journal as numbered marshal
  entries under `workflow/runs/<runId>/` in the powers agent's pet store,
  with `invoke` / `emit` / `after` effects, snapshots every 64 entries,
  recovery-by-refold, and the `@pins` revival recipe in the package
  README.
- **Phase 3 (mail)** — the `ask` effect over `request` / `form` with
  `responseName` correlation, recovery-time answer adoption via
  `maybeLookup` and `@mail/<n>/@result`, a `followMessages` watcher for
  form replies, chart-declared `ports` with `mustMatch` guards, and
  structural `by` attribution throughout the journal.
- **Phase 4 (composition)** — compound states, parallel regions with
  `counts`/`outcomes` join envelopes, `$eachParam` expansion, `spawn` /
  child settlement with cancel cascade, and endowment subsetting by name.
- **Phase 5** — `status()` / `explain()`, seq-cursored
  `follow({ since })`, `journal({ from, to })`, `list()`, and
  `followRuns()` ship as far readers over `@endo/exo-stream`;
  `packages/space-workflow` renders runs in Chat (runs rail, SVG
  statechart with active-path and pending overlays, journal timeline,
  time-travel scrubber over the client fold), wired through
  `packages/chat` as a space mode. CLI verbs remain unbuilt.
- **Phase 6 (acceptance, fake substrate)** —
  `test/feature-change.test.js` drives the motivating chart end to end
  over an in-memory fake of the daemon's agent surface
  (`test/fake-agent.js`, faithful to the durable/ephemeral split): two
  review rounds with feedback, a mid-CI daemon restart with idempotent
  re-dispatch, operator form approval, merge, and audit assertions.
  The live-substrate flow (agentry implementer, real git, sandboxed CI)
  remains open.

Deviations from the design as first written, adopted during the build:

1. **The `event` and `fired` journal entries are coalesced** into one
   `event` entry with an optional `fired` payload. The kernel is
   synchronous, so the step is computed before the append and both halves
   commit in a single write — closing the crash window the two-entry
   shape would have had. `child-settled` is likewise folded into
   `effect-settled` on the parent's spawn effect (`spawned` remains).
2. **Effect-outcome events are path-routed.** An envelope carrying the
   owner effect's state path is delivered only along that path (bubbling
   innermost-out over the still-active prefix), so the outcome of one
   region's ask cannot fire its identical sibling regions. Pathless
   envelopes broadcast as designed.
3. **Regions carry their own `params`/`context` inside the configuration
   tree**, and the `$eachParam` form gains an `input` template
   (substituted against the entering scope) so context values — the
   submitted head ref — can flow into region params.
4. **Ask idempotency rides a description marker.** Each ask's description
   carries `[workflow <runId> <effectId>]`; dispatch scans the service's
   own mailbox for the marker before sending, making re-dispatch after a
   crash send-free. `form()` is fire-and-forget in the daemon, so this
   marker is also how form correlation ids are recovered.
5. **`followRuns()` is a lossless change topic in v1** rather than the
   conflating latest-topic the design named; the conflating upgrade
   awaits a consumer that needs it.
6. Nested compound states raise a `state-done` internal event when their
   child reaches a final state — a small addition the design did not
   enumerate.
7. **The invoke idempotency key on the wire is run-qualified**:
   `${runId}:${effectId}` rather than the bare effect id.
   Effect ids are `${seq}-${index}`, unique within one run only, and an
   endowment is typically shared by many runs (a factory binds one
   target for all of its runs), so a target deduping on the bare id
   would conflate distinct runs' effects.
   Journal entries and pending records keep the run-scoped id; only the
   trailing argument handed to the target carries the run prefix —
   matching the run-qualified `[workflow <runId> <effectId>]` marker the
   ask path already uses.
   Adopted 2026-08-18 for the floot-admin-deploy-workflows integration,
   whose deploy performer is exactly such a shared endowment.

Hardening round (2026-08-18), after the cross-review of the two parallel
implementations — each item either fixes a weakness the comparison
surfaced here or adopts (and, where the pet store allows, strengthens)
an idea from the other branch:

1. **Capability redaction with durable refs.** Journal entries are now
   capability-free data: remotables in params and settled values redact
   to `ref-<n>` alias strings whose capabilities park durably under
   `runs/<runId>/refs/`. Observers read a legible audit log without
   acquiring authority; the control facet's journaled `resolveRef`
   recovers the capability. (The other branch aliased in memory only;
   the pet store makes the mapping — and GC retention — durable.)
2. **Journal hash chain.** Every entry carries `prev`, the SHA-256 of
   the previous entry's canonical encoding (`canonicalStringify`, which
   refuses remotables — so hashing also enforces redaction). Recovery
   verifies the chain and surfaces breaks as `integrity`; sync clients
   re-verify end-to-end.
3. **Fail-loud settlements.** An ask/invoke/spawn settlement that fires
   no transition fails the run instead of wedging it silently, kernel
   throws fail the run, and exit-effect (compensation) settlements are
   exempt by an `exit` mark on their records. `install` gates on
   `chartDiagnostics` errors (statically unhandled outcomes);
   unreachable states and deaf timers warn.
4. **Facet split corrected.** `port()` moved off the shareable run facet
   onto control; the run facet is observation-only and gains
   `explain()`. Pending records carry `since`.
5. **Delimited interpolation.** Ask/form text renders substituted values
   as quoted data (`interpolateDelimited`), so participant-supplied
   strings cannot masquerade as workflow instruction to a human or LLM
   recipient.
6. **Durable factories.** `makeFactory` binds a chart + data params +
   endowments as a revocable grant; `start` fills open slots and returns
   the observer facet only; `with()` derives narrower factories;
   `revoke()` cascades over durable parent links and cancels live runs;
   all of it survives restarts (records in the pet store, run
   attribution via the `started` entry's `factory` field).
7. **Authoring and observation tools.** `chartDiagnostics`,
   `makeSimulator` (kernel + fold, effects settled by hand, engine
   policies intact), `renderGraph` / `renderMermaid` /
   `externalEventTypes`, and `makeRunSyncClient` (client-side fold
   mirror with `stateAt` time travel and chain verification).

A second hardening round followed, from six parallel adversarial review
subagents (engine durability, kernel semantics, ocap boundaries,
journal/fold, space integration, conventions/coverage), whose confirmed
findings were all fixed and regression-tested (81 tests):

1. **Atomic composite entries.** A settlement and the transition it
   fires, and a step and its terminal outcome, commit as one journal
   write (`settles` / `terminal` on the `event` entry); internal events
   and `emit`s are journaled as id'd delivery obligations
   (`fired.internals`, `delivers`) that recovery re-dispatches — closing
   the settle/step, step/complete, and lost-cascade crash windows.
2. **Recovery robustness.** Per-run isolation at init (one corrupt
   journal no longer bricks the service), aborted-mint directories
   skipped (no phantom runs from rejected starts), deterministic child
   run ids so spawn re-dispatch adopts instead of duplicating, queued
   events drained after a crash mid-resume, and replay stops at a
   terminal outcome (a completed run can no longer flip to failed).
3. **Ocap tightening.** Charts asserted capability-free (an embedded
   remotable would have leaked through the shareable run facet's
   `chart()`); ports and control signals refuse statically named
   engine-producible event types (no forged `state-done` / quorum joins / other
   participants' settlements) and strip engine-owned routing and settlement
   metadata; templated event types are not enumerable and security-sensitive
   charts use literal types;
   factory start/revoke and derive/revoke races closed by durable
   re-checks; depth caps on redaction/encoding with unencodable
   settlement values converted to loud effect failures.
4. **Kernel completeness.** An immediately-final compound child now
   raises `state-done` at entry (was a silent wedge); region final
   states named `pending` are rejected (reserved join-count key);
   diagnostics warn on unhandled `state-done` symmetrically with
   `regions-settled`.
5. **Space correctness.** The confined renderer's tag allowlist admits
   the statechart's SVG (it previously flattened to text); reader
   disposal goes through the local iterator (exo readers have no
   `return`); `$eachParam` overlay ids normalize onto the drawn
   representative region; plus error-boundary, stale-banner, key, and
   timeline fixes, and integrity/chain-verification affordances.

A third round (2026-09-02) fixed the pull-request review's blockers:

1. **Dispatch throws settle, never strand.** An exception while
   dispatching an effect — an unparseable `after.at`, a rejected
   `request`/`form` send, a spawn whose child params refuse its chart —
   converts to a journaled failed settlement (honoring the effect's
   `failure` transition, else the fail-loud terminal), at first dispatch
   and at recovery re-arm alike; timer settlements joined the fail-loud
   classes (`by: 'timer'`).
2. **Bounded timer hops.** Node's `setTimeout` clamps delays beyond
   2^31−1 ms to 1 ms, so a distant `after` deadline would have fired
   immediately; timers now arm in bounded hops against the durable
   absolute deadline.
3. **Injective symbol encoding.** The canonical journal encoding names
   symbols with `nameForPassableSymbol` (well-known `Symbol.iterator` ≠
   registered `Symbol.for('Symbol.iterator')`) and refuses unpassable
   symbols, so no two distinct entries can share a hash.

## What is the Problem Being Solved?

The daemon can now host every *ingredient* of a long-running, multi-party
process, but nothing that holds the *process itself*.

Consider the motivating use case.
An operator asks an AI agent (floot, lal, or an `@endo/agentry`-built agent)
to implement a feature against a git-backed workspace (the mount + `Git` +
`GitRemote` trio of [daemon-git-next-steps](daemon-git-next-steps.md)).
The agent makes changes on a branch and submits them.
Review begins, potentially by several specialist reviewers — some human, some
agents themselves.
If changes are requested, the feedback returns to the implementation agent
and the cycle repeats.
After reviews pass, CI runs.
After CI passes, the operator is prompted for final approval.
After approval, the change set is merged and applied.

Every step of that loop exists today as a capability or a message verb:

- the workspace loop (edit → status/diff → commit → push → inspect history)
  closed as the git-stack milestone;
- agents are constructed and tasked via `@endo/agentry`'s `defineAgent`;
- structured human prompts exist as durable `form` / `submit` and
  `request` / `resolve` mail;
- read-only review views exist as `Git.filesystemAt(ref)` / `tree(ref)`.

What does not exist is the thing that *sequences* them:

1. **Nobody owns the state between steps.**
   Today the process state lives in a human's working memory, a chat
   transcript, or an agent's context window.
   None of those survive a daemon restart, none can be queried, and none can
   refuse an out-of-order step ("merge before CI passed").
2. **No durability across restarts.**
   The daemon's mail is durable and `request` resolutions are write-once
   durable formulas, but the *orchestration* — "we are in review, waiting on
   two of three reviewers, CI not yet started" — evaporates with the process
   that improvised it.
   The daemon has already met this problem once and deferred it: the mount
   policy modes `tofu-prompt` / `tofu-attenuator` are refused today
   (`packages/daemon/src/host.js:207`) precisely because a formula-owned
   policy cannot *ask a human and durably await the answer*.
   A durable workflow run is the missing shape: a persistent process that can
   stop on a question for hours or days, survive restarts, and resume when
   the answer arrives.
3. **No audit log.**
   When the loop is improvised, there is no single record of who caused each
   step, what was decided, and why the run is where it is.
   [daemon-commands-as-messages](daemon-commands-as-messages.md) names the
   same gap for individual agent commands; a workflow needs the per-process
   equivalent.
4. **No status surface.**
   There is nothing to render in a UI space: no "where is this change in its
   lifecycle?", no live subscription an inbox or dashboard can follow.
5. **No composition.**
   A review-then-merge process should be one reusable, parameterized value
   that can embed other processes (each reviewer's checklist could itself be
   a workflow) and be embedded in bigger ones (a release train of many
   change sets).

The git use case is only the motivating example.
The same shape recurs everywhere agents and humans cooperate over time:
provisioning flows, scheduled maintenance with approval gates, content
pipelines, incident response, multi-agent research with adjudication.
The system must therefore be **generic** (no git-specific vocabulary in the
engine), **composable**, **durable**, **auditable**, and **observable**.

## Requirements

1. **Generic, composable finite state machines.**
   Workflow definitions are data, not prose or code: states, guarded
   transitions, and effects, with hierarchical nesting, parallel regions
   with join policies, and child workflows.
   The git flow is expressible; so is any other staged process.
2. **Durable.**
   A run survives daemon restarts and resumes without operator intervention:
   in-flight agent tasks are re-adopted or re-issued, pending human prompts
   remain answerable, timers re-arm.
3. **Audit log.**
   Every run yields an append-only journal of events, transitions, and
   effect outcomes, each entry attributed to the capability that caused it —
   attribution derived from facet identity, never from payload claims.
4. **Query and subscribe.**
   Current status is a passable snapshot; changes are followable with the
   daemon's snapshot-then-tail iterator idiom; a UI space renders both.
5. **Capability discipline.**
   The engine holds no ambient authority.
   Each run's authority is exactly the endowments granted at start; each
   participant holds exactly the facet for their role (a reviewer can submit
   *their* verdict and nothing else).
6. **Restart-honest effects.**
   Effects are the only place the engine touches the world.
   The design must be explicit about which effects are exactly-once (mail),
   which are at-least-once (direct invocations), and how idempotency is
   achieved.

## What the Daemon Already Provides

The design leans on surveyed, landed substrate.
This section records the load-bearing facts with their sources so the rest
of the document can cite them tersely.

### Durability substrate

- Every capability is defined by a **formula** — a small typed JSON record
  persisted in SQLite (`{statePath}/endo.sqlite`, `formula` table) — and
  re-derived ("incarnated") from its formula on demand after restart
  ([SQLITE-MIGRATION](../packages/daemon/SQLITE-MIGRATION.md);
  `provideController` / `evaluateFormula`,
  `packages/daemon/src/manager.js:4415`).
  Pet stores are durable name → formula-id tables.
  Formula bodies are plain JSON; cross-formula references are
  `FormulaIdentifier` strings, and passable *values* persist as `marshal`
  formulas (smallcaps body + formula-id slots,
  `formulateMarshalValue`, `manager.js:5673`) — so a stored value may
  contain remotables, but only remotables that are themselves
  formula-backed.
- **Restart is replay, not resumption.**
  Worker processes and all JS heap state are lost; a formula's maker runs
  from scratch on reincarnation (`test/endo.test.js:955`,
  `'closure state lost by restart'`).
  Durable state must live where makers can re-read it: pet-store entries,
  marshal formulas, CAS blobs, scratch-mount directories.
  A durable process is therefore necessarily **a fold over durable state,
  never a suspended coroutine**.
- The daemon eagerly revives exactly two collections at boot: `@nets` and
  the `@pins` directory (`revivePins()`,
  `packages/daemon/src/manager.js:3960`).
  Everything else revives lazily on demand.
  A plugin caplet wakes on restart iff something retains its identifier in a
  reviving collection — the integration-owned revival narrative established
  by [endo-reminder](endo-reminder.md).
- The in-tree template for a durable, ordered, restartable log is the
  **mailbox-store pattern**: a dedicated pet store whose names are decimal
  sequence numbers plus a `next-number` counter, appended under a
  `makeSerialJobs` lock and rehydrated by scanning on incarnation
  (`mail.js:604` `persistMessage`, `mail.js:630` `loadMailboxState`); the
  `channel` formula repeats the same pattern for its message log and member
  registry (`channel.js:117`).
- The in-tree template for a **durable state transition** is the
  promise/resolver pair: both formulas share one pet store; resolution
  commits by writing a `marshal` under the reserved name `status` (value
  first, then status, so GC cannot outrun the consumer); `resolveWithId` is
  serialized and idempotent; the promise re-reads `status` on incarnation
  and otherwise waits on `followNameChanges`
  (`manager.js:2375`–`2519`).
- **Messages are durable.**
  `deliver` persists each message as a formula and the mailbox rebuilds from
  its store on incarnation (`packages/daemon/src/mail.js:630`,
  `loadMailboxState`); dismissal durably removes the slot.
- **Request resolution is durable and write-once.**
  `request()` mints a promise/resolver formula pair
  (`formulatePromise`, `packages/daemon/src/manager.js:5710`); the resolver
  persists its outcome in its own pet store and the promise re-reads that
  status on incarnation (`manager.js:2375`).
  A request passed a `responseName` short-circuits if the name already
  resolves — the built-in idempotent resume hook (`mail.js:1059`).
  Every message's interior is name-addressable through the mail hub —
  `@mail/<n>/@result` durably names "the answer to message n"
  (`manager.js:2921`).
- **Forms are durable structured prompts.**
  `form(to, description, fields)` sends typed fields (each with `label`,
  `example`, `default`, `pattern`, `secret`); `submit` validates values with
  `mustMatch` and posts a durable `value` reply threaded by `replyTo`
  ([daemon-form-request](daemon-form-request.md)).
- The **virtual file system** (`@endo/platform/fs/extended`,
  [platform-fs](platform-fs.md)) provides the backing-agnostic durable
  store contract for plugins: reconciled tree verbs plus the
  write-then-`move` atomic-replacement obligation
  ([endo-reminder](endo-reminder.md) design decision 9).

### Subscription substrate

- The daemon's follow verbs (`followMessages`, `followNameChanges`,
  `followPeerChanges`, …) all share one idiom: **subscribe first, replay a
  snapshot of current durable state, then tail the live topic**
  (`mail.js:212`, `pet-store.js:131`).
- Topics are in-memory (`makeChangeTopic`,
  `packages/daemon/src/pubsub.js:66`); subscriptions do **not** survive
  restart — consumers re-follow and dedupe.
  `packages/pubsub` is the newer extraction of the same primitives and adds
  `makeLatestTopic`, a lossy conflating topic that is the right shape for
  "current status" feeds ([notifier-pubsub-migration](notifier-pubsub-migration.md)).
- Remote iteration crosses CapTP as a `PassableReader` via
  `readerFromIterator` / `iterateReader` from `@endo/exo-stream`, with
  pipelined flow control (`packages/exo-stream/iterate-reader.js`).

### Coordination substrate

- **Agents**: `@endo/agentry`'s `defineAgent(config)` returns a maker;
  calling it with powers yields a live coding agent whose de-facto task API
  is `agent.prompt(text)` / `agent.waitForIdle()` / `agent.subscribe(fn)`
  (`packages/agentry/src/eval/run.js:53`).
  `provisionEndoCodeMode` retains a durable per-session guest with
  workspace + git bindings and returns a plain, non-secret `persistence`
  record that `reconstructEndoCodeMode` can later revive without policy
  widening (`packages/agentry/src/code-mode-provisioning.js:136`) — a
  ready-made durable job-context primitive.
  Floot sessions are guests reachable both by direct
  `E(session).converse(input)` (streaming reader) and by mail (each session
  follows its own inbox and replies, `packages/floot/agent.js:868`); lal is
  a mail-driven guest whose only dispatch path is its inbox loop
  (`packages/lal/inbox-loop.js:36`).
  Guests are durable agents with mailboxes; work can be *asked* of them by
  mail and answered with durable resolutions.
  There is **no agent-reviews-agent loop anywhere in the tree today**; the
  closest gate is the eval harness's mechanical
  `scenario.assertOutcome({ git, workspace, readText })`
  (`packages/agentry/src/eval/run.js:61`).
- **Workspaces**: the git capability stack — `EndoMount` (content), `Git`
  (versioning), `GitRemote` (bounded network + credential),
  `Git.filesystemAt(ref)` / `tree(ref)` (read-only historical views) —
  with commit identity as formula-owned policy
  ([daemon-git-next-steps](daemon-git-next-steps.md)).
  `git`, `git-credential`, and `git-remote` are durable formula types;
  attenuation is a reader/writer/rewriter facet kit, but the sibling facets
  returned by `readOnly()` / `scope()` carry **no formula id of their own**
  — a durable read-only grant must be minted as its own
  `provideGit(mount, name, { readOnly: true })` formula
  (`packages/exo-git/src/git.js:733`, `packages/daemon/src/host.js:853`).
  There is no change-set object, no structured merge/conflict result yet
  (designed as [daemon-git-capability](daemon-git-capability.md) Phase 7),
  and no CI or test-runner capability — `@endo/exo-shell` (durable `shell`
  formula with baked command policy) and `@endo/sandbox`
  (`spawn`/`mount`/`wait` over bwrap/podman) are the substrate a CI step
  builds on.
  [daemon-git-next-steps](daemon-git-next-steps.md) § Beyond the Loop
  already names "composing `Git` with the chat / endopi edit tools so a
  proposed patch applies to the worktree as a real reviewable change" as
  open, unscheduled work — the closest existing statement of this design's
  motivating use case.
- **Deadlines**: `@endo/reminder` has landed (`packages/reminder`) as the
  [endo-reminder](endo-reminder.md) unconfined plugin: durable reminders on
  a VFS store, `@pins` revival, missed-tick coalescing on recovery, and a
  one-shot `reminderResponse` per delivery.
  (The daemon's own `timer` formula is live-only — tick count and
  subscribers are closure state, `manager.js:4209` — so it is *not* a
  durable deadline source.)
- **UI**: spaces are panes of the Chat app selected by a `mode` string over
  a persisted `SpaceConfig`; the house pattern for a space whose engine
  outlives its view is the Floot split — a pure confined Preact component
  plus a chat-side controller with `getState`/`subscribe` and a module-level
  in-flight registry (`packages/chat/floot-component.js:41`).

## Conceptual Model

Vocabulary, chosen to match statechart literature where it exists and daemon
vocabulary where it exists:

| Term | Meaning |
|---|---|
| **chart** | A workflow definition: a passable, hardened statechart — states, transitions, effects. Pure data; contains no capabilities and no code. |
| **run** | One durable instance of a chart: journal + current configuration + context + granted endowments. |
| **state** | A named node of the chart. May nest a child chart or parallel regions. |
| **configuration** | The set of currently-active states (the SCXML term; plural because of nesting and regions). |
| **context** | The run's extended state: a passable record accumulated by declarative `assign`s (review verdicts, branch names, counters). |
| **event** | A passable record `{ type, ... }` that may cause transitions. Every event enters through the journal. |
| **transition** | `{ when?, target, assign?, effects? }` under an event type on a state; `when` is an `@endo/patterns` guard. |
| **effect** | An engine-performed action declared on a state or transition: `ask` (durable mail to an agent or human), `invoke` (eventual send to an endowment), `spawn` (child run), `after` (timer), `emit` (internal event). |
| **endowment** | A capability granted to the run at start, referenced from the chart *only by name*. |
| **journal** | The run's append-only event-sourced log. The journal **is** the audit log; current state is a fold over it. |
| **port** | A per-role facet handed to a participant, through which their events enter the run with facet-derived attribution. |

Three properties follow from "charts are data":

1. **Auditability** — a transition either pattern-matches or does not; the
   journal records which one fired and why.
2. **Renderability** — a UI can draw the chart as a graph and highlight the
   live configuration without executing anything.
3. **Durability for free** — a chart snapshot and a journal are both
   passable; persisting them needs no code serialization, no closure
   capture, and no deterministic-replay discipline over arbitrary JS.

Code is deliberately *not* the orchestration medium (see Implementation
Options, Option C): where a step needs computation, that computation is an
effect — an `ask` of an agent, or an `invoke` of a confined evaluator —
performed by a capability the run was granted, recorded in the journal like
any other effect.

## Implementation Options

The daemon is an immutable formula store with lazy reincarnation and
reachability GC.
It offers no mutable durable collections
([daemon-persistent-stores](../packages/daemon/designs/daemon-persistent-stores.md)
is Not Started), no orthogonal persistence, and no resumable computation.
Any workflow engine on this substrate therefore has one non-negotiable
shape — durable state that makers re-read, folded forward by small
committed writes — and several possible *packagings*.
The options differ in where the engine lives, where the journal lives, and
how runs wake after a restart.

### Option K — pure machine kernel (library only)

A hardened, side-effect-free statechart interpreter, published as the
`machine` module of `@endo/workflow`:

```js
import { assertChart, initialStep, transition } from '@endo/workflow/machine.js';

// transition is a pure function:
//   (chart, configuration, context, event) ->
//     { configuration, context, effects, fired }
// It performs no I/O, reads no clock, and mints no capabilities.
// `effects` is a list of *descriptions* for the caller to perform.
```

Guards evaluate with `@endo/patterns` `matches`; `assign` and effect
arguments evaluate with a total, non-evaluating template substitution.
The kernel is deterministic: replaying the same journal of events over the
same chart reproduces the same configuration and context, which is what
makes the journal sufficient for recovery *and* audit.

- **Pros:** usable inside *any* caplet (an agent can run a private
  checklist machine with no service at all); trivially testable;
  no daemon coupling; the semantics are settled once, independent of
  packaging.
- **Cons:** not durable by itself — someone must own journals, effects,
  revival, and facets.

Option K is not an alternative to the options below; it is the kernel each
of them would wrap.
Shipping it first fixes the chart semantics before any persistence lands.

### Option A — unconfined service plugin (the reminder shape)

`@endo/workflow` exports the standard unconfined-caplet maker:

```js
export const make = (powers, context, { env } = {}) => { /* WorkflowService */ };
```

provisioned via the existing generic pathway
`E(host).makeUnconfined(workerName, specifier, { powersName, resultName })`
and revived by pinning the service under `@pins`, exactly as
`@endo/reminder` does (its README carries the recipe; `revivePins`,
`manager.js:3960`).
No new formula type, no `formula-type.js` / `manager.js` /
`interfaces.js` changes.

**Journal storage: the mailbox-store pattern over the service's own pet
store.**
The service's powers are a dedicated guest.
Each run is a directory in that guest's namespace:

```
workflow/
  runs/
    r-4f2a…/                 # one directory per run
      chart      → marshal   # the chart snapshot, stored once at start
      0 → marshal            # journal entry 0 (started)
      1 → marshal            # journal entry 1 …
      …
      snapshot   → marshal   # optional latest fold, replaced every K entries
```

Entries are appended with `storeValue(entry, ['workflow','runs',id,String(seq)])`
under a per-run `makeSerialJobs` lock; recovery scans the directory —
byte-for-byte the mailbox/channel rehydration idiom
(`loadMailboxState`, `mail.js:630`; `channel.js:117`).
Journal entries are immutable passables, which is exactly what
`storeValue` stores; because marshal slots are formula ids, an entry that
references a formula-backed capability (a guest handle, a git formula, a
child run) *retains* it in the GC graph — the audit log keeps its own
evidence alive.

- **Pros:** zero daemon changes; follows the maintainer's explicit
  redirect of the reminder from formula type to plugin
  ([endo-reminder](endo-reminder.md) design decisions 2–4); journal
  entries get durability, capability slots, and GC retention from the
  marshal layer for free; the whole engine is upgradable by re-pointing
  the plugin specifier, with in-flight runs unaffected because their
  state is data in stores, not heap.
- **Cons:** revival is pin-everything (`@pins` incarnates the service and
  the service re-reads every non-terminal run at boot) rather than lazy
  per-run; cross-run queries are directory scans, not indexed SQL;
  writes cost one formula row + one pet-store row per journal entry
  (irrelevant at workflow event rates, which are human/agent-paced);
  the service guest cannot mint mounts (host-only verbs), so any
  file-shaped needs are granted by the integration, as with reminder.

A sub-choice inside Option A: journal on a **VFS directory** (the
reminder's store contract — `config.json` + one JSON document per item,
write-then-move) instead of pet-store marshals.
Rejected for the journal itself: VFS documents cannot carry capability
slots, so the audit log would name capabilities by unverifiable strings
and retain nothing; and append-only numbered marshals already have two
in-tree precedents.
VFS remains right for what it is right for in reminder: small mutable
config documents.

### Option B — daemon formula types (`workflow-run` as a first-class citizen)

Follow the checklist that `pet-store`, `mailbox-store`,
`known-peers-store`, and `channel` each followed
([daemon-persistent-stores](../packages/daemon/designs/daemon-persistent-stores.md)
design decision 1): add `workflow` / `workflow-run` to
`formula-type.js`, formula shapes to `types.d.ts`, makers to the
`manager.js` table, dependency extraction to `extractLabeledDeps`
(mandatory, or GC eats the run's stores), `formulateWorkflowRun` minting
subsidiary journal stores the way `formulateChannel` mints its two
(`manager.js:4972`), plus host verbs and guards.
The `channel` formula is the closest existing sibling: a durable exo over
a durable log plus a membership registry.

- **Pros:** runs revive lazily on lookup (no pins; a run nobody references
  costs nothing at boot); retention edges make a run's endowments
  first-class GC dependencies; journal appends could be transactional
  SQLite writes; cross-run queries could be indexed; runs appear in the
  formula inspector ([formula-inspector](formula-inspector.md)) like
  everything else.
- **Cons:** the deepest possible coupling — five-plus files in the
  daemon's core, review-expensive, and squarely against the reminder
  precedent ("this particular feature does not particularly benefit from
  deep integration into the daemon").
  The engine's semantics would also be pinned to daemon release cadence,
  which is wrong for a young vocabulary that will iterate.

### Option C — orchestration as code (replayed imperative workflows)

The Temporal shape: a workflow is a JS function; durability comes from
journaling every awaited effect and deterministically replaying the
function from the top after restart.

Rejected as the substrate.
Deterministic replay over arbitrary JS demands a discipline the platform
cannot check (no `Date.now`, no `Math.random`, no unrecorded await — and
SES lockdown removes some but not all sources of nondeterminism); a
buggy replay silently forks state; the process is opaque to audit and UI
(the "current state" of a suspended function is a stack, not data); and
versioning in-flight runs is notoriously hard.
The daemon's own lesson points the same way: restart is replay of
*formulas*, and the in-tree durable objects are all folds over stores.

The imperative escape hatch survives in data-first form: a chart step
whose effect is `ask`-ing an agent, or `invoke`-ing a confined
`evaluate`, may run arbitrarily rich computation — but it runs as an
*effect*, at a journal boundary, under a capability the run was granted.

### Option D — adopt an existing engine (XState et al.)

Rejected.
XState and kin are neither hardened nor passable, drag a large dependency
into lockdown space, and their machine definitions admit functions
(actions, guards) exactly where this design requires data.
What *is* adopted is the semantics: the chart vocabulary below is a
deliberately small subset of Harel/SCXML statecharts (compound states,
parallel regions, guarded transitions, entry effects), so the model is
familiar and the literature applies.

### Comparison and recommendation

| | K kernel | A plugin | B formula types | C replayed code | D existing engine |
|---|---|---|---|---|---|
| Daemon changes | none | none | 5+ core files | none | none |
| Journal durability | caller's problem | pet-store marshals | SQLite rows | journal + replay | n/a |
| Revival | n/a | `@pins`, eager per service | lazy per run | `@pins` | n/a |
| GC retention of endowments | n/a | via marshal slots | via formula edges | manual | n/a |
| Audit/UI legibility | high (data) | high (data) | high (data) | low (code) | medium |
| Upgrade of engine | trivial | re-point specifier | daemon release | replay-version hell | vendor |
| Precedent | `@endo/patterns` style | reminder | channel | none in-tree | none |
| Effort | S | M | L–XL | L, high risk | M, wrong fit |

**Recommendation: K + A.**
Ship the pure kernel, then the plugin service around it.
Option B is named as the *graduation path*, not a competitor: the journal
entry shape and store layout below are chosen so that a later
`workflow-run` formula type could adopt them mechanically (numbered
entries in a dedicated store are precisely what `mailbox-store` rows
already are).
Graduate only if one of the plugin's real limits bites: boot cost of
pin-revival at large run counts, the need for indexed cross-run queries,
or the need for formula-edge retention semantics.

## Design

### Package shape

As built (the `src/run.js` / `src/effects.js` split this section first
sketched stayed inside `service.js`: the per-run engine closes over run
state and the effect performers share its correlation tables, so the
seam bought nothing; and a `src/types.ts` proved unnecessary — facet
types ride the `interfaces.js` guards and JSDoc):

```
packages/workflow/                  @endo/workflow
  machine.js                        thunk → src/machine.js (pure kernel, Option K)
  src/index.js                      make(powers, context, { env }) plugin entry;
                                    re-exports the public surface
  src/machine.js                    assertChart, chartDiagnostics, initialStep,
                                    transition, exitEffects, engineEventTypes
  src/template.js                   total substitution + delimited interpolation
  src/journal.js                    entry shapes, foldJournal, canonical
                                    encoding + hash chain
  src/service.js                    per-run engines: intake, dispatch, recovery,
                                    factories, facets
  src/interfaces.js                 M.interface guards for every facet
  src/simulate.js                   makeSimulator — kernel + fold, hand-settled
  src/sync.js                       makeRunSyncClient — client-side fold mirror
  src/graph.js                      renderGraph / renderMermaid
  src/topic.js                      lossless change topic (follow, followRuns)
  src/serial-jobs.js                per-run serial queue
```

The kernel modules (`machine.js`, `template.js`, `journal.js`) import
only `@endo/patterns`, `@endo/errors`, `@endo/pass-style`, and the
`@endo/hex` / `@endo/sha256` hash helpers — no daemon types — so they
run identically inside the service worker, inside a test, inside an
agent's compartment, or inside a browser space.

### The chart schema

A chart is hardened passable data.
Illustrative subset (the normative schema is an `@endo/patterns` shape,
`ChartShape`, that `assertChart` enforces — the chart schema is itself a
pattern, checked the same way form fields already are):

```js
const chart = harden({
  name: 'example',
  version: 1,
  // Pattern for the input record supplied at start(); checked with mustMatch.
  params: M.splitRecord({ title: M.string() }),
  // Initial extended state; a passable record.
  context: { attempts: 0 },
  initial: 'draft',
  states: {
    draft: {
      // Effects performed on entering the state (descriptions, not thunks).
      entry: [
        { kind: 'ask', to: 'writer',
          what: { description: 'Draft {$params.title}' },
          outcome: 'drafted' },
      ],
      on: {
        // Event type → ordered transition candidates.
        drafted: [{ target: 'review', assign: { draft: { $event: 'value' } } }],
      },
    },
    review: {
      entry: [
        { kind: 'ask', to: 'reviewer', form: {
            description: 'Approve {$params.title}?',
            fields: [{ name: 'approved', label: 'Approve?', pattern: M.boolean() }],
          },
          outcome: 'reviewed' },
        { kind: 'after', ms: 86_400_000, emit: { type: 'review-timed-out' } },
      ],
      on: {
        reviewed: [
          { when: M.splitRecord({ value: M.splitRecord({ approved: M.eq(true) }) }),
            target: 'done' },
          { target: 'draft', assign: { attempts: { $inc: 1 } } },
        ],
        'review-timed-out': [{ target: 'draft' }],
      },
    },
    done: { final: true, output: { draft: { $ctx: 'draft' } } },
  },
});
```

Schema vocabulary, exhaustively:

- **State**: `{ entry?, exit?, on?, states?/initial?, regions?, join?,
  final?, output?, meta? }`.
  `states` + `initial` nests a child chart (compound state); `regions`
  holds child charts active in parallel — either a literal array, or the
  data-driven expansion form
  `{ $eachParam: <params path>, chart: <chartId> }`, which instantiates
  one region per element of a params array at start.
- **Join events**: a parallel state with `join: 'counts'` receives an
  engine-emitted `regions-settled` event each time one of its regions
  reaches a terminal state, carrying the current `counts` envelope plus
  `outcomes`, the `output` records of the regions settled so far; its
  `on` transitions decide early exit (first failure), quorum, or
  wait-for-all.
  Exiting the parallel state cancels the still-pending regions' effects;
  a late answer to an already-exited ask is journaled as an `event` that
  fires nothing.
- **Transition**: `{ when?, target?, assign?, effects? }`.
  `when` is a Pattern matched against the *event envelope*
  `{ type, value, by, at }` (see journal, below).
  Candidates are tried in order; the first match fires.
  A transition without `target` is an internal transition (assign/effects
  only).
- **Guard subject**: patterns cannot compute, so the engine matches them
  against an envelope it has already enriched: for join decisions on a
  parallel state the envelope includes `counts`, a record of terminal
  outcomes per region (e.g. `{ approved: 2, changesRequested: 1, pending: 0 }`),
  so "2-of-3 quorum" is `M.splitRecord({ counts: M.splitRecord({ approved: M.gte(2) }) })`
  — totality preserved, arithmetic stays in the engine.
- **Effect kinds** (closed set; see Effects below): `ask`, `invoke`,
  `spawn`, `after`, `emit`.
- **Templates**: every value position inside `assign`, effect arguments,
  and `output` admits the total substitution forms `{ $params: path }`,
  `{ $ctx: path }`, `{ $event: path }`, `{ $inc: n }` and literal
  passables; inside string literals, `{$params.x}` / `{$ctx.x}` /
  `{$event.x}` interpolate a rendered value (for human-readable ask
  descriptions).
  Substitution and interpolation are structural and non-evaluating — the
  same discipline the persistent-stores design demands of key DSLs
  ("deterministic halting is a hard requirement").
  Anything beyond substitution is not the chart's job; it is an effect's.

`transition` implements the SCXML-subset step: select candidates on the
innermost active states first, fire at most one transition per orthogonal
region per event, compute exited/entered sets, and return the new
configuration plus the entry/exit effect descriptions.
Determinism rule: candidate order is source order; there is no implicit
priority beyond depth.

### The journal

Each run's journal is the numbered-marshal log described under Option A.
Entry shapes (all passable records; `JournalEntryShape` guards them):

| kind | payload | written when |
|---|---|---|
| `started` | `chartId`, `params`, `endowmentNames`, `by` | run creation |
| `event` | `event: { type, value }`, `by`, `cause?` | any event enters the run |
| `fired` | `transition` path, `exited`, `entered`, `assign` result | the reducer applied an event |
| `effect-dispatched` | `effectId`, description (capability *names*, not refs), correlation (`messageId`/`responseName` for `ask`) | after the effect's first send settles |
| `effect-settled` | `effectId`, `outcome: fulfilled/failed`, value/reason | settlement observed (first one wins) |
| `spawned` / `child-settled` | `childRunId`, outcome | sub-workflow lifecycle |
| `paused` / `resumed` / `cancelled` | `by`, reason | control facet actions |
| `completed` / `failed` | `output` / reason | a terminal state is entered |
| `snapshot` | full `{ configuration, context, pendingEffects }` | every K entries (K≈64) |

Envelope common to all entries:

```js
{ seq,                    // bigint, dense, per-run
  at,                     // ISO date, engine clock
  by,                     // attribution: formula id of the acting agent/port,
                          //   or 'engine', or 'control'
  kind, ...payload }
```

**Attribution is structural.**
`by` is derived from *which facet or correlated message* produced the
entry — a port is minted per (run, role), a mail reply carries the
sender's handle id — never from a field the payload claims.
This is requirement 3's teeth.

**The journal is the state.**
`foldJournal(chart, entries)` reproduces `{ configuration, context,
pendingEffects, done, output }`; `snapshot` entries only shorten the
replay.
Because entries are marshal formulas, an entry may carry slots (the chart
snapshot, a child run reference); the GC graph then retains what the
audit trail cites.
Facet-only remotables (ports, live iterators) are *never* stored — the
journal records identifiers and names, which is also the right privacy
posture for an audit log.

**Ordering discipline (journal before world):**
an event is journaled before its transition's effects are performed, and
an effect is performed before its `effect-dispatched` correlation is
journaled *only* where the send itself mints the correlation (mail
returns message ids); recovery treats "journaled `fired` but no
`effect-dispatched`" as "dispatch again".
This mirrors the daemon's own disk-before-graph rule: the durable record
always leads the mutable world, so a crash between the two is resolved by
redoing, never by forgetting.

### Facets

Caretaker splits, per the reminder precedent; every facet is an exo with
an `M.interface` guard and a `help()`.

```js
// The service (one per provisioned plugin; pinned in @pins).
WorkflowService: {
  install(chart, petName)            → chartId          // validate + storeValue
  charts()                           → [{ name, version, chartId }]
  start(chartRef, { params, endowments, petName? }) → { run, control }
  run(runId)                         → WorkflowRun       // re-derivable
  control(runId)                     → WorkflowControl   // service-holder authority
  list(filter?)                      → [RunSummary]
  followRuns()                       → Reader<RunSummary> // latest-topic per run
  help()
}

// Observation — freely shareable.
WorkflowRun: {
  status()                           → RunStatus          // passable snapshot
  follow({ since }?)                 → Reader<JournalEntry> // replay from seq, then live
  journal({ from, to }?)             → [JournalEntry]
  chart()                            → Chart              // the immutable snapshot
  port(role)                         → WorkflowPort       // re-derivable participant facet
  help()
}

// Control — held by whoever started the run (and the service holder).
WorkflowControl: {
  signal(event)                      → seq                // no static engine types; strips routing marks
  pause() / resume()                 → void
  cancel(reason?)                    → void               // chart reconciliation or terminal cancel
  help()
}

// Participant port — one per (run, role); the only write path for outsiders.
WorkflowPort: {
  submit(event)                      → seq
  help()
}
```

- `start` checks `params` against the chart's `params` pattern with
  `mustMatch`, snapshots the chart into the run directory, journals
  `started`, and returns.
  `endowments` is a record of `name → capability` (or pet-name paths the
  service resolves through its powers); the chart references endowments
  only by these names.
- `port(role)` mints (or re-derives) an exo whose `submit` guard is the
  *chart-declared* event pattern for that role, so a reviewer's port
  cannot inject `ci-passed`.
  Ports are not durable objects; they are deterministically re-derivable
  from (runId, role) after a restart, and holders re-fetch them by name —
  the same "fresh dismissers per incarnation" posture the mailbox already
  has.
- `RunStatus` is
  `{ runId, chartName, version, configuration, contextSummary, seq,
  startedAt, updatedAt, done, outcome?, pending: [{ effectId, kind,
  since, correlation? }], prompts: [{ role, description, since }] }` —
  everything a dashboard needs in one passable read.
- `follow({ since })` improves on the house re-follow-and-dedupe idiom
  with a real cursor for free: the journal is densely numbered, so replay
  from `since` then tail the run's `makeChangeTopic`.
  For run *summaries* the service uses a conflating latest-topic per run
  (`packages/pubsub` `makeLatestTopic`), because dashboards want current
  state, not every delta.

### Effects

Effects are the entire boundary between the machine and the world, and
each kind states its delivery contract:

**`ask` — durable, exactly-once, mail-backed.**
`{ kind: 'ask', to: <endowment name of an agent handle>, what | form,
outcome: <event type> }`.
The service's guest powers send a `request` (free-text `what`) or a
`form` (structured fields, validated by the daemon with `mustMatch` on
submit) to the target agent.
Durability is inherited, not built: the message is a durable formula in
both mailboxes; a request's resolution is a write-once durable
promise/resolver pair; `responseName`
(`workflow/answers/<runId>/<effectId>`) makes the answer idempotently
re-readable (`mail.js:1059`), and `@mail/<n>/@result` names it forever.
On settlement the engine journals `effect-settled` and emits the
`outcome` event carrying the value and the responder's identity as `by`.
Humans see asks in their existing inbox/Chat UI with zero new surface —
forms already render as inline widgets with typed inputs
([daemon-form-request](daemon-form-request.md)).
Agents see asks as mail, which lal-style inbox-loop agents already answer
(`packages/lal/inbox-loop.js:36`).

**`invoke` — direct eventual send, at-least-once.**
`{ kind: 'invoke', target: <endowment name>, method, args, outcome,
failure? }`.
`E(endowments[target])[method](...args)` with the settled result (passed
through marshal, so it must be passable) journaled and emitted.
Restart contract: an `invoke` journaled `effect-dispatched` but not
`effect-settled` is re-sent on recovery with the same `effectId`.
The chart author's obligation, stated plainly: an `invoke` target must be
idempotent, or re-derivable (a pure read), or wrapped in an adapter that
dedupes on the run-qualified key `${runId}:${effectId}` (which is passed
as the final argument for exactly this purpose; bare effect ids are
`${seq}-${index}` and repeat across runs sharing an endowment, so the
wire key carries the run id, as the ask marker already does).
Where idempotence cannot be promised, use `ask` — mail's exactly-once is
the reason it exists.

**`spawn` — child run.**
`{ kind: 'spawn', chart: <chartId | inline>, params, endowments?
(subset by name), outcome }`.
The child is a full run with its own journal; the parent journals
`spawned`, the child's terminal entry flows back as the parent's
`outcome` event (`child-settled`).
Endowment subsetting is by name selection only — a parent can grant a
child at most what it holds, the reminder delegation rule.

**`after` — deadline.**
`{ kind: 'after', ms | at, emit }`.
Journaled with its *absolute* deadline; the run arms an in-process timer,
and on recovery re-arms from the journaled deadline, coalescing past-due
deadlines into immediate events (the reminder's `nextTickAt` recovery
shape, `packages/reminder/src/store.js`).
When the integration grants a `reminder` endowment, the service instead
schedules through `@endo/reminder` so deadlines also survive the service
being unpinned; either way the journal is the source of truth and a
duplicate firing dedupes on `effectId`.

**`emit` — internal event**, for chaining and fan-in;
no world contact, exactly-once trivially.

**Cancellation and compensation.**
`cancel` first journals and steps the reserved `cancel-requested` engine event.
If the chart handles it, the run stays live: cleanup invokes, deadlines, and
human attention are ordinary recoverable state transitions rather than a
fire-and-forget epilogue.
The service propagates a handled request to linked children and waits until each
child has journaled it before returning, while retaining the spawn links that
carry their eventual truthful terminals back to the parent.
If the run was paused, cancellation first resumes it and journals every queued
event as discarded rather than replaying those stale envelopes before or after
reconciliation.
This is the required policy for workflows whose effects can leave outside
state ambiguous.

If the active chart does not handle `cancel-requested`, `cancel` journals
`cancelled`, sends the active states' `exit` effects (bounded: exit effects may
not `ask` — compensation must not block on humans), settles the run terminal,
and cancels child runs.
This compatibility path is suitable only when immediate abandonment and
fire-and-forget compensation are safe.
Where the integration granted a context, the run's worker teardown follows the
daemon's normal cancellation cascade (`context.cancel`, `src/context.js:49`).
The journal survives; a cancelled run remains queryable like any other
terminal run (retention policy is a named gap, below).

### Recovery, precisely

On `make()` (service incarnation, e.g. after daemon restart via `@pins`):

1. Scan `workflow/runs/`; for each run directory, read `snapshot` if
   present, then fold the numbered tail.
2. Runs whose fold is terminal: nothing to do (they serve status reads).
3. For each live run, rebuild `pendingEffects` and re-arm:
   - `ask`: if the journal has a correlation, look for the answer first —
     `responseName` lookup, else scan `listMessages()` for a reply to the
     journaled `messageId` — and settle immediately if found; otherwise
     subscribe (`followMessages`) and wait.
     If no correlation was journaled (crash between send and journal),
     re-send: the previous message, if it exists, is answered into a
     `responseName` the engine still owns, and the settle path dedupes.
   - `invoke`: re-dispatch with the same `effectId`.
   - `after`: re-arm from the journaled absolute deadline; past-due fires
     now.
   - `spawn`: children recover independently (they are runs in the same
     scan); re-link parent waiters.
4. Re-mint topics; new followers replay-from-`since` as always.

Recovery is idempotent and crash-tolerant at every arrow because each
step is either a pure read, a dedupe-guarded send, or an append that
records what just happened.

### Trust model

- The engine is generic and holds only its own guest powers; **a run's
  authority is the endowment record**, granted by the starter at `start`
  and named — never reached — by the chart.
  Starting a workflow is thus itself an act of capability composition: the
  operator decides that *this* run may hold *this* writable git, *that*
  reviewer's handle, one shell with a baked test command.
- Ports narrow inbound authority: role-scoped, pattern-guarded,
  identity-attributing.
  Mail-based asks inherit the daemon's existing sender-verification
  ("mail fraud" checks, `mail.js:1111`).
- Endowment capabilities should themselves be pre-attenuated with the
  substrate's own levers: `provideGit(..., { readOnly: true })` for
  reviewers (facets returned by `readOnly()` are not separately durable,
  so reviewers get their own read-only formula), `GitRemote` branch
  policy for submission namespaces, `shell` formulas with fixed argv
  allowlists for CI.
- The journal is the audit log; it records ids and names, not secrets,
  and its entries are immutable marshals.
  Tamper-evidence beyond SQLite's trust domain (hash-chaining entries,
  cross-signing between daemons) is deliberately deferred to the
  multi-daemon phase.

### The UI space

`@endo/space-workflow`, following the Floot split exactly (pure confined
Preact component + a chat-side controller with `getState`/`subscribe`,
module-level stream registry so runs keep streaming while the space is
closed):

- **Run list**: `list()` + `followRuns()`; per-run status chips derived
  from `RunStatus` (live states, pending asks, age).
- **Chart view**: charts are data, so the space renders the statechart as
  a graph (states as nodes, transitions as edges) and *highlights the
  live configuration* — no execution, no interpretation, just the same
  passable the engine runs.
- **Journal view**: the audit log as a timeline; entries carrying `by`
  render attributed avatars; `effect-*` pairs fold into single cards with
  the pending-commands idiom (`spaces-util` `pending-commands.js` is the
  existing spinner→check/error card list to reuse).
- **Action rail**: pending prompts surface as the forms they already are;
  approve/deny happens through the existing inbox `submit` machinery, so
  the workflow space and the chat inbox are two views of the same durable
  mail.
- Registration follows the documented closed-set edits (`KNOWN_MODES`,
  `SpaceConfig.mode`, `bodyComponent` dispatch, add-space card).

CLI surface (thin, later phase): `endo workflow start|list|status|follow|signal|cancel`,
each a direct verb over the facets above; `endo inbox` already covers the
approval half.

## The Motivating Use Case, End to End

A concrete chart for the feature loop, exercising every mechanism above.
(Abridged: guards and templates shown where they carry the design.)

```js
const featureChange = harden({
  name: 'feature-change',
  version: 1,
  params: M.splitRecord({
    title: M.string(),
    spec: M.string(),          // the feature request
    branch: M.string(),        // e.g. 'agent/feature-x'
    reviewers: M.arrayOf(M.string()),  // endowment names of reviewer handles
  }),
  context: { round: 0, feedback: [] },
  initial: 'implement',
  states: {
    implement: {
      entry: [{
        kind: 'ask', to: 'implementer',
        what: { description:
          'Implement {$params.title} on branch {$params.branch}. Spec: {$params.spec}. Prior feedback: {$ctx.feedback}' },
        outcome: 'submitted',
      }],
      on: { submitted: [{ target: 'review',
                          assign: { headRef: { $event: 'value' } } }] },
    },
    review: {
      // One region per reviewer is instantiated from params at start;
      // each region asks its reviewer and ends in a terminal verdict state.
      regions: { $eachParam: 'reviewers', chart: 'reviewer-verdict' },
      join: 'counts',
      on: {
        'regions-settled': [
          { when: M.splitRecord({ counts: M.splitRecord({
              changesRequested: M.gte(1) }) }),
            target: 'implement',
            assign: { round: { $inc: 1 },
                      feedback: { $event: 'outcomes' } } },
          { when: M.splitRecord({ counts: M.splitRecord({
              approved: M.gte(2), pending: M.eq(0) }) }),
            target: 'ci' },
        ],
      },
    },
    ci: {
      entry: [{
        kind: 'invoke', target: 'ci', method: 'check',
        args: [{ $ctx: 'headRef' }],
        outcome: 'ci-result',
      },
      { kind: 'after', ms: 3_600_000, emit: { type: 'ci-timed-out' } }],
      on: {
        'ci-result': [
          { when: M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) }),
            target: 'await-approval' },
          { target: 'implement',
            assign: { round: { $inc: 1 },
                      feedback: { $event: 'value' } } },
        ],
        'ci-timed-out': [{ target: 'needs-attention' }],
      },
    },
    'await-approval': {
      entry: [{
        kind: 'ask', to: 'operator',
        form: {
          description: 'Merge {$params.title} ({$ctx.headRef}) after {$ctx.round} rounds?',
          fields: [
            { name: 'approved', label: 'Merge this change?', pattern: M.boolean() },
            { name: 'note', label: 'Note', pattern: M.string(), default: '' },
          ],
        },
        outcome: 'operator-decided',
      }],
      on: {
        'operator-decided': [
          { when: M.splitRecord({ value: M.splitRecord({ approved: M.eq(true) }) }),
            target: 'merge' },
          { target: 'abandoned' },
        ],
      },
    },
    merge: {
      entry: [{
        kind: 'invoke', target: 'merger', method: 'land',
        args: [{ $ctx: 'headRef' }],
        outcome: 'landed', failure: 'land-failed',
      }],
      on: {
        landed: [{ target: 'done' }],
        'land-failed': [{ target: 'needs-attention' }],
      },
    },
    'needs-attention': {
      entry: [{ kind: 'ask', to: 'operator',
        what: { description: 'Run {$params.title} needs attention.' },
        outcome: 'operator-resumed' }],
      on: { 'operator-resumed': [{ target: 'implement' }] },
    },
    done:      { final: true, output: { headRef: { $ctx: 'headRef' } } },
    abandoned: { final: true },
  },
});
```

(The `$eachParam` region template — instantiate one region per element of
a params array — is the one piece of chart vocabulary invented *for* this
use case; everything else is the generic core.
`reviewer-verdict` is an installed child chart: ask the reviewer with a
verdict form, terminal states `approved` / `changesRequested` carrying
the feedback in their `output`.)

### The endowment table

Capability flow at `start`, all pre-attenuated by the operator's host
before the run ever sees them:

| Endowment name | Capability | Attenuation |
|---|---|---|
| `implementer` | handle of an agentry code-mode session guest (`provisionEndoCodeMode` with the workspace + writable `Git` bound in; or a floot session; or lal) | the *agent's* powers hold the writable git, scoped by `GitRemote` policy to `refs/heads/agent/*`; the run holds only the agent's handle |
| `reviewers[i]` | handles of reviewer agents or human agents (guests/hosts) | reviewers additionally receive, inside the ask payload, pet names for a **read-only** `Git` formula (`provideGit(mount, n, { readOnly: true })`) and the diff text — they can read `filesystemAt(headRef)`, never write |
| `ci` | a small CI caplet: `check(ref)` → clone-or-snapshot the ref (via `provideGitClone` / `tree(ref)` materialization), run the baked test argv in an `exo-shell` / `@endo/sandbox`, return `{ ok, log }` | shell formula has a fixed command allowlist; sandbox mounts only the materialized tree; `check` is idempotent by construction (fresh materialization per call), which is what licenses `invoke` |
| `operator` | the operator's own host handle | asks arrive as ordinary inbox forms |
| `merger` | a merge caplet holding the elevated writer `Git` (and `GitRemote` if landing means pushing) | `land(ref)` is `merge(ref, { fastForwardOnly })` + push; conflicts throw → `land-failed` → `needs-attention`; dedupes on the run-qualified `${runId}:${effectId}` key since a re-sent merge of an already-merged ref is a fast-forward no-op |

The run itself holds *no* git capability — it holds performers who do.
An auditor reading the journal sees: who was asked, what they answered,
which ref moved, who approved, when the merge landed.

### A restart in the middle

Daemon dies while CI runs and reviewer two has not answered.

1. Boot: `revivePins()` incarnates the workflow service; `make()` scans
   `workflow/runs/` and folds the journal to configuration `{ ci }` (the
   review round already passed), with two pending effects: the `ci`
   invoke (dispatched, unsettled) and its `after` deadline.
2. The `ask` answers that arrived while the daemon was down are not lost
   — they are durable mail.
   (Had we crashed during `review`: recovery finds reviewer one's verdict
   at its `responseName`, settles that region immediately, and keeps
   waiting on reviewer two's still-answerable form.)
3. The `ci` invoke re-dispatches with the same `effectId`; the CI caplet
   materializes the ref again and runs the suite — at-least-once, safe by
   construction.
   The `after` deadline re-arms from its journaled absolute time.
4. `follow` subscribers re-follow (subscriptions are ephemeral by
   design), passing `since` = the last `seq` they saw, and observe no
   gap.

No operator intervention, no lost approvals, no duplicate merge.

## Dependencies

| Design / package | Relationship |
|---|---|
| [daemon-form-request](daemon-form-request.md), [daemon-value-message](daemon-value-message.md) | **Complete.** The `ask` effect's human half: durable forms, validated submits, value replies. |
| daemon mail (`request`/`resolve`, durable promise/resolver, `responseName`, `@mail/n/@result`) | Landed. The `ask` effect's durability; no new persistence built for answers. |
| [endo-reminder](endo-reminder.md) (`packages/reminder`) | Landed. Optional upgraded backing for `after` deadlines; also the packaging precedent (plugin, VFS store contract, `@pins` revival, caretaker facets) this design follows. |
| [platform-fs](platform-fs.md), [fs-interface-reconciliation](fs-interface-reconciliation.md) | The VFS store contract, if an integration prefers file-backed journals (non-default). |
| [daemon-git-capability](daemon-git-capability.md), [daemon-git-remotes](daemon-git-remotes.md), [daemon-git-next-steps](daemon-git-next-steps.md) | The motivating use case's workspace, review-view, submission-policy, and merge capabilities. Phase 7 structured results would improve `ci`/`merge` failure routing but are not blockers (porcelain text suffices). |
| [agentry-agent-builder](agentry-agent-builder.md), [endo-agent-tools](endo-agent-tools.md) | Implementer/reviewer agents; `provisionEndoCodeMode`'s durable session record is the recommended implementer endowment. |
| [notifier-pubsub-migration](notifier-pubsub-migration.md) (`packages/pubsub`) | `makeChangeTopic` / `makeLatestTopic` for `follow` / `followRuns`. The workflow service would be the package's first daemon-adjacent consumer. |
| [daemon-persistent-stores](../packages/daemon/designs/daemon-persistent-stores.md) | Not Started. Not required — the journal is append-only marshals — but a landed `collection-store` would simplify the service's run index and is the natural store for high-cardinality derived indices later. |
| [daemon-commands-as-messages](daemon-commands-as-messages.md) | Sibling audit concern at the single-command grain; complementary, no dependency either way. |
| [formula-inspector](formula-inspector.md) | Journal entries and run stores are ordinary formulas/stores, so they inspect for free; a `workflow` formula-view spec is a nice-to-have. |
| `@endo/jsonl-transcript` | Considered for the journal and not used (see Design Decisions); remains the right shape for *agent transcript* export, which an `ask`'s performer may attach as evidence. |
| Chat spaces (`packages/chat`, `spaces-util`, `space-*`) | Host of `@endo/space-workflow`; pending-commands and error-trace utilities reused. |

## Phased Implementation

**Phase 1 — kernel (M).**
`@endo/workflow` `machine.js` + `template.js` + `journal.js`: chart
schema and `assertChart`, the SCXML-subset `transition`, total template
substitution, `foldJournal`, and a property-style test suite (replay
determinism: fold(entries) is invariant under snapshot insertion and
process restarts).
No daemon involvement; runs under plain AVA.

**Phase 2 — service plugin (M–L).**
`make(powers, context, { env })`, run directories over the powers guest's
pet store (numbered marshal journal, serial append, snapshot every K),
`start`/`status`/`journal`/`list`, `invoke` + `emit` + `after`
(in-process re-armed timers) effects, recovery, `@pins` recipe in the
README, restart tests against a forked daemon (serial, per daemon test
conventions).

**Phase 3 — mail integration (M).**
The `ask` effect over `request`/`form` with `responseName` correlation
and recovery-time answer adoption; ports with chart-declared guards;
attribution threading; the `needs-attention` engine default for unrouted
failures.
End-to-end test: a form-gated two-state chart survives restart between
send and submit.

**Phase 4 — composition (M).**
Nested states, parallel regions with `counts` join envelopes, `spawn` /
`child-settled`, endowment subsetting, `$eachParam` regions.
Test: the 2-of-3 reviewer quorum chart, including a restart mid-quorum.

**Phase 5 — status feeds and UI space (M–L).**
`follow({ since })`, `followRuns()` over `packages/pubsub` topics;
`@endo/space-workflow` (run list, chart graph with live highlight,
journal timeline, prompt rail) plus the closed-set chat registrations;
CLI verbs.

**Phase 6 — the worked reference flow (M).**
The `feature-change` chart end to end against real substrate: an agentry
code-mode implementer on a scratch git workspace, two scripted reviewer
agents plus one human form, a sandboxed CI caplet, a merge caplet, and a
kill-the-daemon-mid-CI restart — the acceptance test that closes this
design, in the spirit of the git stack's worked-loop test
(`packages/agent-tools/test/git-worked-loop.test.js`).

**Deferred (named, not scheduled):** reminder-backed deadlines as the
default; run migration between chart versions; hash-chained/multi-party
journals; cross-daemon runs (participants over OCapN are already fine —
handles are location-transparent — but the *engine* stays single-daemon);
graduation to a `workflow-run` formula type per Option B; a
`policyAuthority` bridge so mount `tofu-prompt` can be realized as a
one-state workflow.

## Design Decisions

1. **Charts are data; code is an effect.**
   Durability, audit, UI rendering, and guard totality all fall out of
   the machine being passable data interpreted by a small engine.
   Considered and rejected: replayed imperative workflows (Option C) —
   unverifiable determinism discipline, opaque state; and embedding an
   existing engine (Option D) — not hardened, not passable, functions in
   the definition.
2. **Kernel first, plugin second, formula type only if earned.**
   Mirrors the reminder redirect; keeps engine iteration off the
   daemon's release cadence; preserves a mechanical graduation path
   (numbered-entry journal ≙ mailbox-store rows).
3. **The journal is both the durability substrate and the audit log.**
   One artifact, two requirements; event-sourced fold, snapshot entries
   as pure optimization.
   The alternative — mutable status document plus separate log — invites
   divergence between what happened and what is claimed.
4. **Journal entries are pet-store marshals, not VFS JSON files.**
   Marshal entries carry capability slots (GC retention of cited
   evidence), reuse two in-tree log precedents, and inherit SQLite
   atomicity; VFS files would need their own atomicity contract and can
   only name capabilities as dead strings.
   `@endo/jsonl-transcript` was considered and passed over for the same
   reason (plus its Node-fs coupling), though it remains the export
   format of choice for attached agent transcripts.
5. **Mail is the durable effect channel; direct sends are the fast one.**
   `ask` inherits exactly-once from the daemon's message/promise
   formulas instead of rebuilding persistence; `invoke` is honest about
   at-least-once and hands targets a run-qualified
   `${runId}:${effectId}` key to dedupe on.
   The alternative — building a bespoke durable RPC layer — duplicates
   the mailbox.
6. **Guards are patterns over engine-enriched envelopes.**
   Patterns are total (no user code in the hot path, nothing to meter);
   the engine supplies computed facts (`counts`) rather than letting
   guards compute.
   Rejected: predicate functions in charts (reintroduces code-in-data)
   and a bespoke expression language (a worse `@endo/patterns`).
7. **Ports are re-derivable, not durable.**
   Facet-only remotables die with the process by platform rule; making
   each port a formula would bloat the graph for objects that are pure
   attenuations of (runId, role).
   Holders re-fetch by name after restart — the mailbox's own dismisser
   posture.
8. **Attribution from structure, never from payload.**
   `by` comes from the port's role binding or the mail sender's verified
   handle (the daemon's existing mail-fraud checks), so the audit log's
   who-column is evidence, not testimony.
9. **Exit effects may not `ask`.**
   Compensation that blocks on a human is a state, not a hook; keeping
   exits bounded keeps `cancel` prompt, which is the daemon's own
   graceful-teardown tension resolved the same direction.
10. **Endowments are named grants at start; charts never look anything
    up.**
    The chart stays powerless and shareable; a run's blast radius is
    legible in one table at `start`; parents subset by name for
    children.
    Rejected: charts carrying pet-name paths resolved at run time —
    turns a data artifact into an ambient-authority probe.
11. **One service, many runs (v1); per-run guests deferred.**
    Per-run mailboxes would give each run its own address and inbox
    rendering, at the cost of a guest chain per run; correlation ids
    within one service mailbox are sufficient until traffic proves
    otherwise.
12. **Timers re-arm from journaled absolute deadlines; reminder is an
    upgrade, not a dependency.**
    The engine must be correct with nothing granted; with `reminder`
    granted it gains firing while unpinned.
    The daemon's `timer` formula is live-only and was rejected as a
    backing.

## Known Gaps and TODOs

- [x] Normative chart validation and the exact template grammar —
      resolved in Phase 1: `assertChart` (structural walk with
      `assertPattern` on guards) is the normative check, and
      `src/template.js` fixes the grammar (`$params`/`$ctx`/`$event`
      dotted paths, `$inc`, delimited interpolation).
- [x] `counts` envelope shape for nested joins — resolved in Phase 4:
      `regions-settled` carries `counts` keyed by top-level final-state
      name (zero-populated, `pending` reserved for the unsettled count,
      and region final states of that name rejected) plus per-region
      `outcomes` in region order; a compound region contributes the
      final state it settled in.
- [ ] Service mailbox hygiene: asks fan out from one guest mailbox;
      define dismissal policy for settled correspondence so the inbox
      does not grow without bound.
- [ ] `RunSummary` index: directory scan at boot is O(runs); measure and,
      if it bites, add a `runs-index` snapshot document (or adopt
      `collection-store` when it lands).
- [ ] The `$eachParam` region template is the only data-driven chart
      expansion; validate it against a second use case (matrix CI) before
      freezing.
- [ ] Interaction with GC: journals retain what they cite; define the
      retention story for *terminal* runs (archive verb? age-based
      operator sweep?) so evidence retention is a policy, not an
      accident.
- [ ] Worked adapter: `makeAgentPerformer(agentMaker)` wrapping an
      agentry maker's `prompt`/`waitForIdle` behind the ask/mail
      convention, so agentry agents answer asks without bespoke glue.

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
