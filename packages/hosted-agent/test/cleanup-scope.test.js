// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCleanupScope } from '../src/cleanup-scope.js';

test('cleanup attempts independent releases and retries only failed resources', async t => {
  const scope = makeCleanupScope();
  const calls = [];
  let busy = true;
  scope.add(async () => {
    calls.push('mount');
  });
  scope.add(async () => {
    calls.push('grant');
    if (busy) throw Error('grant owner busy');
  });
  scope.add(async () => {
    calls.push('process');
  });
  const error = await t.throwsAsync(scope.run, { instanceOf: AggregateError });
  t.regex(error.errors[0].message, /grant owner busy/);
  t.deepEqual(calls, ['process', 'grant', 'mount']);
  busy = false;
  await scope.run();
  await scope.run();
  t.deepEqual(calls, ['process', 'grant', 'mount', 'grant']);
});

test('concurrent cleanup callers share a flight and closing forbids acquisition', async t => {
  t.timeout(5000);
  const scope = makeCleanupScope();
  let release = () => {};
  const barrier = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(release);
  let calls = 0;
  scope.add(async () => {
    calls += 1;
    await barrier;
  });
  const first = scope.run();
  t.is(scope.run(), first);
  t.throws(() => scope.add(async () => {}), {
    message: /closing cleanup scope/,
  });
  release();
  await first;
  t.is(calls, 1);
  await scope.run();
  t.is(calls, 1);
});

test('dependency guards retain mounts until failed process cleanup succeeds', async t => {
  const scope = makeCleanupScope();
  let stopped = false;
  let busy = true;
  let unmounted = false;
  let revoked = 0;
  scope.add(async () => {
    if (!stopped) throw Error('process still owns mount');
    unmounted = true;
  });
  scope.add(async () => {
    revoked += 1;
  });
  scope.add(async () => {
    if (busy) throw Error('reap failed');
    stopped = true;
  });
  const error = await t.throwsAsync(scope.run, { instanceOf: AggregateError });
  t.is(error.errors.length, 2);
  t.false(unmounted);
  t.is(revoked, 1);
  busy = false;
  await scope.run();
  t.true(stopped);
  t.true(unmounted);
  t.is(revoked, 1);
});
