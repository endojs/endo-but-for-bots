// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  OPENCODE_BROKER_ACCOUNT,
  OPENROUTER_INFERENCE_PATH,
  OPENROUTER_ORIGIN,
  buildOpencodeBrokerPolicy,
  makeOpencodeBroker,
  makeOpencodeBrokerKit,
} from '../src/opencode-broker.js';

const digest = `sha256:${'a'.repeat(64)}`;
const listenerImageRef = `localhost/endo-provider@${digest}`;
const models = ['deepseek/deepseek-v4.1-flash'];

const makeFakeRuntime = () => {
  let stops = 0;
  let disposes = 0;
  const starts = [];
  return {
    starts,
    stops: () => stops,
    disposes: () => disposes,
    async start(input) {
      starts.push(input);
      return harden({
        async observe() {
          return harden({
            endpoint: 'http://127.0.0.1:1234',
            containerName: 'listener',
            networkNamespaceId: 'net-1',
            listenerImageDigest: digest,
            ...(input.network
              ? {
                  network: {
                    policy: 'public-internet',
                    proxyUrl: 'http://127.0.0.1:23457',
                    dnsHost: '127.0.0.53',
                    resolverConfigPath: '/private-runtime/public-resolv.conf',
                  },
                }
              : {}),
          });
        },
        async stop() {
          stops += 1;
        },
        closed: new Promise(() => {}),
      });
    },
    startKit(input) {
      const value = this.start(input);
      return {
        value,
        stop: async () => {
          const worker = await value;
          await worker.stop();
        },
      };
    },
    async dispose() {
      disposes += 1;
    },
  };
};

const brokerOptions = (runtime, overrides = {}) => ({
  secret: Far('secret', {
    async readBase64() {
      return btoa('openrouter-key');
    },
  }),
  ownerId: 'opencode-owner',
  directory: '/var/lib/endo/opencode-broker',
  imageRef: `localhost/opencode-sandbox@${digest}`,
  imageDigest: digest,
  listenerImageRef,
  models,
  fetch: async () => new Response('ok'),
  runtime,
  ...overrides,
});

const makeBroker = (runtime, overrides = {}) =>
  makeOpencodeBroker(brokerOptions(runtime, overrides));

test('policy pins the OpenRouter origin, route, and strip handling', t => {
  const policy = buildOpencodeBrokerPolicy({ models });
  t.is(policy.origin, OPENROUTER_ORIGIN);
  t.deepEqual(policy.routes, [
    { method: 'POST', path: OPENROUTER_INFERENCE_PATH },
  ]);
  t.is(policy.clientAuthorization, 'strip');
  t.is(policy.authMode, 'api-key');
  t.is(policy.maxConcurrentRequests, 4);
  for (const removed of ['maxRequests', 'maxTotalBytes', 'maxCostMicrounits']) {
    t.false(Object.hasOwn(policy, removed));
  }
  t.throws(() => buildOpencodeBrokerPolicy({ models: [] }), {
    message: /nonempty list/,
  });
});

test('leases report broker-only evidence and listener limits', async t => {
  const runtime = makeFakeRuntime();
  const broker = await makeBroker(runtime);
  t.is(broker.imageRef, `localhost/opencode-sandbox@${digest}`);

  const lease = await broker.issuer({
    sessionId: 'session-1',
    providerOrigin: OPENROUTER_ORIGIN,
    accountRef: OPENCODE_BROKER_ACCOUNT,
    model: models[0],
    networkPolicy: 'off',
  });
  t.deepEqual(runtime.starts[0].limits.allowedPaths, [
    OPENROUTER_INFERENCE_PATH,
  ]);
  t.is(runtime.starts[0].limits.clientAuthorization, 'strip');
  const attestation = await E(lease).attestation();
  t.like(attestation, {
    version: 'ProviderGrantV1',
    sessionId: 'session-1',
    accountRef: OPENCODE_BROKER_ACCOUNT,
    authMode: 'api-key',
    providerOrigin: OPENROUTER_ORIGIN,
    endpoint: 'http://127.0.0.1:1234',
    networkNamespaceId: 'net-1',
  });
  t.deepEqual(attestation.modelAllowlist, models);
  const evidence = await E(lease).sandboxEvidence();
  t.like(evidence, {
    brokerSidecar: { container: 'listener' },
    credentialInjection: 'broker-only',
    brokerTransport: 'loopback-sidecar',
    networkNamespaceId: 'net-1',
  });
  await E(lease).revoke();
  t.is(runtime.stops(), 1);
  await broker.dispose();
  t.is(runtime.disposes(), 1);
});

test('denies leases for other origins, accounts, or models', async t => {
  const broker = await makeBroker(makeFakeRuntime());
  t.teardown(() => broker.dispose());
  await t.throwsAsync(
    () =>
      broker.issuer({
        sessionId: 'session-1',
        providerOrigin: 'https://example.com',
        accountRef: OPENCODE_BROKER_ACCOUNT,
        model: models[0],
        networkPolicy: 'off',
      }),
    { message: /denied/ },
  );
  await t.throwsAsync(
    () =>
      broker.issuer({
        sessionId: 'session-1',
        providerOrigin: OPENROUTER_ORIGIN,
        accountRef: 'other-account',
        model: models[0],
        networkPolicy: 'off',
      }),
    { message: /denied/ },
  );
  await t.throwsAsync(
    () =>
      broker.issuer({
        sessionId: 'session-1',
        providerOrigin: OPENROUTER_ORIGIN,
        accountRef: OPENCODE_BROKER_ACCOUNT,
        model: 'other/model',
        networkPolicy: 'off',
      }),
    { message: /denied/ },
  );
  // No public egress factory is configured: a public-internet lease is denied
  // rather than silently run without the extra network.
  await t.throwsAsync(
    () =>
      broker.issuer({
        sessionId: 'session-1',
        providerOrigin: OPENROUTER_ORIGIN,
        accountRef: OPENCODE_BROKER_ACCOUNT,
        model: models[0],
        networkPolicy: 'public-internet',
      }),
    { message: /Unsupported provider grant network policy/ },
  );
});

test('accepts a property-less remote-presence secret at composition', async t => {
  // A CapTP SecretBlob presence has no own properties; composition must not
  // introspect it synchronously, or every real deployment fails here.
  const broker = await makeBroker(makeFakeRuntime(), { secret: harden({}) });
  t.truthy(broker.issuer);
});

test('refuses unpinned images and invalid operator identity', async t => {
  const runtime = makeFakeRuntime();
  const base = {
    secret: Far('secret', {
      async readBase64() {
        return btoa('openrouter-key');
      },
    }),
    ownerId: 'opencode-owner',
    directory: '/var/lib/endo/opencode-broker',
    imageRef: `localhost/opencode-sandbox@${digest}`,
    imageDigest: digest,
    listenerImageRef,
    models,
    runtime,
  };
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, imageDigest: 'localhost/opencode' }),
    { message: /digest must be pinned/ },
  );
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, ownerId: '../escape' }),
    { message: /owner id is invalid/ },
  );
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, directory: 'relative/dir' }),
    { message: /directory must be absolute/ },
  );
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, listenerImageRef: 'localhost/x' }),
    { message: /listener image must be digest-pinned/ },
  );
  await t.throwsAsync(
    () =>
      makeOpencodeBroker({
        ...base,
        imageRef: `localhost/opencode-sandbox@${`sha256:${'b'.repeat(64)}`}`,
      }),
    { message: /image ref must match its digest/ },
  );
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, ownerId: `a${'b'.repeat(64)}` }),
    { message: /owner id is invalid/ },
  );
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, secret: { readBase64: null } }),
    { message: /SecretBlob read facet/ },
  );
  await t.throwsAsync(() => makeOpencodeBroker({ ...base, secret: null }), {
    message: /SecretBlob read facet/,
  });
  await t.throwsAsync(
    () => makeOpencodeBroker({ ...base, fetch: /** @type {any} */ (null) }),
    {
      message: /fetch authority/,
    },
  );
});

test('public grants use shared egress and revocation removes its authority', async t => {
  const runtime = makeFakeRuntime();
  const broker = await makeBroker(runtime, { publicInternet: true });
  t.teardown(broker.dispose);
  const grant = await broker.issuer({
    sessionId: 'public-session',
    providerOrigin: OPENROUTER_ORIGIN,
    accountRef: OPENCODE_BROKER_ACCOUNT,
    model: models[0],
    networkPolicy: 'public-internet',
  });
  const { network } = runtime.starts[0];
  t.deepEqual(Object.keys(network), ['endpoint']);
  const evidence = await E(grant).attestation();
  t.is(evidence.network.proxyUrl, 'http://127.0.0.1:23457');
  // No network dial is needed: private destinations are rejected by the
  // shared host service before resolution or connection.
  await t.throwsAsync(E(network.endpoint).open('127.0.0.1', 80), {
    message: /denied/,
  });
  await E(grant).revoke();
  await t.throwsAsync(E(network.endpoint).open('example.com', 443), {
    message: /Public egress is disabled/,
  });
  t.is(runtime.stops(), 1);
});

test('broker kit fences same-tick startup before opening its runtime', async t => {
  t.timeout(5000);
  let opens = 0;
  let closes = 0;
  const runtimeKit = {
    open: async () => {
      opens += 1;
      return makeFakeRuntime();
    },
    close: async () => {
      closes += 1;
    },
  };
  const kit = makeOpencodeBrokerKit(brokerOptions(undefined, { runtimeKit }));
  t.teardown(kit.close);
  t.is(opens, 0);
  t.is(closes, 0);
  const starting = kit.start();
  const closing = kit.close();
  await t.throwsAsync(starting, { message: /closed/ });
  await closing;
  t.is(opens, 0);
  t.is(closes, 1);
});

test('broker retains late runtime acquisition and fences issuer construction', async t => {
  t.timeout(5000);
  const runtime = makeFakeRuntime();
  let release = () => {};
  const pending = new Promise(resolve => {
    release = () => resolve(runtime);
  });
  let opened = () => {};
  const admission = new Promise(resolve => {
    opened = () => resolve(undefined);
  });
  let issuers = 0;
  const runtimeKit = {
    open: async () => {
      opened();
      return pending;
    },
    close: async () => {
      await pending;
      await runtime.dispose();
    },
  };
  const kit = makeOpencodeBrokerKit(
    brokerOptions(undefined, {
      runtimeKit,
      makeIssuer: () => {
        issuers += 1;
        throw Error('unexpected issuer');
      },
    }),
  );
  t.teardown(async () => {
    release();
    await kit.close();
  });
  const starting = kit.start();
  const rejected = t.throwsAsync(starting, { message: /closed/ });
  await admission;
  const closing = kit.close();
  t.is(kit.close(), closing);
  let finished = false;
  void closing.then(() => {
    finished = true;
  });
  await Promise.resolve();
  t.false(finished);
  release();
  await rejected;
  await closing;
  t.is(issuers, 0);
  t.is(runtime.disposes(), 1);
});

test('failed issuer construction retains failed runtime cleanup for retry', async t => {
  let failClose = true;
  let closes = 0;
  const runtime = makeFakeRuntime();
  const kit = makeOpencodeBrokerKit(
    brokerOptions(runtime, {
      runtime: {
        ...runtime,
        dispose: () => {
          closes += 1;
          if (failClose) throw Error('release failed');
          return Promise.resolve();
        },
      },
      makeIssuer: () => {
        throw Error('issuer failed');
      },
    }),
  );
  t.teardown(async () => {
    failClose = false;
    await kit.close();
  });
  await t.throwsAsync(kit.start(), { message: /issuer failed/ });
  await t.throwsAsync(kit.close(), { message: /cleanup pending/ });
  failClose = false;
  await kit.close();
  await kit.close();
  t.is(closes, 2);
});

test('broker retries failed grant revocation without repeating released runtime cleanup', async t => {
  let failStop = true;
  let stops = 0;
  const runtime = makeFakeRuntime();
  const kit = makeOpencodeBrokerKit(
    brokerOptions({
      ...runtime,
      start: async input => {
        const worker = await runtime.start(input);
        return {
          ...worker,
          stop: async () => {
            stops += 1;
            if (failStop) throw Error('stop failed');
          },
        };
      },
    }),
  );
  t.teardown(async () => {
    failStop = false;
    await kit.close();
  });
  const broker = await kit.start();
  const grant = await broker.issuer({
    sessionId: 'session-retry',
    providerOrigin: OPENROUTER_ORIGIN,
    accountRef: OPENCODE_BROKER_ACCOUNT,
    model: models[0],
    networkPolicy: 'off',
  });
  const closing = kit.close();
  await t.throwsAsync(
    () =>
      broker.issuer({
        sessionId: 'other',
        providerOrigin: OPENROUTER_ORIGIN,
        accountRef: OPENCODE_BROKER_ACCOUNT,
        model: models[0],
        networkPolicy: 'off',
      }),
    { message: /denied/ },
  );
  await t.throwsAsync(closing, { message: /cleanup pending/ });
  await t.throwsAsync(E(grant).attestation(), { message: /inactive/ });
  failStop = false;
  await kit.close();
  t.is(runtime.disposes(), 1);
  t.is(stops, 2);
});
