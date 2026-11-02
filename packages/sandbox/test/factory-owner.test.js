// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSandboxFactoryKit } from '../src/factory.js';

const opts = harden({ rootfs: { kind: 'host-bind' } });

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ prepare?: (index: number) => Promise<unknown>, prepareKit?: () => { value: Promise<unknown>, close(): Promise<void> }, probe?: () => Promise<void>, teardown?: () => Promise<void>, context?: any }} [options]
 */
const fixture = (t, options = {}) => {
  let prepared = 0;
  const removed = [];
  const failures = new Set();
  const kit = makeSandboxFactoryKit({
    drivers: [
      {
        name: 'bwrap',
        ...(options.prepareKit ? { prepareSliceKit: options.prepareKit } : {}),
        probe: async () => {
          await options.probe?.();
          return {
            available: true,
            details: { lifecycle: { available: true } },
          };
        },
        prepareSlice: async () => {
          prepared += 1;
          return options.prepare ? options.prepare(prepared) : { id: prepared };
        },
        spawn: async () => {
          throw Error('must not spawn');
        },
        teardown: async slice => {
          if (failures.has(slice)) throw Error('removal failed');
          await options.teardown?.();
          removed.push(slice);
        },
      },
    ],
    scratchProvider: /** @type {any} */ ({
      provideScratchMount: async () => {
        throw Error('no scratch');
      },
    }),
    context: options.context,
  });
  t.teardown(async () => {
    failures.clear();
    await kit.close();
  });
  return { ...kit, failures, removed, prepared: () => prepared };
};

test('host close is separate from public authority, fences admission, and caches success', async t => {
  const f = fixture(t);
  const handle = await E(f.factory).make(opts);
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (f.factory)).__getMethodNames__();
  t.false(methods.includes('close'));
  const closing = f.close();
  t.is(f.close(), closing);
  await t.throwsAsync(E(f.factory).make(opts), {
    message: /owner has been cancelled/,
  });
  await t.throwsAsync(E(handle).spawn(['/bin/true']), { message: /disposed/ });
  await closing;
  t.is(f.removed.length, 1);
  t.is(f.close(), closing);
});

test('close waits for a pending prepare and removes its late context', async t => {
  t.timeout(3000);
  const started = makePromiseKit();
  const gate = makePromiseKit();
  const slice = {};
  const f = fixture(t, {
    prepare: async () => {
      started.resolve(undefined);
      return gate.promise;
    },
  });
  t.teardown(() => gate.resolve(slice));
  const making = E(f.factory).make(opts);
  const rejected = t.throwsAsync(making, {
    message: /owner has been cancelled/,
  });
  await started.promise;
  let closed = false;
  const closing = f.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  gate.resolve(slice);
  await rejected;
  await closing;
  t.deepEqual(f.removed, [slice]);
});

test('close stops existing handles while an unrelated prepare is still pending', async t => {
  t.timeout(3000);
  const gate = makePromiseKit();
  const started = makePromiseKit();
  const first = {};
  const second = {};
  const f = fixture(t, {
    prepare: async index => {
      if (index === 1) return first;
      started.resolve(undefined);
      return gate.promise;
    },
  });
  t.teardown(() => gate.resolve(second));
  const handle = await E(f.factory).make(opts);
  const making = E(f.factory).make(opts);
  const rejected = t.throwsAsync(making, {
    message: /owner has been cancelled/,
  });
  await started.promise;
  const closing = f.close();
  await t.throwsAsync(E(handle).spawn(['/bin/true']), { message: /disposed/ });
  t.deepEqual(f.removed, [first]);
  gate.resolve(second);
  await rejected;
  await closing;
  t.deepEqual(f.removed, [first, second]);
});

test('failed late-context cleanup remains owned for a subsequent host close', async t => {
  t.timeout(3000);
  const gate = makePromiseKit();
  const started = makePromiseKit();
  const slice = {};
  const f = fixture(t, {
    prepare: async () => {
      started.resolve(undefined);
      return gate.promise;
    },
  });
  t.teardown(() => gate.resolve(slice));
  f.failures.add(slice);
  const rejected = t.throwsAsync(E(f.factory).make(opts), {
    message: /construction cleanup pending/,
  });
  await started.promise;
  const stopped = t.throwsAsync(f.close(), {
    message: /factory shutdown pending/,
  });
  gate.resolve(slice);
  await rejected;
  await stopped;
  t.deepEqual(f.removed, []);
  f.failures.clear();
  await f.close();
  t.deepEqual(f.removed, [slice]);
});

test('failure after driver preparation releases the context and retains failed cleanup', async t => {
  const slice = {
    get runtimeDetails() {
      throw Error('broken runtime report');
    },
  };
  const f = fixture(t, { prepare: async () => slice });
  f.failures.add(slice);
  await t.throwsAsync(E(f.factory).make(opts), {
    message: /construction cleanup pending/,
  });
  f.failures.clear();
  await f.close();
  t.is(f.removed[0], slice);
});

test('close during probing drains the acquisition without starting driver preparation', async t => {
  t.timeout(3000);
  const gate = makePromiseKit();
  const started = makePromiseKit();
  const f = fixture(t, {
    probe: async () => {
      started.resolve(undefined);
      await gate.promise;
    },
  });
  t.teardown(() => gate.resolve(undefined));
  const rejected = t.throwsAsync(E(f.factory).make(opts), {
    message: /owner has been cancelled/,
  });
  await started.promise;
  const closing = f.close();
  gate.resolve(undefined);
  await rejected;
  await closing;
  t.is(f.prepared(), 0);
});

test('close drains public backend probes and fences subsequent probes', async t => {
  t.timeout(3000);
  const gate = makePromiseKit();
  const started = makePromiseKit();
  const f = fixture(t, {
    probe: async () => {
      started.resolve(undefined);
      await gate.promise;
    },
  });
  t.teardown(() => gate.resolve(undefined));
  const rejected = t.throwsAsync(E(f.factory).listBackends(), {
    message: /owner has been cancelled/,
  });
  await started.promise;
  let closed = false;
  const closing = f.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  gate.resolve(undefined);
  await rejected;
  await closing;
  await t.throwsAsync(E(f.factory).listBackends(), {
    message: /owner has been cancelled/,
  });
});

test('context cancellation uses retained host cleanup and does not strand a sibling', async t => {
  t.timeout(3000);
  const lost = makePromiseKit();
  const first = {};
  const second = {};
  const f = fixture(t, {
    prepare: async index => (index === 1 ? first : second),
    context: harden({ whenCancelled: () => lost.promise }),
  });
  await E(f.factory).make(opts);
  await E(f.factory).make(opts);
  f.failures.add(first);
  lost.reject(Error('owner disconnected'));
  // Deliver the eventual context rejection and its automatic close attempt.
  await new Promise(resolve => setImmediate(resolve));
  await t.throwsAsync(f.close(), { message: /factory shutdown pending/ });
  t.deepEqual(f.removed, [second]);
  f.failures.clear();
  await f.close();
  t.deepEqual(f.removed, [second, first]);
});

test('public disposal and host close share the same teardown attempt', async t => {
  t.timeout(3000);
  const started = makePromiseKit();
  const gate = makePromiseKit();
  let attempts = 0;
  const f = fixture(t, {
    teardown: async () => {
      attempts += 1;
      started.resolve(undefined);
      await gate.promise;
    },
  });
  t.teardown(() => gate.resolve(undefined));
  const handle = await E(f.factory).make(opts);
  const disposing = E(handle).dispose();
  await started.promise;
  const closing = f.close();
  gate.resolve(undefined);
  await Promise.all([disposing, closing]);
  t.is(attempts, 1);
  t.is(f.removed.length, 1);
});

test('factory close retains and fences a driver preparation before awaiting its value', async t => {
  t.timeout(3000);
  const entered = makePromiseKit();
  const value = makePromiseKit();
  let closeCalls = 0;
  const f = fixture(t, {
    prepareKit: () => {
      entered.resolve(undefined);
      return {
        value: value.promise,
        close: async () => {
          closeCalls += 1;
          value.reject(Error('preparation cancelled'));
        },
      };
    },
  });
  t.teardown(() => value.reject(Error('test teardown')));
  const making = E(f.factory).make(opts);
  const rejected = t.throwsAsync(making, { message: /preparation cancelled/ });
  await entered.promise;
  await f.close();
  await rejected;
  t.is(closeCalls, 1);
  t.deepEqual(f.removed, []);
});
