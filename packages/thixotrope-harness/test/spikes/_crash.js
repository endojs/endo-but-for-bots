// @ts-check
/**
 * Spike machinery for W0.6 (S2, S4, S7, S9): a real Ironhorse supervisor in
 * a child process (scripts/serve.mjs in its supervisor-child form, with the
 * allowlisted environment), so the spikes can SIGKILL it, plus the throwaway
 * native resource fixture and a vat program that uses it.
 *
 * Like _spike.js, this runs only under THIX_HARNESS_SPIKES=1 and the run lock.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import url from 'node:url';

import { allowlistEnvironment } from '../../scripts/serve.mjs';
import { harnessRoot } from '../../perf/_harness.mjs';
import { round1 } from './_spike.js';

/** The fixture resource directory (durable.js + ephemeral.js). */
export const ATTACH_FIXTURE = url.fileURLToPath(
  new URL('fixtures/attach', import.meta.url),
);

const serveScript = path.join(harnessRoot, 'scripts', 'serve.mjs');

/**
 * The spike vat program. `spk` is the fixture facet granted at install. The
 * vat keeps its endpoint, intents and outcomes in its heap (Maps, no
 * dynamic property names) and never reads a clock.
 */
export const SPIKE_PROGRAM = `({ make: ({ spk }) => {
  let ep;
  let target;
  let pending = { state: 'none' };
  const intents = new Map();
  const outcomes = new Map();
  const listenerLog = [];
  const me = Far('VatObject', { ping: () => 1 });
  const other = Far('OtherVatObject', { ping: () => 2 });
  const listener = Far('Listener', {
    bound: (key, incarnation) => { listenerLog.push(['bound', key, incarnation]); },
    hear: (incarnation, text) => { listenerLog.push(['hear', incarnation, text]); },
  });
  return Far('SpikeVat', {
    ping: () => 1,
    open: async () => { ep = await E(spk).open(); return E(ep).incarnation(); },
    endpoint: () => ep,
    me: () => me,
    callAdapter: async k => { for (let i = 0; i < k; i += 1) await E(ep).echo(i); return k; },
    startPending: () => {
      pending = { state: 'waiting' };
      E(ep).hang().then(
        () => { pending = { state: 'resolved' }; },
        e => { pending = { state: 'broken', message: String(e && e.message) }; },
      );
      return true;
    },
    pendingState: () => harden({ ...pending }),
    see: which => E(ep).see(which === 'me' ? me : other),
    seeRecord: () => E(ep).seeRecord(harden({ obj: me })),
    relay: () => E(spk).relay(me),
    seenStats: () => E(ep).seenStats(),
    act: (id, logPath) => {
      intents.set(id, true);
      E(ep).effect(id, logPath).then(
        () => { outcomes.set(id, 'ok'); },
        e => { outcomes.set(id, String(e && e.message)); },
      );
    },
    intentState: () => harden([...intents.keys()].map(id => [id, outcomes.get(id) ?? 'none'])),
    subscribe: () => E(spk).subscribe(listener),
    listenerLog: () => harden(listenerLog.map(entry => harden([...entry]))),
    setTarget: t => { target = t; return true; },
    pushMany: (k, payload) => { for (let i = 0; i < k; i += 1) E.sendOnly(target).take(i, payload); return k; },
  });
} })`;

/**
 * A supervisor in a child process over throwaway state, which a spike can
 * SIGKILL and start again over the same state.
 * @param {object} options
 * @param {bigint} options.crankBudget
 * @param {string} options.tag short state-directory prefix
 * @param {number} [options.idleSleepMs]
 */
export const startCrashHost = async ({
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
  const socket = path.join(root, 'control.sock');

  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {Promise<any> | undefined} */
  let exited;
  /** @type {any} */
  let client;
  let stderrTail = '';
  let incarnations = 0;

  const spawnServe = async () => {
    const t0 = performance.now();
    const proc = spawn(
      process.execPath,
      [
        serveScript,
        '--supervisor-child',
        root,
        `--crank-budget=${crankBudget}`,
        `--idle-sleep-ms=${idleSleepMs}`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: allowlistEnvironment(process.env, { crankBudget }),
      },
    );
    child = proc;
    exited = once(proc, 'exit');
    stderrTail = '';
    proc.stderr?.on('data', bytes => {
      stderrTail = `${stderrTail}${String(bytes)}`.slice(-8192);
    });
    let out = '';
    await Promise.race([
      new Promise(resolve => {
        proc.stdout?.on('data', bytes => {
          out = `${out}${String(bytes)}`.slice(-8192);
          if (out.includes('"serving"')) resolve(undefined);
        });
      }),
      exited.then(() => {
        throw Error(`serve exited before serving: ${stderrTail.slice(-2000)}`);
      }),
    ]);
    incarnations += 1;
    const servedMs = round1(performance.now() - t0);
    if (incarnations === 1) {
      const admin = await connectLocalControl(powers, socket);
      await admin.call('createWorkspace', 'w');
      admin.close();
    }
    client = await connectLocalControl(powers, socket, { workspace: 'w' });
    return { servedMs, connectedMs: round1(performance.now() - t0) };
  };

  const closeClient = () => {
    try {
      client?.close();
    } catch {
      // The connection is already gone.
    }
    client = undefined;
  };

  /** SIGKILL the supervisor child and wait for it to be gone. */
  const kill = async () => {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGKILL');
    await exited;
    closeClient();
  };

  /** Clean stop (SIGTERM: serve.mjs closes the supervisor). */
  const stop = async () => {
    const proc = child;
    closeClient();
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    await Promise.race([
      exited,
      delay(60_000).then(() => {
        proc.kill('SIGKILL');
        return exited;
      }),
    ]);
  };

  const first = await spawnServe();

  return {
    root,
    first,
    get client() {
      return client;
    },
    get pid() {
      return child?.pid;
    },
    get stderrTail() {
      return stderrTail;
    },
    serve: spawnServe,
    kill,
    stop,
    /** @returns {Promise<any[]>} */
    workers: async () => (await client.call('status')).workers,
    close: async () => {
      await stop().catch(() => {});
      if (!process.env.KEEP_STATE)
        await rm(root, { recursive: true, force: true });
    },
  };
};

/** @typedef {Awaited<ReturnType<typeof startCrashHost>>} CrashHost */

/**
 * The hub's persisted state file of a state directory.
 * @param {string} root
 */
export const hubJsonPath = root => path.join(root, 'hub.json');

/**
 * Effect lines the fixture adapter appended (S9), grouped by id.
 * @param {string} file
 * @returns {Promise<Map<string, string[]>>} id -> incarnations that ran it
 */
export const readEffects = async file => {
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (line) {
      const { id, incarnation } = JSON.parse(line);
      byId.set(id, [...(byId.get(id) ?? []), incarnation]);
    }
  }
  return byId;
};

/**
 * Adapter processes of the native fixture still alive (orphans after a
 * SIGKILL would show here), by command line.
 */
export const adapterProcesses = async () => {
  const proc = spawn('ps', ['-A', '-o', 'pid=,ppid=,command='], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  proc.stdout.on('data', bytes => {
    out += String(bytes);
  });
  await once(proc, 'exit');
  return out
    .split('\n')
    .filter(line => line.includes('adapter-process-entry'))
    .map(line => line.trim().split(/\s+/).slice(0, 2).map(Number));
};

/**
 * Median of numbers.
 * @param {number[]} values
 */
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};

/**
 * Summary of samples (ms).
 * @param {number[]} values
 */
export const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  /** @param {number} q */
  const at = q =>
    sorted.length === 0
      ? null
      : round1(
          sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))],
        );
  return {
    n: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length ? round1(sorted[sorted.length - 1]) : null,
    min: sorted.length ? round1(sorted[0]) : null,
  };
};
