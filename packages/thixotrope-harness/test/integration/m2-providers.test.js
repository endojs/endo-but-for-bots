// @ts-check
/**
 * M2 acceptance 1, 6 and 8 (milestones.md M2; m2-interfaces.md 2.5, 8;
 * W2.1b) through the daemon: API backends made by the agent host's manager
 * with a key from its Secrets store, served by the adapter against the fake
 * provider server on 127.0.0.1 (D-M2-4), from the m1a state template (the
 * real session program).
 *
 * 1. An OpenRouter-format session streams more than one delta per reply
 *    (and so does an Anthropic one).
 * 6. Cancel mid-stream: the fake server sees the connection closed; the
 *    turn is `cancelled`. The milestone text says "`abort` emitted"; the
 *    session's event contract (m1a-interfaces.md 6, the `end` row) ends a
 *    cancelled turn with `end { status: 'cancelled' }` and keeps `abort`
 *    for a failed one (R4-79), so that is what is checked, and the stream
 *    carries no `abort` for the turn (reported to the PM, J-0424).
 * 8. A 429 with Retry-After is retried per R4-74 only while nothing was
 *    delivered: before any delta the turn completes after the wait; a
 *    stream cut after a delta fails the turn with no second request.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-providers -- \
 *     corepack yarn test test/integration/m2-providers.test.js
 *
 * The Secrets wrapping key file is made under H/tmp (outside the state
 * directory, D-6) through THIX_HARNESS_SECRETS_KEY and removed at the end;
 * the key value is a short placeholder, never a credential.
 */
import '../unit/_m1a-prelude.js';

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  BODY_MARKER,
  openRouterChunks,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { makeSlice, requestId, sliceTemplate, waitFor } from './_m1a-slice.js';
import { replaceSealed } from './_m2-secrets.js';

takeIntegrationLock(test, 'm2 providers test');

const run = integrationEnabled ? test.serial : test.skip;

const KEY = 'not a real key';
const OPENROUTER_MODEL = 'acme/alpha-a';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;
const keyDir = path.join(harnessTmp, `w21b-key-${process.pid}`);

/** @type {any} */
let shared;
/** @type {Awaited<ReturnType<typeof startFakeProviderServer>> | undefined} */
let server;

test.after.always(async () => {
  await server?.close();
  rmSync(keyDir, { recursive: true, force: true });
});

const catalogues = () => [
  {
    match: { method: 'GET', path: '/api/v1/models' },
    file: 'openrouter-models.json',
    repeat: 20,
  },
  {
    match: { method: 'GET', path: '/v1/models' },
    file: 'anthropic-models.json',
    repeat: 20,
  },
];

/**
 * One served state for the whole file: the fake server, a Secret with a
 * read grant, and an OpenRouter and an Anthropic backend reading it.
 * @param {import('ava').ExecutionContext} t
 */
const open = async t => {
  if (shared !== undefined) return shared;
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  process.env.THIX_HARNESS_SECRETS_KEY = path.join(keyDir, 'secrets.key');
  server = await startFakeProviderServer({ plan: catalogues() });
  const template = await sliceTemplate();
  // Shared by the file's tests: cleaned up in `test.after.always`.
  const state = await startFromTemplate(template, {});
  const slice = await makeSlice(state);
  const secrets = await E(slice.admin).getSecrets();
  const secret = await E(secrets).create(
    harden({ label: 'provider key', description: 'fake server key' }),
  );
  const writer = await E(secrets).openWriter();
  await replaceSealed(writer, secret, KEY);
  const keyGrant = await E(secret).makeReadGrant();
  const openRouter = await E(slice.admin).makeBackend(
    harden({
      kind: 'openrouter',
      label: 'OpenRouter',
      keyGrant,
      modelId: OPENROUTER_MODEL,
      baseUrl: server.openRouterBaseUrl,
    }),
  );
  const anthropic = await E(slice.admin).makeBackend(
    harden({
      kind: 'anthropic',
      label: 'Anthropic',
      keyGrant,
      modelId: ANTHROPIC_MODEL,
      baseUrl: server.anthropicBaseUrl,
    }),
  );
  shared = { state, slice, openRouter, anthropic };
  return shared;
};

test.after.always(async () => {
  await shared?.state.cleanup?.();
});

/**
 * A session on `backend` with its live subscription.
 * @param {any} slice
 * @param {any} backend
 * @param {string} modelId
 */
const sessionOn = async (slice, backend, modelId) => {
  const session = await E(slice.factory).createSession(
    harden({
      title: 'providers',
      preset: slice.chatOnly,
      backend,
      modelId,
      at: Date.now(),
    }),
  );
  const live = await slice.subscribe(session);
  return { session, live };
};

/**
 * Submit and wait for the turn's `end` or `abort`.
 * @param {any} slice
 * @param {any} session
 * @param {any} live
 * @param {string} input
 */
const turn = async (slice, session, live, input) => {
  const from = /** @type {number} */ (live.deliveries.length);
  const t0 = performance.now();
  const receipt = await E(slice.composer).submit(session, input, requestId());
  const { turnId } = await E(receipt.turn).getStatus();
  const last = await waitFor(
    () =>
      live.deliveries.find(
        (/** @type {any} */ d, /** @type {number} */ i) =>
          i >= from &&
          (d.event.type === 'end' || d.event.type === 'abort') &&
          d.event.turnId === turnId,
      ),
    60_000,
    `turn ${input}: end`,
    10,
  );
  /** @type {any[]} */
  const events = live.deliveries
    .slice(from)
    .map((/** @type {any} */ d) => d.event)
    .filter((/** @type {any} */ e) => e.turnId === turnId);
  return {
    turn: receipt.turn,
    turnId,
    last: last.event,
    deltas: events.filter((/** @type {any} */ e) => e.type === 'delta'),
    ms: performance.now() - t0,
  };
};

/**
 * A measurement row with the run's identity.
 * @param {Record<string, unknown>} row
 */
const record = async row =>
  emit({ ...row, ...(await runIdentity()), crankBudget, loadAvg: loadAvg() });

/** Chat requests the fake server received so far. */
const posts = () =>
  /** @type {NonNullable<typeof server>} */ (server)
    .requests()
    .filter(request => request.method === 'POST');

run(
  'acceptance 1: OpenRouter and Anthropic sessions stream more than one delta per reply',
  async t => {
    const { slice, openRouter, anthropic } = await open(t);
    const srv = /** @type {NonNullable<typeof server>} */ (server);
    srv.push({ sse: 'openrouter-text.sse' });
    const or = await sessionOn(slice, openRouter, OPENROUTER_MODEL);
    const a = await turn(slice, or.session, or.live, 'hello openrouter');
    t.is(a.last.type, 'end');
    t.true(a.deltas.length > 1, `${a.deltas.length} deltas`);
    t.is(
      a.deltas.map((/** @type {any} */ e) => e.text).join(''),
      'Hello, world. How can I help?',
    );
    const [request] = posts();
    t.is(request.path, '/api/v1/chat/completions');
    t.true(request.authorization);
    t.is(request.json.model, OPENROUTER_MODEL);
    t.true(request.json.stream);
    t.false(JSON.stringify(request.json).includes(KEY));

    srv.push({ sse: 'anthropic-text.sse' });
    const an = await sessionOn(slice, anthropic, ANTHROPIC_MODEL);
    const b = await turn(slice, an.session, an.live, 'hello anthropic');
    t.is(b.last.type, 'end');
    t.true(b.deltas.length > 1, `${b.deltas.length} deltas`);
    const anthropicRequest = posts()[1];
    t.is(anthropicRequest.path, '/v1/messages');
    t.is(anthropicRequest.json.model, ANTHROPIC_MODEL);
    t.is(anthropicRequest.json.max_tokens, 4096);
    await record({
      metric: 'm2.providers.turn',
      unit: 'ms',
      openRouter: Math.round(a.ms),
      anthropic: Math.round(b.ms),
      deltas: [a.deltas.length, b.deltas.length],
    });
    shared.or = or;
  },
);

run(
  'acceptance 6: cancel mid-stream closes the connection; the turn is cancelled and its stream ends',
  async t => {
    const { slice } = await open(t);
    const srv = /** @type {NonNullable<typeof server>} */ (server);
    const { session, live } = shared.or;
    srv.push({
      events: openRouterChunks({
        deltas: Array.from({ length: 400 }, (_, i) => `w${i} `),
      }),
      delayMs: 20,
    });
    const before = posts().length;
    const from = /** @type {number} */ (live.deliveries.length);
    const receipt = await E(slice.composer).submit(
      session,
      'a long one',
      requestId(),
    );
    const { turnId } = await E(receipt.turn).getStatus();
    await waitFor(
      () =>
        live.deliveries.some(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= from && d.event.type === 'delta' && d.event.turnId === turnId,
        ),
      30_000,
      'first delta',
    );
    const t0 = performance.now();
    await E(receipt.turn).cancel();
    await waitFor(
      () => posts()[before]?.closed === true,
      10_000,
      'the server sees the connection closed',
    );
    const closedMs = performance.now() - t0;
    const last = await waitFor(
      () =>
        live.deliveries.find(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= from &&
            (d.event.type === 'end' || d.event.type === 'abort') &&
            d.event.turnId === turnId,
        ),
      30_000,
      'the turn ends',
    );
    t.deepEqual(last.event, { type: 'end', turnId, status: 'cancelled' });
    const status = await E(receipt.turn).whenFinished();
    t.is(status.state, 'cancelled');
    t.false(posts()[before].completed);
    await record({
      metric: 'm2.providers.cancel.closed',
      unit: 'ms',
      value: Math.round(closedMs),
    });
  },
);

run(
  'acceptance 8: a 429 with Retry-After is retried before any delta, never after one',
  async t => {
    const { slice } = await open(t);
    const srv = /** @type {NonNullable<typeof server>} */ (server);
    const { session, live } = shared.or;
    srv.push(
      { status: 429, headers: { 'retry-after': '1' } },
      { sse: 'openrouter-text.sse' },
    );
    const before = posts().length;
    const retried = await turn(slice, session, live, 'rate limited');
    t.is(retried.last.type, 'end');
    t.is(posts().length - before, 2, 'asked twice');
    t.true(retried.ms >= 1000, `turn took ${Math.round(retried.ms)} ms`);
    t.true(retried.deltas.length > 1);

    srv.push(
      { sse: 'openrouter-text.sse', disconnectAfter: 4 },
      { status: 429, headers: { 'retry-after': '1' } },
    );
    const from = posts().length;
    const cut = await turn(slice, session, live, 'cut after a delta');
    t.is(cut.last.type, 'abort');
    t.is(cut.last.reason, texts.openRouterUnreachable);
    t.false(JSON.stringify(cut.last).includes(BODY_MARKER));
    t.is(posts().length - from, 1, 'not asked again after a delta');
    // Drop the unused 429 so nothing waits on it.
    srv.setPlan(catalogues());
    await record({
      metric: 'm2.providers.retry429',
      unit: 'ms',
      value: Math.round(retried.ms),
    });
  },
);
