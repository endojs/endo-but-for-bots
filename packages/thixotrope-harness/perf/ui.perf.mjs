// @ts-check
/* eslint-disable no-await-in-loop -- windows run their operations in order */
/**
 * M3 browser perf rows (designs/m3-interfaces.md 13; W3.8), in headless
 * Chromium through `test/browser/_harness.mjs` (gated: THIX_HARNESS_BROWSER=1
 * and a Chromium; otherwise the file reports `skipped` and exits 0).
 *
 * - `ui.coldLoad`: navigation in a fresh browser context to the session
 *   rows listed, back to back for 60 s; budget median 1.5 s. The bundle's
 *   bytes and gzip bytes (`ui/build.mjs`, not written) against 600 KB gzip.
 * - `ui.hubGrowth`: for 5 minutes one browser views a session and reloads
 *   every 10 s while a turn runs every 5 s; then the viewer closes and the
 *   session vat runs 32 cranks. Hub state (image + log) at the end, budget
 *   2 MB; the session's hub row entries (`ourExports`) against its start,
 *   budget 1.25 x (J-9386, J-9392).
 *
 * Run (exclusive under the run lock):
 *
 *   THIX_HARNESS_BROWSER=1 node scripts/run-lock.mjs --exclusive --label m3-ui -- node perf/ui.perf.mjs
 */
import { emit, hubJsonBytes, runPerf, single, stats } from './_harness.mjs';
import { windowMs } from './_window.mjs';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { performance } = await import('node:perf_hooks');
const { setTimeout: delay } = await import('node:timers/promises');
const { FEW_SAMPLES, WINDOW_MS, makeFileClock } =
  await import('./_m3-client.mjs');
const { browserSkipReason, startBrowserGateway } =
  await import('../test/browser/_harness.mjs');
const { makeSlice, requestId } =
  await import('../test/integration/_m1a-slice.js');
const { hubRow, workerMetas } = await import('./_long-session.mjs');

/** The hub-growth window (m3-interfaces.md 13: 5 minutes). */
const GROWTH_MS = windowMs('M3_GROWTH_MS', 5 * 60_000);
const RELOAD_EVERY_MS = 10_000;
const TURN_EVERY_MS = 5000;
/** Bundle budget, gzip bytes. */
const BUNDLE_GZIP_BUDGET = 600 * 1024;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const uiPerfScript = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'ok ' }, { text: 'done' }], usage }] }],
});

/** @param {string} metric @param {string} why */
const notMeasured = (metric, why) =>
  emit({ metric, notMeasured: why, pass: null });

const skip = await browserSkipReason();
if (skip) {
  emit({ metric: 'ui.skipped', reason: skip, pass: null });
} else {
  await runPerf('ui', async () => {
    const clock = makeFileClock();
    const { buildUi } = await import('../ui/build.mjs');
    const bundle = await buildUi({ write: false });
    await single('ui.bundle', bundle.gzipBytes, {
      budget: { value: BUNDLE_GZIP_BUDGET },
      extra: {
        unit: 'bytes',
        bytes: bundle.bytes,
        gzipBytes: bundle.gzipBytes,
      },
    });
    const harness = await startBrowserGateway({ template: 'm2', lock: false });
    try {
      const slice = await makeSlice(harness.state);
      const made = await slice.makeBackend(uiPerfScript, { label: 'UiPerf' });
      await E(slice.harness).configure(harden({ backends: [made.backend] }));
      const factory = await E(harness.client.powers.operator).getFactory();
      const [preset] = await E(factory).listPresets();
      const [backend] = await E(factory).listBackends();
      const session = await E(factory).createSession(
        harden({ title: 'viewed', preset, backend, at: Date.now() }),
      );
      const { key } = await E(session).getInfo();
      const row = `.floot-session-item[data-key="${key}"]`;
      await harness.page.locator(row).waitFor();
      await harness.page.context().close();

      // ---- ui.coldLoad
      if (clock.fits(WINDOW_MS)) {
        /** @type {number[]} */
        const samples = [];
        const end = performance.now() + WINDOW_MS;
        while (performance.now() < end) {
          const context = await harness.browser.newContext();
          const page = await context.newPage();
          const t = performance.now();
          await page.goto(harness.url);
          await page.locator(row).waitFor({ timeout: 30_000 });
          samples.push(performance.now() - t);
          await context.close();
        }
        await stats('ui.coldLoad', samples, {
          budget: { median: 1500 },
          extra: {
            windowMs: WINDOW_MS,
            ...(samples.length < FEW_SAMPLES ? { fewSamples: true } : {}),
            to: 'the session row listed',
          },
        });
      } else notMeasured('ui.coldLoad', 'file time');

      // ---- ui.hubGrowth
      if (clock.fits(GROWTH_MS + 90_000)) {
        const root = harness.state.root;
        const worker = () =>
          workerMetas(root).find(m => m.debugLabel === `session ${key}`)?.id;
        // One turn first, so the row holds a settled session's handles.
        const first = await E(harness.client.powers.composer).submit(
          session,
          'warm',
          requestId(),
        );
        await E(first.turn).whenFinished();
        const startRow = hubRow(root, /** @type {string} */ (worker()));
        const startHub = await hubJsonBytes(root);
        const context = await harness.browser.newContext();
        const page = await context.newPage();
        await page.goto(harness.url);
        await page.locator(row).click();
        let turns = 0;
        let reloads = 0;
        const t0 = performance.now();
        let nextReload = t0 + RELOAD_EVERY_MS;
        let nextTurn = t0;
        while (performance.now() - t0 < GROWTH_MS) {
          const now = performance.now();
          if (now >= nextTurn) {
            nextTurn += TURN_EVERY_MS;
            const r = await E(harness.client.powers.composer).submit(
              session,
              `turn ${turns}`,
              requestId(),
            );
            void E(r.turn)
              .whenFinished()
              .catch(() => {});
            turns += 1;
          }
          if (now >= nextReload) {
            nextReload += RELOAD_EVERY_MS;
            await page.reload();
            await page.locator(row).click();
            reloads += 1;
          }
          await delay(100);
        }
        const viewedRow = hubRow(root, /** @type {string} */ (worker()));
        await context.close();
        // The session vat runs 32 cranks after the viewer closed.
        for (let i = 0; i < 32; i += 1) await E(session).getInfo();
        await delay(2000);
        const endRow = hubRow(root, /** @type {string} */ (worker()));
        const endHub = await hubJsonBytes(root);
        const ratio =
          startRow && endRow && startRow.ourExports > 0
            ? +(endRow.ourExports / startRow.ourExports).toFixed(3)
            : null;
        const pass =
          endHub !== null &&
          endHub <= 2 * 1024 * 1024 &&
          ratio !== null &&
          ratio <= 1.25;
        emit({
          metric: 'ui.hubGrowth',
          windowMs: GROWTH_MS,
          turns,
          reloads,
          hubBytes: { start: startHub, end: endHub, budget: 2 * 1024 * 1024 },
          sessionRow: { start: startRow, viewed: viewedRow, end: endRow },
          entriesRatio: ratio,
          budget: { hubBytes: 2 * 1024 * 1024, entriesRatio: 1.25 },
          pass,
        });
        if (!pass) process.exitCode = 1;
      } else notMeasured('ui.hubGrowth', 'file time');
      emit({
        metric: 'ui.fileTime',
        unit: 'ms',
        value: Math.round(clock.elapsed()),
      });
    } finally {
      await harness.close();
    }
  });
}
