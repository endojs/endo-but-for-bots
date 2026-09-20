// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeLatestTopic } from '../src/latest-topic.js';

test('a reader gets the current value, then each change, coalesced', async t => {
  const topic = makeLatestTopic();
  topic.publish('a');
  const reader = iterateReader(topic.watch());
  t.deepEqual(await reader.next(), { done: false, value: 'a' });
  // Three changes while nobody asks are one delivery: the newest.
  topic.publish('b');
  topic.publish('c');
  topic.publish('d');
  t.deepEqual(await reader.next(), { done: false, value: 'd' });
  // Asking first and publishing after also delivers.
  const waiting = reader.next();
  topic.publish('e');
  t.deepEqual(await waiting, { done: false, value: 'e' });
  await reader.return(undefined);
  t.is(topic.watcherCount(), 0);
});

test('a reader opened before anything is published waits for the first value', async t => {
  const topic = makeLatestTopic();
  const reader = iterateReader(topic.watch());
  const first = reader.next();
  topic.publish(1);
  t.deepEqual(await first, { done: false, value: 1 });
  await reader.return(undefined);
});

test('closing a waiting reader ends it, and leaves no record behind', async t => {
  const topic = makeLatestTopic();
  const reader = iterateReader(topic.watch());
  const waiting = reader.next();
  // Let the pull reach the topic and park there: closing in the same tick
  // never exercises the parked case.
  await new Promise(resolve => setTimeout(resolve, 10));
  t.is(topic.watcherCount(), 1);
  await reader.return(undefined);
  t.true((await waiting).done);
  t.is(topic.watcherCount(), 0);
  // Publishing afterwards reaches nobody and does not throw.
  topic.publish('late');
});

test('readers are bounded: past the limit the oldest is closed', async t => {
  const topic = makeLatestTopic({ maxWatchers: 2 });
  topic.publish('v');
  const first = iterateReader(topic.watch());
  t.deepEqual(await first.next(), { done: false, value: 'v' });
  const second = iterateReader(topic.watch());
  const third = iterateReader(topic.watch());
  t.is(topic.watcherCount(), 2);
  // The oldest reader's stream ends; the others still work.
  t.true((await first.next()).done);
  t.deepEqual(await second.next(), { done: false, value: 'v' });
  t.deepEqual(await third.next(), { done: false, value: 'v' });
  topic.close();
  t.is(topic.watcherCount(), 0);
});

test('a closed topic ends its readers, and any opened afterwards', async t => {
  const topic = makeLatestTopic();
  topic.publish('v');
  const open = iterateReader(topic.watch());
  t.deepEqual(await open.next(), { done: false, value: 'v' });
  topic.close();
  t.true((await open.next()).done);
  const late = iterateReader(topic.watch());
  t.true((await late.next()).done);
  t.is(topic.watcherCount(), 0);
});
