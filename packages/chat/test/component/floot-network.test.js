// @ts-check

import '@endo/init/debug.js';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import test from 'ava';

import { makeFlootNetwork } from '../../floot-network.js';

const policy = harden({
  policy: 'off',
  supportedPolicies: ['off', 'public-internet'],
  applies: 'next-turn',
  request: {
    id: 'request-1',
    policy: 'public-internet',
    reason: 'Fetch documentation',
  },
});
const makeSession = (overrides = {}) =>
  Far('NetworkSession', {
    __getMethodNames__: () =>
      harden([
        'getNetworkPolicy',
        'getCurrentTurn',
        'setNetworkPolicy',
        'resolveNetworkPolicyRequest',
      ]),
    getNetworkPolicy: () => policy,
    getCurrentTurn: () => null,
    setNetworkPolicy: () => undefined,
    resolveNetworkPolicyRequest: () => undefined,
    ...overrides,
  });

test('network setters require supported policy and idle operator admission', async t => {
  let busy = false;
  const calls = [];
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => busy });
  await network.select(
    makeSession({
      setNetworkPolicy: value => {
        calls.push(value);
      },
    }),
  );
  await network.set('unrestricted');
  busy = true;
  await network.set('public-internet');
  t.deepEqual(calls, []);
  busy = false;
  await network.set('public-internet');
  t.deepEqual(calls, ['public-internet']);
});

test('request decisions require exact ID and bounded nonempty operator note', async t => {
  const calls = [];
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => false });
  await network.select(
    makeSession({
      resolveNetworkPolicyRequest: (...args) => {
        calls.push(args);
      },
    }),
  );
  await network.resolve('old-request', true, 'Reviewed');
  await network.resolve('request-1', true, ' ');
  await network.resolve('request-1', false, 'x'.repeat(8193));
  t.deepEqual(calls, []);
  await network.resolve('request-1', false, ' Not necessary ');
  t.deepEqual(calls, [['request-1', false, 'Not necessary']]);
});

test('remote active-turn recheck refuses policy changes and requires refresh', async t => {
  let current = null;
  let calls = 0;
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => false });
  await network.select(
    makeSession({
      getCurrentTurn: () => current,
      setNetworkPolicy: () => {
        calls += 1;
      },
    }),
  );
  current = true;
  await network.set('public-internet');
  t.is(calls, 0);
  t.false(network.getState().canSet);
  t.regex(network.getState().message, /turn is active/);
});

test('late selected-session reads and not-yet-dispatched decisions are fenced', async t => {
  t.timeout(2000);
  const read = makePromiseKit();
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => false });
  const loading = network.select(
    makeSession({ getNetworkPolicy: () => read.promise }),
  );
  await network.select(null, 'Unavailable session');
  read.resolve(policy);
  await loading;
  t.is(network.getState().message, 'Unavailable session');
  const pending = makePromiseKit();
  let checking = false;
  let calls = 0;
  await network.select(
    makeSession({
      getCurrentTurn: () => (checking ? pending.promise : null),
      setNetworkPolicy: () => {
        calls += 1;
      },
    }),
  );
  checking = true;
  const changing = network.set('public-internet');
  await network.select(null);
  pending.resolve(null);
  await changing;
  t.is(calls, 0);
});

test('unknown and unsupported backends never advertise enforced Off', async t => {
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => false });
  await network.select(makeSession({ __getMethodNames__: () => harden([]) }));
  t.is(network.getState().policy, null);
  t.false(network.getState().canSet);
  await network.select(
    makeSession({
      getNetworkPolicy: () =>
        harden({ policy: null, supportedPolicies: [], applies: 'next-turn' }),
    }),
  );
  t.is(network.getState().policy, null);
  t.regex(network.getState().message, /No off policy is implied/);
  await network.select(
    makeSession({
      getNetworkPolicy: () =>
        harden({
          policy: 'off',
          supportedPolicies: ['unrestricted'],
          applies: 'next-turn',
        }),
    }),
  );
  t.is(network.getState().policy, null);
});

test('duplicate decisions are blocked and backend CAS refusal is shown', async t => {
  t.timeout(2000);
  const pending = makePromiseKit();
  const entered = makePromiseKit();
  let calls = 0;
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => false });
  await network.select(
    makeSession({
      resolveNetworkPolicyRequest: () => {
        calls += 1;
        entered.resolve(undefined);
        return pending.promise;
      },
    }),
  );
  const first = network.resolve('request-1', true, 'Approved');
  await entered.promise;
  t.true(network.getState().changing);
  await network.resolve('request-1', false, 'Double click');
  t.is(calls, 1);
  pending.reject(Error('Request superseded'));
  await first;
  t.false(network.getState().changing);
  t.false(network.getState().canResolve);
  t.regex(network.getState().message, /Request superseded/);
});

test('incomplete policy transition permits only explicit retry of the pending policy', async t => {
  const calls = [];
  const decisions = [];
  const network = makeFlootNetwork({ notify: () => {}, isBusy: () => false });
  await network.select(
    makeSession({
      getNetworkPolicy: () =>
        harden({
          ...policy,
          policy: null,
          pendingPolicy: 'off',
          error: 'Sandbox stop incomplete',
        }),
      setNetworkPolicy: value => {
        calls.push(value);
      },
      resolveNetworkPolicyRequest: (...args) => {
        decisions.push(args);
      },
    }),
  );
  t.is(network.getState().policy, null);
  t.true(network.getState().canSet);
  t.false(network.getState().canResolve);
  t.regex(network.getState().message, /stop incomplete/);
  await network.set('public-internet');
  await network.resolve('request-1', false, 'deny');
  t.deepEqual(calls, []);
  t.deepEqual(decisions, []);
  await network.set('off');
  t.deepEqual(calls, ['off']);
});
