// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeLatestTopic } from '../src/latest-topic.js';
import {
  estimateRequest,
  makeSubscriptionShare,
  namespacedSessionId,
  normalizeShareLimits,
} from '../src/subscription-share.js';

const T0 = Date.parse('2026-09-20T00:00:00Z');
const message = (extra = {}) =>
  harden({
    method: 'POST',
    path: '/v1/responses',
    body: JSON.stringify({
      model: 'allowed',
      max_output_tokens: 100,
      ...extra,
    }),
  });
const cost = (inputTokens, outputTokens) =>
  harden({
    began: true,
    complete: true,
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });

/** A subscription beneath, scripted. */
const makeBeneath = () => {
  /** @type {any[]} */
  const opened = [];
  /** @type {any[]} */
  const served = [];
  const statusTopic = makeLatestTopic();
  const state = {
    status: { available: true, blockedUntil: '', remainingFraction: 0.8 },
    /** @type {Array<(message: any) => any>} */
    script: [],
  };
  const subscription = Far('beneath', {
    describe: async () =>
      harden({
        providerId: 'codex',
        id: 'pool',
        label: 'The pool',
        models: ['allowed', 'other'],
      }),
    openEndpoint: async spec => {
      const entry = { spec, revoked: false };
      opened.push(entry);
      const respond = async request => {
        served.push(request);
        const next = state.script.shift();
        return next
          ? next(request)
          : harden({ status: 200, body: 'ok', usage: cost(10, 5) });
      };
      return Far('inner', {
        request: respond,
        requestByteStream: respond,
        attestation: async () =>
          harden({
            providerOrigin: 'https://chatgpt.com',
            modelAllowlist: ['allowed', 'other'],
            subscriptions: ['work', 'home'],
          }),
        revoke: async () => {
          entry.revoked = true;
        },
      });
    },
    getStatus: async () => harden({ ...state.status, accounts: ['work'] }),
    watchStatus: async () => statusTopic.watch(),
  });
  return { subscription, opened, served, state, statusTopic };
};

const makeStore = () => {
  /** @type {any[]} */
  const written = [];
  return {
    written,
    read: async () => written[written.length - 1],
    write: async record => {
      written.push(record);
    },
  };
};

/**
 * @param {object} [options]
 * @param options.limits
 * @param options.store
 * @param options.beneath
 */
const makeHarness = ({
  limits = {},
  store = makeStore(),
  beneath = makeBeneath(),
} = {}) => {
  const state = {
    now: T0 + 1000,
    limits: { createdAt: new Date(T0).toISOString(), ...limits },
  };
  const kit = makeSubscriptionShare({
    shareId: 'alice',
    provideUnderlying: async () => beneath.subscription,
    provideLimits: async () => state.limits,
    journal: store,
    now: () => state.now,
    log: () => {},
  });
  return { ...kit, beneath, store, state };
};

test('limits are validated and copied', t => {
  t.deepEqual(
    normalizeShareLimits({
      createdAt: '2026-09-20T00:00:00Z',
      budget: { tokens: 1000, periodSeconds: 86_400, extra: 1 },
      reserve: 0.2,
      models: ['allowed'],
      maxConcurrentRequests: 2,
      expiresAt: '2026-10-01T00:00:00Z',
      outputEstimate: 4096,
      anything: 'else',
    }),
    {
      createdAt: '2026-09-20T00:00:00.000Z',
      budget: { tokens: 1000, periodSeconds: 86_400 },
      reserve: 0.2,
      models: ['allowed'],
      maxConcurrentRequests: 2,
      expiresAt: '2026-10-01T00:00:00.000Z',
      outputEstimate: 4096,
    },
  );
  for (const bad of [
    null,
    {},
    { createdAt: 'x' },
    {
      createdAt: '2026-09-20T00:00:00Z',
      budget: { tokens: 0, periodSeconds: 60 },
    },
    {
      createdAt: '2026-09-20T00:00:00Z',
      budget: { tokens: 5, periodSeconds: 1 },
    },
    { createdAt: '2026-09-20T00:00:00Z', reserve: 1 },
    { createdAt: '2026-09-20T00:00:00Z', models: [] },
    { createdAt: '2026-09-20T00:00:00Z', expiresAt: 'never' },
    { createdAt: '2026-09-20T00:00:00Z', maxConcurrentRequests: 0 },
  ]) {
    t.throws(() => normalizeShareLimits(bad));
  }
  t.is(estimateRequest('x'.repeat(400), { max_tokens: 50 }, 8192), 150);
  t.is(estimateRequest('x'.repeat(400), {}, 8192), 8292);
});

test('a request passes through untouched and is charged what it cost', async t => {
  const { share, beneath } = makeHarness({
    limits: { budget: { tokens: 1000, periodSeconds: 3600 } },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 'mine' });
  // The holder's session id is namespaced beneath, and the hop counted.
  t.deepEqual(beneath.opened[0].spec, {
    sessionId: 'share-alice-mine',
    subscription: 'auto',
    hops: 1,
  });
  const reader = Far('reader', {});
  beneath.state.script.push(() =>
    harden({
      status: 200,
      reader,
      contentType: 'text/event-stream',
      usage: Promise.resolve(cost(40, 20)),
    }),
  );
  const response = await E(endpoint).requestByteStream(message());
  t.is(response.reader, reader, 'the reader is the subscription’s own');
  t.is(beneath.served[0].body, message().body);
  await response.usage;
  await null;
  t.like((await E(share).getStatus()).budget, { spent: 60, reserved: 0 });
});

test('what a holder sees of what is beneath is whether, and until when', async t => {
  const { share, admin, beneath } = makeHarness({
    limits: {
      budget: { tokens: 1000, periodSeconds: 3600 },
      models: ['allowed'],
    },
  });
  const status = await E(share).getStatus();
  t.deepEqual(Object.keys(status).sort(), [
    'available',
    'blockedUntil',
    'budget',
    'models',
    'over',
    'shareId',
  ]);
  beneath.state.status = {
    available: false,
    blockedUntil: '2026-09-21T00:00:00.000Z',
    remainingFraction: 0,
  };
  t.like(await E(share).getStatus(), {
    available: false,
    blockedUntil: '2026-09-21T00:00:00.000Z',
  });
  // The grantor sees why.
  t.like(await E(admin).getStatus(), {
    revoked: false,
    beneath: { remainingFraction: 0 },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  t.deepEqual(await E(endpoint).attestation(), {
    version: 'InferenceEndpointV1',
    sessionId: 's',
    providerOrigin: 'https://chatgpt.com',
    modelAllowlist: ['allowed'],
    subscription: 'alice',
    hops: 1,
  });
  t.deepEqual(await E(share).describe(), {
    providerId: 'codex',
    id: 'alice',
    label: 'alice',
    kind: 'share',
    models: ['allowed'],
  });
});

test('each limit refuses with the share’s own word, before anything reaches beneath', async t => {
  const { share, beneath, state } = makeHarness({
    limits: {
      budget: { tokens: 500, periodSeconds: 3600 },
      reserve: 0.25,
      models: ['allowed'],
      maxConcurrentRequests: 1,
    },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  await t.throwsAsync(() => E(endpoint).request(message({ model: 'other' })), {
    message: /Model denied/,
  });
  // Below the grantor's floor.
  beneath.state.status = {
    available: true,
    blockedUntil: '',
    remainingFraction: 0.1,
  };
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: 'Provider share exhausted',
  });
  // Unknown is not below: the floor is advisory between readings.
  beneath.state.status = {
    available: true,
    blockedUntil: '',
    remainingFraction: null,
  };
  // One at a time.
  /** @type {(value: any) => void} */
  let release = () => {};
  beneath.state.script.push(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const slow = E(endpoint).request(message());
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: 'Provider share exhausted',
  });
  release(harden({ status: 200, body: 'ok', usage: cost(200, 100) }));
  await slow;
  // The budget: 300 spent of 500, and the next reservation does not fit.
  await t.throwsAsync(
    () => E(endpoint).request(message({ max_output_tokens: 400 })),
    { message: 'Provider share exhausted' },
  );
  t.is(beneath.served.length, 1, 'refusals never reached what is beneath');
  // Exhaustion beneath reads as the share's; any other failure as a fault.
  beneath.state.script.push(() => {
    throw Error('Provider subscription exhausted');
  });
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: 'Provider share exhausted',
  });
  // Whatever else is thrown beneath, by whoever's daemon, is not repeated.
  beneath.state.script.push(() => {
    throw Error('upstream said something private');
  });
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: 'Provider share unavailable',
  });
  // The bare words of what is beneath do come through.
  for (const word of ['Provider request failed', 'Model denied']) {
    beneath.state.script.push(() => {
      throw Error(word);
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(endpoint).request(message()), {
      message: word,
    });
  }
  // Neither was charged: nothing came back.
  t.like((await E(share).getStatus()).budget, { spent: 300, reserved: 0 });
  // A new period admits again.
  state.now = T0 + 3_600_000 + 1;
  t.truthy(await E(endpoint).request(message({ max_output_tokens: 400 })));
});

test('a share serves only auto, counts hops, and refuses past the limit', async t => {
  const { share, beneath } = makeHarness();
  await t.throwsAsync(
    () => E(share).openEndpoint({ sessionId: 's', subscription: 'work' }),
    {
      message: /serves only "auto"/,
    },
  );
  await t.throwsAsync(() => E(share).openEndpoint({ sessionId: 'bad id' }));
  await E(share).openEndpoint({ sessionId: 's', hops: 3 });
  t.is(beneath.opened[0].spec.hops, 4);
  await t.throwsAsync(
    () => E(share).openEndpoint({ sessionId: 's', hops: 4 }),
    {
      message: /Too many subscriptions/,
    },
  );
  // A share of a share: the second counts on top of the first.
  const outer = makeSubscriptionShare({
    shareId: 'bob',
    provideUnderlying: async () => share,
    provideLimits: async () => ({ createdAt: new Date(T0).toISOString() }),
    journal: makeStore(),
    now: () => T0 + 1,
  });
  await E(outer.share).openEndpoint({ sessionId: 'z' });
  t.deepEqual(beneath.opened[beneath.opened.length - 1].spec, {
    sessionId: 'share-alice-share-bob-z',
    subscription: 'auto',
    hops: 2,
  });
});

test('revocation is durable, cancels what is open, and survives a meter write behind it', async t => {
  const store = makeStore();
  const beneath = makeBeneath();
  const { share, admin } = makeHarness({
    store,
    beneath,
    limits: { budget: { tokens: 1000, periodSeconds: 3600 } },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  /** @type {(value: any) => void} */
  let release = () => {};
  beneath.state.script.push(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const slow = E(endpoint).request(message());
  await new Promise(resolve => setTimeout(resolve, 5));
  await E(admin).revoke();
  t.true(beneath.opened[0].revoked, 'the open endpoint beneath was revoked');
  t.true(store.written[store.written.length - 1].revoked);
  // The in-flight response costs more than it reserved, so the meter writes
  // after the revocation. The flag must still be there.
  release(harden({ status: 200, body: 'ok', usage: cost(600, 100) }));
  await slow;
  await new Promise(resolve => setTimeout(resolve, 5));
  t.true(store.written[store.written.length - 1].revoked);
  t.true(Number(store.written[store.written.length - 1].meter.ceiling) >= 700);
  // The endpoint that was open is closed with it.
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: /Inference endpoint revoked/,
  });
  await t.throwsAsync(() => E(share).openEndpoint({ sessionId: 't' }), {
    message: /Provider share revoked/,
  });

  // A restart: revoked still, and the meter not refilled.
  const revived = makeHarness({
    store,
    beneath,
    limits: { budget: { tokens: 1000, periodSeconds: 3600 } },
  });
  await t.throwsAsync(() => E(revived.share).openEndpoint({ sessionId: 'u' }), {
    message: /Provider share revoked/,
  });
  const status = await E(revived.admin).getStatus();
  t.true(status.revoked);
  t.true(status.over);
  t.true(status.budget.spent >= 700);
});

test('an expired share is over, without anybody revoking it', async t => {
  const { share, state } = makeHarness({
    limits: { expiresAt: new Date(T0 + 10_000).toISOString() },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  t.truthy(await E(endpoint).request(message()));
  state.now = T0 + 10_001;
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: /Provider share revoked/,
  });
  t.like(await E(share).getStatus(), { available: false, over: true });
});

test('an endpoint that settles nothing is charged its reservation; limits are read again for each request', async t => {
  const { share, beneath, state } = makeHarness({
    limits: { budget: { tokens: 10_000, periodSeconds: 3600 } },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  beneath.state.script.push(() => harden({ status: 200, body: 'ok' }));
  await E(endpoint).request(message());
  const reserved = estimateRequest(
    message().body,
    { max_output_tokens: 100 },
    8192,
  );
  t.is((await E(share).getStatus()).budget.spent, reserved);
  // The grantor narrows the models; the open endpoint obeys.
  state.limits = { ...state.limits, models: ['other'] };
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: /Model denied/,
  });
});

test('a watcher is told now, after a request, and when what is beneath changes', async t => {
  const { share, beneath, close } = makeHarness({
    limits: { budget: { tokens: 1000, periodSeconds: 3600 } },
  });
  const reader = iterateReader(await E(share).watchStatus());
  const first = (await reader.next()).value;
  t.is(first.type, 'status');
  t.true(first.status.available);
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  await E(endpoint).request(message());
  const seen = async predicate => {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.next();
      if (done) throw Error('ended');
      if (predicate(value.status)) return value.status;
    }
  };
  t.is(
    (await seen(status => Number(status.budget.spent) > 0)).budget.spent,
    15,
  );
  beneath.state.status = {
    available: false,
    blockedUntil: '2026-09-21T00:00:00.000Z',
    remainingFraction: 0,
  };
  beneath.statusTopic.publish(harden({ type: 'status' }));
  t.is(
    (await seen(status => !status.available)).blockedUntil,
    '2026-09-21T00:00:00.000Z',
  );
  await reader.return(undefined);
  close();
});

test('a holder that never revokes its endpoints costs the share a bounded number of them', async t => {
  const { share, beneath } = makeHarness();
  const first = await E(share).openEndpoint({ sessionId: 's0' });
  for (let i = 1; i <= 256; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(share).openEndpoint({ sessionId: `s${i}` });
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  // The oldest was closed, beneath too; the rest serve.
  t.true(beneath.opened[0].revoked);
  t.false(beneath.opened[1].revoked);
  await t.throwsAsync(() => E(first).request(message()), {
    message: /Inference endpoint revoked/,
  });
});

test('requests that arrive together cannot each take the one free slot', async t => {
  const { share, beneath } = makeHarness({
    limits: { maxConcurrentRequests: 1 },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  /** @type {Array<(value: any) => void>} */
  const releases = [];
  // Only the first to reach what is beneath is held open.
  beneath.state.script.push(
    () =>
      new Promise(resolve => {
        releases.push(resolve);
      }),
  );
  const all = Promise.allSettled(
    [1, 2, 3, 4, 5].map(() => E(endpoint).request(message())),
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  t.is(beneath.served.length, 1, 'one reached what is beneath');
  for (const release of releases) {
    release(harden({ status: 200, body: 'ok', usage: cost(1, 1) }));
  }
  const results = await all;
  t.is(results.filter(result => result.status === 'fulfilled').length, 1);
  t.true(
    results
      .filter(result => result.status === 'rejected')
      .every(
        result =>
          /** @type {PromiseRejectedResult} */ (result).reason.message ===
          'Provider share exhausted',
      ),
  );
  // The slot is free again afterwards.
  t.truthy(await E(endpoint).request(message()));
});

test('a response cut short costs its reservation or its size, whichever is more', async t => {
  const { share, beneath } = makeHarness({
    limits: { budget: { tokens: 1_000_000, periodSeconds: 3600 } },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  const body = message().body;
  const reserved = estimateRequest(body, { max_output_tokens: 100 }, 8192);
  // Cancelled after the first event, which had named a token or two.
  beneath.state.script.push(() =>
    harden({
      status: 200,
      body: 'ok',
      usage: {
        began: true,
        complete: false,
        usage: { inputTokens: 3, outputTokens: 1 },
        responseBytes: 40,
      },
    }),
  );
  await E(endpoint).request(message());
  t.is((await E(share).getStatus()).budget.spent, reserved);
  // And one that streamed far past its reservation before it was dropped.
  beneath.state.script.push(() =>
    harden({
      status: 200,
      body: 'ok',
      usage: {
        began: true,
        complete: false,
        usage: null,
        responseBytes: 40_000,
      },
    }),
  );
  await E(endpoint).request(message());
  t.is(
    (await E(share).getStatus()).budget.spent,
    reserved + Math.ceil(Math.ceil(body.length / 4) + 10_000),
  );
});

test('a share nests three deep, and a long session id is named by its digest', async t => {
  const { share, beneath } = makeHarness();
  const id = 'abcdefghijklmnopqrstuvwxyz012345';
  let current = share;
  for (const name of ['two', 'three']) {
    const under = current;
    current = makeSubscriptionShare({
      shareId: `${name}-${id}`.slice(0, 32),
      provideUnderlying: async () => under,
      provideLimits: async () => ({ createdAt: new Date(T0).toISOString() }),
      journal: makeStore(),
      now: () => T0 + 1,
    }).share;
  }
  const long = 'session-'.padEnd(100, 'x');
  await E(current).openEndpoint({ sessionId: long });
  const { spec } = beneath.opened[beneath.opened.length - 1];
  t.is(spec.hops, 3);
  t.true(`${spec.sessionId}`.length <= 128);
  t.regex(spec.sessionId, /^share-alice-h[0-9a-f]{48}$/);
  // The same session is the same name again, so a pool beneath keeps it warm.
  await E(current).openEndpoint({ sessionId: long });
  t.is(
    beneath.opened[beneath.opened.length - 1].spec.sessionId,
    spec.sessionId,
  );
  t.is(namespacedSessionId('a', 'short'), 'share-a-short');
});

test('a share whose limits cannot be read can still be revoked, and stays revoked', async t => {
  const store = makeStore();
  const broken = makeSubscriptionShare({
    shareId: 'alice',
    provideUnderlying: async () => makeBeneath().subscription,
    provideLimits: async () => {
      throw Error('no limits bound');
    },
    journal: store,
    log: () => {},
  });
  await t.throwsAsync(() => E(broken.share).getStatus(), {
    message: 'Provider share unavailable',
  });
  await E(broken.admin).revoke();
  t.true(store.written[store.written.length - 1].revoked);
  const mended = makeHarness({ store });
  await t.throwsAsync(() => E(mended.share).openEndpoint({ sessionId: 's' }), {
    message: 'Provider share revoked',
  });
});

test('a request lost after the provider had its whole deadline is charged, and reads as a failure', async t => {
  const { share, beneath } = makeHarness({
    limits: { budget: { tokens: 1_000_000, periodSeconds: 3600 } },
  });
  const endpoint = await E(share).openEndpoint({ sessionId: 's' });
  beneath.state.script.push(() => {
    throw Error('Provider response lost');
  });
  // The word goes on up: a share made over this one must charge for it too.
  await t.throwsAsync(() => E(endpoint).request(message()), {
    message: 'Provider response lost',
  });
  const reserved = estimateRequest(
    message().body,
    { max_output_tokens: 100 },
    8192,
  );
  t.is((await E(share).getStatus()).budget.spent, reserved);

  // And a share of this share does.
  const outer = makeSubscriptionShare({
    shareId: 'bob',
    provideUnderlying: async () => share,
    provideLimits: async () => ({
      createdAt: new Date(T0).toISOString(),
      budget: { tokens: 1_000_000, periodSeconds: 3600 },
    }),
    journal: makeStore(),
    now: () => T0 + 1000,
    log: () => {},
  });
  const through = await E(outer.share).openEndpoint({ sessionId: 's' });
  beneath.state.script.push(() => {
    throw Error('Provider response lost');
  });
  await t.throwsAsync(() => E(through).request(message()));
  t.is((await E(outer.share).getStatus()).budget.spent, reserved);
  t.is((await E(share).getStatus()).budget.spent, 2 * reserved);
});
