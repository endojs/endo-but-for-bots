// @ts-check

import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  OPENCODE_BROKER_ACCOUNT,
  OPENROUTER_INFERENCE_PATH,
  OPENROUTER_ORIGIN,
} from '../src/opencode-broker.js';
import { makeOpencodeBrokerServiceKit } from '../src/opencode-broker-service.js';

const digest = `sha256:${'a'.repeat(64)}`;
const model = 'deepseek/deepseek-v4.1-flash';
const spec = harden({
  providerOrigin: OPENROUTER_ORIGIN,
  accountRef: OPENCODE_BROKER_ACCOUNT,
  model,
});

const gate = () => {
  let release = () => {};
  const promise = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  return { promise, release };
};

const fixture = () => {
  const listeners = [];
  let closes = 0;
  let reads = 0;
  /** @type {(ordinal: number) => Promise<void>} */
  let onStart = async () => {};
  /** @type {(ordinal: number) => Promise<void>} */
  let onStop = async () => {};
  let onClose = async () => {};
  const runtime = {
    startKit: input => {
      const ordinal = listeners.length;
      let inactive = false;
      let released = false;
      /** @type {Promise<void> | undefined} */
      let stopping;
      const owner = { endpoint: input.endpoint, attempts: 0 };
      listeners.push(owner);
      /** @returns {Promise<void>} */
      const stop = () => {
        inactive = true;
        if (released) return Promise.resolve();
        if (stopping) return stopping;
        stopping = (async () => {
          owner.attempts += 1;
          await value.catch(() => {});
          await onStop(ordinal);
          released = true;
        })().finally(() => {
          stopping = undefined;
        });
        return stopping;
      };
      const value = (async () => {
        await onStart(ordinal);
        return harden({
          observe: async () => {
            if (inactive) throw Error('Listener is inactive');
            return harden({
              endpoint: `http://127.0.0.1:${12_000 + ordinal}`,
              containerName: `listener-${ordinal}`,
              networkNamespaceId: `net-${ordinal}`,
              listenerImageDigest: digest,
            });
          },
          stop,
          closed: new Promise(() => {}),
        });
      })();
      return harden({ value, stop });
    },
    start: input => runtime.startKit(input).value,
    retryCleanup: async () => {},
    dispose: async () => {
      closes += 1;
      await onClose();
    },
  };
  const options = {
    secret: Far('ExactOperatorSecret', {
      readBase64: async () => {
        reads += 1;
        return btoa('original-operator-secret');
      },
    }),
    ownerId: 'opencode-owner',
    directory: '/var/lib/endo/opencode-broker',
    imageRef: `localhost/opencode-sandbox@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/endo-provider@${digest}`,
    models: [model],
    fetch: async () => new Response('ok'),
    runtime,
  };
  return {
    options,
    listeners,
    closes: () => closes,
    reads: () => reads,
    onStart: action => {
      onStart = action;
    },
    onStop: action => {
      onStop = action;
    },
    onClose: action => {
      onClose = action;
    },
  };
};

const request = endpoint =>
  E(endpoint).request(
    harden({
      method: 'POST',
      path: OPENROUTER_INFERENCE_PATH,
      body: JSON.stringify({ model }),
    }),
  );

test('operator service and returned scopes are inert until explicit startup', async t => {
  const f = fixture();
  const kit = makeOpencodeBrokerServiceKit(f.options);
  t.teardown(kit.close);
  const a = await E(kit.service).provideScope('a', spec);
  t.is(await E(kit.service).lookupScope('a'), a);
  await t.throwsAsync(E(a).attestation(), { message: /has not started/ });
  t.is(f.reads(), 0);
  t.is(f.closes(), 0);
  t.deepEqual(f.listeners, []);
  await E(a).revoke();
  t.is(f.closes(), 0);
  await kit.close();
  await kit.close();
  t.is(f.closes(), 1);
  await t.throwsAsync(E(kit.service).provideScope('b', spec), {
    message: /closed/,
  });
});

test('session A revocation preserves B and uses the original shared credential', async t => {
  const f = fixture();
  const kit = makeOpencodeBrokerServiceKit(f.options);
  t.teardown(kit.close);
  const a = await E(kit.service).provideScope('a', spec);
  const b = await E(kit.service).provideScope('b', spec);
  await Promise.all([E(a).start(), E(b).start()]);
  t.is(f.listeners.length, 2);
  t.is((await request(f.listeners[0].endpoint)).body, 'ok');
  await E(a).revoke();
  t.is(f.listeners[0].attempts, 1);
  t.is(f.listeners[1].attempts, 0);
  t.is(f.closes(), 0);
  await t.throwsAsync(request(f.listeners[0].endpoint), {
    message: /inactive/,
  });
  t.is((await request(f.listeners[1].endpoint)).body, 'ok');
  t.is(f.reads(), 2);
  t.like(await E(b).attestation(), {
    sessionId: 'b',
    accountRef: OPENCODE_BROKER_ACCOUNT,
  });
  await kit.close();
  t.is(f.listeners[1].attempts, 1);
  t.is(f.closes(), 1);
});

test('operator close reaches cancellation-dependent shared opening', async t => {
  t.timeout(5000);
  const f = fixture();
  const opened = gate();
  const cancelled = gate();
  let closes = 0;
  const kit = makeOpencodeBrokerServiceKit({
    ...f.options,
    runtime: undefined,
    runtimeKit: {
      open: async () => {
        opened.release();
        await cancelled.promise;
        return f.options.runtime;
      },
      close: async () => {
        closes += 1;
        cancelled.release();
      },
    },
  });
  t.teardown(async () => {
    cancelled.release();
    await kit.close();
  });
  const a = await E(kit.service).provideScope('a', spec);
  const starting = E(a).start();
  const failed = t.throwsAsync(starting, { message: /closed/ });
  await opened.promise;
  const closing = kit.close();
  t.is(kit.close(), closing);
  await failed;
  await closing;
  t.is(closes, 1);
  t.deepEqual(f.listeners, []);
  t.is(await E(kit.service).lookupScope('a'), undefined);
});

test('operator close retains late listener acquisition and immediately revokes authority', async t => {
  t.timeout(5000);
  const f = fixture();
  const held = gate();
  const entered = gate();
  f.onStart(async () => {
    entered.release();
    await held.promise;
  });
  const kit = makeOpencodeBrokerServiceKit(f.options);
  t.teardown(async () => {
    held.release();
    await kit.close();
  });
  const a = await E(kit.service).provideScope('a', spec);
  const starting = E(a).start();
  const failed = t.throwsAsync(starting, { message: /admission failed/ });
  await entered.promise;
  let done = false;
  const closing = kit.close().then(() => {
    done = true;
  });
  await t.throwsAsync(request(f.listeners[0].endpoint), {
    message: /inactive/,
  });
  t.false(done);
  t.is(f.closes(), 1);
  t.is(await E(kit.service).lookupScope('a'), a);
  held.release();
  await failed;
  await closing;
  t.is(f.listeners[0].attempts, 1);
  t.is(await E(kit.service).lookupScope('a'), undefined);
});

test('failed scoped cleanup is recoverable without closing the operator or session B', async t => {
  const f = fixture();
  let failA = true;
  f.onStop(async ordinal => {
    if (ordinal === 0 && failA) throw Error('A cleanup failed');
  });
  const kit = makeOpencodeBrokerServiceKit(f.options);
  t.teardown(async () => {
    failA = false;
    await kit.close();
  });
  const a = await E(kit.service).provideScope('a', spec);
  const b = await E(kit.service).provideScope('b', spec);
  await Promise.all([E(a).start(), E(b).start()]);
  await t.throwsAsync(E(a).revoke(), { message: /cleanup pending/ });
  t.is(await E(kit.service).lookupScope('a'), a);
  t.is(f.closes(), 0);
  t.is(f.listeners[1].attempts, 0);
  t.is((await request(f.listeners[1].endpoint)).body, 'ok');
  failA = false;
  await E(a).revoke();
  t.is(f.listeners[0].attempts, 2);
  t.is(f.listeners[1].attempts, 0);
});

test('failed operator cleanup retries without repeating successful scope cleanup', async t => {
  const f = fixture();
  let failClose = true;
  f.onClose(async () => {
    if (failClose) throw Error('Runtime cleanup failed');
  });
  const kit = makeOpencodeBrokerServiceKit(f.options);
  t.teardown(async () => {
    failClose = false;
    await kit.close();
  });
  const a = await E(kit.service).provideScope('a', spec);
  await E(a).start();
  await t.throwsAsync(kit.close(), { message: /cleanup pending/ });
  t.is(f.listeners[0].attempts, 1);
  t.is(f.closes(), 1);
  t.is(await E(kit.service).lookupScope('a'), undefined);
  await t.throwsAsync(E(a).start(), { message: /closed/ });
  failClose = false;
  await kit.close();
  await kit.close();
  t.is(f.listeners[0].attempts, 1);
  t.is(f.closes(), 2);
});

test('failed issuer construction and runtime cleanup retain the operator close handle', async t => {
  const f = fixture();
  let failClose = true;
  f.onClose(async () => {
    if (failClose) throw Error('Runtime cleanup failed');
  });
  const kit = makeOpencodeBrokerServiceKit({
    ...f.options,
    makeIssuer: () => {
      throw Error('Issuer construction failed');
    },
  });
  t.teardown(async () => {
    failClose = false;
    await kit.close();
  });
  const a = await E(kit.service).provideScope('a', spec);
  await t.throwsAsync(E(a).start(), { message: /Issuer construction failed/ });
  await t.throwsAsync(kit.close(), { message: /cleanup pending/ });
  t.is(f.closes(), 1);
  failClose = false;
  await kit.close();
  t.is(f.closes(), 2);
  t.deepEqual(f.listeners, []);
});
