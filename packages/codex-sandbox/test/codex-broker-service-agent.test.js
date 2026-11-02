// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeProviderBrokerServiceKit } from '@endo/hosted-agent/provider-broker-service.js';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

import {
  makeOwnedCodexBrokerService,
  readCodexBrokerConfig,
} from '../src/codex-broker-service-agent.js';
import { codexBackendBindings } from '../src/codex-backend-module.js';

const digest = `sha256:${'a'.repeat(64)}`;
const config = harden({
  ownerId: 'codex-operator',
  directory: '/var/lib/endo/codex-broker',
  imageRef: `localhost/codex@${digest}`,
  imageDigest: digest,
  listenerImageRef: `localhost/provider@${digest}`,
  accountAuthority: 'codex-main',
  accountRef: 'account-a',
});
const env = harden({ CODEX_BROKER_CONFIG: JSON.stringify(config) });

test('a profile from before account authorities is refused with the way out, and a session binds to the authority, not the provider account', t => {
  const { accountAuthority: _, ...before } = config;
  t.throws(
    () =>
      readCodexBrokerConfig({ CODEX_BROKER_CONFIG: JSON.stringify(before) }),
    { message: /names no account authority.*retire that broker deliberately/ },
  );
  t.deepEqual(codexBackendBindings(readCodexBrokerConfig(env)), {
    imageRef: config.imageRef,
    accountRef: 'codex-main',
  });
});

test('Codex catalog uses retained credential and the packaged CLI version without starting runtime', async t => {
  let reads = 0;
  let requests = 0;
  let constructions = 0;
  const manifest = JSON.parse(
    await readFile(new URL('../oci/package.json', import.meta.url), 'utf8'),
  );
  // The catalog's own clock: within an observation's lifetime a second
  // catalog request is answered from what is held; past it, the provider is
  // read again under the credential as it is then.
  let clock = 1_000_000;
  const lifetimeMs = 60_000;
  const make = makeOwnedCodexBrokerService({
    makeServiceKit: options =>
      makeProviderBrokerServiceKit({
        ...options,
        now: () => clock,
        catalog: { lifetimeMs },
      }),
    makeCredential: () => {
      constructions += 1;
      return harden({
        accountRef: 'account-a',
        current: async () => {
          reads += 1;
          return harden({
            outcome: 'unchanged',
            state: {
              version: 'BrokerOAuthStateV1',
              accessToken: `token-${reads}`,
              refreshToken: 'refresh-canary',
              accountId: 'account-a',
              expiresAt: clock + lifetimeMs,
            },
          });
        },
      });
    },
    fetch: async (url, options) => {
      requests += 1;
      t.is(
        url,
        `https://chatgpt.com/backend-api/codex/models?client_version=${manifest.dependencies['@openai/codex']}`,
      );
      t.like(options?.headers, {
        authorization: `Bearer token-${reads}`,
        'chatgpt-account-id': 'account-a',
      });
      return Response.json({
        models: [
          {
            slug: 'advertised-model',
            display_name: 'Advertised',
            visibility: 'list',
            priority: 0,
            supported_reasoning_levels: [],
            default_reasoning_level: null,
          },
        ],
      });
    },
  });
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_resolve, reject) => {
    cancel = () => reject(Error('done'));
  });
  void cancelled.catch(() => {});
  t.teardown(async () => {
    cancel();
    await setImmediate();
  });
  const service = await make(
    Far('UnusedSecret', {
      readBase64: async () => {
        throw Error('unexpected read');
      },
    }),
    Far('CatalogContext', { whenCancelled: () => cancelled }),
    { env },
  );
  t.is(reads, 0);
  t.is(requests, 0);
  const first = await E(service).modelCatalog();
  t.is(first.accounts[0].state, 'current');
  t.is(typeof first.accounts[0].observedAt, 'number');
  await E(service).modelCatalog();
  t.is(constructions, 1);
  t.is(reads, 1);
  t.is(requests, 1);
  clock += lifetimeMs;
  t.like((await E(service).modelCatalog()).accounts[0], { state: 'current' });
  t.is(constructions, 1, 'discovery reuses the one credential owner');
  t.is(reads, 2);
  t.is(requests, 2);
  t.is(first.accounts[0].models[0].id, 'advertised-model');
});

test('Codex broker configuration refuses authority injection and unbound accounts', t => {
  t.deepEqual(readCodexBrokerConfig(env), config);
  // An operator model list is not configuration any more: the account's own
  // catalog admits models, so a retained profile carrying one says how to
  // retire it rather than failing as a shape error.
  t.throws(
    () =>
      readCodexBrokerConfig({
        CODEX_BROKER_CONFIG: JSON.stringify({ ...config, models: ['model-a'] }),
      }),
    { message: /names models.*retire that broker/ },
  );
  t.throws(() => readCodexBrokerConfig({}), {
    message: /Missing CODEX_BROKER_CONFIG/,
  });
  for (const change of [
    { credential: 'secret' },
    { fetch: 'override' },
    { origin: 'https://elsewhere.test' },
    { accountRef: '' },
    { accountAuthority: '' },
    { accountAuthority: 'not an id' },
    { accountAuthority: undefined },
    // A pool's profile names no account; one credential's must.
    { pool: true },
    { accountRef: undefined },
  ]) {
    t.throws(() =>
      readCodexBrokerConfig({
        CODEX_BROKER_CONFIG: JSON.stringify({ ...config, ...change }),
      }),
    );
  }
});

test('all Codex scopes share one host-only renewing credential and close with their owner', async t => {
  t.timeout(5000);
  const secret = Far('ExactRenewableSecret', {
    async readBase64() {
      throw Error('must not read on construction');
    },
    async readBase64WithGeneration() {
      throw Error('must not read on construction');
    },
  });
  const credential = harden({
    accountRef: 'account-a',
    current: async () => {
      throw Error('not used by this fixture');
    },
  });
  let constructions = 0;
  let opens = 0;
  let closes = 0;
  /** @type {unknown} */
  let issuerCredential;
  const revoked = [];
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((resolve, reject) => {
    cancel = () => reject(Error('done'));
  });
  void cancelled.catch(() => {});
  const context = Far('Context', { whenCancelled: () => cancelled });
  t.teardown(async () => {
    cancel();
    await setImmediate();
  });
  const make = makeOwnedCodexBrokerService({
    makeCredential: options => {
      constructions += 1;
      t.is(options.secret, secret);
      t.is(options.accountRef, config.accountRef);
      return credential;
    },
    makeServiceKit: options => {
      t.is(options.policy.authMode, 'oauth');
      t.is(options.policy.origin, 'https://chatgpt.com');
      t.is(options.credential, credential);
      return makeProviderBrokerServiceKit({
        ...options,
        runtimeKit: {
          async open() {
            opens += 1;
            return {
              async start() {
                throw Error('unused listener fixture');
              },
              startKit() {
                throw Error('unused listener fixture');
              },
              async retryCleanup() {
                await null;
              },
              async dispose() {
                await null;
              },
            };
          },
          async close() {
            closes += 1;
          },
        },
        makeIssuer: input => {
          issuerCredential = input.credential;
          t.deepEqual(
            input.adaptRequest?.({
              path: '/v1/responses',
              data: { store: false, stream: true },
            }),
            {
              path: '/backend-api/codex/responses',
              headers: {
                'chatgpt-account-id': 'account-a',
                originator: 'codex_cli_rs',
              },
            },
          );
          return /** @type {any} */ ({
            issueKit: spec => ({
              value: Promise.resolve(
                Far('Grant', {
                  async attestation() {
                    return harden({ sessionId: spec.sessionId });
                  },
                }),
              ),
              async fence() {
                revoked.push(`fence:${spec.sessionId}`);
              },
              async revoke() {
                revoked.push(spec.sessionId);
              },
            }),
            async dispose() {
              revoked.push('issuer');
            },
          });
        },
      });
    },
    reportError: error => t.fail(String(error)),
  });
  const service = await make(secret, context, { env });
  t.is(constructions, 1);
  t.is(opens, 0);
  const spec = harden({
    providerOrigin: 'https://chatgpt.com',
    accountRef: 'account-a',
    model: 'model-a',
  });
  const first = await E(service).provideScope('first', spec);
  const second = await E(service).provideScope('second', spec);
  await Promise.all([E(first).start(), E(second).start()]);
  t.is(constructions, 1);
  t.is(opens, 1);
  t.is(issuerCredential, credential);
  // eslint-disable-next-line no-underscore-dangle
  t.false((await E(first).__getMethodNames__()).includes('current'));
  t.deepEqual(await E(first).attestation(), { sessionId: 'first' });
  // The operator's redeemer is a facet of the service, never of a scope, and
  // it can do one thing.
  // eslint-disable-next-line no-underscore-dangle
  t.false((await E(first).__getMethodNames__()).includes('resetRedeemer'));
  const redeemer = await E(service).resetRedeemer();
  t.deepEqual(
    // eslint-disable-next-line no-underscore-dangle
    (await E(redeemer).__getMethodNames__()).filter(
      name => !name.startsWith('__'),
    ),
    ['help', 'redeem'],
  );
  t.is(await E(service).resetRedeemer('another'), undefined);
  await t.throwsAsync(E(redeemer).redeem({ idempotencyKey: 'short' }), {
    message: /Invalid idempotency key/,
  });
  cancel();
  await setImmediate();
  t.is(closes, 1);
  t.true(revoked.includes('first'));
  t.true(revoked.includes('second'));
  t.true(revoked.includes('issuer'));
  await t.throwsAsync(E(first).attestation(), { message: /closed/ });
});
