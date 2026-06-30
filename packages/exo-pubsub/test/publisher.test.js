// @ts-check
/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { makeLoopback, E } from '@endo/captp';
import { makeChangeTopic } from '@endo/pubsub/change-topic.js';

import { publisherFromWriter } from '../publisher-from-writer.js';
import { iteratePublisher } from '../iterate-publisher.js';

test('publisherFromWriter lets a remote producer publish into a local topic', async t => {
  const topic = makeChangeTopic();

  // The far side owns the topic and a local subscriber, and vends the publisher.
  const localSubscription = topic.subscribe();
  const { makeFar } = makeLoopback('publisher');
  const host = Far('Host', {
    getPublisher: () => publisherFromWriter(topic.publisher),
  });
  const remoteHost = await makeFar(host);

  const remotePublisher = iteratePublisher(E(remoteHost).getPublisher());

  await remotePublisher.next(harden({ add: 'one' }));
  await remotePublisher.next(harden({ add: 'two' }));

  // The far-side subscriber observes both values published from the near side.
  t.deepEqual((await localSubscription.next()).value, { add: 'one' });
  t.deepEqual((await localSubscription.next()).value, { add: 'two' });
});

test('iteratePublisher honours a write pattern at the boundary', async t => {
  const topic = makeChangeTopic();
  const { makeFar } = makeLoopback('publisher-pattern');
  const host = Far('Host', {
    getPublisher: () => publisherFromWriter(topic.publisher),
  });
  const remoteHost = await makeFar(host);

  const remotePublisher = iteratePublisher(E(remoteHost).getPublisher(), {
    writePattern: harden({ add: 'ok' }),
  });

  await remotePublisher.next(harden({ add: 'ok' }));
  await t.throwsAsync(() => remotePublisher.next(harden({ add: 'nope' })));
});
