// @ts-check
/**
 * M0 perf checks for frames (milestones.md M0 "Perf checks"; architecture.md
 * section 11): frames.halt, frames.inbound, frames.outbound,
 * vat.evaluateProgram and loop.runaway, at the settings in
 * config/defaults.js and the crank budget the harness serves with.
 *
 *   cd packages/thixotrope-harness && node perf/frames.perf.mjs
 *
 * FRAMES_WINDOW_MS (default 15 s; it was FRAMES_N = 200 samples) per
 * latency metric (pingFloor, inbound, outbound); LOOP_N (default 5)
 * runaway-loop runs; THIXOTROPE_CRANK_BUDGET overrides the budget.
 */
import { performance } from 'node:perf_hooks';

import {
  crankBudget,
  emit,
  runPerf,
  single,
  stats,
  summarize,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first, J-0131).
const { limits } = await import('../config/defaults.js');
const { PROBE_PROGRAM, giveHistory, makeProgram } =
  await import('../test/spikes/_spike.js');
const { E } = await import('@endo/far');

/** Per latency metric (it was FRAMES_N = 200 samples). */
const FRAMES_WINDOW_MS = windowMs('FRAMES_WINDOW_MS', 15_000);
const LOOP_N = Number(process.env.LOOP_N ?? 5);
/** M0 perf table: frames at frameBytes cost at most this over the ping floor. */
const OVER_FLOOR_MS = 300;

/**
 * @template T
 * @param {() => Promise<T>} fn
 */
const time = async fn => {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ok: true, ms: performance.now() - t0, value };
  } catch (error) {
    return {
      ok: false,
      ms: performance.now() - t0,
      error: String(/** @type {Error} */ (error)?.message ?? error).slice(
        0,
        200,
      ),
    };
  }
};

await runPerf('frames', async ({ provision }) => {
  const run = await provision();
  const { frameBytes } = limits;
  let count = 0;
  const fresh = async () => {
    count += 1;
    const name = `f${count}`;
    await run.client.call('install', name, PROBE_PROGRAM, []);
    const vat = await run.client.call('lookup', name);
    await E(vat).ping();
    return { name, vat };
  };
  /** @param {string} name */
  const retire = name => run.client.call('remove', name).catch(() => {});
  /**
   * @param {number} n
   * @param {() => Promise<unknown>} fn
   */
  const sample = async (n, fn) => {
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await fn();
      samples.push(performance.now() - t0);
    }
    return samples;
  };
  /**
   * Samples of `fn` over one window, with the window's fields.
   * @param {() => Promise<unknown>} fn
   */
  const windowed = async fn => {
    const w = await runWindow(fn, { ms: FRAMES_WINDOW_MS });
    return { samples: w.samples, fields: windowFields(w) };
  };
  const settings = {
    frameBytes,
    crankOutBytes: limits.crankOutBytes,
    configuredCrankBudget: String(limits.crankBudget),
  };

  // Ping floor and frames at frameBytes on one vat.
  const probe = await fresh();
  await sample(20, () => E(probe.vat).ping());
  let before = await run.counters();
  const floor = await windowed(() => E(probe.vat).ping());
  const floorSamples = floor.samples;
  let after = await run.counters();
  const floorMedian = summarize(floorSamples).median;
  await stats('frames.pingFloor', floorSamples, {
    before,
    after,
    root: run.root,
    extra: { ...settings, ...floor.fields },
  });

  const payload = 'x'.repeat(frameBytes);
  // The first inbound frame into a vat is reported on its own (it used to
  // intern its index keys, J-0140), then the steady state.
  const first = await time(() => E(probe.vat).len(payload));
  await single('frames.inbound.first', first.ms, {
    extra: { ...settings, ok: first.ok, floorMedian },
  });
  before = await run.counters();
  const inbound = await windowed(() => E(probe.vat).len(payload));
  after = await run.counters();
  await stats('frames.inbound', inbound.samples, {
    budget: { median: +(floorMedian + OVER_FLOOR_MS).toFixed(3) },
    before,
    after,
    root: run.root,
    extra: {
      ...settings,
      floorMedian,
      utf8Bytes: frameBytes,
      ...inbound.fields,
    },
  });

  before = await run.counters();
  const outbound = await windowed(() => E(probe.vat).out(frameBytes));
  after = await run.counters();
  await stats('frames.outbound', outbound.samples, {
    budget: { median: +(floorMedian + OVER_FLOOR_MS).toFixed(3) },
    before,
    after,
    root: run.root,
    extra: {
      ...settings,
      floorMedian,
      utf8Bytes: frameBytes,
      ...outbound.fields,
    },
  });
  await retire(probe.name);

  // frames.halt: the halt point is at least 2 x frameBytes, so a fresh vat
  // takes one message of twice frameBytes.
  const halt = await fresh();
  const twice = await time(() => E(halt.vat).len('x'.repeat(2 * frameBytes)));
  await single('frames.halt', twice.ms, {
    extra: {
      ...settings,
      utf8Bytes: 2 * frameBytes,
      ok: twice.ok,
      ...(twice.ok ? {} : { error: twice.error }),
    },
  });
  if (!twice.ok) process.exitCode = 1;
  await retire(halt.name);
  // The same on a vat with a used session vat's history: a staged 250 k
  // program and a key table filled to the engine's reserve (QC finding 2).
  const used = await fresh();
  const history = await giveHistory(used.vat, { frameBytes });
  const usedTwice = await time(() =>
    E(used.vat).len('x'.repeat(2 * frameBytes)),
  );
  await single('frames.halt.usedVat', usedTwice.ms, {
    extra: {
      ...settings,
      ...history,
      utf8Bytes: 2 * frameBytes,
      ok: usedTwice.ok,
      ...(usedTwice.ok ? {} : { error: usedTwice.error }),
    },
  });
  if (!usedTwice.ok) process.exitCode = 1;
  await retire(used.name);

  // vat.evaluateProgram: a 150 k program source, staged in frameBytes
  // chunks as the harness does (CORE-1b), then evaluated in one crank.
  const program = makeProgram(150_000);
  const evalVat = await fresh();
  const t0 = performance.now();
  for (let offset = 0; offset < program.source.length; offset += frameBytes) {
    // eslint-disable-next-line no-await-in-loop
    await E(evalVat.vat).stage(
      program.source.slice(offset, offset + frameBytes),
    );
  }
  const stageMs = performance.now() - t0;
  const evaluated = await time(() => E(evalVat.vat).evalStaged());
  const totalMs = performance.now() - t0;
  const evalOk = evaluated.ok && evaluated.value === program.functions;
  await single('vat.evaluateProgram', totalMs, {
    budget: { value: 2000 },
    extra: {
      ...settings,
      sourceChars: program.source.length,
      stageMs: +stageMs.toFixed(1),
      evalCrankMs: +evaluated.ms.toFixed(1),
      ok: evalOk,
      ...(evaluated.ok ? {} : { error: evaluated.error }),
    },
  });
  if (!evalOk) process.exitCode = 1;
  await retire(evalVat.name);
  // The same source in one message, recorded (no budget: the harness
  // stages, CORE-1b).
  const oneVat = await fresh();
  const one = await time(() => E(oneVat.vat).evalProgram(program.source));
  await single('vat.evaluateProgram.oneMessage', one.ms, {
    extra: {
      ...settings,
      sourceChars: program.source.length,
      ok: one.ok && one.value === program.functions,
      ...(one.ok ? {} : { error: one.error }),
    },
  });
  await retire(oneVat.name);

  // loop.runaway: wall time until the meter halts a runaway crank.
  const spins = [];
  for (let i = 0; i < LOOP_N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fresh();
    // eslint-disable-next-line no-await-in-loop
    const r = await time(() => E(v.vat).spin());
    if (r.ok) process.exitCode = 1;
    spins.push(r.ms);
    // eslint-disable-next-line no-await-in-loop
    await retire(v.name);
  }
  await stats('loop.runaway', spins, {
    budget: { median: 1000 },
    extra: { ...settings, runs: LOOP_N },
  });
  emit({ metric: 'frames.done', crankBudget, frameBytes });
});
