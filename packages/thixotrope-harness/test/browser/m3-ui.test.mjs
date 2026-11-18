// @ts-check
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
/**
 * M3 browser acceptance without a daemon restart (designs/m3-interfaces.md
 * 12; W3.8), in headless Chromium through `startBrowserGateway`:
 *
 * 1 (page part). A query carrying `agent` is refused 400 and the page says
 *    so (R6-10).
 * 2 (page part). The secret is in no HTTP request line or header, nor in
 *    the WebSocket URL.
 * 9. At 640 px the sidebar is a drawer opened with ☰ over a backdrop; at
 *    641 px it is not.
 * 4 (socket part). The page's socket drops mid-turn: the overlay shows
 *    "Reconnecting…", a new socket opens at once (R6-14's first delay is 0),
 *    and the running turn re-attaches and streams to its end.
 * 5. Reload mid-turn: the page re-attaches to the running turn (R4-62).
 *    Close the page mid-turn and open another: the turn finished.
 * 14 (page part). The status bar equals `getUsage()` after a turn.
 * 15. ■ Stop cancels the running turn (the provider logs `cancelled`).
 * 6. The socket drops right before or right after a `submit` frame: the
 *    page resends from its saved draft only when no receipt exists, and the
 *    transcript has the message once.
 *
 * Gated by THIX_HARNESS_BROWSER=1 and a Chromium (`_harness.mjs`):
 *
 *   corepack yarn test:browser test/browser/m3-ui.test.mjs
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

import {
  gatewayTexts,
  uiTexts,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { usageLabel } from '../../ui/src/shell/StatusBar.js';
import { makeSlice, waitFor } from '../integration/_m1a-slice.js';
import {
  browserSkipReason,
  startBrowserGateway,
  trackSockets,
} from './_harness.mjs';

const skip = await browserSkipReason();
const run = skip === undefined ? test.serial : test.skip;
if (skip) test(`[browser] m3-ui skipped: ${skip}`, t => t.pass());

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The page script: a 6 s stream, a stall, else a short reply. */
export const uiScript = harden({
  turns: [
    {
      input: 'stream',
      rounds: [
        {
          chunks: Array.from({ length: 40 }, (_, i) => ({ text: `c${i} ` })),
          chunkDelayMs: 150,
          usage,
        },
      ],
    },
    {
      input: 'stall',
      rounds: [{ chunks: [{ text: 'stalling' }], stall: 'untilCancel' }],
    },
    { rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
});

/** @type {Awaited<ReturnType<typeof startBrowserGateway>> | undefined} */
let harness;
/** @type {{ backend: any, log: () => any[] } | undefined} */
let made;
/** @type {string} */
let sessionKey = '';
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

/** Turn rows of the page, oldest first. @param {any} page */
const turnRows = page =>
  page.locator('.thix-turn').evaluateAll((/** @type {any[]} */ rows) =>
    rows.map(row => ({
      turnId: row.getAttribute('data-turn'),
      state: row.getAttribute('data-state'),
      user: row.querySelector('.floot-msg-row.user .floot-msg')?.textContent,
      text: row.textContent,
    })),
  );

/**
 * Wait for the newest turn row with this input to reach a state.
 * @param {any} page
 * @param {string} input
 * @param {string[]} states
 */
const turnReaches = (page, input, states, ms = 60_000) =>
  waitFor(
    async () => {
      const rows = await turnRows(page);
      const row = rows.reverse().find(r => r.user === input);
      return row && states.includes(row.state) ? row : undefined;
    },
    ms,
    `a ${input} turn ${states.join('|')}`,
    100,
  );

/** @param {any} page */
const pageTest = page =>
  page.evaluate(() => /** @type {any} */ (globalThis).thixTest);

run('setup: daemon, scripted backend, page signed in', async t => {
  harness = await startBrowserGateway({
    template: 'm2',
    initScript: trackSockets,
  });
  const slice = await makeSlice(harness.state);
  made = await slice.makeBackend(uiScript);
  await E(slice.harness).configure(harden({ backends: [made.backend] }));
  const factory = await E(harness.client.powers.operator).getFactory();
  const [preset] = await E(factory).listPresets();
  const [backend] = await E(factory).listBackends();
  const session = await E(factory).createSession(
    harden({ title: 'browser', preset, backend, at: Date.now() }),
  );
  sessionKey = (await E(session).getInfo()).key;
  await harness.page
    .locator(`.floot-session-item[data-key="${sessionKey}"]`)
    .waitFor();
  t.is(await harness.page.title(), uiTexts.pageTitle);
});

run(
  'acceptance 1, 2 (page parts) and 9: query refusal, no secret in HTTP, drawer',
  async t => {
    if (!harness) throw Error('setup failed');
    const { gateway } = harness;
    /** @type {string[]} */
    const seen = [];
    const page = await harness.newPage(gateway.url, p => {
      p.on('request', async (/** @type {any} */ request) => {
        const headers = await request.allHeaders();
        seen.push(
          `${request.method()} ${request.url()} ${JSON.stringify(headers)}`,
        );
      });
      p.on('websocket', (/** @type {any} */ ws) => seen.push(`WS ${ws.url()}`));
    });
    await page
      .locator(`.floot-session-item[data-key="${sessionKey}"]`)
      .waitFor();
    t.true(seen.length > 0);
    t.true(seen.some(line => line.startsWith('WS ')));
    t.false(
      seen.some(line => line.includes(gateway.secret)),
      'the secret is in no request line, header or socket URL',
    );

    const refused = await page.goto(`${gateway.origin}/?agent=x`);
    t.is(refused.status(), 400);
    t.true((await page.textContent('body')).includes(gatewayTexts.queryConfig));

    // 9. The drawer.
    await page.goto(gateway.url);
    await page.setViewportSize({ width: 640, height: 800 });
    const app = page.locator('.thix-app');
    await page.locator('.thix-app[data-drawer="closed"]').waitFor();
    t.is(await page.locator('.floot-backdrop').count(), 0);
    await page.locator('.thix-menu-btn').click();
    await page.locator('.thix-app[data-drawer="open"]').waitFor();
    t.true(await page.locator('.floot-backdrop').isVisible());
    await page
      .locator('.floot-backdrop')
      .click({ position: { x: 600, y: 400 } });
    await page.locator('.thix-app[data-drawer="closed"]').waitFor();
    await page.setViewportSize({ width: 641, height: 800 });
    await page.locator('.thix-app[data-drawer="none"]').waitFor();
    t.is(await app.getAttribute('data-drawer'), 'none');
    await page.context().close();
  },
);

run(
  'acceptance 4 (socket), 5, 14 (page) and 15: drop, reload, close, usage, Stop',
  async t => {
    if (!harness || !made) throw Error('setup failed');
    let page = harness.page;
    await openSession(page, sessionKey);

    // 4. Drop the socket mid-turn.
    await send(page, 'stream');
    await page.locator('.streaming').waitFor();
    const before = (await pageTest(page)).opens.length;
    const droppedAt = Date.now();
    await page.evaluate(() => /** @type {any} */ (globalThis).thixTest.drop());
    const after = await waitFor(
      async () => {
        const tracked = await pageTest(page);
        return tracked.opens.length > before ? tracked : undefined;
      },
      5000,
      'a new socket',
      20,
    );
    const firstRetryMs = after.opens[before] - droppedAt;
    t.true(firstRetryMs < 1000, `first retry after ${firstRetryMs} ms`);
    t.true(
      after.overlays.some(([, text]) => text === uiTexts.reconnecting),
      'the overlay said Reconnecting…',
    );
    await turnReaches(page, 'stream', ['completed']);
    // The completed row's text settles from the live fold or the newest
    // history page; wait for the last chunk rather than read it once.
    const done = await waitFor(
      async () => {
        const rows = await turnRows(page);
        const row = rows.reverse().find(r => r.user === 'stream');
        return row?.text?.includes('c39') ? row : undefined;
      },
      15_000,
      'the last chunk on the page',
      100,
    ).catch(async error => {
      t.log(JSON.stringify((await turnRows(page)).slice(-2)));
      throw error;
    });
    t.true(done.text.includes('c0 '), 'the re-attached turn kept its start');

    // 14. The status bar equals getUsage().
    const factory = await E(harness.client.powers.operator).getFactory();
    const session = await E(factory).findSession(sessionKey);
    const expected = usageLabel(await E(session).getUsage());
    await waitFor(
      async () =>
        (await page.locator('.thix-usage').textContent()) === expected,
      10_000,
      'the usage label',
    );
    t.is(await page.locator('.thix-usage').textContent(), expected);

    // 5. Reload mid-turn: re-attach.
    const count = (await turnRows(page)).length;
    await send(page, 'stream');
    await page.locator('.streaming').waitFor();
    await page.reload();
    await openSession(page, sessionKey);
    await page.locator('.streaming').waitFor({ timeout: 15_000 });
    const reloaded = await turnReaches(page, 'stream', ['completed']);
    t.true(reloaded.text.includes('c39'));
    t.is((await turnRows(page)).length, count + 1);

    // 5. Close mid-turn; another page sees it finished.
    await send(page, 'stream');
    await page.locator('.streaming').waitFor();
    await page.context().close();
    page = await harness.newPage();
    await openSession(page, sessionKey);
    await waitFor(
      async () => {
        const rows = await turnRows(page);
        const last = rows[rows.length - 1];
        return last?.user === 'stream' && last.state === 'completed';
      },
      60_000,
      'the closed page turn completed',
      200,
    );
    t.pass();

    // 15. Stop.
    await send(page, 'stall');
    await page.locator('.thix-stop').waitFor();
    const stalled = await turnReaches(page, 'stall', ['running']);
    await page.locator('.thix-stop').click();
    await turnReaches(page, 'stall', ['cancelled']);
    await waitFor(
      () =>
        made
          ?.log()
          .some(l => l.kind === 'cancelled' && l.turnId === stalled.turnId),
      10_000,
      'the provider saw the cancel',
    );
    t.pass();
    harness.page = page;
  },
);

run(
  'acceptance 6: a send whose socket drops is in the transcript once',
  async t => {
    if (!harness) throw Error('setup failed');
    const page = harness.page;
    await openSession(page, sessionKey);
    const factory = await E(harness.client.powers.operator).getFactory();
    const session = await E(factory).findSession(sessionKey);
    for (const mode of ['before', 'after']) {
      const text = `once ${mode} ${Date.now()}`;
      await page.evaluate(m => {
        /** @type {any} */ (globalThis).thixTest.dropOnSubmit = m;
      }, mode);
      await send(page, text);
      await turnReaches(page, text, ['completed'], 60_000);
      // Every turn of the session with that input, from the daemon.
      const page1 = await E(session).getHistoryPage();
      const n = page1.turns.filter(
        (/** @type {any} */ tp) => tp.records[0]?.input === text,
      ).length;
      t.is(n, 1, `${mode}: once in the transcript`);
      const shown = (await turnRows(page)).filter(r => r.user === text).length;
      t.is(shown, 1, `${mode}: once on the page`);
    }
  },
);
