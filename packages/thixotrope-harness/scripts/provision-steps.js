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

/** The session program's size budget (architecture D-4, perf `session.program`). */
export const sessionProgramBytes = 200_000;

/**
 * @typedef {object} StepContext
 * @property {any} client a control client on the harness workspace
 * @property {(options?: { workspace?: string }) => Promise<any>} [connect]
 * @property {{ sessionEntry: string, execEntry?: string, pool?: PoolOption, gateway?: GatewayOption }} options
 */

/**
 * @typedef {{ port: number, publicOrigin?: string, trustedProxies?: string[], signInFailuresPerMinute?: number }} GatewayOption
 *   M3 (H5): `GatewayAdmin.serve` settings; the step adds the `Operator`
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

/**
 * M3's step (W3.7, m3-interfaces.md 11 H5), appended: `gateway` serves the
 * chat gateway with `options.gateway` and the harness's `Operator`
 * (`GatewayAdmin.serve`), skipped without `options.gateway` (tests serve
 * their own on port 0) and when the gateway already serves that port and
 * origin (the kit restores it at every start, so serving again is never
 * needed). A trusted-proxy or ceiling change on the same port and origin
 * is not seen by `status()`: stop the gateway first (`scripts/gateway.mjs`).
 * @type {ProvisionStep[]}
 */
const m3Steps = [
  {
    name: 'gateway',
    run: async ({ client, options }) => {
      const wanted = options.gateway;
      if (wanted === undefined) return { skipped: true };
      const admin = await client.call('lookup', names.agentHost);
      const gateway = await E(admin).gateway();
      const before = await E(gateway).status();
      const sameOrigin =
        wanted.publicOrigin === undefined
          ? before.origin === `http://127.0.0.1:${before.port}`
          : before.origin === wanted.publicOrigin;
      if (
        before.state === 'serving' &&
        wanted.port !== 0 &&
        before.port === wanted.port &&
        sameOrigin
      )
        return { skipped: true, detail: { port: before.port } };
      const harness = await client.call('lookup', names.harness);
      const operator = await E(harness).getOperator();
      const status = await E(gateway).serve(harden({ ...wanted, operator }));
      if (status.state !== 'serving')
        throw Error(status.error ?? `the gateway is ${status.state}`);
      return {
        skipped: false,
        detail: { port: status.port, origin: status.origin },
      };
    },
  },
];

/** Hook table (append-only). */
export const provisionSteps = harden([...m1aSteps, ...m1bSteps, ...m3Steps]);

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
 * @param {GatewayOption} [options.gateway] M3: serve the gateway (H5)
 * @param {(report: StepReport) => void} [options.onStep]
 * @returns {(context: { client: any, connect?: any }) => Promise<StepReport[]>}
 */
export const makeProvision =
  ({
    sessionEntry: entry = sessionEntry,
    execEntry: exec = execEntry,
    pool = M1A_POOL,
    gateway = undefined,
    onStep,
  } = {}) =>
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
        options: {
          sessionEntry: entry,
          execEntry: exec,
          pool,
          ...(gateway === undefined ? {} : { gateway }),
        },
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
