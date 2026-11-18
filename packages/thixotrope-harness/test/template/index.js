// @ts-check
/**
 * The state template for integration tests (milestones.md M0 W0.7, spike S8;
 * architecture.md section 10, layer 3).
 *
 * A cold supervisor start costs about 32 s and creating a workspace about
 * 12 s more (survey tooling.md 4.1). Integration tests instead start from a
 * provisioned, cleanly stopped state directory, copied per test under a new
 * short path. Spike S8 (test/spikes/s8.test.js) checks that a state
 * directory is path-independent, so a copy serves from its new path.
 *
 * Usage, in an integration test file:
 *
 *   import test from 'ava';
 *   import { ensureTemplate, startFromTemplate, integrationEnabled } from '../template/index.js';
 *
 *   const run = integrationEnabled ? test.serial : test.skip;
 *   run('my scenario', async t => {
 *     const template = await ensureTemplate();          // built once, then cached
 *     const state = await startFromTemplate(template, { t }); // copy + start
 *     const value = await state.client.call('lookup', 'something');
 *     await state.kill();                               // kill -9 the supervisor
 *     await state.restart();                            // serve the same copy again
 *     // state.cleanup() runs from t.teardown: stop, then delete the copy
 *   });
 *
 * The run lock (scripts/run-lock.mjs) must be held around Ironhorse work;
 * `takeIntegrationLock(test)` registers before/after hooks that take it.
 *
 * Templates are cached under `tmp/t<key>` (git-ignored). The key covers
 * everything that makes a state directory unusable or different: the worker
 * binary and the Ironhorse boot bundles (a change of either changes the boot
 * digest and the state is refused), the supervisor's WORKSPACE_VERSION, the
 * crank budget, TEMPLATE_VERSION and the caller's provisioning `id`. A
 * template whose key no longer matches is simply not found and a new one is
 * built; `removeTemplates()` deletes all of them (but not a live process's
 * build directory).
 *
 * Several test processes may share one worktree (run-lock slots): a build
 * holds the private lock `tmp/t<key>.build`, and a process that waited on it
 * finds the template cached. A finished build appears with one rename, and
 * a rebuild moves the old template aside before it is deleted. Every copy
 * and build directory has its own name (`tmp/<6 chars>`, `tmp/b<pid>`).
 *
 * The supervisor runs in a child process (`scripts/serve.mjs`
 * `spawnSupervisorChild`: the environment allowlist, and a pipe that stops
 * it if this process dies), so it can be killed with SIGKILL like a real
 * crash. The perf harness (perf/_harness.mjs) starts state the same way.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import url from 'node:url';

import { limits } from '../../config/defaults.js';
import { acquireRunLock, isProcessAlive } from '../../scripts/run-lock.mjs';
import { readServeRecord, spawnSupervisorChild } from '../../scripts/serve.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const harnessRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(harnessRoot, '..', '..');
const thixotropeRoot = path.join(repoRoot, 'packages', 'thixotrope');
export const tmpRoot = path.join(harnessRoot, 'tmp');

/** Bump when what a template holds changes shape. */
export const TEMPLATE_VERSION = 1;

/** The workspace every template provisions and every client selects. */
export const TEMPLATE_WORKSPACE = 'w';

/**
 * Integration tests (and spikes) run only when asked: they need the release
 * Ironhorse worker and minutes of machine time.
 */
export const integrationEnabled =
  process.env.THIX_HARNESS_INTEGRATION === '1' ||
  process.env.THIX_HARNESS_SPIKES === '1';

/**
 * The worker binary the supervisor runs.
 */
export const workerBinary =
  process.env.THIXOTROPE_IRONHORSE_WORKER ??
  path.join(repoRoot, 'target', 'release', 'thixotrope-ironhorse-worker');

/** @param {number} ms */
const round1 = ms => +ms.toFixed(1);

/**
 * @param {import('node:crypto').Hash} hash
 * @param {string} file
 */
const hashInto = (hash, file) =>
  new Promise((resolve, reject) =>
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject),
  );

/**
 * State settings a served directory pins (the collection schedule, CC-022,
 * CC-023) or lays out on disk (the hub store, CC-024), as set in this
 * process's environment; unset ones are left out.
 * @returns {Record<string, string>}
 */
export const stateSettingsFromEnv = () => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of [
    'THIXOTROPE_GC_POLICY',
    'THIXOTROPE_GC_SLOT_ALLOWANCE',
    'THIXOTROPE_GC_CHUNK_ALLOWANCE',
    'THIXOTROPE_GC_CRANK_INTERVAL',
    'THIXOTROPE_HUB_STORE',
  ]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};

/**
 * The cache key of a template: a short hex digest of the runtime identity,
 * the workspace version, the crank budget, TEMPLATE_VERSION and the
 * provisioning id.
 * @param {{ crankBudget: bigint, id: string }} options
 */
export const templateKey = async ({ crankBudget, id }) => {
  const hash = createHash('sha256');
  for (const file of [
    workerBinary,
    path.join(thixotropeRoot, 'dist-ironhorse', 'boot.js'),
    path.join(thixotropeRoot, 'dist-ironhorse', 'worker-peer.js'),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await hashInto(hash, file);
    hash.update('\0');
  }
  const supervisorSource = await readFile(
    path.join(thixotropeRoot, 'src', 'control', 'supervisor.js'),
    'utf8',
  );
  const workspaceVersion =
    /WORKSPACE_VERSION\s*=\s*(\d+)/.exec(supervisorSource)?.[1] ?? '?';
  hash.update(
    JSON.stringify({
      workspaceVersion,
      crankBudget: String(crankBudget),
      templateVersion: TEMPLATE_VERSION,
      id,
      // A state's slot ceiling is persisted and may not decrease (M1b QC):
      // a template served at one ceiling cannot be served at a lower one.
      slotCeiling: String(
        process.env.THIXOTROPE_SLOT_CEILING ?? limits.slotCeiling,
      ),
      // Also persisted and refused when changed (CC-022, CC-023), and the
      // hub store's layout (CC-024): the file store refuses a log directory.
      // Only set ones are keyed, so the defaults keep their templates.
      ...stateSettingsFromEnv(),
    }),
  );
  return hash.digest('hex').slice(0, 10);
};

/**
 * A fresh short directory name under tmp/: one letter and five base-36
 * characters (6 characters; Unix socket paths are limited to 104 bytes).
 * @param {string} [letter]
 */
export const shortName = (letter = 's') => {
  let rest = '';
  // Not crypto: only uniqueness among concurrent tests on one machine.
  for (let i = 0; i < 5; i += 1)
    rest += '0123456789abcdefghijklmnopqrstuvwxyz'[
      Math.floor(Math.random() * 36)
    ];
  return `${letter}${rest}`;
};

/**
 * @typedef {object} Supervisor
 * @property {string} root
 * @property {number | undefined} pid
 * @property {() => Promise<{ servedMs: number }>} serve start the child over `root`
 * @property {() => Promise<void>} kill SIGKILL, then wait for exit
 * @property {() => Promise<void>} stop SIGTERM (clean close), SIGKILL after 60 s
 * @property {() => boolean} running
 * @property {() => string} stderrTail
 * @property {() => CrashLine[]} crashLog the current serve's crash lines
 */

/**
 * A supervisor stderr line about a vat crash, its retries or its giving up,
 * with its time from the start of that serve.
 * @typedef {{ ms: number, text: string }} CrashLine
 */

/** Supervisor stderr lines kept in `crashLog()`. */
export const CRASH_LINE =
  /crashed while resuming|quarantined|retry after a crash|crash count|gave up|giving up/;

/**
 * A supervisor child process over one state directory.
 * @param {object} options
 * @param {string} options.root
 * @param {bigint} options.crankBudget
 * @param {number} options.idleSleepMs
 * @param {number} [options.snapshotEveryDeliveries]
 * @param {number} [options.maxDeliveryAttempts] the crash bound
 *   (`THIXOTROPE_MAX_DELIVERY_ATTEMPTS`, 2..100; default the wrapper's)
 * @returns {Supervisor}
 */
const makeSupervisor = ({
  root,
  crankBudget,
  idleSleepMs,
  snapshotEveryDeliveries,
  maxDeliveryAttempts,
}) => {
  /** @type {import('../../scripts/serve.mjs').SupervisorChild | undefined} */
  let started;
  /** @type {CrashLine[]} */
  let crashLog = [];
  const running = () => started !== undefined && started.running();
  const serve = async () => {
    if (running()) throw Error('the supervisor is already running');
    const t0 = performance.now();
    crashLog = [];
    // The same child, environment and parent-death pipe as scripts/serve.mjs.
    started = spawnSupervisorChild(
      {
        statePath: root,
        crankBudget,
        idleSleepMs,
        snapshotEveryDeliveries,
        ...(maxDeliveryAttempts === undefined ? {} : { maxDeliveryAttempts }),
      },
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let partial = '';
    started.child.stderr?.on('data', bytes => {
      const lines = `${partial}${String(bytes)}`.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (CRASH_LINE.test(line))
          crashLog.push({
            ms: round1(performance.now() - t0),
            text: line.slice(0, 240),
          });
      }
    });
    await started.served;
    return { servedMs: round1(performance.now() - t0) };
  };
  const kill = async () => {
    if (!running()) return;
    started?.child.kill('SIGKILL');
    await started?.exited;
  };
  const stop = async () => {
    if (!running() || !started) return;
    const { child, exited } = started;
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      delay(60_000).then(() => {
        child.kill('SIGKILL');
        return exited;
      }),
    ]);
  };
  return {
    root,
    get pid() {
      return started?.pid;
    },
    serve,
    kill,
    stop,
    running,
    stderrTail: () => started?.stderrTail() ?? '',
    crashLog: () => crashLog,
  };
};

/** @type {Promise<{ connectLocalControl: any, powers: any }> | undefined} */
let controlModules;
const control = () => {
  controlModules ??= (async () => {
    const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
      import('@endo/thixotrope/local-control.js'),
      import('@endo/thixotrope/node-powers.js'),
    ]);
    return { connectLocalControl, powers: makeNodePowers() };
  })();
  return controlModules;
};

/**
 * Open a control connection to the supervisor serving `root`.
 * @param {string} root
 * @param {{ workspace?: string }} [options] omit `workspace` for a
 *   daemon-wide (administrative) connection
 * @returns {Promise<any>} the control client (`call(method, ...args)`, `close()`)
 */
export const connect = async (root, { workspace } = {}) => {
  const { connectLocalControl, powers } = await control();
  return connectLocalControl(
    powers,
    path.join(root, 'control.sock'),
    workspace === undefined ? undefined : { workspace },
  );
};

/**
 * @typedef {object} ProvisionContext
 * @property {string} root the state directory being provisioned (it moves afterwards: do not keep it)
 * @property {any} client a control client on the template workspace
 * @property {(options?: { workspace?: string }) => Promise<any>} connect another control client
 */

/**
 * @typedef {object} Template
 * @property {string} dir the cached, cleanly stopped state directory (never served)
 * @property {string} key
 * @property {string} id
 * @property {bigint} crankBudget
 * @property {boolean} built true when this call built it
 * @property {number} [buildMs] cold provision time when built
 * @property {Record<string, number>} [buildSteps] per-step times when built
 * @property {string} [builtAt] the path the template was provisioned under
 */

/**
 * Find or build a template.
 *
 * Building: a supervisor serves a fresh directory (`tmp/b<pid>`), the
 * workspace `w` is created, the `provision` steps run with a client on it,
 * the supervisor is stopped cleanly (SIGTERM), sockets are removed, and the
 * directory is renamed to `tmp/t<key>`. The rename is the first proof of
 * path independence: no template is ever served at the path it is stored
 * under.
 *
 * @param {object} [options]
 * @param {string} [options.id] names the provisioning; part of the cache key
 * @param {(context: ProvisionContext) => Promise<void>} [options.provision]
 *   extra steps after the workspace exists (installs, natives); must be
 *   deterministic for one `id`
 * @param {bigint} [options.crankBudget]
 * @param {boolean} [options.rebuild] build even when a cached one exists
 * @returns {Promise<Template>}
 */
export const ensureTemplate = async ({
  id = 'base',
  provision,
  crankBudget = limits.crankBudget,
  rebuild = false,
} = {}) => {
  if (!/^[a-z0-9-]{1,32}$/.test(id))
    throw Error(`template id must be [a-z0-9-]{1,32}, got ${id}`);
  const key = await templateKey({ crankBudget, id });
  const dir = path.join(tmpRoot, `t${key}`);
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const cached = async () =>
    (await readServeRecord(dir).catch(() => undefined))?.status === 'clean';
  if (!rebuild && (await cached()))
    return { dir, key, id, crankBudget, built: false };
  // Several test processes in one worktree may want the same template: one
  // builds it, the others wait here and then find it cached.
  const buildLock = await acquireRunLock({
    lockPath: path.join(tmpRoot, `t${key}.build`),
    slots: 1,
    mode: 'shared',
    env: {},
    label: `template ${id}`,
  });
  try {
    if (!rebuild && (await cached()))
      return { dir, key, id, crankBudget, built: false };
    return await buildTemplate({ dir, key, id, provision, crankBudget });
  } finally {
    await buildLock.release();
  }
};

/**
 * Build a template into `dir` (the caller holds the template's build lock).
 * @param {object} options
 * @param {string} options.dir
 * @param {string} options.key
 * @param {string} options.id
 * @param {((context: ProvisionContext) => Promise<void>) | undefined} options.provision
 * @param {bigint} options.crankBudget
 * @returns {Promise<Template>}
 */
const buildTemplate = async ({ dir, key, id, provision, crankBudget }) => {
  const building = path.join(tmpRoot, `b${process.pid % 100_000}`);
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { recursive: true, mode: 0o700 });
  const supervisor = makeSupervisor({
    root: building,
    crankBudget,
    idleSleepMs: 2000,
  });
  /** @type {Record<string, number>} */
  const buildSteps = {};
  const t0 = performance.now();
  try {
    buildSteps.serveMs = (await supervisor.serve()).servedMs;
    let t1 = performance.now();
    const admin = await connect(building);
    await admin.call('createWorkspace', TEMPLATE_WORKSPACE);
    admin.close();
    buildSteps.createWorkspaceMs = round1(performance.now() - t1);
    if (provision) {
      t1 = performance.now();
      const client = await connect(building, {
        workspace: TEMPLATE_WORKSPACE,
      });
      try {
        await provision({
          root: building,
          client,
          connect: options => connect(building, options),
        });
      } finally {
        client.close();
      }
      buildSteps.provisionMs = round1(performance.now() - t1);
    }
    t1 = performance.now();
    await supervisor.stop();
    buildSteps.stopMs = round1(performance.now() - t1);
    const record = await readServeRecord(building);
    if (record?.status !== 'clean')
      throw Error(
        `template supervisor did not stop cleanly: ${supervisor.stderrTail().slice(-2000)}`,
      );
    for (const name of ['control.sock', 'peers.sock'])
      // eslint-disable-next-line no-await-in-loop
      await rm(path.join(building, name), { force: true });
    // Never delete a template in place: move the old one aside first, so
    // the new one appears in one rename. A copy being taken from the old one
    // at this moment fails (rebuild only on request: M1A_REBUILD, spike S8).
    const old = path.join(tmpRoot, shortName('x'));
    const moved = await rename(dir, old).then(
      () => true,
      () => false,
    );
    await rename(building, dir);
    if (moved) await rm(old, { recursive: true, force: true });
  } catch (error) {
    await supervisor.kill();
    if (!process.env.KEEP_STATE)
      await rm(building, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    key,
    id,
    crankBudget,
    built: true,
    buildMs: round1(performance.now() - t0),
    buildSteps,
    builtAt: building,
  };
};

/**
 * Copy a state directory: files are cloned (APFS clonefile through
 * COPYFILE_FICLONE, a plain copy elsewhere); sockets are skipped; the root
 * is made private (0700), which the supervisor requires.
 * @param {string} from
 * @param {string} to
 */
export const copyState = async (from, to) => {
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
    filter: source => !source.endsWith('.sock'),
  });
  await chmod(to, 0o700);
};

/**
 * @typedef {object} TemplateState
 * @property {string} root the copy's state directory
 * @property {any} client a control client on workspace `w` (replaced at each restart)
 * @property {() => number | undefined} pid the supervisor child's pid
 * @property {{ copyMs: number, servedMs: number, connectedMs: number, totalMs: number }} timings of the first start
 * @property {(options?: { workspace?: string }) => Promise<any>} connect another control client
 * @property {() => Promise<void>} kill kill -9 the supervisor (the copy stays)
 * @property {() => Promise<void>} stop clean stop (SIGTERM)
 * @property {() => Promise<{ servedMs: number, connectedMs: number }>} restart
 *   serve the copy again (after kill or stop; stops cleanly first if running)
 * @property {() => Promise<void>} cleanup stop, kill stray processes, delete the copy
 * @property {() => string} stderrTail
 * @property {() => CrashLine[]} crashLog the supervisor's crash lines since
 *   the last (re)start, timed from it
 */

/**
 * Copy a template under a new short path (`tmp/<6 chars>`) and start a
 * supervisor child over the copy; connect a client on workspace `w`.
 *
 * @param {Template} template
 * @param {object} [options]
 * @param {import('ava').ExecutionContext} [options.t] registers cleanup as a teardown
 * @param {number} [options.idleSleepMs] default 2,000 so idle vats checkpoint quickly (architecture section 10)
 * @param {number} [options.snapshotEveryDeliveries]
 * @param {string} [options.root] the copy's path (default tmp/<6 chars>)
 * @param {number} [options.maxDeliveryAttempts] the supervisor's crash bound
 *   (`THIXOTROPE_MAX_DELIVERY_ATTEMPTS`, 2..100) for every (re)start of the
 *   copy; default the serve wrapper's (5)
 * @returns {Promise<TemplateState>}
 */
export const startFromTemplate = async (
  template,
  {
    t,
    idleSleepMs = 2000,
    snapshotEveryDeliveries,
    root,
    maxDeliveryAttempts,
  } = {},
) => {
  const target = root ?? path.join(tmpRoot, shortName());
  const t0 = performance.now();
  await copyState(template.dir, target);
  const copyMs = round1(performance.now() - t0);
  const supervisor = makeSupervisor({
    root: target,
    crankBudget: template.crankBudget,
    idleSleepMs,
    snapshotEveryDeliveries,
    maxDeliveryAttempts,
  });
  /** @type {any} */
  let client;
  const closeClient = () => {
    try {
      client?.close();
    } catch {
      // Already gone with its supervisor.
    }
    client = undefined;
  };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    closeClient();
    await supervisor.stop().catch(() => supervisor.kill());
    await killStrays(target);
    if (!process.env.KEEP_STATE)
      await rm(target, { recursive: true, force: true });
  };
  if (t) t.teardown(cleanup);
  try {
    const { servedMs } = await supervisor.serve();
    client = await connect(target, { workspace: TEMPLATE_WORKSPACE });
    const totalMs = round1(performance.now() - t0);
    return {
      root: target,
      get client() {
        return client;
      },
      pid: () => supervisor.pid,
      timings: {
        copyMs,
        servedMs,
        connectedMs: round1(totalMs - copyMs),
        totalMs,
      },
      connect: options => connect(target, options),
      kill: async () => {
        await supervisor.kill();
        closeClient();
      },
      stop: async () => {
        closeClient();
        await supervisor.stop();
      },
      restart: async () => {
        closeClient();
        await supervisor.stop();
        const t1 = performance.now();
        const served = await supervisor.serve();
        client = await connect(target, { workspace: TEMPLATE_WORKSPACE });
        return {
          servedMs: served.servedMs,
          connectedMs: round1(performance.now() - t1),
        };
      },
      cleanup,
      stderrTail: () => supervisor.stderrTail(),
      crashLog: () => supervisor.crashLog(),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/**
 * Processes whose command line names a path under `root` (workers, the lock
 * helper, adapters): after a clean stop there should be none.
 * @param {string} root
 * @returns {{ pid: number, command: string }[]}
 */
export const processesUnder = root => {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  }).toString();
  const needle = `${root}/`;
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(needle))
    .map(line => {
      const space = line.indexOf(' ');
      return {
        pid: Number(line.slice(0, space)),
        command: line.slice(space + 1),
      };
    })
    .filter(({ pid }) => pid !== process.pid);
};

/**
 * SIGKILL every process still naming `root` (after a supervisor SIGKILL its
 * children normally exit on their own; this is the belt to that).
 * @param {string} root
 * @returns {Promise<number>} how many were killed
 */
export const killStrays = async root => {
  let strays = processesUnder(root);
  for (let i = 0; i < 20 && strays.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await delay(250);
    strays = processesUnder(root);
  }
  for (const { pid } of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
  }
  return strays.length;
};

/**
 * Delete every cached template (and abandoned build directories).
 * @returns {Promise<string[]>} the directories removed
 */
export const removeTemplates = async () => {
  const names = await readdir(tmpRoot).catch(() => []);
  const removed = [];
  for (const name of names) {
    // A build directory is `b<pid>`: leave a live process's build alone.
    const building = /^b([0-9]+)$/.exec(name);
    const live =
      building !== null &&
      Number(building[1]) !== process.pid % 100_000 &&
      isProcessAlive(Number(building[1]));
    if (!live && (/^t[0-9a-f]{10}$/.test(name) || building)) {
      const dir = path.join(tmpRoot, name);
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(dir).catch(() => undefined);
      if (info?.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
  }
  return removed;
};

/**
 * Register before/after hooks that hold the run lock for the whole file
 * when integration tests are enabled.
 * @param {import('ava').TestFn} test
 * @param {string} label
 */
export const takeIntegrationLock = (test, label) => {
  /** @type {Awaited<ReturnType<typeof acquireRunLock>> | undefined} */
  let lock;
  test.before(async () => {
    if (integrationEnabled)
      lock = await acquireRunLock({
        label,
        onEvent: event =>
          process.stderr.write(`run-lock: ${JSON.stringify(event)}\n`),
      });
  });
  test.after.always(async () => {
    await lock?.release();
  });
};
