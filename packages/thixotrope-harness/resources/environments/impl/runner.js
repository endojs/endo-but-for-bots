// @ts-check
/**
 * The environments adapter's runner (contract `designs/m6-interfaces.md`
 * D-M6-3, D-M6-8, 4.2, 4.4, 4.7, 5.2): one per adapter incarnation, over
 * one `Runtime` (`runtime-fake.js`, `runtime-oci.js`). It owns when an
 * environment's container runs:
 *
 * - **lazy start**: nothing runs until a key's first command; then the
 *   workspace is ensured (`layout.ensureWorkspace`), home is made, and
 *   `runtime.start(env)` runs once (concurrent first commands share it);
 * - **idle stop** (D-16): `idleStopMs` after the last command of a key
 *   ends, the key is stopped (an adapter timer: it dies with the process,
 *   and the next bind's sweep stops what it left);
 * - **stop**, **release**, **sweep**: kill every command and stop the
 *   container (cancel, emergency stop); also remove it (delete); stop and
 *   remove everything this state owns (bind, after a SIGKILL);
 * - **a failed stop is retried** (R4-81 as improved, D-16): the key is owed
 *   a stop, performed before it runs again (and by the next bind's sweep);
 *   the session is never quarantined;
 * - **the allowlist and the timeout** on every command, whichever path it
 *   came by (the shell port also checks the model's JSON; the exec path
 *   reaches here through `EnvironmentsOps.runCommand`).
 *
 * Retained state: one entry per started key (removed at stop), and the keys
 * owed a stop (removed when the stop succeeds); both bounded by the
 * manager's `maxEnvironments`. Errors of the start phase are rewritten to
 * `runtimeFailed` with the error code only: no host path reaches a vat
 * (D-M6-14).
 *
 * Node only (adapter).
 */
import { mkdir, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentLimits,
  environmentTextOf,
  environmentTexts,
} from '../../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */

/** @import { Timers } from '../../agent-host/impl/timers.js' */
/** @import { Runtime, RuntimeEnv, RawResult } from './runtime-fake.js' */

/**
 * @typedef {object} RunnerLayout the part of the state layout the runner
 *   uses (`layout.js`, contract 5.2)
 * @property {() => string} tag
 * @property {(key: string) => { workspace: string, home: string, run: string }} dirsOf
 * @property {(key: string) => boolean} [hasProjectSeed]
 * @property {(key: string) => Promise<void>} ensureWorkspace
 */

/**
 * @typedef {object} Runner
 * @property {(key: string, argv: string[], options?: { timeoutMs?: number }) => Promise<RawResult>} exec
 * @property {() => { allowedCommands: string[], timeoutMs: number, maxOutputBytes: number }} inspect
 * @property {(key: string) => Promise<void>} stop
 * @property {(key: string) => Promise<void>} release
 * @property {() => Promise<{ stopped: number }>} sweep
 * @property {() => number} runningCount
 */

const L = environmentLimits;

/** The manager's environment keys (`e<n>`), as directory names. */
const keyPattern = /^e[0-9]+$/;

/** @param {unknown} error */
const reasonOf = error =>
  String(/** @type {any} */ (error)?.code ?? 'start failed');

/**
 * A timeout a command may ask (exo-shell's rule, R3-47).
 * @param {unknown} ms
 */
const isTimeout = ms =>
  typeof ms === 'number' &&
  Number.isSafeInteger(ms) &&
  ms > 0 &&
  ms <= L.maxCommandTimeoutMs;

/**
 * The directory holding every key's directories (5.1
 * `<state>/environments/sessions/`): two levels above a key's run
 * directory, read from the layout rather than rebuilt here.
 * @param {RunnerLayout} layout
 */
const sessionsDirOf = layout => dirname(dirname(layout.dirsOf('e0').run));

/**
 * @param {object} options
 * @param {Runtime} options.runtime
 * @param {any} options.settings the resource's `EnvironmentSettings`
 * @param {RunnerLayout} options.layout
 * @param {Pick<Timers, 'after'>} options.timers adapter timers
 * @returns {Runner}
 */
export const makeRunner = ({ runtime, settings, layout, timers }) => {
  const allowedCommands = harden([...settings.allowedCommands]);
  const allowed = new Set(allowedCommands);
  const defaultTimeoutMs =
    settings.defaultTimeoutMs ?? L.defaultCommandTimeoutMs;
  const idleStopMs = settings.idleStopMs ?? L.idleStopMs;

  /**
   * @typedef {object} Entry
   * @property {RuntimeEnv} env
   * @property {Promise<void>} started
   * @property {number} inFlight
   * @property {(() => void) | undefined} cancelIdle
   */
  /** @type {Map<string, Entry>} started keys */
  const entries = new Map();
  /** @type {Map<string, Promise<void>>} stops in progress */
  const stopping = new Map();
  /** @type {Set<string>} keys whose last stop failed */
  const owed = new Set();

  /** @param {string} key */
  const envOf = key => {
    const tag = layout.tag();
    const { workspace, home, run } = layout.dirsOf(key);
    return harden({
      key,
      name: `thix-${tag}-${key}`,
      tag,
      workspace,
      home,
      run,
      settings,
      ...(layout.hasProjectSeed?.(key) && { project: true }),
    });
  };

  /** @param {RuntimeEnv} env */
  const startEnv = async env => {
    try {
      if (owed.has(env.key)) {
        await runtime.stop(env);
        owed.delete(env.key);
      }
      await layout.ensureWorkspace(env.key);
      await mkdir(env.home, { recursive: true, mode: 0o700 });
      await runtime.start(env);
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- a cause would carry the host path to the vat
      throw Error(environmentTextOf.runtimeFailed(reasonOf(error)));
    }
  };

  /** @param {string} key */
  const entryOf = key => {
    const found = entries.get(key);
    if (found !== undefined) return found;
    const env = envOf(key);
    /** @type {Entry} */
    const entry = {
      env,
      started: startEnv(env),
      inFlight: 0,
      cancelIdle: undefined,
    };
    entries.set(key, entry);
    entry.started.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return entry;
  };

  /**
   * @param {string} key
   * @param {Entry} entry
   */
  const scheduleIdleStop = (key, entry) => {
    entry.cancelIdle = timers.after(idleStopMs, () => {
      if (entries.get(key) !== entry || entry.inFlight > 0) return;
      // A failure leaves the key owed: retried before it runs again.
      stop(key).catch(() => {});
    });
  };

  /** @param {string} key */
  const stop = key => {
    const running = stopping.get(key);
    if (running !== undefined) return running;
    const entry = entries.get(key);
    if (entry === undefined && !owed.has(key)) return Promise.resolve();
    entries.delete(key);
    entry?.cancelIdle?.();
    const env = entry?.env ?? envOf(key);
    const done = (async () => {
      // A start in progress finishes first, so its container is stopped too.
      await entry?.started.catch(() => {});
      try {
        await runtime.stop(env);
        owed.delete(key);
      } catch (error) {
        owed.add(key);
        // eslint-disable-next-line preserve-caught-error -- a cause would carry the host path to the vat
        throw Error(environmentTextOf.runtimeFailed(reasonOf(error)));
      }
    })();
    stopping.set(key, done);
    const clear = () => {
      if (stopping.get(key) === done) stopping.delete(key);
    };
    done.then(clear, clear);
    return done;
  };

  /** @type {Runner['exec']} */
  const exec = async (key, argv, { timeoutMs = defaultTimeoutMs } = {}) => {
    const [program] = argv;
    if (typeof program !== 'string' || !allowed.has(program)) {
      throw Error(environmentTextOf.notAllowed(String(program)));
    }
    if (!isTimeout(timeoutMs)) throw Error(environmentTexts.timeoutInvalid);
    await stopping.get(key)?.catch(() => {});
    const entry = entryOf(key);
    entry.inFlight += 1;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    try {
      await entry.started;
      return await runtime.exec(entry.env, harden([...argv]), {
        timeoutMs,
        killGraceMs: L.killGraceMs,
        streamBytes: L.streamBytes,
      });
    } finally {
      entry.inFlight -= 1;
      if (entry.inFlight === 0 && entries.get(key) === entry) {
        scheduleIdleStop(key, entry);
      }
    }
  };

  /** @param {string} key */
  const release = async key => {
    await stop(key);
    try {
      await runtime.remove(envOf(key));
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- a cause would carry the host path to the vat
      throw Error(environmentTextOf.runtimeFailed(reasonOf(error)));
    }
  };

  const sweep = async () => {
    for (const entry of entries.values()) entry.cancelIdle?.();
    entries.clear();
    const sessions = sessionsDirOf(layout);
    /** @type {string[]} */
    let names = [];
    try {
      names = await readdir(sessions);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
    }
    const runDirs = names
      .filter(name => keyPattern.test(name))
      .map(name => layout.dirsOf(name).run);
    const answer = await runtime.sweep(layout.tag(), { runDirs });
    owed.clear();
    return answer;
  };

  return harden({
    exec,
    inspect: () =>
      harden({
        allowedCommands,
        timeoutMs: defaultTimeoutMs,
        maxOutputBytes: L.streamBytes,
      }),
    stop,
    release,
    sweep,
    runningCount: () => entries.size,
  });
};
harden(makeRunner);
