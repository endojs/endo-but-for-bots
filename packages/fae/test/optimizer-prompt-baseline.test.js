// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  findBaselineIssues,
  sha256,
} from '../optimizer/check-prompt-baseline.js';

const baseline = harden({
  systemPromptSha256: sha256('prompt'),
  repairMessagesSha256: sha256('repairs'),
  examplesSha256: sha256('examples'),
  trainingScore: 8,
  modelScores: {
    weak: 8,
    strong: 9,
  },
});

test('prompt baseline accepts matching prompt, examples, and non-regressed score', t => {
  t.deepEqual(
    findBaselineIssues({
      baseline,
      previousBaseline: {
        ...baseline,
        trainingScore: 7,
        modelScores: { weak: 7, strong: 9 },
      },
      systemPromptSha256: sha256('prompt'),
      repairMessagesSha256: sha256('repairs'),
      examplesSha256: sha256('examples'),
    }),
    [],
  );
});

test('prompt baseline reports stale hashes, score regressions, and missing models', t => {
  t.deepEqual(
    findBaselineIssues({
      baseline: {
        ...baseline,
        modelScores: { weak: 7 },
      },
      previousBaseline: {
        ...baseline,
        trainingScore: 9,
        modelScores: { weak: 8, strong: 9 },
      },
      systemPromptSha256: sha256('changed prompt'),
      repairMessagesSha256: sha256('changed repairs'),
      examplesSha256: sha256('changed examples'),
    }),
    [
      'system-prompt.js changed since the recorded optimizer baseline',
      'repair-messages.js changed since the recorded optimizer baseline',
      'optimizer/examples.json changed since the recorded baseline',
      'training score regressed from 9 to 8',
      'model score for weak regressed from 8 to 7',
      'model score for strong is missing from the baseline',
    ],
  );
});
