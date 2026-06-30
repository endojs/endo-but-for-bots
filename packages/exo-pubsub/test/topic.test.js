// @ts-check
/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { makeLoopback, E } from '@endo/captp';
import { makeChangeTopic } from '@endo/pubsub/change-topic.js';
import { makeLatestTopic } from '@endo/pubsub/latest-topic.js';

import { topicFromSubscribe } from '../topic-from-subscribe.js';
import { subscribeTopic } from '../subscribe-topic.js';

/**
 * Stand up a far-side host that vends the read side of `topic` over a CapTP
 * membrane and lets the test drive publication. Returns the near-side remote
 * host presence.
 *
 * @param {{ publisher: any, subscribe: any }} topic
 */
const hostTopic = async topic => {
  const { makeFar } = makeLoopback('topic');
  const host = Far('Host', {
    getTopic: () => topicFromSubscribe(topic.subscribe),
    publish: value => topic.publisher.next(value),
    finish: value => topic.publisher.return(value),
    fail: error => topic.publisher.throw(error),
    // A round trip to the host that is causally after a prior subscribe()
    // message on the same membrane, so the responder has minted (and captured
    // the cursor of) the subscription before the test publishes.
    ping: () => undefined,
  });
  return makeFar(host);
};

test('topicFromSubscribe delivers change-topic deltas across CapTP', async t => {
  const topic = makeChangeTopic();
  const remoteHost = await hostTopic(topic);

  const remoteTopic = await E(remoteHost).getTopic();
  const subscription = subscribeTopic(remoteTopic).subscribe();

  // The subscribe() message is in flight; ping is ordered after it, so once
  // ping resolves the cursor has been captured and lossless delivery is safe.
  await E(remoteHost).ping();

  await E(remoteHost).publish(harden({ add: 'alice' }));
  await E(remoteHost).publish(harden({ add: 'bob' }));

  const first = await subscription.next();
  t.false(first.done);
  t.deepEqual(first.value, { add: 'alice' });

  const second = await subscription.next();
  t.false(second.done);
  t.deepEqual(second.value, { add: 'bob' });
});

test('topicFromSubscribe fans out to independent subscribers', async t => {
  const topic = makeChangeTopic();
  const remoteHost = await hostTopic(topic);

  const remoteTopic = await E(remoteHost).getTopic();
  const local = subscribeTopic(remoteTopic);
  const first = local.subscribe();
  const second = local.subscribe();

  await E(remoteHost).ping();

  await E(remoteHost).publish(harden({ add: 'shared' }));

  const a = await first.next();
  const b = await second.next();
  t.deepEqual(a.value, { add: 'shared' });
  t.deepEqual(b.value, { add: 'shared' });
});

test('topicFromSubscribe propagates topic return termination', async t => {
  const topic = makeChangeTopic();
  const remoteHost = await hostTopic(topic);

  const remoteTopic = await E(remoteHost).getTopic();
  const subscription = subscribeTopic(remoteTopic).subscribe();
  await E(remoteHost).ping();

  await E(remoteHost).publish(harden({ add: 'only' }));
  await E(remoteHost).finish(undefined);

  const value = await subscription.next();
  t.deepEqual(value.value, { add: 'only' });

  const end = await subscription.next();
  t.true(end.done);
});

test('topicFromSubscribe over a latest topic is lossy (sees newest)', async t => {
  const topic = makeLatestTopic();
  const remoteHost = await hostTopic(topic);

  const remoteTopic = await E(remoteHost).getTopic();
  const subscription = subscribeTopic(remoteTopic).subscribe();
  await E(remoteHost).ping();

  // Publish three before the first read; a lossy topic collapses to newest.
  await E(remoteHost).publish(harden({ count: 1 }));
  await E(remoteHost).publish(harden({ count: 2 }));
  await E(remoteHost).publish(harden({ count: 3 }));

  const latest = await subscription.next();
  t.false(latest.done);
  t.deepEqual(latest.value, { count: 3 });
});

test('topicFromSubscribe honours a per-subscription read pattern', async t => {
  const topic = makeChangeTopic();
  const remoteHost = await hostTopic(topic);

  const remoteTopic = await E(remoteHost).getTopic();
  const subscription = subscribeTopic(remoteTopic, {
    buffer: 0,
    readPattern: harden({ add: 'alice' }),
  }).subscribe();
  await E(remoteHost).ping();

  await E(remoteHost).publish(harden({ add: 'alice' }));
  const ok = await subscription.next();
  t.deepEqual(ok.value, { add: 'alice' });

  await E(remoteHost).publish(harden({ add: 'mismatch' }));
  await t.throwsAsync(() => subscription.next());
});
