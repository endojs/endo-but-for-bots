// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeProviderBrokerGrant } from '@endo/hosted-agent/provider-broker.js';

import { makeCodexSubscriptionProfile } from '../src/codex-subscription-profile.js';
import { readCodexBrokerConfig } from '../src/codex-broker-service-agent.js';

const setup = t => {
  const profile = makeCodexSubscriptionProfile({
    accountRef: 'account-1',
    models: ['allowed'],
  });
  const calls = [];
  let reads = 0;
  const grant = makeProviderBrokerGrant(
    { ...profile.policy, accountRef: profile.accountRef },
    {
      adaptRequest: profile.adaptRequest,
      secret: Far('UnusedSecret', {
        async readBase64() {
          throw Error('unused');
        },
      }),
      credential: {
        accountRef: profile.accountRef,
        async current() {
          reads += 1;
          return harden({
            outcome: 'unchanged',
            state: {
              version: 'BrokerOAuthStateV1',
              accessToken: 'access-canary',
              refreshToken: 'refresh-canary',
              accountId: profile.accountRef,
              expiresAt: Date.now() + 60_000,
            },
          });
        },
      },
      transport: Far('Transport', {
        async request(request) {
          calls.push(request);
          return harden({ status: 200, body: 'ok' });
        },
      }),
    },
  );
  t.teardown(() => E(grant.admin).revoke());
  return { ...grant, profile, calls, reads: () => reads };
};

const request = harden({
  method: 'POST',
  path: '/v1/responses',
  body: JSON.stringify({ model: 'allowed', stream: true, store: false }),
});

test('Codex subscription maps only its fixed endpoint and pins the account header', async t => {
  const subject = setup(t);
  await E(subject.endpoint).request(
    harden({
      ...request,
      headers: { 'chatgpt-account-id': 'guest-account', originator: 'guest' },
    }),
  );
  t.is(subject.calls.length, 1);
  t.is(subject.calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  t.like(subject.calls[0].headers, {
    'chatgpt-account-id': 'account-1',
    originator: 'codex_cli_rs',
    authorization: 'Bearer access-canary',
  });
  t.false(JSON.stringify(subject.calls[0].headers).includes('refresh-canary'));
  t.false(subject.calls[0].body.includes('refresh-canary'));
  await E(subject.admin).revoke();
  await t.throwsAsync(E(subject.endpoint).request(request), {
    message: /inactive/,
  });
  t.is(subject.calls.length, 1);
});

test('Codex subscription rejects storage, nonstreaming, model and account routes before credentials', async t => {
  const subject = setup(t);
  for (const extra of [
    { body: '{"model":"allowed","store":true,"stream":true}' },
    { body: '{"model":"allowed","store":false,"stream":false}' },
    { body: '{"model":"allowed"}' },
    { body: '{"model":"denied","store":false,"stream":true}' },
    { path: '/backend-api/accounts' },
    { path: '/v1/messages' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(subject.endpoint).request(harden({ ...request, ...extra })),
    );
  }
  t.is(subject.reads(), 0);
  t.deepEqual(subject.calls, []);
});

test('Codex subscription requires shared renewing OAuth authority', t => {
  const { policy, accountRef, adaptRequest } = makeCodexSubscriptionProfile({
    accountRef: 'account-1',
    models: ['allowed'],
  });
  t.throws(
    () =>
      makeProviderBrokerGrant(
        { ...policy, accountRef },
        {
          secret: Far('Secret', {
            async readBase64() {
              throw Error('unused');
            },
          }),
          transport: /** @type {any} */ ({}),
          adaptRequest,
        },
      ),
    { message: /Unprovisioned broker OAuth mode/ },
  );
  t.throws(
    () =>
      makeCodexSubscriptionProfile({
        accountRef: 'account\r\nheader',
        models: ['allowed'],
      }),
    { message: /Invalid Codex subscription account/ },
  );
});

test('operator JSON cannot replace the fixed provider adapter or origin', t => {
  const config = {
    ownerId: 'owner',
    directory: '/broker',
    imageRef: `runtime@sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    listenerImageRef: `listener@sha256:${'b'.repeat(64)}`,
    accountRef: 'account-1',
    models: ['allowed'],
  };
  for (const extra of [
    { origin: 'https://other.test' },
    { adaptRequest: {} },
    { routes: [{ method: 'POST', path: '/v1/messages' }] },
    { credentialHeader: 'x-api-key' },
  ]) {
    t.throws(
      () =>
        readCodexBrokerConfig({
          CODEX_BROKER_CONFIG: JSON.stringify({ ...config, ...extra }),
        }),
      { message: /Invalid Codex broker configuration/ },
    );
  }
});
