# `@endo/workflow`

Durable, composable statechart workflow engine for the Endo daemon.
Design: [`designs/endo-workflow.md`](../../designs/endo-workflow.md).

The package layers a durable **engine** over a pure, host-agnostic
**interpreter core**.
The core knows nothing about the daemon — no mail, no formulas, no
timers — and everything in it runs under plain SES lockdown; the engine
takes its authority through an injected powers seam, so the daemon
plugin and the tests drive the same code.

## The engine (`src/engine.js`)

`makeWorkflowEngine({ storeRoot, deliver, now, makeId, makeTimer?,
rebindParticipants?, warn? })` provides:

- **Definition and fragment registries** — content-addressed, persisted,
  fragments inlined at `define()` time (`src/fragment.js`).
- **Durable runs** — hash-chained journals under `runs/<runId>/`,
  restart recovery that re-folds journals, re-issues pending
  `request`/`form`/fanout deliveries under their original idempotency
  keys, routes interrupted non-idempotent `call`s to `onError` as
  `indeterminate`, re-arms `after` timers from journaled entry times,
  and journals `recovery.completed`.
- **The observer/controller/admin run kit** — cumulative exo facets with
  `M.interface` guards (`src/interfaces.js`): observers are read-only
  and see capability references only as `ref:n` aliases (the alias
  table is engine-private); `signal` needs the controller; overrides
  (`pause`/`resume`/`abort`/`retryEffect`/`forceTransition`/
  `injectEvent`/`resolveRef`) need the admin and journal their actor.
- **Effects** — `request`, `form`, `call` (with retry), `fanout` with
  per-member results and `all`/`any`/quorum joins, `spawn` child runs
  with input/output mapping and downward-only abort cascade, `emit`.
- **Factories** — `makeFactory({ definition, participants, input,
  limits })`: the attenuation unit for granting starts without the
  underlying capabilities; non-escalating `with()` derivation;
  revocation cascades down the derivation tree.
- **Syncing** — `status()` carries `throughSeq`; `history(fromSeq)` is a
  gapless subscribe-first splice of journal replay and the live topic;
  `makeWorkflowSyncClient` (`src/sync.js`) folds it client-side and
  resumes from `lastSeq + 1` on reconnect.
- **Rendering** — `renderDefinition` (the graph model the
  `@endo/space-workflow` Chat space lays out) and `renderMermaid`
  (`stateDiagram-v2` for review in markdown).

`src/plugin.js` is the unconfined daemon entry in the `@endo/reminder`
mold (`make(powers)` resolving `workflow-store` by name, pinned via
`@pins`).

## The interpreter core

- `validateDefinition(definition)` — structured diagnostics
  (`{ severity, path, message }`), not a bare verdict: dangling targets,
  unreachable states, undeclared participants, unmatched `as`
  correlations, expression budget and parse failures, and availability
  warnings (an `all` join with no timeout).
- `compileExpression` / `evaluateExpression` — guard and reducer
  expressions evaluated in a fresh powerless `Compartment` under a
  define-time syntactic budget (length cap; no loops, functions, or
  dynamic evaluation).
  SES on Node cannot meter evaluation; the budget is defense in depth and
  the trust model (definitions come only from the host) is the primary
  control.
- `applyEvent` / `foldRecords` — the pure journal fold.
  The journal records decisions (`transition.fired` carries the resulting
  context), so folding never re-evaluates expressions and never issues
  effects; the module is authority-free and browser-importable.
- `makeInterpreter(definition)` — the decision layer: one external event
  plus the current run state in, the journal events to append out
  (settlement-correlation provenance included: unmatched settlements
  become `event.unauthorized`).
- `simulateRun(definition, { input, participants })` — the daemon-free
  unit-test surface: the engine's own reducer under scripted events with
  recorded effects; `priorRecords` replays a journal prefix
  (fork-to-sandbox).
- `provideRunJournal(directory, { runId, now })` — the durable journal
  over `@endo/platform/fs/extended` verbs: one hash-chained record per
  write-then-move segment, snapshot support, tamper detection on load
  (`findChainBreak`).

Later phases (daemon plugin, factories, sync surface, the
`space-workflow` Chat space) build on these seams; see the design's
Phased Implementation.

## Example

```js
import { simulateRun } from '@endo/workflow';
import { featureChange } from '@endo/workflow/test/fixtures/feature-change.js';

const sim = simulateRun(featureChange, {
  input: { request: 'add dark mode', branch: 'feat/dark-mode' },
  participants: { implementer: 'lal', reviewers: ['sec'], ci: 'ci', approver: 'me', repo: 'git' },
});
sim.expectEffect('request', { to: 'implementer' });
sim.inject('effect.settled', { as: 'implementation', ref: 'ref:1' });
sim.state; // 'reviewing'
```
