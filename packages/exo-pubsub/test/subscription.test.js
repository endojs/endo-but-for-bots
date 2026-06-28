// @ts-check
/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { makeLoopback, E } from '@endo/captp';
import { makePromiseKit } from '@endo/promise-kit';
import { makeChangeTopic } from '@endo/pubsub/change-topic.js';

import { subscriptionFromReader } from '../subscription-from-reader.js';
import { iterateSubscription } from '../iterate-subscription.js';

test('subscriptionFromReader bridges a single subscription across CapTP', async t => {
  const { promise: trigger, resolve: fire } = makePromiseKit();

  async function* followChanges() {
    yield harden({ add: 'INITIAL' });
    await trigger;
    yield harden({ add: 'TRIGGERED' });
  }

  const { makeFar } = makeLoopback('subscription');
  const host = Far('Host', {
    followChanges: () => subscriptionFromReader(followChanges()),
    fire: () => fire(undefined),
  });
  const remoteHost = await makeFar(host);

  const subscription = iterateSubscription(E(remoteHost).followChanges());

  const first = await subscription.next();
  t.false(first.done);
  t.deepEqual(first.value, { add: 'INITIAL' });

  await E(remoteHost).fire();

  const second = await subscription.next();
  t.deepEqual(second.value, { add: 'TRIGGERED' });

  const end = await subscription.next();
  t.true(end.done);
});

// Mirrors the daemon's followNameChanges shape: a snapshot prefix followed by a
// live @endo/pubsub change-topic subscription, bridged with subscriptionFromReader
// and consumed with iterateSubscription. This is the migration shape the chat
// name-change follow path now takes.
test('subscriptionFromReader carries snapshot-then-topic like followNameChanges', async t => {
  /** @type {{ publisher: any, subscribe: () => AsyncIterable<{ add: string }> }} */
  const nameChanges = makeChangeTopic();

  async function* followNameChanges() {
    yield harden({ add: 'MAIN' });
    yield harden({ add: 'SELF' });
    const subscription = nameChanges.subscribe();
    for await (const change of subscription) {
      yield change;
    }
  }

  const { makeFar } = makeLoopback('follow-names');
  const host = Far('Host', {
    followNameChanges: () => subscriptionFromReader(followNameChanges()),
    addName: name => nameChanges.publisher.next(harden({ add: name })),
  });
  const remoteHost = await makeFar(host);

  // buffer 1 so the responder generator advances past subscribe() before
  // addName publishes, matching the daemon/chat live-follow contract.
  const names = iterateSubscription(E(remoteHost).followNameChanges(), {
    buffer: 1,
  });

  t.deepEqual((await names.next()).value, { add: 'MAIN' });
  t.deepEqual((await names.next()).value, { add: 'SELF' });

  await E(remoteHost).addName('NEW');
  t.deepEqual((await names.next()).value, { add: 'NEW' });
});

test('iterateSubscription early close releases the subscription', async t => {
  const { makeFar } = makeLoopback('close');
  const host = Far('Host', {
    follow: () =>
      subscriptionFromReader(
        (async function* pair() {
          yield harden({ add: 'first' });
          yield harden({ add: 'second' });
        })(),
      ),
  });
  const remoteHost = await makeFar(host);

  const subscription = iterateSubscription(E(remoteHost).follow());
  const first = await subscription.next();
  t.deepEqual(first.value, { add: 'first' });

  assert(subscription.return, 'iterator has return');
  await subscription.return();

  const end = await subscription.next();
  t.true(end.done);
});
