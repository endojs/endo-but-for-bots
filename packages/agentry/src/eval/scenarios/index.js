// @ts-check

// Registry barrel for all git code-mode eval scenarios.
export {
  conflictRebasePrompt,
  makeConflictRebaseScenario,
  assertGitConflictRebaseOutcome,
} from './conflict-rebase/index.js';
export {
  makeStageAndCommitScenario,
  assertGitCommitOutcome,
} from './stage-and-commit/index.js';
