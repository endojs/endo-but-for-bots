// @ts-check
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
/**
 * M3 browser acceptance 8 (designs/m3-interfaces.md 12; W3.8), in headless
 * Chromium through `startBrowserGateway` on the `m3-300` template (one
 * imported 300-turn session, `perf/_m3-client.mjs`):
 *
 * - tool calls fold into a "Thought for ..." group; an `exec` call shows
 *   its `code` highlighted; `</>` shows the raw JSON;
 * - scrolling up pages the 300-turn session back to turn 1
 *   across the archive with every turn once;
 * - a 1 MiB reply watched live renders fully (Show all reads it in pages).
 *
 * Gated by THIX_HARNESS_BROWSER=1 and a Chromium (`_harness.mjs`):
 *
 *   corepack yarn test:browser test/browser/m3-ui-history.test.mjs
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

import { makeSlice, waitFor } from '../integration/_m1a-slice.js';
import { browserSkipReason, startBrowserGateway } from './_harness.mjs';

const skip = await browserSkipReason();
const run = skip === undefined ? test.serial : test.skip;
if (skip) test(`[browser] m3-ui-history skipped: ${skip}`, t => t.pass());

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** A reply of exactly 1 MiB in 16 chunks of 64 KiB. */
const MEGA = 1_048_576;

const historyScript = harden({
  turns: [
    {
      input: 'tools',
      rounds: [
        {
          chunks: [{ text: 'calling' }],
          toolCalls: [
            { name: 'echo', args: JSON.stringify({ text: 'looked up' }) },
            {
              name: 'exec',
              args: JSON.stringify({ code: 'const answer = 6 * 7;\nanswer;' }),
            },
          ],
          usage,
        },
        { chunks: [{ text: 'done' }], usage },
      ],
    },
    {
      input: 'mega',
      rounds: [
        {
          chunks: Array.from({ length: 16 }, () => ({
            text: 'm',
            repeat: MEGA / 16,
          })),
          usage,
        },
      ],
    },
    { rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
});

/** @type {Awaited<ReturnType<typeof startBrowserGateway>> | undefined} */
let harness;
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

/** @param {any} page */
const turnIds = page =>
  page
    .locator('.thix-turn')
    .evaluateAll((/** @type {any[]} */ rows) =>
      rows.map(row => row.getAttribute('data-turn')),
    );

/** @type {string} */
let liveKey = '';
/** @type {string} */
let longKey = '';

run('setup: m3-300 template, scripted backend for live turns', async t => {
  t.timeout(5 * 60_000);
  harness = await startBrowserGateway({ template: 'm3-300' });
  const slice = await makeSlice(harness.state);
  const made = await slice.makeBackend(historyScript, { label: 'Live' });
  await E(slice.harness).configure(harden({ backends: [made.backend] }));
  const factory = await E(harness.client.powers.operator).getFactory();
  const { rows } = await E(factory).listSessions(harden({ limit: 50 }));
  longKey = rows.find((/** @type {any} */ r) => r.title === 'm3-300').key;
  const [preset] = await E(factory).listPresets();
  const [backend] = await E(factory).listBackends();
  const session = await E(factory).createSession(
    harden({ title: 'live', preset, backend, at: Date.now() }),
  );
  liveKey = (await E(session).getInfo()).key;
  t.truthy(longKey);
});

run(
  'acceptance 8: tool groups, exec highlight, raw view, 1 MiB reply',
  async t => {
    if (!harness) throw Error('setup failed');
    const page = harness.page;
    await page.locator(`.floot-session-item[data-key="${liveKey}"]`).waitFor();
    await openSession(page, liveKey);
    await send(page, 'tools');
    const turn = page.locator('.thix-turn[data-state="completed"]').last();
    await turn.waitFor({ timeout: 60_000 });
    const head = turn.locator('.floot-actions-head').first();
    // "Thought for" joins the header only with a thinking entry, which the
    // scripted provider cannot emit (W3.6's unit tests cover that label).
    t.regex((await head.textContent()) ?? '', /2 actions/);
    await head.click();
    const entries = turn.locator('.floot-action-head');
    t.true((await entries.count()) >= 2, 'two tool entries');
    await entries.last().click();
    await turn
      .locator(
        '.floot-code .floot-tok-keyword, .floot-code [class*="floot-tok-"]',
      )
      .first()
      .waitFor();
    t.true(
      (await turn.locator('.floot-code [class*="floot-tok-"]').count()) > 0,
      'exec source highlighted',
    );
    // `</>` replaces the conversation with each turn's raw JSON.
    await page.locator('.thix-raw-toggle').first().click();
    const raw =
      (await page
        .locator('.thix-raw-view .floot-tool-pre')
        .last()
        .textContent()) ?? '';
    t.notThrows(() => JSON.parse(raw), 'the raw view is JSON');
    await page.locator('.thix-raw-toggle').first().click();

    // 1 MiB reply.
    await send(page, 'mega');
    const mega = page.locator('.thix-turn[data-state="completed"]').last();
    await waitFor(
      async () =>
        (await mega.locator('.floot-msg-row.user .floot-msg').textContent()) ===
        'mega',
      120_000,
      'the mega turn completed',
      200,
    );
    // The live fold keeps a bounded text; the settled transcript holds the
    // reply as a staged field. The page re-reads the turn's records when it
    // settles (M3-FIX), so Show all pages the whole reply in without a
    // reload (J-9605 needed one).
    const showAll = mega.locator('.thix-show-all');
    await showAll.first().waitFor({ timeout: 30_000 });
    await showAll.first().click();
    const length = await waitFor(
      async () => {
        const n = await mega
          .locator('.floot-msg-row.assistant .floot-msg')
          .evaluateAll((/** @type {any[]} */ els) =>
            Math.max(
              0,
              ...els.map(el => (el.textContent.match(/m/g) ?? []).length),
            ),
          );
        return n >= MEGA ? n : undefined;
      },
      60_000,
      'the whole 1 MiB reply',
      250,
    );
    t.is(length, MEGA);
  },
);

run(
  'acceptance 8: scrolling up preserves the reading position through every page to turn 1',
  async t => {
    if (!harness) throw Error('setup failed');
    const page = harness.page;
    await openSession(page, longKey);
    await page
      .locator('.floot-header-title', { hasText: 'm3-300' })
      .waitFor({ timeout: 15_000 });
    await waitFor(
      async () => (await turnIds(page)).some(id => Number(id.slice(1)) > 2),
      30_000,
      'the m3-300 turns on screen',
      100,
    );
    await page.locator('.thix-turn').first().waitFor();
    await page.setViewportSize({ width: 900, height: 480 });
    const scroller = page.locator('.thix-conversation');
    t.is(
      await page.getByRole('button', { name: 'Load earlier messages' }).count(),
      0,
    );
    let pages = 0;
    for (;;) {
      const ids = await turnIds(page);
      if (ids.includes('t1')) break;
      if (pages > 100) throw Error('too many pages');
      const first = scroller.locator('.thix-turn').first();
      const id = await first.getAttribute('data-turn');
      const old = scroller.locator(`.thix-turn[data-turn="${id}"]`);
      const topAtStart = await old.evaluate((/** @type {HTMLElement} */ el) => {
        const parent = /** @type {HTMLElement} */ (
          el.closest('.thix-conversation')
        );
        return el.getBoundingClientRect().top + parent.scrollTop;
      });
      await scroller.hover();
      await page.mouse.wheel(0, -1_000_000);
      await waitFor(
        async () => (await turnIds(page)).length > ids.length,
        30_000,
        'an earlier page after a real upward wheel event',
        50,
      );
      const top = await old.evaluate(
        (/** @type {HTMLElement} */ el) => el.getBoundingClientRect().top,
      );
      t.true(
        Math.abs(top - topAtStart) <= 2,
        `page ${pages}: anchor ${top} vs ${topAtStart}`,
      );
      pages += 1;
    }
    t.true(pages > 1);
    const ids = await turnIds(page);
    const numbers = ids.map(id => Number(String(id).slice(1)));
    t.is(new Set(ids).size, ids.length, 'every turn once');
    const max = Math.max(...numbers);
    t.true(max >= 300);
    t.deepEqual(
      [...numbers].sort((a, b) => a - b),
      Array.from({ length: max }, (_, i) => i + 1),
      'turns 1..N, none missing',
    );
    const scrollPosition = () =>
      scroller.evaluate((/** @type {HTMLElement} */ el) => ({
        top: el.scrollTop,
        remaining: el.scrollHeight - el.clientHeight - el.scrollTop,
      }));
    const position = await scrollPosition();
    t.true(position.remaining > 48);
    await send(page, 'update while reading earlier messages');
    await waitFor(
      async () => (await turnIds(page)).length > ids.length,
      30_000,
      'first incoming turn',
      50,
    );
    t.true(
      Math.abs((await scrollPosition()).top - position.top) <= 2,
      'incoming turn keeps the reading position',
    );
    await scroller.hover();
    await page.mouse.wheel(0, 1_000_000);
    await waitFor(
      async () => (await scrollPosition()).remaining < 2,
      10_000,
      'reader reached the latest turn',
      50,
    );
    await send(page, 'update while reading latest');
    await waitFor(
      async () => (await turnIds(page)).length > ids.length + 1,
      30_000,
      'second incoming turn',
      50,
    );
    t.true(
      (await scrollPosition()).remaining < 2,
      'the latest turn stays in view',
    );
    t.log(`${ids.length} turns in ${pages} pages`);
  },
);

run('rule 4a: every call the page made was admitted (XD)', async t => {
  if (!harness) throw Error('setup failed');
  // m3-interfaces.md 4.4 rule 4a: a method outside the gateway's `methods`
  // is refused `gatewayTexts.unknownMethod` and logged with rule `method`.
  t.deepEqual(harness.gatewayLog.refused('method'), []);
});
