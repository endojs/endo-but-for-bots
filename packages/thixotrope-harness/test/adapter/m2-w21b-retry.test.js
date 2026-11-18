// @ts-check
// M2 W2.1b: the retry schedule (resources/agent-host/impl/providers/retry.js;
// designs/m2-interfaces.md 8.2; R4-74, R4-105), unit by unit with scripted
// attempts and a recording sleep, then OpenRouter's retries against the fake
// provider server (acceptance 8 at adapter level: a 429 with Retry-After is
// retried before any delta and never after one).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import {
  anthropicDelay,
  isDelivery,
  makeRetry,
  openRouterDelay,
  sleeperOf,
  withRetries,
} from '../../resources/agent-host/impl/providers/retry.js';
import { ProviderFailure } from '../../resources/agent-host/impl/providers/round.js';
import {
  makeOpenRouterProvider,
  openRouterKind,
} from '../../resources/agent-host/impl/providers/openrouter.js';
import {
  openRouterChunks,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { noBodyOrKey, runApiRound, timers } from './_m2-w21b-round.js';

const usage = (/** @type {number} */ n) =>
  harden({
    inputTokens: n,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });

/**
 * Run `withRetries` over scripted attempts: each script entry is the
 * attempt's events and then, unless `ok`, the failure it throws.
 * @param {Array<{ events?: any[], fail?: any, ok?: boolean }>} script
 * @param {Partial<Parameters<typeof withRetries>[0]>} [options]
 */
const drive = async (script, options = {}) => {
  /** @type {number[]} */
  const waits = [];
  /** @type {any[]} */
  const notices = [];
  let attempts = 0;
  const controller = new AbortController();
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let error;
  try {
    for await (const event of withRetries({
      attempt: async function* attempt() {
        const step = script[attempts];
        attempts += 1;
        for (const scripted of step.events ?? []) yield scripted;
        if (!step.ok) throw step.fail;
      },
      delayMs: openRouterDelay,
      sleep: async ms => {
        waits.push(ms);
      },
      signal: controller.signal,
      onRetry: notice => notices.push(notice),
      ...options,
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error, waits, attempts, notices };
};

const busy = (/** @type {Record<string, any>} */ details = {}) =>
  new ProviderFailure(textOf.openRouterHttp(503), {
    retryable: true,
    status: 503,
    ...details,
  });

test('schedules: OpenRouter min(30 s, max(RA, 1 s x 3^(n-1))); Anthropic min(8 s, max(RA, 0.5 s x 2^(n-1)))', t => {
  t.deepEqual(
    [1, 2, 3, 4, 5].map(n => openRouterDelay(n)),
    [1000, 3000, 9000, 27_000, 30_000],
  );
  t.is(openRouterDelay(1, 7000), 7000);
  t.is(openRouterDelay(1, 90_000), 30_000);
  t.deepEqual(
    [1, 2, 3, 4, 5].map(n => anthropicDelay(n)),
    [500, 1000, 2000, 4000, 8000],
  );
  t.is(anthropicDelay(2, 3000), 3000);
  t.is(anthropicDelay(1, 60_000), 8000);
});

test('deliveries: a delta, or usage that reports tokens; zero usage is not one', t => {
  t.true(isDelivery({ delta: 'x' }));
  t.false(isDelivery({ delta: '' }));
  t.true(isDelivery({ usage: usage(3) }));
  t.false(isDelivery({ usage: usage(0) }));
  t.false(isDelivery({ toolCall: { name: 'x', args: '{}' } }));
  t.false(isDelivery({ servedBy: {} }));
  t.false(isDelivery({ nativeContext: 'x' }));
});

test('retried while nothing was delivered: waits per schedule, held events of failed attempts dropped', async t => {
  const r = await drive([
    {
      events: [{ servedBy: { modelId: 'a/b' } }, { usage: usage(0) }],
      fail: busy({ retryAfterMs: 2000 }),
    },
    { events: [{ toolCall: { name: 'x', args: '1' } }], fail: busy() },
    {
      events: [{ delta: 'hi' }, { usage: usage(4) }, { stop: 'stop' }],
      ok: true,
    },
  ]);
  t.is(r.error, undefined);
  t.is(r.attempts, 3);
  t.deepEqual(r.waits, [2000, 3000]);
  t.deepEqual(r.events, [
    { delta: 'hi' },
    { usage: usage(4) },
    { stop: 'stop' },
  ]);
  t.deepEqual(
    r.notices.map(n => [n.attempt, n.waitMs, n.failure.status]),
    [
      [1, 2000, 503],
      [2, 3000, 503],
    ],
  );
});

test('never retried after a delta or consumed tokens; the failure keeps its text and the events seen', async t => {
  const afterDelta = await drive([
    { events: [{ delta: 'part' }], fail: busy() },
  ]);
  t.is(afterDelta.attempts, 1);
  t.is(afterDelta.error.reason, textOf.openRouterHttp(503));
  t.deepEqual(afterDelta.events, [{ delta: 'part' }]);
  const consumed = await drive([
    { events: [{ servedBy: {} }, { usage: usage(9) }], fail: busy() },
  ]);
  t.is(consumed.attempts, 1);
  t.deepEqual(consumed.events, [{ servedBy: {} }, { usage: usage(9) }]);
  const saysDelivered = await drive([{ fail: busy({ delivered: true }) }]);
  t.is(saysDelivered.attempts, 1);
});

test('the last failure says how many attempts; a non-retryable failure is not retried', async t => {
  const three = await drive([
    { fail: busy() },
    { fail: busy() },
    { events: [{ usage: usage(0) }], fail: busy({ status: 502 }) },
  ]);
  t.is(three.attempts, 3);
  t.is(three.error.reason, textOf.afterAttempts(textOf.openRouterHttp(503), 3));
  t.is(three.error.status, 502);
  t.false(three.error.retryable);
  t.deepEqual(three.events, [{ usage: usage(0) }], 'last held events kept');
  const refused = await drive([
    { fail: new ProviderFailure(textOf.openRouterHttp(400)) },
  ]);
  t.is(refused.attempts, 1);
  t.is(refused.error.reason, textOf.openRouterHttp(400));
  const fixedAttempts = await drive([{ fail: busy() }, { fail: busy() }], {
    maxAttempts: 2,
  });
  t.is(fixedAttempts.attempts, 2);
});

test('at most one timeout retry; a thrown non-provider error is not retried', async t => {
  const timeout = () =>
    new ProviderFailure(textOf.openRouterTimeout(3600), {
      retryable: true,
      timedOut: true,
    });
  const r = await drive([{ fail: timeout() }, { fail: timeout() }]);
  t.is(r.attempts, 2);
  t.is(r.error.reason, textOf.afterAttempts(textOf.openRouterTimeout(3600), 2));
  t.true(r.error.timedOut);
  const mixed = await drive([
    { fail: timeout() },
    { fail: busy() },
    { ok: true, events: [{ delta: 'ok' }] },
  ]);
  t.is(mixed.attempts, 3);
  t.is(mixed.error, undefined);
  const odd = await drive([{ fail: TypeError('boom') }, { ok: true }]);
  t.is(odd.attempts, 1);
  t.is(odd.error.name, 'TypeError');
});

test('cancel during the wait ends the round at once, with no further attempt', async t => {
  const controller = new AbortController();
  let attempts = 0;
  const sleep = sleeperOf(timers);
  const started = Date.now();
  const run = (async () => {
    for await (const _ of withRetries({
      attempt: async function* attempt() {
        attempts += 1;
        yield* [];
        throw busy();
      },
      delayMs: () => 60_000,
      sleep,
      signal: controller.signal,
    })) {
      // nothing
    }
  })();
  await timers.delay(30);
  controller.abort();
  const error = await run.then(
    () => undefined,
    caught => caught,
  );
  t.is(attempts, 1);
  t.truthy(error);
  t.true(Date.now() - started < 1000, 'the wait ended at the cancel');
});

/** @param {import('ava').ExecutionContext} t */
const serverFor = async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  return server;
};

/**
 * @param {Awaited<ReturnType<typeof startFakeProviderServer>>} server
 * @param {Record<string, any>} [options]
 */
const openRouter = (server, options = {}) =>
  runApiRound(makeOpenRouterProvider, {
    baseUrl: server.openRouterBaseUrl,
    modelId: 'fake-org/fake-model',
    waitMs: 15_000,
    unexpectedFailure: openRouterKind.unexpectedFailure,
    ...options,
  });

test('acceptance 8 (adapter): OpenRouter retries a 429 with Retry-After before any delta, never after one', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { status: 429, headers: { 'retry-after': '1' } },
    { sse: 'openrouter-text.sse' },
  ]);
  const r = await openRouter(server);
  t.teardown(r.cleanup);
  t.is(r.finals[0].text, 'Hello, world. How can I help?');
  t.is(server.requests().length, 2);
  t.true(r.elapsedMs >= 1000, `waited ${r.elapsedMs} ms`);
  t.deepEqual(
    r.log
      .filter(line => line.kind === 'retry')
      .map(line => [line.attempt, line.waitMs, line.status]),
    [[1, openRouterDelay(1, 1000), 429]],
  );
  noBodyOrKey(t, r);

  // After a delta: a cut stream is not asked again.
  server.setPlan([
    { sse: 'openrouter-text.sse', disconnectAfter: 4 },
    { status: 429, headers: { 'retry-after': '1' } },
  ]);
  const cut = await openRouter(server);
  t.teardown(cut.cleanup);
  t.is(cut.failures[0].reason, texts.openRouterUnreachable);
  t.is(cut.failures[0].partial, 'Hello, ');
  t.is(server.requests().length, 3, 'no retry after the delta');
  t.is(server.pending(), 1, 'the planned 429 was never asked for');
});

test('OpenRouter: an empty answer with no tokens is asked again; with tokens it is not (R4-74, R4-78)', async t => {
  const server = await serverFor(t);
  const fast = makeRetry({ timers, delayMs: () => 10 });
  server.setPlan([
    { events: openRouterChunks({ usage: null }) },
    { sse: 'openrouter-text.sse' },
    { events: openRouterChunks({}) },
  ]);
  const r = await openRouter(server, { retry: fast });
  t.teardown(r.cleanup);
  t.is(r.finals[0].text, 'Hello, world. How can I help?');
  t.is(server.requests().length, 2);
  const consumed = await openRouter(server, { retry: fast });
  t.teardown(consumed.cleanup);
  t.true(consumed.failures[0].reason.startsWith(textOf.openRouterEmpty('')));
  t.is(consumed.failures[0].usage.inputTokens, 12);
  t.is(server.requests().length, 3);
});

test('OpenRouter: 5xx three times fails with the attempt count; 408 and network failures are retried', async t => {
  const server = await serverFor(t);
  const fast = makeRetry({ timers, delayMs: () => 10 });
  server.setPlan([{ status: 502, repeat: 3 }]);
  const r = await openRouter(server, { retry: fast });
  t.teardown(r.cleanup);
  t.is(
    r.failures[0].reason,
    textOf.afterAttempts(textOf.openRouterHttp(502), 3),
  );
  t.is(server.requests().length, 3);
  noBodyOrKey(t, r);
  server.setPlan([
    { status: 408 },
    { sse: 'openrouter-text.sse', disconnectAfter: 1 },
    { sse: 'openrouter-text.sse' },
  ]);
  const ok = await openRouter(server, { retry: fast });
  t.teardown(ok.cleanup);
  t.is(ok.finals.length, 1);
  t.is(server.requests().length, 6);
});

test('OpenRouter: the request timeout is configurable and retried once', async t => {
  const server = await serverFor(t);
  server.setPlan([{ hang: true, repeat: 2 }]);
  const r = await openRouter(server, {
    spec: { timeoutMs: 120 },
    retry: makeRetry({ timers, delayMs: () => 10 }),
  });
  t.teardown(r.cleanup);
  t.is(
    r.failures[0].reason,
    textOf.afterAttempts(textOf.openRouterTimeout(0), 2),
  );
  t.is(server.requests().length, 2);
});
