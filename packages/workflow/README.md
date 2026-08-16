# `@endo/workflow`

Durable, composable statechart workflow engine core for the Endo daemon.
Design: [`designs/endo-workflow.md`](../../designs/endo-workflow.md).

This package is **Phase 1** of the design: the host-agnostic interpreter
core.
It knows nothing about the daemon — no mail, no formulas, no timers — and
everything in it runs under plain SES lockdown.

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
