// @ts-check
/**
 * Spike S6 (milestones.md M0, W0.7; decides D-4, the spare-vat pool).
 *
 * A spare is a durable vat created through the workspace's worker controller
 * (`vats`, the resource the factory will hold), loaded with a session-sized
 * program (a generated 250 k-character guest program, staged in frameBytes
 * chunks and evaluated in one crank) whose completion value is a maker
 * object. The spare is left idle until it checkpoints and sleeps. Taking it
 * is the factory's `createSession` path: one `make(config)` call, which
 * wakes the vat.
 *
 * Measures: creation time, take time (`vat.spareTake`, budget <= 500 ms),
 * disk per sleeping vat, resident memory awake and asleep, and the daemon's
 * restart time with 0, 10 and 50 sleeping spares (clean and SIGKILL), with
 * the number of vats startup woke (architecture section 0 fact 5).
 *
 * The creation is driven from Node here (the control client holds `vats`);
 * the factory vat will drive the same messages itself [inferred: plus one
 * outbound crank per chunk in the factory].
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s6.test.js
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { limits } from '../../config/defaults.js';
// eslint-disable-next-line import/no-relative-packages -- not exported
import { evaluateSource } from '../../../thixotrope/src/core/evaluate-source.js';
import { du, stats as perfStats } from '../../perf/_harness.mjs';
import { ensureTemplate, startFromTemplate } from '../template/index.js';
import { E, emit, round1, spikesEnabled, takeRunLock } from './_spike.js';
import { summarize } from './_crash.js';

const crankBudget = BigInt(process.env.S6_BUDGET ?? limits.crankBudget);
const PROGRAM_CHARS = Number(process.env.S6_PROGRAM_CHARS ?? 250_000);
const FIRST = Number(process.env.S6_FIRST ?? 6);
const COUNTS = (process.env.S6_COUNTS ?? '10,50').split(',').map(Number);
const PARALLEL = Number(process.env.S6_PARALLEL ?? 4);
const IDLE_MS = Number(process.env.S6_IDLE_MS ?? 2000);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s6');
});
test.after.always(async () => {
  await lock?.release();
});

/**
 * A generated session-sized guest program: `(endowments) => maker`. It has
 * module-like closures (each with 30 local functions whose names repeat
 * across modules, as in a bundle), initialised at load; `make(config)`
 * builds per-session state and returns a Session object. Plain ASCII.
 * @param {number} chars
 */
export const makeSessionProgram = chars => {
  const head = `(endowments) => {
  const table = new Map();
  const modules = [];
`;
  const tail = `  for (const init of modules) init(table);
  let made = false;
  const make = config => {
    const state = { config, turns: [], counters: new Map(), notes: [] };
    let handlers = 0;
    let check = 0;
    for (const [name, fns] of table) {
      handlers += fns.length;
      check = (check + fns[0](state, name.length) + fns.length) % 1000003;
    }
    state.counters.set('handlers', handlers);
    return Far('Session', {
      ping: () => 1,
      info: () => harden({ title: String(config.title), handlers, check }),
      run: (module, index, x) => {
        const fns = table.get(module);
        return fns[index % fns.length](state, x);
      },
    });
  };
  return Far('SpareMaker', {
    ping: () => 1,
    modules: () => table.size,
    make: config => {
      if (made) throw Error('this spare has been taken');
      made = true;
      return make(config);
    },
  });
}
`;
  /** @param {number} m */
  const module = m => {
    const lines = [`  modules.push(table => {\n`];
    for (let f = 0; f < 30; f += 1) {
      const k = (m * 31 + f) % 97;
      switch (f % 3) {
        case 0:
          lines.push(
            `    const f${f} = (state, x) => { const r = (x | 0) * ${k} + ${f}; return r % 7 === 3 ? state.notes.length : r % 1009; };\n`,
          );
          break;
        case 1:
          lines.push(
            `    const f${f} = (state, x) => { const parts = ['m${m}', 'f${f}', String(x)]; state.notes.push(parts.join(':')); return parts.length + ${k}; };\n`,
          );
          break;
        default:
          lines.push(
            `    const f${f} = (state, x) => { let acc = ${k}; for (let i = 0; i < 4; i += 1) acc = (acc * 31 + i + (x | 0)) % 65521; return acc; };\n`,
          );
      }
    }
    lines.push(
      `    table.set('m${m}', [${Array.from({ length: 30 }, (_, f) => `f${f}`).join(', ')}]);\n  });\n`,
    );
    return lines.join('');
  };
  const parts = [head];
  let length = head.length + tail.length;
  for (let m = 0; ; m += 1) {
    const text = module(m);
    if (length + text.length > chars) break;
    parts.push(text);
    length += text.length;
  }
  parts.push(tail);
  const source = parts.join('');
  return { source, modules: parts.length - 2 };
};

/**
 * Resident memory of the worker processes serving `root`, and of those
 * whose heap directory names `label` (`vat-<label>-...`).
 * @param {string} root
 * @param {string} [label]
 */
const workerRss = (root, label) => {
  const out = execFileSync('ps', ['-axo', 'rss=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  }).toString();
  const rows = out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(`${root}/`) && line.includes('heap.sqlite'));
  const pick = label
    ? rows.filter(line => line.includes(`vat-${label}-`))
    : rows;
  return {
    workers: pick.length,
    rssKiB: pick.reduce((n, line) => n + Number(line.split(/\s+/)[0]), 0),
  };
};

const run = spikesEnabled ? test.serial : test.skip;

run('S6 spare-vat pool: create, sleep, take, startup cost', async t => {
  t.timeout(3 * 60 * 60_000);
  const base = { spike: 'S6', crankBudget: String(crankBudget) };
  const { source, modules } = makeSessionProgram(PROGRAM_CHARS);
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(source)) throw Error('program must be ASCII');
  /** @type {Record<string, boolean>} */
  const found = {};
  const template = await ensureTemplate({ crankBudget });
  const host = await startFromTemplate(template, { idleSleepMs: IDLE_MS });
  const { root } = host;
  await emit({
    ...base,
    metric: 's6.setup',
    programChars: source.length,
    modules,
    functions: modules * 30,
    templateBuilt: template.built,
    start: host.timings,
    idleSleepMs: IDLE_MS,
    chunkChars: limits.frameBytes,
  });

  /** @returns {Promise<any[]>} */
  const workers = async () => (await host.client.call('status')).workers;
  /**
   * The journal runs past the last snapshot: startup would replay it.
   * @param {any} w a status().workers row
   */
  const uncheckpointed = w =>
    Number(w.snapshot?.cut ?? 0) < Number(w.journalLength);
  /**
   * Wait until each worker is asleep and checkpointed.
   * @param {string[]} ids
   * @param {number} [timeoutMs]
   */
  const untilAsleep = async (ids, timeoutMs = 300_000) => {
    const t0 = performance.now();
    const want = new Set(ids);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const rows = (await workers()).filter(w => want.has(w.workerId));
      const pending = rows.filter(
        w => w.awake || uncheckpointed(w) || w.failure,
      );
      if (pending.length === 0 && rows.length === want.size)
        return round1(performance.now() - t0);
      if (rows.some(w => w.failure))
        throw Error(
          `spare failed: ${JSON.stringify(rows.find(w => w.failure)).slice(0, 500)}`,
        );
      if (performance.now() - t0 > timeoutMs)
        throw Error(
          `${pending.length} spares did not sleep in ${timeoutMs} ms`,
        );
      // eslint-disable-next-line no-await-in-loop
      await delay(250);
    }
  };

  // The worker controller, held by the workspace vat, made reachable.
  await host.client.call('evaluate', "(inventory.set('vats', vats), true)");
  let vats = await host.client.call('lookup', 'vats');

  /** @type {{ index: number, label: string, workerId: string, taken: boolean }[]} */
  const spares = [];
  /**
   * Create one spare: a durable vat, the program staged and evaluated, the
   * maker kept in the inventory under `m<index>` (so it survives restarts).
   * @param {number} index
   */
  const createSpare = async index => {
    const label = `sp${index}`;
    const t0 = performance.now();
    const facade = await E(vats).createWorker(label);
    const workerId = await E(facade).getId();
    const createWorkerMs = round1(performance.now() - t0);
    let messages = 0;
    let lastStart = 0;
    const maker = await evaluateSource(
      {
        evaluate: (s, e) => {
          messages += 1;
          lastStart = performance.now();
          return E(facade).evaluate(s, e);
        },
      },
      source,
      {},
      { chunkChars: limits.frameBytes },
    );
    const t1 = performance.now();
    const loadMs = round1(t1 - t0 - createWorkerMs);
    const evalMs = round1(t1 - lastStart);
    await host.client.call('keep', `m${index}`, maker);
    spares.push({ index, label, workerId, taken: false });
    return {
      index,
      label,
      workerId,
      maker,
      createWorkerMs,
      loadMs,
      evalMs,
      messages,
      totalMs: round1(performance.now() - t0),
    };
  };
  /**
   * Create spares `from..to-1`, PARALLEL at a time.
   * @param {number} from
   * @param {number} to
   */
  const createMany = async (from, to) => {
    const t0 = performance.now();
    /** @type {number[]} */
    const totals = [];
    let next = from;
    const lane = async () => {
      while (next < to) {
        const index = next;
        next += 1;
        // eslint-disable-next-line no-await-in-loop
        const made = await createSpare(index);
        totals.push(made.totalMs);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, lane));
    return { wallMs: round1(performance.now() - t0), each: summarize(totals) };
  };

  /**
   * Take spare `index`: one make() call (it wakes the sleeping vat), then a
   * ping on the new session (awake floor).
   * @param {number} index
   * @param {string} phase
   */
  const take = async (index, phase) => {
    const spare = spares.find(s => s.index === index);
    if (!spare) throw Error(`no spare ${index}`);
    const maker = await host.client.call('lookup', `m${index}`);
    const before = (await workers()).find(w => w.workerId === spare.workerId);
    const t0 = performance.now();
    const session = await E(maker).make(harden({ title: `session ${index}` }));
    const takeMs = round1(performance.now() - t0);
    const t1 = performance.now();
    const info = await E(session).info();
    const awakeCallMs = round1(performance.now() - t1);
    spare.taken = true;
    const rss = workerRss(root, spare.label);
    return {
      phase,
      index,
      wasAwake: before?.awake,
      takeMs,
      awakeCallMs,
      handlers: info.handlers,
      awakeRssKiB: rss.rssKiB,
    };
  };

  /**
   * Restart the daemon (clean or SIGKILL) and report what startup woke.
   * @param {'clean' | 'sigkill'} how
   * @param {number} sleeping
   */
  const restart = async (how, sleeping) => {
    if (how === 'sigkill') await host.kill();
    const { servedMs, connectedMs } = await host.restart();
    vats = await host.client.call('lookup', 'vats');
    const rows = await workers();
    const ids = new Set(spares.map(s => s.workerId));
    const spareRows = rows.filter(w => ids.has(w.workerId));
    const row = {
      ...base,
      metric: `s6.restart.${how}`,
      sleepingSpares: sleeping,
      servedMs,
      connectedMs,
      daemonWorkers: rows.length,
      awakeWorkers: rows.filter(w => w.awake).length,
      sparesWoken: spareRows.filter(w => w.awake).length,
      sparesUncheckpointed: spareRows.filter(uncheckpointed).length,
      resident: workerRss(root),
      stateKiB: du(root),
    };
    await emit(row);
    return row;
  };

  try {
    // 0. Baseline: restarts with no spares.
    await untilAsleep((await workers()).map(w => w.workerId));
    const restarts0 = [];
    restarts0.push(await restart('clean', 0));
    await untilAsleep((await workers()).map(w => w.workerId));
    restarts0.push(await restart('clean', 0));
    await untilAsleep((await workers()).map(w => w.workerId));
    const kib0 = du(root);

    // 1. The first spares, one at a time: creation, sleep, disk, memory.
    const created = [];
    for (let i = 0; i < FIRST; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const made = await createSpare(i);
      const awake = workerRss(root, made.label);
      // eslint-disable-next-line no-await-in-loop
      const sleepMs = await untilAsleep([made.workerId]);
      const asleep = workerRss(root, made.label);
      const { maker: _maker, ...rest } = made;
      const row = {
        ...rest,
        awakeRssKiB: awake.rssKiB,
        awakeProcesses: awake.workers,
        sleptAfterMs: sleepMs,
        asleepProcesses: asleep.workers,
      };
      created.push(row);
      // eslint-disable-next-line no-await-in-loop
      await emit({ ...base, metric: 's6.create', ...row });
    }
    const kibFirst = du(root);
    const diskPerSpareKiB = Math.round((kibFirst - kib0) / FIRST);
    await perfStats(
      'vat.spareCreate',
      created.map(c => c.totalMs),
      {
        extra: {
          programChars: source.length,
          messagesPerCreate: created[0]?.messages,
          createWorker: summarize(created.map(c => c.createWorkerMs)),
          load: summarize(created.map(c => c.loadMs)),
          evaluatingCrank: summarize(created.map(c => c.evalMs)),
          awakeRssKiB: summarize(created.map(c => c.awakeRssKiB)),
          diskPerSpareKiB,
          stateKiB: kibFirst,
        },
      },
    );

    // 2. Take them while asleep (no restart in between).
    const takes = [];
    for (let i = 0; i < FIRST; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const taken = await take(i, 'asleep');
      takes.push(taken);
      // eslint-disable-next-line no-await-in-loop
      await emit({ ...base, metric: 's6.take', ...taken });
    }
    const takeRow = await perfStats(
      'vat.spareTake',
      takes.map(x => x.takeMs),
      {
        budget: { median: 500 },
        extra: {
          phase: 'asleep, same daemon run',
          awakeCall: summarize(takes.map(x => x.awakeCallMs)),
          allWereAsleep: takes.every(x => x.wasAwake === false),
        },
      },
    );
    found.takeBudget = takeRow.pass === true;
    found.takesAsleep = takes.every(x => x.wasAwake === false);

    // 3. Restarts with COUNTS sleeping vats each.
    /** @type {any[]} */
    const restartRows = [...restarts0];
    /** @type {any[]} */
    const afterRestartTakes = [];
    for (const count of COUNTS) {
      if (spares.length < count) {
        // eslint-disable-next-line no-await-in-loop
        const many = await createMany(spares.length, count);
        // eslint-disable-next-line no-await-in-loop
        await emit({
          ...base,
          metric: 's6.createMany',
          upTo: count,
          parallel: PARALLEL,
          ...many,
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await untilAsleep((await workers()).map(w => w.workerId));
      const kib = du(root);
      // eslint-disable-next-line no-await-in-loop
      await emit({
        ...base,
        metric: 's6.disk',
        sleepingSpares: spares.length,
        stateKiB: kib,
        perSpareKiB: Math.round((kib - kib0) / spares.length),
        ...workerRss(root),
      });
      for (const how of /** @type {const} */ (['clean', 'clean', 'sigkill'])) {
        // eslint-disable-next-line no-await-in-loop
        restartRows.push(await restart(how, spares.length));
        // eslint-disable-next-line no-await-in-loop
        await untilAsleep((await workers()).map(w => w.workerId));
      }
      // Takes after the restart (the spare slept through it).
      const untaken = spares.filter(s => !s.taken).slice(0, 3);
      for (const spare of untaken) {
        // eslint-disable-next-line no-await-in-loop
        const taken = await take(spare.index, `afterRestart${count}`);
        afterRestartTakes.push(taken);
        // eslint-disable-next-line no-await-in-loop
        await emit({ ...base, metric: 's6.take', ...taken });
      }
    }
    if (afterRestartTakes.length) {
      await perfStats(
        'vat.spareTake.afterRestart',
        afterRestartTakes.map(x => x.takeMs),
        {
          budget: { median: 500 },
          extra: {
            awakeCall: summarize(afterRestartTakes.map(x => x.awakeCallMs)),
            allWereAsleep: afterRestartTakes.every(x => x.wasAwake === false),
          },
        },
      );
    }
    await emit({
      ...base,
      metric: 's6.restart.summary',
      rows: restartRows.map(r => ({
        how: r.metric.slice('s6.restart.'.length),
        sleeping: r.sleepingSpares,
        servedMs: r.servedMs,
        connectedMs: r.connectedMs,
        woken: r.sparesWoken,
        awake: r.awakeWorkers,
      })),
    });
    found.noSpareWoken = restartRows.every(r => r.sparesWoken === 0);
  } catch (error) {
    await emit({
      ...base,
      metric: 's6.error',
      error: String(/** @type {Error} */ (error)?.stack ?? error).slice(
        0,
        3000,
      ),
      stderr: host.stderrTail().slice(-2000),
    });
    throw error;
  } finally {
    await host.cleanup();
  }
  t.true(found.takesAsleep, 'each spare was asleep when taken');
  t.true(found.noSpareWoken, 'startup woke no sleeping spare');
  t.true(found.takeBudget, 'vat.spareTake within budget');
});

if (!spikesEnabled) {
  test('S6 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
