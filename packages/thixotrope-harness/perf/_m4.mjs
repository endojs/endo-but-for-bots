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

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { E } from '@endo/far';

import { harnessRoot } from './_harness.mjs';
import { m4Template, m4View } from '../test/integration/_m4.js';
import { startFakeSubscriptionServer } from '../test/fixtures/fake-subscription-server.mjs';

/** Servers this process started (closed by `closeServers`). */
/** @type {Array<{ close: () => Promise<void> }>} */
const servers = [];

/** Close every fake server this process started, so it can exit. */
export const closeServers = async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
};

/** The measured window of one point. */
export const WINDOW_MS = Number(process.env.M4_WINDOW_MS ?? 60_000);

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
 * The Secrets key file for this process (every supervisor started after
 * this inherits it); removed by the returned function.
 * @param {string} tag
 */
export const useKeyFile = tag => {
  const dir = path.join(harnessRoot, 'tmp', `w48-${tag}-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.THIX_HARNESS_SECRETS_KEY = path.join(dir, 'secrets.key');
  return () => rmSync(dir, { recursive: true, force: true });
};

/**
 * Serve a copy of the `m4` template through the perf harness and take the
 * M4 view of it; a fake subscription server answering every route at
 * `FAKE_MS`.
 * @param {(options?: any) => Promise<any>} provision the `runPerf` tool
 * @param {{ credentialTag?: (value: string) => string | undefined }} [options]
 */
export const startPerfM4 = async (provision, { credentialTag } = {}) => {
  const template = await m4Template();
  const run = await provision({ template: template.dir });
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
  return {
    manager,
    /** @param {string} [label] default the manager vat */
    frames: async (label = manager) => (await lengths()).get(label) ?? 0,
  };
};
