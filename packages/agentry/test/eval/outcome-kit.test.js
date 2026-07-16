// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  check,
  makeOutcomeReport,
  measurementPoint,
  readTrackedFileAt,
} from '../../src/eval/outcome-kit.js';

test('outcome report scores flat measurement points without changing the gate', t => {
  const allMiss = makeOutcomeReport(
    [check('first', false, 'miss'), check('second', false, 'miss')],
    [
      measurementPoint('first progress marker', false, 'miss'),
      measurementPoint('second progress marker', false, 'miss'),
    ],
  );
  t.false(allMiss.pass);
  t.is(allMiss.score, 0);
  t.is(allMiss.divergence, null);

  const partial = makeOutcomeReport(
    [
      check('first', true, 'pass'),
      check('second', false, 'miss'),
      check('third', true, 'pass'),
    ],
    [
      measurementPoint('first progress marker', true, 'pass'),
      measurementPoint('second progress marker', false, 'miss'),
      measurementPoint('third progress marker', true, 'pass'),
    ],
  );
  t.false(partial.pass);
  t.is(partial.score, 2 / 3);
  t.is(partial.divergence, null);

  const full = makeOutcomeReport(
    [check('first', true, 'pass'), check('second', true, 'pass')],
    [
      measurementPoint('first progress marker', true, 'pass'),
      measurementPoint('second progress marker', true, 'pass'),
    ],
  );
  t.true(full.pass);
  t.is(full.score, 1);
  t.is(full.divergence, null);
});

test('outcome report flags a complete score with a failing gate', t => {
  const report = makeOutcomeReport(
    [check('gate-only condition', false, 'miss')],
    [measurementPoint('progress marker', true, 'hit')],
  );

  t.false(report.pass);
  t.is(report.score, 1);
  t.is(report.divergence, 'fail-with-complete-score');
});

test('tracked-file lookup rejects malformed relative paths', async t => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('', '..', '/file', 'dir//file', 'dir/../file'),
      async path => {
        await t.throwsAsync(
          () =>
            readTrackedFileAt({
              git: undefined,
              readText: async () => '',
              ref: 'HEAD',
              path,
            }),
          { message: /non-empty relative path/ },
        );
      },
    ),
  );
});
