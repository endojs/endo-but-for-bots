/**
 * Formula Inspector E2E Tests
 *
 * These tests verify the Value modal's back-face Formula view, the F
 * flip key, the modal-header gear icon, the Backspace pop, the Escape
 * consistency, and the retention-paths table. They require Playwright
 * because the card-flip transform, the bounded-height scroll region, and
 * the focus-management behavior depend on the real CSS engine.
 *
 * Note: the inventory-row gear icon was removed — it was redundant with
 * the modal-header gear and made the row too busy. The only entry
 * points to the Formula back face are now the modal-header gear button
 * (`#value-flip-to-formula`) and the `F` accelerator.
 *
 * The suite runs against the daemon-free harness page
 * `test/e2e/harness/formula-inspector.html`, which mounts the real
 * `valueComponent` under the app's lockdown and stylesheet against a
 * synthetic EndoHost. `window.__testHarness.setFixture` supplies the
 * inventory rows, the formula records, and the `listRetentionPaths`
 * snapshots. Run with `yarn test:e2e:harness`.
 *
 * See designs/formula-inspector.md "Test Plan".
 */
// @ts-nocheck - E2E test with browser globals

import { test, expect, type Page } from '@playwright/test';

// A well-formed formula id (`<64hex>:<64hex>`) on the local node, so the
// back face can derive an `endo://` locator for `listRetentionPaths`.
const formulaId = (digit: string) => `${digit.repeat(64)}:${'0'.repeat(64)}`;

const EVAL_ID = formulaId('e');
const WORKER_ID = formulaId('d');
const KEY_ID = formulaId('c');
const HUB_ID = formulaId('b');
const LOOSE_ID = formulaId('a');
const PINS_ID = formulaId('9');
const ENDO_ID = formulaId('8');

const evalFormula = (number: string, source: string) => ({
  type: 'eval',
  number,
  properties: {
    source: { kind: 'literal', value: source },
    worker: { kind: 'reference', identifier: WORKER_ID },
    endowments: { kind: 'reference-list', entries: {} },
  },
});

const FIXTURE = {
  names: [
    { name: 'my-eval', type: 'eval', id: EVAL_ID },
    { name: 'my-worker', type: 'worker', id: WORKER_ID },
    { name: 'my-key', type: 'keypair', id: KEY_ID },
    { name: 'my-hub', type: 'eval', id: HUB_ID },
    { name: 'my-loose', type: 'eval', id: LOOSE_ID },
  ],
  formulas: {
    [EVAL_ID]: evalFormula(EVAL_ID, '1 + 1'),
    [WORKER_ID]: { type: 'worker', number: WORKER_ID, properties: {} },
    [KEY_ID]: {
      type: 'keypair',
      number: KEY_ID,
      properties: {
        publicKey: { kind: 'literal', value: '0xPUBLIC' },
        privateKey: { kind: 'literal', value: '0xSECRET' },
      },
    },
    [HUB_ID]: evalFormula(HUB_ID, 'harden({})'),
    [LOOSE_ID]: evalFormula(LOOSE_ID, '2 + 2'),
  },
  // The snapshot the synthetic EndoHost's #284 `listRetentionPaths`
  // resolves to, keyed by inspected formula id. Segments are ordered
  // leaf-to-root exactly as the daemon returns them (see the shape in
  // packages/chat/test/component/value-component-flip.test.js). `my-eval`
  // is retained by one path (endo root → "pins" pet store → my-eval);
  // `my-loose` is deliberately unretained (empty snapshot) so the back
  // face renders the empty state.
  retentionPaths: {
    [EVAL_ID]: [
      [
        {
          groupMembers: [EVAL_ID],
          formulaTypes: ['eval'],
          referencedBy: PINS_ID,
          labels: ['pet:my-eval'],
        },
        {
          groupMembers: [PINS_ID],
          formulaTypes: ['pet-store'],
          referencedBy: ENDO_ID,
          labels: ['pins'],
        },
        {
          groupMembers: [ENDO_ID],
          type: 'root',
          formulaTypes: ['endo'],
        },
      ],
    ],
    [LOOSE_ID]: [],
    // A value retained by many paths, so the bounded-height list must
    // scroll. Each path is a distinct single-hop retainer rooted at
    // `endo`, generated so the fixture stays legible.
    [HUB_ID]: Array.from({ length: 12 }, (_unused, i) => {
      const holderId = formulaId(i.toString(16));
      return [
        {
          groupMembers: [HUB_ID],
          formulaTypes: ['eval'],
          referencedBy: holderId,
          labels: [`pet:holder-${i}`],
        },
        {
          groupMembers: [holderId],
          type: 'root',
          formulaTypes: ['endo'],
        },
      ];
    }),
  },
};

const setupHarness = async (page: Page) => {
  await page.goto('/test/e2e/harness/formula-inspector.html');
  // eslint-disable-next-line no-underscore-dangle
  await page.waitForFunction(() => window.__testHarnessReady === true);
  await page.evaluate(fixture => {
    // eslint-disable-next-line no-underscore-dangle
    window.__testHarness.setFixture(fixture);
  }, FIXTURE);
};

/**
 * Open the Value modal on the front face for a fixture pet name, through
 * the row's inspect button (as the inventory does).
 *
 * @param page
 * @param name
 */
const openValue = async (page: Page, name: string) => {
  await page.locator(`.pet-item-row[data-name="${name}"] .info-button`).click();
  await expect(page.locator('#value-frame')).toBeVisible();
  await expect(page.locator('.value-name-input')).toBeFocused();
  // Opening a named value focuses the rename input, which keeps typed keys
  // (F included) out of the modal's accelerators. Move focus to the modal
  // chrome, as a keyboard user would, before driving accelerators.
  await page.locator('#value-title').click();
};

test.describe('Formula Inspector (Value modal back face)', () => {
  test('F flips the modal from front face to Formula back face', async ({
    page,
  }) => {
    await setupHarness(page);
    // Click an inventory row to open the modal on the front face.
    await openValue(page, 'my-eval');
    await expect(page.locator('#value-window')).toBeVisible();
    await expect(page.locator('#value-window')).not.toHaveClass(/flipped/);

    // Press F.
    await page.keyboard.press('f');
    await expect(page.locator('#value-window')).toHaveClass(/flipped/);
    // The back face names the type once via its human-facing title; the
    // redundant raw-type chip has been removed.
    await expect(page.locator('#formula-view-title')).toHaveText('Evaluation');
  });

  test('modal-header gear button flips to the Formula back face', async ({
    page,
  }) => {
    await setupHarness(page);
    // Open the modal on the front face, then click the header gear.
    await openValue(page, 'my-eval');
    await expect(page.locator('#value-window')).not.toHaveClass(/flipped/);
    await page.locator('#value-flip-to-formula').click();
    await expect(page.locator('#value-window')).toHaveClass(/flipped/);
  });

  test('clicking a reference button opens that value and Backspace returns', async ({
    page,
  }) => {
    await setupHarness(page);
    await openValue(page, 'my-eval');
    await page.keyboard.press('f');
    // Click the worker reference button (labels are humanized: "Worker").
    await page.locator('.formula-view-reference >> text=Worker').click();
    // The modal lands on the front face for the worker.
    await expect(page.locator('#value-window')).not.toHaveClass(/flipped/);

    // Backspace on the back face (flip back first) returns to eval.
    await page.keyboard.press('f');
    await page.keyboard.press('Backspace');
    await expect(page.locator('#value-window')).not.toHaveClass(/flipped/);
  });

  test('Escape on back face flips to front face; Escape on front face closes', async ({
    page,
  }) => {
    await setupHarness(page);
    await openValue(page, 'my-eval');
    await page.keyboard.press('f');
    await expect(page.locator('#value-window')).toHaveClass(/flipped/);

    // Escape on back face: flip-to-front, not close.
    await page.keyboard.press('Escape');
    await expect(page.locator('#value-window')).not.toHaveClass(/flipped/);
    await expect(page.locator('#value-frame')).toBeVisible();

    // Escape on front face: closes.
    await page.keyboard.press('Escape');
    await expect(page.locator('#value-frame')).not.toBeVisible();
  });

  test('keypair back face shows public key but suppresses private key', async ({
    page,
  }) => {
    await setupHarness(page);
    await openValue(page, 'my-key');
    await page.locator('#value-flip-to-formula').click();
    const back = page.locator('#value-back-face');
    await expect(back).toContainText('0xPUBLIC');
    await expect(back).not.toContainText('0xSECRET');
    await expect(back).toContainText('Private key not displayed');
  });

  test('reduced-motion preference disables the card-flip rotation', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await setupHarness(page);
    await openValue(page, 'my-eval');
    // Sample the computed transition-property; under reduced motion
    // the card-flip transform transition is disabled.
    const trans = await page
      .locator('#value-window')
      .evaluate(el => getComputedStyle(el).transitionDuration);
    // The reduced-motion rule overrides the 200ms duration.
    expect(trans === '0s' || trans === '0ms' || trans === '').toBe(true);
    await context.close();
  });

  /**
   * Retention-paths table on the Formula back face (#439/#599).
   *
   * The read-only "Retention paths" table renders the #284
   * `EndoHost.listRetentionPaths` snapshot for the inspected value: each
   * row a path from a garbage-collection root, through the reference
   * graph, to this value. Unlike the happy-dom component tests
   * (`test/component/retention-paths-view.test.js` and
   * `value-component-flip.test.js`), these cases exercise the table in a
   * real browser — the flip transform, the bounded-height scroll region,
   * and the confined renderer under a live CSS engine. Like the sibling
   * back-face cases they run on the harness page, whose `setFixture`
   * carries the `retentionPaths` snapshots.
   */
  test.describe('Retention paths table', () => {
    test('flipping to the back face renders the retention-paths table', async ({
      page,
    }) => {
      await setupHarness(page);
      await openValue(page, 'my-eval');
      await page.keyboard.press('f');
      await expect(page.locator('#value-window')).toHaveClass(/flipped/);

      // The table heading and count badge reflect the one retaining path.
      const table = page.locator('.retention-paths');
      await expect(table).toBeVisible();
      await expect(table.locator('.retention-paths-title')).toHaveText(
        'Retention paths',
      );
      await expect(table.locator('.retention-paths-count')).toHaveText('1');
      await expect(table.locator('.retention-path')).toHaveCount(1);

      // The back face asked the host for the snapshot by the inspected
      // value's `endo://` locator, not its bare formula id.
      const locators = await page.evaluate(() =>
        // eslint-disable-next-line no-underscore-dangle
        window.__testHarness.calls
          .filter(c => c.method === 'listRetentionPaths')
          .map(c => c.args[0]),
      );
      expect(locators).toEqual([
        `endo://${'0'.repeat(64)}/${'e'.repeat(64)}?type=eval`,
      ]);
    });

    test('the table shows the pet-store edge and marks the target segment', async ({
      page,
    }) => {
      await setupHarness(page);
      await openValue(page, 'my-eval');
      await page.keyboard.press('f');

      // The pet-store edge renders the quoted pet name; the leaf (the
      // inspected value) is highlighted as the target segment.
      await expect(page.locator('.retention-path-edge-pet')).toHaveText(
        '"my-eval"',
      );
      await expect(
        page.locator('.retention-path-segment-target'),
      ).toContainText(EVAL_ID);
    });

    test('an unretained value shows the empty state', async ({ page }) => {
      await setupHarness(page);
      // my-loose has an empty retention snapshot (unretained).
      await openValue(page, 'my-loose');
      await page.keyboard.press('f');
      await expect(page.locator('#value-window')).toHaveClass(/flipped/);

      const table = page.locator('.retention-paths');
      await expect(table.locator('.retention-path')).toHaveCount(0);
      await expect(
        table.locator('.formula-view-empty.retention-paths-message'),
      ).toContainText('unretained');
      // No count badge when there are no paths.
      await expect(table.locator('.retention-paths-count')).toHaveCount(0);
    });

    test('a value retained by many paths scrolls within a bounded height', async ({
      page,
    }) => {
      // A browser-only assertion: the list caps its height and scrolls
      // (real CSS layout), which happy-dom cannot measure. `my-hub` is
      // retained by more paths than fit the bounded height.
      await setupHarness(page);
      await openValue(page, 'my-hub');
      await page.keyboard.press('f');
      await expect(page.locator('.retention-paths-count')).toHaveText('12');

      const list = page.locator('.retention-paths-list');
      const overflows = await list.evaluate(
        el => el.scrollHeight > el.clientHeight,
      );
      expect(overflows).toBe(true);
    });
  });
});
