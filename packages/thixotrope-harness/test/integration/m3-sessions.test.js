// @ts-check
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
/**
 * M3 acceptance 3, 13, 14 and the protocol part of 12
 * (designs/m3-interfaces.md 12; W3.7) through the gateway: every call a
 * page makes goes through a Node CapTP client over a real loopback
 * WebSocket (`_m3-gateway.js`); only the operator's set-up (backends,
 * defaults, the provider key) uses the control socket, as the operator's
 * CLI does.
 *
 * 3. Two pages: a session created on one appears in the other's list feed
 *    within 500 ms; rename and delete propagate the same way; rows carry
 *    the R6-36 fields.
 * 14. After each turn, `getUsage()` through the gateway equals the
 *    session's own answer to the operator (the status bar's source).
 * 12 (protocol). A message sent during a turn is queued (`listPending`);
 *    `Composer.edit` and `QueueEntry.cancel` work from the page; after a
 *    restart the queue is held with the hold line and `sendNow` releases
 *    it in FIFO order (R4-56, R6-44).
 * 13 (protocol). The page lists presets, backends (the same presence on
 *    two calls) and the catalogue with the default row first; a failing
 *    catalogue answers `unavailable` with its text; a session created on a
 *    chosen model runs on it (the fake provider sees that model); a session
 *    created with the default keeps its model after the default changes
 *    (R4-22).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/m3-sessions.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import { startFakeProviderServer } from '../fixtures/fake-provider-server.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  collect,
  makeSlice,
  requestId,
  sliceTemplate,
  waitFor,
} from './_m1a-slice.js';
import { makeTestSecretValue, replaceSealed } from './_m2-secrets.js';
import {
  freePort,
  gatewayAdminOf,
  serveGateway,
  useTestWrappingKey,
} from './_m3-gateway.js';

takeIntegrationLock(test, 'm3 sessions test');

const run = integrationEnabled ? test.serial : test.skip;

const FIRST = 'deepseek/deepseek-v4.1-flash';
const SECOND = 'acme/alpha-b';
const ROW_FIELDS = [
  'activity',
  'backendTitle',
  'key',
  'messageCount',
  'modelId',
  'queuedCount',
  'session',
  'state',
  'title',
];

/** @type {Awaited<ReturnType<typeof startFromTemplate>> | undefined} */
let state;
/** @type {(() => void) | undefined} */
let removeKey;
/** @type {Awaited<ReturnType<typeof startFakeProviderServer>> | undefined} */
let server;
test.after.always(async () => {
  await state?.cleanup();
  await server?.close();
  removeKey?.();
});

/**
 * A page's list feed from the current revision, read in the background.
 * @param {any} powers
 */
const listFeed = async powers => {
  const factory = await E(powers.operator).getFactory();
  const { rev } = await E(factory).listSessions(harden({ limit: 1 }));
  return collect(await E(powers.live).subscribeList(rev));
};

/**
 * A page's live feed of one session (`watch()` then `subscribe`).
 * @param {any} powers
 * @param {any} session
 */
const sessionFeed = async (powers, session) => {
  const { rev } = await E(session).watch();
  return collect(await E(powers.live).subscribe(session, rev));
};

/**
 * Submit from a page and wait for that turn's end.
 * @param {any} powers
 * @param {any} session
 * @param {ReturnType<typeof collect>} feed
 * @param {string} text
 */
const turnFromPage = async (powers, session, feed, text) => {
  const from = feed.deliveries.length;
  const receipt = await E(powers.composer).submit(session, text, requestId());
  const { turnId } = await E(receipt.turn).getStatus();
  await feed.until(
    event =>
      (event.type === 'end' || event.type === 'abort') &&
      event.turnId === turnId,
    60_000,
    from,
  );
  return receipt;
};

/**
 * Inputs of a session's turns, oldest first, once `count` are settled.
 * @param {any} session
 * @param {number} count
 */
const settledInputs = (session, count) =>
  waitFor(
    async () => {
      /** @type {{ n: number, input: any, state: string }[]} */
      const turns = [];
      let page = await E(session).getHistoryPage();
      for (;;) {
        for (const tp of page.turns) {
          turns.push({
            n: Number(tp.turnId.slice(1)),
            input: tp.records[0]?.input,
            state: tp.state,
          });
        }
        if (page.next === undefined) break;
        page = await E(session).getHistoryPage(page.next);
      }
      return turns.length >= count &&
        turns.every(tp => tp.state !== 'running' && tp.state !== 'cancelling')
        ? turns.sort((a, b) => a.n - b.n).map(tp => tp.input)
        : undefined;
    },
    60_000,
    `${count} settled turns`,
    100,
  );

run('setup: served state, scripted and catalogue backends', async t => {
  removeKey = useTestWrappingKey('m3ss').remove;
  server = await startFakeProviderServer({
    plan: [
      {
        match: { method: 'GET', path: '/api/v1/models' },
        file: 'openrouter-models.json',
        repeat: 20,
      },
    ],
  });
  state = await startFromTemplate(await sliceTemplate());
  t.truthy(state.client);
});

run(
  'acceptance 3, 14, 12: list feed, usage, queue through the gateway',
  async t => {
    if (!state) throw Error('setup failed');
    const slice = await makeSlice(state);
    const { backend } = await slice.makeBackend(harden(sliceScript));
    await E(slice.harness).configure(harden({ backends: [backend] }));
    const port = await freePort();
    const gateway = await serveGateway(state, { port });
    const pageA = await gateway.connect();
    const pageB = await gateway.connect();
    const factoryA = await E(pageA.powers.operator).getFactory();
    const feedB = await listFeed(pageB.powers);

    // 3. Create on A; B's feed shows the row.
    const [preset] = await E(factoryA).listPresets();
    const [pageBackend] = await E(factoryA).listBackends();
    const session = await E(factoryA).createSession(
      harden({
        title: 'from page A',
        preset,
        backend: pageBackend,
        at: Date.now(),
      }),
    );
    // From the creator's answer to the other page's delivery (a row that
    // arrived first counts 0).
    const created = Date.now();
    const { key } = await E(session).getInfo();
    const seenAt = await feedB.until(
      event => event.type === 'row' && event.row.key === key,
      5000,
    );
    const appearMs = Math.max(0, feedB.deliveries[seenAt].arrivedAt - created);
    const row = feedB.deliveries[seenAt].event.row;
    t.deepEqual(
      Object.keys(row)
        .filter(name => name !== 'effort')
        .sort(),
      ROW_FIELDS,
    );
    t.is(row.title, 'from page A');

    await E(session).rename('renamed on A');
    const renamed = Date.now();
    const renameAt = await feedB.until(
      event =>
        event.type === 'row' &&
        event.row.key === key &&
        event.row.title === 'renamed on A',
      5000,
    );
    const renameMs = Math.max(
      0,
      feedB.deliveries[renameAt].arrivedAt - renamed,
    );

    // 14. Usage through the gateway equals the session's own answer.
    const liveA = await sessionFeed(pageA.powers, session);
    const controlSession = await E(slice.factory).findSession(key);
    for (const text of [inputs.hi, inputs.hi]) {
      await turnFromPage(pageA.powers, session, liveA, text);
      const viaPage = await E(session).getUsage();
      const viaOperator = await E(controlSession).getUsage();
      t.deepEqual(viaPage, viaOperator);
    }
    t.is((await E(session).getUsage()).turns, 2);

    // 12. A message sent during a turn is queued; Edit and Delete work.
    const composer = pageA.powers.composer;
    const running = await E(composer).submit(
      session,
      inputs.stall,
      requestId(),
    );
    t.is(running.state, 'started');
    await E(composer).submit(session, 'q1', requestId());
    const second = await E(composer).submit(session, 'q2', requestId());
    await E(composer).submit(session, 'q3', requestId());
    let pending = await E(session).listPending();
    t.deepEqual(
      pending.entries.map((/** @type {any} */ e) => e.preview),
      ['q1', 'q2', 'q3'],
    );
    await E(composer).edit(pending.entries[0].entry, 'q1 edited');
    await E(second.entry).cancel();
    pending = await E(session).listPending();
    t.deepEqual(
      pending.entries.map((/** @type {any} */ e) => e.preview),
      ['q1 edited', 'q3'],
    );

    // After SIGKILL the queue is held; Send now releases it in FIFO order.
    pageA.close();
    pageB.close();
    await feedB.stop();
    await liveA.stop();
    await state.kill();
    await state.restart();
    const { admin } = await gatewayAdminOf(state);
    await waitFor(
      async () => (await E(admin).status()).state === 'serving',
      60_000,
      'the restored gateway',
      100,
    );
    const again = await gateway.connect();
    const factoryAgain = await E(again.powers.operator).getFactory();
    const sessionAgain = await E(factoryAgain).findSession(key);
    const held = await E(sessionAgain).listPending();
    t.deepEqual(held.hold, { reason: 'restart', message: texts.holdRestart });
    t.deepEqual(
      held.entries.map((/** @type {any} */ e) => e.preview),
      ['q1 edited', 'q3'],
    );
    await E(held.entries[1].entry).sendNow();
    const order = await settledInputs(sessionAgain, 5);
    t.deepEqual(order, [inputs.hi, inputs.hi, inputs.stall, 'q3', 'q1 edited']);
    t.deepEqual(await E(sessionAgain).listPending(), { entries: [] });

    // 3. Delete on A (again), B (again) sees the row removed.
    const pageB2 = await gateway.connect();
    const feedB2 = await listFeed(pageB2.powers);
    await E(factoryAgain).deleteSession(sessionAgain);
    const deleted = Date.now();
    const removedAt = await feedB2.until(
      event => event.type === 'row-removed' && event.key === key,
      10_000,
    );
    const removeMs = Math.max(
      0,
      feedB2.deliveries[removedAt].arrivedAt - deleted,
    );
    await feedB2.stop();
    again.close();
    pageB2.close();
    emit({ metric: 'm3.sessions.listFeed', appearMs, renameMs, removeMs });
    t.true(appearMs <= 500, `the created row appeared in ${appearMs} ms`);
    t.true(renameMs <= 500, `the rename appeared in ${renameMs} ms`);
    t.true(removeMs <= 500, `the removal appeared in ${removeMs} ms`);
    await E(admin).stop();
  },
);

run(
  'acceptance 13: presets, backends, catalogue, chosen and default models',
  async t => {
    if (!state || !server) throw Error('setup failed');
    const slice = await makeSlice(state);
    const secrets = await E(slice.admin).getSecrets();
    const secret = await E(secrets).create(
      harden({ label: 'provider key', description: 'gateway catalogue test' }),
    );
    const writer = await E(secrets).openWriter();
    await replaceSealed(writer, secret, makeTestSecretValue('m3'));
    const keyGrant = await E(secret).makeReadGrant();
    const api = await E(slice.admin).makeBackend(
      harden({
        kind: 'openrouter',
        label: 'OpenRouter',
        keyGrant,
        modelId: 'acme/alpha-a',
        baseUrl: server.openRouterBaseUrl,
      }),
    );
    // A backend whose catalogue cannot be read (nothing listens there).
    const dead = await E(slice.admin).makeBackend(
      harden({
        kind: 'openrouter',
        label: 'Unreachable',
        keyGrant,
        modelId: 'acme/alpha-a',
        baseUrl: `http://127.0.0.1:${await freePort()}/api/v1`,
      }),
    );
    await E(slice.harness).configure(
      harden({
        backends: [api, dead],
        defaultBackend: api,
        defaultModelId: FIRST,
      }),
    );
    const gateway = await serveGateway(state);
    const page = await gateway.connect();
    const factory = await E(page.powers.operator).getFactory();

    const presets = await E(factory).listPresets();
    t.true(Number(presets.length) >= 1);
    t.truthy(await E(presets[0]).describe());
    const backends = await E(factory).listBackends();
    t.is(backends.length, 2);
    t.is(
      (await E(factory).listBackends())[0],
      backends[0],
      'A-2: one presence',
    );
    const [pageApi, pageDead] = backends;

    const models = await E(factory).listModels();
    t.is(models.state, 'ok');
    t.is(models.rows[0].modelId, FIRST, 'the default row first');
    t.true(models.rows[0].default === true);
    const failing = await E(factory).listModels(harden({ backend: pageDead }));
    t.is(failing.state, 'unavailable');
    t.is(typeof failing.error, 'string');
    t.log('failing catalogue text:', failing.error);

    // A session on a chosen model runs on it.
    const chosen = await E(factory).createSession(
      harden({
        title: 'chosen',
        preset: presets[0],
        backend: pageApi,
        modelId: SECOND,
        at: Date.now(),
      }),
    );
    t.is((await E(chosen).getInfo()).modelId, SECOND);
    // A session on the default keeps it after the default changes.
    const byDefault = await E(factory).createSession(
      harden({ title: 'default', preset: presets[0], at: Date.now() }),
    );
    t.is((await E(byDefault).getInfo()).modelId, FIRST);
    await E(slice.harness).configure(harden({ defaultModelId: SECOND }));
    t.is((await E(byDefault).getInfo()).modelId, FIRST, 'R4-22: kept');

    const live = await sessionFeed(page.powers, chosen);
    server.push({ sse: 'openrouter-text.sse' });
    await turnFromPage(page.powers, chosen, live, 'first');
    const posts = server.requests().filter(r => r.method === 'POST');
    t.deepEqual(
      posts.map(r => r.json.model),
      [SECOND],
    );
    await live.stop();
    page.close();
    await E(gateway.admin).stop();
  },
);
