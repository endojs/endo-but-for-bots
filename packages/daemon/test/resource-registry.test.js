// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeResourceRegistry } from '../src/resource-registry.js';

const defer = () => {
  let resolve = () => {};
  const promise = new Promise(r => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
};

test('session operations serialize locally, recover after failure, and allow unrelated progress', async t => {
  t.timeout(5000);
  const sessions = makeResourceRegistry();
  const acquired = defer();
  const unblock = defer();
  t.teardown(unblock.resolve);
  const calls = [];
  const first = sessions.inOrder('a', async () => {
    calls.push('a1');
    acquired.resolve();
    await unblock.promise;
    throw Error('acquisition failed');
  });
  const failed = t.throwsAsync(first, { message: /acquisition failed/ });
  const next = sessions.inOrder('a', async () => {
    calls.push('a2');
    return 2;
  });
  await acquired.promise;
  await sessions.inOrder('b', async () => {
    calls.push('b');
  });
  t.deepEqual(calls, ['a1', 'b']);
  unblock.resolve();
  await failed;
  t.is(await next, 2);
  t.deepEqual(calls, ['a1', 'b', 'a2']);
});

test('failed cleanup retains ownership and stale release cannot remove a successor', async t => {
  const sessions = makeResourceRegistry();
  let busy = true;
  let attempts = 0;
  const predecessor = async () => {
    attempts += 1;
    if (busy) throw Error('still running');
    sessions.release('a', predecessor);
  };
  sessions.retain('a', predecessor);
  await t.throwsAsync(() => sessions.stop('a'), { message: /still running/ });
  busy = false;
  await sessions.stop('a');
  await sessions.stop('a');
  t.is(attempts, 2);
  let successorStops = 0;
  const successor = async () => {
    successorStops += 1;
    sessions.release('a', successor);
  };
  sessions.retain('a', successor);
  sessions.release('a', predecessor);
  await sessions.stop('a');
  t.is(successorStops, 1);
});

test('shutdown fences queued and future work and cleans up a late acquisition', async t => {
  t.timeout(5000);
  const sessions = makeResourceRegistry();
  const acquiring = defer();
  const unblock = defer();
  t.teardown(unblock.resolve);
  let stopped = 0;
  const terminate = async () => {
    stopped += 1;
    sessions.release('a', terminate);
  };
  const starting = sessions.inOrder('a', async () => {
    acquiring.resolve();
    await unblock.promise;
    sessions.retain('a', terminate);
  });
  await acquiring.promise;
  const queued = sessions.inOrder('a', async () =>
    t.fail('queued operation ran'),
  );
  const rejected = t.throwsAsync(queued, { message: /shutting down/ });
  const shutdown = sessions.shutdown();
  t.is(sessions.shutdown(), shutdown);
  t.throws(() => sessions.inOrder('b', async () => {}), {
    message: /shutting down/,
  });
  t.is(stopped, 0);
  unblock.resolve();
  await starting;
  await rejected;
  await shutdown;
  t.is(stopped, 1);
  await sessions.shutdown();
  t.is(stopped, 1);
});

test('shutdown attempts independent owners and retries retained failures', async t => {
  const sessions = makeResourceRegistry();
  let busy = true;
  let firstStops = 0;
  let otherStops = 0;
  const first = async () => {
    firstStops += 1;
    if (busy) throw Error('reap failed');
    sessions.release('a', first);
  };
  const other = async () => {
    otherStops += 1;
    sessions.release('b', other);
  };
  sessions.retain('a', first);
  sessions.retain('b', other);
  const error = await t.throwsAsync(sessions.shutdown, {
    instanceOf: AggregateError,
    message: /shutdown pending/,
  });
  t.is(error.errors[0].message, 'reap failed');
  t.is(otherStops, 1);
  busy = false;
  await sessions.shutdown();
  t.is(firstStops, 2);
  t.is(otherStops, 1);
});
