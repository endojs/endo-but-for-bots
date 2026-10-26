// Reproducible browser check for live source replacement under real confinement.
// Run: yarn test:whylip-live (requires installed Playwright Chromium).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  root: fileURLToPath(new URL('.', import.meta.url)),
  configFile: false,
  logLevel: 'warn',
  server: {
    port: 5198,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] },
  },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('http://localhost:5198');
  await page.waitForFunction(() => globalThis.__ready === true);
  // Host canvas must really exist; an overlay-only render is not a 3D pass.
  await page
    .locator('.whylip-three-surface canvas')
    .waitFor({ state: 'visible' });
  assert.equal(await page.locator('.whylip-three-fallback:visible').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__whylip.getError()), null);

  await page.getByRole('button', { name: 'Light the lantern' }).click();
  await page.getByRole('button', { name: 'Wake the fireflies' }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'Dim the lantern' })
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Let the fireflies rest' })
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.deepEqual(await page.evaluate(() => globalThis.__whylip.actions), []);

  await page.evaluate(() =>
    globalThis.__whylip.patchState({
      narration: 'The lantern flickers in reply.',
    }),
  );
  assert.equal(
    await page.getByText('The lantern flickers in reply.').count(),
    1,
  );
  await page.evaluate(() => globalThis.__whylip.patchState({ narration: '' }));
  const choice = page.getByRole('button', { name: /Follow the river/ });
  await choice.focus();
  const update = await page.evaluate(async () => {
    const focused = document.activeElement;
    const canvas = document.querySelector('.whylip-three-surface canvas');
    const start = performance.now();
    globalThis.__whylip.edit();
    await new Promise(resolve =>
      requestAnimationFrame(() => resolve(undefined)),
    );
    return {
      elapsedMs: performance.now() - start,
      focusPreserved: focused === document.activeElement,
      canvasPreserved:
        canvas === document.querySelector('.whylip-three-surface canvas'),
      visible: document.body.textContent.includes(
        'On this newly written page,',
      ),
    };
  });
  assert.equal(update.visible, true);
  assert.equal(update.focusPreserved, true);
  assert.equal(update.canvasPreserved, true);
  assert.equal(
    await page
      .getByRole('button', { name: 'Dim the lantern' })
      .getAttribute('aria-pressed'),
    'true',
  );

  await page.evaluate(() => globalThis.__whylip.breakSource());
  await page.waitForFunction(() => Boolean(globalThis.__whylip.getError()));
  assert.equal(await page.getByText(/On this newly written page,/).count(), 1);
  await page.getByRole('button', { name: 'Dim the lantern' }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'Light the lantern' })
      .getAttribute('aria-pressed'),
    'false',
  );
  await page.getByRole('button', { name: 'Light the lantern' }).click();
  await page.evaluate(() => globalThis.__whylip.restore());
  await page.waitForFunction(() => globalThis.__whylip.getError() === null);

  await choice.click();
  assert.deepEqual(await page.evaluate(() => globalThis.__whylip.actions), [
    {
      name: 'choose-path',
      detail: { path: 'river', lanternLit: true, firefliesAwake: true },
    },
  ]);
  await page.evaluate(() => globalThis.__whylip.patchState({ showBell: true }));
  await page
    .getByRole('button', { name: 'Ring the bell', exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => globalThis.__whylip.getState().bellRings),
    1,
  );
  assert.deepEqual(
    await page.evaluate(() => globalThis.__whylip.actions.at(-1)),
    { name: 'ring-bell', detail: { rings: 1 } },
  );
  assert.equal(await page.getByText('The bell sings.').count(), 1);
  assert.equal(await page.locator('.whylip-three-surface canvas').count(), 1);
  // Exercise the actual browser lifecycle, not synthetic context events.
  const recoveryCanvas = await page
    .locator('.whylip-three-surface canvas')
    .elementHandle();
  assert.ok(recoveryCanvas);
  const beforeRecovery = await page.evaluate(() => ({
    state: globalThis.__whylip.getState(),
    actions: [...globalThis.__whylip.actions],
  }));
  await recoveryCanvas.evaluate(async canvas => {
    const gl = canvas.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!gl || !extension)
      throw Error('Chromium must support WEBGL_lose_context');
    globalThis.__whylipContextRecovery = { canvas, gl, extension };
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error('WebGL loss event timed out')),
        5000,
      );
      canvas.addEventListener(
        'webglcontextlost',
        () => {
          clearTimeout(timeout);
          resolve(undefined);
        },
        { once: true },
      );
      extension.loseContext();
    });
  });
  await page
    .locator('.whylip-three-fallback')
    .waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(
    await page.evaluate(() =>
      globalThis.__whylipContextRecovery.gl.isContextLost(),
    ),
    true,
  );
  // Context loss itself must neither erase progress nor invent a reader action.
  assert.deepEqual(
    await page.evaluate(() => ({
      state: globalThis.__whylip.getState(),
      actions: [...globalThis.__whylip.actions],
    })),
    beforeRecovery,
  );
  // Accessible local controls still work during loss, but cannot dismiss the
  // recovery notice or reenable picking before the browser restores WebGL.
  await page.getByRole('button', { name: 'Dim the lantern' }).click();
  assert.equal(
    await page.evaluate(() => globalThis.__whylip.getState().lanternLit),
    false,
  );
  assert.equal(await page.locator('.whylip-three-fallback').isVisible(), true);
  await page.getByRole('button', { name: 'Light the lantern' }).click();
  assert.equal(await page.locator('.whylip-three-fallback').isVisible(), true);
  assert.deepEqual(
    await page.evaluate(() => globalThis.__whylip.actions),
    beforeRecovery.actions,
  );
  await page.evaluate(async () => {
    const { canvas, extension } = globalThis.__whylipContextRecovery;
    await new Promise(resolve =>
      requestAnimationFrame(() => resolve(undefined)),
    );
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error('WebGL restoration event timed out')),
        5000,
      );
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          clearTimeout(timeout);
          resolve(undefined);
        },
        { once: true },
      );
      extension.restoreContext();
    });
  });
  await page
    .locator('.whylip-three-fallback')
    .waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(
    await recoveryCanvas.evaluate(
      canvas =>
        canvas === document.querySelector('.whylip-three-surface canvas'),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      globalThis.__whylipContextRecovery.gl.isContextLost(),
    ),
    false,
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      state: globalThis.__whylip.getState(),
      actions: [...globalThis.__whylip.actions],
    })),
    beforeRecovery,
  );
  assert.equal(await page.evaluate(() => globalThis.__whylip.getError()), null);
  await page.evaluate(() => {
    delete globalThis.__whylipContextRecovery;
  });
  await recoveryCanvas.dispose();
  await page.screenshot({ path: '/tmp/whylip-confined-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: '/tmp/whylip-confined-mobile.png' });
  assert.deepEqual(browserErrors, []);
  console.log(
    `Whylip confined live scene passed. Renderer update visible by next frame: ${update.elapsedMs.toFixed(2)} ms (excludes agent and filesystem latency).`,
  );
} finally {
  await browser?.close();
  await server.close();
}
