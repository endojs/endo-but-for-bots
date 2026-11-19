// @ts-check
/* eslint-disable import/no-relative-packages */
// The Settings "Sandbox execution" section in headless Chromium against a
// real daemon (spec R6-50, R6-57; m6-interfaces.md acceptance 19), through
// M3's `startBrowserGateway`. Gated by THIX_HARNESS_BROWSER=1:
//
// - a `chat-only` session (no environment): Settings shows no Sandbox
//   execution section (the `m2` template, no environments resource);
// - a `development` session on the `environments` template: Settings shows
//   "Sandbox execution" running; Emergency stop -> stopped, and the
//   composer's send is refused with the session's text (the draft stays,
//   nothing is queued); Resume -> running, the queue still held `stopped`;
// - rule 4a: no call of the page was refused `unknown method`.
//
// The second case needs the environments template
// (`test/integration/_environments.js` `environmentsTemplate`), which the
// lane's integration unit builds.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { E } from '@endo/far';

import { texts } from '../../guest/lib/interfaces.js';
import { makeSlice, waitFor } from '../integration/_m1a-slice.js';
import { executionTexts } from '../../ui/src/environment/texts.js';

/** A scripted backend that answers every turn with a short reply. */
const replyScript = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'ok' }] }] }],
});

const enabled = process.env.THIX_HARNESS_BROWSER === '1';

/**
 * A built-in preset by its label (test set-up only).
 *
 * @param {any} factory
 * @param {string} label
 */
const presetLabelled = async (factory, label) => {
  const presets = await E(factory).listPresets();
  for (const preset of presets) {
    // eslint-disable-next-line no-await-in-loop
    const info = await E(preset).describe();
    if (info.label === label) return preset;
  }
  throw Error(`no preset ${label}`);
};

/**
 * Start the gateway on `template`, make one session of `presetLabel` on a
 * scripted backend and open its Settings in the page.
 *
 * @param {any} template
 * @param {string} presetLabel
 */
const openSettings = async (template, presetLabel) => {
  // M3's harness, imported as the M5 browser file does.
  const harnessPath = './_harness.mjs';
  const { startBrowserGateway } = await import(harnessPath);
  const gateway = await startBrowserGateway({ template });
  const { page, state } = gateway;
  try {
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(replyScript);
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    const session = await E(slice.factory).createSession(
      harden({
        title: presetLabel,
        preset: await presetLabelled(slice.factory, presetLabel),
        backend: made.backend,
        userInitiated: true,
        at: Date.now(),
      }),
    );
    const { key } = await E(session).getInfo();
    await page.locator(`.floot-session-item[data-key="${key}"]`).click();
    await page.locator('textarea.floot-input').waitFor();
    await page.locator('button[aria-label="Settings"]').click();
    await page.locator('.thix-settings').waitFor();
    return { ...gateway, session };
  } catch (error) {
    await gateway.close();
    throw error;
  }
};

/**
 * @param {any} page
 * @param {string} text
 */
const statusBecomes = (page, text) =>
  waitFor(
    async () =>
      (await page
        .locator('.floot-execution [role="status"]')
        .textContent()
        .catch(() => undefined)) === text,
    10_000,
    `the execution status "${text}"`,
  );

(enabled ? test.serial : test.skip)(
  '[browser] a session without an environment shows no Sandbox execution section',
  async t => {
    t.timeout(3 * 60_000);
    const { page, close, session, gatewayLog } = await openSettings(
      'm2',
      'chat-only',
    );
    try {
      t.deepEqual(await E(session).getExecutionState(), {
        state: 'running',
        supported: false,
      });
      // The section waits for its first read; give it time to (not) appear.
      await page.waitForTimeout(1000);
      t.is(await page.locator('.floot-execution').count(), 0);
      t.deepEqual(gatewayLog.refused('method'), []);
    } finally {
      await close();
    }
  },
);

(enabled ? test.serial : test.skip)(
  '[browser] acceptance 19: Sandbox execution, Emergency stop, refused send, Resume with the queue held',
  async t => {
    t.timeout(4 * 60_000);
    // The lane's integration helper (m6-interfaces.md 3.11).
    const helperPath = '../integration/_environments.js';
    const { environmentsTemplate } = await import(helperPath);
    const { page, close, session, gatewayLog } = await openSettings(
      await environmentsTemplate(),
      'development',
    );
    try {
      await page.locator('.floot-execution').waitFor();
      t.is(
        await page.locator('.floot-execution h3').textContent(),
        executionTexts.heading,
      );
      await statusBecomes(page, executionTexts.running);

      await page
        .locator('.floot-execution [data-action="emergency-stop"]')
        .click();
      await statusBecomes(page, executionTexts.stopped);
      t.like(await E(session).getExecutionState(), { state: 'stopped' });

      // The composer is blocked with the session's text; the draft stays.
      const input = page.locator('textarea.floot-input');
      await input.fill('while stopped');
      await page.locator('button.thix-send').click();
      await page.locator('.thix-send-error').waitFor();
      t.is(
        await page.locator('.thix-send-error').textContent(),
        texts.sessionStopped,
      );
      t.is(await input.inputValue(), 'while stopped');
      const held = await E(session).listPending();
      t.is(held.entries.length, 0, 'nothing was queued');
      t.is(held.hold?.reason, 'stopped');

      await page.locator('.floot-execution [data-action="resume"]').click();
      await statusBecomes(page, executionTexts.running);
      const after = await E(session).listPending();
      t.is(after.hold?.reason, 'stopped', 'resume leaves the queue held');
      await page
        .locator('.floot-execution', { hasText: executionTexts.queueHeld })
        .waitFor();
      t.deepEqual(gatewayLog.refused('method'), []);
    } finally {
      await close();
    }
  },
);
