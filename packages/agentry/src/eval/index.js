// @ts-check

// The git code-mode eval harness: drive a code-mode git-loop agent against a
// scenario and score it by **outcome assertion** (did the repository reach the
// target end-state), not by trace-edit-distance. See ./README.md for the
// eval-vs-optimize distinction.

// Shared harness.
export { runGitScenario, runGitScenarioUnder } from './run.js';
export {
  parseEvalModelSpecs,
  resolveEvalModelFromEnv,
  resolveEvalModelsFromEnv,
} from './env-model.js';
export { makeRunMetricsRecorder } from './metrics.js';
export {
  aggregateEvalMatrixRows,
  renderEvalMatrixMarkdownTable,
  runEvalMatrix,
} from './matrix.js';
export { readText, initRepo, makePowersOver } from './repo.js';
export {
  codeModeCondition,
  defaultEvalConditions,
  evalConditionsByName,
  shellCondition,
  toolCallsCondition,
} from './conditions/index.js';
export { makeDefaultGitScenarioSpecs } from './scenarios/index.js';

// Per-eval public symbols, re-exported from each eval's folder.
export {
  conflictRebasePrompt,
  makeConflictRebaseScenario,
  assertGitConflictRebaseOutcome,
  makeStageAndCommitScenario,
  assertGitCommitOutcome,
  provisionStageAndCommitRepo,
} from './scenarios/index.js';
