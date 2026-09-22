// @ts-check
/// <reference types="ses"/>

/** @import { GitScenario } from '../../types.js' */
/** @import { GitConflictRebaseTarget } from './types.js' */

import { assertGitConflictRebaseOutcome } from './outcome.js';

export const conflictRebasePrompt = `\
Rebase the current feature branch onto integration.
When app.txt conflicts, keep the integration wording, then add the feature
sentence after it.
Preserve the feature note and the integration note.
Leave the branch rebased, with a clean working tree.`;
harden(conflictRebasePrompt);

/** Repo-relative path to this scenario's reference solution. */
const referenceSourcePath =
  'packages/agentry/src/eval/scenarios/conflict-rebase/reference.js';
/** Named export in {@link referenceSourcePath} holding the reference solution. */
const referenceSourceExport = 'conflictRebaseSource';

/**
 * A git code-mode scenario for a rebase that must stop for a content conflict,
 * resolve it deliberately, then continue replaying the remaining clean commit.
 *
 * @param {GitConflictRebaseTarget} [expectedTarget]
 * @returns {GitScenario<GitConflictRebaseTarget>}
 */
export const makeConflictRebaseScenario = expectedTarget => {
  const expected = harden({
    featureBranch: expectedTarget?.featureBranch ?? '',
    integrationBranch: expectedTarget?.integrationBranch ?? '',
    integrationOid: expectedTarget?.integrationOid ?? '',
    replayedSummaries: expectedTarget?.replayedSummaries ?? [],
    originalFeatureOids: expectedTarget?.originalFeatureOids ?? [],
    expectedPatches: expectedTarget?.expectedPatches ?? [],
    featureTreeOid: expectedTarget?.featureTreeOid ?? '',
    appText: expectedTarget?.appText ?? '',
    notes: expectedTarget?.notes ?? [],
  });
  return harden({
    name: 'conflict-rebase',
    requirements: harden({ allowHistoryRewrite: true }),
    expected,
    prompt: conflictRebasePrompt,
    referenceSourcePath,
    referenceSourceExport,
    assertOutcome: args => {
      if (expectedTarget === undefined) {
        throw new Error('conflict-rebase scenario target is not provisioned');
      }
      return assertGitConflictRebaseOutcome({ ...args, expected });
    },
  });
};
harden(makeConflictRebaseScenario);
