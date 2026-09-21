// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeProviderBrokerGrantIssuer } from '../src/provider-grant-issuer.js';
import { makePoolMemberLifecycle } from '../src/pool-member-lifecycle.js';

const digest = `sha256:${'a'.repeat(64)}`;
const spec = harden({
  sessionId: 'session',
  accountRef: 'account',
  providerOrigin: 'https://api.example.test',
  model: 'allowed',
});
const policy = harden({
  origin: spec.providerOrigin,
  routes: [{ method: 'POST', path: '/v1/responses' }],
  models: ['allowed'],
  maxConcurrentRequests: 4,
  maxRequestBytes: 1024n,
  maxResponseBytes: 1024n,
});

test('retiring one pool member leaves an existing auto endpoint usable by its sibling', async t => {
  const work = makePoolMemberLifecycle();
  const home = makePoolMemberLifecycle();
  let selected = ['work', 'home'];
  const sent = [];
  const issuer = makeProviderBrokerGrantIssuer({
    runtime: {},
    secret: undefined,
    policy,
    imageDigest: digest,
    accountRef: 'account',
    fetch: async (_url, init) => {
      sent.push(init.headers.authorization);
      return new Response('ok');
    },
    pool: {
      members: () =>
        [
          { id: 'work', lifecycle: work },
          { id: 'home', lifecycle: home },
        ].map(member => ({
          ...member,
          secret: Far('MemberSecret', {
            readBase64: async () => btoa(`${member.id}-key`),
          }),
        })),
      forSession: () => ({
        select: () => selected,
        served: () => {},
        exhausted: () => {},
      }),
    },
  });
  t.teardown(() => issuer.dispose());
  const endpoint = await issuer.openEndpoint({
    sessionId: 'retirement',
    subscription: 'auto',
  });
  const request = harden({
    method: 'POST',
    path: '/v1/responses',
    body: '{"model":"allowed"}',
  });
  await E(endpoint).request(request);
  await work.close();
  // Even a candidate order captured before retirement cannot reach fetch.
  await t.throwsAsync(E(endpoint).request(request));
  selected = ['home'];
  t.is((await E(endpoint).request(request)).body, 'ok');
  t.deepEqual(sent, ['Bearer work-key', 'Bearer home-key']);
});

test('member retirement waits for a late wrapped endpoint and retains failed revocation', async t => {
  const owner = makePoolMemberLifecycle();
  let finish;
  let entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const opening = new Promise(resolve => {
    finish = resolve;
  });
  let failures = true;
  let revoked = 0;
  let requests = 0;
  const far = Far('LateEndpoint', {
    request: async () => {
      requests += 1;
      return { status: 200, body: 'ok' };
    },
    revoke: async () => {
      revoked += 1;
      if (failures) throw Error('retry cleanup');
    },
  });
  const issuer = makeProviderBrokerGrantIssuer({
    runtime: {},
    secret: undefined,
    fetch: async () => new Response('unused'),
    policy,
    imageDigest: digest,
    accountRef: 'account',
    pool: {
      members: () => [
        {
          id: 'shared',
          lifecycle: owner,
          subscription: Far('Share', {
            openEndpoint: () => {
              entered();
              return opening;
            },
          }),
        },
      ],
      forSession: () => ({
        select: () => ['shared'],
        served: () => {},
        exhausted: () => {},
      }),
    },
  });
  t.teardown(() => issuer.dispose());
  const endpoint = await issuer.openEndpoint({
    sessionId: 'wrapped-retirement',
    subscription: 'auto',
  });
  const request = E(endpoint).request(
    harden({
      method: 'POST',
      path: '/v1/responses',
      body: '{"model":"allowed"}',
    }),
  );
  const failedRequest = t.throwsAsync(request);
  await started;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  const failedClose = t.throwsAsync(closing, { message: /cleanup pending/ });
  await null;
  t.false(closed);
  finish(far);
  await failedRequest;
  await failedClose;
  failures = false;
  await owner.close();
  t.true(revoked >= 2);
  t.is(requests, 0);
});

const networkEvidence = harden({
  policy: 'public-internet',
  proxyUrl: 'http://127.0.0.1:3456',
  dnsHost: '127.0.0.53',
  resolverConfigPath: '/private-runtime/public-resolv.conf',
});

/** @param {any} [options] */
const fixture = ({
  requestTimeoutMs,
  startBarrier,
  policy: policyOverride,
  credential,
  makePublicNetwork,
  observeNetwork,
  adaptRequest,
  fetch: fetchAuthority = async () => new Response('ok'),
} = {}) => {
  let stops = 0;
  let fails = false;
  let drift = false;
  let endpoint;
  let listenerLimits;
  let listenerNetwork;
  let disconnect = () => {};
  const closed = new Promise(resolve => {
    disconnect = () => resolve(undefined);
  });
  const issuer = makeProviderBrokerGrantIssuer({
    runtime: {
      startKit(input) {
        const value = (async () => {
          endpoint = input.endpoint;
          listenerLimits = input.limits;
          listenerNetwork = input.network;
          if (startBarrier) await startBarrier;
          return {
            async observe() {
              return harden({
                endpoint: 'http://127.0.0.1:1234',
                containerName: 'listener',
                networkNamespaceId: drift ? 'net-2' : 'net-1',
                listenerImageDigest: digest,
                ...(observeNetwork ? { network: observeNetwork() } : {}),
              });
            },
            async stop() {
              stops += 1;
              if (fails) throw Error('cleanup unavailable');
              disconnect();
            },
            closed,
          };
        })();
        return {
          value,
          stop: async () => {
            const worker = await value;
            await worker.stop();
          },
        };
      },
    },
    secret: Far('host-only secret', {
      async readBase64() {
        return btoa('host-secret');
      },
    }),
    fetch: fetchAuthority,
    adaptRequest,
    policy: policyOverride ?? policy,
    ...(credential === undefined ? {} : { credential }),
    ...(makePublicNetwork ? { makePublicNetwork } : {}),
    requestTimeoutMs,
    imageDigest: digest,
    accountRef: 'account',
  });
  return {
    issuer,
    endpoint: () => endpoint,
    listenerLimits: () => listenerLimits,
    listenerNetwork: () => listenerNetwork,
    stops: () => stops,
    failCleanup: () => {
      fails = true;
    },
    allowCleanup: () => {
      fails = false;
    },
    drift: () => {
      drift = true;
    },
    disconnect,
    closed,
  };
};

test('issuer carries the trusted adapter only to host-side inference', async t => {
  const calls = [];
  const f = fixture({
    adaptRequest: () => ({
      path: '/provider/responses',
      headers: { custom: 'host' },
    }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response('ok');
    },
  });
  t.teardown(f.issuer.dispose);
  const grant = await f.issuer(spec);
  const attestation = await E(grant).attestation();
  t.is(attestation.providerOrigin, spec.providerOrigin);
  t.false(Object.hasOwn(attestation, 'adaptRequest'));
  t.deepEqual(f.listenerLimits().allowedPaths, ['/v1/responses']);
  await E(f.endpoint()).request(
    harden({
      method: 'POST',
      path: '/v1/responses',
      body: '{"model":"allowed"}',
    }),
  );
  t.is(calls[0].url, 'https://api.example.test/provider/responses');
  t.is(calls[0].options.headers.custom, 'host');
  await E(grant).revoke();
  await t.throwsAsync(
    E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    { message: /inactive|disposed/ },
  );
  t.is(calls.length, 1);
});

test('authority fencing blocks inference without removing the namespace listener', async t => {
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const kit = f.issuer.issueKit(spec);
  await kit.value;
  await kit.fence();
  t.is(f.stops(), 0);
  await t.throwsAsync(
    E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    { message: /inactive|disposed/ },
  );
  await kit.revoke();
  t.is(f.stops(), 1);
});

test('public egress is lease-bound and revoked before cleanup retries', async t => {
  let disposed = 0;
  /** @type {Record<string, any> | undefined} */
  let requested;
  const endpoint = Far('Test public egress', {});
  const f = fixture({
    makePublicNetwork: request => {
      requested = request;
      return {
        endpoint,
        dispose: () => {
          disposed += 1;
        },
      };
    },
    observeNetwork: () => networkEvidence,
  });
  t.teardown(f.issuer.dispose);
  const lease = await f.issuer({ ...spec, networkPolicy: 'public-internet' });
  t.is(requested?.networkPolicy, 'public-internet');
  t.deepEqual(f.listenerNetwork(), { endpoint });
  t.deepEqual((await E(lease).attestation()).network, networkEvidence);
  t.deepEqual((await E(lease).sandboxEvidence()).network, networkEvidence);
  f.failCleanup();
  await t.throwsAsync(E(lease).revoke(), { message: /cleanup unavailable/ });
  t.true(disposed > 0);
  f.allowCleanup();
  await f.issuer.retryCleanup();
  await t.throwsAsync(E(lease).attestation(), { message: /inactive/ });
});

test('network mismatch or drift revokes public egress', async t => {
  for (const mismatch of [true, false]) {
    let disposed = 0;
    let drift = mismatch;
    const f = fixture({
      makePublicNetwork: () => ({
        endpoint: Far('Unused egress', {}),
        dispose: () => {
          disposed += 1;
        },
      }),
      observeNetwork: () => (drift ? undefined : networkEvidence),
    });
    t.teardown(f.issuer.dispose);
    if (mismatch) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        f.issuer({ ...spec, networkPolicy: 'public-internet' }),
        { message: /admission failed/ },
      );
    } else {
      // eslint-disable-next-line no-await-in-loop
      const lease = await f.issuer({
        ...spec,
        networkPolicy: 'public-internet',
      });
      drift = true;
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(E(lease).attestation(), {
        message: /identity changed/,
      });
    }
    t.true(disposed > 0);
    t.is(f.stops(), 1);
  }
});

test('unsupported public policy and unexpected off egress fail closed', async t => {
  const f = fixture();
  t.teardown(f.issuer.dispose);
  await t.throwsAsync(f.issuer({ ...spec, networkPolicy: 'public-internet' }), {
    message: /Unsupported.*network policy/,
  });
  await t.throwsAsync(f.issuer({ ...spec, networkPolicy: 'private' }), {
    message: /Unsupported.*network policy/,
  });
  await t.throwsAsync(f.issuer({ ...spec, networkPolicy: null }), {
    message: /Unsupported.*network policy/,
  });
  t.is(f.listenerLimits(), undefined);
  const unexpected = fixture({ observeNetwork: () => networkEvidence });
  t.teardown(unexpected.issuer.dispose);
  await t.throwsAsync(unexpected.issuer(spec), { message: /admission failed/ });
  t.is(unexpected.stops(), 1);
});

test('request deadlines are independent of session lifetime', async t => {
  for (const [requestTimeoutMs, expected] of [
    [undefined, 120_000],
    [600_000, 600_000],
  ]) {
    const f = fixture({ requestTimeoutMs });
    t.teardown(f.issuer.dispose);
    // eslint-disable-next-line no-await-in-loop
    await f.issuer(spec);
    t.is(f.listenerLimits().timeoutMs, expected);
  }
});

test('listener limits mirror the lease routes and client authorization mode', async t => {
  const f = fixture({
    policy: {
      ...policy,
      routes: [{ method: 'POST', path: '/api/v1/chat/completions' }],
      clientAuthorization: 'strip',
    },
  });
  t.teardown(f.issuer.dispose);
  const lease = await f.issuer(spec);
  t.deepEqual(f.listenerLimits().allowedPaths, ['/api/v1/chat/completions']);
  t.is(f.listenerLimits().clientAuthorization, 'strip');
  await E(lease).revoke();
});

test('invalid host request deadlines are refused', t => {
  for (const requestTimeoutMs of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    600_001,
    '600000',
  ]) {
    t.throws(() => fixture({ requestTimeoutMs }), {
      message: 'Invalid provider request deadline',
    });
  }
});

test('lease binds observations and only delegates inference; retry preserves live lease', async t => {
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const lease = await f.issuer(spec);
  t.like(await E(lease).attestation(), {
    sessionId: 'session',
    accountRef: 'account',
    networkNamespaceId: 'net-1',
  });
  t.like(await E(lease).sandboxEvidence(), {
    brokerSidecar: { container: 'listener' },
  });
  await f.issuer.retryCleanup();
  t.is(f.stops(), 0);
  t.deepEqual(
    await E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    // The body said nothing of its cost; the response did begin.
    {
      status: 200,
      body: 'ok',
      usage: { usage: null, began: true, complete: true, responseBytes: 2 },
    },
  );
  await E(lease).revoke();
  await E(lease).revoke();
  t.is(f.stops(), 1);
  await t.throwsAsync(() => E(lease).attestation(), { message: /inactive/ });
});

test('failed lease teardown retains authority and retries the same worker', async t => {
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const lease = await f.issuer(spec);
  f.failCleanup();
  await t.throwsAsync(() => E(lease).revoke(), {
    message: 'cleanup unavailable',
  });
  await t.throwsAsync(
    () =>
      E(f.endpoint()).request(
        harden({
          method: 'POST',
          path: '/v1/responses',
          body: '{"model":"allowed"}',
        }),
      ),
    { message: /inactive/ },
  );
  f.allowCleanup();
  await f.issuer.retryCleanup();
  t.is(f.stops(), 2);
});

const LOADED_RUNNER_BUDGET_MS = 10_000;

test('grant preserves identity beyond 64 requests until explicit revocation', async t => {
  t.timeout(LOADED_RUNNER_BUDGET_MS);
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const grant = await f.issuer(spec);
  const initial = await E(grant).attestation();
  t.false(Object.hasOwn(initial, 'expiresAt'));
  t.false(Object.hasOwn(initial, 'limits'));
  for (let index = 0; index < 100; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    );
    t.is(response.status, 200);
  }
  t.deepEqual(await E(grant).attestation(), initial);
  t.is(f.stops(), 0);
  await E(grant).revoke();
  t.is(f.stops(), 1);
  await t.throwsAsync(
    E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    { message: /inactive/ },
  );
});

test('worker disconnect revokes host endpoint', async t => {
  t.timeout(LOADED_RUNNER_BUDGET_MS);
  const f = fixture();
  t.teardown(f.issuer.dispose);
  await f.issuer(spec);
  f.disconnect();
  await f.closed;
  await t.throwsAsync(
    () =>
      E(f.endpoint()).request(
        harden({
          method: 'POST',
          path: '/v1/responses',
          body: '{"model":"allowed"}',
        }),
      ),
    { message: /inactive/ },
  );
  t.is(f.stops(), 1);
});

test('disposal during acquisition waits and cleans late worker', async t => {
  t.timeout(LOADED_RUNNER_BUDGET_MS);
  let release = () => {};
  const startBarrier = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const f = fixture({ startBarrier });
  t.teardown(f.issuer.dispose);
  const starting = f.issuer(spec);
  await Promise.resolve();
  const disposing = f.issuer.dispose();
  t.teardown(release);
  // Shutdown fences authority before a slow acquisition can finish.
  await t.throwsAsync(
    E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    { message: /inactive/ },
  );
  release();
  await t.throwsAsync(starting);
  await disposing;
  t.is(f.stops(), 1);
});

test('attestation rejects changed worker network identity', async t => {
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const lease = await f.issuer(spec);
  f.drift();
  await t.throwsAsync(() => E(lease).attestation(), {
    message: /identity changed/,
  });
  t.is(f.stops(), 1);
  await t.throwsAsync(() => E(lease).attestation(), { message: /inactive/ });
});

test('queued lease request cannot be changed after issue invocation', async t => {
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const mutable = { ...spec };
  const issuing = f.issuer(mutable);
  mutable.sessionId = 'different';
  const lease = await issuing;
  t.is((await E(lease).attestation()).sessionId, 'session');
});

const oauthCredential = (accountRef = spec.accountRef) =>
  harden({ accountRef, current: async () => harden({}) });

test('an oauth issuer requires a credential bound to its own account', async t => {
  const base = { ...policy, authMode: /** @type {const} */ ('oauth') };
  // No credential at all: the mode is refused at admission rather than on the
  // first turn, which is the whole point of checking here.
  t.throws(() => fixture({ policy: base }), {
    message: /Invalid provider grant issuer policy/,
  });
  // A credential for another account is a different session's.
  t.throws(
    () => fixture({ policy: base, credential: oauthCredential('other') }),
    { message: /Invalid provider grant issuer policy/ },
  );
  // One that cannot refresh is refused too: it would otherwise be admitted,
  // report `authMode: 'oauth'` in its attestation, and fail on first use.
  t.throws(
    () =>
      fixture({
        policy: base,
        credential: harden({ accountRef: spec.accountRef }),
      }),
    { message: /Unprovisioned broker OAuth mode/ },
  );
  t.notThrows(() => fixture({ policy: base, credential: oauthCredential() }));
});

test('retained issuance revoked before its queue turn acquires no listener', async t => {
  t.timeout(5000);
  const f = fixture();
  t.teardown(f.issuer.dispose);
  const kit = f.issuer.issueKit(spec);
  const closing = kit.revoke();
  await t.throwsAsync(kit.value, { message: /denied/ });
  await closing;
  t.is(f.endpoint(), undefined);
  t.is(f.stops(), 0);
  const next = await f.issuer({ ...spec, sessionId: 'next' });
  t.is((await E(next).attestation()).sessionId, 'next');
});

test('retained issuance revokes authority during acquisition and drains its late listener', async t => {
  t.timeout(5000);
  let release = () => {};
  const startBarrier = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const f = fixture({ startBarrier });
  t.teardown(async () => {
    release();
    await f.issuer.dispose();
  });
  const kit = f.issuer.issueKit(spec);
  const rejected = t.throwsAsync(kit.value, { message: /admission failed/ });
  await Promise.resolve();
  const closing = kit.revoke();
  t.is(kit.revoke(), closing);
  let finished = false;
  void closing.then(() => {
    finished = true;
  });
  await t.throwsAsync(
    E(f.endpoint()).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    { message: /inactive/ },
  );
  t.false(finished);
  release();
  await rejected;
  await closing;
  await kit.revoke();
  t.is(f.stops(), 1);
});

test('failed issuance retains A-only cleanup while B remains usable', async t => {
  let failA = true;
  const listeners = [];
  const runtime = {
    startKit({ endpoint }) {
      const index = listeners.length;
      const state = { endpoint, stops: 0 };
      listeners.push(state);
      const value =
        index === 1
          ? Promise.reject(Error('A listener startup failed'))
          : Promise.resolve({
              observe: async () =>
                harden({
                  endpoint: 'http://127.0.0.1:1234',
                  containerName: `listener-${index}`,
                  networkNamespaceId: `net-${index}`,
                  listenerImageDigest: digest,
                }),
              closed: new Promise(() => {}),
            });
      return {
        value,
        stop: async () => {
          state.stops += 1;
          if (index === 1 && failA) throw Error('A cleanup unavailable');
        },
      };
    },
    dispose: async () => {
      throw Error('Unexpected global runtime disposal');
    },
    retryCleanup: async () => {
      throw Error('Unexpected global runtime cleanup');
    },
  };
  const issuer = makeProviderBrokerGrantIssuer({
    runtime,
    secret: Far('secret', { readBase64: async () => btoa('secret') }),
    fetch: async () => new Response('ok'),
    policy,
    imageDigest: digest,
    accountRef: 'account',
  });
  t.teardown(async () => {
    failA = false;
    await issuer.dispose();
  });
  const b = await issuer({ ...spec, sessionId: 'b' });
  const a = issuer.issueKit({ ...spec, sessionId: 'a' });
  await t.throwsAsync(a.value, { message: /admission and cleanup failed/ });
  t.is(listeners[1].stops, 1);
  t.is(listeners[0].stops, 0);
  await t.throwsAsync(
    E(listeners[1].endpoint).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: '{"model":"allowed"}',
      }),
    ),
    { message: /inactive/ },
  );
  failA = false;
  await a.revoke();
  await a.revoke();
  t.is(listeners[1].stops, 2);
  t.is(listeners[0].stops, 0);
  t.is((await E(b).attestation()).sessionId, 'b');
  t.is(
    (
      await E(listeners[0].endpoint).request(
        harden({
          method: 'POST',
          path: '/v1/responses',
          body: '{"model":"allowed"}',
        }),
      )
    ).body,
    'ok',
  );
});

const listenerRuntime = onEndpoint =>
  harden({
    startKit(input) {
      onEndpoint(input.endpoint);
      const value = Promise.resolve({
        observe: async () =>
          harden({
            endpoint: 'http://127.0.0.1:1234',
            containerName: 'listener',
            networkNamespaceId: 'net-1',
            listenerImageDigest: digest,
          }),
        stop: async () => {},
        closed: new Promise(() => {}),
      });
      return { value, stop: async () => {} };
    },
  });

test('a pool issuer serves a session from its chosen subscription and reads each account as its own', async t => {
  const { makeSubscriptionPool } = await import('../src/subscription-pool.js');
  /** @type {Record<string, any[]>} */
  const readings = { work: [], home: [] };
  /** @type {Array<{ url: string, authorization: string }>} */
  const requests = [];
  // `work` is drained; `home` serves. Both say so in their headers.
  const fetchAuthority = async (url, init) => {
    const authorization = init.headers.authorization;
    requests.push({ url, authorization });
    if (authorization === 'Bearer work-key') {
      return new Response('limit', {
        status: 429,
        headers: {
          'x-codex-secondary-used-percent': '100',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': '4000000000',
          'x-codex-rate-limit-reached-type': 'rate_limit_reached',
        },
      });
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'x-codex-secondary-used-percent': '12' },
    });
  };
  const latest = id => readings[id].at(-1)?.rateLimits;
  const members = [
    { id: 'work', label: 'Work', weight: 20 },
    { id: 'home', label: 'Home', weight: 1 },
  ];
  const chooser = makeSubscriptionPool({
    members: () => members,
    readingOf: latest,
    cacheLifetimeMs: 300_000,
  });
  let endpoint;
  const issuer = makeProviderBrokerGrantIssuer({
    runtime: listenerRuntime(value => {
      endpoint = value;
    }),
    secret: undefined,
    fetch: /** @type {any} */ (fetchAuthority),
    policy,
    imageDigest: digest,
    accountRef: 'account',
    pool: {
      members: () =>
        members.map(({ id }) => ({
          id,
          secret: Far(`${id} secret`, {
            readBase64: async () => btoa(`${id}-key`),
          }),
          onReading: reading => readings[id].push(reading),
        })),
      forSession: chooser.forSession,
    },
  });
  const kit = issuer.issueKit(spec);
  await kit.value;
  const response = await E(endpoint).request(
    harden({
      method: 'POST',
      path: '/v1/responses',
      body: '{"model":"allowed"}',
    }),
  );
  t.is(response.body, '{"ok":true}');
  // Declared order with nothing known: `work` first; it refused as drained,
  // and the same request went to `home`.
  t.deepEqual(
    requests.map(request => request.authorization),
    ['Bearer work-key', 'Bearer home-key'],
  );
  // Each account's reading reached its own observer, the refusal's included.
  t.true(readings.work[0].exhausted);
  t.is(readings.work[0].status, 429);
  t.is(readings.home[0].rateLimits.windows[0].usedPercent, 12);
  // The pool now knows `work` is blocked, until the time its refusal named.
  const standing = chooser.standings().find(entry => entry.id === 'work');
  t.true(standing.blocked);
  t.is(standing.blockedUntilMs, 4_000_000_000_000);
  // The next request of this session does not try `work` again.
  await E(endpoint).request(
    harden({
      method: 'POST',
      path: '/v1/responses',
      body: '{"model":"allowed"}',
    }),
  );
  t.is(requests.at(-1).authorization, 'Bearer home-key');
  t.is(requests.length, 3);
  await kit.revoke();
});

test('a session pinned to one subscription is refused another, and a single-subscription issuer refuses a pin', async t => {
  const single = fixture();
  await t.throwsAsync(
    () => single.issuer.issueKit({ ...spec, subscription: 'work' }).value,
  );
  await t.notThrowsAsync(
    () => single.issuer.issueKit({ ...spec, sessionId: 'auto-ok' }).value,
  );
});

const inference = harden({
  method: 'POST',
  path: '/v1/responses',
  body: '{"model":"allowed"}',
});

test('an endpoint without a listener serves the same credentialed core, and is the issuer’s to reap', async t => {
  /** @type {any[]} */
  const sent = [];
  const f = fixture({
    fetch: async (url, init) => {
      sent.push({ url, authorization: init.headers.authorization });
      return new Response('{"usage":{"input_tokens":5,"output_tokens":2}}');
    },
  });
  const endpoint = await f.issuer.openEndpoint({ sessionId: 'share-a-s1' });
  // No listener was started for it.
  t.is(f.endpoint(), undefined);

  // eslint-disable-next-line no-underscore-dangle
  const endpointMethods = await E(endpoint).__getMethodNames__();
  t.deepEqual(
    endpointMethods.filter(name => !name.startsWith('__')),
    ['attestation', 'request', 'requestByteStream', 'revoke'],
  );
  t.deepEqual(await E(endpoint).attestation(), {
    version: 'InferenceEndpointV1',
    sessionId: 'share-a-s1',
    providerOrigin: policy.origin,
    modelAllowlist: [...policy.models],
    subscription: 'auto',
    hops: 0,
  });
  const response = await E(endpoint).request(inference);
  t.is(sent[0].authorization, 'Bearer host-secret');
  t.like(response.usage, { began: true, usage: { inputTokens: 5 } });
  // The grant's admission rules are the endpoint's too.
  await t.throwsAsync(() =>
    E(endpoint).request(harden({ ...inference, body: '{"model":"denied"}' })),
  );
  await t.throwsAsync(() =>
    E(endpoint).request(harden({ ...inference, path: '/v1/files' })),
  );

  for (const bad of [
    {},
    { sessionId: 'bad id' },
    { sessionId: 's', subscription: 'work' },
    { sessionId: 's', hops: 5 },
    { sessionId: 's', hops: -1 },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => f.issuer.openEndpoint(bad), {
      message: /Provider endpoint request denied/,
    });
  }

  await E(endpoint).revoke();
  await t.throwsAsync(() => E(endpoint).request(inference), {
    message: /Inference endpoint revoked/,
  });
  // Disposing the issuer reaps the endpoints nobody revoked.
  const left = await f.issuer.openEndpoint({ sessionId: 's2' });
  await f.issuer.dispose();
  await t.throwsAsync(() => E(left).request(inference));
  await t.throwsAsync(() => f.issuer.openEndpoint({ sessionId: 's3' }));
});

test('an endpoint over a pool hands over, and says so only when every account is used up', async t => {
  const { makeSubscriptionPool } = await import('../src/subscription-pool.js');
  /** @type {Record<string, any>} */
  const latest = {};
  let homeServes = true;
  const members = [
    { id: 'work', label: 'Work', weight: 1 },
    { id: 'home', label: 'Home', weight: 1 },
  ];
  const chooser = makeSubscriptionPool({
    members: () => members,
    readingOf: id => latest[id],
    cacheLifetimeMs: 300_000,
  });
  const limited = () =>
    new Response('limit', {
      status: 429,
      headers: {
        'x-codex-secondary-used-percent': '100',
        'x-codex-secondary-reset-at': '4000000000',
      },
    });
  const issuer = makeProviderBrokerGrantIssuer({
    runtime: listenerRuntime(() => {}),
    secret: undefined,
    fetch: /** @type {any} */ (
      async (_url, init) => {
        if (init.headers.authorization === 'Bearer work-key') return limited();
        return homeServes ? new Response('{"ok":true}') : limited();
      }
    ),
    policy,
    imageDigest: digest,
    accountRef: 'account',
    pool: {
      members: () =>
        members.map(({ id }) => ({
          id,
          secret: Far(`${id} secret`, {
            readBase64: async () => btoa(`${id}-key`),
          }),
          onReading: reading => {
            latest[id] = reading.rateLimits;
          },
        })),
      forSession: chooser.forSession,
    },
  });
  const endpoint = await issuer.openEndpoint({ sessionId: 'share-a-s1' });
  t.is((await E(endpoint).request(inference)).body, '{"ok":true}');
  homeServes = false;
  await t.throwsAsync(() => E(endpoint).request(inference), {
    message: 'Provider subscription exhausted',
  });
  // And again, now that both are known to be blocked before it is tried.
  await t.throwsAsync(() => E(endpoint).request(inference), {
    message: 'Provider subscription exhausted',
  });
  await issuer.dispose();
});

/**
 * An issuer over a pool of one account of the operator's own and one member
 * that is somebody else's subscription.
 *
 * @param {(issuer: () => any) => any} makeFar The far subscription, given a
 *   way to reach this issuer (for a cycle).
 * @param {object} [options]
 */
const wrappedPoolFixture = async (makeFar, options = {}) => {
  const { makeSubscriptionPool } = await import('../src/subscription-pool.js');
  /** @type {string[]} */
  const own = [];
  const members = [
    { id: 'far', label: 'Far', weight: 1 },
    { id: 'own', label: 'Own', weight: 1 },
  ];
  const chooser = makeSubscriptionPool({
    members: () => members,
    readingOf: () => undefined,
    cacheLifetimeMs: 300_000,
  });
  /** @type {any} */
  let listenerEndpoint;
  /** @type {any} */
  let issuer;
  const far = makeFar(() => issuer);
  issuer = makeProviderBrokerGrantIssuer({
    runtime: listenerRuntime(value => {
      listenerEndpoint = value;
    }),
    secret: undefined,
    fetch: /** @type {any} */ (
      async (_url, init) => {
        own.push(init.headers.authorization);
        return new Response('{"served":"own"}');
      }
    ),
    policy,
    imageDigest: digest,
    accountRef: 'account',
    pool: {
      members: () => [
        { id: 'far', subscription: far },
        {
          id: 'own',
          secret: Far('own secret', {
            readBase64: async () => btoa('own-key'),
          }),
        },
      ],
      forSession: chooser.forSession,
    },
    ...options,
  });
  return { issuer, own, endpoint: () => listenerEndpoint };
};

test('a pool that holds a share of itself neither deadlocks nor goes round for ever', async t => {
  const { makeSubscriptionShare } =
    await import('../src/subscription-share.js');
  const f = await wrappedPoolFixture(issuer => {
    // The operator's own pool as a Subscription, and a share of it, put back
    // into that pool.
    const self = Far('self', {
      describe: async () => harden({ providerId: 'test', models: ['allowed'] }),
      getStatus: async () => harden({ available: true }),
      openEndpoint: requested => issuer().openEndpoint(requested),
    });
    return makeSubscriptionShare({
      shareId: 'loop',
      provideUnderlying: async () => self,
      provideLimits: async () => ({ createdAt: '2026-09-20T00:00:00Z' }),
      journal: { read: async () => undefined, write: async () => {} },
      log: () => {},
    }).share;
  });
  // The grant is issued at once: nothing is opened while the queue is held.
  const kit = f.issuer.issueKit(spec);
  await kit.value;
  // The request goes round until the hop limit refuses to open another, and
  // is then served by the operator's own account, at the bottom.
  const response = await E(f.endpoint()).request(inference);
  t.is(response.body, '{"served":"own"}');
  t.deepEqual(f.own, ['Bearer own-key']);
  await kit.revoke();
  await f.issuer.dispose();
});

test('a far subscription that hangs or has gone costs a pause, not the session: the next member serves', async t => {
  let opens = 0;
  const f = await wrappedPoolFixture(
    () =>
      Far('hanging', {
        openEndpoint: () => {
          opens += 1;
          return new Promise(() => {});
        },
      }),
    { wrappedOpenDeadlineMs: 20 },
  );
  const kit = f.issuer.issueKit(spec);
  await kit.value;
  t.is((await E(f.endpoint()).request(inference)).body, '{"served":"own"}');
  t.is(opens, 1);
  // The pool skips it for a while afterwards, as it does a dead credential.
  t.is((await E(f.endpoint()).request(inference)).body, '{"served":"own"}');
  t.is(opens, 1);
  await kit.revoke();
});

test('a far endpoint that stopped working is opened again, once; the older text reader never reaches a far subscription', async t => {
  /** @type {any[]} */
  const opened = [];
  let served = 0;
  const f = await wrappedPoolFixture(() =>
    Far('restarting', {
      openEndpoint: async () => {
        const entry = { revoked: false, index: opened.length };
        opened.push(entry);
        return Far('far endpoint', {
          request: async () => {
            // The first endpoint died with the far daemon's restart.
            if (entry.index === 0) throw Error('Inference endpoint revoked');
            served += 1;
            return harden({ status: 200, body: '{"served":"far"}' });
          },
          requestByteStream: async () => {
            served += 1;
            throw Error('not expected');
          },
          revoke: async () => {
            entry.revoked = true;
          },
        });
      },
    }),
  );
  const kit = f.issuer.issueKit(spec);
  await kit.value;
  t.is((await E(f.endpoint()).request(inference)).body, '{"served":"far"}');
  t.is(opened.length, 2);
  // The dead one is kept until the grant ends: another request of this
  // session might still have been streaming from it.
  t.false(opened[0].revoked);
  // A listener from before the bytes stream is served by our own account.
  const before = served;
  const legacy = await E(f.endpoint()).requestStream(inference);
  let text = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await E(legacy.reader).next();
    text += chunk.value;
    if (chunk.done) break;
  }
  t.is(text, '{"served":"own"}');
  t.is(served, before);
  await kit.revoke();
  await new Promise(resolve => setTimeout(resolve, 5));
  t.true(opened[0].revoked, 'the dead one is given back with the grant');
  t.true(opened[1].revoked, 'the live one is revoked with the grant');
});

test('a far share that cannot serve just now is not sent the request again, and a sibling streaming from it is left alone', async t => {
  /** @type {any[]} */
  const opened = [];
  /** @type {string[]} */
  const calls = [];
  const unavailable = true;
  const f = await wrappedPoolFixture(() =>
    Far('flaky', {
      openEndpoint: async () => {
        const entry = { revoked: false };
        opened.push(entry);
        return Far('far endpoint', {
          request: async () => {
            calls.push('far');
            if (unavailable) throw Error('Provider share unavailable');
            return harden({ status: 200, body: '{"served":"far"}' });
          },
          requestByteStream: async () => {
            throw Error('not expected');
          },
          revoke: async () => {
            entry.revoked = true;
          },
        });
      },
    }),
  );
  const kit = f.issuer.issueKit(spec);
  await kit.value;
  // Sent once, refused by the far share's own trouble: our own account
  // serves, and the far endpoint is neither reopened nor revoked.
  t.is((await E(f.endpoint()).request(inference)).body, '{"served":"own"}');
  t.deepEqual(calls, ['far']);
  t.is(opened.length, 1);
  t.false(opened[0].revoked);
  await kit.revoke();
});

test('how far a request has come is not held against the member: past the hop limit it is left out, and the pool is not told', async t => {
  let opens = 0;
  const f = await wrappedPoolFixture(() =>
    Far('far', {
      openEndpoint: async () => {
        opens += 1;
        throw Error('Too many subscriptions between here and the provider');
      },
    }),
  );
  // A holder who claims to have come a long way already.
  const deep = await f.issuer.openEndpoint({ sessionId: 'deep', hops: 3 });
  t.is((await E(deep).request(inference)).body, '{"served":"own"}');
  t.is(opens, 0, 'the far member was never asked');
  await E(deep).revoke();
});
