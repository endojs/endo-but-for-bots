// @ts-check
/**
 * Provisioning steps (M1a W1a.6; hook table, `designs/m1a-interfaces.md`
 * sections 9 and 12; architecture 3.1).
 *
 * `provisionSteps` is append-only for later milestones: each entry is
 * `{ name, run(context) -> Promise<StepResult> }` and must be idempotent
 * (it checks the inventory or the program digest first and answers
 * `{ skipped: true }` when there is nothing to do). `context` is the state
 * template helper's provisioning context, `{ client, connect }`, with
 * `client` a control client on the harness workspace, plus `options`.
 *
 * M1a's steps:
 * 1. `install-native agentHost`: `installNative('agentHostAdmin',
 *    resources/agent-host)`.
 * 2. `inventory vats`: the workspace vat puts its worker controller in the
 *    inventory as `vats`.
 * 3. `install harness`: bundle `guest/factory/main.js` and install it as
 *    `harness` with the grants `host` -> `agentHostAdmin`, `vats` -> `vats`.
 * 4. `load session program`: bundle the session program and load it into
 *    the factory in pieces of at most `programPieceBytes` UTF-8 bytes,
 *    unless the factory already holds that digest.
 * The factory registers its start listener itself when it is made.
 *
 * `provision(context)` runs the steps with the session program
 * `guest/session/main.js` (W1a.4). `makeProvision({ sessionEntry })` runs
 * them with another program (the factory's tests use the stand-in
 * `guest/factory/standin-session.js`). `m1aTemplateOptions()` gives the
 * `ensureTemplate` options for the m1a state template, with an id that
 * changes whenever the provisioned code changes.
 */
import './_init.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import url from 'node:url';

import { E } from '@endo/far';

import { limits } from '../config/defaults.js';
import { bundleGuest } from './bundle-guest.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const harnessRoot = path.resolve(here, '..');
export const guestRoot = path.join(harnessRoot, 'guest');
/** The agent-host native resource directory (W1a.2). */
export const agentHostDirectory = path.join(
  harnessRoot,
  'resources',
  'agent-host',
);
export const factoryEntry = path.join(guestRoot, 'factory', 'main.js');
/** The session program (W1a.4). */
export const sessionEntry = path.join(guestRoot, 'session', 'main.js');
/** The factory's stand-in session program (tests until W1a.7). */
export const standinSessionEntry = path.join(
  guestRoot,
  'factory',
  'standin-session.js',
);

/** Inventory names (F.2 c: names a CLI and tests use). */
export const names = harden({
  agentHost: 'agentHostAdmin',
  vats: 'vats',
  harness: 'harness',
});

/**
 * The largest program piece, in UTF-8 bytes: `frameBytes` less the
 * envelope the factory keeps free (`guest/factory/root.js`
 * `programPieceBytes`, the same expression).
 */
export const programPieceBytes = limits.frameBytes - 1024;

/** The session program's size budget (architecture D-4, perf `session.program`). */
export const sessionProgramBytes = 200_000;

/**
 * @typedef {object} StepContext
 * @property {any} client a control client on the harness workspace
 * @property {(options?: { workspace?: string }) => Promise<any>} [connect]
 * @property {{ sessionEntry: string }} options
 */

/**
 * @typedef {object} StepResult
 * @property {boolean} skipped
 * @property {Record<string, unknown>} [detail]
 */

/**
 * @typedef {object} ProvisionStep
 * @property {string} name
 * @property {(context: StepContext) => Promise<StepResult>} run
 */

/**
 * @param {any} client
 * @param {string} name
 */
const has = async (client, name) =>
  (await client.call('lookup', name)) !== undefined;

/** @type {ProvisionStep[]} */
const m1aSteps = [
  {
    name: 'install-native agentHost',
    run: async ({ client }) => {
      if (await has(client, names.agentHost)) return { skipped: true };
      await client.call('installNative', names.agentHost, agentHostDirectory);
      return { skipped: false };
    },
  },
  {
    name: 'inventory vats',
    run: async ({ client }) => {
      if (await has(client, names.vats)) return { skipped: true };
      await client.call(
        'evaluate',
        `(inventory.set(${JSON.stringify(names.vats)}, vats), true)`,
      );
      return { skipped: false };
    },
  },
  {
    name: 'install harness',
    run: async ({ client }) => {
      if (await has(client, names.harness)) return { skipped: true };
      const bundle = await bundleGuest(factoryEntry, { guestRoot });
      await client.call('install', names.harness, bundle.source, [
        ['host', names.agentHost],
        ['vats', names.vats],
      ]);
      return {
        skipped: false,
        detail: { bytes: bundle.bytes, digest: bundle.digest },
      };
    },
  },
  {
    name: 'load session program',
    run: async ({ client, options }) => {
      const bundle = await bundleGuest(options.sessionEntry, { guestRoot });
      const harness = await client.call('lookup', names.harness);
      const status = await E(harness).status();
      const detail = {
        bytes: bundle.bytes,
        digest: bundle.digest,
        withinBudget: bundle.bytes <= sessionProgramBytes,
      };
      if (status.program.digest === bundle.digest)
        return { skipped: true, detail };
      const answer = await loadSessionProgram(harness, bundle);
      return { skipped: false, detail: { ...detail, pieces: answer.pieces } };
    },
  },
];

/** Hook table (append-only). */
export const provisionSteps = harden(m1aSteps);

/**
 * Load a program source into the factory in pieces.
 * @param {any} harness the HarnessRoot
 * @param {{ source: string, digest: string }} program
 */
export const loadSessionProgram = async (harness, { source, digest }) => {
  const { chunkText } = await guestBounded();
  const pieces = chunkText(source, programPieceBytes);
  let answer = { complete: false, bytes: 0 };
  for (let index = 0; index < pieces.length; index += 1) {
    answer = await E(harness).loadSessionProgram(
      harden({ digest, index, count: pieces.length, text: pieces[index] }),
    );
  }
  if (!answer.complete)
    throw Error(`the factory did not complete program ${digest}`);
  return { ...answer, pieces: pieces.length };
};

/**
 * `guest/lib/bounded.js` needs the guest prelude on globalThis; load both
 * on first use only (this module is also imported where no guest code
 * runs).
 */
const guestBounded = async () => {
  const { installGuestPrelude } = await import('./guest-prelude.js');
  installGuestPrelude();
  // eslint-disable-next-line import/no-relative-packages
  return import('../guest/lib/bounded.js');
};

/**
 * @typedef {object} StepReport
 * @property {string} name
 * @property {boolean} skipped
 * @property {number} ms
 * @property {Record<string, unknown>} [detail]
 */

/**
 * The provisioning function for a session program.
 * @param {object} [options]
 * @param {string} [options.sessionEntry] default `guest/session/main.js`
 * @param {(report: StepReport) => void} [options.onStep]
 * @returns {(context: { client: any, connect?: any }) => Promise<StepReport[]>}
 */
export const makeProvision =
  ({ sessionEntry: entry = sessionEntry, onStep } = {}) =>
  async ({ client, connect }) => {
    if (!existsSync(entry))
      throw Error(`No session program at ${entry} (W1a.4 writes it)`);
    /** @type {StepReport[]} */
    const reports = [];
    for (const step of provisionSteps) {
      const t0 = performance.now();

      const result = await step.run({
        client,
        connect,
        options: { sessionEntry: entry },
      });
      const report = {
        name: step.name,
        skipped: result.skipped,
        ms: +(performance.now() - t0).toFixed(1),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      reports.push(report);
      onStep?.(report);
    }
    return reports;
  };

/**
 * Provision with the session program (the template helper's `provision`).
 * @param {{ client: any, connect?: any }} context
 */
export const provision = async context => {
  await makeProvision()(context);
};

/**
 * @param {import('node:crypto').Hash} hash
 * @param {string} dir
 */
const hashTree = async (hash, dir) => {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await hashTree(hash, file);
    } else if (entry.name.endsWith('.js')) {
      hash.update(path.relative(harnessRoot, file));

      hash.update(await readFile(file));
    }
  }
};

/**
 * The m1a template's id: `m1a-` and 10 hex digits of what provisioning
 * installs (the factory and session bundles, the agent-host installed
 * modules and the guest library they import), so a code change builds a
 * new template instead of serving a stale one. The worker, boot bundles
 * and crank budget are in the template key already.
 * @param {object} [options]
 * @param {string} [options.sessionEntry]
 * @param {string} [options.prefix] default `m1a`
 */
export const templateIdFor = async ({
  sessionEntry: entry = sessionEntry,
  prefix = 'm1a',
} = {}) => {
  const hash = createHash('sha256');
  for (const bundleEntry of [factoryEntry, entry]) {
    hash.update((await bundleGuest(bundleEntry, { guestRoot })).digest);
  }
  for (const file of ['durable.js', 'ephemeral.js']) {
    hash.update(await readFile(path.join(agentHostDirectory, file)));
  }
  await hashTree(hash, path.join(guestRoot, 'lib'));
  return `${prefix}-${hash.digest('hex').slice(0, 10)}`;
};

/**
 * Options for `ensureTemplate` (test/template/index.js) that build the m1a
 * state template: `ensureTemplate(await m1aTemplateOptions())`.
 * @param {object} [options]
 * @param {string} [options.sessionEntry]
 * @param {string} [options.prefix]
 * @param {(report: StepReport) => void} [options.onStep]
 */
export const m1aTemplateOptions = async ({
  sessionEntry: entry = sessionEntry,
  prefix = 'm1a',
  onStep,
} = {}) => {
  const run = makeProvision({ sessionEntry: entry, onStep });
  return {
    id: await templateIdFor({ sessionEntry: entry, prefix }),
    /** @param {{ client: any, connect?: any }} context */
    provision: async context => {
      await run(context);
    },
  };
};
