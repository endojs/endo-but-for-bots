// @ts-check
// Throwaway harness baseline for Thixotrope (survey phase; not committed).
// Run from packages/thixotrope with the Ironhorse worker and bundles built:
//   node tmp/harness-perf/baseline.mjs [phases...]
// Phases: start ping append heap text push restart (default: all, in order).
// Output: one JSON object per line on stdout ({"metric", "unit", ...}).
import '@endo/init';
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../../src/control/local-control.js';
import { serveThixotrope } from '../../src/control/supervisor.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// Unix socket paths are limited to 103 bytes: keep the state path short.
const root = join(here, '..', `hp${process.pid}`);
const phases = new Set(
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['start', 'ping', 'append', 'push', 'heap', 'restart', 'text'],
);
const PING_N = Number(process.env.PING_N ?? 300);
const SNAP = Number(process.env.SNAP_EVERY ?? 256);
const HEAP_MB = Number(process.env.HEAP_MB ?? 20);

const powers = makeNodePowers();
const emit = row => console.log(JSON.stringify(row));
const stats = (metric, samples, extra = {}) => {
  const s = [...samples].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  emit({
    metric,
    unit: 'ms',
    n: s.length,
    median: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    p99: +q(0.99).toFixed(3),
    min: +s[0].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    ...extra,
  });
};
const timed = async (metric, fn, extra = {}) => {
  const t = performance.now();
  const value = await fn();
  emit({
    metric,
    unit: 'ms',
    value: +(performance.now() - t).toFixed(3),
    ...extra,
  });
  return value;
};
const du = () =>
  Number(execFileSync('du', ['-sk', root]).toString().split('\t')[0]);
const duTree = () =>
  Object.fromEntries(
    execFileSync('sh', [
      '-c',
      `du -sk "${root}"/* "${root}"/heaps/* 2>/dev/null | sort -rn | head -8`,
    ])
      .toString()
      .trim()
      .split('\n')
      .map(line => line.split('\t'))
      .map(([k, path]) => [path.slice(root.length + 1), Number(k)]),
  );
const workerRss = () => {
  try {
    const out = execFileSync('ps', ['-axo', 'rss=,comm=']).toString();
    const rows = out
      .split('\n')
      .filter(line => line.includes(`${root}/runtime/`))
      .map(line => Number(line.trim().split(/\s+/)[0]));
    return { workers: rows.length, rssKiB: rows.reduce((a, b) => a + b, 0) };
  } catch {
    return {};
  }
};

const FACTORY = `({ make: () => {
  const records = [];
  const big = [];
  const listeners = [];
  const bench = Far('Bench', {
    ping: () => 1,
    echo: s => s.length,
    append: r => { records.push(r); return records.length; },
    appendMany: n => {
      for (let i = 0; i < n; i += 1)
        records.push(harden({ i: records.length, kind: 'text', text: 'record ' + i }));
      return records.length;
    },
    count: () => records.length,
    grow: (count, size) => {
      for (let i = 0; i < count; i += 1) {
        const piece = String(big.length).padStart(8, '0');
        big.push(piece.repeat(size / 8));
      }
      return big.length;
    },
    bigChars: () => big.reduce((a, s) => a + s.length, 0),
    subscribe: l => { listeners.push(l); return listeners.length; },
    unsubscribeAll: () => { listeners.length = 0; },
    emit: (n, sendOnly) => {
      for (let i = 0; i < n; i += 1)
        for (const l of listeners)
          if (sendOnly) E.sendOnly(l).event(i); else E(l).event(i);
      return n;
    },
  });
  return bench;
} })`;
// TARGET=workspace evaluates the factory in the workspace vat (large heap:
// inventory, prelude, mail); TARGET=app installs it as its own vat.
const TARGET = process.env.TARGET ?? 'app';

const serve = () =>
  serveThixotrope(powers, root, {
    idleSleepMs: Number(process.env.IDLE_MS ?? 3_600_000),
    snapshotEveryDeliveries: SNAP,
  });

let supervisor;
let client;
const counters = async () => (await client.call('status')).timings;
const delta = (a, b) =>
  Object.fromEntries(
    Object.keys(b).map(k => [
      k,
      {
        count: b[k].count - a[k].count,
        ms: +(b[k].milliseconds - a[k].milliseconds).toFixed(1),
      },
    ]),
  );

const restart = async label => {
  const before = du();
  await timed(`${label}.close`, () => {
    client.close();
    return supervisor.close();
  });
  const t0 = performance.now();
  supervisor = await serve();
  const served = performance.now() - t0;
  client = await connectLocalControl(powers, join(root, 'control.sock'), {
    workspace: 'bench',
  });
  const bench = await client.call('lookup', 'bench');
  const count = await E(bench).count();
  const firstCall = performance.now() - t0;
  emit({
    metric: `${label}.restart`,
    unit: 'ms',
    serveMs: +served.toFixed(1),
    firstCallMs: +firstCall.toFixed(1),
    stateKiB: before,
    count,
    ...workerRss(),
  });
  return bench;
};

try {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // (a) cold start
  const t0 = performance.now();
  supervisor = await serve();
  const servedMs = performance.now() - t0;
  const admin = await connectLocalControl(powers, join(root, 'control.sock'));
  await admin.call('status');
  const statusMs = performance.now() - t0;
  const tw = performance.now();
  await admin.call('createWorkspace', 'bench');
  const createMs = performance.now() - tw;
  admin.close();
  client = await connectLocalControl(powers, join(root, 'control.sock'), {
    workspace: 'bench',
  });
  const te = performance.now();
  if (TARGET === 'app') await client.call('install', 'bench', FACTORY, []);
  else
    await client.call(
      'evaluate',
      `(inventory.set('bench', (${FACTORY}).make()), true)`,
    );
  const installMs = performance.now() - te;
  const bench0 = await client.call('lookup', 'bench');
  const tp = performance.now();
  await E(bench0).ping();
  const firstPingMs = performance.now() - tp;
  emit({
    metric: 'a.coldStart',
    target: TARGET,
    unit: 'ms',
    serveMs: +servedMs.toFixed(1),
    firstStatusMs: +statusMs.toFixed(1),
    createWorkspaceMs: +createMs.toFixed(1),
    evaluateGuestMs: +installMs.toFixed(1),
    firstPingMs: +firstPingMs.toFixed(1),
    stateKiB: du(),
    largestKiB: duTree(),
    ...workerRss(),
  });
  let bench = bench0;

  if (phases.has('ping')) {
    for (let i = 0; i < 20; i += 1) await E(bench).ping();
    const c0 = await counters();
    const samples = [];
    for (let i = 0; i < PING_N; i += 1) {
      const t = performance.now();
      await E(bench).ping();
      samples.push(performance.now() - t);
    }
    stats('b.pingRoundTrip', samples, { engine: delta(c0, await counters()) });
    const t = performance.now();
    await Promise.all(Array.from({ length: PING_N }, () => E(bench).ping()));
    emit({
      metric: 'b.pingPipelined',
      unit: 'ms',
      n: PING_N,
      value: +(performance.now() - t).toFixed(1),
    });
  }

  if (phases.has('append')) {
    const c0 = await counters();
    const samples = [];
    const tAll = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      const t = performance.now();
      await E(bench).append(harden({ i, kind: 'text', text: `record ${i}` }));
      samples.push(performance.now() - t);
    }
    const total = performance.now() - tAll;
    stats('c.append1000.perCall', samples, {
      totalMs: +total.toFixed(1),
      engine: delta(c0, await counters()),
    });
    await timed('c.appendMany1000.oneCall', () => E(bench).appendMany(1000));
    bench = await restart('c');
  }

  const pushRun = async (burst, bursts, sendOnly) => {
    const N = burst * bursts;
    let got = 0;
    let done;
    const finished = new Promise(r => (done = r));
    const listener = Far('Listener', {
      event: () => {
        got += 1;
        if (got === N) done();
      },
    });
    await E(bench).subscribe(listener);
    const c0 = await counters();
    const t = performance.now();
    for (let i = 0; i < bursts; i += 1) await E(bench).emit(burst, sendOnly);
    const accepted = performance.now() - t;
    await finished;
    const total = performance.now() - t;
    emit({
      metric: 'e.push',
      unit: 'ms',
      events: N,
      eventsPerCrank: burst,
      sendOnly,
      emitReturnedMs: +accepted.toFixed(1),
      allReceivedMs: +total.toFixed(1),
      perEventUs: +((total * 1000) / N).toFixed(1),
      eventsPerSecond: Math.round(N / (total / 1000)),
      engine: delta(c0, await counters()),
    });
    await E(bench).unsubscribeAll();
  };
  if (phases.has('push')) {
    await pushRun(100, 20, true);
    await pushRun(100, 20, false);
    await pushRun(10, 200, true);
    await pushRun(1, 300, true);
  }
  if (phases.has('pushSingle')) {
    // One crank emitting N sends; a halt quarantines the vat, so run alone.
    for (const n of [250, 500, 1000, 2000]) {
      try {
        await pushRun(n, 1, true);
      } catch (error) {
        emit({
          metric: 'e.pushSingle',
          events: n,
          ok: false,
          error: String(error?.message ?? error).slice(0, 300),
        });
        break;
      }
    }
  }

  if (phases.has('heap')) {
    // Grow ~HEAP_MB million characters in 200 KiB-character steps.
    const step = 100; // strings per call
    const size = 2000; // characters per string
    const calls = Math.round((HEAP_MB * 1_000_000) / (step * size));
    const growSamples = [];
    const pingAt = [];
    for (let c = 0; c < calls; c += 1) {
      const t = performance.now();
      await E(bench).grow(step, size);
      growSamples.push(performance.now() - t);
      if ((c + 1) % Math.max(1, Math.floor(calls / 4)) === 0) {
        const ps = [];
        for (let i = 0; i < 30; i += 1) {
          const tp = performance.now();
          await E(bench).ping();
          ps.push(performance.now() - tp);
        }
        ps.sort((a, b) => a - b);
        pingAt.push({
          chars: (c + 1) * step * size,
          pingMedianMs: +ps[15].toFixed(2),
          pingMaxMs: +ps[29].toFixed(2),
        });
      }
    }
    stats('d.grow200kChars.perCall', growSamples, {
      calls,
      chars: await E(bench).bigChars(),
    });
    emit({ metric: 'd.pingVsHeap', rows: pingAt });
    const c0 = await counters();
    const samples = [];
    for (let i = 0; i < 200; i += 1) {
      const t = performance.now();
      await E(bench).ping();
      samples.push(performance.now() - t);
    }
    stats('d.pingWithBigHeap', samples, {
      engine: delta(c0, await counters()),
      ...workerRss(),
    });
    bench = await restart('d');
    const s2 = [];
    for (let i = 0; i < 50; i += 1) {
      const t = performance.now();
      await E(bench).ping();
      s2.push(performance.now() - t);
    }
    stats('d.pingAfterRestart', s2);
  }

  if (phases.has('wake')) {
    // Needs IDLE_MS (for example 2000): idle workers sleep, then a call wakes one.
    const idle = Number(process.env.IDLE_MS ?? 0);
    for (let i = 0; i < 5; i += 1) {
      await new Promise(r => setTimeout(r, idle + 3000));
      const c0 = await counters();
      const t = performance.now();
      await E(bench).ping();
      emit({
        metric: 'h.pingAfterIdleSleep',
        unit: 'ms',
        value: +(performance.now() - t).toFixed(1),
        engine: delta(c0, await counters()),
        ...workerRss(),
      });
    }
  }

  if (phases.has('restart')) {
    // Explicit snapshot-free restart cost: ping, then restart with a short
    // journal suffix (replay) since the last snapshot.
    bench = await restart('g');
  }
  if (phases.has('text')) {
    // One string argument of N characters into the guest.
    // Runs last: a string too long halts and quarantines the vat.
    for (const n of [1_000, 2_000, 4_000, 8_000, 12_000, 15_000, 20_000]) {
      const s = 'abcdefghij'.repeat(n / 10);
      const t = performance.now();
      try {
        const len = await E(bench).echo(s);
        emit({
          metric: 'f.stringArg',
          unit: 'ms',
          chars: n,
          ok: len === n,
          value: +(performance.now() - t).toFixed(1),
        });
      } catch (error) {
        emit({
          metric: 'f.stringArg',
          unit: 'ms',
          chars: n,
          ok: false,
          error: String(error?.message ?? error).slice(0, 300),
          value: +(performance.now() - t).toFixed(1),
        });
        // A failed vat cannot continue; stop this phase.
        break;
      }
    }
  }
} finally {
  try {
    client?.close();
    await supervisor
      ?.close()
      .catch(error => emit({ metric: 'closeError', error: String(error) }));
  } finally {
    if (!process.env.KEEP_STATE)
      await rm(root, { recursive: true, force: true });
  }
}
