// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeProviderBrokerServiceKit } from '@endo/hosted-agent/provider-broker-service.js';

import {
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_ORIGIN,
  ANTHROPIC_VERSION,
  CLAUDE_BROKER_ACCOUNT,
  DEFAULT_OAUTH_BETA,
  buildClaudeBrokerPolicy,
  makeClaudeBrokerKit,
} from '../src/claude-broker.js';
import { makeOwnedClaudeBrokerService } from '../src/claude-broker-service-agent.js';

const digest = `sha256:${'a'.repeat(64)}`;
const listenerImageRef = `localhost/endo-provider@${digest}`;
const models = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

test('Claude pool hands recognized exhaustion to a second secret but never moves a pinned request', async t => {
  const runtime = makeFakeRuntime();
  const used = [];
  /** @type {Map<string, any>} */
  const entries = new Map([
    ['subscriptions', harden({ members: [{ id: 'first' }, { id: 'second' }] })],
    ...['first', 'second'].map(id => [
      id,
      Far(`${id} secret`, { readBase64: async () => btoa(`sk-ant-oat-${id}`) }),
    ]),
  ]);
  let kit;
  const make = makeOwnedClaudeBrokerService({
    makeServiceKit: options => {
      kit = makeProviderBrokerServiceKit({
        ...options,
        runtime,
        fetch: async (_url, init) => {
          const auth = init.headers.authorization;
          used.push(auth);
          return auth.endsWith('first')
            ? new Response('exhausted', {
                status: 429,
                headers: {
                  'anthropic-ratelimit-unified-status': 'rejected',
                  'anthropic-ratelimit-unified-5h-utilization': '1',
                  'anthropic-ratelimit-unified-5h-reset': '4000000000',
                },
              })
            : new Response('served');
        },
      });
      return kit;
    },
  });
  const namespace = Far('pool namespace', {
    lookup: async name => entries.get(name),
    list: async () => [],
    storeValue: async (value, name) => entries.set(name, value),
  });
  const service = await make(
    namespace,
    Far('context', { whenCancelled: () => new Promise(() => {}) }),
    {
      env: {
        CLAUDE_BROKER_CONFIG: JSON.stringify({
          ownerId: 'claude-pooled',
          directory: '/tmp/unused',
          imageRef: `localhost/claude@${digest}`,
          imageDigest: digest,
          listenerImageRef,
          models,
          credentialKind: 'oauthToken',
          pool: true,
        }),
      },
    },
  );
  t.teardown(() => kit.close());
  const spec = harden({
    providerOrigin: ANTHROPIC_ORIGIN,
    accountRef: CLAUDE_BROKER_ACCOUNT,
  });
  const scope = await E(service).provideScope('auto-session', spec);
  await E(scope).start();
  const request = harden({
    method: 'POST',
    path: ANTHROPIC_MESSAGES_PATH,
    body: JSON.stringify({ model: models[0] }),
  });
  const endpoint = runtime.starts[0].endpoint;
  t.is((await E(endpoint).request(request)).body, 'served');
  t.deepEqual(used, ['Bearer sk-ant-oat-first', 'Bearer sk-ant-oat-second']);
  t.is((await E(endpoint).request(request)).body, 'served');
  t.is(used.length, 3);
  const pinned = await E(service).provideScope(
    'pinned-session',
    harden({ ...spec, subscription: 'first' }),
  );
  await E(pinned).start();
  await t.throwsAsync(() => E(runtime.starts[1].endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(used.length, 3);
});

const makeFakeRuntime = () => {
  let stops = 0;
  let disposes = 0;
  /** @type {any[]} */
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
      return btoa('sk-ant-api03-key');
    },
  }),
  ownerId: 'claude-owner',
  directory: '/var/lib/endo/claude-broker',
  imageRef: `localhost/claude-sandbox@${digest}`,
  imageDigest: digest,
  listenerImageRef,
  models,
  credentialKind: 'apiKey',
  fetch: async () => new Response('ok'),
  runtime,
  ...overrides,
});

/** Start a broker over the fake runtime and dispose it with the test. */
const startBroker = async (t, runtime, overrides = {}) => {
  const kit = makeClaudeBrokerKit(brokerOptions(runtime, overrides));
  const broker = await kit.start();
  t.teardown(() => kit.close());
  return broker;
};

test('the policy pins the Anthropic Messages route and selects the header by credential kind', t => {
  const apiKey = buildClaudeBrokerPolicy({ models, credentialKind: 'apiKey' });
  t.is(apiKey.origin, ANTHROPIC_ORIGIN);
  t.deepEqual(apiKey.routes, [
    { method: 'POST', path: ANTHROPIC_MESSAGES_PATH },
  ]);
  t.is(apiKey.authMode, 'api-key');
  t.is(apiKey.clientAuthorization, 'strip');
  t.is(apiKey.credentialHeader, 'x-api-key');
  t.is(apiKey.anthropicVersion, ANTHROPIC_VERSION);
  t.false(Object.hasOwn(apiKey, 'anthropicBeta'));
  t.deepEqual(apiKey.models, models);
  t.is(apiKey.maxConcurrentRequests, 4);
  // A subscription token rides as a Bearer token under the OAuth beta.
  const oauth = buildClaudeBrokerPolicy({
    models,
    credentialKind: 'oauthToken',
  });
  t.is(oauth.credentialHeader, 'bearer');
  t.is(oauth.anthropicBeta, DEFAULT_OAUTH_BETA);
  t.is(
    buildClaudeBrokerPolicy({
      models,
      credentialKind: 'oauthToken',
      anthropicBeta: 'oauth-2025-04-20,interleaved-thinking',
    }).anthropicBeta,
    'oauth-2025-04-20,interleaved-thinking',
  );
  t.throws(
    () => buildClaudeBrokerPolicy({ models: [], credentialKind: 'apiKey' }),
    {
      message: /nonempty list/,
    },
  );
  // A beta list the broker would refuse at every grant is refused here.
  t.throws(
    () =>
      buildClaudeBrokerPolicy({
        models,
        credentialKind: 'oauthToken',
        anthropicBeta: 'oauth-2025-04-20, interleaved-thinking',
      }),
    { message: /Invalid Anthropic beta capabilities/ },
  );
  t.throws(
    () => buildClaudeBrokerPolicy({ models, credentialKind: 'password' }),
    {
      message: /Claude credential kind must be one of/,
    },
  );
});

test('leases attest the Anthropic account and broker-only credential injection', async t => {
  const runtime = makeFakeRuntime();
  const broker = await startBroker(t, runtime);
  t.is(broker.imageRef, `localhost/claude-sandbox@${digest}`);
  const lease = await broker.issuer({
    sessionId: 'session-1',
    providerOrigin: ANTHROPIC_ORIGIN,
    accountRef: CLAUDE_BROKER_ACCOUNT,
    model: models[0],
    networkPolicy: 'off',
  });
  t.deepEqual(runtime.starts[0].limits.allowedPaths, [ANTHROPIC_MESSAGES_PATH]);
  t.is(runtime.starts[0].limits.clientAuthorization, 'strip');
  const attestation = await E(lease).attestation();
  t.like(attestation, {
    version: 'ProviderGrantV1',
    sessionId: 'session-1',
    accountRef: CLAUDE_BROKER_ACCOUNT,
    authMode: 'api-key',
    providerOrigin: ANTHROPIC_ORIGIN,
    endpoint: 'http://127.0.0.1:1234',
    networkNamespaceId: 'net-1',
    imageDigest: digest,
  });
  t.deepEqual(attestation.modelAllowlist, models);
  const evidence = await E(lease).sandboxEvidence();
  t.like(evidence, {
    brokerSidecar: { container: 'listener' },
    credentialInjection: 'broker-only',
    brokerTransport: 'loopback-sidecar',
    networkNamespaceId: 'net-1',
    imageDigest: digest,
  });
  t.false(Object.hasOwn(evidence, 'network'));
  await E(lease).revoke();
  t.is(runtime.stops(), 1);
});

test('denies leases for other origins, accounts, models, or an unprovisioned network policy', async t => {
  const broker = await startBroker(t, makeFakeRuntime());
  const base = {
    sessionId: 'session-1',
    providerOrigin: ANTHROPIC_ORIGIN,
    accountRef: CLAUDE_BROKER_ACCOUNT,
    model: models[0],
    networkPolicy: 'off',
  };
  /** @type {[string, Record<string, unknown>, RegExp][]} */
  const refused = [
    ['origin', { providerOrigin: 'https://example.com' }, /denied/],
    ['account', { accountRef: 'other-account' }, /denied/],
    ['model', { model: 'claude-3-opus' }, /denied/],
    [
      'network',
      { networkPolicy: 'public-internet' },
      /Unsupported provider grant network policy/,
    ],
  ];
  for (const [name, spec, message] of refused) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      broker.issuer(/** @type {any} */ ({ ...base, ...spec })),
      { message },
      name,
    );
  }
});

test('the kit refuses an unpinned image, a bad operator identity, and an unknown credential kind at construction', t => {
  const runtime = makeFakeRuntime();
  /**
   * @param {Record<string, unknown>} overrides
   * @param {RegExp} message
   */
  const refuse = (overrides, message) =>
    t.throws(() => makeClaudeBrokerKit(brokerOptions(runtime, overrides)), {
      message,
    });
  refuse({ imageDigest: 'localhost/claude' }, /digest must be pinned/);
  refuse({ ownerId: '../escape' }, /owner id is invalid/);
  refuse({ directory: 'relative/dir' }, /directory must be absolute/);
  refuse(
    { listenerImageRef: 'localhost/x' },
    /listener image must be digest-pinned/,
  );
  refuse({ secret: null }, /SecretBlob read facet/);
  refuse(
    { credentialKind: 'password' },
    /Claude credential kind must be one of/,
  );
  t.deepEqual(runtime.starts, [], 'nothing started');
});
