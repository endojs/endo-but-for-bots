// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { Fail } from '@endo/errors';

import {
  makeBrokerOAuthCredential,
  makeProviderBrokerLease,
} from '../src/provider-broker.js';

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
 * Build the shared powers behind one secret record: the store the rotate
 * capability writes and the read facet reads back, plus a token endpoint that
 * models a provider with refresh-token rotation and replay detection.
 *
 * Shared deliberately, so a test can put two leases over one record and see
 * whether they redeem the same refresh token.
 *
 * @param {object} [options]
 * @param {any} [options.state]
 * @param {string} [options.rawStored] - Base64 to seed the record with, for
 * the cases where what is stored is not a state document at all.
 * @param {(request: any) => Promise<any>} [options.exchange]
 * @param {string} [options.accountRef]
 * @param {() => number} [options.now]
 * @param {number} [options.refreshSkewMs]
 */
const makeRecord = ({
  state,
  rawStored,
  exchange,
  accountRef = 'account-1',
  now = () => 0,
  refreshSkewMs,
} = {}) => {
  const exchanges = [];
  const rotations = [];
  // Every `ifGeneration` the broker pinned, so a test can assert the value it
  // named rather than only that a write happened.
  const pins = [];
  const spentTokens = new Set();
  let stored =
    rawStored ?? globalThis.btoa(JSON.stringify(state ?? oauthState()));
  // The record's generation, as the secret manager keeps it: incremented by
  // every replacement, so a conditional write can name the version it read.
  let generation = 1n;
  const facets = {
    exchanges,
    rotations,
    pins,
    stored: () => JSON.parse(globalThis.atob(stored)),
    generation: () => generation,
    // An operator replacing the record out from under the broker.
    replace: next => {
      stored = globalThis.btoa(JSON.stringify(next));
      generation += 1n;
    },
    secret: Far('secret', {
      // Both, as a real `SecretBlob` has: the api-key path reads the plain
      // form, the OAuth credential the generation-carrying one.
      async readBase64() {
        return stored;
      },
      async readBase64WithGeneration() {
        return harden({ base64: stored, generation });
      },
    }),
    refresh: Far('refresh', {
      async refresh(exchangeRequest) {
        exchanges.push(exchangeRequest);
        if (exchange) return exchange(exchangeRequest);
        // Replay detection, as a rotating provider implements it: presenting a
        // refresh token twice is a breach signal, not a retry.
        !spentTokens.has(exchangeRequest.refreshToken) ||
          Fail`refresh token replayed`;
        spentTokens.add(exchangeRequest.refreshToken);
        return oauthState({
          accessToken: `${accessToken}-${exchanges.length}`,
          refreshToken: `${refreshToken}-${exchanges.length}`,
        });
      },
    }),
    rotate: Far('rotate', {
      async replaceBase64(base64, options) {
        pins.push(options?.ifGeneration);
        // The manager refuses a conditional write whose generation moved.
        options?.ifGeneration === undefined ||
          options.ifGeneration === generation ||
          Fail`Secret operation failed: "GENERATION_CONFLICT"`;
        rotations.push(base64);
        stored = base64;
        generation += 1n;
        // The generation the write committed, as `SecretAdmin.replaceBase64`
        // reports it. This fake increments by one exactly as the manager does,
        // so no test here can tell a broker that uses this value from one that
        // guesses `read + 1n`; the reason to use it is that the guess encodes
        // the manager's increment in every caller that stages a write, not
        // that this suite can catch it.
        return generation;
      },
    }),
  };
  // Deliberately not hardened: `exchanges` and `rotations` are the test's
  // mutable observation log.
  // One credential per record, as production builds it, so that two leases
  // over this record share the guard rather than each getting their own.
  // `recreate` builds another over the same stored bytes, which is what a
  // broker restart or a re-provisioned owner amounts to: everything the old
  // one held in memory is gone, and only the record remains.
  const build = () =>
    makeBrokerOAuthCredential({
      secret: facets.secret,
      refresh: facets.refresh,
      rotate: facets.rotate,
      accountRef,
      now,
      ...(refreshSkewMs === undefined ? {} : { refreshSkewMs }),
    });
  return { ...facets, recreate: build, credential: build() };
};

/**
 * @param {object} [options]
 * @param {Partial<BrokerPolicy>} [options.limits]
 * @param {(r: any) => Promise<any>} [options.respond]
 * @param {(r: any) => Promise<any>} [options.respondStream]
 * @param {() => Promise<string>} [options.read]
 * @param {boolean} [options.oauth] - Provision the refreshing credential.
 * @param {any} [options.state] - Initial OAuth state when `oauth` is set.
 * @param {string} [options.rawStored] - Raw base64 to seed the record with.
 * @param {(request: any) => Promise<any>} [options.exchange] - Token endpoint.
 * @param {any} [options.record] - An existing record to share.
 * @param {() => number} [options.clock] - A clock shared between leases.
 */
const setup = ({
  limits = {},
  respond = async () => ({ status: 200, body: 'ok' }),
  respondStream,
  read,
  oauth = false,
  state,
  rawStored,
  exchange,
  record: shared,
  clock,
} = {}) => {
  const calls = [];
  const audit = [];
  let time = 0;
  const now = clock ?? (() => time);
  const record = oauth
    ? (shared ?? makeRecord({ state, rawStored, exchange, now }))
    : undefined;
  const transport = Far('transport', {
    async request(r) {
      calls.push(r);
      return respond(r);
    },
    async requestStream(r) {
      calls.push(r);
      return respondStream ? respondStream(r) : respond(r);
    },
  });
  const powers = {
    secret: record
      ? record.secret
      : Far('secret', {
          readBase64: read ?? (async () => globalThis.btoa(credential)),
        }),
    transport,
    now,
    audit: event => {
      audit.push(event);
    },
  };
  if (record) Object.assign(powers, { credential: record.credential });
  const lease = makeProviderBrokerLease({ ...policy, ...limits }, powers);
  return {
    ...lease,
    calls,
    audit,
    record,
    exchanges: record ? record.exchanges : [],
    rotations: record ? record.rotations : [],
    pins: record ? record.pins : [],
    stored: () => /** @type {any} */ (record).stored(),
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
  // Two writes, in order: the intent that says a refresh token is about to be
  // presented, then the result that both stores the new tokens and clears the
  // mark. Nothing is left saying an exchange is outstanding.
  t.is(lease.rotations.length, 2);
  t.like(JSON.parse(globalThis.atob(lease.rotations[0])), {
    accessToken,
    pendingRefresh: { startedAt: 0 },
  });
  t.is(lease.stored().accessToken, `${accessToken}-1`);
  t.is(lease.stored().pendingRefresh, undefined);
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
    release = () => resolve(undefined);
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
  release();
  await Promise.all([first, second]);
  // One exchange, one intent and one write-back: a provider that invalidates
  // the old refresh token on use would have revoked the session had both turns
  // exchanged it.
  t.is(lease.exchanges.length, 1);
  t.is(lease.rotations.length, 2);
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
  // Nothing was dispatched and no credential under the other account was
  // written back. The one write is the intent, which is deliberately still
  // there: the refresh token really was presented, so the record must go on
  // saying so.
  t.is(moved.calls.length, 0);
  t.is(moved.rotations.length, 1);
  t.like(moved.stored(), { accessToken, pendingRefresh: { startedAt: 0 } });
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
    oauthState(/** @type {any} */ ({ expiresAt: 'soon' })),
    oauthState({ accountId: '' }),
    // An unreadable mark is the one field whose meaning is "refuse to
    // exchange", so a shape this code cannot interpret fails the document
    // rather than being dropped on the way to the check that reads it.
    oauthState(/** @type {any} */ ({ pendingRefresh: true })),
    oauthState(/** @type {any} */ ({ pendingRefresh: {} })),
    oauthState(/** @type {any} */ ({ pendingRefresh: { startedAt: 'now' } })),
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
    rawStored: globalThis.btoa(credential),
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

test('two leases over one record never redeem the same refresh token', async t => {
  // The refresh token belongs to the record, not to a session. A guard that
  // lived on the lease would let each of these exchange it, and the fake token
  // endpoint refuses a replayed token the way a rotating provider does.
  const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
  const first = setup({ limits: oauthLimits, oauth: true, record });
  const second = setup({ limits: oauthLimits, oauth: true, record });
  const [a, b] = await Promise.all([
    E(first.endpoint).request(request),
    E(second.endpoint).request(request),
  ]);
  t.deepEqual(
    [a, b],
    [
      { status: 200, body: 'ok' },
      { status: 200, body: 'ok' },
    ],
  );
  t.is(record.exchanges.length, 1);
  t.is(record.rotations.length, 2);
  t.deepEqual(
    record.exchanges.map(entry => entry.refreshToken),
    [refreshToken],
  );
  // Both sessions ran on the one credential the exchange produced.
  t.deepEqual(
    [...first.calls, ...second.calls].map(call => call.headers.authorization),
    [`Bearer ${accessToken}-1`, `Bearer ${accessToken}-1`],
  );
});

test('the guard re-reads, so a credential refreshed elsewhere is not re-exchanged', async t => {
  // The single-flight guard re-reads the record before exchanging. Without
  // that, a caller whose first read saw a spent credential would redeem a
  // refresh token another holder had already spent — the replay this guard
  // exists to prevent.
  const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
  let reads = 0;
  // The credential reads the record twice per refresh: once for the caller,
  // once inside the guard. Another holder installs a fresh credential in
  // between.
  const watched = Far('secret', {
    async readBase64() {
      return E(record.secret).readBase64();
    },
    async readBase64WithGeneration() {
      reads += 1;
      if (reads === 2) {
        record.replace(oauthState({ accessToken: 'refreshed-elsewhere' }));
      }
      return E(record.secret).readBase64WithGeneration();
    },
  });
  const calls = [];
  const credentialOverWatched = makeBrokerOAuthCredential({
    secret: watched,
    refresh: record.refresh,
    rotate: record.rotate,
    accountRef: 'account-1',
    now: () => 0,
  });
  const lease = makeProviderBrokerLease(
    { ...policy, ...oauthLimits },
    {
      secret: record.secret,
      transport: Far('transport', {
        async request(r) {
          calls.push(r);
          return { status: 200, body: 'ok' };
        },
      }),
      now: () => 0,
      credential: credentialOverWatched,
    },
  );
  await E(lease.endpoint).request(request);
  // The guard saw the fresher credential and did not exchange at all.
  t.is(record.exchanges.length, 0);
  t.is(record.rotations.length, 0);
  t.is(reads, 2);
  t.is(calls[0].headers.authorization, 'Bearer refreshed-elsewhere');
});

test('a refresh that omits the refresh token keeps the stored one', async t => {
  // RFC 6749 section 6 makes it optional: omitting it means "keep the one you
  // have". Persisting the response verbatim would strand the record.
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () =>
      harden({
        version: 'BrokerOAuthStateV1',
        accessToken: 'rotated-access',
        expiresAt: 1_000_000,
        accountId: 'account-1',
      }),
  });
  await E(lease.endpoint).request(request);
  t.is(lease.stored().accessToken, 'rotated-access');
  t.is(lease.stored().refreshToken, refreshToken);
});

test('a refresh response cannot store a mark of its own', async t => {
  // The mark is this broker's bookkeeping about its own dispatch. Persisting
  // an echoed one would commit a credential that refuses its own next refresh,
  // with nothing but an operator re-grant to clear it — an upstream field
  // turned into a denial of service on the record.
  const record = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () =>
      harden({
        ...oauthState({ accessToken: 'rotated-access' }),
        pendingRefresh: { startedAt: 5 },
      }),
  });
  const lease = setup({ limits: oauthLimits, oauth: true, record });
  await E(lease.endpoint).request(request);
  t.is(record.stored().accessToken, 'rotated-access');
  t.is(record.stored().pendingRefresh, undefined);
  // And the document the commit stored is genuinely unlocked, not merely
  // missing the field: refusing the credential it holds forces an exchange
  // against that very document, which a stored mark would refuse.
  const { outcome } = await E(record.credential).current(
    harden({ rejected: 'rotated-access' }),
  );
  t.is(outcome, 'refreshed');
});

test('a refresh that does not advance expiry is refused', async t => {
  // Otherwise every subsequent request refreshes again, silently, forever.
  const lease = setup({
    limits: { ...oauthLimits, maxRequests: 4n, maxCostMicrounits: 100n },
    oauth: true,
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => oauthState({ expiresAt: 10_000 }),
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(lease.calls.length, 0);
  // The one write is the intent; the bad state was refused rather than
  // persisted, so the record still holds the original token — now marked,
  // because that token has been presented.
  t.is(lease.rotations.length, 1);
  t.is(lease.stored().refreshToken, refreshToken);
  t.like(lease.stored().pendingRefresh, { startedAt: 0 });
  t.is(lease.exchanges.length, 1);

  // But the provider already consumed that token when it answered. A second
  // request must not present it again: the exchange succeeded, only the
  // validation after it failed, and every check between the exchange and a
  // committed write sits in that window.
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(lease.exchanges.length, 1);
});

test('a validation failure after a successful exchange still fences the token', async t => {
  await null;
  // Every check between the exchange and a committed write is in the window
  // where the token is spent but nothing has stored the result.
  for (const exchange of [
    // Names another account.
    async () => oauthState({ accountId: 'account-2' }),
    // Not a state document at all.
    async () => harden({ nonsense: true }),
    // A token that is header-unsafe.
    async () => oauthState({ accessToken: 'has space' }),
  ]) {
    const record = makeRecord({
      state: oauthState({ expiresAt: 10_000 }),
      exchange,
    });
    const lease = setup({ limits: oauthLimits, oauth: true, record });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(lease.endpoint).request(request), {
      message: /Provider request failed/,
    });
    t.is(record.exchanges.length, 1);
    // Only the intent: nothing that failed validation was stored.
    t.is(record.rotations.length, 1);
    t.like(record.stored().pendingRefresh, { startedAt: 0 });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(lease.endpoint).request(request), {
      message: /Provider request failed/,
    });
    t.is(record.exchanges.length, 1);
    // And the refusal is in the record rather than in this process, so an
    // owner rebuilt over the same bytes refuses too. The in-memory fence this
    // replaced was cleared by exactly the restart a stuck refresh provokes.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(record.recreate()).current(harden({})), {
      message: /Broker credential consumed/,
    });
    t.is(record.exchanges.length, 1);
  }
});

test('a refresh that may have been dispatched fences; one that provably was not does not', async t => {
  // A rejection cannot be assumed to leave the token unspent: a lost response
  // or a timeout may well have consumed it.
  const ambiguous = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      throw Error('token endpoint unavailable');
    },
  });
  const first = setup({ limits: oauthLimits, oauth: true, record: ambiguous });
  await t.throwsAsync(() => E(first.endpoint).request(request), {
    message: /Provider request failed/,
  });
  await t.throwsAsync(() => E(first.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(ambiguous.exchanges.length, 1);

  // An authority that can prove the request never left says so, and the token
  // is still good to present.
  const undispatched = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      throw Error('Refresh not dispatched');
    },
  });
  const second = setup({
    limits: oauthLimits,
    oauth: true,
    record: undispatched,
  });
  await t.throwsAsync(() => E(second.endpoint).request(request), {
    message: /Provider request failed/,
  });
  await t.throwsAsync(() => E(second.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(undispatched.exchanges.length, 2);
});

test('a forbidden request is not treated as a rejected credential', async t => {
  // A 403 is the upstream refusing this request, not the token. Refreshing on
  // it would let a slice that can reproduce one turn every admitted request
  // into a second dispatch, an exchange and a secret write.
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    respond: async () => {
      throw Error('Provider transport failed');
    },
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(lease.calls.length, 1);
  t.is(lease.exchanges.length, 0);
  t.is(lease.rotations.length, 0);
});

test('a retry does not unscreen the token the first attempt already sent', async t => {
  // The first attempt handed its token to the upstream, so a response screened
  // only against the second one could deliver the first back to the slice.
  let attempts = 0;
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    respond: async () => {
      attempts += 1;
      if (attempts === 1) throw Error('Provider credential rejected');
      return { status: 200, body: `echo:${accessToken}` };
    },
  });
  await t.throwsAsync(() => E(lease.endpoint).request(request), {
    message: /Provider request failed/,
  });
  t.is(lease.calls.length, 2);
});

test('a streaming oauth turn refreshes, retries and screens both tokens', async t => {
  let attempts = 0;
  const chunks = ['hel', 'lo'];
  const lease = setup({
    limits: oauthLimits,
    oauth: true,
    respondStream: async () => {
      attempts += 1;
      if (attempts === 1) throw Error('Provider credential rejected');
      return harden({
        status: 200,
        reader: Far('reader', {
          async next() {
            const value = chunks.shift();
            return harden({ done: value === undefined, value: value ?? '' });
          },
          return() {},
        }),
      });
    },
  });
  const response = await E(lease.endpoint).requestStream(request);
  t.is(response.status, 200);
  let text = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await E(response.reader).next();
    text += chunk.value;
    if (chunk.done) break;
  }
  t.is(text, 'hello');
  t.deepEqual(
    lease.calls.map(call => call.headers.authorization),
    [`Bearer ${accessToken}`, `Bearer ${accessToken}-1`],
  );
  t.deepEqual(
    lease.audit.map(entry => entry.event),
    ['admitted', 'credential-rejected', 'refreshed', 'completed'],
  );

  // And the streaming screen covers the token the first attempt sent.
  const leaked = setup({
    limits: oauthLimits,
    oauth: true,
    respondStream: async () =>
      harden({
        status: 200,
        reader: Far('reader', {
          async next() {
            return harden({ done: false, value: `x${accessToken}x` });
          },
          return() {},
        }),
      }),
  });
  const stream = await E(leaked.endpoint).requestStream(request);
  await t.throwsAsync(() => E(stream.reader).next(), {
    message: /Provider request failed/,
  });
});

test('a shared credential refuses a state whose account is not the bound one', t => {
  const record = makeRecord();
  t.throws(
    () =>
      makeBrokerOAuthCredential({
        secret: record.secret,
        refresh: record.refresh,
        rotate: record.rotate,
        accountRef: '',
        now: () => 0,
      }),
    { message: /Invalid broker account binding/ },
  );
  for (const missing of ['secret', 'refresh', 'rotate']) {
    t.throws(
      () =>
        makeBrokerOAuthCredential({
          secret: record.secret,
          refresh: record.refresh,
          rotate: record.rotate,
          accountRef: 'account-1',
          now: () => 0,
          [missing]: undefined,
        }),
      { message: /Unprovisioned broker OAuth credential/ },
    );
  }
  // A lease may not be handed a credential bound to another account.
  t.throws(
    () =>
      setup({
        limits: { ...oauthLimits, accountRef: 'account-2' },
        oauth: true,
        record,
      }),
    { message: /Unprovisioned broker OAuth mode/ },
  );
});

test('an operator replacement during an exchange is not overwritten', async t => {
  // The window Tokyo's trial reproduced against the real secret manager: a
  // refresh in flight, an operator installing a new grant, and an
  // unconditional write landing afterwards.
  let release = () => {};
  const held = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let started = () => {};
  const begun = new Promise(resolve => {
    started = () => resolve(undefined);
  });
  const record = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      started();
      await held;
      return oauthState({ accessToken: 'from-stale-exchange' });
    },
  });
  const lease = setup({ limits: oauthLimits, oauth: true, record });
  const pending = E(lease.endpoint).request(request);
  // Wait until the exchange is actually in flight, so the broker has already
  // read generation 1. Replacing before that would simply be read normally and
  // would prove nothing.
  await begun;
  record.replace(
    oauthState({
      accessToken: 'operator-regrant',
      refreshToken: 'operator-refresh',
    }),
  );
  release();
  await pending;
  // The stale exchange never displaced the operator's grant, and the turn ran
  // on the credential that is actually stored rather than on one nothing kept.
  // The exchange really did run and really was refused: without this, the
  // test would also pass if the replacement had simply landed before the
  // broker's first read, which is a different and much weaker scenario.
  t.is(record.exchanges.length, 1);
  // The intent pinned generation 1 and committed generation 2; the operator's
  // replacement moved the record to 3, so the completion pinned to 2 was
  // refused rather than overwriting it. Only the intent was ever written.
  t.deepEqual(record.pins, [1n, 2n]);
  t.is(record.stored().accessToken, 'operator-regrant');
  t.is(record.rotations.length, 1);
  t.is(lease.calls[0].headers.authorization, 'Bearer operator-regrant');
  t.deepEqual(
    lease.audit.map(entry => entry.event),
    ['admitted', 'refresh-discarded', 'completed'],
  );
});

test('a replacement that is itself mid-exchange is not adopted', async t => {
  // The adopt path exists because a conflicting write means someone stored
  // something newer, and newer is usually better. Not when what they stored is
  // another exchange's mark: adopting that would hand out a credential whose
  // own refresh is unresolved, and clear nothing.
  let release = () => {};
  const held = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let started = () => {};
  const begun = new Promise(resolve => {
    started = () => resolve(undefined);
  });
  const record = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      started();
      await held;
      return oauthState({ accessToken: 'from-stale-exchange' });
    },
  });
  const pending = E(record.credential).current(harden({}));
  await begun;
  // An operator restoring a snapshot that was taken mid-refresh. Everything
  // else about it is fine — the expiry is far off, the account matches — so
  // the mark is the only thing that can refuse it.
  record.replace(
    harden({
      ...oauthState({ accessToken: 'marked-restore' }),
      pendingRefresh: { startedAt: 1 },
    }),
  );
  release();
  await t.throwsAsync(() => pending, {
    message: /Broker credential rotation failed/,
  });
  t.is(record.stored().accessToken, 'marked-restore');
  t.is(record.rotations.length, 1);
});

test('the undo for a request that never left needs no further read', async t => {
  // It names the generation its own mark committed, so it is one write and no
  // read. Recognising the mark by its bytes instead would need a read that can
  // fail — and failing it leaves a live credential locked over a token nothing
  // ever presented, which is the exact outcome this undo exists to avoid.
  // Seeded with a document whose keys are in an order the validator's
  // projection does not reproduce, so "restores the bytes that were there"
  // and "restores a re-serialization of them" are distinguishable.
  const seeded = globalThis.btoa(
    JSON.stringify({
      accountId: 'account-1',
      expiresAt: 10_000,
      refreshToken,
      accessToken,
      version: 'BrokerOAuthStateV1',
    }),
  );
  const record = makeRecord({
    rawStored: seeded,
    exchange: async () => {
      throw Error('Refresh not dispatched');
    },
  });
  let reads = 0;
  const blind = makeBrokerOAuthCredential({
    // Serves the two reads an exchange makes and refuses anything after.
    secret: Far('secret', {
      async readBase64WithGeneration() {
        reads += 1;
        reads <= 2 || Fail`Secret operation failed: "STALE_READ"`;
        return E(record.secret).readBase64WithGeneration();
      },
    }),
    refresh: record.refresh,
    rotate: record.rotate,
    accountRef: 'account-1',
    now: () => 0,
  });
  await t.throwsAsync(() => E(blind).current(harden({})), {
    message: /Refresh not dispatched/,
  });
  t.is(record.exchanges.length, 1);
  // Marked, then unmarked: two writes, and the record is back to the grant it
  // held — byte for byte, not as this broker version would have re-serialized
  // it. Restoring a re-serialization would silently rewrite an operator's
  // document, and would drop any field a later schema adds that this one does
  // not know to carry.
  t.is(record.rotations.length, 2);
  t.is(record.rotations[1], seeded);
  t.is(record.stored().pendingRefresh, undefined);
  t.is(record.stored().refreshToken, refreshToken);
});

test('a losing intent write does not undo the mark that beat it', async t => {
  // The one-credential-per-record invariant violated on purpose, because that
  // is the case the generation pin exists to bound. Two holders that read the
  // same generation write the same mark — same state, same clock, so the same
  // bytes — and only one write can land. The loser must leave the winner's
  // mark alone: undoing it by recognising its own bytes in it would clear the
  // fence of an exchange that is at that moment presenting the token, which is
  // the replay the whole protocol exists to prevent.
  let letLoserWrite = () => {};
  const loserParked = new Promise(resolve => {
    letLoserWrite = () => resolve(undefined);
  });
  let loserRead = () => {};
  const loserHasRead = new Promise(resolve => {
    loserRead = () => resolve(undefined);
  });
  let releaseWinner = () => {};
  const winnerHeld = new Promise(resolve => {
    releaseWinner = () => resolve(undefined);
  });
  let winnerDispatched = () => {};
  const winnerAtProvider = new Promise(resolve => {
    winnerDispatched = () => resolve(undefined);
  });
  const record = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      winnerDispatched();
      await winnerHeld;
      return oauthState({ accessToken: 'winner-access' });
    },
  });
  let parked = true;
  const loser = makeBrokerOAuthCredential({
    secret: record.secret,
    refresh: record.refresh,
    rotate: Far('rotate', {
      async replaceBase64(base64, options) {
        await null;
        if (parked) {
          parked = false;
          loserRead();
          await loserParked;
        }
        return E(record.rotate).replaceBase64(base64, options);
      },
    }),
    accountRef: 'account-1',
    now: () => 0,
  });

  // The loser has read generation 1 and is about to write its mark.
  const losing = E(loser).current(harden({}));
  await loserHasRead;
  // The winner reads the same generation 1, writes its mark, and is now at the
  // token endpoint with the refresh token in flight.
  const winning = E(record.credential).current(harden({}));
  await winnerAtProvider;
  // Only now does the loser's write reach the record, where it is refused.
  letLoserWrite();
  await t.throwsAsync(() => losing, { message: /GENERATION_CONFLICT/ });

  // The winner's mark is still standing, so nothing else can exchange while
  // its token is outstanding.
  t.like(record.stored().pendingRefresh, { startedAt: 0 });
  t.is(record.exchanges.length, 1);
  releaseWinner();
  // And the winner can still commit, because its pin is still the newest
  // generation: the loser wrote nothing at all.
  const { outcome } = await winning;
  t.is(outcome, 'refreshed');
  t.is(record.stored().accessToken, 'winner-access');
  t.is(record.stored().pendingRefresh, undefined);
});

test('an intent that cannot be recorded means nothing is dispatched', async t => {
  // Write-ahead is only worth anything if the write really precedes the
  // dispatch. A broker that presented the token anyway when its mark failed
  // would have the same lost-outcome window as before, with an extra write.
  const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
  const unmarkable = makeBrokerOAuthCredential({
    secret: record.secret,
    refresh: record.refresh,
    rotate: Far('rotate', {
      async replaceBase64() {
        throw Error('secret backend unavailable');
      },
    }),
    accountRef: 'account-1',
    now: () => 0,
  });
  await t.throwsAsync(() => E(unmarkable).current(harden({})), {
    message: /secret backend unavailable/,
  });
  t.is(record.exchanges.length, 0);
  t.is(record.rotations.length, 0);
  // Nothing is fenced, because nothing was spent: the record is exactly as it
  // was, and a healthy owner over it still works.
  t.is(record.generation(), 1n);
  t.is(record.stored().pendingRefresh, undefined);
  await E(record.credential).current(harden({}));
  t.is(record.exchanges.length, 1);
});

test('an intent whose write is acknowledged late leaves the record fenced', async t => {
  // The write landed and the answer did not come back, so the mark's own
  // generation is unknown. The stored refresh token is certainly unspent —
  // nothing was dispatched — and the mark is still left standing, because the
  // only way to recognise it would be by its bytes, and those cannot
  // distinguish this credential's mark from a second holder's. Fencing a live
  // credential is the accepted cost of never guessing.
  const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
  let lose = true;
  const lossy = makeBrokerOAuthCredential({
    secret: record.secret,
    refresh: record.refresh,
    rotate: Far('rotate', {
      async replaceBase64(base64, options) {
        const generation = await E(record.rotate).replaceBase64(
          base64,
          options,
        );
        if (lose) {
          lose = false;
          throw Error('acknowledgement lost');
        }
        return generation;
      },
    }),
    accountRef: 'account-1',
    now: () => 0,
  });
  await t.throwsAsync(() => E(lossy).current(harden({})), {
    message: /acknowledgement lost/,
  });
  t.is(record.exchanges.length, 0);
  // One write: the mark, which landed and stayed.
  t.is(record.rotations.length, 1);
  t.like(record.stored().pendingRefresh, { startedAt: 0 });
  // The token it fences was never presented, and the fence holds anyway — for
  // this owner and for one rebuilt over the same record.
  t.is(record.stored().refreshToken, refreshToken);
  await t.throwsAsync(() => E(lossy).current(harden({})), {
    message: /Broker credential consumed/,
  });
  await t.throwsAsync(() => E(record.recreate()).current(harden({})), {
    message: /Broker credential consumed/,
  });
  t.is(record.exchanges.length, 0);

  // An operator re-grant is what clears it, as it is for every other fenced
  // record.
  record.replace(
    oauthState({
      accessToken: 'operator-regrant',
      refreshToken: 'operator-refresh',
      expiresAt: 10_000,
    }),
  );
  const { outcome } = await E(record.recreate()).current(harden({}));
  t.is(outcome, 'refreshed');
  t.is(record.exchanges.length, 1);
});

test('the undo for a request that never left cannot roll back a newer grant', async t => {
  // The undo names the generation its own mark committed, so an operator whose
  // re-grant landed while the token endpoint was unreachable is refused rather
  // than rolled back. Dropping that pin would make this undo an unconditional
  // write of a credential two versions stale.
  const record = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      // The operator's grant arrives in the window between the mark and the
      // undo: the request is on its way out and provably never leaves.
      record.replace(
        oauthState({
          accessToken: 'operator-regrant',
          refreshToken: 'operator-refresh',
        }),
      );
      throw Error('Refresh not dispatched');
    },
  });
  await t.throwsAsync(() => E(record.credential).current(harden({})), {
    message: /Refresh not dispatched/,
  });
  // The mark pinned generation 1 and committed 2; the operator moved the
  // record to 3, so the undo pinned to 2 was refused.
  t.deepEqual(record.pins, [1n, 2n]);
  t.is(record.stored().accessToken, 'operator-regrant');
  t.is(record.stored().refreshToken, 'operator-refresh');
});

test('an undo that cannot land leaves the mark and the original failure', async t => {
  // Best-effort means the record keeps the conservative state, and it also
  // means the caller still learns why its refresh failed rather than why the
  // undo did.
  const record = makeRecord({
    state: oauthState({ expiresAt: 10_000 }),
    exchange: async () => {
      throw Error('Refresh not dispatched');
    },
  });
  const brittle = makeBrokerOAuthCredential({
    secret: record.secret,
    refresh: record.refresh,
    rotate: Far('rotate', {
      async replaceBase64(base64, options) {
        // The mark lands; the undo that follows it does not.
        if (record.rotations.length >= 1) throw Error('backend unavailable');
        return E(record.rotate).replaceBase64(base64, options);
      },
    }),
    accountRef: 'account-1',
    now: () => 0,
  });
  await t.throwsAsync(() => E(brittle).current(harden({})), {
    message: /Refresh not dispatched/,
  });
  t.is(record.rotations.length, 1);
  t.like(record.stored().pendingRefresh, { startedAt: 0 });
});

test('a result that cannot be stored fences the record for every later owner', async t => {
  const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
  // Healthy for the intent, broken for the commit: the exact shape of a
  // refresh whose result is lost after the provider has consumed the token.
  const stranded = makeBrokerOAuthCredential({
    secret: record.secret,
    refresh: record.refresh,
    rotate: Far('rotate', {
      async replaceBase64(base64, options) {
        if (record.rotations.length >= 1) {
          throw Error('secret backend unavailable');
        }
        return E(record.rotate).replaceBase64(base64, options);
      },
    }),
    accountRef: 'account-1',
    now: () => 0,
  });
  await t.throwsAsync(() => E(stranded).current(harden({})), {
    message: /Broker credential rotation failed/,
  });
  t.is(record.exchanges.length, 1);
  t.is(record.rotations.length, 1);
  // The record still holds the token that exchange spent, and now says so.
  t.is(record.stored().refreshToken, refreshToken);
  t.like(record.stored().pendingRefresh, { startedAt: 0 });

  // Failing the request that discovered the lost write is not enough: without
  // the mark the next call re-reads the same record and presents the same
  // spent token, which is the replay that revokes the grant.
  await t.throwsAsync(() => E(stranded).current(harden({})), {
    message: /Broker credential consumed/,
  });
  t.is(record.exchanges.length, 1);

  // The refusal is in the record, so it survives the process. A fresh owner
  // over the same bytes — a restarted broker, a re-provisioned session — has a
  // working rotate capability and still must not exchange.
  await t.throwsAsync(() => E(record.recreate()).current(harden({})), {
    message: /Broker credential consumed/,
  });
  t.is(record.exchanges.length, 1);

  // An operator installing a genuinely new grant lifts it, because the record
  // no longer holds either the spent token or the mark.
  record.replace(
    oauthState({
      accessToken: 'operator-regrant',
      refreshToken: 'operator-refresh',
      expiresAt: 10_000,
    }),
  );
  const recovered = record.recreate();
  const { state } = await E(recovered).current(harden({}));
  // It exchanged again, and against the new grant's token rather than the
  // spent one.
  t.is(record.exchanges.length, 2);
  t.is(record.exchanges[1].refreshToken, 'operator-refresh');
  t.is(state.accessToken, `${accessToken}-2`);
  t.is(record.stored().pendingRefresh, undefined);
});

test('a conditional write names the generation it read', async t => {
  const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
  const lease = setup({ limits: oauthLimits, oauth: true, record });
  t.is(record.generation(), 1n);
  await E(lease.endpoint).request(request);
  // Both writes named a generation rather than being unconditional: asserting
  // only that a write happened would pass with the precondition removed. The
  // intent pinned the generation it read, and the commit pinned the one the
  // intent produced rather than re-reading to find out.
  t.deepEqual(record.pins, [1n, 2n]);
  t.is(record.rotations.length, 2);
  t.is(record.generation(), 3n);
});

test('a rotator that does not report its generation is refused before dispatch', async t => {
  // The commit pins to the generation the intent write committed. A rotator
  // that will not say what it committed leaves only a guess to pin to, and
  // guessing is how a commit ends up overwriting a grant it never read. Caught
  // while the refresh token is still unspent rather than after — the check has
  // to reject every non-generation, not merely the absent one, because a
  // `number` would otherwise reach the rotator's own `M.bigint()` guard and be
  // refused there, one step past the dispatch.
  await null;
  for (const committed of [undefined, 2, '2n', null]) {
    const record = makeRecord({ state: oauthState({ expiresAt: 10_000 }) });
    const mute = makeBrokerOAuthCredential({
      secret: record.secret,
      refresh: record.refresh,
      rotate: Far('rotate', {
        async replaceBase64(base64, options) {
          await E(record.rotate).replaceBase64(base64, options);
          return committed;
        },
      }),
      accountRef: 'account-1',
      now: () => 0,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(mute).current(harden({})), {
      message: /Broker refresh intent unusable/,
    });
    t.is(record.exchanges.length, 0);
    // The mark stays: its generation is exactly what this rotator would not
    // report, so there is nothing safe to undo it with. A misconfigured
    // rotator therefore fences the record on its first refresh, loudly and at
    // the cost of an operator re-grant, rather than quietly presenting a token
    // it cannot record the outcome of.
    t.like(record.stored().pendingRefresh, { startedAt: 0 });
  }
});

test('a clock that is not a time never reaches the stored document', async t => {
  // Reachable without a broken expiry: a refused access token makes the stored
  // credential spent whatever the clock says. A non-finite `startedAt` would
  // serialize to `null` and leave a document the validator cannot parse back,
  // so the record would report as corrupt rather than as the broken clock it
  // is — and nothing could exchange against it again.
  const record = makeRecord({ now: () => NaN });
  const broken = makeBrokerOAuthCredential({
    secret: record.secret,
    refresh: record.refresh,
    rotate: record.rotate,
    accountRef: 'account-1',
    now: () => NaN,
  });
  await t.throwsAsync(
    () => E(broken).current(harden({ rejected: accessToken })),
    { message: /Invalid broker clock/ },
  );
  t.is(record.rotations.length, 0);
  t.is(record.exchanges.length, 0);
  // Still readable, so an operator fixing the clock recovers without a
  // re-grant.
  t.is(record.stored().accessToken, accessToken);
});

test('a mark fences exchanging, not using a credential that is still good', async t => {
  // A mark says another exchange is unresolved, not that the access token is
  // bad. Every concurrent turn on the record must keep running on the token it
  // already has — hoisting the refusal to cover use as well would turn each
  // refresh into an outage for every session sharing the record.
  const record = makeRecord({
    state: harden({
      ...oauthState(),
      pendingRefresh: { startedAt: 1 },
    }),
  });
  const { state, outcome } = await E(record.credential).current(harden({}));
  t.is(outcome, 'unchanged');
  t.is(state.accessToken, accessToken);
  t.is(record.exchanges.length, 0);
  t.is(record.rotations.length, 0);
  // It is genuinely the mark that is being tolerated: once the same credential
  // is spent, the very same record refuses.
  await t.throwsAsync(
    () => E(record.credential).current(harden({ rejected: accessToken })),
    { message: /Broker credential consumed/ },
  );
  t.is(record.exchanges.length, 0);
});
