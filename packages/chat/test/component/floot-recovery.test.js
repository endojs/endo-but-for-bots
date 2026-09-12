// @ts-check

import '@endo/init/debug.js';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import test from 'ava';

import { makeFlootRecovery } from '../../floot-recovery.js';

const unknownTurn = harden({
  turnId: '1',
  state: 'outcome-unknown',
  tools: [],
  activity: [],
});
const makeSession = (overrides = {}) =>
  Far('RecoverySession', {
    __getMethodNames__: () =>
      harden(['getTurns', 'resolveTurn', 'getCurrentTurn']),
    getTurns: () => harden([unknownTurn]),
    getCurrentTurn: () => null,
    resolveTurn: () => undefined,
    ...overrides,
  });

test('resolution needs explicit confirmation, a note, and idle admission', async t => {
  const calls = [];
  let busy = false;
  const recovery = makeFlootRecovery({ notify: () => {}, isBusy: () => busy });
  await recovery.select(
    makeSession({ resolveTurn: (...args) => calls.push(args) }),
  );
  await recovery.resolve('1', '', true);
  await recovery.resolve('1', 'checked', false);
  busy = true;
  await recovery.resolve('1', 'checked', true);
  t.deepEqual(calls, []);
  busy = false;
  await recovery.resolve('1', ' checked ', true);
  t.deepEqual(calls, [['1', 'checked']]);
});

test('remote liveness recheck refuses a turn started since the snapshot', async t => {
  let current = null;
  let calls = 0;
  const recovery = makeFlootRecovery({ notify: () => {}, isBusy: () => false });
  await recovery.select(
    makeSession({
      getCurrentTurn: () => current,
      resolveTurn: () => {
        calls += 1;
      },
    }),
  );
  current = true;
  await recovery.resolve('1', 'checked', true);
  t.is(calls, 0);
  t.false(recovery.getState().canResolve);
  t.regex(recovery.getState().message, /turn is active/);
});

test('session switching fences late reads and a not-yet-dispatched resolution', async t => {
  t.timeout(2000);
  const read = makePromiseKit();
  const recovery = makeFlootRecovery({ notify: () => {}, isBusy: () => false });
  const pending = recovery.select(
    makeSession({ getTurns: () => read.promise }),
  );
  await recovery.select(null, 'Unavailable session');
  read.resolve(harden([unknownTurn]));
  await pending;
  t.is(recovery.getState().message, 'Unavailable session');
  const check = makePromiseKit();
  let rechecking = false;
  let calls = 0;
  await recovery.select(
    makeSession({
      getCurrentTurn: () => (rechecking ? check.promise : null),
      resolveTurn: () => {
        calls += 1;
      },
    }),
  );
  rechecking = true;
  const resolve = recovery.resolve('1', 'checked', true);
  await recovery.select(null);
  check.resolve(null);
  await resolve;
  t.is(calls, 0);
});

test('older facets and corrupt journals are safely unavailable', async t => {
  let reads = 0;
  const recovery = makeFlootRecovery({ notify: () => {}, isBusy: () => false });
  await recovery.select(
    makeSession({
      __getMethodNames__: () => harden([]),
      getTurns: () => {
        reads += 1;
      },
    }),
  );
  t.is(reads, 0);
  t.is(recovery.getState().status, 'unavailable');
  await recovery.select(
    makeSession({
      getTurns: () => {
        throw Error('corrupt');
      },
    }),
  );
  t.false(recovery.getState().canResolve);
  t.regex(recovery.getState().message, /No recovery action is safe/);
  await recovery.select(makeSession({ getTurns: () => harden([null]) }));
  t.is(recovery.getState().status, 'unavailable');
});

test('double acknowledgment and refresh cannot race a pending resolution', async t => {
  t.timeout(2000);
  const pending = makePromiseKit();
  const entered = makePromiseKit();
  let calls = 0;
  const recovery = makeFlootRecovery({ notify: () => {}, isBusy: () => false });
  await recovery.select(
    makeSession({
      resolveTurn: () => {
        calls += 1;
        entered.resolve(undefined);
        return pending.promise;
      },
    }),
  );
  const first = recovery.resolve('1', 'checked', true);
  await entered.promise;
  t.true(recovery.getState().resolving);
  t.false(recovery.getState().canResolve);
  await recovery.refresh();
  await recovery.resolve('1', 'double click', true);
  t.is(calls, 1);
  pending.resolve(undefined);
  await first;
  t.false(recovery.getState().resolving);
});

test('pending and completed records cannot be acknowledged', async t => {
  let calls = 0;
  const recovery = makeFlootRecovery({ notify: () => {}, isBusy: () => false });
  for (const state of ['pending', 'completed', 'failed', 'cancelled']) {
    // eslint-disable-next-line no-await-in-loop
    await recovery.select(
      makeSession({
        getTurns: () => harden([{ ...unknownTurn, state }]),
        resolveTurn: () => {
          calls += 1;
        },
      }),
    );
    // eslint-disable-next-line no-await-in-loop
    await recovery.resolve('1', 'checked', true);
  }
  t.is(calls, 0);
});
