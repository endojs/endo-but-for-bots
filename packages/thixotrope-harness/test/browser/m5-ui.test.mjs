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
//   keeps the draft.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { E } from '@endo/far';

import { texts as factoryTexts } from '../../guest/lib/interfaces-m5-factory.js';
import { texts as m5Texts } from '../../guest/lib/interfaces-m5.js';

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
 * `notes` and `calc`, and one session.
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
  const factory = await E(operator).getFactory();
  await E(factory).createSession(
    harden({ title: 'mentions', userInitiated: true, at: Date.now() }),
  );
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
    const { page, url, client, close } = await startBrowserGateway({
      template: 'm2',
      provision,
    });
    try {
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
        factoryTexts.presetStale,
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
      // 80 three-byte units per endowment label: 22,605 string bytes in
      // all (computed with the editor's `recordOf` and `presetRecordSize`),
      // over the 22,528 bound; never sent, so the duplicates do not matter.
      for (let i = 0; i < 32; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await page.locator(`input[name="endowment-${i}"]`).fill('€'.repeat(80));
      }
      await page.locator('select[name="backend"]').selectOption({ index: 1 });
      await page.locator('input[name="modelId"]').fill('m'.repeat(256));
      await page.locator('input[name="reasoningEffort"]').fill('€'.repeat(32));
      await page.locator('button[name="save"]').click();
      await page.locator('.thix-preset-error').waitFor();
      t.is(
        await page.locator('.thix-preset-error').textContent(),
        factoryTexts.presetTooLarge,
      );
      t.is(
        (await E(general).describe()).instructions,
        'From device A',
        'nothing was sent',
      );
      await page.locator('button[name="discard"]').click();
      await page.locator('button[data-panel="presets"]').click(); // close

      // Mentions: @ lists inventory labels; Send attaches the object.
      await page.locator('.floot-session-item').first().click();
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
      const factory = await E(operator).getFactory();
      const sessions = await E(factory).listSessions({});
      const key = sessions.rows[0].key;
      // M2's A.4 form (guest/lib/pending-queue.js REQUEST_ID), as the page
      // makes it: a 32-hex id is refused by a real session.
      const requestId = `${Date.now()}-00000000-0000-4000-8000-000000000001`;
      await page.evaluate(
        ([sessionKey, id]) => {
          globalThis.localStorage.setItem(
            `familiar.draft:${sessionKey}`,
            JSON.stringify({ sessionKey, text: 'again @notes', requestId: id }),
          );
          globalThis.localStorage.setItem(
            `familiar.mentions:${id}`,
            JSON.stringify(['notes']),
          );
        },
        [key, requestId],
      );
      await page.reload();
      await page.locator('.floot-session-item').first().click();
      await page.locator('.thix-send-error').waitFor();
      t.true(
        (await page.locator('.thix-send-error').textContent()).includes(
          m5Texts.attachmentsLost,
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
    } finally {
      await close();
    }
  },
);
