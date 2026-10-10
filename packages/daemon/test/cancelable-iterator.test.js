// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import {
  cancelPendingIterator,
  makeCancelableIterator,
} from '../src/cancelable-iterator.js';
import { makeChangeTopic } from '../src/pubsub.js';

test('reader close cancels a pending pull through nested generators', async t => {
  t.timeout(5000);
  const topic = makeChangeTopic();
  const started = makePromiseKit();
  let cleaned = 0;
  const source = makeCancelableIterator(async function* (setCancelPending) {
    const subscription = topic.subscribe();
    setCancelPending(() => cancelPendingIterator(subscription));
    try {
      started.resolve(undefined);
      yield* subscription;
    } finally {
      await subscription.return(undefined);
      cleaned += 1;
    }
    return undefined;
  });
  const outer = makeCancelableIterator(async function* (setCancelPending) {
    setCancelPending(() => cancelPendingIterator(source));
    try {
      yield* source;
    } finally {
      await source.return(undefined);
      cleaned += 1;
    }
    return undefined;
  });
  const reader = iterateReader(
    readerFromIterator(outer, {
      cancelPending: () => cancelPendingIterator(outer),
    }),
  );
  const pending = reader.next();
  await started.promise;
  t.true((await reader.return(undefined)).done);
  t.true((await pending).done);
  t.is(cleaned, 2);
});

test('return during a snapshot releases the live subscription', async t => {
  t.timeout(5000);
  const topic = makeChangeTopic();
  const subscription = topic.subscribe();
  const pending = subscription.next(undefined);
  const iterator = makeCancelableIterator(async function* (setCancelPending) {
    setCancelPending(() => cancelPendingIterator(subscription));
    try {
      yield 'snapshot';
      yield* subscription;
    } finally {
      await subscription.return(undefined);
    }
    return undefined;
  });
  await iterator.next();
  await iterator.return(undefined);
  t.true((await pending).done);
});

test('cancellation reaches a source acquired after an await', async t => {
  t.timeout(5000);
  const ready = makePromiseKit();
  let canceled = 0;
  const iterator = makeCancelableIterator(
    // This source completes without yielding after cancellation.
    // eslint-disable-next-line require-yield
    async function* delayedSource(setCancelPending) {
      await ready.promise;
      await setCancelPending(() => {
        canceled += 1;
      });
      return undefined;
    },
  );
  const pending = iterator.next();
  await cancelPendingIterator(iterator);
  ready.resolve(undefined);
  t.true((await pending).done);
  t.is(canceled, 1);
});

test('a failing cancellation hook still runs generator cleanup', async t => {
  t.timeout(5000);
  let cleaned = false;
  const failure = Error('cancellation failed');
  const iterator = makeCancelableIterator(
    async function* failingCancellation(setCancelPending) {
      await setCancelPending(() => {
        throw failure;
      });
      try {
        yield 'snapshot';
      } finally {
        cleaned = true;
      }
      return undefined;
    },
  );
  await iterator.next();
  await t.throwsAsync(() => iterator.return(undefined), { is: failure });
  t.true(cleaned);
});

test('return queues before a subsequent next call', async t => {
  const iterator = makeCancelableIterator(async function* values() {
    yield 'must not be pulled';
    return undefined;
  });
  const returned = iterator.return(undefined);
  const subsequent = iterator.next();
  t.true((await returned).done);
  t.true((await subsequent).done);
});
