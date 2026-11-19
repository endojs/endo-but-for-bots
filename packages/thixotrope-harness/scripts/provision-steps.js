// @ts-check
/**
 * Provisioning steps (M1a W1a.6; hook table, `designs/m1a-interfaces.md`
 * sections 9 and 12; architecture 3.1).
 *
 * `provisionSteps` holds M1a's and M1b's steps; later milestones register
 * theirs by file (below). Each step is
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
 * M1b's steps (W1b.5, appended):
 * 5. `load exec program`: bundle the exec program (`guest/exec/main.js`,
 *    W1b.3; `options.execEntry` overrides it) and load it with
 *    `HarnessRoot.loadExecProgram` in pieces, unless the factory holds that
 *    digest; skipped when there is no exec program yet.
 * 6. `pool`: `HarnessRoot.configure(options.pool)` then `whenSettled()`, so
 *    a template is stopped with its spares made and asleep; skipped when the
 *    targets are already as asked and the pool is full. `makeProvision`
 *    defaults to no spares (`M1A_POOL`: M1a's states create cold, as their
 *    tests and perf rows expect); `provision` and `m1bTemplateOptions` use
 *    the factory's defaults (2 session spares, 1 exec spare).
 *
 * Later milestones' steps (M2-T1; m3-interfaces.md H5, m4-interfaces.md
 * H-8, m5-interfaces.md H-10): one file each under
 * `scripts/provision-steps/`, named `<two digits>-<name>.js` and exporting
 * `steps` (a `ProvisionStep[]`), run after the table above in file-name
 * order: `30-gateway.js` (M3, `options.gateway`), `40-subscriptions.js`
 * (M4, `options.subscriptions`), `50-m5-fixtures.js` (M5,
 * `options.m5Fixtures`); reserved for the lanes building them (WX.1; no
 * file yet): `60-environments.js` (the environments resource,
 * `options.environments`) and `70-voice.js` (speech settings through
 * `HarnessRoot.configureSpeech`); later milestones take further numbers. A
 * lane adds its file and edits nothing here. `makeProvision` forwards every option it
 * does not use itself to every step untouched (the same values, not
 * copies), so a later step's options need no edit of `makeProvision`
 * either. A step that is not asked for answers `{ skipped: true }`.
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

/** The exec program (W1b.3). */
export const execEntry = path.join(guestRoot, 'exec', 'main.js');
/** The pool's stand-in exec program (tests until W1b.3 lands). */
export const standinExecEntry = path.join(
  guestRoot,
  'factory',
  'standin-exec.js',
);

/**
 * Pool settings for M1a's states: no spares, every creation cold (their
 * tests and perf rows measure the cold path and find vats by
 * `session s<n>` labels).
 */
export const M1A_POOL = harden({ spareSessions: 0, spareExec: 0 });

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

/**
 * The session program's size budget (architecture D-4, perf
 * `session.program`): `limits.sessionProgramBytes` (the same value, the
 * unit test of the session program keeps them equal), raised from 200,000
 * by M5 (contract O-1) and from 240,000 for the group of M6, M8, M9 and
 * M11 (owner question G-1, the PM's default; WX.1).
 */
export const sessionProgramBytes = 270_336;

/**
 * @typedef {object} StepContext
 * @property {any} client a control client on the harness workspace
 * @property {(options?: { workspace?: string }) => Promise<any>} [connect]
 * @property {StepOptions} options
 */

/**
 * @typedef {{ sessionEntry: string, execEntry?: string, pool?: PoolOption } & Record<string, unknown>} StepOptions
 *   the session and exec entries and the pool `makeProvision` resolved, plus
 *   every other option given to it, forwarded untouched (M3
 *   `options.gateway`, M4 `options.subscriptions`, M5 `options.m5Fixtures`)
 */

/**
 * @typedef {{ spareSessions?: number, spareExec?: number, execDeadlineMs?: number }} PoolOption
 *   `HarnessRoot.configure` settings; `{}` keeps the factory's defaults
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
 * Whether the workspace inventory holds `name` (registered steps use it for
 * their idempotence check).
 * @param {any} client
 * @param {string} name
 */
export const has = async (client, name) =>
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

/** @type {ProvisionStep[]} */
const m1bSteps = [
  {
    name: 'load exec program',
    run: async ({ client, options }) => {
      const entry = options.execEntry ?? execEntry;
      if (!existsSync(entry))
        return { skipped: true, detail: { missing: entry } };
      const bundle = await bundleGuest(entry, { guestRoot });
      const harness = await client.call('lookup', names.harness);
      const status = await E(harness).status();
      const detail = { bytes: bundle.bytes, digest: bundle.digest };
      if (status.execProgram?.digest === bundle.digest)
        return { skipped: true, detail };
      const answer = await loadProgramPieces(harness, bundle, 'exec');
      return { skipped: false, detail: { ...detail, pieces: answer.pieces } };
    },
  },
  {
    name: 'pool',
    run: async ({ client, options }) => {
      const wanted = options.pool ?? {};
      const harness = await client.call('lookup', names.harness);
      const before = await E(harness).status();
      const { pool } = before;
      if (pool === undefined) return { skipped: true };
      const target = { ...pool.target, ...wanted };
      const execLoaded = (before.execProgram?.digest ?? '') !== '';
      const satisfied =
        pool.target.spareSessions === target.spareSessions &&
        pool.target.spareExec === target.spareExec &&
        wanted.execDeadlineMs === undefined &&
        pool.refilling === 0 &&
        pool.spareSessions === target.spareSessions &&
        (!execLoaded || pool.spareExec === target.spareExec);
      if (satisfied) return { skipped: true, detail: { pool } };
      const t0 = performance.now();
      await E(harness).configure(harden(wanted));
      const settled = await E(harness).whenSettled();
      return {
        skipped: false,
        detail: {
          pool: settled,
          settleMs: +(performance.now() - t0).toFixed(1),
        },
      };
    },
  },
];

/** Hook table (append-only). */
export const provisionSteps = harden([...m1aSteps, ...m1bSteps]);

/** Later milestones' step files (see the header): one per lane. */
export const stepDirectory = path.join(here, 'provision-steps');

const STEP_FILE = /^\d{2}-[a-z0-9-]+\.js$/;

/**
 * The step files of a registry directory, in run order (none when the
 * directory does not exist).
 * @param {string} [directory]
 * @returns {Promise<string[]>} absolute paths
 */
export const stepFiles = async (directory = stepDirectory) => {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && STEP_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .map(name => path.join(directory, name));
};

/**
 * The registered steps of a directory, file by file in run order. Each file
 * must export `steps`, a list of `{ name, run }`; a name already taken (by
 * the table or an earlier file) is refused, so two lanes cannot shadow each
 * other's step.
 * @param {string} [directory]
 * @returns {Promise<ProvisionStep[]>}
 */
export const registeredSteps = async (directory = stepDirectory) => {
  const taken = new Set(provisionSteps.map(step => step.name));
  /** @type {ProvisionStep[]} */
  const out = [];
  for (const file of await stepFiles(directory)) {
    const { steps } = await import(url.pathToFileURL(file).href);
    if (!Array.isArray(steps))
      throw Error(`${path.basename(file)} must export steps (a list)`);
    for (const step of steps) {
      if (typeof step?.name !== 'string' || typeof step?.run !== 'function')
        throw Error(`${path.basename(file)}: a step is { name, run }`);
      if (taken.has(step.name))
        throw Error(`${path.basename(file)}: step ${step.name} exists already`);
      taken.add(step.name);
      out.push(step);
    }
  }
  return harden(out);
};

/**
 * Every step `makeProvision` runs: the table, then the registered steps.
 * @param {string} [directory]
 * @returns {Promise<readonly ProvisionStep[]>}
 */
export const allProvisionSteps = async (directory = stepDirectory) =>
  harden([...provisionSteps, ...(await registeredSteps(directory))]);

/**
 * Load a program source into the factory in pieces.
 * @param {any} harness the HarnessRoot
 * @param {{ source: string, digest: string }} program
 */
export const loadSessionProgram = async (harness, program) =>
  loadProgramPieces(harness, program, 'session');

/**
 * Load a program source into the factory in pieces: the session program
 * (`loadSessionProgram`) or the exec program (`loadExecProgram`, M1b).
 * @param {any} harness the HarnessRoot
 * @param {{ source: string, digest: string }} program
 * @param {'session' | 'exec'} kind
 */
export const loadProgramPieces = async (harness, { source, digest }, kind) => {
  const { chunkText } = await guestBounded();
  const pieces = chunkText(source, programPieceBytes);
  let answer = { complete: false, bytes: 0 };
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = harden({
      digest,
      index,
      count: pieces.length,
      text: pieces[index],
    });
    answer =
      kind === 'exec'
        ? await E(harness).loadExecProgram(piece)
        : await E(harness).loadSessionProgram(piece);
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
 * @param {string} [options.execEntry] default `guest/exec/main.js` (M1b;
 *   the step is skipped while it does not exist)
 * @param {PoolOption} [options.pool] default `M1A_POOL` (no spares)
 * @param {(report: StepReport) => void} [options.onStep]
 * @param {string} [options.stepDirectory] where the registered steps are
 *   (default `scripts/provision-steps/`; tests name another)
 * @param {unknown} [options.gateway] M3 (H5), forwarded untouched
 * @param {unknown} [options.subscriptions] M4 (H-8), forwarded untouched
 * @param {unknown} [options.m5Fixtures] M5 (H-10), forwarded untouched
 * @returns {(context: { client: any, connect?: any }) => Promise<StepReport[]>}
 */
export const makeProvision =
  ({
    sessionEntry: entry = sessionEntry,
    execEntry: exec = execEntry,
    pool = M1A_POOL,
    onStep,
    stepDirectory: directory = stepDirectory,
    ...stepOptions
  } = {}) =>
  async ({ client, connect }) => {
    if (!existsSync(entry))
      throw Error(`No session program at ${entry} (W1a.4 writes it)`);
    const steps = await allProvisionSteps(directory);
    /** @type {StepReport[]} */
    const reports = [];
    for (const step of steps) {
      const t0 = performance.now();

      const result = await step.run({
        client,
        connect,
        options: { ...stepOptions, sessionEntry: entry, execEntry: exec, pool },
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
 * Provision with the session program, the exec program and the factory's
 * default pool (the template helper's `provision`; M1b's states).
 * @param {{ client: any, connect?: any }} context
 */
export const provision = async context => {
  await makeProvision({ pool: {} })(context);
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
 * @param {string} [options.execEntry] (M1b) hashed when it exists
 * @param {PoolOption} [options.pool] (M1b) default `M1A_POOL`
 * @param {string} [options.prefix] default `m1a`
 */
export const templateIdFor = async ({
  sessionEntry: entry = sessionEntry,
  execEntry: exec = execEntry,
  pool = M1A_POOL,
  prefix = 'm1a',
} = {}) => {
  const hash = createHash('sha256');
  for (const bundleEntry of [factoryEntry, entry]) {
    hash.update((await bundleGuest(bundleEntry, { guestRoot })).digest);
  }
  if (existsSync(exec))
    hash.update((await bundleGuest(exec, { guestRoot })).digest);
  hash.update(JSON.stringify(pool));
  hash.update(await readFile(path.join(here, 'provision-steps.js')));
  // The registered steps (none until M3): a new or changed step file gives
  // a new id; with none the hash input is as before.
  for (const file of await stepFiles()) {
    hash.update(path.relative(harnessRoot, file));
    hash.update(await readFile(file));
  }
  // Every installed module of the agent host outside impl/ (durable.js,
  // ephemeral.js and the lanes' durable-*.js beside them): a lane's new
  // durable module gives a new id without an edit here.
  const installed = (await readdir(agentHostDirectory, { withFileTypes: true }))
    .filter(dirent => dirent.isFile() && dirent.name.endsWith('.js'))
    .map(dirent => dirent.name)
    .sort();
  for (const file of installed) {
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

/**
 * Options for `ensureTemplate` that build an M1b state template: the
 * session and exec programs and a pool (default: the factory's targets),
 * provisioned with its spares made and asleep.
 * @param {object} [options]
 * @param {string} [options.sessionEntry]
 * @param {string} [options.execEntry]
 * @param {PoolOption} [options.pool] default `{}` (the factory's defaults)
 * @param {string} [options.prefix] default `m1b`
 * @param {(report: StepReport) => void} [options.onStep]
 */
export const m1bTemplateOptions = async ({
  sessionEntry: entry = sessionEntry,
  execEntry: exec = execEntry,
  pool = {},
  prefix = 'm1b',
  onStep,
} = {}) => {
  const run = makeProvision({
    sessionEntry: entry,
    execEntry: exec,
    pool,
    onStep,
  });
  return {
    id: await templateIdFor({
      sessionEntry: entry,
      execEntry: exec,
      pool,
      prefix,
    }),
    /** @param {{ client: any, connect?: any }} context */
    provision: async context => {
      await run(context);
    },
  };
};
