// @ts-check
/// <reference types="ses"/>

/** @import { GitScenarioSpec } from '../types.js' */

import {
  makeStageAndCommitScenario,
  provisionStageAndCommitRepo,
} from './stage-and-commit/index.js';
import {
  makeConflictRebaseScenario,
  provisionConflictRebaseRepo,
} from './conflict-rebase/index.js';

export {
  conflictRebasePrompt,
  makeConflictRebaseScenario,
  assertGitConflictRebaseOutcome,
} from './conflict-rebase/index.js';
export {
  makeStageAndCommitScenario,
  assertGitCommitOutcome,
  provisionStageAndCommitRepo,
} from './stage-and-commit/index.js';

/**
 * @returns {GitScenarioSpec}
 */
export const makeStageAndCommitScenarioSpec = () =>
  harden({
    name: 'stage-and-commit',
    makeScenario: () => makeStageAndCommitScenario(),
    provisionRepo: ({ scenario }) =>
      provisionStageAndCommitRepo({
        path: /** @type {import('../types.js').GitCommitTarget} */ (
          scenario.expected
        ).path,
        content: /** @type {import('../types.js').GitCommitTarget} */ (
          scenario.expected
        ).content,
      }),
  });
harden(makeStageAndCommitScenarioSpec);

/**
 * @returns {GitScenarioSpec}
 */
export const makeConflictRebaseScenarioSpec = () =>
  harden({
    name: 'conflict-rebase',
    makeScenario: () => makeConflictRebaseScenario(),
    provisionRepo: ({ requirements }) =>
      provisionConflictRebaseRepo(requirements),
  });
harden(makeConflictRebaseScenarioSpec);

/**
 * Landed eval scenarios.
 * Each matrix run provisions a fresh repo from the spec
 * so conditions and repeats do not share state.
 *
 * @returns {GitScenarioSpec[]}
 */
export const makeDefaultGitScenarioSpecs = () =>
  harden([makeStageAndCommitScenarioSpec(), makeConflictRebaseScenarioSpec()]);
harden(makeDefaultGitScenarioSpecs);
