#!/usr/bin/env node
// @ts-check
/**
 * The run lock: one Ironhorse workload at a time on this machine
 * (architecture.md section 10). Integration tests, spikes and perf checks
 * take it; parallel builders wait for it.
 *
 * The lock is `tmp/.run.lock` under this package, created with O_EXCL and
 * holding `{"pid","label","at"}`. A lock whose holder pid is gone is stale
 * and is broken; a lock file that cannot be parsed (a holder that died
 * between create and write) is stale once it is older than `unreadableMs`.
 * Breaking happens under a second O_EXCL file, `.run.lock.break`, so two
 * waiters never both break and one of them never removes the other's fresh
 * lock.
 *
 * Re-entry: a command run under the lock sees THIX_HARNESS_RUN_LOCK=<pid>;
 * a nested taker whose variable names the current holder passes through
 * without waiting (the PM holds the lock for sign-off runs that themselves
 * call scripts taking it).
 *
 * Usage:
 *   node scripts/run-lock.mjs [--label NAME] [--timeout-ms N] -- command [args...]
 */
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const defaultLockPath = path.resolve(here, '..', 'tmp', '.run.lock');
export const RUN_LOCK_ENV = 'THIX_HARNESS_RUN_LOCK';

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
 * @param {string} file
 * @returns {Promise<{ holder?: { pid: number, label?: string, at?: string }, mtimeMs?: number } | undefined>}
 *   undefined when the file does not exist
 */
const readHolder = async file => {
  try {
    const [text, info] = await Promise.all([
      readFile(file, 'utf8'),
      stat(file),
    ]);
    try {
      const holder = JSON.parse(text);
      if (Number.isInteger(holder?.pid))
        return { holder, mtimeMs: info.mtimeMs };
    } catch {
      // Unreadable: the creator died before writing, or is writing now.
    }
    return { mtimeMs: info.mtimeMs };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return undefined;
    throw error;
  }
};

/**
 * Create `file` exclusively with `content`; false if it exists.
 * @param {string} file
 * @param {string} content
 */
const createExclusive = async (file, content) => {
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST')
      return false;
    throw error;
  }
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
};

/**
 * @typedef {object} RunLockOptions
 * @property {string} [lockPath]
 * @property {string} [label]
 * @property {number} [pollMs] how often a waiter looks again
 * @property {number} [timeoutMs] give up after this long (default: never)
 * @property {number} [unreadableMs] age after which an unparsable lock is stale
 * @property {(pid: number) => boolean} [isAlive]
 * @property {number} [pid] the holder pid to record (default: this process)
 * @property {Record<string, string | undefined>} [env] for re-entry
 * @property {(event: object) => void} [onEvent] waiting / broke-stale notices
 */

/**
 * @typedef {object} RunLock
 * @property {string} lockPath
 * @property {boolean} reentrant true when an enclosing holder's lock was reused
 * @property {number} waitedMs
 * @property {() => Promise<void>} release removes the lock if it is still ours
 */

/**
 * Break a stale lock, under the break file so only one waiter breaks.
 * @param {string} lockPath
 * @param {(holder: Awaited<ReturnType<typeof readHolder>>) => boolean} isStale
 * @param {(pid: number) => boolean} isAlive
 * @param {number} unreadableMs
 */
const breakStale = async (lockPath, isStale, isAlive, unreadableMs) => {
  const breakPath = `${lockPath}.break`;
  const mine = JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
  });
  if (!(await createExclusive(breakPath, mine))) {
    // Another waiter is breaking. If that breaker died, its file is stale too.
    const breaker = await readHolder(breakPath);
    const breakerGone = breaker?.holder
      ? !isAlive(breaker.holder.pid)
      : breaker !== undefined &&
        Date.now() - (breaker.mtimeMs ?? 0) > unreadableMs;
    if (breakerGone) await unlink(breakPath).catch(() => {});
    return false;
  }
  try {
    // Re-read under the break file: the lock may have been released and
    // taken afresh since we judged it.
    const current = await readHolder(lockPath);
    if (current === undefined || !isStale(current)) return false;
    // Rename first so a reader never sees a half-removed lock.
    const aside = `${lockPath}.stale-${process.pid}`;
    await rename(lockPath, aside);
    await unlink(aside).catch(() => {});
    return true;
  } finally {
    await unlink(breakPath).catch(() => {});
  }
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
  pid = process.pid,
  env = process.env,
  onEvent = () => {},
} = {}) => {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const start = Date.now();
  const enclosing = Number(env[RUN_LOCK_ENV]);
  /** @param {Awaited<ReturnType<typeof readHolder>>} found */
  const isStale = found =>
    found !== undefined &&
    (found.holder
      ? !isAlive(found.holder.pid)
      : Date.now() - (found.mtimeMs ?? 0) > unreadableMs);
  let announced = false;
  for (;;) {
    const content = JSON.stringify({
      pid,
      label,
      at: new Date().toISOString(),
    });
    if (await createExclusive(lockPath, content)) {
      return {
        lockPath,
        reentrant: false,
        waitedMs: Date.now() - start,
        release: async () => {
          const found = await readHolder(lockPath);
          if (found?.holder?.pid === pid) await unlink(lockPath);
        },
      };
    }
    const found = await readHolder(lockPath);
    // A lock released between our create and our read: try again at once.
    if (found !== undefined) {
      if (
        found.holder &&
        Number.isInteger(enclosing) &&
        enclosing > 0 &&
        found.holder.pid === enclosing &&
        isAlive(enclosing)
      ) {
        return {
          lockPath,
          reentrant: true,
          waitedMs: Date.now() - start,
          release: async () => {},
        };
      }
      let broke = false;
      if (isStale(found)) {
        broke = await breakStale(lockPath, isStale, isAlive, unreadableMs);
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
  const holder = lock.reentrant
    ? process.env[RUN_LOCK_ENV]
    : String(process.pid);
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [RUN_LOCK_ENV]: holder },
  });
  /** @param {NodeJS.Signals} signal */
  const forward = signal => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
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
