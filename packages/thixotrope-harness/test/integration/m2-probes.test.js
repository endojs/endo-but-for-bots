// @ts-check
/**
 * M2 too-big probes (milestones.md M2 perf table, last probe row; W2.9),
 * from the m1a state template, scripted backend:
 *
 * - A submission of exactly `messageUnits` (200,000) characters through the
 *   Composer is accepted (staged) and its turn completes; one of 200,001 is
 *   refused by the Composer's guard and nothing reaches the session.
 * - A 100 KiB string sent straight to a vat method through the admin path
 *   (`Session.startTurn` with inline text) is refused. The row asks for a
 *   refusal before sending (the session vat's delivery frontier does not
 *   move): a known failure, the control client sends it and the vat's
 *   guard refuses it (J-9407).
 * - After each, the next ordinary turn completes (no halt).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-probes -- \
 *     corepack yarn test test/integration/m2-probes.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
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
import { makeSlice, requestId, sliceTemplate } from './_m1a-slice.js';

takeIntegrationLock(test, 'm2 probes test');

const run = integrationEnabled ? test.serial : test.skip;

/** The session vat's delivery frontier around the 100 KiB call. */
let frontier = [0, 0];

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const script = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'ok' }], usage }] }],
});

run(
  'too-big probes: 200 k characters accepted, 200 k + 1 refused; a 100 KiB inline string refused; no halt',
  async t => {
    t.timeout(4 * 60_000);
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(script);
    const session = await slice.createSession(made.backend, 'probes');
    const { key } = await E(session).getInfo();

    /** An ordinary turn completes. */
    const ordinary = async (/** @type {string} */ text) => {
      const receipt = await slice.submit(session, text);
      const status = await E(receipt.turn).whenFinished();
      t.is(status.state, 'completed', text);
    };
    await ordinary('first');

    // 200,000 characters: accepted (staged by the Composer), completes.
    const exact = 'x'.repeat(limits.messageUnits);
    const t0 = Date.now();
    const receipt = await E(slice.composer).submit(session, exact, requestId());
    const status = await E(receipt.turn).whenFinished();
    t.is(status.state, 'completed');
    const exactMs = Date.now() - t0;
    const requests = made
      .log()
      .filter((/** @type {any} */ l) => l.kind === 'request');
    t.is(requests.length, 2);

    // 200,001: refused; nothing reaches the session.
    const turnsBefore = (await E(session).getUsage()).turns;
    const over = await t.throwsAsync(() =>
      E(slice.composer).submit(session, `${exact}y`, requestId()),
    );
    t.is((await E(session).getUsage()).turns, turnsBefore);
    await ordinary('after the 200 k + 1 refusal');

    // A 100 KiB inline string straight to the vat method.
    const worker = async () =>
      (await slice.workers()).find(
        (/** @type {any} */ w) => w.debugLabel === `session ${key}`,
      ) ??
      (await slice.workers())
        .filter((/** @type {any} */ w) =>
          /^spare session \d+$/.test(w.debugLabel),
        )
        .sort(
          (/** @type {any} */ a, /** @type {any} */ b) =>
            b.journalLength - a.journalLength,
        )[0];
    const frontierBefore = Number((await worker())?.journalLength);
    const direct = await t.throwsAsync(() =>
      E(session).startTurn(
        harden({ text: 'z'.repeat(100 * 1024) }),
        Date.now(),
      ),
    );
    const frontierAfter = Number((await worker())?.journalLength);
    await ordinary('after the 100 KiB refusal');

    emit({
      metric: 'm2.tooBig',
      exactMs,
      overError: String(over?.message).slice(0, 200),
      directError: String(direct?.message).slice(0, 200),
      frontier: [frontierBefore, frontierAfter],
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
    frontier = [frontierBefore, frontierAfter];
    await state.cleanup();
  },
);

// Known failure (W2.9, J-9407): the milestone row asks that the client
// library refuse a 100 KiB string before sending. The control client sends
// it; the session vat's own guard refuses it (no halt, the next turn
// completes), so the vat's delivery frontier moves by one.
(integrationEnabled ? test.failing : test.skip)(
  'a 100 KiB inline string is refused before it is sent [known failure: the control client sends it; the vat guard refuses it]',
  t => {
    t.true(frontier[0] > 0, 'the probe above ran');
    t.is(frontier[1], frontier[0], 'nothing was delivered to the vat');
  },
);
