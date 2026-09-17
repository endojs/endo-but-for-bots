// @ts-check
import '@endo/init';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeHostedSessionSupervisor } from '../src/session-supervisor.js';

const makePromiseKit = () => {
  /** @type {(value: undefined) => void} */
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve: value => resolve(value) };
};

const plan = harden({
  sandboxSessionId: 'session-a',
  workspaceMountPoint: '/private/a/workspace',
  mounterSocketDir: '/private/a/9p',
});
const resolver = Far('Resolver', {});
const readPlan = () => plan;

test('a hung client cannot delay revocation, sandbox closure, or MCP admission closure', async t => {
  t.timeout(3000);
  const clientStop = makePromiseKit();
  const revoked = makePromiseKit();
  const sandboxStopped = makePromiseKit();
  const mcpClosed = makePromiseKit();
  let unmounted = false;
  const supervisor = makeHostedSessionSupervisor({
    name: 'Test',
    readPlan,
    start: async (_plan, _resolver, { own }) => {
      own('broker', Far('Grant', { revoke: () => revoked.resolve(undefined) }));
      own(
        'sandbox',
        Far('Scope', { close: () => sandboxStopped.resolve(undefined) }),
      );
      own('mcp', harden({ close: async () => mcpClosed.resolve(undefined) }));
      own(
        'mounter',
        harden({
          close: async () => {
            unmounted = true;
          },
        }),
      );
      return Far('Client', {
        terminate: () => clientStop.promise,
        send: async () => undefined,
        interrupt: async () => undefined,
        status: async () => harden({}),
      });
    },
  });
  await E(supervisor).activate('plan', resolver);
  const stopping = E(supervisor).terminate('plan', resolver);
  t.teardown(async () => {
    clientStop.resolve(undefined);
    await stopping;
  });
  await Promise.all([
    revoked.promise,
    sandboxStopped.promise,
    mcpClosed.promise,
  ]);
  t.like(await E(supervisor).status(), { stopping: true, stopped: false });
  await t.throwsAsync(E(supervisor).send('not admitted'), {
    message: /stopping/,
  });
  clientStop.resolve(undefined);
  await stopping;
  t.true(unmounted);
  t.like(await E(supervisor).status(), { stopped: true });
});

test('failed revocation can retry while client termination is still pending', async t => {
  t.timeout(3000);
  const clientStop = makePromiseKit();
  const failedRevoke = makePromiseKit();
  const revoked = makePromiseKit();
  let attempts = 0;
  const supervisor = makeHostedSessionSupervisor({
    name: 'Test',
    readPlan,
    start: async (_plan, _resolver, { own }) => {
      own(
        'broker',
        Far('Grant', {
          async revoke() {
            attempts += 1;
            if (attempts === 1) {
              failedRevoke.resolve(undefined);
              throw Error('transient revocation failure');
            }
            revoked.resolve(undefined);
          },
        }),
      );
      return Far('Client', {
        terminate: () => clientStop.promise,
        send: async () => undefined,
        interrupt: async () => undefined,
        status: async () => harden({}),
      });
    },
  });
  await E(supervisor).activate('plan', resolver);
  const first = E(supervisor).terminate('plan', resolver);
  t.teardown(async () => {
    clientStop.resolve(undefined);
    await first;
  });
  await failedRevoke.promise;
  // Cross an eventual-send boundary so the failed release is observed.
  await E(supervisor).status();
  const second = E(supervisor).terminate('plan', resolver);
  await revoked.promise;
  t.is(attempts, 2, 'retry reached the grant without waiting for the client');
  t.like(await E(supervisor).status(), { stopped: false });
  clientStop.resolve(undefined);
  await Promise.all([first, second]);
  t.like(await E(supervisor).status(), { stopped: true });
});

test('failed release remains owned, successful releases are not repeated on retry', async t => {
  let refuse = true;
  let revocations = 0;
  let closures = 0;
  let unmounts = 0;
  const supervisor = makeHostedSessionSupervisor({
    name: 'Test',
    readPlan,
    start: async (_plan, _resolver, { own }) => {
      own(
        'broker',
        Far('Grant', {
          revoke: () => {
            revocations += 1;
          },
        }),
      );
      own(
        'sandbox',
        Far('Scope', {
          close: () => {
            closures += 1;
            if (refuse) throw Error('not reaped');
          },
        }),
      );
      own(
        'mounter',
        harden({
          close: async () => {
            unmounts += 1;
          },
        }),
      );
      return Far('Client', {
        terminate: async () => undefined,
        send: async () => undefined,
        interrupt: async () => undefined,
        status: async () => harden({}),
      });
    },
  });
  t.teardown(async () => {
    refuse = false;
    await E(supervisor).terminate('plan', resolver);
  });
  await E(supervisor).activate('plan', resolver);
  await t.throwsAsync(E(supervisor).terminate('plan', resolver), {
    message: /cleanup pending/,
  });
  t.is(closures, 1, 'one attempt, not an implicit retry');
  t.is(unmounts, 0, 'storage remains mounted until reaping succeeds');
  t.is(revocations, 1, 'independent authority has already been withdrawn');
  refuse = false;
  await E(supervisor).terminate('plan', resolver);
  t.is(closures, 2);
  t.is(unmounts, 1);
  t.is(revocations, 1);
});

test('a client arriving after stop stays owned until its release acknowledges', async t => {
  t.timeout(3000);
  const entered = makePromiseKit();
  const acquired = makePromiseKit();
  const released = makePromiseKit();
  const releaseAllowed = makePromiseKit();
  const supervisor = makeHostedSessionSupervisor({
    name: 'Test',
    readPlan,
    start: async () => {
      entered.resolve(undefined);
      await acquired.promise;
      return Far('LateClient', {
        terminate: async () => {
          released.resolve(undefined);
          await releaseAllowed.promise;
        },
        send: async () => undefined,
        interrupt: async () => undefined,
        status: async () => harden({}),
      });
    },
  });
  const activation = t.throwsAsync(E(supervisor).activate('plan', resolver), {
    message: /stopping/,
  });
  await entered.promise;
  const stopping = E(supervisor).terminate('plan', resolver);
  t.teardown(async () => {
    acquired.resolve(undefined);
    releaseAllowed.resolve(undefined);
    await stopping;
  });
  // Observing the fence makes the acquisition/stop order deterministic.
  t.like(await E(supervisor).status(), { stopping: true, stopped: false });
  acquired.resolve(undefined);
  await released.promise;
  await activation;
  t.like(await E(supervisor).status(), { stopped: false });
  releaseAllowed.resolve(undefined);
  await stopping;
  t.like(await E(supervisor).status(), { stopped: true });
});
