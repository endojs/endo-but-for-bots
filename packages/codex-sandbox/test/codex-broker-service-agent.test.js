// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeProviderBrokerServiceKit } from '@endo/hosted-agent/provider-broker-service.js';
import { setImmediate } from 'node:timers/promises';

import {
  makeOwnedCodexBrokerService,
  readCodexBrokerConfig,
} from '../src/codex-broker-service-agent.js';

const digest = `sha256:${'a'.repeat(64)}`;
const config = harden({
  ownerId: 'codex-operator',
  directory: '/var/lib/endo/codex-broker',
  imageRef: `localhost/codex@${digest}`,
  imageDigest: digest,
  listenerImageRef: `localhost/provider@${digest}`,
  accountRef: 'account-a',
  models: ['model-a'],
});
const env = harden({ CODEX_BROKER_CONFIG: JSON.stringify(config) });

test('Codex broker configuration refuses authority injection and unbound accounts', t => {
  t.deepEqual(readCodexBrokerConfig(env), config);
  t.throws(() => readCodexBrokerConfig({}), {
    message: /Missing CODEX_BROKER_CONFIG/,
  });
  for (const change of [
    { credential: 'secret' },
    { fetch: 'override' },
    { origin: 'https://elsewhere.test' },
    { accountRef: '' },
    { models: [] },
    { models: ['invalid model'] },
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
  cancel();
  await setImmediate();
  t.is(closes, 1);
  t.true(revoked.includes('first'));
  t.true(revoked.includes('second'));
  t.true(revoked.includes('issuer'));
  await t.throwsAsync(E(first).attestation(), { message: /closed/ });
});
