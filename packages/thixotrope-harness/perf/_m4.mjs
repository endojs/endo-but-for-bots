// @ts-check
/**
 * Shared setup of M4's perf checks (W4.8; `designs/m4-interfaces.md` 18):
 * a served copy of the `m4` state template (`test/integration/_m4.js`), the
 * Secrets key file under H/tmp, the fake subscription server answering at a
 * fixed 20 ms, per-vat frame counts from `status()` (the manager vat found
 * by the frames a manager-only call adds), and a fixed-window loop.
 *
 * Every check measures over a fixed window (default 60 s, `M4_WINDOW_MS`)
 * and reports per-operation figures with the number of samples it held.
 */
import '../test/unit/_m1a-prelude.js';

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { E } from '@endo/far';

import { harnessRoot } from './_harness.mjs';
import { windowMs } from './_window.mjs';
import { m4Template, m4View } from '../test/integration/_m4.js';
import { frameKind } from '../test/integration/_m1a-slice.js';
import { startFakeSubscriptionServer } from '../test/fixtures/fake-subscription-server.mjs';

/**
 * The core's `GC_FRAMES_PER_CRANK` (`durable-worker-transport.js`, not
 * exported by the package): a run of journaled GC frames rides with the next
 * ordinary frame, or is a crank of its own at this length.
 */
const GC_FRAMES_PER_CRANK = 64;

/** Servers this process started (closed by `closeServers`). */
/** @type {Array<{ close: () => Promise<void> }>} */
const servers = [];

/** Close every fake server this process started, so it can exit. */
export const closeServers = async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
};

/** The measured window of one point. */
export const WINDOW_MS = windowMs('M4_WINDOW_MS', 60_000);

/** The fake servers' fixed answer time (section 18). */
export const FAKE_MS = 20;

/**
 * Run `step` repeatedly until `ms` have passed; the samples it returns.
 * @template T
 * @param {() => Promise<T>} step
 * @param {number} [ms]
 * @returns {Promise<{ samples: T[], elapsedMs: number }>}
 */
export const inWindow = async (step, ms = WINDOW_MS) => {
  /** @type {T[]} */
  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // eslint-disable-next-line no-await-in-loop
    samples.push(await step());
  }
  return { samples, elapsedMs: performance.now() - t0 };
};

/**
 * A Secrets key file under H/tmp for one served state: pass `file` to
 * `startPerfM4` (it reaches that supervisor only, never this process's
 * environment); `remove()` deletes it.
 * @param {string} tag
 */
export const testKeyFile = tag => {
  const dir = path.join(harnessRoot, 'tmp', `w48-${tag}-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    file: path.join(dir, 'secrets.key'),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/**
 * Serve a copy of the `m4` template through the perf harness and take the
 * M4 view of it; a fake subscription server answering every route at
 * `FAKE_MS`.
 * @param {(options?: any) => Promise<any>} provision the `runPerf` tool
 * @param {{ secretsKeyFile: string, credentialTag?: (value: string) => string | undefined }} options
 *   `secretsKeyFile` from `testKeyFile`
 */
export const startPerfM4 = async (
  provision,
  { secretsKeyFile, credentialTag },
) => {
  const template = await m4Template();
  const run = await provision({ template: template.dir, secretsKeyFile });
  const m4 = await m4View(run);
  const server = await startFakeSubscriptionServer({
    ...(credentialTag === undefined ? {} : { credentialTag }),
    defaults: {
      'GET /v1/models': {
        file: 'claude-models.json',
        firstByteDelayMs: FAKE_MS,
      },
      'GET /backend-api/codex/models': {
        file: 'codex-models.json',
        firstByteDelayMs: FAKE_MS,
      },
      'GET /api/oauth/usage': {
        file: 'claude-usage.json',
        firstByteDelayMs: FAKE_MS,
      },
      'GET /backend-api/wham/usage': {
        file: 'codex-usage.json',
        firstByteDelayMs: FAKE_MS,
      },
      'POST /v1/messages': {
        sse: 'claude-text.sse',
        firstByteDelayMs: FAKE_MS,
      },
      'POST /backend-api/codex/responses': {
        sse: 'codex-text.sse',
        firstByteDelayMs: FAKE_MS,
      },
    },
  });
  servers.push(server);
  return { run, m4, server, templateKey: template.key };
};

/**
 * Frame counters per vat (journal length from `status()`; a snapshot that
 * cuts the journal makes a delta negative, which callers drop).
 * @param {any} m4 the M4 view
 */
export const makeFrameCounter = async m4 => {
  /** @returns {Promise<Map<string, number>>} */
  const lengths = async () =>
    new Map(
      (await m4.slice.workers()).map((/** @type {any} */ w) => [
        String(w.debugLabel ?? w.workerId),
        Number(w.journalLength ?? 0),
      ]),
    );
  // The manager vat: the one whose journal grows by a manager-only call.
  const before = await lengths();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(m4.subs).listPools();
  }
  const after = await lengths();
  const grown = [...after].filter(
    ([label, n]) => n - (before.get(label) ?? 0) >= 3,
  );
  if (grown.length !== 1)
    throw Error(`cannot tell the manager vat: ${JSON.stringify(grown)}`);
  const [[manager]] = grown;
  const managerRow = (await m4.slice.workers()).find(
    (/** @type {any} */ w) => String(w.debugLabel ?? w.workerId) === manager,
  );
  return {
    manager,
    /** The manager vat's worker id (its journal's directory). */
    managerWorkerId: String(managerRow?.workerId),
    /** @param {string} [label] default the manager vat */
    frames: async (label = manager) => (await lengths()).get(label) ?? 0,
  };
};

/**
 * The frames a worker's journal holds between two delivery frontiers, by
 * kind (`frameKind`: `deliver <method>`, `fulfill`, `gc-answers`, ...), and
 * the cranks they were delivered in: a run of GC frames goes with the next
 * ordinary frame (the core's `journalCranks`), so the cranks are the
 * ordinary frames plus any GC run that reached `GC_FRAMES_PER_CRANK` alone.
 * A snapshot that cut the journal inside the range leaves the frames before
 * the cut unread (`unread`).
 * @param {string} root the state directory
 * @param {string} workerId
 * @param {number} from journal frontier before
 * @param {number} to journal frontier after
 */
export const journalFrames = (root, workerId, from, to) => {
  const lines = readFileSync(
    path.join(root, 'workers', workerId, 'journal.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n');
  const base = Number(JSON.parse(lines[0]).base ?? 0);
  const entries = lines.slice(1).map(line => JSON.parse(line));
  const start = Math.max(from, base);
  const picked = entries.slice(start - base, to - base);
  /** @type {Record<string, number>} */
  const byKind = {};
  let gcFrames = 0;
  let cranks = 0;
  let gcRun = 0;
  for (const entry of picked) {
    const kind = frameKind(JSON.stringify({ b64: entry.b64 }));
    const name = entry.gc === true ? `gc ${kind}` : kind;
    byKind[name] = (byKind[name] ?? 0) + 1;
    if (entry.gc === true) {
      gcFrames += 1;
      gcRun += 1;
      if (gcRun === GC_FRAMES_PER_CRANK) {
        cranks += 1;
        gcRun = 0;
      }
    } else {
      cranks += 1;
      gcRun = 0;
    }
  }
  return harden({
    frames: picked.length,
    gcFrames,
    cranks,
    byKind,
    unread: start - from,
  });
};
