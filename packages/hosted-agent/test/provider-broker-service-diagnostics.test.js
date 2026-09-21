// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import { E } from '@endo/eventual-send';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { makeSubscriptionShare } from '../src/subscription-share.js';
import { makeLatestTopic } from '../src/latest-topic.js';

import {
  listenerDiagnostics,
  readingFromShareStatus,
  makeOwnedProviderBrokerService,
  makeProviderBrokerServiceKit,
} from '../src/provider-broker-service.js';

const encode = text => new TextEncoder().encode(text);

/** What an account's catalog read says when it lists these models. */
const listing =
  (...ids) =>
  async () =>
    harden({
      observedAt: 1,
      models: ids.map(id => ({
        id,
        title: id,
        description: '',
        default: false,
        defaultReasoningEffort: null,
        reasoningEfforts: [],
      })),
    });

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
      /** @type {any} */ ({
        ownerId: `owner-${diagnostics}`,
        diagnostics,
        pool: false,
      }),
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
    t.false(
      Object.hasOwn(options, 'pool'),
      'setup flag is not a runtime pool capability',
    );
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
  const redeemed = [];
  /** @type {string[]} */
  const used = [];
  /** @type {any} */
  let endpoint;
  const kit = makeProviderBrokerServiceKit({
    label: 'Test',
    policy: /** @type {any} */ ({
      origin: 'https://api.example.test',
      routes: [{ method: 'POST', path: '/v1/responses' }],
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
      modelReadOf: () => listing('allowed'),
      resetRedeemOf:
        ({ member }) =>
        async request => {
          redeemed.push({ member: member.id, ...request });
          return { outcome: 'reset', words: 'of the provider' };
        },
      readState: async () => undefined,
      writeState: async state => {
        kept.push(state);
      },
    },
  });
  // Each member has its own redeemer, reached by id and by nothing else; its
  // answer is one word.
  const homeRedeemer = await E(kit.service).resetRedeemer('home');
  t.deepEqual(
    await E(homeRedeemer).redeem({
      idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e',
    }),
    { outcome: 'reset' },
  );
  t.deepEqual(redeemed, [
    { member: 'home', idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e' },
  ]);
  t.is(await E(kit.service).resetRedeemer('nobody'), undefined);
  t.is(await E(kit.service).resetRedeemer(), undefined);
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

  // The broker as a Subscription, and a share made over it: a holder's
  // request is served from the same pool, by the account that can serve,
  // through an endpoint that has no listener.
  const subscription = await E(kit.service).subscription();
  t.like(await E(subscription).describe(), {
    providerId: 'test',
    kind: 'broker',
    models: ['allowed'],
  });
  // `work` is used up and `home` is not: the short form says it can serve.
  t.like(await E(subscription).getStatus(), {
    available: true,
    blockedUntil: '',
  });
  /** @type {any[]} */
  const shareStore = [];
  const { share } = makeSubscriptionShare({
    shareId: 'alice',
    provideUnderlying: async () => subscription,
    provideLimits: async () => ({
      createdAt: '2026-09-20T00:00:00Z',
      budget: { tokens: 100_000, periodSeconds: 86_400 },
    }),
    journal: {
      read: async () => shareStore.at(-1),
      write: async record => {
        shareStore.push(record);
      },
    },
  });
  const held = await E(share).openEndpoint({ sessionId: 'peer-1' });
  const before = used.length;
  t.is((await E(held).request(request)).body, '{"ok":true}');
  // A new session, so it sees the member added above; never the drained one.
  t.deepEqual(used.slice(before), ['Bearer spare-key']);
  t.like(await E(held).attestation(), { subscription: 'alice', hops: 1 });
  // The response did not say what it cost, so the reservation is the charge.
  await new Promise(resolve => setTimeout(resolve, 0));
  t.true((await E(share).getStatus()).budget.spent > 0);
  await kit.close();
  await t.throwsAsync(() => E(held).request(request));
});

const pooledKit = (digestLetter, ownerId, subscriptions, overrides = {}) => {
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
    ...overrides,
  });
};

test('pool close drains an admitted observation write and fences later chooser updates', async t => {
  let entered;
  let release;
  const began = new Promise(resolve => {
    entered = resolve;
  });
  const paused = new Promise(resolve => {
    release = resolve;
  });
  let pool;
  let writes = 0;
  const kit = pooledKit(
    'b',
    'owner-observation-drain',
    {
      readSet: async () => ({ members: [{ id: 'work' }] }),
      secretOf: () => Far('Unused', { readBase64: async () => '' }),
      writeState: async () => {
        writes += 1;
        entered();
        await paused;
      },
    },
    {
      makeIssuer: options => {
        pool = options.pool;
        return {
          openEndpoint: async () => {
            await pool.members();
            pool.forSession('write-test', 'auto').served('work');
            return Far('UnusedEndpoint', {});
          },
          dispose: async () => {},
        };
      },
    },
  );
  const subscription = await E(kit.service).subscription();
  await E(subscription).openEndpoint({ sessionId: 'write-test' });
  await began;
  let closed = false;
  const closing = kit.close().then(() => {
    closed = true;
  });
  await null;
  t.false(closed);
  release();
  await closing;
  pool.forSession('late-request', 'auto').served('work');
  await null;
  t.is(writes, 1);
});

for (const fail of [false, true])
  test(`wrapped quiet reader retirement retries independent close: ${fail}`, async t => {
    let members = [{ id: 'shared', subscriptionName: 'share' }];
    let entered;
    const began = new Promise(resolve => {
      entered = resolve;
    });
    let attempts = 0;
    let refusing = fail;
    let wake;
    const next = new Promise(resolve => {
      wake = resolve;
    });
    const reader = readerFromIterator(
      harden({
        next: () => {
          entered();
          return next;
        },
        return: async () => {
          attempts += 1;
          wake(harden({ done: true, value: undefined }));
          if (refusing) throw Error('reader return failed');
          return harden({ done: true, value: undefined });
        },
      }),
      { cancelPending: () => wake(harden({ done: true, value: undefined })) },
    );
    const share = Far('QuietShare', {
      watchStatus: async () => reader,
      getStatus: async () => ({}),
    });
    const kit = pooledKit('b', 'owner-quiet-retirement', {
      readSet: async () => ({ members }),
      secretOf: () => Far('unused', {}),
      subscriptionOf: () => share,
    });
    await E(kit.service).accountSource('shared');
    await began;
    members = [{ id: 'home', subscriptionName: 'other' }];
    if (fail) {
      await t.throwsAsync(E(kit.service).subscriptions(), {
        message: /cleanup pending/,
      });
      refusing = false;
      t.deepEqual(
        (await E(kit.service).subscriptions()).map(member => member.id),
        ['home'],
      );
      await kit.close();
    } else {
      t.deepEqual(
        (await E(kit.service).subscriptions()).map(member => member.id),
        ['home'],
      );
      await kit.close();
    }
    if (fail) t.true(attempts >= 2);
    else t.is(attempts, 1);
  });

test('wrapped follower read errors do not poison acknowledged resource closure', async t => {
  let members = [{ id: 'shared', subscriptionName: 'share' }];
  let acknowledge;
  const returned = new Promise(resolve => {
    acknowledge = resolve;
  });
  let returns = 0;
  const reader = readerFromIterator(
    harden({
      next: async () => {
        throw Error('historical read failure');
      },
      return: async () => {
        returns += 1;
        acknowledge();
        return harden({ done: true, value: undefined });
      },
    }),
  );
  const share = Far('FailedStatusHistory', {
    watchStatus: async () => reader,
    getStatus: async () => ({}),
  });
  const kit = pooledKit('b', 'owner-historical-status', {
    readSet: async () => ({ members }),
    secretOf: () => Far('unused', {}),
    subscriptionOf: () => share,
  });
  await E(kit.service).accountSource('shared');
  await returned;
  members = [{ id: 'home', subscriptionName: 'other' }];
  t.deepEqual(
    (await E(kit.service).subscriptions()).map(member => member.id),
    ['home'],
  );
  await kit.close();
  t.is(returns, 1);
});

test('removed member drains renewal and fences retained account and reset facets', async t => {
  let members = [{ id: 'work', accountRef: 'acct_work' }];
  let release;
  let entered;
  const began = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let persisted = false;
  let resets = 0;
  const kit = pooledKit('b', 'owner-retirement', {
    readSet: async () => ({ members }),
    secretOf: () => Far('RenewalAuthority', { readBase64: async () => '' }),
    credentialOf: member => ({
      accountRef: member.accountRef,
      current: async () => {
        entered();
        await gate;
        persisted = true;
        return {};
      },
    }),
    activeReadOf:
      ({ credential }) =>
      async () => {
        await credential.current();
        return {};
      },
    resetRedeemOf: () => async () => {
      resets += 1;
      return { outcome: 'reset' };
    },
  });
  t.teardown(() => kit.close());
  const account = await E(kit.service).accountSource('work');
  const reset = await E(kit.service).resetRedeemer('work');
  const refresh = E(account).refresh();
  await began;
  members = [{ id: 'home', accountRef: 'acct_home' }];
  let retired = false;
  const retirement = E(kit.service)
    .subscriptions()
    .then(() => {
      retired = true;
    });
  await new Promise(resolve => setTimeout(resolve, 0));
  t.false(retired);
  await t.throwsAsync(E(account).observe(), { message: /closed/ });
  await t.throwsAsync(E(reset).redeem({ idempotencyKey: '1234567890123456' }), {
    message: /retired/,
  });
  release();
  await refresh;
  await retirement;
  t.true(persisted);
  t.is(resets, 0);
  await t.throwsAsync(E(account).refresh(), { message: /closed/ });
  t.truthy(await E(kit.service).accountSource('home'));
});

test('catalog discovery retains account boundaries and isolates failed readings', async t => {
  const owners = [];
  const reads = [];
  const kit = pooledKit('b', 'owner-models', {
    readSet: async () => ({
      members: [
        { id: 'work', accountRef: 'acct_work' },
        { id: 'home', accountRef: 'acct_home' },
      ],
    }),
    secretOf: member =>
      Far('ModelSecret', { readBase64: async () => member.id }),
    credentialOf: member => {
      const credential = {
        accountRef: member.accountRef,
        current: async () => member.id,
      };
      owners.push(credential);
      return credential;
    },
    modelReadOf:
      ({ member, secret, credential }) =>
      async () => {
        t.is(await E(secret).readBase64(), member.id);
        t.is(await credential.current(), member.id);
        reads.push(member.id);
        if (member.id === 'home') throw Error('SECRET must not escape');
        return {
          observedAt: 123,
          models: [
            {
              id: 'model-a',
              title: 'Model A',
              description: '',
              default: true,
              defaultReasoningEffort: null,
              reasoningEfforts: [],
            },
          ],
        };
      },
  });
  t.teardown(() => kit.close());
  t.deepEqual(reads, []);
  const catalog = await E(kit.service).modelCatalog();
  t.is(owners.length, 2);
  t.deepEqual(
    catalog.accounts.map(account => [account.subscriptionId, account.state]),
    [
      ['work', 'current'],
      ['home', 'unavailable'],
    ],
  );
  t.is(catalog.accounts[0].models[0].id, 'model-a');
  t.deepEqual(catalog.accounts[1].models, []);
  t.false(JSON.stringify(catalog).includes('SECRET'));
  await E(kit.service).modelCatalog('work');
  t.is(owners.length, 2, 'discovery reuses existing credential owners');
  // A catalog read within its lifetime is answered from what is held; the
  // account that could not be read is not asked again at once either.
  t.deepEqual(reads, ['work', 'home']);
  await t.throwsAsync(() => E(kit.service).modelCatalog('missing'), {
    message: /Unknown provider subscription/,
  });
});

test('discovery constructor failure does not discard the credential owner or leak its error', async t => {
  let owners = 0;
  const kit = pooledKit('b', 'owner-model-failure', {
    readSet: async () => ({ members: [{ id: 'work' }] }),
    secretOf: () => {
      owners += 1;
      return {};
    },
    modelReadOf: () => {
      throw Error('SECRET constructor failure');
    },
  });
  t.teardown(() => kit.close());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await E(kit.service).modelCatalog(), {
      accounts: [
        {
          subscriptionId: 'work',
          state: 'unavailable',
          observedAt: null,
          models: [],
        },
      ],
    });
  }
  t.is(owners, 1);
});

test('a removed account cannot publish its pending catalog as current', async t => {
  t.timeout(5000);
  let stored = { members: [{ id: 'work' }] };
  let finish;
  let started;
  const began = new Promise(resolve => {
    started = resolve;
  });
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const kit = pooledKit('b', 'owner-model-retired', {
    readSet: async () => stored,
    secretOf: () => ({}),
    modelReadOf: () => async () => {
      started();
      return pending;
    },
  });
  t.teardown(() => kit.close());
  const reading = E(kit.service).modelCatalog('work');
  await began;
  stored = { members: [{ id: 'home' }] };
  const retirement = E(kit.service).subscriptions();
  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  t.false(retired, 'removal waits for the admitted model reader');
  finish({ observedAt: 123, models: [] });
  await retirement;
  t.deepEqual(await reading, {
    accounts: [
      {
        subscriptionId: 'work',
        state: 'unavailable',
        observedAt: null,
        models: [],
      },
    ],
  });
});

test('catalog batch rechecks a fast account after a slower account finishes', async t => {
  t.timeout(5000);
  let stored = { members: [{ id: 'fast' }, { id: 'slow' }] };
  let finishSlow;
  let markFast;
  const fastDone = new Promise(resolve => {
    markFast = resolve;
  });
  const slow = new Promise(resolve => {
    finishSlow = resolve;
  });
  const snapshot = { observedAt: 123, models: [] };
  const kit = pooledKit('b', 'owner-model-batch', {
    readSet: async () => stored,
    secretOf: () => ({}),
    modelReadOf:
      ({ member }) =>
      async () => {
        if (member.id === 'slow') return slow;
        markFast();
        return snapshot;
      },
  });
  t.teardown(() => kit.close());
  const reading = E(kit.service).modelCatalog();
  await fastDone;
  // Let the fast account complete normalization before changing membership.
  await new Promise(resolve => setTimeout(resolve, 0));
  stored = { members: [{ id: 'slow' }] };
  await E(kit.service).subscriptions();
  finishSlow(snapshot);
  const result = await reading;
  t.deepEqual(
    result.accounts.map(account => [account.subscriptionId, account.state]),
    [
      ['fast', 'unavailable'],
      ['slow', 'current'],
    ],
  );
});

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

test('pool member IDs cannot be rebound to another authority within an incarnation', async t => {
  const original = {
    id: 'work',
    secretName: 'key-one',
    accountRef: 'acct_one',
  };
  /** @type {any} */
  let stored = { members: [original] };
  let credentials = 0;
  const observed = [];
  const kit = pooledKit('a', 'owner-binding', {
    readSet: async () => stored,
    secretOf: member =>
      Far('secret', {
        readBase64: async () => btoa(member.secretName),
      }),
    credentialOf: () => {
      credentials += 1;
      return {};
    },
    activeReadOf:
      ({ member }) =>
      async () => {
        observed.push(member.accountRef);
        return {};
      },
  });
  t.teardown(() => kit.close());
  const source = await E(kit.service).accountSource('work');
  t.is(credentials, 1);
  for (const changed of [
    { ...original, accountRef: 'acct_two' },
    { ...original, secretName: 'key-two' },
    { id: 'work', subscriptionName: 'shared' },
  ]) {
    stored = { members: [changed] };
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(kit.service).subscriptions(), {
      message: /authority changed; use a new member ID/,
    });
  }
  t.is(credentials, 1);
  // Rejection does not claim to revoke already issued account capabilities.
  await E(source).refresh();
  t.deepEqual(observed, ['acct_one']);
  stored = {
    members: [{ ...original, label: 'Renamed', weight: 2, pinnedOnly: true }],
  };
  t.deepEqual(await E(kit.service).subscriptions(), [
    { id: 'work', label: 'Renamed', weight: 2, pinnedOnly: true },
  ]);
  // Removal must not permit the same ID to mean a different account later.
  stored = { members: [{ id: 'other', accountRef: 'acct_other' }] };
  await E(kit.service).subscriptions();
  stored = { members: [{ ...original, accountRef: 'acct_two' }] };
  await t.throwsAsync(() => E(kit.service).subscriptions(), {
    message: /authority changed; use a new member ID/,
  });
  stored = { members: [original] };
  t.is((await E(kit.service).subscriptions())[0].id, 'work');
});

test('an owned pool binds actual secret capabilities before activation and refuses name rebinding', async t => {
  const digest = `sha256:${'e'.repeat(64)}`;
  /** @type {Map<string, any>} */
  const names = new Map();
  names.set('subscriptions', {
    members: [
      { id: 'work', secretName: 'secret-work', accountRef: 'acct_work' },
      { id: 'home', secretName: 'secret-home', accountRef: 'acct_home' },
    ],
  });
  names.set(
    'secret-work',
    Far('work secret', { readBase64: async () => btoa('work-key') }),
  );
  names.set(
    'secret-home',
    Far('home secret', { readBase64: async () => btoa('home-key') }),
  );
  const namespace = Far('namespace', {
    has: async name => names.has(name),
    list: async () => [...names.keys()],
    lookup: async name => {
      if (!names.has(name)) throw Error(`Unknown pet name ${name}`);
      return names.get(name);
    },
    storeValue: async (value, name) => {
      names.set(name, value);
    },
    remove: async name => {
      names.delete(name);
    },
  });
  /** @type {any} */
  let kitOptions;
  const make = makeOwnedProviderBrokerService({
    label: 'Test',
    log: () => {},
    readConfig: () =>
      /** @type {any} */ ({
        ownerId: 'owner-pool-mode',
        directory: '/tmp/unused',
        imageRef: `localhost/slice@${digest}`,
        imageDigest: digest,
        listenerImageRef: `localhost/listener@${digest}`,
        accountRef: 'pool',
        pool: true,
      }),
    makePolicy: config =>
      /** @type {any} */ ({
        policy: { origin: 'https://provider.test' },
        accountRef: config.accountRef,
        adaptRequest: () => ({
          path: '/x',
          headers: { 'x-account': config.accountRef },
        }),
      }),
    makeServiceKit: /** @type {any} */ (
      options => {
        kitOptions = options;
        return { service: Far('service', {}), close: async () => {} };
      }
    ),
  });
  const context = Far('context', {
    whenCancelled: () => new Promise(() => {}),
  });
  await make(namespace, context, { env: {} });
  const { subscriptions } = kitOptions;
  t.is(kitOptions.secret, undefined);
  t.is((await subscriptions.readSet()).members.length, 2);
  // Each member's translation names its own account, never the pool's label.
  t.deepEqual(
    subscriptions.adaptRequestOf({ id: 'work', accountRef: 'acct_work' })({})
      .headers,
    { 'x-account': 'acct_work' },
  );
  // A secret that is there.
  const work = subscriptions.secretOf({
    id: 'work',
    secretName: 'secret-work',
  });
  t.is(atob(await work.readBase64()), 'work-key');
  // Capture the actual capability, not a wrapper that follows the pet name.
  const home = subscriptions.secretOf({
    id: 'home',
    secretName: 'secret-home',
  });
  t.is(atob(await home.readBase64()), 'home-key');
  names.set(
    'secret-home',
    Far('replacement secret', {
      readBase64: async () => btoa('replacement-key'),
    }),
  );
  t.is(atob(await home.readBase64()), 'home-key');
  await t.throwsAsync(subscriptions.readSet(), {
    message: /journal is fenced/,
  });
  // What the pool keeps goes to a journal in the same namespace, which prunes
  // only its own names.
  await subscriptions.writeState({ refusals: {}, sessions: {} });
  t.is(
    await subscriptions.readState(),
    undefined,
    'first binding never adopts historical chooser state',
  );
  t.true(names.has('subscriptions'));
  t.true(names.has('secret-work'));
});

test('chooser observations require an established matching capability binding and never import v1', async t => {
  const authority = Far('BoundChooserSecret', { readBase64: async () => '' });
  const other = Far('OtherChooserSecret', { readBase64: async () => '' });
  const observations = {
    refusals: { work: { untilMs: 123, strikes: 1 } },
    sessions: { s: { memberId: 'work', atMs: 1 } },
  };
  const names = new Map([
    ['subscriptions', harden({ members: [{ id: 'work', secretName: 'key' }] })],
    ['key', authority],
    ['pool-state-v1-00000000000000000000', observations],
    [
      'pool-state-v2-00000000000000000000',
      harden({
        version: 2,
        bindings: [{ id: 'work', authority }],
        state: observations,
      }),
    ],
  ]);
  const namespace = Far('ChooserNamespace', {
    list: async () => harden([...names.keys()]),
    has: async name => names.has(name),
    lookup: async name => names.get(name),
    storeValue: async (value, name) => {
      names.set(name, value);
    },
    remove: async name => {
      names.delete(name);
    },
  });
  let options;
  const make = makeOwnedProviderBrokerService({
    label: 'Chooser',
    readConfig: () => ({ ownerId: 'chooser-bound-state', pool: true }),
    makePolicy: () => ({
      policy: { origin: 'https://provider.test' },
      accountRef: 'pool',
    }),
    makeServiceKit: value => {
      options = value;
      return { service: Far('Inert', {}), close: async () => {} };
    },
  });
  let cancel;
  let cancelled = new Promise(resolve => {
    cancel = resolve;
  });
  const context = Far('ChooserContext', { whenCancelled: () => cancelled });
  await make(namespace, context, { env: {} });
  await options.subscriptions.readSet();
  t.is(
    await options.subscriptions.readState(),
    undefined,
    'even v2 cannot precede authoritative identity',
  );
  await options.subscriptions.writeState(observations);
  cancel();
  await new Promise(resolve => setTimeout(resolve, 0));
  cancelled = new Promise(resolve => {
    cancel = resolve;
  });
  t.teardown(() => cancel());
  await make(namespace, context, { env: {} });
  await options.subscriptions.readSet();
  t.deepEqual(await options.subscriptions.readState(), observations);
  // A syntactically current observation for a different authority is not useful.
  for (const [name, value] of names) {
    if (name.startsWith('pool-state-v2-'))
      names.set(
        name,
        harden({ ...value, bindings: [{ id: 'work', authority: other }] }),
      );
  }
  t.deepEqual(await options.subscriptions.readState(), {
    refusals: {},
    sessions: {},
  });
  for (const name of names.keys())
    if (name.startsWith('pool-state-v2-')) names.delete(name);
  t.is(
    await options.subscriptions.readState(),
    undefined,
    'v1 is never a fallback',
  );
});

test('failed authoritative identity write prevents owned-pool credential construction', async t => {
  const digest = `sha256:${'f'.repeat(64)}`;
  const secret = Far('UnactivatedSecret', {
    readBase64: async () => {
      throw Error('must not read');
    },
  });
  const namespace = Far('FailedIdentityStorage', {
    list: () => ['subscriptions', 'key'],
    has: () => false,
    lookup: name =>
      name === 'subscriptions'
        ? harden({
            members: [
              { id: 'member', secretName: 'key', accountRef: 'account' },
            ],
          })
        : secret,
    storeValue: () => {
      throw Error('Cannot commit authoritative binding');
    },
  });
  let constructed = 0;
  const make = makeOwnedProviderBrokerService({
    label: 'IdentityWriteFailure',
    readConfig: () =>
      /** @type {any} */ ({
        ownerId: 'identity-failed-write',
        pool: true,
        directory: '/tmp/unused',
        imageRef: `localhost/fixture@${digest}`,
        imageDigest: digest,
        listenerImageRef: `localhost/fixture@${digest}`,
      }),
    makePolicy: () =>
      /** @type {any} */ ({
        policy: { origin: 'https://provider.test' },
        accountRef: 'pool',
      }),
    makeCredential: () => {
      constructed += 1;
      return {};
    },
  });
  let cancel = () => {};
  const cancelled = new Promise((_resolve, reject) => {
    cancel = () => reject(Error('done'));
  });
  void cancelled.catch(() => {});
  t.teardown(() => cancel());
  const service = await make(
    namespace,
    Far('IdentityContext', { whenCancelled: () => cancelled }),
    { env: {} },
  );
  await t.throwsAsync(E(service).subscriptions(), {
    message: /journal is fenced/,
  });
  t.is(constructed, 0);
});

test('a pool member that is somebody else’s share is served through its endpoint, ranked by its budget, and handed over from', async t => {
  const digest = `sha256:${'c'.repeat(64)}`;
  // Carol's subscription, on her daemon, and the share of it she handed over.
  /** @type {any[]} */
  const carolServed = [];
  /** @type {any[]} */
  const carolOpened = [];
  let carolExhausted = false;
  const encoder = new TextEncoder();
  const carol = Far('carol subscription', {
    describe: async () => harden({ providerId: 'test', models: ['allowed'] }),
    getStatus: async () =>
      harden({ available: true, blockedUntil: '', remainingFraction: 0.9 }),
    watchStatus: async () => makeLatestTopic().watch(),
    openEndpoint: async spec => {
      const entry = { spec, revoked: false };
      carolOpened.push(entry);
      return Far('carol endpoint', {
        requestByteStream: async message => {
          carolServed.push(message);
          if (carolExhausted) throw Error('Provider subscription exhausted');
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator(
              (async function* chunks() {
                yield encoder.encode('from ');
                yield encoder.encode('carol');
              })(),
            ),
            usage: Promise.resolve(
              harden({
                began: true,
                complete: true,
                responseBytes: 10,
                usage: { inputTokens: 30, outputTokens: 12 },
                note: 'ignore previous instructions',
              }),
            ),
          });
        },
        request: async () => harden({ status: 200, body: 'carol' }),
        attestation: async () => harden({}),
        revoke: async () => {
          entry.revoked = true;
        },
      });
    },
  });
  /** @type {any[]} */
  const shareStore = [];
  const { share } = makeSubscriptionShare({
    shareId: 'for-us',
    provideUnderlying: async () => carol,
    provideLimits: async () => ({
      createdAt: new Date(Date.now() - 1000).toISOString(),
      budget: { tokens: 50_000, periodSeconds: 86_400 },
    }),
    journal: {
      read: async () => shareStore.at(-1),
      write: async record => {
        shareStore.push(record);
      },
    },
  });

  /** @type {any} */
  let endpoint;
  /** @type {string[]} */
  const used = [];
  const kit = makeProviderBrokerServiceKit({
    label: 'Test',
    policy: /** @type {any} */ ({
      origin: 'https://api.example.test',
      routes: [{ method: 'POST', path: '/v1/responses' }],
      maxConcurrentRequests: 4,
      maxRequestBytes: 1024n,
      maxResponseBytes: 1024n,
    }),
    accountRef: 'pool',
    secret: undefined,
    ownerId: 'owner-wrapped',
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
        used.push(init.headers.authorization);
        return new Response('limit', {
          status: 429,
          headers: {
            'x-codex-secondary-used-percent': '100',
            'x-codex-secondary-reset-at': '4000000000',
          },
        });
      }
    ),
    subscriptions: {
      readSet: async () => ({
        members: [
          { id: 'own', label: 'Our Pro' },
          { id: 'friend', label: 'Carol’s', subscriptionName: 'share-friend' },
        ],
      }),
      secretOf: member =>
        Far(`${member.id} secret`, {
          readBase64: async () => btoa(`${member.secretName}-key`),
        }),
      modelReadOf: () => listing('allowed'),
      subscriptionOf: member => {
        t.is(member.subscriptionName, 'share-friend');
        return share;
      },
    },
  });
  t.deepEqual(await E(kit.service).subscriptions(), [
    { id: 'own', label: 'Our Pro', weight: 1 },
    { id: 'friend', label: 'Carol’s', weight: 1 },
  ]);
  // A wrapped member has no credential of ours, and so nothing to redeem.
  t.is(await E(kit.service).resetRedeemer('friend'), undefined);

  const scope = await E(kit.service).provideScope(
    'session-w',
    harden({ providerOrigin: 'https://api.example.test', accountRef: 'pool' }),
  );
  await E(scope).start();
  // Nothing is opened on her side until a request needs it.
  t.is(carolOpened.length, 0);
  const request = harden({
    method: 'POST',
    path: '/v1/responses',
    body: '{"model":"allowed","stream":true,"max_output_tokens":64}',
  });
  const response = await E(endpoint).requestByteStream(request);
  // Her share's budget is a window that runs out first (its period ends
  // within the day; nothing is known of our own account yet), so it is the
  // one to drain: our own credential is not even tried.
  t.deepEqual(used, []);
  t.is(carolServed.length, 1);
  t.is(JSON.parse(carolServed[0].body).model, 'allowed');
  // One hop for our pool; the share counts its own on top.
  t.deepEqual(carolOpened[0].spec, {
    sessionId: 'share-for-us-session-w',
    subscription: 'auto',
    hops: 2,
  });
  const parts = [];
  for await (const bytes of iterateBytesReader(response.reader, {
    buffer: 64,
  })) {
    parts.push(new TextDecoder().decode(bytes));
  }
  t.is(parts.join(''), 'from carol');
  // Her settlement reaches our listener as numbers and nothing else.
  t.deepEqual(await response.usage, {
    began: true,
    complete: true,
    responseBytes: 10,
    usage: {
      inputTokens: 30,
      outputTokens: 12,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  // Her share charged its meter from the same settlement.
  await new Promise(resolve => setTimeout(resolve, 5));
  t.is((await E(share).getStatus()).budget.spent, 42);
  // What the share says of itself reached our account source for it, as a
  // window: the pool ranks it and a view shows it like the rest.
  const friend = await E(kit.service).accountSource('friend');
  await E(friend).refresh();
  const reading = await E(friend).observe();
  t.is(reading.plan.planId, 'share');
  t.is(reading.rateLimits.windows[0].title, 'Share budget');

  // Carol's runs out: the same request goes on to our own account, which
  // is used up too, and the slice sees one failure.
  carolExhausted = true;
  await t.throwsAsync(() => E(endpoint).requestByteStream(request), {
    message: /Provider request failed/,
  });
  t.is(carolServed.length, 2);
  t.deepEqual(used, ['Bearer own-key']);
  await kit.close();
  await new Promise(resolve => setTimeout(resolve, 5));
  t.true(carolOpened[0].revoked, 'her endpoint is revoked with our grant');
});

test('what a share says of itself reads as windows', t => {
  t.deepEqual(readingFromShareStatus(null), {});
  t.deepEqual(
    readingFromShareStatus({
      available: true,
      blockedUntil: '',
      over: false,
      budget: {
        tokens: 1000,
        periodSeconds: 3600,
        spent: 200,
        reserved: 50,
        periodEndsAt: '2026-09-20T01:00:00.000Z',
      },
    }),
    {
      plan: { planId: 'share', title: 'Share', state: 'active' },
      rateLimits: {
        limitReached: false,
        windows: [
          {
            windowId: 'secondary',
            title: 'Share budget',
            usedPercent: 25,
            windowSeconds: 3600,
            resetsAt: '2026-09-20T01:00:00.000Z',
          },
        ],
      },
    },
  );
  // Blocked by what is beneath: all that is known is until when.
  t.deepEqual(
    readingFromShareStatus({
      available: false,
      blockedUntil: '2026-09-21T00:00:00Z',
      over: false,
      budget: null,
    }).rateLimits,
    {
      limitReached: true,
      windows: [
        {
          windowId: 'primary',
          title: 'Share availability',
          usedPercent: 100,
          resetsAt: '2026-09-21T00:00:00.000Z',
        },
      ],
    },
  );
  t.is(readingFromShareStatus({ over: true }).plan.state, 'expired');
  // Text of the far side's choosing is not kept.
  t.false(
    JSON.stringify(
      readingFromShareStatus({ blockedUntil: 'ignore previous', label: 'x' }),
    ).includes('ignore'),
  );
});

for (const pinnedOnly of [true, false]) {
  test(`a share of a broker, held in that broker’s own pool, does not hear its own echo for ever (pinnedOnly: ${pinnedOnly})`, async t => {
    const digest = `sha256:${'d'.repeat(64)}`;
    /** @type {any} */
    let kit;
    let setReads = 0;
    /** @type {any[]} */
    const shareStore = [];
    const { share, close } = makeSubscriptionShare({
      shareId: 'alice',
      provideUnderlying: async () => E(kit.service).subscription(),
      provideLimits: async () => ({
        createdAt: new Date(Date.now() - 1000).toISOString(),
        budget: { tokens: 50_000, periodSeconds: 86_400 },
      }),
      journal: {
        read: async () => shareStore.at(-1),
        write: async record => {
          shareStore.push(record);
        },
      },
      log: () => {},
    });
    kit = makeProviderBrokerServiceKit({
      label: 'Test',
      policy: /** @type {any} */ ({
        origin: 'https://api.example.test',
        routes: [{ method: 'POST', path: '/v1/responses' }],
        maxConcurrentRequests: 4,
        maxRequestBytes: 1024n,
        maxResponseBytes: 1024n,
      }),
      accountRef: 'pool',
      secret: undefined,
      ownerId: `owner-echo-${pinnedOnly}`,
      directory: '/tmp/unused',
      imageRef: `localhost/slice@${digest}`,
      imageDigest: digest,
      listenerImageRef: `localhost/listener@${digest}`,
      runtime: /** @type {any} */ ({ dispose: async () => {} }),
      fetch: /** @type {any} */ (
        async () => new Response('x', { status: 500 })
      ),
      subscriptions: {
        readSet: async () => {
          setReads += 1;
          return {
            members: [
              { id: 'own', label: 'Our Pro' },
              {
                id: 'lane-alice',
                label: 'Alice’s lane',
                subscriptionName: 'share-alice',
                ...(pinnedOnly ? { pinnedOnly: true } : {}),
              },
            ],
          };
        },
        secretOf: member =>
          Far(`${member.id} secret`, { readBase64: async () => btoa('k') }),
        subscriptionOf: () => share,
      },
    });
    const subscription = await E(kit.service).subscription();
    // Somebody watches the broker's status, and the share's: every link of
    // the cycle is live.
    const brokerEvents = iterateReader(await E(subscription).watchStatus());
    const shareEvents = iterateReader(await E(share).watchStatus());
    await brokerEvents.next();
    await shareEvents.next();
    t.like(await E(subscription).getStatus(), { available: true });
    const before = setReads;
    await new Promise(resolve => setTimeout(resolve, 400));
    t.true(
      setReads - before < 40,
      `the set was read ${setReads - before} times while nothing changed`,
    );
    await brokerEvents.return(undefined);
    await shareEvents.return(undefined);
    close();
    await kit.close();
  });
}

test('a catalog is current, then stale when the provider stops answering, then unavailable, and unsupported without discovery', async t => {
  let clock = 1_000_000;
  const LIFETIME = 60_000;
  const MAX_AGE = 600_000;
  let answer = true;
  const kit = pooledKit(
    'd',
    'owner-catalog-states',
    {
      readSet: async () => ({
        members: [{ id: 'work' }, { id: 'quiet', subscriptionName: 'share' }],
      }),
      secretOf: () => Far('secret', { readBase64: async () => '' }),
      subscriptionOf: () =>
        Far('share', {
          describe: async () => harden({ providerId: 'test', models: ['x'] }),
          getStatus: async () => harden({ available: true }),
          watchStatus: async () => makeLatestTopic().watch(),
        }),
      modelReadOf: () => async () => {
        if (!answer) throw Error('provider catalog down');
        return listing('allowed')();
      },
    },
    { now: () => clock, catalog: { lifetimeMs: LIFETIME, maxAgeMs: MAX_AGE } },
  );
  t.teardown(() => kit.close());
  const states = async () =>
    (await E(kit.service).modelCatalog()).accounts.map(account => [
      account.subscriptionId,
      account.state,
      account.models.map(model => model.id),
    ]);
  t.deepEqual(await states(), [
    ['work', 'current', ['allowed']],
    // A share in the pool lists what its grantor says of it.
    ['quiet', 'current', ['x']],
  ]);
  answer = false;
  clock += LIFETIME;
  t.deepEqual(await states(), [
    ['work', 'stale', ['allowed']],
    ['quiet', 'current', ['x']],
  ]);
  clock += MAX_AGE;
  t.deepEqual(await states(), [
    ['work', 'unavailable', []],
    ['quiet', 'current', ['x']],
  ]);
  answer = true;
  clock += LIFETIME;
  t.deepEqual((await states())[0], ['work', 'current', ['allowed']]);
  const bare = pooledKit('e', 'owner-catalog-unsupported', {
    readSet: async () => ({ members: [{ id: 'work' }] }),
    secretOf: () => Far('secret', { readBase64: async () => '' }),
  });
  t.teardown(() => bare.close());
  t.deepEqual(await E(bare.service).modelCatalog(), {
    accounts: [
      {
        subscriptionId: 'work',
        state: 'unsupported',
        observedAt: null,
        models: [],
      },
    ],
  });
});

test('a request goes to the subscription whose account lists its model, and a retired account admits nothing', async t => {
  const digest = `sha256:${'f'.repeat(64)}`;
  /** @type {any} */
  let storedSet = { members: [{ id: 'work' }, { id: 'home' }] };
  /** @type {string[]} */
  const used = [];
  /** @type {any} */
  let endpoint;
  const kit = makeProviderBrokerServiceKit({
    label: 'Test',
    policy: /** @type {any} */ ({
      origin: 'https://api.example.test',
      routes: [{ method: 'POST', path: '/v1/responses' }],
      maxConcurrentRequests: 4,
      maxRequestBytes: 1024n,
      maxResponseBytes: 1024n,
    }),
    accountRef: 'pool',
    secret: undefined,
    ownerId: 'owner-disjoint',
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
        used.push(init.headers.authorization);
        return new Response('{"ok":true}');
      }
    ),
    subscriptions: {
      readSet: async () => storedSet,
      secretOf: member =>
        Far(`${member.id} secret`, {
          readBase64: async () => btoa(`${member.secretName}-key`),
        }),
      // Disjoint catalogs: each account lists a model of its own.
      modelReadOf: ({ member }) =>
        listing(member.id === 'work' ? 'model-w' : 'model-h'),
    },
  });
  t.teardown(() => kit.close());
  const scope = await E(kit.service).provideScope(
    'disjoint',
    harden({ providerOrigin: 'https://api.example.test', accountRef: 'pool' }),
  );
  await E(scope).start();
  /** @param {string} model */
  const ask = model =>
    E(endpoint).request(
      harden({
        method: 'POST',
        path: '/v1/responses',
        body: JSON.stringify({ model }),
      }),
    );
  t.is((await ask('model-h')).body, '{"ok":true}');
  t.is((await ask('model-w')).body, '{"ok":true}');
  // Declared order would try `work` first; only the account that lists the
  // model is asked.
  t.deepEqual(used, ['Bearer home-key', 'Bearer work-key']);
  await t.throwsAsync(() => ask('model-x'), { message: /Model denied/ });
  // The broker as a Subscription describes the union of what its accounts
  // list.
  const subscription = await E(kit.service).subscription();
  t.deepEqual((await E(subscription).describe()).models, [
    'model-w',
    'model-h',
  ]);
  // `home` leaves the set: its catalog is closed with it, and the grant
  // that took the set as it was cannot be served from it any more.
  storedSet = { members: [{ id: 'work' }] };
  await E(kit.service).subscriptions();
  await t.throwsAsync(() => ask('model-h'), { message: /Model denied/ });
  t.deepEqual(used, ['Bearer home-key', 'Bearer work-key']);
  t.deepEqual(
    (await E(kit.service).modelCatalog()).accounts.map(account => [
      account.subscriptionId,
      account.state,
    ]),
    [['work', 'current']],
  );
});

test('a retired member’s catalog admits nothing, even to a grant that still holds it', async t => {
  /** @type {any} */
  let storedSet = { members: [{ id: 'work' }, { id: 'home' }] };
  /** @type {any} */
  let pool;
  const kit = pooledKit(
    '1',
    'owner-retired-admission',
    {
      readSet: async () => storedSet,
      secretOf: () => Far('secret', { readBase64: async () => '' }),
      modelReadOf: ({ member }) =>
        listing(member.id === 'work' ? 'model-w' : 'model-h'),
    },
    {
      makeIssuer: options => {
        pool = options.pool;
        return {
          openEndpoint: async () => Far('UnusedEndpoint', {}),
          dispose: async () => {},
        };
      },
    },
  );
  t.teardown(() => kit.close());
  // Issuance holds the set as it was: the grant made now keeps `home`.
  const subscription = await E(kit.service).subscription();
  await E(subscription).openEndpoint({ sessionId: 'retire-test' });
  const members = await pool.members();
  const home = members.find(
    (/** @type {any} */ member) => member.id === 'home',
  );
  t.true(await home.admits('model-h'));
  t.is(home.catalogState(), 'current');
  storedSet = { members: [{ id: 'work' }] };
  await E(kit.service).subscriptions();
  // The grant took the set as it was; the member it holds is retired, and
  // its catalog closed with it.
  t.false(await home.admits('model-h'));
  t.is(home.catalogState(), 'unavailable');
});

test('a share in the pool lists only what its grantor’s limits allow', async t => {
  const carol = Far('carol subscription', {
    describe: async () =>
      harden({ providerId: 'test', models: ['allowed', 'other'] }),
    getStatus: async () =>
      harden({ available: true, blockedUntil: '', remainingFraction: 0.9 }),
    watchStatus: async () => makeLatestTopic().watch(),
    openEndpoint: async () => {
      throw Error('unused');
    },
  });
  /** @type {any[]} */
  const shareStore = [];
  const { share } = makeSubscriptionShare({
    shareId: 'narrow',
    provideUnderlying: async () => carol,
    provideLimits: async () => ({
      createdAt: new Date(Date.now() - 1000).toISOString(),
      budget: { tokens: 50_000, periodSeconds: 86_400 },
      models: ['allowed', 'not-beneath'],
    }),
    journal: {
      read: async () => shareStore.at(-1),
      write: async record => {
        shareStore.push(record);
      },
    },
  });
  const kit = pooledKit('2', 'owner-share-catalog', {
    readSet: async () => ({
      members: [
        { id: 'own', label: 'Ours' },
        { id: 'friend', label: 'Carol’s', subscriptionName: 'share-narrow' },
      ],
    }),
    secretOf: () => Far('secret', { readBase64: async () => '' }),
    subscriptionOf: () => share,
    modelReadOf: () => listing('allowed', 'own-only'),
  });
  t.teardown(() => kit.close());
  t.deepEqual(
    (await E(kit.service).modelCatalog()).accounts.map(account => [
      account.subscriptionId,
      account.state,
      account.models.map(model => model.id),
    ]),
    [
      ['own', 'current', ['allowed', 'own-only']],
      // The share's narrowing, intersected with what is beneath it.
      ['friend', 'current', ['allowed']],
    ],
  );
});
