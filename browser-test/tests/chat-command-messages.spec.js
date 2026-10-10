// @ts-check
/* global getComputedStyle */
const { test, expect } = require('@playwright/test');

// Loads the command-messages fixture built from
// packages/chat/test/browser/ (see the README there), which mounts the
// real inbox component against mock powers holding a fixed transcript:
// an `adopt` command with a successful result, then a `resolve`
// command with a failed result.  The happy-dom tests in packages/chat
// cover DOM structure; this case covers what only a browser computes:
// the cards' stylesheet-driven appearance.

const FIXTURE_URL = 'http://127.0.0.1:3000/chat-fixtures/command-messages.html';

test.beforeEach(async ({ page }) => {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', err => {
    pageErrors.push(err.stack || err.message);
  });
  await page.goto(FIXTURE_URL);
  try {
    await expect(page.locator('body[data-fixture-ready]')).toBeAttached({
      timeout: 30_000,
    });
  } catch (err) {
    const fixtureError = await page
      .locator('body')
      .getAttribute('data-fixture-error')
      .catch(() => null);
    throw new Error(
      [
        /** @type {Error} */ (err).message,
        `fixtureError: ${fixtureError}`,
        `pageErrors (${pageErrors.length}):`,
        ...pageErrors.map(e => `  ${e}`),
      ].join('\n'),
      { cause: err },
    );
  }
  expect(pageErrors, 'no page errors').toEqual([]);
});

test('command cards render in transcript order', async ({ page }) => {
  const cards = page.locator('.message-envelope.command-envelope');
  await expect(cards).toHaveCount(4);
  await expect(cards.locator('.command-text')).toHaveText([
    'adopt 3 gift my-gift',
    'adopted as my-gift',
    'resolve 4 nope',
    'No formula exists for the pet name "nope"',
  ]);
  await expect(cards.locator('.command-icon')).toHaveText(['◐', '✓', '◐', '✗']);
});

test('command results thread to their commands', async ({ page }) => {
  const commandIds = await page.locator('.command-envelope').evaluateAll(els =>
    els.map(el => ({
      messageId: /** @type {HTMLElement} */ (el).dataset.messageId,
      replyTo: /** @type {HTMLElement} */ (el).dataset.replyTo,
    })),
  );
  expect(commandIds[1].replyTo).toBe(commandIds[0].messageId);
  expect(commandIds[3].replyTo).toBe(commandIds[2].messageId);
});

test('command cards are styled as compact, muted telemetry', async ({
  page,
}) => {
  const envelope = page.locator('.command-envelope').first();
  await expect(envelope).toHaveCSS('opacity', '0.8');

  const card = page.locator('.command-message').first();
  await expect(card).toHaveCSS('display', 'inline-flex');
  await expect(card).toHaveCSS('font-family', /monospace/);
});

test('success and failure results are visually distinct', async ({ page }) => {
  const success = page.locator('.command-message.success');
  const failure = page.locator('.command-message.error');
  await expect(success).toHaveCount(1);
  await expect(failure).toHaveCount(1);
  const successColor = await success.evaluate(el => getComputedStyle(el).color);
  const failureColor = await failure.evaluate(el => getComputedStyle(el).color);
  expect(successColor).not.toBe(failureColor);
});
