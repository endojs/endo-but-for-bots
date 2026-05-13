// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { score, choices } from '../src/score.js';

/** @import { Choice, GameResult } from '../src/score.js' */

test('every same-choice pair is a draw', t => {
  for (const c of choices) {
    t.is(score(c, c), 'draw', `${c} vs ${c}`);
  }
});

test('paper beats rock with the right reason', t => {
  t.deepEqual(score('paper', 'rock'), { winner: 1, why: 'paper covers rock' });
  t.deepEqual(score('rock', 'paper'), { winner: 2, why: 'paper covers rock' });
});

test('scissors beats paper with the right reason', t => {
  t.deepEqual(score('scissors', 'paper'), {
    winner: 1,
    why: 'scissors cuts paper',
  });
  t.deepEqual(score('paper', 'scissors'), {
    winner: 2,
    why: 'scissors cuts paper',
  });
});

test('rock beats scissors with the right reason', t => {
  t.deepEqual(score('rock', 'scissors'), {
    winner: 1,
    why: 'rock crushes scissors',
  });
  t.deepEqual(score('scissors', 'rock'), {
    winner: 2,
    why: 'rock crushes scissors',
  });
});

test('every non-draw outcome names exactly one winner', t => {
  for (const c1 of choices) {
    for (const c2 of choices) {
      if (c1 !== c2) {
        const result = score(c1, c2);
        t.not(result, 'draw', `${c1} vs ${c2} should not be a draw`);
        const { winner, why } = /** @type {Exclude<GameResult, 'draw'>} */ (
          result
        );
        t.true(
          winner === 1 || winner === 2,
          `winner must be 1 or 2; got ${winner}`,
        );
        t.true(why.length > 0, 'why must be a non-empty sentence');
      }
    }
  }
});

test('score result is hardened', t => {
  const result = score('rock', 'scissors');
  t.true(Object.isFrozen(result));
});
