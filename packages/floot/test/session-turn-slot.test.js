// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { makeSessionTurnSlot } from '../src/session-turn-slot.js';

test('a session retains its turn through cancellation and releases it after teardown', async t => {
  t.timeout(2000);
  let settle = () => {};
  const slot = makeSessionTurnSlot(
    () =>
      new Promise(resolve => {
        settle = () => resolve(undefined);
      }),
  );
  const turn = slot.start('hello');
  t.deepEqual(slot.getCurrent(), { input: 'hello', turn });
  t.throws(() => slot.start('overlap'), { message: /active turn/ });
  await E(turn).cancel();
  t.is(slot.getCurrent()?.turn, turn);
  t.throws(() => slot.start('still unwinding'), { message: /active turn/ });
  settle();
  await E(turn).whenFinished();
  await null;
  t.is(slot.getCurrent(), null);
  const next = slot.start('next');
  t.not(next, turn);
  settle();
  await E(next).whenFinished();
});

test('turn discovery never reveals a streamed input capability', async t => {
  const input = harden({ stream: () => undefined });
  /** @type {unknown} */
  let received;
  const slot = makeSessionTurnSlot(async value => {
    received = value;
  });
  const turn = slot.start(input);
  t.is(received, input);
  t.deepEqual(slot.getCurrent(), { input: null, turn });
  await E(turn).whenFinished();
});
