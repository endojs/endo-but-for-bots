// @ts-check

/**
 * `@endo/workflow` — durable, composable statechart workflow engine
 * core (Phase 1: host-agnostic interpreter, simulator, and journal).
 *
 * See `designs/endo-workflow.md`.
 */

export {
  validateDefinition,
  assertValidDefinition,
  renderDiagnostics,
  FINAL_OUTCOMES,
  EFFECT_KINDS,
} from './definition.js';
export {
  expressionBudgetProblem,
  compileExpression,
  evaluateExpression,
  substituteTemplate,
} from './expression.js';
export { applyEvent, foldRecords } from './fold.js';
export { makeInterpreter } from './interpret.js';
export { simulateRun } from './simulate.js';
export {
  provideRunJournal,
  canonicalJson,
  hashRecord,
  findChainBreak,
} from './journal.js';
export { inlineFragments } from './fragment.js';
export { makeWorkflowEngine } from './engine.js';
export { makeWorkflowSyncClient } from './sync.js';
export { renderDefinition, renderMermaid } from './graph.js';
