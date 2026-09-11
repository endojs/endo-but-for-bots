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
          });
        },
        async stop() {
          stops += 1;
        },
        closed: new Promise(() => {}),
      });
    },
    async dispose() {
      disposes += 1;
    },
  };
};

const makeBroker = (runtime, overrides = {}) =>
  makeOpencodeBroker({
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

test('policy pins the OpenRouter origin, route, and strip handling', t => {
  const policy = buildOpencodeBrokerPolicy({ models });
  t.is(policy.origin, OPENROUTER_ORIGIN);
  t.deepEqual(policy.routes, [
    { method: 'POST', path: OPENROUTER_INFERENCE_PATH },
  ]);
  t.is(policy.clientAuthorization, 'strip');
  t.is(policy.authMode, 'api-key');
  t.is(policy.maxRequests, 64n);
  t.is(policy.maxCostMicrounits, 64n);
  t.is(
    policy.maxTotalBytes,
    64n * (8n * 1024n ** 2n + 16n * 1024n ** 2n),
    'every bounded request reserves a full request and response',
  );
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
    version: 'BrokerLeaseV1',
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
    { message: /Unsupported provider lease network policy/ },
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
  await t.throwsAsync(() => makeOpencodeBroker({ ...base, fetch: null }), {
    message: /fetch authority/,
  });
});
