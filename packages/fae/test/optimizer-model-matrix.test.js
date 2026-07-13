// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { summarizeModelTrials } from '../optimizer/model-matrix.js';

test('summarizeModelTrials reports per-model and worst-slice scores', t => {
  const summary = summarizeModelTrials([
    { model: 'weak', score: { score: 5, withinLimits: true } },
    { model: 'weak', score: { score: 1, withinLimits: false } },
    { model: 'strong', score: { score: 9, withinLimits: true } },
    { model: 'strong', score: { score: 7, withinLimits: true } },
  ]);

  t.is(summary.averageScore, 5.5);
  t.is(summary.minimumScore, 1);
  t.deepEqual(summary.byModel, [
    {
      model: 'weak',
      examples: 2,
      averageScore: 3,
      minimumScore: 1,
      withinLimits: 1,
    },
    {
      model: 'strong',
      examples: 2,
      averageScore: 8,
      minimumScore: 7,
      withinLimits: 2,
    },
  ]);
});
