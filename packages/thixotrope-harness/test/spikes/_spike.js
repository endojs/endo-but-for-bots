// @ts-check
/**
 * Shared machinery for the M0 spikes (milestones.md W0.5-W0.7): a real
 * Ironhorse supervisor in throwaway state under `tmp/`, a probe vat program,
 * fresh probe vats, halt detection, and JSON-line output.
 *
 * Spikes are measurement programs, not unit tests: they run only when
 * THIX_HARNESS_SPIKES=1 and take the run lock (scripts/run-lock.mjs) for
 * their whole duration. Every row is one JSON line on stdout and, when
 * SPIKE_OUT is set, appended to that file.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { E, Far } from '@endo/far';

import { acquireRunLock } from '../../scripts/run-lock.mjs';
import { serveHarness } from '../../scripts/serve.mjs';
import { harnessRoot, loadAvg, runIdentity } from '../../perf/_harness.mjs';

export { E, Far };

export const spikesEnabled = process.env.THIX_HARNESS_SPIKES === '1';

/** The text the hub breaks every pending answer with when a vat halts. */
export const RETIRED = 'the target session has been retired';

/**
 * The probe vat program (evaluated as an application vat; `Far`, `E` and
 * `harden` are vat globals). Kept small so installs are cheap.
 */
export const PROBE_PROGRAM = `({ make: () => {
  let sink;
  let staged = [];
  let gen;
  let fromAsync;
  let resolveGate;
  return Far('Probe', {
    ping: () => 1,
    len: s => s.length,
    lenAll: list => { let n = 0; for (const s of list) n += s.length; return n; },
    out: n => 'x'.repeat(n),
    outMany: (k, n) => { const s = 'y'.repeat(n); const out = []; for (let i = 0; i < k; i += 1) out.push(s); return out; },
    setSink: s => { sink = s; return true; },
    pushMany: (k, n) => { const s = 'z'.repeat(n); for (let i = 0; i < k; i += 1) E.sendOnly(sink).take(i, s); return k; },
    sendOnly: n => { for (let i = 0; i < n; i += 1) E.sendOnly(sink).event(i); return n; },
    sendAnswered: n => { for (let i = 0; i < n; i += 1) E(sink).event(i); return n; },
    spin: () => { for (;;) { /* runaway */ } },
    fill: () => { const o = {}; let i = 0; try { for (;; i += 1) o['fill' + i] = 1; } catch (e) { return i + '|' + e.message; } },
    loop: n => { let x = 0; for (let i = 0; i < n; i += 1) x = (x + i) % 1000003; return x; },
    hasCompartment: () => typeof Compartment,
    evalProgram: src => { const c = new Compartment(); return c.evaluate(src); },
    stage: chunk => { staged.push(chunk); return staged.length; },
    stagedLength: () => staged.reduce((n, s) => n + s.length, 0),
    evalStaged: () => { const src = staged.join(''); staged = []; const c = new Compartment(); return c.evaluate(src); },
    genStart: () => {
      gen = (async function* counter() {
        let i = 0;
        for (;;) {
          const step = yield i;
          i += step === undefined ? 1 : step;
        }
      })();
      return gen.next().then(r => r.value);
    },
    genNext: step => gen.next(step).then(r => r.value),
    fromAsyncStart: () => {
      const gate = new Promise(resolve => { resolveGate = resolve; });
      fromAsync = Array.fromAsync((async function* items() {
        yield 1;
        yield await gate;
        yield 3;
      })());
      return true;
    },
    fromAsyncRelease: v => { resolveGate(v); return true; },
    fromAsyncResult: () => fromAsync.then(list => list.join(',')),
  });
} })`;

/**
 * Give a probe vat the history of a used session vat (QC finding 2): stage
 * and evaluate a `programChars` program in `frameBytes` chunks, then fill
 * the vat's property-key table with fresh names up to the engine's reserve
 * (the guest catches the RangeError). Returns what it did.
 * @param {any} vat
 * @param {object} options
 * @param {number} options.frameBytes
 * @param {number} [options.programChars]
 */
export const giveHistory = async (
  vat,
  { frameBytes, programChars = 250_000 },
) => {
  const t0 = performance.now();
  // eslint-disable-next-line no-use-before-define
  const { source, functions } = makeProgram(programChars);
  for (let offset = 0; offset < source.length; offset += frameBytes) {
    // eslint-disable-next-line no-await-in-loop
    await E(vat).stage(source.slice(offset, offset + frameBytes));
  }
  const evaluated = await E(vat).evalStaged();
  if (evaluated !== functions) throw Error(`program evaluated to ${evaluated}`);
  const [names, why] = String(await E(vat).fill()).split('|');
  return {
    historyProgramChars: source.length,
    historyNames: Number(names),
    historyFill: why,
    historyMs: round1(performance.now() - t0),
  };
};

/**
 * @param {Record<string, unknown>} row
 * @returns {Promise<Record<string, any>>}
 */
export const emit = async row => {
  const full = {
    ...row,
    ...(await runIdentity()),
    loadAvg: loadAvg(),
    at: new Date().toISOString(),
  };
  const line = `${JSON.stringify(full)}\n`;
  process.stdout.write(line);
  if (process.env.SPIKE_OUT) appendFileSync(process.env.SPIKE_OUT, line);
  return full;
};

/** @param {number} ms */
export const round1 = ms => +ms.toFixed(1);

/**
 * Take the run lock for the spike file; release in `after.always`.
 * @param {string} label
 */
export const takeRunLock = label =>
  acquireRunLock({
    label,
    onEvent: event =>
      process.stderr.write(`run-lock: ${JSON.stringify(event)}\n`),
  });

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error(`timeout after ${ms} ms`)), ms).unref(),
    ),
  ]);

/**
 * Run one call and classify it. `halted` means the vat is gone (the hub
 * broke the answer with the retired text, or the vat no longer answers a
 * ping); `threw` means the vat answered with an exception and still lives.
 * @param {() => Promise<any>} fn
 * @param {{ timeoutMs?: number }} [options]
 */
export const attempt = async (fn, { timeoutMs = 180_000 } = {}) => {
  const t0 = performance.now();
  try {
    const value = await within(fn(), timeoutMs);
    return { ok: true, ms: round1(performance.now() - t0), value };
  } catch (error) {
    const message = String(
      /** @type {Error} */ (error)?.message ?? error,
    ).slice(0, 200);
    return { ok: false, ms: round1(performance.now() - t0), error: message };
  }
};

/**
 * A supervisor serving throwaway state at one crank budget, with a
 * workspace and fresh probe vats.
 * @param {object} options
 * @param {bigint} options.crankBudget
 * @param {string} options.tag short state-directory prefix (Unix socket path limit)
 * @param {number} [options.idleSleepMs]
 */
export const startHost = async ({
  crankBudget,
  tag,
  idleSleepMs = 3_600_000,
}) => {
  const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
    import('@endo/thixotrope/local-control.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  const powers = makeNodePowers();
  const root = path.join(harnessRoot, 'tmp', `${tag}${process.pid % 100_000}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const serve = () =>
    serveHarness({ statePath: root, crankBudget, idleSleepMs });
  const t0 = performance.now();
  let served = await serve();
  const socket = path.join(root, 'control.sock');
  const admin = await connectLocalControl(powers, socket);
  await admin.call('createWorkspace', 'w');
  admin.close();
  let client = await connectLocalControl(powers, socket, { workspace: 'w' });
  const startMs = round1(performance.now() - t0);
  /** @returns {Promise<any[]>} */
  const workers = async () => (await client.call('status')).workers;
  let count = 0;
  /** @type {Set<string>} */
  const installed = new Set();

  /**
   * Install a fresh probe vat, warm it with one ping.
   * @param {string} [program]
   */
  const fresh = async (program = PROBE_PROGRAM) => {
    count += 1;
    const name = `p${count}`;
    const before = new Set((await workers()).map(w => w.workerId));
    const t1 = performance.now();
    await client.call('install', name, program, []);
    const installMs = round1(performance.now() - t1);
    installed.add(name);
    const workerId = (await workers())
      .map(w => w.workerId)
      .find(id => !before.has(id));
    const vat = await client.call('lookup', name);
    await E(vat).ping();
    return { name, vat, workerId, installMs };
  };

  /**
   * Ping floor of a live vat (median of n).
   * @param {any} vat
   * @param {number} [n]
   */
  const floor = async (vat, n = 3) => {
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      const t1 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(vat).ping();
      samples.push(performance.now() - t1);
    }
    samples.sort((a, b) => a - b);
    return round1(samples[Math.floor(samples.length / 2)]);
  };

  /**
   * After a failed call: does the vat still answer, and what does the
   * daemon record about its worker?
   * @param {{ vat: any, workerId?: string }} probe
   */
  const diagnose = async ({ vat, workerId }) => {
    const ping = await attempt(() => E(vat).ping(), { timeoutMs: 20_000 });
    const meta = (await workers()).find(w => w.workerId === workerId);
    /** @type {Record<string, unknown>} */
    const kept = {};
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (!['workerId', 'startNotice', 'journalLength'].includes(key))
        kept[key] = value;
    }
    return {
      alive: ping.ok,
      ...(ping.ok ? {} : { pingError: ping.error }),
      worker: JSON.stringify(kept).slice(0, 300),
    };
  };

  /** @param {string} name */
  const retire = async name => {
    if (!installed.has(name)) return;
    installed.delete(name);
    await client.call('remove', name).catch(() => {});
  };

  const restart = async () => {
    const t1 = performance.now();
    client.close();
    await served.close();
    const closeMs = round1(performance.now() - t1);
    const t2 = performance.now();
    served = await serve();
    client = await connectLocalControl(powers, socket, { workspace: 'w' });
    return { closeMs, serveMs: round1(performance.now() - t2) };
  };

  return {
    root,
    startMs,
    get client() {
      return client;
    },
    fresh,
    floor,
    diagnose,
    retire,
    restart,
    workers,
    close: async () => {
      client.close();
      await served.close();
      if (!process.env.KEEP_STATE)
        await rm(root, { recursive: true, force: true });
    },
  };
};

/** @typedef {Awaited<ReturnType<typeof startHost>>} Host */

/**
 * A Node-side sink for vat sends: counts events and bytes, resolves when a
 * target count is reached.
 */
export const makeSink = () => {
  let events = 0;
  let bytes = 0;
  /** @type {{ target: number, resolve: () => void } | undefined} */
  let waiter;
  const check = () => {
    if (waiter && events >= waiter.target) {
      waiter.resolve();
      waiter = undefined;
    }
  };
  const sink = Far('Sink', {
    /** @param {number} _i */
    event: _i => {
      events += 1;
      check();
      return true;
    },
    /**
     * @param {number} _i @param {string} s
     * @param s
     */
    take: (_i, s) => {
      events += 1;
      bytes += s.length;
      check();
    },
  });
  return {
    sink,
    reset: () => {
      events = 0;
      bytes = 0;
    },
    get events() {
      return events;
    },
    get bytes() {
      return bytes;
    },
    /** @param {number} target */
    until: target =>
      new Promise(resolve => {
        waiter = { target, resolve: () => resolve(undefined) };
        check();
      }),
  };
};

/**
 * A plain program of about `bytes` ASCII characters: many small functions,
 * then a completion value (the number of functions).
 * @param {number} bytes
 */
export const makeProgram = bytes => {
  const head = '(() => {\n  const fns = [];\n';
  const tail = '  return fns.length;\n})()\n';
  const lines = [head];
  let length = head.length + tail.length;
  let i = 0;
  for (;;) {
    const line = `  fns.push((a, b) => { const v${i} = a * ${i % 97} + b; return v${i} % 7 === 3 ? 'three' : v${i}; });\n`;
    if (length + line.length > bytes) break;
    lines.push(line);
    length += line.length;
    i += 1;
  }
  lines.push(tail);
  return { source: lines.join(''), functions: i };
};
