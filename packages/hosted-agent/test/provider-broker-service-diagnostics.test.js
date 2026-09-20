// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import { E } from '@endo/eventual-send';

import {
  listenerDiagnostics,
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '../src/provider-broker-service.js';

const encode = text => new TextEncoder().encode(text);

test('listener diagnostics are the worker lines and nothing else on the stream', t => {
  t.deepEqual(
    listenerDiagnostics(
      encode(
        [
          'SES Removing unpermitted intrinsics',
          'Provider HTTP diagnostic: {"stage":"endpoint"}',
          'Provider HTTP diagnostic: {"stage":"headers","checks":{"authorization":false,"path":true,"note":"canary"}}',
          'Provider HTTP diagnostic: {"stage":"end',
          'Provider HTTP diagnostic: {"stage":42}',
          '',
        ].join('\n'),
      ),
    ),
    [
      { stage: 'endpoint' },
      { stage: 'headers', checks: { authorization: false, path: true } },
    ],
  );
});

/**
 * Open an owned broker service over a recording kit and return the options
 * the kit was constructed with.
 * @param {boolean | undefined} diagnostics
 * @param {(...args: string[]) => void} log
 */
const kitOptionsFor = async (diagnostics, log) => {
  /** @type {any} */
  let seen;
  const make = makeOwnedProviderBrokerService({
    label: 'Test',
    log,
    readConfig: () =>
      /** @type {any} */ ({ ownerId: `owner-${diagnostics}`, diagnostics }),
    makePolicy: () => /** @type {any} */ ({ policy: {}, accountRef: 'a' }),
    makeServiceKit: /** @type {any} */ (
      options => {
        seen = options;
        return { service: Far('service', {}), close: async () => {} };
      }
    ),
  });
  const context = Far('context', {
    whenCancelled: () => new Promise(() => {}),
  });
  await make(Far('secret', { readBase64: async () => '' }), context, {
    env: {},
  });
  return seen;
};

test('failure hooks do not depend on the diagnostics flag; the admission trail does', async t => {
  /** @type {string[]} */
  const logged = [];
  const log = (...args) => logged.push(args.join(' '));
  for (const flag of [undefined, false, true]) {
    // eslint-disable-next-line no-await-in-loop
    const options = await kitOptionsFor(flag, log);
    t.is(typeof options.onDiagnostic, 'function', `${flag}`);
    t.is(typeof options.onListenerDiagnostic, 'function', `${flag}`);
    t.is(typeof options.audit, flag === true ? 'function' : 'undefined');
    options.onDiagnostic({ stage: 'response', status: 429 });
    options.onListenerDiagnostic({ stage: 'endpoint' });
    if (flag === true) options.audit({ event: 'admitted', requests: 1n });
  }
  t.is(
    logged.filter(line => line === 'Test broker event admitted 1').length,
    1,
  );
  t.is(
    logged.filter(
      line =>
        line === 'Test upstream failure {"stage":"response","status":429}',
    ).length,
    3,
  );
  t.is(
    logged.filter(line => line === 'Test listener failure {"stage":"endpoint"}')
      .length,
    3,
  );
});

test('what the transport reads of the account reaches the service’s account source', async t => {
  /** @type {any} */
  let issuerOptions;
  const digest = `sha256:${'a'.repeat(64)}`;
  const kit = makeProviderBrokerServiceKit({
    label: 'Test',
    policy: /** @type {any} */ ({}),
    accountRef: 'account',
    secret: Far('secret', { readBase64: async () => '' }),
    ownerId: 'owner-account-source',
    directory: '/tmp/unused',
    imageRef: `localhost/slice@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/listener@${digest}`,
    runtime: /** @type {any} */ ({ dispose: async () => {} }),
    makeIssuer: /** @type {any} */ (
      options => {
        issuerOptions = options;
        return { dispose: async () => {} };
      }
    ),
    activeAccountRead: async () =>
      harden({ plan: { planId: 'pro', title: 'Pro', state: 'active' } }),
  });
  const source = await E(kit.service).accountSource();
  // Dormant: nothing has been served and nothing was asked.
  t.deepEqual(await E(source).observe(), {});
  t.is(issuerOptions, undefined);

  // The issuer is built when the first scope opens; drive its observer the
  // way the transport does.
  await E(kit.service)
    .provideScope(
      'session-a',
      harden({
        providerOrigin: 'https://api.example.test',
        accountRef: 'account',
      }),
    )
    .then(scope => E(scope).start())
    .catch(() => {});
  t.is(typeof issuerOptions?.onReading, 'function');
  issuerOptions.onReading(
    harden({
      rateLimits: {
        windows: [
          { windowId: 'secondary', title: 'Weekly window', usedPercent: 12 },
        ],
        limitReached: false,
      },
      status: 200,
      exhausted: false,
    }),
  );
  t.is((await E(source).observe()).rateLimits.windows[0].usedPercent, 12);
  // The active read runs only when asked.
  await E(source).refresh();
  t.is((await E(source).observe()).plan.planId, 'pro');
  await kit.close();
});

test('a broker over several subscriptions reads its set, hands over, keeps its state, and says what it holds', async t => {
  const digest = `sha256:${'b'.repeat(64)}`;
  /** @type {any} */
  let storedSet = {
    cacheLifetimeSeconds: 300,
    members: [
      { id: 'work', label: 'Work Pro', weight: 20 },
      { id: 'home', label: 'Home Plus' },
    ],
  };
  /** @type {any[]} */
  const kept = [];
  /** @type {string[]} */
  const used = [];
  /** @type {any} */
  let endpoint;
  const kit = makeProviderBrokerServiceKit({
    label: 'Test',
    policy: /** @type {any} */ ({
      origin: 'https://api.example.test',
      routes: [{ method: 'POST', path: '/v1/responses' }],
      models: ['allowed'],
      maxConcurrentRequests: 4,
      maxRequestBytes: 1024n,
      maxResponseBytes: 1024n,
    }),
    accountRef: 'pool',
    secret: undefined,
    ownerId: 'owner-pooled',
    directory: '/tmp/unused',
    imageRef: `localhost/slice@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/listener@${digest}`,
    runtime: /** @type {any} */ ({
      dispose: async () => {},
      startKit(input) {
        endpoint = input.endpoint;
        const value = Promise.resolve({
          observe: async () =>
            harden({
              endpoint: 'http://127.0.0.1:1',
              containerName: 'listener',
              networkNamespaceId: 'net',
              listenerImageDigest: digest,
            }),
          stop: async () => {},
          closed: new Promise(() => {}),
        });
        return { value, stop: async () => {} };
      },
    }),
    fetch: /** @type {any} */ (
      async (_url, init) => {
        const key = init.headers.authorization;
        used.push(key);
        if (key === 'Bearer work-key') {
          return new Response('limit', {
            status: 429,
            headers: {
              'x-codex-secondary-used-percent': '100',
              'x-codex-secondary-reset-at': '4000000000',
            },
          });
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'x-codex-secondary-used-percent': '7' },
        });
      }
    ),
    subscriptions: {
      readSet: async () => storedSet,
      secretOf: member =>
        Far(`${member.id} secret`, {
          readBase64: async () => btoa(`${member.secretName}-key`),
        }),
      readState: async () => undefined,
      writeState: async state => {
        kept.push(state);
      },
    },
  });
  // What it holds, before any session: labels and weights, nothing secret.
  t.deepEqual(await E(kit.service).subscriptions(), [
    { id: 'work', label: 'Work Pro', weight: 20 },
    { id: 'home', label: 'Home Plus', weight: 1 },
  ]);
  const workSource = await E(kit.service).accountSource('work');
  t.deepEqual(await E(workSource).observe(), {});
  t.is(await E(kit.service).accountSource('nobody'), undefined);

  const scope = await E(kit.service).provideScope(
    'session-a',
    harden({ providerOrigin: 'https://api.example.test', accountRef: 'pool' }),
  );
  await E(scope).start();
  const body = '{"model":"allowed"}';
  const request = harden({ method: 'POST', path: '/v1/responses', body });
  t.is((await E(endpoint).request(request)).body, '{"ok":true}');
  t.deepEqual(used, ['Bearer work-key', 'Bearer home-key']);
  // Each account's own source has its own reading.
  t.is((await E(workSource).observe()).rateLimits.windows[0].usedPercent, 100);
  const homeSource = await E(kit.service).accountSource('home');
  t.is((await E(homeSource).observe()).rateLimits.windows[0].usedPercent, 7);
  // The refusal and where the session was served were offered for keeping.
  await new Promise(resolve => setTimeout(resolve, 0));
  t.is(kept.at(-1).refusals.work.untilMs, 4_000_000_000_000);
  t.is(kept.at(-1).sessions['session-a'].memberId, 'home');

  // An operator adds a subscription: a write of a value, no retirement. The
  // next session sees it.
  storedSet = {
    ...storedSet,
    members: [...storedSet.members, { id: 'spare' }],
  };
  t.is((await E(kit.service).subscriptions()).length, 3);
  // The session that was already open keeps working: its grant took the set
  // as it was, and is not handed a member it does not hold.
  t.is((await E(endpoint).request(request)).body, '{"ok":true}');
  await kit.close();
});

const pooledKit = (digestLetter, ownerId, subscriptions) => {
  const digest = `sha256:${digestLetter.repeat(64)}`;
  return makeProviderBrokerServiceKit({
    label: 'Test',
    policy: /** @type {any} */ ({}),
    accountRef: 'pool',
    secret: undefined,
    ownerId,
    directory: '/tmp/unused',
    imageRef: `localhost/slice@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/listener@${digest}`,
    runtime: /** @type {any} */ ({ dispose: async () => {} }),
    subscriptions,
  });
};

test('a status reader and the first session arriving together share one pool', async t => {
  let stateReads = 0;
  const kit = pooledKit('c', 'owner-concurrent', {
    readSet: async () => ({ members: [{ id: 'work' }, { id: 'home' }] }),
    secretOf: () => Far('secret', { readBase64: async () => '' }),
    readState: async () => {
      stateReads += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return undefined;
    },
  });
  await Promise.all([
    E(kit.service).subscriptions(),
    E(kit.service).subscriptions(),
    E(kit.service).accountSource('work'),
  ]);
  t.is(stateReads, 1);
  await kit.close();
});

test('a set that is not well formed fails cleanly and leaves the service usable', async t => {
  /** @type {any} */
  let stored = { members: [{ id: 'a' }, { id: 'a' }] };
  const kit = pooledKit('d', 'owner-invalid', {
    readSet: async () => stored,
    secretOf: () => Far('secret', { readBase64: async () => '' }),
    // An OAuth provider: every member must name its account.
    credentialOf: () => ({}),
  });
  await t.throwsAsync(() => E(kit.service).subscriptions(), {
    message: /distinct/,
  });
  stored = { members: [{ id: 'a', accountRef: 'acct_1' }, { id: 'b' }] };
  await t.throwsAsync(() => E(kit.service).subscriptions(), {
    message: /must name its account/,
  });
  stored = {
    members: [
      { id: 'a', accountRef: 'acct_1' },
      { id: 'b', accountRef: 'acct_2' },
    ],
  };
  t.is((await E(kit.service).subscriptions()).length, 2);
  await kit.close();
});
