// @ts-check
/**
 * The fixed-window helpers of the perf checks (perf/_window.mjs) and the
 * rule that every window length goes through `windowMs`, so
 * PERF_WINDOW_SCALE time-boxes every check (HR-SYN-19).
 */
import test from '@endo/ses-ava/test.js';

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_WINDOW_MS,
  runWindow,
  windowFields,
  windowMs,
} from '../perf/_window.mjs';
import { harnessRoot } from './_helpers.js';

// Serial: the timing cases run before the concurrent ones, so another test's
// file reads cannot stall the event loop for a whole window.
test.serial(
  'runWindow runs back to back until the window has passed',
  async t => {
    // An operation that settles at once: many samples in 100 ms.
    const w = await runWindow(async i => i, { ms: 100 });
    t.true(w.samples.length >= 2);
    t.is(w.results.length, w.samples.length);
    t.deepEqual(
      w.results,
      w.results.map((_, i) => i),
    );
    t.true(w.elapsedMs >= 100);
    t.is(w.ms, 100);
    t.is(w.few, 10);
    for (const sample of w.samples) t.true(sample >= 0);
  },
);

test.serial('runWindow holds at least min samples and at most max', async t => {
  const slow = await runWindow(
    () => new Promise(resolve => setTimeout(() => resolve('x'), 5)),
    { ms: 1, min: 3 },
  );
  t.is(slow.samples.length, 3);
  t.true(slow.elapsedMs >= 1);
  const capped = await runWindow(async () => 1, { ms: 60_000, max: 4 });
  t.is(capped.samples.length, 4);
  t.true(capped.elapsedMs < 60_000);
  // The default min: one sample even when the window has passed at once.
  const one = await runWindow(
    () => new Promise(resolve => setTimeout(resolve, 3)),
    { ms: 0 },
  );
  t.is(one.samples.length, 1);
  t.is(DEFAULT_WINDOW_MS, 60_000);
});

test('windowFields reports the window, rates and few samples', t => {
  t.deepEqual(
    windowFields({ ms: 1000, elapsedMs: 2000.4, few: 10, samples: 4 }),
    {
      window: { ms: 1000, elapsedMs: 2000 },
      samples: 4,
      opsPerSecond: 2,
      opsPerMinute: 120,
      fewSamples: true,
    },
  );
  t.deepEqual(windowFields({ ms: 10, elapsedMs: 0, few: 1, samples: [1, 2] }), {
    window: { ms: 10, elapsedMs: 0 },
    samples: 2,
    opsPerSecond: null,
    opsPerMinute: null,
  });
});

test('windowMs reads the variable, falls back, and honours PERF_WINDOW_SCALE', t => {
  t.is(windowMs('W_MS', 60_000, { env: {} }), 60_000);
  t.is(windowMs('W_MS', 60_000, { env: { W_MS: '1000' } }), 1000);
  t.is(windowMs('W_MS', 60_000, { env: { PERF_WINDOW_SCALE: '0.05' } }), 3000);
  t.is(
    windowMs('W_MS', 60_000, {
      env: { W_MS: '1000', PERF_WINDOW_SCALE: '0.5' },
    }),
    500,
  );
  // Never below 1 ms.
  t.is(windowMs('W_MS', 10, { env: { PERF_WINDOW_SCALE: '0.001' } }), 1);
  // A window that must outlast a restart, a timeout or a GC cycle says so.
  t.is(
    windowMs('W_MS', 60_000, {
      scaled: false,
      env: { PERF_WINDOW_SCALE: '0.05' },
    }),
    60_000,
  );
  t.is(
    windowMs('W_MS', 60_000, {
      scaled: false,
      env: { W_MS: '2000', PERF_WINDOW_SCALE: '0.05' },
    }),
    2000,
  );
});

/**
 * Variables a perf file reads that are not window lengths: the idle sleep, a
 * kill poll interval, a stream's delta pacing and the scale itself.
 */
const NOT_WINDOWS = new Set([
  'IDLE_MS',
  'CRASH_KILL_POLL_MS',
  'PROVIDER_DELTA_MS',
  'PERF_WINDOW_SCALE',
]);

test('every perf window length is read through windowMs', async t => {
  const dir = path.join(harnessRoot, 'perf');
  const listed = await readdir(dir);
  const names = listed.filter(name => name.endsWith('.mjs'));
  t.true(names.length > 30);
  const sources = await Promise.all(
    names.map(name => readFile(path.join(dir, name), 'utf8')),
  );
  /** @type {string[]} */
  const bypass = [];
  for (const [i, name] of names.entries()) {
    const source = sources[i];
    for (const match of source.matchAll(
      /process\.env\.([A-Z0-9_]*(?:_MS|WINDOW)[A-Z0-9_]*)/g,
    )) {
      if (!NOT_WINDOWS.has(match[1])) bypass.push(`${name}: ${match[1]}`);
    }
  }
  t.deepEqual(bypass, []);
});
