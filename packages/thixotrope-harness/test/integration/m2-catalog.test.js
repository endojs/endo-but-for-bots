// @ts-check
/**
 * M2 acceptance 11 (milestones.md M2; R4-20, R4-21, R4-22, R4-33;
 * m2-interfaces.md 8.4; W2.9) through the daemon, against the fake
 * provider server's model catalogue on 127.0.0.1 (D-M2-4), from the m1a
 * state template:
 *
 * - The operator configures an OpenRouter backend as the factory's
 *   default, with a default model. A creation that names no backend and
 *   no model gets that model and the catalogue's context window.
 * - The operator changes the default model. The existing session keeps
 *   its model (its next request names it); a new session gets the new
 *   default (its request names that).
 * - `SessionFactory.listModels` marks the current default; a pinned model
 *   that is not in the catalogue and a model without its organization
 *   prefix are refused with the R4-21 texts.
 * - The catalogue was read once for all of it (R4-104 freshness).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-catalog -- \
 *     corepack yarn test test/integration/m2-catalog.test.js
 */
import '../unit/_m1a-prelude.js';

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
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
import { startFakeProviderServer } from '../fixtures/fake-provider-server.mjs';
import { makeSlice, requestId, sliceTemplate, waitFor } from './_m1a-slice.js';
import { makeTestSecretValue } from './_m2-secrets.js';

takeIntegrationLock(test, 'm2 catalog test');

const run = integrationEnabled ? test.serial : test.skip;

const FIRST = 'deepseek/deepseek-v4.1-flash';
const FIRST_WINDOW = 163_840;
const SECOND = 'acme/alpha-b';
const SECOND_WINDOW = 8192;
const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;
const keyDir = path.join(harnessTmp, `w29-cat-${process.pid}`);

/** @param {Record<string, unknown>} row */
const record = async row =>
  emit({ ...row, ...(await runIdentity()), crankBudget, loadAvg: loadAvg() });

/**
 * Submit and wait for the turn's `end` or `abort`.
 * @param {any} slice
 * @param {any} session
 * @param {any} live
 * @param {string} input
 */
const turn = async (slice, session, live, input) => {
  const from = /** @type {number} */ (live.deliveries.length);
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
  return last.event;
};

run(
  'acceptance 11: a change of the default model reaches new sessions only; listModels marks it; R4-21 refusals',
  async t => {
    t.timeout(4 * 60_000);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    t.teardown(() => rmSync(keyDir, { recursive: true, force: true }));
    process.env.THIX_HARNESS_SECRETS_KEY = path.join(keyDir, 'secrets.key');

    const server = await startFakeProviderServer({
      plan: [
        {
          match: { method: 'GET', path: '/api/v1/models' },
          file: 'openrouter-models.json',
          repeat: 20,
        },
      ],
    });
    t.teardown(() => server.close());
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);

    const secrets = await E(slice.admin).getSecrets();
    const secret = await E(secrets).create(
      harden({ label: 'provider key', description: 'catalogue test' }),
    );
    const writer = await E(secrets).openWriter();
    await E(writer).replace(secret, makeTestSecretValue('catalog'));
    const keyGrant = await E(secret).makeReadGrant();
    const backend = await E(slice.admin).makeBackend(
      harden({
        kind: 'openrouter',
        label: 'OpenRouter',
        keyGrant,
        modelId: 'acme/alpha-a',
        baseUrl: server.openRouterBaseUrl,
      }),
    );

    /** @type {Record<string, number>} */
    const marks = {};
    const mark = (/** @type {string} */ name) => {
      marks[name] = Math.round(performance.now());
    };
    // The operator's defaults.
    await E(slice.harness).configure(
      harden({
        backends: [backend],
        defaultBackend: backend,
        defaultModelId: FIRST,
      }),
    );
    t.deepEqual(await E(slice.factory).listBackends(), [backend]);

    /**
     * A creation that names neither backend nor model.
     * @param title
     */
    const create = async (/** @type {string} */ title) => {
      const t0 = performance.now();
      const session = await E(slice.factory).createSession(
        harden({ title, preset: slice.chatOnly, at: Date.now() }),
      );
      return { session, ms: performance.now() - t0 };
    };

    mark('configured');
    const one = await create('before the change');
    mark('one');
    const oneInfo = await E(one.session).getInfo();
    t.is(oneInfo.modelId, FIRST);

    const page = await E(slice.factory).listModels();
    t.is(page.state, 'ok');
    const firstRow = page.rows.find((/** @type {any} */ r) => r.default);
    t.is(firstRow?.modelId, FIRST);
    t.is(page.rows[0].modelId, FIRST, 'R4-20: the default row first');

    // The change.
    await E(slice.harness).configure(harden({ defaultModelId: SECOND }));
    mark('changed');
    const after = await E(slice.factory).listModels();
    mark('listed');
    t.is(after.rows.find((/** @type {any} */ r) => r.default)?.modelId, SECOND);

    const two = await create('after the change');
    mark('two');
    t.is((await E(two.session).getInfo()).modelId, SECOND);
    t.is((await E(one.session).getInfo()).modelId, FIRST, 'R4-22: kept');

    // Each session's request names its own model; the windows are the
    // catalogue's (R4-33), stored at creation.
    const liveOne = await slice.subscribe(one.session);
    const liveTwo = await slice.subscribe(two.session);
    server.push({ sse: 'openrouter-text.sse' }, { sse: 'openrouter-text.sse' });
    t.is((await turn(slice, one.session, liveOne, 'first')).type, 'end');
    t.is((await turn(slice, two.session, liveTwo, 'second')).type, 'end');
    const posts = server.requests().filter(r => r.method === 'POST');
    t.deepEqual(
      posts.map(r => r.json.model),
      [FIRST, SECOND],
    );
    const usageOne = await E(one.session).getUsage();
    const usageTwo = await E(two.session).getUsage();
    t.is(usageOne.context.windowTokens, FIRST_WINDOW);
    t.is(usageTwo.context.windowTokens, SECOND_WINDOW);

    mark('turns');
    // R4-21 refusals.
    await t.throwsAsync(
      () =>
        E(slice.factory).createSession(
          harden({
            title: 'unknown',
            preset: slice.chatOnly,
            backend,
            modelId: 'acme/not-listed',
            at: Date.now(),
          }),
        ),
      { message: textOf.unknownProviderModel('acme/not-listed') },
    );
    await t.throwsAsync(
      () =>
        E(slice.factory).createSession(
          harden({
            title: 'no prefix',
            preset: slice.chatOnly,
            backend,
            modelId: 'alpha-b',
            at: Date.now(),
          }),
        ),
      { message: texts.openRouterModelPrefix },
    );
    // A refused creation lists nothing half-made.
    const listed = await E(slice.factory).listSessions();
    t.is(listed.rows.length, 2);

    const reads = server
      .requests()
      .filter(r => r.method === 'GET' && r.path === '/api/v1/models');
    t.log(
      'catalogue reads at',
      reads.map(r => Math.round(r.receivedAt)),
      'marks',
      marks,
    );
    t.is(reads.length, 1, 'one catalogue read served every creation');
    await record({
      metric: 'm2.catalog.create',
      unit: 'ms',
      first: Math.round(one.ms),
      second: Math.round(two.ms),
      catalogueReads: reads.length,
    });
    await state.cleanup();
  },
);
