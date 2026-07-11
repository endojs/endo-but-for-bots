// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

test('agentry subpaths resolve through package exports', async t => {
  const [rootModule, harnessModule, executeModule, evalModule] =
    await Promise.all([
      // eslint-disable-next-line import/no-unresolved
      import('@endo/agentry'),
      // eslint-disable-next-line import/no-unresolved
      import('@endo/agentry/harness'),
      // eslint-disable-next-line import/no-unresolved
      import('@endo/agentry/execute'),
      // eslint-disable-next-line import/no-unresolved
      import('@endo/agentry/eval'),
    ]);
  t.is(typeof rootModule.defineAgent, 'function');
  t.is(typeof harnessModule.makePiAgent, 'function');
  t.is(typeof executeModule.makeCodeModeAgent, 'function');
  t.is(typeof evalModule.runGitScenario, 'function');
  t.is(typeof evalModule.makeRunMetricsRecorder, 'function');
  t.is(typeof evalModule.resolveEvalModelFromEnv, 'function');
  t.is(evalModule.conflictRebasePrompt, undefined);
  t.is(evalModule.makeConflictRebaseScenario, undefined);
  t.is(evalModule.assertGitConflictRebaseOutcome, undefined);
  t.is(evalModule.makeStageAndCommitScenario, undefined);
  t.is(evalModule.assertGitCommitOutcome, undefined);
});
