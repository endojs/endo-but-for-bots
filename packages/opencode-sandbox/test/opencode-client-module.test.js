// @ts-check
import '@endo/init';
import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { make } from '../src/opencode-client-module.js';

const deferred = () => {
  /** @type {(value?: any) => void} */
  let resolve = () => {};
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve };
};

/** @param {Record<string, (...args: any[]) => any>} [overrides] */
const fixture = (overrides = {}) => {
  /** @type {string[]} */
  const calls = [];
  const invoke = async name => {
    calls.push(name);
    return overrides[name]?.();
  };
  const slice = harden({
    async spawn() {
      throw Error('Bridge intentionally unavailable');
    },
    dispose: () => invoke('dispose'),
  });
  const mount = harden({ unmount: () => invoke('unmount') });
  const credentials = harden({
    __getMethodNames__: () => ['kind'],
    kind: () => 'apiKey',
    async issue() {
      await invoke('issue');
      return harden({ materialise: () => 'test-credential' });
    },
    revoke: () => invoke('revoke'),
  });
  const sessionPowers = harden({
    sandboxFactory: () =>
      harden({
        async make() {
          await invoke('make');
          return slice;
        },
      }),
    fsMounter: () =>
      harden({
        async mount() {
          await invoke('mount');
          return mount;
        },
      }),
    stateProvider: () =>
      harden({
        async provideSessionMount() {
          await invoke('state');
          return harden({});
        },
        removeSession: () => invoke('remove-state'),
      }),
    filesystem: () => harden({}),
    credentials: () => credentials,
    provideMount: async () => {
      await invoke('name');
      return harden({});
    },
    removeMount: () => invoke('remove-names'),
  });
  // The local fake implements the remote powers interface without a FarRef brand.
  const powers = /** @type {Parameters<typeof make>[0]} */ (
    /** @type {unknown} */ (sessionPowers)
  );
  const client = make(powers, undefined, {
    env: {
      SESSION_ID: 'session-a',
      WORKSPACE_MOUNT_POINT: '/workspace-mount',
      OPENCODE_ROOTFS: 'oci:test',
    },
  });
  return {
    client,
    calls,
    count: name => calls.filter(call => call === name).length,
  };
};

/** @param {ReturnType<typeof fixture>['client']} client */
const attempt = async client => {
  const reader = await client.send('test');
  for await (const event of iterateReader(reader)) {
    if (event.type === 'end' || event.type === 'abort') return;
  }
};

test('failed partial rollback is retained before another provision attempt', async t => {
  t.timeout(2000);
  let failures = 2;
  let stateFails = true;
  const f = fixture({
    unmount: () => {
      if (failures > 0) {
        failures -= 1;
        throw Error('Mount still busy');
      }
    },
    state: () => {
      if (stateFails) {
        stateFails = false;
        throw Error('State unavailable');
      }
    },
  });
  t.teardown(() => f.client.terminate());
  await attempt(f.client);
  t.is(f.count('unmount'), 1);
  t.is(f.count('revoke'), 1);
  t.is(f.count('remove-names'), 0);
  await attempt(f.client);
  t.is(f.count('unmount'), 2);
  t.is(f.count('mount'), 1, 'failed rollback forbids replacement acquisition');
  t.is(f.count('issue'), 1);
  await attempt(f.client);
  t.is(f.count('mount'), 2);
  t.is(f.count('make'), 1);
  await f.client.terminate();
  t.is(f.count('dispose'), 1);
  t.is(f.count('revoke'), 2, 'successful earlier revocation is not repeated');
});

test('slice disposal gates mounts and names while independent revocation proceeds', async t => {
  let fail = true;
  const f = fixture({
    dispose: () => {
      if (fail) throw Error('Container removal not proved');
    },
  });
  t.teardown(() => {
    fail = false;
    return f.client.terminate();
  });
  await attempt(f.client);
  await t.throwsAsync(() => f.client.terminate(), {
    instanceOf: AggregateError,
  });
  t.is(f.count('unmount'), 0);
  t.is(f.count('remove-names'), 0);
  t.is(f.count('revoke'), 1);
  fail = false;
  await f.client.terminate();
  t.is(f.count('unmount'), 1);
  t.is(f.count('remove-names'), 1);
  t.is(f.count('revoke'), 1);
});

test('settled mount-name failures remain retryable without repeating released resources', async t => {
  let fail = true;
  const f = fixture({
    'remove-names': () =>
      harden([
        fail
          ? { status: 'rejected', reason: Error('Name removal failed') }
          : { status: 'fulfilled', value: undefined },
      ]),
  });
  t.teardown(() => {
    fail = false;
    return f.client.terminate();
  });
  await attempt(f.client);
  await t.throwsAsync(() => f.client.terminate(), {
    instanceOf: AggregateError,
  });
  fail = false;
  await f.client.terminate();
  t.is(f.count('remove-names'), 2);
  t.is(f.count('dispose'), 1);
  t.is(f.count('unmount'), 1);
  t.is(f.count('revoke'), 1);
});

test('failed credential revocation does not prevent containment or lose its retry', async t => {
  let fail = true;
  const f = fixture({
    revoke: () => {
      if (fail) throw Error('Credential issuer unavailable');
    },
  });
  t.teardown(() => {
    fail = false;
    return f.client.terminate();
  });
  await attempt(f.client);
  await t.throwsAsync(() => f.client.terminate(), {
    instanceOf: AggregateError,
  });
  t.is(f.count('dispose'), 1);
  t.is(f.count('unmount'), 1);
  t.is(f.count('remove-names'), 1);
  fail = false;
  await f.client.terminate();
  t.is(f.count('revoke'), 2);
  t.is(f.count('dispose'), 1);
  t.is(f.count('unmount'), 1);
});

for (const acquisition of ['mount', 'make']) {
  test(`stop owns a late successful ${acquisition} acquisition`, async t => {
    t.timeout(2000);
    const entered = deferred();
    const finish = deferred();
    const f = fixture({
      [acquisition]: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    t.teardown(() => {
      finish.resolve();
      return f.client.terminate();
    });
    const turn = attempt(f.client);
    await entered.promise;
    const first = f.client.terminate();
    const second = f.client.terminate();
    finish.resolve();
    await Promise.all([first, second, turn]);
    t.is(f.count('unmount'), 1);
    t.is(f.count('revoke'), 1);
    t.is(f.count('dispose'), acquisition === 'make' ? 1 : 0);
    t.is(f.count('make'), acquisition === 'make' ? 1 : 0);
    await t.throwsAsync(() => f.client.send('after stop'), {
      message: /terminated/,
    });
  });

  test(`rejected ${acquisition} acquisition retains unknown effects`, async t => {
    const f = fixture({
      [acquisition]: () => {
        throw Error('Acquisition interrupted');
      },
    });
    // The fake acquisition creates no external resources; production uncertainty
    // deliberately cannot be cleared without a host reconciliation capability.
    t.teardown(() => f.client.terminate().catch(() => undefined));
    await attempt(f.client);
    await attempt(f.client);
    t.is(
      f.count(acquisition),
      1,
      'unknown predecessor blocks a new acquisition',
    );
    await t.throwsAsync(() => f.client.terminate(), {
      instanceOf: AggregateError,
    });
    await t.throwsAsync(() => f.client.destroy(), {
      instanceOf: AggregateError,
    });
    t.is(f.count('unmount'), 0);
    t.is(f.count('remove-names'), 0);
    t.is(f.count('remove-state'), 0);
    t.is(f.count('revoke'), 1);
  });
}
