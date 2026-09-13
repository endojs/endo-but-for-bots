// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import {
  makeOwnedSandboxAgent,
  makeOwnedNativeSandboxAgent,
} from '../src/owned-agent.js';
import { readRuntimeConfig } from '../src/runtime-config.js';
import { makeSandboxRuntime } from '../src/runtime.js';

/** @import { SandboxFactory, SandboxPowers } from '../src/types.js' */
/** @import { ExecutionContext } from 'ava' */
/** @import { PromiseKit } from '@endo/promise-kit' */

const env = harden({
  ENDO_SANDBOX_RUNTIME_DIR: '/private/runtime',
  ENDO_SANDBOX_OWNER_ID: 'operator-owner',
  ENDO_SANDBOX_GENERATED_MAX_BYTES: '9007199254740993',
  ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
});
const powers = /** @type {SandboxPowers} */ (
  /** @type {unknown} */ (harden({}))
);

/** @param {ExecutionContext} t */
const fixture = t => {
  /** @type {unknown[]} */
  const errors = [];
  /** @type {Array<ReturnType<typeof makePromiseKit>>} */
  const contexts = [];
  const next = () => ({
    opened: makePromiseKit(),
    closed: makePromiseKit(),
    openGate: makePromiseKit(),
    closeGate: makePromiseKit(),
    holdOpen: false,
    holdClose: false,
    openFault: false,
    closeFault: false,
    closeSyncFault: false,
    closes: 0,
    factory: /** @type {Awaited<SandboxFactory>} */ (
      /** @type {unknown} */ (harden({ help: () => 'test factory' }))
    ),
  });
  let prepared = next();
  /** @type {Array<ReturnType<typeof next>>} */
  const runtimes = [];
  const make = makeOwnedSandboxAgent({
    reportError: error => errors.push(error),
    makeRuntime: (config, runtimePowers) => {
      t.is(config.maxBytes, 9_007_199_254_740_993n);
      t.is(config.env?.ENDO_SANDBOX_OWNER_ID, config.ownerId);
      t.is(runtimePowers.scratchProvider, powers);
      const state = prepared;
      prepared = next();
      runtimes.push(state);
      return harden({
        openNative: async () => {
          throw Error('Unexpected native service selection');
        },
        open: async () => {
          await null;
          state.opened.resolve(undefined);
          if (state.holdOpen) await state.openGate.promise;
          if (state.openFault) throw Error('open failed');
          return state.factory;
        },
        close: () => {
          state.closes += 1;
          state.closed.resolve(undefined);
          if (state.closeSyncFault) throw Error('close threw');
          return (async () => {
            await null;
            if (state.holdClose) await state.closeGate.promise;
            if (state.closeFault) throw Error('close failed');
          })();
        },
      });
    },
  });
  const context = () => {
    const token = makePromiseKit();
    contexts.push(token);
    return {
      token,
      cap: harden({
        whenCancelled: () => /** @type {Promise<never>} */ (token.promise),
      }),
    };
  };
  /**
   * @param {ReturnType<typeof context>} owner
   * @param {string} [ownerId]
   */
  const start = (owner, ownerId = env.ENDO_SANDBOX_OWNER_ID) =>
    make(powers, owner.cap, {
      env: { ...env, ENDO_SANDBOX_OWNER_ID: ownerId },
    });
  t.teardown(async () => {
    for (const state of [...runtimes, prepared]) {
      state.closeFault = false;
      state.closeSyncFault = false;
      state.openGate.resolve(undefined);
      state.closeGate.resolve(undefined);
    }
    for (const token of contexts) token.reject(Error('test finished'));
    await setImmediate();
  });
  return { make, start, context, runtimes, errors, next: () => prepared };
};

test('runtime formula budgets are explicit decimal bigint quantities', t => {
  t.deepEqual(readRuntimeConfig(env), {
    directory: '/private/runtime',
    ownerId: 'operator-owner',
    maxBytes: 9_007_199_254_740_993n,
    maxEntries: 16n,
  });
  t.is(
    readRuntimeConfig({ ...env, ENDO_SANDBOX_GENERATED_MAX_BYTES: '0' })
      .maxBytes,
    0n,
  );
  for (const key of Object.keys(env)) {
    t.throws(() => readRuntimeConfig({ ...env, [key]: undefined }), {
      message: /Missing runtime configuration/,
    });
  }
  for (const value of ['-1', '1.5', '1e3', ' 1', '01', '+1']) {
    t.throws(
      () =>
        readRuntimeConfig({ ...env, ENDO_SANDBOX_GENERATED_MAX_BYTES: value }),
      {
        message: /decimal natural number/,
      },
    );
  }
  t.throws(
    () =>
      readRuntimeConfig({ ...env, ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '0' }),
    {
      message: /must be positive/,
    },
  );
});

test('a refused duplicate and its cancellation cannot stop a live owner', async t => {
  const f = fixture(t);
  const first = f.context();
  const duplicate = f.context();
  const factory = await f.start(first);
  t.is(factory, f.runtimes[0].factory);
  await t.throwsAsync(f.start(duplicate), { message: /already live/ });
  duplicate.token.reject(Error('duplicate cancelled'));
  await setImmediate();
  t.is(f.runtimes.length, 1);
  t.is(f.runtimes[0].closes, 0);
});

test('cancellation fences pending open immediately and refuses late publication', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const state = f.next();
  state.holdOpen = true;
  state.holdClose = true;
  const owner = f.context();
  const failure = t.throwsAsync(f.start(owner), {
    message: /cancelled or unreachable/,
  });
  await state.opened.promise;
  owner.token.reject(Error('interrupt owner'));
  await state.closed.promise;
  t.is(state.closes, 1, 'close ran before open completed');
  state.openGate.resolve(undefined);
  state.closeGate.resolve(undefined);
  await failure;
  const successor = await f.start(f.context());
  t.is(successor, f.runtimes[1].factory);
});

test('a queued cancelled caller acquires nothing and does not stop its predecessor', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const state = f.next();
  state.holdOpen = true;
  const opening = f.start(f.context());
  await state.opened.promise;
  const queued = f.context();
  const failure = t.throwsAsync(f.start(queued), {
    message: /cancelled or unreachable/,
  });
  queued.token.reject(undefined);
  await setImmediate();
  state.openGate.resolve(undefined);
  await opening;
  await failure;
  t.is(f.runtimes.length, 1);
  t.is(state.closes, 0);
});

test('failed automatic cleanup is retried before one of two reconstructions can open', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const state = f.next();
  state.closeFault = true;
  const owner = f.context();
  await f.start(owner);
  owner.token.reject(Error('cancel'));
  await setImmediate();
  t.is(state.closes, 1);
  t.is(f.errors.length, 1);
  await t.throwsAsync(f.start(f.context()), { message: /close failed/ });
  t.is(f.runtimes.length, 1);
  state.closeFault = false;
  state.holdClose = true;
  const successor = f.start(f.context());
  const refused = t.throwsAsync(f.start(f.context()), {
    message: /already live/,
  });
  await setImmediate();
  t.is(f.runtimes.length, 1);
  state.closeGate.resolve(undefined);
  await successor;
  await refused;
  t.is(f.runtimes.length, 2);
  t.is(state.closes, 3);
});

test('failed open and cleanup preserve both errors and retry authority', async t => {
  const f = fixture(t);
  const state = f.next();
  state.openFault = true;
  state.closeSyncFault = true;
  const failure = await t.throwsAsync(f.start(f.context()), {
    instanceOf: AggregateError,
    message: /construction failed; cleanup pending/,
  });
  t.regex(String(failure?.errors[0]), /open failed/);
  t.regex(String(failure?.errors[1]), /close threw/);
  state.closeSyncFault = false;
  await f.start(f.context());
  t.is(state.closes, 2);
});

test('old cancellation after failed construction cannot affect its successor', async t => {
  const f = fixture(t);
  const state = f.next();
  state.openFault = true;
  const old = f.context();
  await t.throwsAsync(f.start(old), { message: /open failed/ });
  await f.start(f.context());
  old.token.reject(Error('old cancellation arrived'));
  await setImmediate();
  t.is(state.closes, 1);
  t.is(f.runtimes[1].closes, 0);
  await t.throwsAsync(f.start(f.context()), { message: /already live/ });
});

test('successful predecessor retry forgets its old failure before delayed cancellation', async t => {
  const f = fixture(t);
  const state = f.next();
  state.openFault = true;
  state.closeFault = true;
  const old = f.context();
  await t.throwsAsync(f.start(old), {
    message: /construction failed; cleanup pending/,
  });
  state.closeFault = false;
  await f.start(f.context());
  old.token.reject(Error('old context finished'));
  await setImmediate();
  t.is(state.closes, 2);
  t.is(f.runtimes[1].closes, 0);
  t.deepEqual(f.errors, []);
});

test('cancellation can abandon unresolved daemon powers without blocking a successor', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const owner = f.context();
  const pendingPowers = /** @type {PromiseKit<SandboxPowers>} */ (
    makePromiseKit()
  );
  const failure = t.throwsAsync(
    f.make(pendingPowers.promise, owner.cap, { env }),
    {
      message: /cancelled or unreachable/,
    },
  );
  await setImmediate();
  owner.token.reject(Error('cancel'));
  await failure;
  t.is(f.runtimes.length, 0);
  await f.start(f.context());
  pendingPowers.resolve(powers);
  await setImmediate();
  t.is(f.runtimes.length, 1);
});

test('lost or fulfilled cancellation observation closes a published runtime', async t => {
  const f = fixture(t);
  const disconnected = f.context();
  await f.start(disconnected);
  disconnected.token.reject(undefined);
  await setImmediate();
  t.is(f.runtimes[0].closes, 1);
  const fulfilled = f.context();
  await f.start(fulfilled);
  fulfilled.token.resolve(undefined);
  await setImmediate();
  t.is(f.runtimes[1].closes, 1);
});

test('one blocked owner does not serialize another owner', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const state = f.next();
  state.holdOpen = true;
  const first = f.start(f.context());
  await state.opened.promise;
  await f.start(f.context(), 'independent-owner');
  t.is(f.runtimes.length, 2);
  state.openGate.resolve(undefined);
  await first;
});

test('independent entrypoint registries remain excluded by actual runtime ownership', async t => {
  t.timeout(5000);
  const directory = await fs.mkdtemp(join(tmpdir(), 'endo-owned-agent-'));
  /** @type {Array<ReturnType<typeof makeSandboxRuntime>>} */
  const runtimes = [];
  /** @type {Array<ReturnType<typeof makePromiseKit>>} */
  const tokens = [];
  /** @type {unknown[]} */
  const errors = [];
  t.teardown(async () => {
    for (const token of tokens) token.reject(Error('test finished'));
    await setImmediate();
    await Promise.all(runtimes.map(runtime => runtime.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const instance = () =>
    makeOwnedSandboxAgent({
      reportError: error => errors.push(error),
      makeRuntime: (config, runtimePowers) => {
        const runtime = makeSandboxRuntime(config, runtimePowers);
        runtimes.push(runtime);
        return runtime;
      },
    });
  const context = () => {
    const token = makePromiseKit();
    tokens.push(token);
    return {
      token,
      cap: harden({
        whenCancelled: () => /** @type {Promise<never>} */ (token.promise),
      }),
    };
  };
  const options = { env: { ...env, ENDO_SANDBOX_RUNTIME_DIR: directory } };
  const first = instance();
  const second = instance();
  const old = context();
  await first(powers, old.cap, options);
  const marker = join(directory, `${env.ENDO_SANDBOX_OWNER_ID}.owner`);
  const oldToken = await fs.readlink(marker);
  await t.throwsAsync(second(powers, context().cap, options), {
    message: /EEXIST/,
  });
  t.is(await fs.readlink(marker), oldToken);
  old.token.reject(Error('owner cancelled'));
  await setImmediate();
  await runtimes[0].close();
  t.deepEqual(await fs.readdir(directory), []);
  await second(powers, context().cap, options);
  t.not(await fs.readlink(marker), oldToken);
  t.deepEqual(errors, []);
});

test('native operator entrypoint exposes scoped authority and retains cancellation', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'endo-native-agent-'));
  const token = makePromiseKit();
  /** @type {ReturnType<typeof makeSandboxRuntime> | undefined} */
  let retained;
  t.teardown(async () => {
    token.reject(Error('test finished'));
    await setImmediate();
    await retained?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const make = makeOwnedNativeSandboxAgent({
    makeRuntime: (config, runtimePowers) => {
      retained = makeSandboxRuntime(config, runtimePowers);
      return retained;
    },
  });
  const context = harden({
    whenCancelled: () => /** @type {Promise<never>} */ (token.promise),
  });
  const service = await make(powers, context, {
    env: { ...env, ENDO_SANDBOX_RUNTIME_DIR: directory },
  });
  const scope = await E(service).provideScope('one');
  t.is(await E(service).lookupScope('one'), scope);
  await E(scope).close();
  token.reject(Error('native operator cancelled'));
  await setImmediate();
  await retained?.close();
  await t.throwsAsync(E(service).provideScope('two'), { message: /closing/ });
  t.deepEqual(await fs.readdir(directory), []);
});
