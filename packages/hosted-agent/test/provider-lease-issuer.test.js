// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeProviderBrokerLeaseIssuer } from '../src/provider-lease-issuer.js';

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
  maxRequests: 2n,
  maxRequestBytes: 1024n,
  maxResponseBytes: 1024n,
  maxTotalBytes: 8192n,
  maxCostMicrounits: 20n,
  maxCostMicrounitsPerRequest: 10n,
});

/** @param {any} [options] */
const fixture = ({
  leaseDurationMs = 60_000,
  startBarrier,
  now,
  policy: policyOverride,
  credential,
} = {}) => {
  let stops = 0;
  let fails = false;
  let drift = false;
  let endpoint;
  let disconnect = () => {};
  const closed = new Promise(resolve => {
    disconnect = () => resolve(undefined);
  });
  const issuer = makeProviderBrokerLeaseIssuer({
    runtime: {
      async start(input) {
        endpoint = input.endpoint;
        if (startBarrier) await startBarrier;
        return {
          async observe() {
            return harden({
              endpoint: 'http://127.0.0.1:1234',
              containerName: 'listener',
              networkNamespaceId: drift ? 'net-2' : 'net-1',
              listenerImageDigest: digest,
            });
          },
          async stop() {
            stops += 1;
            if (fails) throw Error('cleanup unavailable');
            disconnect();
          },
          closed,
        };
      },
    },
    secret: Far('host-only secret', {
      async readBase64() {
        return btoa('host-secret');
      },
    }),
    fetch: async () => new Response('ok'),
    policy: policyOverride ?? policy,
    ...(credential === undefined ? {} : { credential }),
    leaseDurationMs,
    now,
    imageDigest: digest,
    accountRef: 'account',
  });
  return {
    issuer,
    endpoint: () => endpoint,
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

// The outer budget on these tests guards against a hang, not against a slow
// runner: the expiry and admission timers they exercise are tens of
// milliseconds, but spinning the fixture (listener, broker, worker) alongside
// the rest of the affected set on a loaded macOS runner has taken well over a
// second, which a one-second budget reported as a failure.
const LOADED_RUNNER_BUDGET_MS = 10_000;

test('lease expiry revokes traffic and stops worker', async t => {
  t.timeout(LOADED_RUNNER_BUDGET_MS);
  // Setup can exceed the short expiry interval on a loaded CI runner. Keep
  // admission live, then advance the policy clock and await the real timer.
  let time = 0;
  const f = fixture({ leaseDurationMs: 20, now: () => time });
  t.teardown(f.issuer.dispose);
  const lease = await f.issuer(spec);
  time = 20;
  await f.closed;
  await t.throwsAsync(() => E(lease).attestation(), { message: /inactive/ });
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

test('worker disconnect revokes host endpoint', async t => {
  t.timeout(LOADED_RUNNER_BUDGET_MS);
  const f = fixture();
  t.teardown(f.issuer.dispose);
  await f.issuer(spec);
  f.disconnect();
  await f.issuer.dispose();
  t.is(f.stops(), 1);
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
    message: /Invalid provider lease issuer policy/,
  });
  // A credential for another account is a different session's.
  t.throws(
    () => fixture({ policy: base, credential: oauthCredential('other') }),
    { message: /Invalid provider lease issuer policy/ },
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
