#!/usr/bin/env node
// @ts-check
/**
 * The run lock: one Ironhorse workload at a time on this machine
 * (architecture.md section 10). Integration tests, spikes and perf checks
 * take it; parallel builders wait for it.
 *
 * The lock is `tmp/.run.lock` under this package. Its record is
 *
 *   {"version":2,"id","pid","startedAt","label","at",
 *    "workload":{"pid","startedAt"}}
 *
 * `id` is a random nonce naming this taking of the lock (its generation).
 * `pid`/`startedAt` is the taker; `workload` is the command the CLI runs
 * under the lock, recorded as soon as it is spawned. A process is the same
 * process only when its pid exists and its start time (`ps -o lstart`)
 * matches the recorded one, so a reused pid does not keep a lock alive.
 * The lock is held while the taker OR the workload is alive: a CLI wrapper
 * killed with SIGKILL leaves its workload running, and the lock with it.
 *
 * Creation is atomic with its content: the record is written to a private
 * temporary file and hard-linked to the lock path (link fails with EEXIST
 * when the lock exists), so a reader never sees an empty lock.
 *
 * Takeover of a stale lock is a compare-and-delete on its generation. A
 * taker that judges generation G stale must first create the break token
 * `.run.lock.break-<G>-<k>` exclusively (k = 0, 1, ...; it moves on to k+1
 * only when the owner of token k is dead). Holding the token, it re-reads
 * the lock and deletes it only if it is still generation G and still
 * stale. Only a token holder can delete generation G, and a token is moved
 * past only when its owner is dead, so at most one live process deletes G
 * and no taker ever deletes a later generation or a lock whose holder is
 * alive. The deleter then removes G's tokens; a late taker that judged G
 * stale earlier finds the lock no longer G and backs off.
 *
 * Re-entry: a command run under the lock sees THIX_HARNESS_RUN_LOCK=<id>;
 * a nested taker whose variable names the current generation, held by a
 * live process, passes through without waiting (the PM holds the lock for
 * sign-off runs that themselves call scripts taking it).
 *
 * Usage:
 *   node scripts/run-lock.mjs [--label NAME] [--timeout-ms N] -- command [args...]
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const defaultLockPath = path.resolve(here, '..', 'tmp', '.run.lock');
export const RUN_LOCK_ENV = 'THIX_HARNESS_RUN_LOCK';
export const LOCK_VERSION = 2;
/** Break tokens a taker walks past (owners dead) before it gives up a round. */
const MAX_BREAK_TOKENS = 64;

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const nonce = () => randomBytes(12).toString('hex');

/**
 * Whether a process with this pid exists (EPERM means it exists but is not
 * ours, which still holds the lock).
 * @param {number} pid
 */
export const isProcessAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
};

/**
 * A process's start time as `ps -o lstart=` prints it, or undefined when
 * it cannot be read (no such process, no ps).
 * @param {number} pid
 * @returns {string | undefined}
 */
export const processStartTime = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .replace(/\s+/g, ' ');
    return text || undefined;
  } catch {
    return undefined;
  }
};

/**
 * @typedef {object} ProcessRef
 * @property {number} pid
 * @property {string} [startedAt] `ps -o lstart` of the process when recorded
 */

/**
 * @typedef {object} LockRecord
 * @property {number} [version]
 * @property {string} [id] the generation nonce (absent in version 1 locks)
 * @property {number} pid the taker
 * @property {string} [startedAt]
 * @property {string} [label]
 * @property {string} [at]
 * @property {ProcessRef} [workload] the command run under the lock
 */

/**
 * @typedef {object} Liveness
 * @property {(pid: number) => boolean} isAlive
 * @property {(pid: number) => string | undefined} startTimeOf
 */

/**
 * The recorded process is still running: its pid exists and, when a start
 * time was recorded and can be read now, it is the same one.
 * @param {ProcessRef | undefined} ref
 * @param {Liveness} liveness
 */
export const isSameProcessAlive = (ref, { isAlive, startTimeOf }) => {
  if (!ref || !isAlive(ref.pid)) return false;
  if (ref.startedAt === undefined) return true;
  const now = startTimeOf(ref.pid);
  // Unreadable now: it exists, so assume it is the one recorded.
  return now === undefined || now === ref.startedAt;
};

/**
 * The lock is held while its taker or its workload runs.
 * @param {LockRecord} record
 * @param {Liveness} liveness
 */
export const isRecordAlive = (record, liveness) =>
  isSameProcessAlive(record, liveness) ||
  isSameProcessAlive(record.workload, liveness);

/**
 * @typedef {object} Found
 * @property {LockRecord} [holder] the parsed record, when it parses
 * @property {string} generation the record's id, or the file's identity
 * @property {number} mtimeMs
 */

/**
 * @param {string} file
 * @returns {Promise<Found | undefined>} undefined when the file does not exist
 */
const readHolder = async file => {
  let text;
  let info;
  try {
    // Open once so the text and the identity are of the same file.
    const handle = await open(file, 'r');
    try {
      info = await handle.stat();
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return undefined;
    throw error;
  }
  const identity = `i${info.dev}-${info.ino}`;
  try {
    const holder = JSON.parse(text);
    if (Number.isInteger(holder?.pid)) {
      const id =
        typeof holder.id === 'string' && /^[0-9a-f]{8,64}$/.test(holder.id)
          ? holder.id
          : identity;
      return { holder, generation: id, mtimeMs: info.mtimeMs };
    }
  } catch {
    // Unreadable: a version 1 taker died between create and write.
  }
  return { generation: identity, mtimeMs: info.mtimeMs };
};

/**
 * Create `file` with `content` atomically and exclusively: write a private
 * temporary file, then hard-link it to `file`. False when `file` exists.
 * @param {string} file
 * @param {string} content
 */
const createExclusive = async (file, content) => {
  const temporary = `${file}.n${nonce()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, file);
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST')
        return false;
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
};

/**
 * Replace `file`'s content atomically (temporary file and rename).
 * @param {string} file
 * @param {string} content
 */
const replaceAtomic = async (file, content) => {
  const temporary = `${file}.n${nonce()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
};

/**
 * @typedef {object} RunLockOptions
 * @property {string} [lockPath]
 * @property {string} [label]
 * @property {number} [pollMs] how often a waiter looks again
 * @property {number} [timeoutMs] give up after this long (default: never)
 * @property {number} [unreadableMs] age after which an unparsable lock is stale
 * @property {(pid: number) => boolean} [isAlive]
 * @property {(pid: number) => string | undefined} [startTimeOf]
 * @property {number} [pid] the taker pid to record (default: this process)
 * @property {Record<string, string | undefined>} [env] for re-entry
 * @property {(event: object) => void} [onEvent] waiting / broke-stale notices
 */

/**
 * @typedef {object} RunLock
 * @property {string} lockPath
 * @property {string | undefined} id this generation (the enclosing one when reentrant)
 * @property {boolean} reentrant true when an enclosing holder's lock was reused
 * @property {number} waitedMs
 * @property {(pid: number) => Promise<void>} recordWorkload record the
 *   command run under the lock, so the lock outlives a killed taker
 * @property {() => Promise<void>} release removes the lock if it is still ours
 */

/**
 * Delete generation `generation` of the lock if it is still that generation
 * and still stale, holding that generation's break token.
 * @param {string} lockPath
 * @param {string} generation
 * @param {(found: Found) => boolean} isStale
 * @param {Liveness} liveness
 * @param {number} unreadableMs
 * @param {ProcessRef} self
 * @returns {Promise<boolean>} true when this call deleted the lock
 */
const breakStale = async (
  lockPath,
  generation,
  isStale,
  liveness,
  unreadableMs,
  self,
) => {
  const prefix = `${path.basename(lockPath)}.break-${generation}-`;
  const dir = path.dirname(lockPath);
  const content = JSON.stringify({ ...self, at: new Date().toISOString() });
  for (let k = 0; k < MAX_BREAK_TOKENS; k += 1) {
    const token = path.join(dir, `${prefix}${k}`);
    if (await createExclusive(token, content)) {
      let deleted = false;
      try {
        const current = await readHolder(lockPath);
        if (
          current !== undefined &&
          current.generation === generation &&
          isStale(current)
        ) {
          await unlink(lockPath);
          deleted = true;
        }
      } finally {
        const after = await readHolder(lockPath).catch(() => undefined);
        if (after === undefined || after.generation !== generation) {
          // Generation G is gone for good: clear every token for it.
          const names = await readdir(dir).catch(() => []);
          for (const name of names)
            // Tokens only: another breaker's temporary file is its own.
            if (
              name.startsWith(prefix) &&
              /^\d+$/.test(name.slice(prefix.length))
            )
              await unlink(path.join(dir, name)).catch(() => {});
        } else {
          await unlink(token).catch(() => {});
        }
      }
      return deleted;
    }
    // Token k is taken. Its owner, if alive, is breaking G now.
    const owner = await readHolder(token);
    if (owner === undefined) return false; // G was just cleared: look again
    const ownerGone = owner.holder
      ? !isSameProcessAlive(owner.holder, liveness)
      : Date.now() - owner.mtimeMs > unreadableMs;
    if (!ownerGone) return false;
  }
  return false;
};

/** @type {Map<number, string | undefined>} */
const startTimes = new Map();
/**
 * @param {number} pid
 * @param {(pid: number) => string | undefined} startTimeOf
 */
const ownStartTime = (pid, startTimeOf) => {
  if (!startTimes.has(pid)) startTimes.set(pid, startTimeOf(pid));
  return startTimes.get(pid);
};

/**
 * Take the run lock, waiting while another live process holds it.
 * @param {RunLockOptions} [options]
 * @returns {Promise<RunLock>}
 */
export const acquireRunLock = async ({
  lockPath = defaultLockPath,
  label = path.basename(process.argv[1] ?? 'node'),
  pollMs = 500,
  timeoutMs = Infinity,
  unreadableMs = 10_000,
  isAlive = isProcessAlive,
  startTimeOf = processStartTime,
  pid = process.pid,
  env = process.env,
  onEvent = () => {},
} = {}) => {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const liveness = { isAlive, startTimeOf };
  const start = Date.now();
  const enclosing = env[RUN_LOCK_ENV];
  const self = { pid, startedAt: ownStartTime(pid, startTimeOf) };
  /** @param {Found} found */
  const isStale = found =>
    found.holder
      ? !isRecordAlive(found.holder, liveness)
      : Date.now() - found.mtimeMs > unreadableMs;
  let announced = false;
  for (;;) {
    const id = nonce();
    /** @type {LockRecord} */
    const record = {
      version: LOCK_VERSION,
      id,
      ...self,
      label,
      at: new Date().toISOString(),
    };
    if (await createExclusive(lockPath, JSON.stringify(record))) {
      /** @param {LockRecord} next */
      const ifOurs = async next => {
        const found = await readHolder(lockPath);
        // Only a breaker of this generation could change it, and none acts
        // while this process is alive.
        if (found?.generation !== id) return false;
        await replaceAtomic(lockPath, JSON.stringify(next));
        return true;
      };
      return {
        lockPath,
        id,
        reentrant: false,
        waitedMs: Date.now() - start,
        recordWorkload: async workloadPid => {
          record.workload = {
            pid: workloadPid,
            startedAt: startTimeOf(workloadPid),
          };
          await ifOurs(record);
        },
        release: async () => {
          const found = await readHolder(lockPath);
          if (found?.generation === id) await unlink(lockPath);
        },
      };
    }
    const found = await readHolder(lockPath);
    // A lock released between our create and our read: try again at once.
    if (found !== undefined) {
      if (
        found.holder &&
        enclosing &&
        found.holder.id === enclosing &&
        isRecordAlive(found.holder, liveness)
      ) {
        return {
          lockPath,
          id: enclosing,
          reentrant: true,
          waitedMs: Date.now() - start,
          recordWorkload: async () => {},
          release: async () => {},
        };
      }
      let broke = false;
      if (isStale(found)) {
        broke = await breakStale(
          lockPath,
          found.generation,
          isStale,
          liveness,
          unreadableMs,
          self,
        );
        if (broke)
          onEvent({ event: 'brokeStale', holder: found.holder ?? null });
      } else if (!announced) {
        announced = true;
        onEvent({ event: 'waiting', holder: found.holder ?? null });
      }
      if (!broke) {
        if (Date.now() - start > timeoutMs)
          throw Error(
            `Run lock ${lockPath} still held after ${timeoutMs} ms by ${JSON.stringify(found.holder ?? null)}`,
          );
        await delay(pollMs);
      }
    }
  }
};

/**
 * Run `fn` holding the run lock.
 * @template T
 * @param {RunLockOptions} options
 * @param {(lock: RunLock) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export const withRunLock = async (options, fn) => {
  const lock = await acquireRunLock(options);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
};

/** @param {string[]} argv */
export const parseRunLockArgs = argv => {
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1)
    throw Error(
      'Usage: run-lock.mjs [--label NAME] [--timeout-ms N] -- command [args...]',
    );
  const own = argv.slice(0, split);
  const command = argv.slice(split + 1);
  /** @type {{ label?: string, timeoutMs?: number, lockPath?: string }} */
  const options = {};
  for (let i = 0; i < own.length; i += 1) {
    const arg = own[i];
    const value = own[i + 1];
    if (value === undefined) throw Error(`${arg} needs a value`);
    i += 1;
    if (arg === '--label') options.label = value;
    else if (arg === '--lock') options.lockPath = path.resolve(value);
    else if (arg === '--timeout-ms') {
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms < 0)
        throw Error('--timeout-ms takes a whole number of milliseconds');
      options.timeoutMs = ms;
    } else throw Error(`Unknown option ${arg}`);
  }
  return { options, command };
};

/** @param {string[]} argv */
const main = async argv => {
  const { options, command } = parseRunLockArgs(argv);
  const lock = await acquireRunLock({
    label: options.label ?? command.join(' ').slice(0, 80),
    ...options,
    onEvent: event =>
      process.stderr.write(`run-lock: ${JSON.stringify(event)}\n`),
  });
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [RUN_LOCK_ENV]: lock.id },
  });
  // Recorded as soon as it exists: if this wrapper is killed, the lock stays
  // held until the workload ends.
  child.once('spawn', () => {
    if (child.pid !== undefined)
      lock.recordWorkload(child.pid).catch(error => {
        process.stderr.write(
          `run-lock: workload not recorded: ${error.message}\n`,
        );
      });
  });
  /** @param {NodeJS.Signals} signal */
  const forward = signal => child.kill(signal);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']))
    process.on(signal, forward);
  const code = await new Promise(resolve => {
    child.once('error', error => {
      process.stderr.write(`run-lock: ${error.message}\n`);
      resolve(127);
    });
    child.once('exit', (exitCode, signal) =>
      resolve(exitCode ?? (signal ? 128 : 1)),
    );
  });
  await lock.release();
  process.exitCode = /** @type {number} */ (code);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`run-lock: ${error.message}\n`);
    process.exitCode = 1;
  });
}
