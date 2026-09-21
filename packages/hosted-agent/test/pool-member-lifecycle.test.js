// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makePoolMemberLifecycle } from '../src/pool-member-lifecycle.js';

const gate = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test('retirement waits for admitted rotation persistence but never releases its result', async t => {
  const owner = makePoolMemberLifecycle();
  const started = gate();
  const release = gate();
  let persisted = false;
  const current = owner.run(async () => {
    started.resolve();
    await release.promise;
    persisted = true;
    return 'private token';
  });
  const rejected = t.throwsAsync(current, { message: /retired/ });
  await started.promise;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await null;
  t.false(closed);
  t.throws(() => owner.run(() => 'new work'), { message: /retired/ });
  release.resolve();
  await closing;
  await rejected;
  t.true(persisted);
});

test('a dispatched reset keeps its real result and cleanup failures remain retryable', async t => {
  const owner = makePoolMemberLifecycle();
  const started = gate();
  const release = gate();
  let attempts = 0;
  owner.retain(() => {
    attempts += 1;
    if (attempts === 1) throw Error('cleanup failed');
  });
  const reset = owner.run(async () => {
    started.resolve();
    await release.promise;
    return { outcome: 'reset' };
  }, true);
  await started.promise;
  const closing = t.throwsAsync(owner.close(), { message: /cleanup pending/ });
  release.resolve();
  t.deepEqual(await reset, { outcome: 'reset' });
  await closing;
  await owner.close();
  t.is(attempts, 2);
});
