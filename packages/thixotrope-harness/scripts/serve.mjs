#!/usr/bin/env node
// @ts-check
/**
 * The harness serve wrapper (architecture.md section 1.1, "Configuration,
 * not core: the crank budget").
 *
 * - Sets THIXOTROPE_CRANK_BUDGET (daemon-wide) from `--crank-budget`, else
 *   the caller's THIXOTROPE_CRANK_BUDGET, else DEFAULT_CRANK_BUDGET.
 * - Refuses to lower the budget unless the last shutdown of this state
 *   directory was clean: crash recovery replays journaled cranks under the
 *   current budget, and a crank recorded under a higher one can exceed it
 *   and quarantine that vat (pkg README, limits section).
 * - Runs the supervisor in a child process whose environment is only
 *   ENV_ALLOWLIST plus the budget, so native adapter processes (which
 *   inherit the supervisor's environment) see no other host variables.
 *
 * The record of the last run is `<state>/harness-serve.json`:
 *   {"version":1,"status":"running"|"clean","crankBudget","floor","pid",...}
 * `floor` is the highest budget any crank since the last clean shutdown may
 * have been journaled under. With no record, a state directory that already
 * has `heaps/runtime.json` takes its recorded crank budget as the floor
 * (its shutdown history is unknown).
 *
 * Usage:
 *   node scripts/serve.mjs STATE [--crank-budget N] [--idle-sleep-ms N]
 *     [--snapshot-every N]
 * Stop with SIGINT or SIGTERM (or `thix stop STATE`).
 */
import './_init.mjs';
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

/**
 * Planning value (architecture section 9) until M0 spike S1 measures and
 * chooses; S1's choice replaces this constant.
 */
export const DEFAULT_CRANK_BUDGET = 50_000_000n;
export const SERVE_RECORD = 'harness-serve.json';
const CHILD_FLAG = '--supervisor-child';

/**
 * Host variables the supervisor and its adapter processes may see. Provider
 * keys and other secrets reach adapters through the secrets manager (M4),
 * never through the environment.
 */
export const ENV_ALLOWLIST = Object.freeze([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  // Thixotrope's own settings (pkg README, limits section; supervisor.js).
  'THIXOTROPE_IRONHORSE_WORKER',
  'THIXOTROPE_BOOTSTRAP_BUDGET',
  'THIXOTROPE_SLOT_CEILING',
  'THIXOTROPE_CHUNK_CEILING',
  'THIXOTROPE_REQUEST_TIMEOUT_MS',
  'THIXOTROPE_TRACE',
]);

/**
 * @param {string} name
 * @param {string | number | bigint} value
 */
export const parseCrankBudget = (name, value) => {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text))
    throw Error(`${name} must be a positive decimal integer, got ${text}`);
  const amount = BigInt(text);
  if (amount > 0xffff_ffff_ffff_ffffn)
    throw Error(`${name} must be at most 2^64-1`);
  return amount;
};

/**
 * @param {string} name
 * @param {string} value
 */
const parseMs = (name, value) => {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1)
    throw Error(`${name} must be a positive whole number`);
  return Number(value);
};

/**
 * @typedef {object} ServeOptions
 * @property {string} statePath
 * @property {bigint} crankBudget
 * @property {number} [idleSleepMs]
 * @property {number} [snapshotEveryDeliveries]
 */

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @returns {ServeOptions}
 */
export const parseServeArgs = (argv, env = process.env) => {
  /** @type {string | undefined} */
  let statePath;
  /** @type {bigint | undefined} */
  let crankBudget;
  /** @type {number | undefined} */
  let idleSleepMs;
  /** @type {number | undefined} */
  let snapshotEveryDeliveries;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split('=', 2) : [arg];
    const takeValue = () => {
      if (inline !== undefined) return inline;
      i += 1;
      const value = argv[i];
      if (value === undefined) throw Error(`${flag} needs a value`);
      return value;
    };
    if (flag === '--crank-budget')
      crankBudget = parseCrankBudget('--crank-budget', takeValue());
    else if (flag === '--idle-sleep-ms')
      idleSleepMs = parseMs('--idle-sleep-ms', takeValue());
    else if (flag === '--snapshot-every')
      snapshotEveryDeliveries = parseMs('--snapshot-every', takeValue());
    else if (arg.startsWith('-')) throw Error(`Unknown option ${arg}`);
    else if (statePath === undefined) statePath = path.resolve(arg);
    else throw Error(`Unexpected argument ${arg}`);
  }
  if (statePath === undefined)
    throw Error(
      'Usage: serve.mjs STATE [--crank-budget N] [--idle-sleep-ms N] [--snapshot-every N]',
    );
  if (crankBudget === undefined) {
    const fromEnv = env.THIXOTROPE_CRANK_BUDGET;
    crankBudget =
      fromEnv === undefined || fromEnv === ''
        ? DEFAULT_CRANK_BUDGET
        : parseCrankBudget('THIXOTROPE_CRANK_BUDGET', fromEnv);
  }
  return { statePath, crankBudget, idleSleepMs, snapshotEveryDeliveries };
};

/**
 * The supervisor's environment: the allowlisted host variables and the
 * chosen crank budget, nothing else.
 * @param {Record<string, string | undefined>} env
 * @param {{ crankBudget: bigint }} options
 * @returns {Record<string, string>}
 */
export const allowlistEnvironment = (env, { crankBudget }) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out.THIXOTROPE_CRANK_BUDGET = String(crankBudget);
  return out;
};

/**
 * @typedef {object} ServeRecord
 * @property {1} version
 * @property {'running' | 'clean'} status
 * @property {string} crankBudget
 * @property {string} floor
 * @property {number} [pid]
 * @property {string} [startedAt]
 * @property {string} [stoppedAt]
 */

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
const readJsonMaybe = async file => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return undefined;
    throw error;
  }
};

/**
 * @param {string} statePath
 * @returns {Promise<ServeRecord | undefined>}
 */
export const readServeRecord = async statePath => {
  const record = await readJsonMaybe(path.join(statePath, SERVE_RECORD));
  if (record === undefined) return undefined;
  if (
    record?.version !== 1 ||
    !['running', 'clean'].includes(record.status) ||
    !/^[0-9]+$/.test(String(record.floor)) ||
    !/^[0-9]+$/.test(String(record.crankBudget))
  )
    throw Error(
      `Unreadable ${SERVE_RECORD} in ${statePath}; refusing to guess the last shutdown`,
    );
  return record;
};

/**
 * @param {string} statePath
 * @param {ServeRecord} record
 */
export const writeServeRecord = async (statePath, record) => {
  const file = path.join(statePath, SERVE_RECORD);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, file);
};

/**
 * The lowest crank budget this state directory may start under.
 * @param {string} statePath
 * @returns {Promise<{ floor: bigint, reason: string }>}
 */
export const crankBudgetFloor = async statePath => {
  const record = await readServeRecord(statePath);
  if (record !== undefined) {
    if (record.status === 'clean')
      return { floor: 0n, reason: 'the last shutdown was clean' };
    const floor = BigInt(record.floor);
    const budget = BigInt(record.crankBudget);
    return {
      floor: floor > budget ? floor : budget,
      reason: `the last run (pid ${record.pid ?? '?'}) under crank budget ${record.crankBudget} did not shut down cleanly`,
    };
  }
  const runtime = await readJsonMaybe(
    path.join(statePath, 'heaps', 'runtime.json'),
  );
  const recorded = runtime?.limits?.crankBudget;
  if (recorded !== undefined && /^[0-9]+$/.test(String(recorded)))
    return {
      floor: BigInt(recorded),
      reason: `the state was last run under crank budget ${recorded} without ${SERVE_RECORD}, so its last shutdown is unknown`,
    };
  return { floor: 0n, reason: 'fresh state' };
};

/**
 * Throw when starting `statePath` under `crankBudget` would lower the
 * budget after an unclean (or unknown) shutdown.
 * @param {string} statePath
 * @param {bigint} crankBudget
 * @returns {Promise<bigint>} the floor that the new run carries
 */
export const checkCrankBudget = async (statePath, crankBudget) => {
  const { floor, reason } = await crankBudgetFloor(statePath);
  if (crankBudget < floor)
    throw Error(
      `Refusing to lower THIXOTROPE_CRANK_BUDGET to ${crankBudget} below ${floor}: ${reason}. Start once at ${floor} or more and stop cleanly, then lower it.`,
    );
  return floor > crankBudget ? floor : crankBudget;
};

/**
 * Serve in this process (tests and perf). The engine reads the budget from
 * an environment power holding only the allowlist; adapter processes still
 * inherit this process's environment, which the CLI path avoids.
 * @param {ServeOptions} options
 * @param {{ env?: Record<string, string | undefined> }} [host]
 */
export const serveHarness = async (
  { statePath, crankBudget, idleSleepMs, snapshotEveryDeliveries },
  { env = process.env } = {},
) => {
  // `serveThixotrope` is not in @endo/thixotrope's exports (JOURNAL
  // J-0132): reach it by path inside the work tree, as the survey baseline did.
  const [{ serveThixotrope }, { makeNodePowers }] = await Promise.all([
    // eslint-disable-next-line import/no-relative-packages -- not exported (J-0132)
    import('../../thixotrope/src/control/supervisor.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const floor = await checkCrankBudget(statePath, crankBudget);
  const allowed = allowlistEnvironment(env, { crankBudget });
  const powers = makeNodePowers();
  const platform = {
    ...powers,
    environment: harden({ get: (/** @type {string} */ name) => allowed[name] }),
  };
  const startedAt = new Date().toISOString();
  await writeServeRecord(statePath, {
    version: 1,
    status: 'running',
    crankBudget: String(crankBudget),
    floor: String(floor),
    pid: process.pid,
    startedAt,
  });
  const supervisor = await serveThixotrope(
    /** @type {any} */ (platform),
    statePath,
    {
      ...(idleSleepMs === undefined ? {} : { idleSleepMs }),
      ...(snapshotEveryDeliveries === undefined
        ? {}
        : { snapshotEveryDeliveries }),
    },
  );
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    closing ??= (async () => {
      await supervisor.close();
      // Only a close that completed is clean; a throw leaves "running".
      await writeServeRecord(statePath, {
        version: 1,
        status: 'clean',
        crankBudget: String(crankBudget),
        floor: String(crankBudget),
        pid: process.pid,
        startedAt,
        stoppedAt: new Date().toISOString(),
      });
    })();
    return closing;
  };
  return harden({
    socketPath: supervisor.socketPath,
    stopped: supervisor.stopped,
    close,
    crankBudget,
  });
};

/** @param {ServeOptions} options */
const runChild = async options => {
  const served = await serveHarness(options);
  const stop = () => {
    void served.close().catch(error => {
      process.stderr.write(`serve: ${error.message}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(
    `${JSON.stringify({ serving: served.socketPath, crankBudget: String(served.crankBudget), pid: process.pid })}\n`,
  );
  await served.stopped;
  await served.close();
};

/** @param {string[]} argv */
const main = async argv => {
  if (argv[0] === CHILD_FLAG) {
    await runChild(parseServeArgs(argv.slice(1)));
    return;
  }
  const options = parseServeArgs(argv);
  // Refuse in the parent too, before any process starts.
  await checkCrankBudget(options.statePath, options.crankBudget);
  const childArgs = [
    CHILD_FLAG,
    options.statePath,
    `--crank-budget=${options.crankBudget}`,
    ...(options.idleSleepMs ? [`--idle-sleep-ms=${options.idleSleepMs}`] : []),
    ...(options.snapshotEveryDeliveries
      ? [`--snapshot-every=${options.snapshotEveryDeliveries}`]
      : []),
  ];
  const child = spawn(
    process.execPath,
    [url.fileURLToPath(import.meta.url), ...childArgs],
    {
      stdio: 'inherit',
      env: allowlistEnvironment(process.env, options),
    },
  );
  /** @param {NodeJS.Signals} signal */
  const forward = signal => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  const code = await new Promise(resolve =>
    child.once('exit', (exitCode, signal) =>
      resolve(exitCode ?? (signal ? 128 : 1)),
    ),
  );
  process.exitCode = /** @type {number} */ (code);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`serve: ${error.message}\n`);
    process.exitCode = 1;
  });
}
