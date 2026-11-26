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
 * - Sets THIXOTROPE_MAX_DELIVERY_ATTEMPTS (the crash bound of `thix serve`,
 *   2..100) from `--max-delivery-attempts`, else the caller's variable, else
 *   config/defaults.js `limits.maxDeliveryAttempts` (the upstream default).
 * - Always runs the supervisor in a child process whose environment is only
 *   ENV_ALLOWLIST plus those two settings, so native adapter processes
 *   (which the core forks with the supervisor's environment) see no other
 *   host variables. This holds for the CLI and for `serveHarness()`; the
 *   child refuses to serve from any other environment.
 * - The child exits when its parent dies, even by SIGKILL: the parent holds
 *   one end of a pipe (the child's fd 3) and never writes to it; the kernel
 *   closes it when the parent dies, the child reads end-of-file, closes the
 *   supervisor cleanly and exits (forced after PARENT_GONE_GRACE_MS). A pipe
 *   rather than a periodic parent check: it fires at once, needs no timer,
 *   cannot be fooled by a reused pid, and works the same on macOS (no
 *   PR_SET_PDEATHSIG) and Linux.
 *
 * The record of the last run is `<state>/harness-serve.json`:
 *   {"version":1,"status":"running"|"clean","crankBudget","floor","pid",...}
 * `floor` is the highest budget any crank since the last clean shutdown may
 * have been journaled under. With no record, a state directory that already
 * has `runtime.json` (the Ironhorse manifest, at the state's top level)
 * takes its recorded crank budget as the floor (its shutdown history is
 * unknown).
 *
 * - The CLI refuses to start a new state (absent or empty) under /tmp or
 *   /private/tmp, which reboots and temp cleaners empty, unless
 *   `--allow-tmp-state` says it is a disposable test state; an existing
 *   one there is served with a warning. `serveHarness()` and
 *   `spawnSupervisorChild()` (tests, templates) do not check.
 *
 * Usage:
 *   node scripts/serve.mjs STATE [--crank-budget N] [--idle-sleep-ms N]
 *     [--snapshot-every N] [--max-delivery-attempts N] [--allow-tmp-state]
 * Stop with SIGINT or SIGTERM (or `thix stop STATE`).
 * Check a state without changing it: `node scripts/preflight.mjs STATE`.
 */
import './_init.mjs';
import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import url from 'node:url';

import { limits } from '../config/defaults.js';

/**
 * The daemon crank budget spike S1 chose (config/defaults.js, architecture
 * section 9).
 */
export const DEFAULT_CRANK_BUDGET = limits.crankBudget;
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = limits.maxDeliveryAttempts;
export const SERVE_RECORD = 'harness-serve.json';
export const CHILD_FLAG = '--supervisor-child';
/** `--parent-fd=N`: the child watches fd N for its parent's death. */
const PARENT_FD_FLAG = '--parent-fd=';
const PARENT_FD = 3;
/** How long a child whose parent died may take to close cleanly. */
export const PARENT_GONE_GRACE_MS = 60_000;

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
  // Rootless Podman (the environments adapter's `podman` runtime; Tokyo
  // plan 2.1, 2.4). Each is a path, not a secret; the adapter hands only
  // its own `cliEnvNames` to the podman process, never to a container.
  // - XDG_RUNTIME_DIR: podman's per-user runtime directory (libpod state,
  //   the pause process, conmon sockets). A system service with no login
  //   session or linger has no /run/user/<uid>; the unit names one
  //   (RuntimeDirectory=) and podman must see it or it guesses a temp dir.
  'XDG_RUNTIME_DIR',
  // - CONTAINERS_CONF: a containers.conf outside $HOME (on NixOS a store
  //   file with cgroup_manager = "cgroupfs" and events_logger = "file").
  'CONTAINERS_CONF',
  // Not passed: XDG_CONFIG_HOME and XDG_DATA_HOME (podman's defaults follow
  // HOME, which the unit sets: ~/.config/containers and the graph root
  // ~/.local/share/containers), CONTAINERS_STORAGE_CONF and
  // CONTAINERS_REGISTRIES_CONF (the adapter does not hand them to podman;
  // the files under ~/.config/containers serve), and
  // DBUS_SESSION_BUS_ADDRESS (needed only by cgroup_manager = "systemd",
  // which a service user without linger cannot use).
  //
  // systemd's LoadCredential= directory (a path): a Secrets wrapping key
  // under it is read-only, never created or written (secrets/wrapping-key.js
  // isCredentialPath). Only the wrapping key is loaded there.
  'CREDENTIALS_DIRECTORY',
  // Thixotrope's own settings (pkg README, limits section; supervisor.js).
  'THIXOTROPE_IRONHORSE_WORKER',
  'THIXOTROPE_BOOTSTRAP_BUDGET',
  'THIXOTROPE_SLOT_CEILING',
  'THIXOTROPE_CHUNK_CEILING',
  'THIXOTROPE_REQUEST_TIMEOUT_MS',
  'THIXOTROPE_MAX_DELIVERY_ATTEMPTS',
  'THIXOTROPE_TRACE',
  // The collection schedule (CC-022, CC-023): fixed per state directory,
  // so a run that bisects with `every-crank` must reach the supervisor.
  'THIXOTROPE_GC_POLICY',
  'THIXOTROPE_GC_SLOT_ALLOWANCE',
  'THIXOTROPE_GC_CHUNK_ALLOWANCE',
  'THIXOTROPE_GC_CRANK_INTERVAL',
  // How the hub keeps its state (CC-024): `log` (default) or `file`.
  'THIXOTROPE_HUB_STORE',
  // The hub's ceiling on one frame into a vat (CC-027); the harness default
  // is `limits.vatFrameBytes` (allowlistEnvironment).
  'THIXOTROPE_VAT_FRAME_BYTES',
  // M2 W2.3 (m2-interfaces 9.1): the path of the Secrets wrapping key file,
  // outside the state directory. A path, never a secret value.
  'THIX_HARNESS_SECRETS_KEY',
  // perf/turn.perf.mjs: the directory the agent host's live probe writes to
  // in the daemon a perf run serves (impl/channels.js; HR-SYN-13). Unset,
  // there is no probe.
  'THIX_HARNESS_LIVE_PROBE_DIR',
  // Explicit opt-in for the forwarded-mail diagnostic's selector-only worker trace.
  'THIX_HARNESS_FORWARD_PROBE_DIR',
]);

/** Set by the wrapper itself, besides the allowlist. */
const WRAPPER_SET = Object.freeze([
  'THIXOTROPE_CRANK_BUDGET',
  'THIXOTROPE_MAX_DELIVERY_ATTEMPTS',
]);

/**
 * Set by the operating system in a process started with an environment
 * that lacks it, so the child may have it though the wrapper never passed
 * it: macOS CoreFoundation's text-encoding hint (not a secret).
 */
const OS_ADDED = Object.freeze(['__CF_USER_TEXT_ENCODING']);

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
 * The same rule as `thix serve` (pkg src/control/supervisor.js
 * readMaxDeliveryAttempts): a decimal integer from 2 to 100.
 * @param {string} name
 * @param {string | number} value
 */
export const parseMaxDeliveryAttempts = (name, value) => {
  const text = String(value);
  if (!/^([2-9]|[1-9][0-9]|100)$/.test(text))
    throw Error(
      `${name} must be a decimal integer between 2 and 100, got ${text}`,
    );
  return Number(text);
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
 * @property {number} [maxDeliveryAttempts] default: the caller's
 *   THIXOTROPE_MAX_DELIVERY_ATTEMPTS, else DEFAULT_MAX_DELIVERY_ATTEMPTS
 * @property {boolean} [allowTmpState] the CLI may start a new state under
 *   /tmp (`--allow-tmp-state`, disposable test states only)
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
  /** @type {number | undefined} */
  let maxDeliveryAttempts;
  let allowTmpState = false;
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
    else if (flag === '--max-delivery-attempts')
      maxDeliveryAttempts = parseMaxDeliveryAttempts(
        '--max-delivery-attempts',
        takeValue(),
      );
    else if (arg === '--allow-tmp-state') allowTmpState = true;
    else if (arg.startsWith('-')) throw Error(`Unknown option ${arg}`);
    else if (statePath === undefined) statePath = path.resolve(arg);
    else throw Error(`Unexpected argument ${arg}`);
  }
  if (statePath === undefined)
    throw Error(
      'Usage: serve.mjs STATE [--crank-budget N] [--idle-sleep-ms N] [--snapshot-every N] [--max-delivery-attempts N] [--allow-tmp-state]',
    );
  if (crankBudget === undefined) {
    const fromEnv = env.THIXOTROPE_CRANK_BUDGET;
    crankBudget =
      fromEnv === undefined || fromEnv === ''
        ? DEFAULT_CRANK_BUDGET
        : parseCrankBudget('THIXOTROPE_CRANK_BUDGET', fromEnv);
  }
  maxDeliveryAttempts ??= defaultMaxDeliveryAttempts(env);
  return {
    statePath,
    crankBudget,
    idleSleepMs,
    snapshotEveryDeliveries,
    maxDeliveryAttempts,
    ...(allowTmpState ? { allowTmpState } : {}),
  };
};

/** Directories a reboot or a temp cleaner empties. */
export const TMP_ROOTS = harden(['/tmp', '/private/tmp']);

/**
 * @param {string} file
 * @param {string} root
 */
const isUnder = (file, root) =>
  file === root || file.startsWith(`${root}${path.sep}`);

/**
 * The real path of `file`, or of its nearest existing ancestor joined with
 * the rest (`/tmp` is a symlink to `/private/tmp` on macOS).
 * @param {string} file
 * @returns {Promise<string>}
 */
const realPathOf = async file => {
  const absolute = path.resolve(file);
  try {
    return await realpath(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await realPathOf(parent), path.basename(absolute));
  }
};

/**
 * True when `file` (as given or once symlinks are resolved) is under one of
 * `TMP_ROOTS`.
 * @param {string} file
 */
export const isUnderTmp = async file => {
  const candidates = [path.resolve(file), await realPathOf(file)];
  return candidates.some(candidate =>
    TMP_ROOTS.some(root => isUnder(candidate, root)),
  );
};

/**
 * A new state: the directory is absent or empty.
 * @param {string} statePath
 */
export const isNewState = async statePath => {
  try {
    return (await readdir(statePath)).length === 0;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return true;
    throw error;
  }
};

/**
 * Refuse a new state under /tmp unless `allowTmpState`; warn for an
 * existing one.
 * @param {ServeOptions} options
 * @param {(line: string) => void} [warn]
 */
export const checkStateLocation = async (
  { statePath, allowTmpState = false },
  warn = line => process.stderr.write(`${line}\n`),
) => {
  if (!(await isUnderTmp(statePath))) return;
  if (await isNewState(statePath)) {
    if (!allowTmpState)
      throw Error(
        `Refusing to start a new state under a temporary directory (${statePath}): a reboot or temp cleaner deletes it. Use a durable path, or pass --allow-tmp-state for a disposable test state.`,
      );
    return;
  }
  warn(
    `serve: warning: the state ${statePath} is under a temporary directory; a reboot or temp cleaner deletes it`,
  );
};

/**
 * The caller's THIXOTROPE_MAX_DELIVERY_ATTEMPTS, else the harness default.
 * @param {Record<string, string | undefined>} env
 */
export const defaultMaxDeliveryAttempts = env => {
  const text = env.THIXOTROPE_MAX_DELIVERY_ATTEMPTS;
  return text === undefined || text === ''
    ? DEFAULT_MAX_DELIVERY_ATTEMPTS
    : parseMaxDeliveryAttempts('THIXOTROPE_MAX_DELIVERY_ATTEMPTS', text);
};

/**
 * The supervisor's environment: the allowlisted host variables, the chosen
 * crank budget and the crash bound, the harness's slot ceiling
 * (`limits.slotCeiling`) unless the host sets `THIXOTROPE_SLOT_CEILING`, and
 * at a crank budget of at least `limits.crankBudget` the harness's vat frame
 * ceiling (`limits.vatFrameBytes`) unless the host sets
 * `THIXOTROPE_VAT_FRAME_BYTES`; nothing else.
 * @param {Record<string, string | undefined>} env
 * @param {{ crankBudget: bigint, maxDeliveryAttempts?: number }} options
 * @returns {Record<string, string>}
 */
export const allowlistEnvironment = (
  env,
  { crankBudget, maxDeliveryAttempts = defaultMaxDeliveryAttempts(env) },
) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out.THIXOTROPE_SLOT_CEILING ??= String(limits.slotCeiling);
  // An encoded frame may exceed the core's 32,768 default (J-10125); the
  // harness's ceiling is safe only at its own crank budget or above.
  if (crankBudget >= limits.crankBudget)
    out.THIXOTROPE_VAT_FRAME_BYTES ??= String(limits.vatFrameBytes);
  out.THIXOTROPE_CRANK_BUDGET = String(crankBudget);
  out.THIXOTROPE_MAX_DELIVERY_ATTEMPTS = String(
    parseMaxDeliveryAttempts('maxDeliveryAttempts', maxDeliveryAttempts),
  );
  return out;
};

/**
 * Names in `env` that the supervisor child may not see.
 * @param {Record<string, string | undefined>} env
 */
export const unexpectedEnvironment = env =>
  Object.keys(env)
    .filter(
      name =>
        !ENV_ALLOWLIST.includes(name) &&
        !WRAPPER_SET.includes(name) &&
        !OS_ADDED.includes(name),
    )
    .sort();

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
  const runtime = await readJsonMaybe(path.join(statePath, 'runtime.json'));
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
 * @param {ServeOptions} options
 * @returns {string[]} the child's arguments after CHILD_FLAG and the parent fd
 */
const childArguments = ({
  statePath,
  crankBudget,
  idleSleepMs,
  snapshotEveryDeliveries,
  maxDeliveryAttempts,
}) => [
  statePath,
  `--crank-budget=${crankBudget}`,
  ...(idleSleepMs ? [`--idle-sleep-ms=${idleSleepMs}`] : []),
  ...(snapshotEveryDeliveries
    ? [`--snapshot-every=${snapshotEveryDeliveries}`]
    : []),
  ...(maxDeliveryAttempts
    ? [`--max-delivery-attempts=${maxDeliveryAttempts}`]
    : []),
];

/**
 * @typedef {object} SupervisorChild
 * @property {import('node:child_process').ChildProcess} child
 * @property {number | undefined} pid
 * @property {Promise<{ socketPath: string, pid: number }>} served resolves at
 *   the child's "serving" line (only with `stdout: 'pipe'`); rejects if the
 *   child exits first
 * @property {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} exited
 * @property {() => boolean} running
 * @property {() => string} stderrTail
 */

/**
 * Start `serve.mjs --supervisor-child` over a state directory: the
 * environment is the allowlist (plus the budget and crash bound), and the
 * child holds the read end of a pipe from this process, so it stops when
 * this process dies. The one way every harness path starts a supervisor
 * (the CLI, `serveHarness`, the state-template helper).
 *
 * @param {ServeOptions} options
 * @param {object} [io]
 * @param {Record<string, string | undefined>} [io.env] the source of allowlisted variables
 * @param {'inherit' | 'pipe'} [io.stdout] 'pipe' parses the serving line
 * @param {'inherit' | 'pipe' | 'tail'} [io.stderr] 'tail' keeps a tail and
 *   forwards to this process's stderr; 'pipe' only keeps the tail
 * @returns {SupervisorChild}
 */
export const spawnSupervisorChild = (
  options,
  { env = process.env, stdout = 'pipe', stderr = 'pipe' } = {},
) => {
  const child = spawn(
    process.execPath,
    [
      url.fileURLToPath(import.meta.url),
      CHILD_FLAG,
      `${PARENT_FD_FLAG}${PARENT_FD}`,
      ...childArguments(options),
    ],
    {
      stdio: [
        'ignore',
        stdout,
        stderr === 'inherit' ? 'inherit' : 'pipe',
        'pipe',
      ],
      env: allowlistEnvironment(env, options),
    },
  );
  // Our end of the parent pipe: never written, never read; it must not keep
  // this process alive.
  const parentEnd = /** @type {import('node:net').Socket | undefined} */ (
    child.stdio[PARENT_FD]
  );
  parentEnd?.on('error', () => {});
  parentEnd?.unref();
  let tail = '';
  child.stderr?.on('data', bytes => {
    tail = `${tail}${String(bytes)}`.slice(-16_384);
    if (stderr === 'tail') process.stderr.write(bytes);
  });
  /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      parentEnd?.destroy();
      resolve({ code, signal });
    });
    child.once('error', () => {
      if (child.pid === undefined) resolve({ code: null, signal: null });
    });
  });
  /** @type {Promise<{ socketPath: string, pid: number }>} */
  const served = new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', bytes => {
      out = `${out}${String(bytes)}`.slice(-8192);
      const line = out.split('\n').find(text => text.includes('"serving"'));
      if (line) {
        try {
          const { serving, pid } = JSON.parse(line);
          resolve({ socketPath: serving, pid });
        } catch (error) {
          reject(error);
        }
      }
    });
    void exited.then(({ code, signal }) =>
      reject(
        Error(
          `the supervisor for ${options.statePath} exited (${code ?? signal}) before serving: ${tail.slice(-2000)}`,
        ),
      ),
    );
  });
  void served.catch(() => {});
  return {
    child,
    pid: child.pid,
    served,
    exited,
    running: () => child.exitCode === null && child.signalCode === null,
    stderrTail: () => tail,
  };
};

/**
 * Serve a state directory for tests, spikes and perf: the supervisor runs in
 * a child process through `spawnSupervisorChild`, so its adapters get the
 * allowlisted environment, as on the CLI path, and it stops if this process
 * dies. Refuses to lower the crank budget before anything starts.
 *
 * @param {ServeOptions} options
 * @param {{ env?: Record<string, string | undefined> }} [host]
 */
export const serveHarness = async (options, { env = process.env } = {}) => {
  const { statePath, crankBudget } = options;
  const maxDeliveryAttempts =
    options.maxDeliveryAttempts ?? defaultMaxDeliveryAttempts(env);
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  await checkCrankBudget(statePath, crankBudget);
  const started = spawnSupervisorChild(
    { ...options, maxDeliveryAttempts },
    { env, stdout: 'pipe', stderr: 'tail' },
  );
  const { socketPath, pid } = await started.served;
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    closing ??= (async () => {
      if (started.running()) {
        started.child.kill('SIGTERM');
        const timer = setTimeout(() => started.child.kill('SIGKILL'), 60_000);
        await started.exited;
        clearTimeout(timer);
      } else await started.exited;
      const record = await readServeRecord(statePath);
      if (record?.status !== 'clean')
        throw Error(
          `the supervisor for ${statePath} did not stop cleanly: ${started.stderrTail().slice(-2000)}`,
        );
    })();
    return closing;
  };
  return harden({
    socketPath,
    pid,
    stopped: started.exited.then(() => undefined),
    close,
    /** SIGKILL the supervisor, as a crash would. */
    kill: async () => {
      if (started.running()) started.child.kill('SIGKILL');
      await started.exited;
    },
    crankBudget,
    maxDeliveryAttempts,
  });
};

/**
 * Serve in this process: only the supervisor child does this, from an
 * environment `spawnSupervisorChild` made.
 * @param {ServeOptions} options
 */
const serveInProcess = async ({
  statePath,
  crankBudget,
  idleSleepMs,
  snapshotEveryDeliveries,
  maxDeliveryAttempts,
}) => {
  const extra = unexpectedEnvironment(process.env);
  if (extra.length)
    throw Error(
      `the supervisor child must run from the allowlisted environment (scripts/serve.mjs spawnSupervisorChild); it also has ${extra.join(', ')}`,
    );
  const [{ serveThixotrope }, { makeNodePowers }] = await Promise.all([
    import('@endo/thixotrope/supervisor.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const floor = await checkCrankBudget(statePath, crankBudget);
  const allowed = allowlistEnvironment(process.env, {
    crankBudget,
    maxDeliveryAttempts,
  });
  const powers = makeNodePowers();
  const probeDir = allowed.THIX_HARNESS_FORWARD_PROBE_DIR;
  if (probeDir && !path.isAbsolute(probeDir))
    throw Error('The forward probe directory must be absolute');
  const platform = {
    ...powers,
    ...(probeDir && {
      processes: (
        await import('../perf/_forward-worker.mjs')
      ).observeForwardWorkers(powers.processes, probeDir),
    }),
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

/**
 * Call `onGone` once when the process holding the other end of the pipe on
 * `fd` dies (end-of-file, close or error on the read end). The watch does
 * not keep this process alive.
 * @param {number} fd
 * @param {() => void} onGone
 */
export const watchParent = (fd, onGone) => {
  const socket = new net.Socket({ fd, readable: true, writable: false });
  let fired = false;
  const gone = () => {
    if (fired) return;
    fired = true;
    onGone();
  };
  socket.on('data', () => {});
  socket.once('end', gone);
  socket.once('close', gone);
  socket.once('error', gone);
  socket.unref();
  return socket;
};

/**
 * @param {ServeOptions} options
 * @param {number | undefined} parentFd
 */
const runChild = async (options, parentFd) => {
  // A parent that died leaves our stdout and stderr pipes broken.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const served = await serveInProcess(options);
  const stop = () => {
    void served.close().catch(error => {
      process.stderr.write(`serve: ${error.message}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (parentFd !== undefined)
    watchParent(parentFd, () => {
      process.stderr.write('serve: parent process gone; stopping\n');
      setTimeout(() => {
        process.stderr.write('serve: clean stop timed out; exiting\n');
        process.exit(1);
      }, PARENT_GONE_GRACE_MS).unref();
      stop();
    });
  process.stdout.write(
    `${JSON.stringify({ serving: served.socketPath, crankBudget: String(served.crankBudget), pid: process.pid })}\n`,
  );
  await served.stopped;
  await served.close();
};

/** @param {string[]} argv */
const main = async argv => {
  if (argv[0] === CHILD_FLAG) {
    let rest = argv.slice(1);
    /** @type {number | undefined} */
    let parentFd;
    if (rest[0]?.startsWith(PARENT_FD_FLAG)) {
      parentFd = Number(rest[0].slice(PARENT_FD_FLAG.length));
      rest = rest.slice(1);
    }
    await runChild(parseServeArgs(rest), parentFd);
    return;
  }
  const options = parseServeArgs(argv);
  await checkStateLocation(options);
  // Refuse in the parent too, before any process starts.
  await checkCrankBudget(options.statePath, options.crankBudget);
  const started = spawnSupervisorChild(options, {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  /** @param {NodeJS.Signals} signal */
  const forward = signal => started.child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  const { code, signal } = await started.exited;
  process.exitCode = code ?? (signal ? 128 : 1);
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
