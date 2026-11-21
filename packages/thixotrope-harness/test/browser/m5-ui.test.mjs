// @ts-check
/* eslint-disable import/no-relative-packages */
// M5 acceptance 15 (m5-interfaces.md 8.1; P-49, R6-40; W5.8) in headless
// Chromium against a real daemon, through M3's `startBrowserGateway`
// (m3-interfaces.md 17, W3.8). Gated by THIX_HARNESS_BROWSER=1 and run
// after M3 and M5's vat side are merged:
//
// - a preset saved on device A appears on device B after Reload;
// - B's stale save shows the catalogue's refusal and keeps B's edits;
// - an over-size record is refused by the editor before sending (the
//   preset is unchanged in the daemon);
// - typing `@` lists inventory labels and sending attaches the object (the
//   transcript shows the attachment chip);
// - after a reload, resending the saved draft shows `attachmentsLost` and
//   keeps the draft (shown when that session's view opens);
// - after the same reload a plain saved draft with an A.4 request id is
//   resent for real: one receipt, one completed turn, the draft cleared;
// - rule 4a: no call of the page was refused `unknown method` (XD).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { E } from '@endo/far';

import { texts } from '../../guest/lib/interfaces.js';
import {
  makeSlice,
  requestId as newRequestId,
  turnWithInput,
  waitFor,
} from '../integration/_m1a-slice.js';

import { turnRecords } from '../integration/_m1b.js';

/** A scripted backend that answers every turn with a short reply. */
const replyScript = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'ok' }] }] }],
});

const enabled = process.env.THIX_HARNESS_BROWSER === '1';

/**
 * A label of 80 units (77 three-byte) with a three-digit suffix.
 *
 * @param {number} i
 */
const longLabel = i => `${'€'.repeat(77)}${String(i).padStart(3, '0')}`;

/**
 * Daemon set-up before the gateway serves: 32 inventory entries with long
 * labels and distinct values (the editor keeps one endowment per object),
 * `notes` and `calc`. The session is made after the start, on a scripted
 * backend (the template configures none).
 *
 * @param {{ operator: any }} powers
 */
const provision = async ({ operator }) => {
  const presets = await E(E(operator).getPresets()).list();
  const inventory = E(operator).getInventory();
  const seeds = await E(inventory).addAll(
    harden(
      Array.from({ length: 32 }, (_, i) => ({
        label: `seed-${i}`,
        value: presets[0],
      })),
    ),
  );
  await E(inventory).addAll(
    harden(seeds.map((entry, i) => ({ label: longLabel(i), value: entry }))),
  );
  await E(inventory).add('notes', presets[1]);
  await E(inventory).add('calc', presets[2]);
};

/**
 * Poll an input's value (no `expect` outside `@playwright/test`).
 *
 * @param {any} locator
 * @param {string} value
 */
const valueBecomes = async (locator, value) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if ((await locator.inputValue()) === value) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
};

(enabled ? test.serial : test.skip)(
  '[browser] M5 acceptance 15: preset editor and mentions',
  async t => {
    t.timeout(4 * 60_000);
    // W3.8's harness; it exists once M3 is merged.
    const harnessPath = './_harness.mjs';
    const { startBrowserGateway } = await import(harnessPath);
    const { page, url, client, close, state, gatewayLog } =
      await startBrowserGateway({
        template: 'm2',
        provision,
      });
    /** @type {string[]} */
    const pageLog = [];
    page.on('console', (/** @type {any} */ m) =>
      pageLog.push(`${m.type()}: ${m.text()}`),
    );
    page.on('pageerror', (/** @type {any} */ e) =>
      pageLog.push(`pageerror: ${e.message}`),
    );
    try {
      const slice = await makeSlice(state);
      const made = await slice.makeBackend(replyScript);
      await E(slice.harness).configure(harden({ backends: [made.backend] }));
      /** @param {string} title */
      const sessionTitled = async title => {
        const session = await E(slice.factory).createSession(
          harden({
            title,
            preset: slice.chatOnly,
            backend: made.backend,
            userInitiated: true,
            at: Date.now(),
          }),
        );
        return { session, key: (await E(session).getInfo()).key };
      };
      const mentionsSession = await sessionTitled('mentions');
      // A second session whose saved draft (no attachments) is resent for
      // real after the reload (XD).
      const resendSession = await sessionTitled('resend');
      const sessionItem = (/** @type {string} */ key) =>
        page.locator(`.floot-session-item[data-key="${key}"]`);
      // `client.powers` is the signed-in Node client's `GatewayPowers`.
      const operator = client.powers.operator;
      const catalog = await E(operator).getPresets();
      const general = (await E(catalog).list())[2];

      const pageB = await page.context().newPage();
      await pageB.goto(url);
      /** @param {any} p */
      const openPresets = async p => {
        await p.locator('button[data-panel="presets"]').click();
        await p
          .locator('.thix-preset-item', { hasText: /general/i })
          .first()
          .click();
      };
      await openPresets(page);
      await openPresets(pageB); // B reads the catalogue revision now

      // A saves; B's save at the old revision is refused.
      await page.locator('textarea[name="instructions"]').fill('From device A');
      await page.locator('button[name="save"]').click();
      await page.locator('.thix-preset-notice').waitFor();
      t.is((await E(general).describe()).instructions, 'From device A');

      await pageB
        .locator('textarea[name="instructions"]')
        .fill('From device B');
      await pageB.locator('button[name="save"]').click();
      await pageB.locator('.thix-preset-error').waitFor();
      t.is(
        await pageB.locator('.thix-preset-error').textContent(),
        texts.presetStale,
      );
      t.is(
        await pageB.locator('textarea[name="instructions"]').inputValue(),
        'From device B',
        'B keeps its edits',
      );
      await pageB.locator('button[name="reload"]').click();
      t.true(
        await valueBecomes(
          pageB.locator('textarea[name="instructions"]'),
          'From device A',
        ),
        'the save on A appears on B',
      );

      // An over-size record: every field at its bound, 32 objects, a
      // backend with a 256-unit model.
      await page.locator('input[name="label"]').fill('€'.repeat(120));
      await page.locator('textarea[name="description"]').fill('€'.repeat(500));
      await page
        .locator('textarea[name="instructions"]')
        .fill('€'.repeat(4096));
      for (let i = 0; i < 32; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await page
          .locator('select[name="addObject"]')
          .selectOption({ label: longLabel(i) });
      }
      // 80 three-byte units per endowment label, with the three-byte model ID in
      // all (computed with the editor's `recordOf` and `presetRecordSize`),
      // over the 22,528 bound; never sent, so the duplicates do not matter.
      for (let i = 0; i < 32; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await page.locator(`input[name="endowment-${i}"]`).fill('€'.repeat(80));
      }
      await page.locator('select[name="backend"]').selectOption({ index: 1 });
      await page.locator('input[name="modelId"]').fill('€'.repeat(256));
      t.is(await page.locator('[name="reasoningEffort"]').count(), 0);
      await page.locator('button[name="save"]').click();
      await page.locator('.thix-preset-error').waitFor();
      t.is(
        await page.locator('.thix-preset-error').textContent(),
        texts.presetTooLarge,
      );
      t.is(
        (await E(general).describe()).instructions,
        'From device A',
        'nothing was sent',
      );
      await page.locator('button[name="discard"]').click();
      await page.locator('button[data-panel="presets"]').click(); // close

      // Mentions: @ lists inventory labels; Send attaches the object.
      await sessionItem(mentionsSession.key).click();
      const input = page.locator('textarea.floot-input');
      await input.fill('look at @no');
      await page.locator('.thix-mention-option[data-label="notes"]').waitFor();
      await page
        .locator('.thix-mention-option[data-label="notes"]')
        .dispatchEvent('mousedown');
      t.is(await input.inputValue(), 'look at @notes ');
      await input.press('Enter');
      await page
        .locator('.thix-attachments .thix-attachment-chip[data-label="notes"]')
        .waitFor();

      // A draft with attachments whose answer was lost, then a reload: the
      // resend shows attachmentsLost and the draft is kept.
      const key = mentionsSession.key;
      // M2's A.4 form (guest/lib/pending-queue.js REQUEST_ID), as the page
      // makes it: a 32-hex id is refused by a real session.
      const requestId = `${Date.now()}-00000000-0000-4000-8000-000000000001`;
      const resendId = `${Date.now()}-00000000-0000-4000-8000-000000000002`;
      const resendText = 'resent after the reload';
      await page.evaluate(
        ([sessionKey, id, otherKey, otherId, otherText]) => {
          globalThis.localStorage.setItem(
            `familiar.draft:${sessionKey}`,
            JSON.stringify({ sessionKey, text: 'again @notes', requestId: id }),
          );
          globalThis.localStorage.setItem(
            `familiar.mentions:${id}`,
            JSON.stringify(['notes']),
          );
          globalThis.localStorage.setItem(
            `familiar.draft:${otherKey}`,
            JSON.stringify({
              sessionKey: otherKey,
              text: otherText,
              requestId: otherId,
            }),
          );
        },
        [key, requestId, resendSession.key, resendId, resendText],
      );
      await page.reload();
      // The plain draft is resent for real with its A.4 id: the session
      // has a receipt for it, the turn ran once and the draft is gone.
      await waitFor(
        async () =>
          Boolean(
            await E(resendSession.session).getSubmissionReceipt(resendId),
          ),
        30_000,
        'the resent draft has a receipt',
        100,
      );
      await waitFor(
        async () =>
          turnWithInput(
            await E(resendSession.session).getHistoryPage(),
            resendText,
          )?.state === 'completed',
        30_000,
        'the resent turn completed',
        100,
      );
      const resentTurns = (
        await E(resendSession.session).getHistoryPage()
      ).turns.filter(
        (/** @type {any} */ turn) =>
          turn.records.find((/** @type {any} */ r) => r.kind === 'turn-started')
            ?.input === resendText,
      );
      t.is(resentTurns.length, 1, 'the resent draft ran once');
      t.is(
        await page.evaluate(
          sessionKey =>
            globalThis.localStorage.getItem(`familiar.draft:${sessionKey}`),
          resendSession.key,
        ),
        null,
        'the resent draft is cleared',
      );
      await sessionItem(key).click();
      await page.locator('.thix-send-error').waitFor();
      t.true(
        (await page.locator('.thix-send-error').textContent()).includes(
          texts.attachmentsLost,
        ),
      );
      t.truthy(
        await page.evaluate(
          sessionKey =>
            globalThis.localStorage.getItem(`familiar.draft:${sessionKey}`),
          key,
        ),
        'the draft is kept',
      );
      // Rule 4a (m3-interfaces.md 4.4): every M5 method the page called is
      // admitted by the gateway (XD).
      t.deepEqual(gatewayLog.refused('method'), []);
    } catch (error) {
      t.log(pageLog.slice(-40).join('\n'));
      t.log(
        await page
          .locator('.floot-main, main, body')
          .first()
          .innerText()
          .catch(() => ''),
      );
      throw error;
    } finally {
      await close();
    }
  },
);

(enabled ? test.serial : test.skip)(
  '[browser] selected-session inventory follows live adoptions, switches, and collapse',
  async t => {
    t.timeout(4 * 60_000);
    const { startBrowserGateway } = await import('./_harness.mjs');
    const { page, state, close } = await startBrowserGateway({
      template: 'm2',
    });
    t.teardown(close);
    const slice = await makeSlice(state);
    const samples = [
      { label: 'alpha-first', number: 1 },
      { label: 'beta-only', number: 1 },
      { label: 'alpha-later', number: 2 },
      { label: 'beta-hidden', number: 2 },
    ];
    const { backend } = await slice.makeBackend(
      harden({
        turns: samples.map(({ label, number }) => ({
          input: label,
          rounds: [
            {
              chunks: [{ text: 'Saving.' }],
              toolCalls: [
                {
                  name: 'adopt',
                  args: JSON.stringify({
                    messageNumber: number,
                    edgeName: 'item',
                    petName: label,
                  }),
                },
              ],
            },
            { chunks: [{ text: 'Saved.' }] },
          ],
        })),
      }),
    );
    const alpha = await slice.createSession(backend, 'Inventory Alpha');
    const beta = await slice.createSession(backend, 'Inventory Beta');
    const adopt = async (
      /** @type {any} */ session,
      /** @type {string} */ label,
    ) => {
      const attachment = await slice.makeBackend(harden({ turns: [] }), {
        label,
      });
      const { turn } = await E(slice.composer).submit(
        session,
        label,
        newRequestId(),
        harden({
          attachments: [{ label: 'item', value: attachment.backend }],
        }),
      );
      t.is((await E(turn).whenFinished()).state, 'completed');
      const result = (await turnRecords(turn)).find(
        record => record.kind === 'tool-result',
      );
      t.like(result, { name: 'adopt', failed: false });
    };
    const toggle = page.getByRole('button', {
      name: 'Agent inventory',
      exact: true,
    });
    const panel = page.locator('.thix-session-inventory');
    const visibleLabels = async () =>
      panel
        .locator('[data-label]:visible')
        .evaluateAll((/** @type {Element[]} */ rows) =>
          rows.map(row => row.getAttribute('data-label')),
        );
    const select = async (/** @type {string} */ title) => {
      await page.locator('.floot-session-item', { hasText: title }).click();
      await toggle.waitFor();
      if ((await toggle.getAttribute('aria-expanded')) === 'false')
        await toggle.click();
    };
    const expectLabels = async (/** @type {string[]} */ wanted) => {
      await waitFor(
        async () => {
          const shown = await visibleLabels();
          return samples.every(
            ({ label }) => shown.includes(label) === wanted.includes(label),
          );
        },
        15_000,
        `inventory contains exactly the selected session's sample labels: ${wanted.join(', ')}`,
      );
    };
    await select('Inventory Alpha');
    await adopt(alpha, 'alpha-first');
    await expectLabels(['alpha-first']);
    await select('Inventory Beta');
    await expectLabels([]);
    await adopt(beta, 'beta-only');
    await expectLabels(['beta-only']);
    await adopt(alpha, 'alpha-later');
    await expectLabels(['beta-only']);
    await toggle.click();
    t.is(await toggle.getAttribute('aria-expanded'), 'false');
    await adopt(beta, 'beta-hidden');
    t.deepEqual(await visibleLabels(), []);
    await toggle.click();
    await expectLabels(['beta-only', 'beta-hidden']);
    const chatWidth = () =>
      page
        .locator('.thix-conversation')
        .evaluate(el => el.getBoundingClientRect().width);
    const box = async (/** @type {string} */ selector) => {
      return page.locator(selector).evaluate(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      });
    };
    // All coordinates in this check describe the settled layout. The drawer
    // also supports reduced motion, so request it before comparing widths.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await panel.evaluate(async el => {
      await Promise.all(
        el
          .getAnimations({ subtree: true })
          .map(anim => anim.finished.catch(() => {})),
      );
    });
    const sessions = await box('.floot-sidebar');
    const drawer = await box('.thix-session-inventory');
    const chat = await box('.thix-conversation');
    const sessionHeader = await box('.floot-main > .floot-header');
    const controls = await box('.thix-session-content .floot-compose');
    t.is(await panel.locator('..').getAttribute('class'), 'thix-session-body');
    t.is(drawer.y, sessionHeader.y + sessionHeader.height);
    t.is(chat.y, drawer.y);
    t.is(sessionHeader.x, drawer.x);
    t.is(chat.x + chat.width, sessionHeader.x + sessionHeader.width);
    t.true(drawer.width > 150);
    t.true(controls.x >= chat.x);
    t.is(drawer.x, sessions.x + sessions.width);
    t.is(chat.x, drawer.x + drawer.width);
    await toggle.click();
    await waitFor(
      async () => (await chatWidth()) >= chat.width + drawer.width - 1,
      3000,
      'inventory releases chat width',
    );
    t.deepEqual(await box('.floot-sidebar'), sessions);
    t.deepEqual(await box('.floot-main > .floot-header'), sessionHeader);
    t.true(
      (await box('.floot-compose')).width >= controls.width + drawer.width - 1,
    );
    await toggle.click();
    await expectLabels(['beta-only', 'beta-hidden']);
    await waitFor(
      async () => (await chatWidth()) === chat.width,
      3000,
      'expanded inventory takes its original width',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(
      async () => (await page.locator('.thix-app.narrow').count()) === 1,
      3000,
      'mobile layout',
    );
    await expectLabels(['beta-only', 'beta-hidden']);
    const mobile = await box('.thix-conversation');
    const header = await box('.floot-header');
    const sheet = await box('.thix-session-inventory');
    t.true(sheet.y >= header.y + header.height - 1);
    t.true(sheet.width < mobile.width);
    await toggle.click();
    t.is(await chatWidth(), mobile.width);
    await page.setViewportSize({ width: 1280, height: 800 });
    await select('Inventory Alpha');
    await expectLabels(['alpha-first', 'alpha-later']);
  },
);
