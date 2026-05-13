// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { make } from '../src/rock-paper-scissors.js';

test('a single round resolves with the right verdict', async t => {
  const attacker = make();
  const defender = E(attacker).attack('rock');
  const result = await E(defender).defend('paper');
  t.deepEqual(result, { winner: 2, why: 'paper covers rock' });
});

test('a tie is reported as a draw', async t => {
  const attacker = make();
  const defender = E(attacker).attack('scissors');
  const result = await E(defender).defend('scissors');
  t.is(result, 'draw');
});

test('an invalid attacker choice is rejected at the boundary', async t => {
  const attacker = make();
  await t.throwsAsync(
    // @ts-expect-error deliberately invalid input
    () => E(attacker).attack('pillow'),
    { message: /In "attack" method/ },
    'pattern guard rejects unknown choices',
  );
});

test('an invalid defender choice is rejected at the boundary', async t => {
  const attacker = make();
  const defender = E(attacker).attack('rock');
  await t.throwsAsync(
    // @ts-expect-error deliberately invalid input
    () => E(defender).defend('lizard'),
    { message: /In "defend" method/ },
  );
});

test('the attacker can attack only once', async t => {
  const attacker = make();
  void E(attacker).attack('rock');
  await t.throwsAsync(() => E(attacker).attack('scissors'), {
    message: /already chose/,
  });
});

test('getResult settles once the defender plays', async t => {
  const attacker = make();
  const resultP = E(attacker).getResult();
  const defender = E(attacker).attack('rock');
  await E(defender).defend('scissors');
  t.deepEqual(await resultP, { winner: 1, why: 'rock crushes scissors' });
});

test('getResult on a fresh game stays pending', async t => {
  const attacker = make();
  let settled = false;
  E(attacker)
    .getResult()
    .then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
  // Flush the microtask queue a few times.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  t.false(settled, 'result must not settle before defender.defend()');
});

test('two parallel games do not share state', async t => {
  const g1 = make();
  const g2 = make();
  const d1 = E(g1).attack('rock');
  const d2 = E(g2).attack('paper');
  const [r1, r2] = await Promise.all([
    E(d1).defend('paper'),
    E(d2).defend('scissors'),
  ]);
  t.deepEqual(r1, { winner: 2, why: 'paper covers rock' });
  t.deepEqual(r2, { winner: 2, why: 'scissors cuts paper' });
});
