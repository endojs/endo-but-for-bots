// @ts-check

import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeProviderBrokerServiceKit } from '@endo/hosted-agent/provider-broker-service.js';
import { setImmediate } from 'node:timers/promises';

import {
  makeOwnedOpencodeBrokerService,
  readOpencodeBrokerConfig,
} from '../src/opencode-broker-service-agent.js';

/** @import { ExecutionContext } from 'ava' */

const digest = `sha256:${'a'.repeat(64)}`;
const config = harden({
  ownerId: 'opencode-operator',
  directory: '/var/lib/endo/broker',
  imageRef: `localhost/opencode@${digest}`,
  imageDigest: digest,
  listenerImageRef: `localhost/provider@${digest}`,
  models: ['vendor/model'],
});
const env = harden({ OPENCODE_BROKER_CONFIG: JSON.stringify(config) });
const spec = harden({
  providerOrigin: 'https://openrouter.ai',
  accountRef: 'openrouter',
  model: 'vendor/model',
});
const secret = Far('OriginalSecret', { readBase64: async () => btoa('key') });

const gate = () => {
  let release = () => {};
  const promise = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  return { promise, release };
};

/** @param {ExecutionContext} t */
const fixture = t => {
  const next = () => ({
    opened: gate(),
    closing: gate(),
    openGate: gate(),
    closeGate: gate(),
    holdOpen: false,
    holdClose: false,
    failClose: false,
    opens: 0,
    closes: 0,
  });
  let prepared = next();
  /** @type {Array<ReturnType<typeof next>>} */
  const states = [];
  /** @type {Array<(reason: Error) => void>} */
  const cancellations = [];
  const errors = [];
  /** @type {Array<Record<string,string> | undefined>} */
  const environments = [];
  const make = makeOwnedOpencodeBrokerService({
    reportError: error => errors.push(error),
    makeServiceKit: options => {
      t.is(options.secret, secret);
      // The owned service hands the shared kit the OpenCode policy already
      // built from the persisted profile.
      t.deepEqual(options.policy.models, config.models);
      t.is(options.label, 'OpenCode');
      environments.push(options.env);
      const state = prepared;
      prepared = next();
      states.push(state);
      return makeProviderBrokerServiceKit({
        ...options,
        runtimeKit: {
          open: async () => {
            state.opens += 1;
            state.opened.release();
            if (state.holdOpen) await state.openGate.promise;
            return {
              startKit: () => {
                throw Error('Unexpected listener acquisition');
              },
              start: async () => {
                throw Error('Unexpected listener acquisition');
              },
              retryCleanup: async () => {},
              dispose: async () => {},
            };
          },
          close: async () => {
            state.closes += 1;
            state.closing.release();
            if (state.holdClose) await state.closeGate.promise;
            if (state.failClose) throw Error('Native cleanup failed');
          },
        },
      });
    },
  });
  const context = () => {
    /** @type {(reason: Error) => void} */
    let cancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_resolve, reject) => {
      cancel = reject;
    });
    void cancelled.catch(() => {});
    cancellations.push(cancel);
    return {
      cap: Far('OwnerContext', { whenCancelled: () => cancelled }),
      cancel,
    };
  };
  t.teardown(async () => {
    for (const state of [...states, prepared]) {
      state.failClose = false;
      state.openGate.release();
      state.closeGate.release();
    }
    for (const cancel of cancellations) cancel(Error('Test finished'));
    await setImmediate();
  });
  return { make, context, states, errors, environments, next: () => prepared };
};

test('broker configuration is explicit copy data and excludes injected authority', t => {
  t.deepEqual(readOpencodeBrokerConfig(env), config);
  t.throws(() => readOpencodeBrokerConfig({}), {
    message: /Missing OPENCODE_BROKER_CONFIG/,
  });
  t.throws(() => readOpencodeBrokerConfig({ OPENCODE_BROKER_CONFIG: '{' }), {
    instanceOf: SyntaxError,
  });
  for (const invalid of [
    null,
    {},
    { ...config, ownerId: undefined },
    { ...config, models: 'vendor/model' },
    { ...config, secret: 'namespace-name' },
    { ...config, runtime: {} },
    { ...config, fetch: 'ambient' },
    { ...config, makeIssuer: 'override' },
    { ...config, publicInternet: 'true' },
  ]) {
    t.throws(
      () =>
        readOpencodeBrokerConfig({
          OPENCODE_BROKER_CONFIG: JSON.stringify(invalid),
        }),
      { message: /Invalid OpenCode broker configuration/ },
    );
  }
  t.deepEqual(
    readOpencodeBrokerConfig({
      OPENCODE_BROKER_CONFIG: JSON.stringify({
        ...config,
        maxSessions: 3,
        publicInternet: true,
      }),
    }),
    { ...config, maxSessions: 3, publicInternet: true },
  );
});

test('broker entrypoint returns inert scopes and rejects a live duplicate without closing it', async t => {
  const f = fixture(t);
  const owner = f.context();
  const service = await f.make(secret, owner.cap, { env });
  t.is(
    f.environments[0],
    env,
    'original operator environment reaches broker kit',
  );
  const a = await E(service).provideScope('a', spec);
  t.is(await E(service).lookupScope('a'), a);
  t.is(f.states[0].opens, 0);
  const duplicate = f.context();
  await t.throwsAsync(f.make(secret, duplicate.cap, { env }), {
    message: /already live/,
  });
  duplicate.cancel(Error('Refused caller cancelled'));
  await setImmediate();
  t.is(f.states[0].closes, 0);
  owner.cancel(Error('Original owner cancelled'));
  await f.states[0].closing.promise;
  await t.throwsAsync(E(service).provideScope('b', spec), {
    message: /closed/,
  });
});

test('context cancellation reaches lazy broker opening and retains its drain', async t => {
  t.timeout(5000);
  const f = fixture(t);
  const state = f.next();
  state.holdOpen = true;
  state.holdClose = true;
  const owner = f.context();
  const service = await f.make(secret, owner.cap, { env });
  const a = await E(service).provideScope('a', spec);
  const starting = E(a).start();
  const rejected = t.throwsAsync(starting, { message: /closed/ });
  await state.opened.promise;
  owner.cancel(Error('Stop pending broker'));
  await state.closing.promise;
  t.is(state.closes, 1);
  let reconstructed = false;
  const successor = f.make(secret, f.context().cap, { env }).then(value => {
    reconstructed = true;
    return value;
  });
  await setImmediate();
  t.false(reconstructed);
  t.is(f.states.length, 1);
  state.openGate.release();
  state.closeGate.release();
  await rejected;
  await successor;
  t.is(f.states.length, 2);
});

test('failed automatic cleanup retains the original broker until reconstruction retries it', async t => {
  const f = fixture(t);
  const original = f.context();
  const state = f.next();
  state.failClose = true;
  await f.make(secret, original.cap, { env });
  original.cancel(Error('Stop operator'));
  await setImmediate();
  t.is(state.closes, 1);
  t.is(f.errors.length, 1);
  await t.throwsAsync(f.make(secret, f.context().cap, { env }), {
    message: /cleanup pending/,
  });
  t.is(f.states.length, 1);
  state.failClose = false;
  await f.make(secret, f.context().cap, { env });
  t.is(state.closes, 3);
  t.is(f.states.length, 2);
  t.is(f.states[1].closes, 0);
});

test('cancellation abandons pending secret powers without constructing a broker', async t => {
  t.timeout(5000);
  const f = fixture(t);
  /** @type {(value: typeof secret) => void} */
  let release = () => {};
  /** @type {Promise<typeof secret>} */
  const pending = new Promise(resolve => {
    release = resolve;
  });
  t.teardown(() => release(secret));
  const old = f.context();
  const starting = f.make(pending, old.cap, { env });
  const rejected = t.throwsAsync(starting, {
    message: /cancelled or unreachable/,
  });
  old.cancel(Error('Stop before secret resolves'));
  await rejected;
  t.is(f.states.length, 0);
  await f.make(secret, f.context().cap, { env });
  release(secret);
  await setImmediate();
  t.is(f.states.length, 1);
  t.is(f.states[0].closes, 0);
});

test('invalid pinned operator configuration acquires no native runtime', async t => {
  const f = fixture(t);
  const owner = f.context();
  await t.throwsAsync(
    f.make(secret, owner.cap, {
      env: {
        OPENCODE_BROKER_CONFIG: JSON.stringify({
          ...config,
          imageRef: 'localhost/opencode:mutable',
        }),
      },
    }),
    { message: /image ref must match its digest/ },
  );
  t.is(f.states[0].opens, 0);
  t.is(f.states[0].closes, 0);
  const service = await f.make(secret, f.context().cap, { env });
  owner.cancel(Error('Old invalid caller cancelled'));
  await setImmediate();
  t.is(f.states[1].closes, 0);
  t.truthy(await E(service).provideScope('a', spec));
});
