// @ts-check
/**
 * Spike S1 (milestones.md M0, W0.5): frame halt points in and out of a vat,
 * several messages per crank, eventual sends per crank and runaway-loop wall
 * time, at a crank budget.
 *
 * A measurement program: it prints one JSON line per probe and asserts its
 * findings. Every halt it provokes happens in throwaway state under `tmp/`.
 *
 *   THIX_HARNESS_SPIKES=1 S1_BUDGETS=10000000,50000000 S1_PARTS=inbound,loop \
 *     node scripts/run-lock.mjs -- corepack yarn test test/spikes/s1.test.js
 *
 * S1_BUDGETS (default 10000000): crank budgets, one fresh state directory
 *   each. S1_PARTS (default inbound,outbound,percrank,sends,loop): `accept`
 *   adds M0 acceptance test 1 at the settings in config/defaults.js;
 *   `inboundUsed` searches the inbound halt point on vats with the history
 *   of a used session vat (a staged 250 k program and a full key table).
 */
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import {
  E,
  attempt,
  emit,
  giveHistory,
  makeSink,
  spikesEnabled,
  startHost,
  takeRunLock,
} from './_spike.js';

/** @typedef {import('./_spike.js').Host} Host */

const budgets = (process.env.S1_BUDGETS ?? '10000000')
  .split(',')
  .map(s => BigInt(s.trim()));
const parts = new Set(
  (process.env.S1_PARTS ?? 'inbound,outbound,percrank,sends,loop').split(','),
);
const KiB = 1024;

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s1');
});
test.after.always(async () => {
  await lock?.release();
});

/**
 * One probe on a vat: run `call`, classify, emit.
 * @param {Host} host
 * @param {{ vat: any, workerId?: string, installMs?: number }} probe
 * @param {Record<string, unknown>} row
 * @param {(vat: any) => Promise<any>} call
 */
const probeOnce = async (host, probe, row, call) => {
  const floorMs = await host.floor(probe.vat);
  const result = await attempt(() => call(probe.vat));
  const diagnosis = result.ok ? {} : await host.diagnose(probe);
  const out = await emit({
    spike: 'S1',
    ...row,
    ok: result.ok,
    ms: result.ms,
    floorMs,
    overFloorMs: +(result.ms - floorMs).toFixed(1),
    ...(result.ok ? {} : { error: result.error }),
    ...diagnosis,
    ...(probe.installMs === undefined ? {} : { installMs: probe.installMs }),
  });
  return { ...result, alive: result.ok || diagnosis.alive, row: out };
};

/**
 * Ascending ladder, then bisection between the largest passing size and the
 * smallest failing one. `freshEach` installs a new vat per probe (inbound:
 * the vat's property-key table is history, J-0140); otherwise a vat is reused
 * until a probe fails.
 * @param {Host} host
 * @param {object} options
 * @param {string} options.metric
 * @param {bigint} options.crankBudget
 * @param {number[]} options.sizes
 * @param {(vat: any, size: number) => Promise<any>} options.call
 * @param {(size: number) => Record<string, unknown>} [options.describe]
 * @param {boolean} [options.freshEach]
 * @param {number} [options.bisect] bisection steps
 * @param {number} [options.grain] round bisection sizes to this
 */
const haltSearch = async (
  host,
  {
    metric,
    crankBudget,
    sizes,
    call,
    describe = size => ({ size }),
    freshEach = false,
    bisect = 3,
    grain = KiB,
  },
) => {
  /** @type {any} */
  let probe;
  let okMax = 0;
  /** @type {number | undefined} */
  let haltMin;
  /** @type {string | undefined} */
  let haltError;
  const run = async (/** @type {number} */ size) => {
    if (!probe || freshEach) {
      if (probe) await host.retire(probe.name);
      probe = await host.fresh();
    }
    const result = await probeOnce(
      host,
      probe,
      { metric, crankBudget: String(crankBudget), ...describe(size) },
      vat => call(vat, size),
    );
    if (!result.alive || !result.ok) {
      await host.retire(probe.name);
      probe = undefined;
    }
    return result;
  };
  for (const size of sizes) {
    // eslint-disable-next-line no-await-in-loop
    const result = await run(size);
    if (result.ok) okMax = size;
    else {
      haltMin = size;
      haltError = result.error;
      break;
    }
  }
  for (let i = 0; i < bisect && haltMin !== undefined; i += 1) {
    const mid = Math.round((okMax + haltMin) / 2 / grain) * grain;
    if (mid <= okMax || mid >= haltMin) break;
    // eslint-disable-next-line no-await-in-loop
    const result = await run(mid);
    if (result.ok) okMax = mid;
    else {
      haltMin = mid;
      haltError = result.error;
    }
  }
  if (probe) await host.retire(probe.name);
  const summary = await emit({
    spike: 'S1',
    metric: `${metric}.haltPoint`,
    crankBudget: String(crankBudget),
    okMax,
    haltMin: haltMin ?? null,
    haltError: haltError ?? null,
    ladderTop: sizes[sizes.length - 1],
  });
  return { okMax, haltMin, haltError, row: summary };
};

const INBOUND_SIZES = [
  16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048,
].map(n => n * KiB);

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const inbound = async (t, host, crankBudget) => {
  /** @type {Record<number, Awaited<ReturnType<typeof haltSearch>>>} */
  const found = {};
  for (const k of [1, 8, 32]) {
    // eslint-disable-next-line no-await-in-loop
    found[k] = await haltSearch(host, {
      metric: k === 1 ? 'frames.inbound.single' : `frames.inbound.strings${k}`,
      crankBudget,
      sizes: INBOUND_SIZES,
      freshEach: true,
      describe: size => ({ utf8Bytes: size, strings: k }),
      call: (vat, size) =>
        k === 1
          ? E(vat).len('x'.repeat(size))
          : E(vat).lenAll(
              Array.from({ length: k }, () => 'x'.repeat(size / k)),
            ),
    });
  }
  // Before d0fd6b1138 every byte of a hardened frame interned a key and
  // the ceiling was the 16-bit key table near 58 KB (J-0140, J-0190); the
  // assertion is the setting's requirement, not the halt's cause.
  for (const k of [1, 8, 32]) {
    t.true(
      found[k].okMax >= 2 * limits.frameBytes,
      `inbound x${k} takes 2 x frameBytes at ${crankBudget}`,
    );
  }
};

/**
 * The inbound halt point on vats that have done work (QC finding 2): each
 * probe vat first stages and evaluates a 250 k program and fills its key
 * table to the engine's reserve, so no history can leave less room.
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const inboundUsed = async (t, host, crankBudget) => {
  /** @type {Record<string, unknown>} */
  let history = {};
  const found = await haltSearch(host, {
    metric: 'frames.inbound.usedVat',
    crankBudget,
    sizes: INBOUND_SIZES,
    freshEach: true,
    describe: size => ({ utf8Bytes: size, strings: 1, ...history }),
    call: async (vat, size) => {
      history = await giveHistory(vat, { frameBytes: limits.frameBytes });
      return E(vat).len('x'.repeat(size));
    },
  });
  t.true(
    found.okMax >= 2 * limits.frameBytes,
    `a used vat takes 2 x frameBytes at ${crankBudget}`,
  );
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const outbound = async (t, host, crankBudget) => {
  const single = await haltSearch(host, {
    metric: 'frames.outbound.single',
    crankBudget,
    // At 50 M and 100 M, 8 MiB lost the control connection and 16 MiB ended
    // in HeapExhausted (J-0143); S1_OUT_MAX_KIB raises the ladder top.
    sizes: [64, 256, 1024, 4096, 8192, 16_384]
      .filter(n => n <= Number(process.env.S1_OUT_MAX_KIB ?? 4096))
      .map(n => n * KiB),
    bisect: 2,
    grain: 64 * KiB,
    describe: size => ({ utf8Bytes: size, strings: 1 }),
    call: (vat, size) => E(vat).out(size),
  });
  const many = await haltSearch(host, {
    metric: 'frames.outbound.strings32',
    crankBudget,
    sizes: [64, 256, 1024, 4096].map(n => n * KiB),
    bisect: 2,
    grain: 64 * KiB,
    describe: size => ({ utf8Bytes: size, strings: 32 }),
    call: (vat, size) => E(vat).outMany(32, size / 32),
  });
  t.true(single.okMax >= 256 * KiB, 'outbound single string of 256 KiB');
  t.true(many.okMax >= 256 * KiB, 'outbound 32 strings totalling 256 KiB');
};

/**
 * Several messages in one crank: outbound E.sendOnly bursts carrying strings
 * to a Node sink, and pipelined inbound calls.
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const perCrank = async (t, host, crankBudget) => {
  const sink = makeSink();
  /** @type {any} */
  let probe;
  const k = 8;
  const out = await haltSearch(host, {
    metric: 'frames.crankOut.sendOnly8',
    crankBudget,
    // 8 x 1 MiB passes the control connection's limit (J-0143).
    sizes: [4, 16, 64, 256, 1024]
      .filter(n => n <= Number(process.env.S1_OUT_MAX_KIB ?? 4096) / 8)
      .map(n => n * KiB),
    bisect: 2,
    grain: 4 * KiB,
    describe: size => ({ messages: k, bytesEach: size, utf8Bytes: k * size }),
    call: async (vat, size) => {
      if (probe?.vat !== vat) {
        await E(vat).setSink(sink.sink);
        probe = { vat };
      }
      sink.reset();
      await E(vat).pushMany(k, size);
      await sink.until(k);
      return sink.bytes;
    },
  });
  t.true(out.okMax >= 16 * KiB, '8 outbound messages of 16 KiB in one crank');

  // Pipelined inbound: k calls sent without waiting, on a fresh vat each.
  for (const size of [4 * KiB, 8 * KiB, 16 * KiB]) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await host.fresh();
    // eslint-disable-next-line no-await-in-loop
    const floorMs = await host.floor(fresh.vat);
    // eslint-disable-next-line no-await-in-loop
    const result = await attempt(() =>
      Promise.all(
        Array.from({ length: k }, () => E(fresh.vat).len('x'.repeat(size))),
      ),
    );
    // eslint-disable-next-line no-await-in-loop
    const diagnosis = result.ok ? {} : await host.diagnose(fresh);
    // eslint-disable-next-line no-await-in-loop
    await emit({
      spike: 'S1',
      metric: 'frames.inbound.pipelined8',
      crankBudget: String(crankBudget),
      messages: k,
      bytesEach: size,
      utf8Bytes: k * size,
      ok: result.ok,
      ms: result.ms,
      perMessageMs: +(result.ms / k).toFixed(1),
      floorMs,
      ...(result.ok ? {} : { error: result.error }),
      ...diagnosis,
    });
    // eslint-disable-next-line no-await-in-loop
    await host.retire(fresh.name);
  }
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const sends = async (t, host, crankBudget) => {
  const sink = makeSink();
  /** @type {any} */
  let wired;
  const sendOnly = await haltSearch(host, {
    metric: 'sends.perCrank.sendOnly',
    crankBudget,
    sizes: [100, 250, 500, 1000, 2000, 4000, 8000],
    grain: 50,
    describe: size => ({ sends: size }),
    call: async (vat, size) => {
      if (wired !== vat) {
        await E(vat).setSink(sink.sink);
        wired = vat;
      }
      sink.reset();
      await E(vat).sendOnly(size);
      await sink.until(size);
      return sink.events;
    },
  });
  const answered = await haltSearch(host, {
    metric: 'sends.perCrank.answered',
    crankBudget,
    sizes: [100, 250, 500, 1000, 2000],
    grain: 50,
    describe: size => ({ sends: size }),
    call: async (vat, size) => {
      if (wired !== vat) {
        await E(vat).setSink(sink.sink);
        wired = vat;
      }
      sink.reset();
      const t0 = performance.now();
      await E(vat).sendAnswered(size);
      const issueMs = performance.now() - t0;
      await sink.until(size);
      const receivedMs = performance.now() - t0;
      // The answers return to the vat as deliveries; a ping queues behind them.
      await E(vat).ping();
      const settledMs = performance.now() - t0;
      return {
        issueMs: +issueMs.toFixed(1),
        receivedMs: +receivedMs.toFixed(1),
        settledMs: +settledMs.toFixed(1),
      };
    },
  });
  t.true(sendOnly.okMax >= 100, '100 sendOnly sends in one crank');
  t.true(answered.okMax >= 100, '100 answered sends in one crank');
};

/**
 * Answered sends per crank on a vat with a used session vat's history (QC
 * finding 2): sendsPerCrank was chosen on the empty probe vat.
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const sendsUsed = async (t, host, crankBudget) => {
  const sink = makeSink();
  /** @type {any} */
  let wired;
  /** @type {Record<string, unknown>} */
  let history = {};
  const answered = await haltSearch(host, {
    metric: 'sends.perCrank.answered.usedVat',
    crankBudget,
    sizes: [100, 250, 500, 1000],
    grain: 50,
    describe: size => ({ sends: size, ...history }),
    call: async (vat, size) => {
      if (wired !== vat) {
        history = await giveHistory(vat, { frameBytes: limits.frameBytes });
        await E(vat).setSink(sink.sink);
        wired = vat;
      }
      sink.reset();
      await E(vat).sendAnswered(size);
      await sink.until(size);
      await E(vat).ping();
      return size;
    },
  });
  t.true(
    answered.okMax >= 2 * limits.sendsPerCrank,
    'a used vat takes 2 x sendsPerCrank answered sends in one crank',
  );
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const loop = async (t, host, crankBudget) => {
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await host.fresh();
    // eslint-disable-next-line no-await-in-loop
    const result = await probeOnce(
      host,
      probe,
      { metric: 'loop.runaway', crankBudget: String(crankBudget), sample: i },
      vat => E(vat).spin(),
    );
    samples.push(result);
    // eslint-disable-next-line no-await-in-loop
    await host.retire(probe.name);
  }
  for (const s of samples) {
    t.false(s.ok, 'a runaway loop never answers');
    t.false(s.alive, 'a runaway loop halts its vat');
  }
  const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
  await emit({
    spike: 'S1',
    metric: 'loop.runaway.summary',
    crankBudget: String(crankBudget),
    n: sorted.length,
    median: sorted[1],
    max: sorted[2],
  });
};

/**
 * M0 acceptance test 1 at the chosen settings: 200 messages of frameBytes in
 * and 200 out with no halt, and a halt point of at least 2 x frameBytes.
 * @param {import('ava').ExecutionContext} t
 * @param {Host} host
 * @param {bigint} crankBudget
 */
const accept = async (t, host, crankBudget) => {
  const { frameBytes } = limits;
  const probe = await host.fresh();
  const inboundMs = [];
  const outboundMs = [];
  const payload = 'x'.repeat(frameBytes);
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const n = await E(probe.vat).len(payload);
    inboundMs.push(performance.now() - t0);
    t.is(n, frameBytes);
  }
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const s = await E(probe.vat).out(frameBytes);
    outboundMs.push(performance.now() - t0);
    t.is(s.length, frameBytes);
  }
  const floorMs = await host.floor(probe.vat, 20);
  await host.retire(probe.name);
  const med = (/** @type {number[]} */ xs) =>
    +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1);
  await emit({
    spike: 'S1',
    metric: 'accept.frames200',
    crankBudget: String(crankBudget),
    frameBytes,
    inboundMedianMs: med(inboundMs),
    inboundFirstMs: +inboundMs[0].toFixed(1),
    inboundMaxMs: +Math.max(...inboundMs).toFixed(1),
    outboundMedianMs: med(outboundMs),
    floorMs,
    ok: true,
  });
  const fresh = await host.fresh();
  const twice = await probeOnce(
    host,
    fresh,
    {
      metric: 'accept.twiceFrameBytes',
      crankBudget: String(crankBudget),
      utf8Bytes: 2 * frameBytes,
    },
    vat => E(vat).len('x'.repeat(2 * frameBytes)),
  );
  await host.retire(fresh.name);
  t.true(twice.ok, 'a fresh vat takes 2 x frameBytes in one message');
  // The same on a vat with a used session vat's history (QC finding 2).
  const used = await host.fresh();
  const history = await giveHistory(used.vat, { frameBytes });
  const usedTwice = await probeOnce(
    host,
    used,
    {
      metric: 'accept.twiceFrameBytes.usedVat',
      crankBudget: String(crankBudget),
      utf8Bytes: 2 * frameBytes,
      ...history,
    },
    vat => E(vat).len('x'.repeat(2 * frameBytes)),
  );
  await host.retire(used.name);
  t.true(usedTwice.ok, 'a used vat takes 2 x frameBytes in one message');
};

const PARTS = {
  inbound,
  inboundUsed,
  outbound,
  percrank: perCrank,
  sends,
  sendsUsed,
  loop,
  accept,
};

for (const crankBudget of budgets) {
  const run = spikesEnabled ? test.serial : test.skip;
  run(`S1 at crank budget ${crankBudget}`, async t => {
    t.timeout(60 * 60_000);
    const host = await startHost({ crankBudget, tag: 's1' });
    await emit({
      spike: 'S1',
      metric: 'host.start',
      crankBudget: String(crankBudget),
      ms: host.startMs,
    });
    try {
      for (const [name, part] of Object.entries(PARTS)) {
        // eslint-disable-next-line no-await-in-loop
        if (parts.has(name)) await part(t, host, crankBudget);
      }
    } finally {
      await host.close();
    }
  });
}

if (!spikesEnabled) {
  test('S1 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
