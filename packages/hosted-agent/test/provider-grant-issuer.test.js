// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeProviderBrokerGrantIssuer } from '../src/provider-grant-issuer.js';

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
    { status: 200, body: 'ok' },
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
