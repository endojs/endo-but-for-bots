// @ts-check
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
/**
 * M3 browser acceptance across daemon restarts (designs/m3-interfaces.md
 * 7, 12; W3.8), in headless Chromium through `startBrowserGateway` with the
 * gateway on a fixed port (restored there after each restart):
 *
 * 12. A message sent during a turn shows as queued with Send now, Edit and
 *     Delete; Edit and Delete work; after a restart the queue is held with
 *     the hold line, and Send now releases it in FIFO order (R4-56, R6-44).
 * 7.  K5: SIGKILL mid-turn (inside a tool call) with two pages open: both
 *     show the outcome-unknown status row; Details opens "Turn journal and
 *     recovery"; "Record acknowledgement" works while idle; the provider saw
 *     one request and the tool ran once.
 * 4.  The daemon stopped for 60 s: the page shows "Server starting..." and
 *     reconnects by itself within 30 s of the gateway's return.
 *
 * Gated by THIX_HARNESS_BROWSER=1 and a Chromium (`_harness.mjs`):
 *
 *   corepack yarn test:browser test/browser/m3-ui-restart.test.mjs
 */
import '../unit/_m1a-prelude.js';

import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import { uiTexts } from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeSlice, waitFor } from '../integration/_m1a-slice.js';
import { freePort } from '../integration/_m3-gateway.js';
import {
  browserSkipReason,
  startBrowserGateway,
  trackSockets,
} from './_harness.mjs';

const skip = await browserSkipReason();
const run = skip === undefined ? test.serial : test.skip;
if (skip) test(`[browser] m3-ui-restart skipped: ${skip}`, t => t.pass());

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const restartScript = harden({
  turns: [
    {
      input: 'stall',
      rounds: [{ chunks: [{ text: 'stalling' }], stall: 'untilCancel' }],
    },
    {
      input: 'tool hang',
      rounds: [
        {
          chunks: [{ text: 'calling ' }, { text: 'echo' }],
          chunkDelayMs: 100,
          toolCalls: [
            {
              name: 'echo',
              args: JSON.stringify({ text: 'slow', delayMs: 600_000 }),
            },
          ],
          usage,
        },
        { chunks: [{ text: 'done' }], usage },
      ],
    },
    { rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
});

/** @type {Awaited<ReturnType<typeof startBrowserGateway>> | undefined} */
let harness;
/** @type {{ backend: any, log: () => any[] } | undefined} */
let made;
test.after.always(async () => {
  await harness?.close();
});

/** @param {any} page @param {string} key */
const openSession = async (page, key) => {
  await page.locator(`.floot-session-item[data-key="${key}"]`).click();
  await page.locator('textarea.floot-input').waitFor();
};

/** @param {any} page @param {string} text */
const send = async (page, text) => {
  const input = page.locator('textarea.floot-input');
  await input.fill(text);
  await input.press('Enter');
};

/** A new session made by the Node client; answers its key. @param {string} title */
const newSession = async title => {
  // eslint-disable-next-line no-use-before-define -- hoisted helper
  const client = await freshClient();
  try {
    const factory = await E(client.powers.operator).getFactory();
    const [preset] = await E(factory).listPresets();
    const [backend] = await E(factory).listBackends();
    const session = await E(factory).createSession(
      harden({ title, preset, backend, at: Date.now() }),
    );
    return (await E(session).getInfo()).key;
  } finally {
    client.close();
  }
};

/** The page is connected (no overlay). @param {any} page */
const connected = page =>
  page.locator('.thix-overlay').waitFor({ state: 'detached', timeout: 90_000 });

/**
 * A fresh signed-in client after a restart (the old one died with the
 * adapter).
 */
const freshClient = () => {
  if (!harness) throw Error('setup failed');
  const { gateway } = harness;
  return waitFor(
    () => gateway.connect().catch(() => undefined),
    60_000,
    'a client after restart',
    200,
  );
};

/** Inputs of the session's turns, oldest first. @param {any} session */
const turnInputs = async session => {
  const page = await E(session).getHistoryPage();
  return [...page.turns]
    .sort(
      (a, b) =>
        a.at - b.at || Number(a.turnId.slice(1)) - Number(b.turnId.slice(1)),
    )
    .map(tp => tp.records[0]?.input);
};

run('setup: daemon, scripted backend, gateway on a fixed port', async t => {
  harness = await startBrowserGateway({
    template: 'm2',
    initScript: trackSockets,
    gateway: { port: await freePort() },
  });
  const slice = await makeSlice(harness.state);
  made = await slice.makeBackend(restartScript);
  await E(slice.harness).configure(harden({ backends: [made.backend] }));
  t.is(harness.gateway.status.state, 'serving');
});

run(
  'acceptance 12: queue rows, Edit, Delete, held after restart, Send now',
  async t => {
    if (!harness) throw Error('setup failed');
    const key = await newSession('queue');
    const page = harness.page;
    await openSession(page, key);
    await send(page, 'stall');
    await page.locator('.thix-stop').waitFor();
    for (const text of ['q1', 'q2', 'q3']) await send(page, text);
    const rows = page.locator('.thix-queue [data-entry]');
    await waitFor(
      async () => (await rows.count()) === 3,
      15_000,
      'three queued rows',
    );
    const second = rows.nth(1);
    t.is(await rows.first().locator('[data-action="send-now"]').count(), 1);
    t.is(await second.locator('[data-action="edit"]').count(), 1);
    t.is(await second.locator('[data-action="delete"]').count(), 1);

    // Edit q2, delete q3.
    await second.locator('[data-action="edit"]').click();
    const box = page.locator('.floot-pending-input');
    await box.fill('q2 edited');
    await box.press('Enter');
    await page
      .locator('.thix-queue [data-entry]', { hasText: 'q2 edited' })
      .waitFor();
    await page
      .locator('.thix-queue [data-entry]', { hasText: 'q3' })
      .locator('[data-action="delete"]')
      .click();
    await waitFor(async () => (await rows.count()) === 2, 15_000, 'q3 deleted');

    // A clean restart: the stalled turn ends, the queue is held.
    await harness.state.stop();
    await harness.state.restart();
    await connected(page);
    await openSession(page, key);
    await page.locator('.floot-pending-hold').waitFor({ timeout: 30_000 });
    t.is(await rows.count(), 2, 'the queue survived the restart');

    // Send now on the head releases the queue in order.
    await rows.first().locator('[data-action="send-now"]').click();
    const client = await freshClient();
    const factory = await E(client.powers.operator).getFactory();
    const session = await E(factory).findSession(key);
    const inputs = await waitFor(
      async () => {
        const all = await turnInputs(session);
        const pending = await E(session).listPending();
        return all.includes('q2 edited') && pending.entries.length === 0
          ? all
          : undefined;
      },
      60_000,
      'the queue released',
      200,
    );
    t.deepEqual(inputs.slice(-2), ['q1', 'q2 edited'], 'FIFO order');
    t.false(inputs.includes('q3'));
    client.close();
  },
);

run(
  'acceptance 7, K5: SIGKILL mid-turn with two pages, recovery panel',
  async t => {
    if (!harness || !made) throw Error('setup failed');
    const key = await newSession('k5');
    const pageA = harness.page;
    const pageB = await harness.newPage();
    await openSession(pageA, key);
    await openSession(pageB, key);
    await send(pageA, 'tool hang');
    await pageB.locator('.streaming, .thix-thinking-row').first().waitFor();
    const turnId = await waitFor(
      () =>
        made
          ?.log()
          .find(l => l.kind === 'echo-start')
          ?.opId?.split('/')[0],
      30_000,
      'the echo call running',
      50,
    );
    await harness.state.kill();
    await harness.state.restart();
    for (const page of [pageA, pageB]) {
      await connected(page);
      await openSession(page, key);
      await page
        .locator(`.floot-msg-row.status[data-turn-state="outcome-unknown"]`)
        .waitFor({ timeout: 30_000 });
    }
    const log = made.log();
    t.is(
      log.filter(l => l.kind === 'request' && l.turnId === turnId).length,
      1,
      'one provider request',
    );
    t.is(
      log.filter(
        l => l.kind === 'echo-start' && l.opId.startsWith(`${turnId}/`),
      ).length,
      1,
      'one tool run',
    );

    // Details -> the recovery panel; acknowledge while idle.
    await pageA.locator('.thix-details-btn').first().click();
    await pageA.locator('.floot-recovery').waitFor();
    t.is(
      (await pageA.locator('.thix-recovery-title').textContent())?.trim(),
      uiTexts.recoveryTitle,
    );
    const item = pageA.locator(`.floot-recovery-turn[data-turn="${turnId}"]`);
    await item.locator('.thix-recovery-head').click();
    await item.locator('.thix-recovery-note').fill('checked by the test');
    await item.locator('.thix-confirm-effects').click();
    await item.locator('.thix-acknowledge-btn').click();
    await pageA
      .locator(`.floot-recovery-turn.acknowledged[data-turn="${turnId}"]`)
      .waitFor({ timeout: 15_000 });
    const client = await freshClient();
    const factory = await E(client.powers.operator).getFactory();
    const session = await E(factory).findSession(key);
    const status = await E(await E(session).findTurn(turnId)).getStatus();
    t.truthy(status.resolution, 'the daemon recorded the acknowledgement');
    client.close();
    await pageB.context().close();
  },
);

run(
  'acceptance 4: daemon down 60 s, "Server starting...", back within 30 s',
  async t => {
    if (!harness) throw Error('setup failed');
    const page = harness.page;
    await connected(page);
    await harness.state.stop();
    await page
      .locator('.thix-overlay-box', { hasText: uiTexts.serverStarting })
      .waitFor({ timeout: 30_000 });
    await delay(60_000);
    t.is(
      (await page.locator('.thix-overlay-box').textContent())?.trim(),
      uiTexts.serverStarting,
    );
    await harness.state.restart();
    const servedAt = Date.now();
    await waitFor(
      () =>
        harness?.gateway.connect().then(
          c => {
            c.close();
            return true;
          },
          () => false,
        ),
      60_000,
      'the gateway serving',
      100,
    );
    const listening = Date.now() - servedAt;
    await connected(page);
    const back = Date.now() - servedAt;
    t.log(
      `gateway listening ${listening} ms after serve; page back after ${back} ms`,
    );
    t.true(
      back - listening <= 32_000,
      `page back ${back - listening} ms after the gateway`,
    );
    const tracked = await page.evaluate(
      () => /** @type {any} */ (globalThis).thixTest,
    );
    t.true(
      tracked.overlays.some(
        (/** @type {any} */ [, text]) => text === uiTexts.serverStarting,
      ),
    );
  },
);
