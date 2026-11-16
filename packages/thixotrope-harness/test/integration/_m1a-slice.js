// @ts-check
/**
 * Helpers shared by the M1a slice integration tests and perf checks
 * (W1a.7): the m1a state template with the real session program, a client
 * view of one served state (factory, preset, Composer, Live, backends with
 * an event log), live subscriptions, the scripted provider's log, and the
 * per-vat journal counts from `status()`.
 *
 * Everything is reached through public objects: the control client's
 * `lookup` of `agentHostAdmin` and `harness`, then methods.
 *
 * The importer must have installed the guest prelude first
 * (`test/unit/_m1a-prelude.js`, or `installGuestPrelude()`).
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { E } from '@endo/far';

import { m1aTemplateOptions, names } from '../../scripts/provision-steps.js';
import { ensureTemplate } from '../template/index.js';

/** @param {number} ms */
export const round1 = ms => +ms.toFixed(1);

/**
 * The m1a state template: provisioned with the real session program
 * (`guest/session/main.js`); its id follows the provisioned code.
 * @param {{ rebuild?: boolean, onStep?: (report: any) => void }} [options]
 */
export const sliceTemplate = async ({ rebuild = false, onStep } = {}) =>
  ensureTemplate({ ...(await m1aTemplateOptions({ onStep })), rebuild });

/** A request id in the A.4 format: 13 digits of ms, a dash, a UUID. */
export const requestId = () => `${Date.now()}-${randomUUID()}`;

/**
 * Wait until `predicate` returns a truthy value; return it, or throw after
 * `ms`.
 * @template T
 * @param {() => Promise<T> | T} predicate
 * @param {number} ms
 * @param {string} what
 * @param {number} [everyMs]
 * @returns {Promise<NonNullable<T>>}
 */
export const waitFor = async (predicate, ms, what, everyMs = 50) => {
  const t0 = performance.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await predicate();
    if (value) return /** @type {NonNullable<T>} */ (value);
    if (performance.now() - t0 > ms)
      throw Error(`timed out after ${ms} ms waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await delay(everyMs);
  }
};

/**
 * Lines of a scripted backend's event log (section 10).
 * @param {string} logPath
 * @returns {any[]}
 */
export const readLog = logPath => {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
};

/**
 * A live subscription read in the background: every delivery is kept with
 * its arrival time (Date.now(), comparable with the adapter's log times).
 * @param {any} subscription a LiveSubscription presence
 */
export const collect = subscription => {
  /** @type {{ seq: number, rev: number, event: any, arrivedAt: number }[]} */
  const deliveries = [];
  let closed = false;
  /** @type {unknown} */
  let failure;
  let stopped = false;
  const done = (async () => {
    while (!stopped && !closed) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const batch = await E(subscription).next();
        const arrivedAt = Date.now();
        for (const d of batch.deliveries) deliveries.push({ ...d, arrivedAt });
        if (batch.closed) closed = true;
      } catch (error) {
        failure = error;
        return;
      }
    }
  })();
  return {
    deliveries,
    events: () => deliveries.map(d => d.event),
    failure: () => failure,
    /**
     * Wait until a delivery matches; return its index.
     * @param {(event: any) => boolean} match
     * @param {number} [ms]
     * @param {number} [from] index to start looking at
     */
    until: async (match, ms = 30_000, from = 0) =>
      waitFor(
        () => {
          if (failure) throw failure;
          const i = deliveries.findIndex((d, k) => k >= from && match(d.event));
          return i >= 0 ? i + 1 : 0;
        },
        ms,
        'a live event',
        10,
      ).then(i => i - 1),
    stop: async () => {
      stopped = true;
      await E(subscription)
        .close()
        .catch(() => {});
      await Promise.race([done, delay(2000)]);
    },
  };
};

/**
 * The client view of one served m1a state (from the state template).
 * Presences die with the control client that holds them, so call
 * `refresh()` after a restart (the state's client is replaced).
 * @param {{ client: any, root: string }} state
 */
export const makeSlice = async state => {
  let backendCount = 0;
  const self = {
    /** @type {any} */ admin: undefined,
    /** @type {any} */ harness: undefined,
    /** @type {any} */ factory: undefined,
    /** @type {any} */ chatOnly: undefined,
    /** @type {any} */ composer: undefined,
    /** @type {any} */ live: undefined,
    refresh: async () => {
      const { client } = state;
      self.admin = await client.call('lookup', names.agentHost);
      self.harness = await client.call('lookup', names.harness);
      const operator = await E(self.harness).getOperator();
      self.factory = await E(operator).getFactory();
      [self.chatOnly] = await E(self.factory).listPresets();
      self.composer = await E(self.admin).composer();
      self.live = await E(self.admin).live();
      return self;
    },
    /**
     * A scripted backend with its own event log in the state directory.
     * @param {any} script
     * @param {{ label?: string }} [options]
     */
    makeBackend: async (script, { label = 'Scripted' } = {}) => {
      backendCount += 1;
      const logPath = path.join(state.root, `scripted-${backendCount}.log`);
      const backend = await E(self.admin).makeBackend(
        harden({ kind: 'scripted', label, script, logPath }),
      );
      return { backend, logPath, log: () => readLog(logPath) };
    },
    /**
     * The caller has the clock (`CreateOptions.at`, J-9150): the session's
     * `createdAt` is this process's `Date.now()` at the call.
     * @param {any} backend
     * @param {string} [title]
     */
    createSession: (backend, title = 't') =>
      E(self.factory).createSession(
        harden({ title, preset: self.chatOnly, backend, at: Date.now() }),
      ),
    /**
     * Submit through the Composer.
     * @param {any} session
     * @param {string} text
     * @param {string} [id]
     */
    submit: (session, text, id = requestId()) =>
      E(self.composer).submit(session, text, id),
    /**
     * `watch()` then `subscribe(session, rev)`, collected in the background.
     * @param {any} session
     */
    subscribe: async session => {
      const { rev } = await E(session).watch();
      return collect(await E(self.live).subscribe(session, rev));
    },
    /** @returns {Promise<any[]>} the daemon's worker rows */
    workers: async () => (await state.client.call('status')).workers,
    /**
     * The status row of a session vat (`createWorker('session s<n>')`).
     * @param {string} key
     */
    sessionWorker: async key =>
      (await self.workers()).find(w => w.debugLabel === `session ${key}`),
  };
  return self.refresh();
};

/**
 * Records of one turn in a history page (newest turn first).
 * @param {any} page
 * @param {string} input
 */
export const turnWithInput = (page, input) =>
  page.turns.find(
    (/** @type {any} */ tp) =>
      tp.records[0]?.kind === 'turn-started' && tp.records[0].input === input,
  );

const run = promisify(execFile);

/**
 * Pids of processes whose command line contains `needle`.
 * @param {string} needle
 */
const pidsNaming = async needle => {
  const { stdout } = await run('ps', ['-axo', 'pid=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(needle))
    .map(line => Number(line.slice(0, line.indexOf(' '))));
};

/**
 * The worker incarnations of one vat, as `perf/crash.perf.mjs` finds them:
 * `heaps/incarnations/vat-<slug of the debug label>-`.
 * @param {string} root
 * @param {string} debugLabel e.g. 'session s1'
 */
export const incarnationNeedle = (root, debugLabel) =>
  `${root}/heaps/incarnations/vat-${debugLabel.replace(/[^A-Za-z0-9._-]+/g, '-')}-`;

/**
 * SIGKILL every process naming `needle` as soon as it appears (the killer
 * of `perf/crash.perf.mjs`), until stopped.
 * @param {string} needle
 * @param {number} t0 performance.now() the kill times are relative to
 * @param {number} [pollMs]
 */
export const startKiller = (needle, t0, pollMs = 20) => {
  /** @type {{ pid: number, ms: number }[]} */
  const kills = [];
  const seen = new Set();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      // eslint-disable-next-line no-await-in-loop
      const pids = await pidsNaming(needle).catch(() => []);
      for (const pid of pids) {
        if (!seen.has(pid)) {
          seen.add(pid);
          try {
            process.kill(pid, 'SIGKILL');
            kills.push({ pid, ms: round1(performance.now() - t0) });
          } catch {
            // Gone already.
          }
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  })();
  return {
    kills,
    stop: async () => {
      stopped = true;
      await done;
    },
  };
};

/**
 * Wait until the listed vats are asleep with nothing unsnapshotted.
 * @param {() => Promise<any[]>} workers
 * @param {(row: any) => boolean} which
 * @param {number} [ms]
 */
export const untilAsleep = (workers, which, ms = 120_000) =>
  waitFor(
    async () => {
      const rows = (await workers()).filter(which);
      return (
        rows.length > 0 &&
        rows.every(
          w =>
            !w.awake && Number(w.snapshot?.cut ?? 0) >= Number(w.journalLength),
        )
      );
    },
    ms,
    'vats asleep and checkpointed',
    250,
  );

/** @param {any} row a worker status row */
export const unsnapshotted = row =>
  Number(row?.snapshot?.cut ?? 0) < Number(row?.journalLength ?? 0);

/**
 * The OCapN operation of a worker journal line (`{ b64 }`): `deliver` with
 * its method (or `fulfill` for an answer), or a GC or other operation.
 * @param {string} line
 */
export const frameKind = line => {
  const { b64 } = JSON.parse(line);
  const text = Buffer.from(b64, 'base64')
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '.');
  const op = /op:([a-z-]+)/.exec(text)?.[1] ?? '?';
  if (op !== 'deliver') return op;
  const method = /\d+'desc.*?\d+'([A-Za-z]+)/.exec(text)?.[1] ?? '?';
  return `deliver ${method}`;
};

/**
 * Kinds of the last `n` frames of a worker's journal (fewer when a
 * snapshot truncated the journal meanwhile).
 * @param {string} root the state directory
 * @param {string} workerId
 * @param {number} n
 */
export const journalTail = (root, workerId, n) => {
  if (n <= 0) return [];
  const lines = readFileSync(
    path.join(root, 'workers', workerId, 'journal.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n');
  // The first line is the file's header ({ base }).
  return lines.slice(1).slice(-n).map(frameKind);
};
