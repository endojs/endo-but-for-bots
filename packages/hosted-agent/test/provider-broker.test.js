// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeProviderBrokerLease } from '../src/provider-broker.js';

/** @import { BrokerPolicy } from '../src/provider-broker.js' */

const policy = harden({
  origin: 'https://api.example.test',
  routes: [{ method: 'POST', path: '/v1/responses' }],
  models: ['allowed'],
  expiresAt: 1000,
  maxRequests: 2n,
  maxRequestBytes: 1000n,
  maxResponseBytes: 100n,
  maxTotalBytes: 3000n,
  maxCostMicrounits: 20n,
  maxCostMicrounitsPerRequest: 10n,
});
const request = harden({
  method: 'POST',
  path: '/v1/responses',
  body: '{"model":"allowed"}',
});
const credential = 'canary-secret';
/**
 * @param {object} [options]
 * @param {Partial<BrokerPolicy>} [options.limits]
 * @param {(r: any) => Promise<any>} [options.respond]
 * @param {() => Promise<string>} [options.read]
 */
const setup = ({
  limits = {},
  respond = async () => ({ status: 200, body: 'ok' }),
  read = async () => globalThis.btoa(credential),
} = {}) => {
  const calls = [];
  const audit = [];
  let time = 0;
  const lease = makeProviderBrokerLease(
    { ...policy, ...limits },
    {
      secret: Far('secret', { readBase64: read }),
      transport: Far('transport', {
        async request(r) {
          calls.push(r);
          return respond(r);
        },
      }),
      now: () => time,
      audit: event => {
        audit.push(event);
      },
    },
  );
  return {
    ...lease,
    calls,
    audit,
    expire: () => {
      time = 1000;
    },
  };
};

test('broker injects credentials only into fixed transport and canonicalizes JSON', async t => {
  const { endpoint, calls, audit } = setup();
  t.deepEqual(
    await E(endpoint).request(
      harden({ ...request, body: '{"model":"denied","model":"allowed"}' }),
    ),
    { status: 200, body: 'ok' },
  );
  t.like(calls[0], {
    url: 'https://api.example.test/v1/responses',
    redirect: 'error',
    maxResponseBytes: 100n,
    body: request.body,
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
  });
  t.deepEqual(audit, [
    { event: 'admitted', requests: 1n },
    { event: 'completed', requests: 1n },
  ]);
});

test('method, paths, models and request bytes fail before touching secret', async t => {
  const { endpoint, calls } = setup({
    read: async () => {
      t.fail('secret read');
      return '';
    },
  });
  for (const bad of [
    { ...request, method: 'GET' },
    { ...request, path: '//evil.test/v1/responses' },
    { ...request, path: '/v1/responses?redirect=https://evil.test' },
    { ...request, path: '/v1/%72esponses' },
    { ...request, path: '/v1/../v1/responses' },
    { ...request, body: '{"model":"denied"}' },
    { ...request, body: 'null' },
    { ...request, body: '{' },
    { ...request, body: ' '.repeat(1001) },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(endpoint).request(harden(bad)));
  }
  t.is(calls.length, 0);
});

test('concurrent requests reserve all quotas before asynchronous secret reads', async t => {
  t.timeout(5000);
  let release = () => {};
  const held = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const { endpoint, admin } = setup({
    limits: { maxCostMicrounits: 10n },
    read: async () => {
      await held;
      return globalThis.btoa(credential);
    },
  });
  t.teardown(() => release());
  const first = E(endpoint).request(request);
  await t.throwsAsync(() => E(endpoint).request(request), {
    message: /quota exhausted/,
  });
  release();
  await first;
  t.like(await E(admin).getStatus(), {
    requests: 1n,
    reservedCostMicrounits: 10n,
  });
});

test('request count and byte reservations independently bound admission', async t => {
  for (const limits of [{ maxRequests: 1n }, { maxTotalBytes: 119n }]) {
    const { endpoint } = setup({ limits });
    // eslint-disable-next-line no-await-in-loop
    await E(endpoint).request(request);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(endpoint).request(request), {
      message: /quota exhausted/,
    });
  }
  t.pass();
});

test('revocation during secret read prevents transport dispatch', async t => {
  t.timeout(5000);
  let release = () => {};
  const held = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const { endpoint, admin, calls } = setup({
    read: async () => {
      await held;
      return globalThis.btoa(credential);
    },
  });
  t.teardown(() => release());
  const pending = E(endpoint).request(request);
  await E(admin).revoke();
  release();
  await t.throwsAsync(pending, { message: /Provider request failed/ });
  t.is(calls.length, 0);
});

test('expiry denies new requests and response delivery', async t => {
  const lease = setup({
    respond: async () => {
      lease.expire();
      return { status: 200, body: 'ok' };
    },
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /inactive/,
  });
});

test('redirects, oversized bodies, credential echoes and transport errors are redacted', async t => {
  for (const respond of [
    async () => ({
      status: 302,
      body: 'redirect',
      headers: { location: 'https://evil.test' },
    }),
    async () => ({ status: 200, body: 'x'.repeat(101) }),
    async () => ({ status: 200, body: credential }),
    async () => ({ status: 200, body: globalThis.btoa(credential) }),
    async () => ({ status: 401, body: credential }),
    async () => {
      throw Error(credential);
    },
  ]) {
    const { endpoint, audit } = setup({ respond });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(endpoint).request(request), {
      message: 'Provider request failed',
    });
    t.deepEqual(audit, [
      { event: 'admitted', requests: 1n },
      { event: 'failed', requests: 1n },
    ]);
  }
});

test('header injection via secret is rejected without exporting the secret', async t => {
  const { endpoint, calls } = setup({
    read: async () => globalThis.btoa('token\r\nInjected: yes'),
  });
  await t.throwsAsync(() => E(endpoint).request(request), {
    message: 'Provider request failed',
  });
  t.is(calls.length, 0);
});

test('caller headers cannot override broker authority or supply cookies', async t => {
  const { endpoint, calls } = setup();
  await E(endpoint).request(
    harden({
      ...request,
      headers: { authorization: 'evil', cookie: 'ambient', host: 'evil.test' },
    }),
  );
  t.deepEqual(calls[0].headers, {
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  });
});

test('operator policy mutation does not widen a lease', async t => {
  const models = ['allowed'];
  const routes = [{ method: 'POST', path: '/v1/responses' }];
  const { endpoint } = setup({ limits: { models, routes } });
  models.push('denied');
  routes[0].path = '/admin';
  await t.throwsAsync(
    () =>
      E(endpoint).request(harden({ ...request, body: '{"model":"denied"}' })),
    { message: /Model denied/ },
  );
  await t.throwsAsync(
    () => E(endpoint).request(harden({ ...request, path: '/admin' })),
    { message: /route denied/ },
  );
  await E(endpoint).request(request);
});

test('revocation during transport suppresses the response', async t => {
  t.timeout(5000);
  const lease = setup({
    respond: async () => {
      await E(lease.admin).revoke();
      return { status: 200, body: 'ok' };
    },
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
});

test('malformed origins and routes cannot become proxy authority', t => {
  for (const origin of [
    'http://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/path',
    'https://api.example.test?next=evil',
    'https://api.example.test/',
  ]) {
    t.throws(() => setup({ limits: { origin } }));
  }
  t.throws(() =>
    setup({ limits: { routes: [{ method: 'POST', path: '/v1/../admin' }] } }),
  );
});

test('operator chooses Anthropic authorization without caller headers', async t => {
  const { endpoint, calls } = setup({
    limits: { credentialHeader: 'x-api-key', anthropicVersion: '2023-06-01' },
  });
  await E(endpoint).request(request);
  t.deepEqual(calls[0].headers, {
    'x-api-key': credential,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  });
  t.throws(() =>
    setup({ limits: { anthropicVersion: '2023-06-01\r\nInjected: yes' } }),
  );
});

test('operator configuration cannot enable administrative routes or subscription auth', t => {
  t.throws(
    () =>
      setup({
        limits: { routes: [{ method: 'POST', path: '/v1/account/delete' }] },
      }),
    { message: /Invalid inference route/ },
  );
  t.throws(
    () => setup({ limits: /** @type {any} */ ({ authMode: 'subscription' }) }),
    { message: /Unsupported broker authentication mode/ },
  );
});
