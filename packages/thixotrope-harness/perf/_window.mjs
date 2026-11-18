// @ts-check
/**
 * Fixed-window measurement for perf checks (designs/process.md section 3):
 * run an operation back to back for a fixed time instead of a fixed count,
 * and report the window with the samples it held.
 *
 *   const w = await runWindow(async () => { ... }, { ms: 60_000 });
 *   await stats('feature.op', w.samples, { extra: windowFields(w) });
 *
 * A window always holds at least `min` samples (default 1), so a slow
 * operation can overrun it by one operation; it holds at most `max`
 * (default unbounded). A window with fewer than `few` samples (default 10)
 * says so (`fewSamples: true`); it does not run longer.
 *
 * PERF_WINDOW_SCALE (default 1) multiplies every window read through
 * `windowMs`: 0.25 for a quick smoke, never to make a row pass.
 */
import { performance } from 'node:perf_hooks';

/** The default window of one measured point. */
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * A window length from an environment variable (milliseconds), multiplied
 * by PERF_WINDOW_SCALE. Every window length a perf check reads goes through
 * here (test/perf-window.test.js checks it), so the scale time-boxes every
 * check. A window that must outlast a restart, a timeout or a collection
 * cycle passes `scaled: false` and says why beside it; its variable still
 * sets it.
 * @param {string} name
 * @param {number} fallback
 * @param {{ scaled?: boolean, env?: Record<string, string | undefined> }} [options]
 */
export const windowMs = (
  name,
  fallback,
  { scaled = true, env = process.env } = {},
) => {
  const scale = scaled ? Number(env.PERF_WINDOW_SCALE ?? 1) : 1;
  return Math.max(1, Math.round(Number(env[name] ?? fallback) * scale));
};

/**
 * @typedef {object} Window
 * @property {number[]} samples milliseconds per operation
 * @property {any[]} results what each operation returned
 * @property {number} ms the window asked for
 * @property {number} elapsedMs the window as run (the last operation ends it)
 * @property {number} few
 */

/**
 * Run `op` back to back until `ms` have passed (and at least `min` ran).
 * @template T
 * @param {(index: number) => Promise<T>} op
 * @param {{ ms?: number, min?: number, max?: number, few?: number }} [options]
 * @returns {Promise<Window>}
 */
export const runWindow = async (
  op,
  { ms = DEFAULT_WINDOW_MS, min = 1, max = Infinity, few = 10 } = {},
) => {
  /** @type {number[]} */
  const samples = [];
  /** @type {T[]} */
  const results = [];
  const t0 = performance.now();
  while (
    samples.length < max &&
    (samples.length < min || performance.now() - t0 < ms)
  ) {
    const t = performance.now();
    results.push(await op(samples.length));
    samples.push(performance.now() - t);
  }
  return { samples, results, ms, elapsedMs: performance.now() - t0, few };
};

/** @param {number} value */
const round1 = value => +value.toFixed(1);

/**
 * The window fields a row carries: `window` (asked and run, ms), `samples`
 * (operations the window held), operations per second and per minute, and
 * `fewSamples` when it held fewer than the window's `few`.
 * @param {Pick<Window, 'ms' | 'elapsedMs' | 'few'> & { samples: number[] | number }} w
 */
export const windowFields = w => {
  const n = typeof w.samples === 'number' ? w.samples : w.samples.length;
  const seconds = w.elapsedMs / 1000;
  return {
    window: { ms: w.ms, elapsedMs: Math.round(w.elapsedMs) },
    samples: n,
    opsPerSecond: seconds > 0 ? round1(n / seconds) : null,
    opsPerMinute: seconds > 0 ? round1((n * 60) / seconds) : null,
    ...(n < w.few ? { fewSamples: true } : {}),
  };
};

/**
 * Window fields for samples gathered some other way (a stretch of turns
 * whose per-turn numbers come from logs) between `t0` and `t1`.
 * @param {number} ms the window asked for
 * @param {number} t0 performance.now() at its start
 * @param {number} t1 performance.now() at its end
 * @param {number} n samples it held
 * @param {number} [few]
 */
export const stretchFields = (ms, t0, t1, n, few = 10) =>
  windowFields({ ms, elapsedMs: t1 - t0, few, samples: n });
