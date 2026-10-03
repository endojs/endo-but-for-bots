import test from '@endo/ses-ava/prepare-endo.js';

import { makeRouter } from '../router.js';

const message = (number, fromNames, text) =>
  harden({
    number,
    type: 'package',
    fromNames,
    toNames: ['@self'],
    strings: [text],
    names: [],
  });

test('route ignores a guest message whose sender names include @self', async t => {
  // Jaine is a guest: it names its own outbound mail `@self`, and engaging it
  // would loop on its own replies.
  const router = await makeRouter(undefined, undefined);
  const decision = router.route(message(1n, ['@self'], 'hello'));
  t.is(decision.action, 'ignore');
  t.is(decision.reason, 'own message');
});

test('route engages a correspondent once per message number', async t => {
  const router = await makeRouter(undefined, undefined);
  const first = router.route(message(2n, ['alice'], 'hello'));
  t.is(first.action, 'engage');
  t.regex(first.textContent, /hello/);
  const repeat = router.route(message(2n, ['alice'], 'hello'));
  t.is(repeat.action, 'ignore');
  t.is(repeat.reason, 'duplicate');
});

test('route engages a message without sender names', async t => {
  const router = await makeRouter(undefined, undefined);
  t.is(router.route(harden({ number: 3n, type: 'package' })).action, 'engage');
});

test('participation is keyed by the channel pet name', async t => {
  const router = await makeRouter(undefined, undefined);
  t.is(router.getParticipation('lobby').level, 'normal');
  router.setParticipation('lobby', 'observer', 'quiet please');
  t.deepEqual(router.getParticipation('lobby'), {
    level: 'observer',
    notes: 'quiet please',
  });
  t.is(router.getParticipation('kitchen').level, 'normal');
  const observed = await router.routeChannelMessage(
    message(4n, ['alice'], 'hi'),
    'lobby',
    '',
    'alice',
  );
  t.deepEqual(observed, { shouldEngage: false, reason: 'observer mode' });
});
