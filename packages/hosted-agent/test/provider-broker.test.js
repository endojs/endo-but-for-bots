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
const accessToken = 'canary-access';
const refreshToken = 'canary-refresh';

/** @param {Partial<import('../src/provider-broker.js').BrokerOAuthState>} [overrides] */
const oauthState = (overrides = {}) =>
  harden({
    version: /** @type {const} */ ('BrokerOAuthStateV1'),
    accessToken,
    refreshToken,
    // Comfortably beyond the default 60s refresh skew at the test clock's zero.
    expiresAt: 1_000_000,
    accountId: 'account-1',
    ...overrides,
  });

/**
 * @param {object} [options]
 * @param {Partial<BrokerPolicy>} [options.limits]
 * @param {(r: any) => Promise<any>} [options.respond]
 * @param {() => Promise<string>} [options.read]
 * @param {boolean} [options.oauth] - Provision the refresh and rotate halves.
 * @param {any} [options.state] - Initial OAuth state when `oauth` is set.
 * @param {(request: any) => Promise<any>} [options.exchange] - Token endpoint.
 */
const setup = ({
  limits = {},
  respond = async () => ({ status: 200, body: 'ok' }),
  read,
  oauth = false,
  state,
  exchange,
} = {}) => {
  const calls = [];
  const audit = [];
  const exchanges = [];
  const rotations = [];
  let time = 0;
  // The rotate capability writes here and the read facet reads it back, so a
  // test observes exactly what a later request would see.
  let stored = oauth
    ? globalThis.btoa(JSON.stringify(state ?? oauthState()))
    : globalThis.btoa(credential);
  const powers = {
    secret: Far('secret', {
      readBase64: read ?? (async () => stored),
    }),
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
  };
  if (oauth) {
    Object.assign(powers, {
      refresh: Far('refresh', {
        async refresh(exchangeRequest) {
          exchanges.push(exchangeRequest);
          if (exchange) return exchange(exchangeRequest);
          return oauthState({
            accessToken: `${accessToken}-${exchanges.length}`,
            refreshToken: `${refreshToken}-${exchanges.length}`,
          });
        },
      }),
      rotate: Far('rotate', {
        async replaceBase64(base64) {
          rotations.push(base64);
          stored = base64;
        },
      }),
    });
  }
  const lease = makeProviderBrokerLease({ ...policy, ...limits }, powers);
  return {
    ...lease,
    calls,
    audit,
    exchanges,
    rotations,
    stored: () => JSON.parse(globalThis.atob(stored)),
    advance: ms => {
      time += ms;
    },
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
  // Still refused, now for a recorded reason rather than for want of an
  // implementation: neither vendor documents a configuration in which the
  // broker holds an individual subscription credential and the slice holds
  // none. See packages/codex-sandbox/SUBSCRIPTION-AUTH.md.
  t.throws(
    () => setup({ limits: /** @type {any} */ ({ authMode: 'subscription' }) }),
    { message: /Unsupported broker authentication mode/ },
  );
  // The mode that *is* implemented is refused until it is provisioned, so a
  // policy naming `oauth` without the capabilities that make refresh and
  // rotation possible fails at admission rather than on its first expiry.
  t.throws(() => setup({ limits: { authMode: 'oauth' } }), {
    message: /Unprovisioned broker OAuth mode/,
  });
  // Nor without an account to bind the credential to, nor in a credential
  // header shape an OAuth bearer does not take.
  t.throws(() => setup({ limits: { authMode: 'oauth' }, oauth: true }), {
    message: /Unprovisioned broker OAuth mode/,
  });
  t.throws(
    () =>
      setup({
        limits: {
          authMode: 'oauth',
          accountRef: 'account-1',
          credentialHeader: 'x-api-key',
        },
        oauth: true,
      }),
    { message: /Unprovisioned broker OAuth mode/ },
  );
  // A properly provisioned one is admitted.
  t.notThrows(() =>
    setup({
      limits: { authMode: 'oauth', accountRef: 'account-1' },
      oauth: true,
    }),
  );
});

/** @param {string[]} chunks */
const streamingSetup = chunks => {
  let cancelled = false;
  const reader = Far('reader', {
    async next() {
      const value = chunks.shift();
      return harden({ done: value === undefined, value: value ?? '' });
    },
    return() {
      cancelled = true;
    },
  });
  const lease = makeProviderBrokerLease(policy, {
    secret: Far('secret', {
      async readBase64() {
        return btoa(credential);
      },
    }),
    transport: Far('transport', {
      async request() {
        return harden({ status: 200, body: '' });
      },
      async requestStream() {
        return harden({ status: 200, reader });
      },
    }),
    now: () => 0,
  });
  return { ...lease, cancelled: () => cancelled };
};

test('stream rejects a credential split across chunks before disclosing its prefix', async t => {
  const lease = streamingSetup([
    `${'safe-prefix '.repeat(2)}canary-`,
    'secret',
  ]);
  const response = await E(lease.endpoint).requestStream(request);
  const first = await E(response.reader).next();
  t.false(first.value.includes('canary'));
  await t.throwsAsync(() => E(response.reader).next(), {
    message: /Provider request failed/,
  });
  await Promise.resolve();
  t.true(lease.cancelled());
});

test('stream delivers UTF8 intact and checks revocation on every pull', async t => {
  const lease = streamingSetup([`${'a'.repeat(20)}😀`, 'z'.repeat(20)]);
  const response = await E(lease.endpoint).requestStream(request);
  t.is(response.contentType, 'application/json');
  const first = await E(response.reader).next();
  t.false(first.done);
  await E(lease.admin).revoke();
  await t.throwsAsync(() => E(response.reader).next(), {
    message: /Provider request failed/,
  });
  t.true(lease.cancelled());
});

test('stream preserves buffered content and yields EOF after final held suffix', async t => {
  const input = ['hello 😀', ' world!', 'x'.repeat(25)];
  const lease = streamingSetup([...input]);
  const response = await E(lease.endpoint).requestStream(request);
  let output = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await E(response.reader).next();
    if (chunk.done) break;
    output += chunk.value;
  }
  t.is(output, input.join(''));
});

test('stream enforces response quota and rejects encoded credential across chunks', async t => {
  for (const chunks of [
    ['x'.repeat(101)],
    [btoa(credential).slice(0, 8), btoa(credential).slice(8)],
  ]) {
    const lease = streamingSetup(chunks);
    // eslint-disable-next-line no-await-in-loop
    const response = await E(lease.endpoint).requestStream(request);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(response.reader).next(), {
      message: /Provider request failed/,
    });
    t.true(lease.cancelled());
  }
});

test('cancel suppresses a pending delivery even if upstream ignores cancellation', async t => {
  t.timeout(1000);
  /** @type {(chunk: {done:boolean,value:string}) => void} */
  let deliver = () => {};
  const pending = new Promise(resolve => {
    deliver = resolve;
  });
  const lease = makeProviderBrokerLease(policy, {
    secret: Far('secret', {
      async readBase64() {
        return btoa(credential);
      },
    }),
    transport: Far('transport', {
      async request() {
        return harden({ status: 200, body: '' });
      },
      async requestStream() {
        return harden({
          status: 200,
          reader: Far('reader', {
            async next() {
              return pending;
            },
            return() {},
          }),
        });
      },
    }),
    now: () => 0,
  });
  const response = await E(lease.endpoint).requestStream(request);
  const pull = E(response.reader).next();
  await E(response.reader).return();
  deliver(harden({ done: false, value: 'x'.repeat(40) }));
  await t.throwsAsync(pull, { message: /Provider request failed/ });
});

for (const termination of ['return', 'read failure', 'invalid status', 'EOF']) {
  test(`terminated stream is released after ${termination}`, async t => {
    let returns = 0;
    const upstream = Far('upstream reader', {
      async next() {
        if (termination === 'read failure') throw Error('upstream failed');
        return harden({ done: true, value: '' });
      },
      return() {
        returns += 1;
      },
      getReturnCount() {
        return returns;
      },
    });
    const lease = makeProviderBrokerLease(policy, {
      secret: Far('secret', {
        async readBase64() {
          return btoa(credential);
        },
      }),
      transport: Far('transport', {
        async request() {
          return harden({ status: 200, body: '' });
        },
        async requestStream() {
          return harden({
            status: termination === 'invalid status' ? 500 : 200,
            reader: upstream,
          });
        },
      }),
      now: () => 0,
    });
    if (termination === 'invalid status') {
      await t.throwsAsync(() => E(lease.endpoint).requestStream(request), {
        message: /Provider request failed/,
      });
    } else {
      const response = await E(lease.endpoint).requestStream(request);
      if (termination === 'return') {
        await E(response.reader).return();
        await E(response.reader).return();
      } else if (termination === 'read failure') {
        await t.throwsAsync(() => E(response.reader).next(), {
          message: /Provider request failed/,
        });
        await E(response.reader).return();
      } else {
        t.true((await E(response.reader).next()).done);
        await E(response.reader).return();
      }
    }
    await E(lease.admin).revoke();
    await E(lease.admin).revoke();
    // Drain eventual sends to the same upstream target before checking count.
    t.is(await E(upstream).getReturnCount(), termination === 'EOF' ? 0 : 1);
  });
}

const oauthLimits = harden({
  authMode: /** @type {const} */ ('oauth'),
  accountRef: 'account-1',
});

test('oauth mode presents the access token and never the refresh token', async t => {
  const { endpoint, calls, exchanges } = setup({
    limits: oauthLimits,
    oauth: true,
  });
  await E(endpoint).request(request);
  t.deepEqual(calls[0].headers, {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  });
  // A credential that is still good is not exchanged, and the refresh token
  // never leaves the broker.
  t.is(exchanges.length, 0);
  t.false(
    `${JSON.stringify(calls[0].headers)}${calls[0].body}`.includes(
      refreshToken,
    ),
  );
});

test('an expiring credential is refreshed and rotated before the turn is dispatched', async t => {
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    state: oauthState({ expiresAt: 10_000 }),
  });
  await E(lease.endpoint).request(request);
  t.is(lease.exchanges.length, 1);
  t.deepEqual(lease.exchanges[0], {
    refreshToken,
    accountId: 'account-1',
  });
  // The turn carries the refreshed token, and the rotated state is durable, so
  // the next request and every other lease over the same record see it too.
  t.is(lease.calls[0].headers.authorization, `Bearer ${accessToken}-1`);
  t.is(lease.rotations.length, 1);
  t.is(lease.stored().accessToken, `${accessToken}-1`);
  // Refreshing is not an inference request and spends none of that quota.
  t.is((await E(lease.admin).getStatus()).requests, 1n);
  t.deepEqual(
    lease.audit.map(entry => entry.event),
    ['admitted', 'refreshed', 'completed'],
  );
});

test('concurrent turns share one refresh rather than racing the rotation', async t => {
  let release = () => {};
  const held = new Promise(resolve => {
    release = resolve;
  });
  const lease = setup({
    limits: { ...oauthLimits, maxRequests: 4n, maxCostMicrounits: 100n },
    oauth: true,
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      await held;
      return oauthState({ accessToken: `${accessToken}-once` });
    },
  });
  const first = E(lease.endpoint).request(request);
  const second = E(lease.endpoint).request(request);
  release(undefined);
  await Promise.all([first, second]);
  // One exchange, one write-back: a provider that invalidates the old refresh
  // token on use would have revoked the session had both turns exchanged it.
  t.is(lease.exchanges.length, 1);
  t.is(lease.rotations.length, 1);
  t.deepEqual(
    lease.calls.map(call => call.headers.authorization),
    [`Bearer ${accessToken}-once`, `Bearer ${accessToken}-once`],
  );
});

test('a credential rejected mid-session is refreshed once and the turn survives', async t => {
  let attempts = 0;
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    respond: async () => {
      attempts += 1;
      if (attempts === 1) throw Error('Provider credential rejected');
      return { status: 200, body: 'ok' };
    },
  });
  t.deepEqual(await E(lease.endpoint).request(request), {
    status: 200,
    body: 'ok',
  });
  t.is(lease.exchanges.length, 1);
  t.is(lease.calls[0].headers.authorization, `Bearer ${accessToken}`);
  t.is(lease.calls[1].headers.authorization, `Bearer ${accessToken}-1`);
  // One turn, one reservation: the retry rides the admission already granted.
  t.is((await E(lease.admin).getStatus()).requests, 1n);
  t.deepEqual(
    lease.audit.map(entry => entry.event),
    ['admitted', 'credential-rejected', 'refreshed', 'completed'],
  );
});

test('the refreshed retry is not itself retried', async t => {
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    respond: async () => {
      throw Error('Provider credential rejected');
    },
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(lease.exchanges.length, 1);
  t.is(lease.calls.length, 2);
});

test('an api-key lease never refreshes on a rejected credential', async t => {
  const lease = setup({
    respond: async () => {
      throw Error('Provider credential rejected');
    },
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(lease.calls.length, 1);
});

test('a refresh that moves the account or cannot happen fails closed', async t => {
  const moved = setup({
    limits: oauthLimits,
    oauth: true,
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => oauthState({ accountId: 'account-2' }),
  });
  await t.throwsAsync(() => E(moved.endpoint).request(request), {
    message: /Provider request failed/,
  });
  // Nothing was dispatched and nothing was written back under the other
  // account's credential.
  t.is(moved.calls.length, 0);
  t.is(moved.rotations.length, 0);
  t.deepEqual(
    moved.audit.map(entry => entry.event),
    ['admitted', 'refresh-failed', 'failed'],
  );

  // A stored credential that already names another account is refused before
  // any exchange is attempted.
  const foreign = setup({
    limits: oauthLimits,
    oauth: true,
    state: oauthState({ accountId: 'account-2' }),
  });
  await t.throwsAsync(() => E(foreign.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(foreign.exchanges.length, 0);

  // An expired credential with nothing to exchange cannot be recovered.
  const stranded = setup({
    limits: oauthLimits,
    oauth: true,
    state: harden({
      version: 'BrokerOAuthStateV1',
      accessToken,
      expiresAt: 10_000,
      accountId: 'account-1',
    }),
  });
  await t.throwsAsync(() => E(stranded.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(stranded.calls.length, 0);
});

test('a malformed oauth state is refused rather than sent upstream', async t => {
  for (const state of [
    { version: 'BrokerOAuthStateV2' },
    oauthState({ accessToken: 'has space' }),
    oauthState({ accessToken: '' }),
    oauthState({ refreshToken: 'has space' }),
    oauthState({ expiresAt: 'soon' }),
    oauthState({ accountId: '' }),
  ]) {
    const lease = setup({
      limits: oauthLimits,
      oauth: true,
      state: harden(state),
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(lease.endpoint).request(request), {
      message: /Provider request failed/,
    });
    t.is(lease.calls.length, 0);
  }
  // A bare bearer where a state document belongs is not silently accepted.
  const bare = setup({
    limits: oauthLimits,
    oauth: true,
    read: async () => globalThis.btoa(credential),
  });
  await t.throwsAsync(() => E(bare.endpoint).request(request), {
    message: /Provider request failed/,
  });
});

test('neither oauth token escapes through a response that echoes it', async t => {
  for (const echo of [
    accessToken,
    refreshToken,
    globalThis.btoa(accessToken),
  ]) {
    const lease = setup({
      limits: oauthLimits,
      oauth: true,
      respond: async () => ({ status: 200, body: `leak:${echo}` }),
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(lease.endpoint).request(request), {
      message: /Provider request failed/,
    });
  }
});

test('operator supplies Anthropic beta capabilities without caller headers', async t => {
  const { endpoint, calls } = setup({
    limits: {
      anthropicVersion: '2023-06-01',
      anthropicBeta: 'oauth-2026-01-01,context-management-2025-06-27',
    },
  });
  await E(endpoint).request(request);
  t.deepEqual(calls[0].headers, {
    authorization: `Bearer ${credential}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2026-01-01,context-management-2025-06-27',
    'content-type': 'application/json',
  });
  for (const anthropicBeta of [
    'oauth\r\nInjected: yes',
    'oauth, spaced',
    '',
    ',leading',
  ]) {
    t.throws(() => setup({ limits: { anthropicBeta } }), {
      message: /Invalid Anthropic beta capabilities/,
    });
  }
});
