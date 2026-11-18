#!/usr/bin/env node
// @ts-check
/**
 * The run lock: a machine-wide pool of slots for Ironhorse workloads
 * (architecture.md section 10). Integration tests, spikes and perf checks
 * take a slot; a performance measurement takes every slot.
 *
 * Where. The default lock lives under `<THIX_HARNESS_HOME>/run-lock/`
 * (`THIX_HARNESS_HOME` defaults to `<home>/.cache/thixotrope-harness`), so
 * every worktree on the machine shares it. It has N slots
 * (`THIX_HARNESS_RUN_SLOTS`, default 4): the files `slot`, `slot.1`, ...,
 * `slot.<N-1>`, and the exclusive intent marker `slot.intent`. Every taker
 * on the machine must use the same N. `--lock PATH` (option `lockPath`)
 * names a private lock instead: one slot at PATH unless `--slots N` says
 * more (PATH, PATH.1, ...; intent PATH.intent).
 *
 * Modes. A shared taker (the default) takes any one free slot and waits
 * while none is free. An exclusive taker (`--exclusive`; perf measurements)
 * waits until every slot is free and holds all of them. It cannot starve:
 * it first creates the intent marker, and while a live intent marker
 * exists no new shared taker takes a slot (one that took a slot just as
 * the marker appeared gives it back). The intent marker is a lock record
 * like a slot's, with the same stale-owner takeover; it is removed once the
 * exclusive taker holds every slot, so the next exclusive taker can queue.
 * A command whose arguments name a file under `perf/` ending in `.perf.mjs`
 * is exclusive by default; `--shared` overrides. In process, the same rule
 * is applied to this process's own arguments.
 *
 * Record. Each slot file holds
 *
 *   {"version":2,"id","pid","startedAt","label","at","mode","slot",
 *    "workload":{"pid","startedAt"}}
 *
 * `id` is a random nonce naming this taking (its generation; an exclusive
 * taker writes one id into every slot). `pid`/`startedAt` is the taker;
 * `workload` is the command the CLI runs under the lock, recorded as soon
 * as it is spawned. A process is the same process only when its pid exists
 * and its start time (`ps -o lstart`) matches the recorded one, so a reused
 * pid does not keep a slot alive. A slot is held while the taker OR the
 * workload is alive: a CLI wrapper killed with SIGKILL leaves its workload
 * running, and the slot with it.
 *
 * Creation is atomic with its content: the record is written to a private
 * temporary file and hard-linked to the slot path (link fails with EEXIST
 * when the slot is taken), so a reader never sees an empty slot file.
 *
 * Takeover of a stale slot (or intent marker) is a compare-and-delete on
 * its generation. A taker that judges generation G stale must first create
 * the break token `<file>.break-<G>-<k>` exclusively (k = 0, 1, ...; it
 * moves on to k+1 only when the owner of token k is dead). Holding the
 * token, it re-reads the file and deletes it only if it is still
 * generation G and still stale. Only a token holder can delete generation
 * G, and a token is moved past only when its owner is dead, so at most one
 * live process deletes G and no taker ever deletes a later generation or a
 * file whose holder is alive. The deleter then removes G's tokens; a late
 * taker that judged G stale earlier finds the file no longer G and backs
 * off.
 *
 * Re-entry: a command run under the lock sees THIX_HARNESS_RUN_LOCK=<id>; a
 * nested taker whose variable names the generation of a slot held by a
 * live process passes through without waiting, whatever mode it asks for
 * (an exclusive taker nested in a shared holder cannot get more without
 * deadlocking on its own parent). Re-entry is checked before the intent
 * marker, so a nested taker never waits behind an exclusive waiter.
 *
 * Time box (CLI). `--max-ms N` (default 600,000; `THIX_HARNESS_RUN_MAX_MS`
 * overrides the default): the workload runs in its own process group; when
 * it runs longer, the whole group gets SIGTERM, then SIGKILL 10 s later,
 * the slot is released, one line says so and the wrapper exits 124. The
 * wait for a slot does not count against the box.
 *
 * Run log (CLI). On every exit the wrapper can see (normal, time-out,
 * signal, wait time-out) it appends one JSON line to
 * `<THIX_HARNESS_HOME>/runs.jsonl` with one write on an O_APPEND file:
 * {"at","lane","agent","label","mode","slot","waitedMs","heldMs",
 *  "exitCode","timedOut"}. `lane` is the basename of the git worktree the
 * command ran in, `agent` is THIX_AGENT or null. No arguments beyond the
 * label and no absolute paths are logged. A wrapper killed with SIGKILL
 * logs nothing.
 *
 * Usage:
 *   node scripts/run-lock.mjs [--label NAME] [--timeout-ms N] [--max-ms N]
 *     [--exclusive | --shared] [--lock PATH] [--slots N] -- command [args...]
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

export const RUN_LOCK_ENV = 'THIX_HARNESS_RUN_LOCK';
export const LOCK_VERSION = 2;
export const DEFAULT_SLOTS = 4;
export const DEFAULT_MAX_MS = 600_000;
/** Between SIGTERM and SIGKILL of a timed-out workload's group. */
export const KILL_GRACE_MS = 10_000;
/** Exit code of a timed-out workload (as timeout(1)). */
export const TIMED_OUT_EXIT = 124;
/** Break tokens a taker walks past (owners dead) before it gives up a round. */
const MAX_BREAK_TOKENS = 64;

/**
 * Machine-local state: `THIX_HARNESS_HOME`, default
 * `<home>/.cache/thixotrope-harness`.
 * @param {Record<string, string | undefined>} [env]
 */
export const harnessHome = (env = process.env) =>
  env.THIX_HARNESS_HOME ||
  path.join(os.homedir(), '.cache', 'thixotrope-harness');

/** @param {Record<string, string | undefined>} [env] */
export const defaultLockPathFor = (env = process.env) =>
  path.join(harnessHome(env), 'run-lock', 'slot');

/** The machine-wide lock's first slot (the others are `<this>.<i>`). */
export const defaultLockPath = defaultLockPathFor();

/** @param {Record<string, string | undefined>} [env] */
export const runLogPath = (env = process.env) =>
  path.join(harnessHome(env), 'runs.jsonl');

/**
 * @param {string | undefined} value
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 */
const wholeNumber = (value, name, fallback, min) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw Error(`${name} must be a whole number >= ${min}, got ${value}`);
  return n;
};

/** @param {Record<string, string | undefined>} [env] */
export const slotsFromEnv = (env = process.env) =>
  wholeNumber(
    env.THIX_HARNESS_RUN_SLOTS,
    'THIX_HARNESS_RUN_SLOTS',
    DEFAULT_SLOTS,
    1,
  );

/** @param {Record<string, string | undefined>} [env] */
export const maxMsFromEnv = (env = process.env) =>
  wholeNumber(
    env.THIX_HARNESS_RUN_MAX_MS,
    'THIX_HARNESS_RUN_MAX_MS',
    DEFAULT_MAX_MS,
    1,
  );

/**
 * The slot files of a lock whose first slot is `base`.
 * @param {string} base
 * @param {number} slots
 */
export const slotPaths = (base, slots) =>
  Array.from({ length: slots }, (_, i) => (i === 0 ? base : `${base}.${i}`));

/** @param {string} base */
export const intentPath = base => `${base}.intent`;

/**
 * Whether these arguments name a perf check (a file under `perf/` ending in
 * `.perf.mjs`), which runs exclusive by default.
 * @param {readonly string[]} args
 */
export const namesPerfCheck = args =>
  args.some(arg => /(^|[/\\])perf[/\\][^/\\]+\.perf\.mjs$/.test(arg));

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
 * @property {'shared' | 'exclusive'} [mode]
 * @property {number} [slot]
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
 * A slot is held while its taker or its workload runs.
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
 * Delete `file` if it is still generation `id` (only its owner calls this,
 * and no breaker acts on a live owner's file).
 * @param {string} file
 * @param {string} id
 */
const removeIfOurs = async (file, id) => {
  const found = await readHolder(file).catch(() => undefined);
  if (found?.generation === id) await unlink(file).catch(() => {});
};

/**
 * @typedef {object} RunLockOptions
 * @property {string} [lockPath] a private lock's first slot (default: the
 *   machine-wide lock under THIX_HARNESS_HOME)
 * @property {number} [slots] default THIX_HARNESS_RUN_SLOTS (4) for the
 *   machine-wide lock, 1 for a private `lockPath`
 * @property {'shared' | 'exclusive'} [mode] default exclusive when this
 *   process's arguments name a perf check, else shared
 * @property {string} [label]
 * @property {number} [pollMs] how often a waiter looks again
 * @property {number} [timeoutMs] give up after this long (default: never)
 * @property {number} [unreadableMs] age after which an unparsable file is stale
 * @property {(pid: number) => boolean} [isAlive]
 * @property {(pid: number) => string | undefined} [startTimeOf]
 * @property {number} [pid] the taker pid to record (default: this process)
 * @property {Record<string, string | undefined>} [env] for re-entry and the defaults
 * @property {(event: object) => void} [onEvent] waiting / broke-stale notices
 */

/**
 * @typedef {object} RunLock
 * @property {string} lockPath the slot held (the first slot when exclusive)
 * @property {string | undefined} id this generation (the enclosing one when reentrant)
 * @property {boolean} reentrant true when an enclosing holder's slot was reused
 * @property {'shared' | 'exclusive'} mode
 * @property {number | 'all' | undefined} slot the slot index, 'all' when
 *   exclusive, undefined when reentrant
 * @property {number} waitedMs
 * @property {(pid: number) => Promise<void>} recordWorkload record the
 *   command run under the lock, so the slots outlive a killed taker
 * @property {() => Promise<void>} release removes the slots if still ours
 */

/**
 * Delete generation `generation` of `file` if it is still that generation
 * and still stale, holding that generation's break token.
 * @param {string} file
 * @param {string} generation
 * @param {(found: Found) => boolean} isStale
 * @param {Liveness} liveness
 * @param {number} unreadableMs
 * @param {ProcessRef} self
 * @returns {Promise<boolean>} true when this call deleted the file
 */
const breakStale = async (
  file,
  generation,
  isStale,
  liveness,
  unreadableMs,
  self,
) => {
  const prefix = `${path.basename(file)}.break-${generation}-`;
  const dir = path.dirname(file);
  const content = JSON.stringify({ ...self, at: new Date().toISOString() });
  for (let k = 0; k < MAX_BREAK_TOKENS; k += 1) {
    const token = path.join(dir, `${prefix}${k}`);
    if (await createExclusive(token, content)) {
      let deleted = false;
      try {
        const current = await readHolder(file);
        if (
          current !== undefined &&
          current.generation === generation &&
          isStale(current)
        ) {
          await unlink(file);
          deleted = true;
        }
      } finally {
        const after = await readHolder(file).catch(() => undefined);
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
 * Take the run lock (one slot, or every slot when exclusive), waiting while
 * live processes hold what is needed.
 * @param {RunLockOptions} [options]
 * @returns {Promise<RunLock>}
 */
export const acquireRunLock = async ({
  lockPath,
  slots,
  mode,
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
  const base = lockPath ?? defaultLockPathFor(env);
  const count = slots ?? (lockPath === undefined ? slotsFromEnv(env) : 1);
  if (!Number.isInteger(count) || count < 1)
    throw Error(`slots must be a whole number >= 1, got ${count}`);
  const wanted =
    mode ?? (namesPerfCheck(process.argv) ? 'exclusive' : 'shared');
  const paths = slotPaths(base, count);
  const intent = intentPath(base);
  await mkdir(path.dirname(base), { recursive: true, mode: 0o700 });
  const liveness = { isAlive, startTimeOf };
  const start = Date.now();
  const enclosing = env[RUN_LOCK_ENV];
  const self = { pid, startedAt: ownStartTime(pid, startTimeOf) };
  /** @param {Found} found */
  const isStale = found =>
    found.holder
      ? !isRecordAlive(found.holder, liveness)
      : Date.now() - found.mtimeMs > unreadableMs;
  /**
   * @param {string} file
   * @param {Found} found
   */
  const tryBreak = async (file, found) => {
    const broke = await breakStale(
      file,
      found.generation,
      isStale,
      liveness,
      unreadableMs,
      self,
    );
    if (broke)
      onEvent({
        event: 'brokeStale',
        holder: found.holder ?? null,
        ...(file === intent ? { intent: true } : {}),
      });
    return broke;
  };
  let announced = false;
  /**
   * @param {Found | undefined} found
   * @param {boolean} [byIntent]
   */
  const announce = (found, byIntent = false) => {
    if (announced) return;
    announced = true;
    onEvent({
      event: 'waiting',
      holder: found?.holder ?? null,
      ...(byIntent ? { intent: true } : {}),
    });
  };
  const id = nonce();
  /**
   * @param {number} slot
   * @returns {LockRecord}
   */
  const recordFor = slot => ({
    version: LOCK_VERSION,
    id,
    ...self,
    label,
    at: new Date().toISOString(),
    mode: wanted,
    slot,
  });
  /**
   * Slots this taker holds, by index.
   * @type {Map<number, LockRecord>}
   */
  const held = new Map();
  let intentHeld = false;
  const releaseAll = async () => {
    for (const slot of held.keys()) await removeIfOurs(paths[slot], id);
    held.clear();
    if (intentHeld) await removeIfOurs(intent, id);
    intentHeld = false;
  };
  /**
   * @param {number | 'all'} slot
   * @returns {RunLock}
   */
  const handle = slot => ({
    lockPath: paths[slot === 'all' ? 0 : slot],
    id,
    reentrant: false,
    mode: wanted,
    slot,
    waitedMs: Date.now() - start,
    recordWorkload: async workloadPid => {
      const workload = {
        pid: workloadPid,
        startedAt: startTimeOf(workloadPid),
      };
      for (const [index, record] of held) {
        record.workload = workload;
        // Only a breaker of this generation could change a slot, and none
        // acts while this process is alive.
        const found = await readHolder(paths[index]);
        if (found?.generation === id)
          await replaceAtomic(paths[index], JSON.stringify(record));
      }
    },
    release: releaseAll,
  });
  const giveUp = async (/** @type {unknown} */ holder) => {
    await releaseAll();
    throw Error(
      `Run lock ${base} still held after ${timeoutMs} ms by ${JSON.stringify(holder ?? null)}`,
    );
  };
  try {
    for (;;) {
      /** @type {(Found | undefined)[]} */
      const seen = [];
      for (const file of paths) seen.push(await readHolder(file));
      if (enclosing) {
        const outer = seen.find(
          found =>
            found?.holder &&
            found.holder.id === enclosing &&
            isRecordAlive(found.holder, liveness),
        );
        if (outer) {
          return {
            lockPath: base,
            id: enclosing,
            reentrant: true,
            mode: outer.holder?.mode ?? 'shared',
            slot: undefined,
            waitedMs: Date.now() - start,
            recordWorkload: async () => {},
            release: async () => {},
          };
        }
      }
      let progressed = false;
      /** @type {unknown} */
      let blocker;
      if (wanted === 'shared') {
        const marker = await readHolder(intent);
        if (marker !== undefined) {
          blocker = marker.holder;
          if (isStale(marker)) progressed = await tryBreak(intent, marker);
          else announce(marker, true);
        } else {
          for (let i = 0; i < count && held.size === 0; i += 1) {
            const record = recordFor(i);
            if (await createExclusive(paths[i], JSON.stringify(record)))
              held.set(i, record);
          }
          if (held.size) {
            const [slot] = held.keys();
            // An exclusive taker queued meanwhile: give the slot back.
            const late = await readHolder(intent);
            if (late === undefined || isStale(late)) return handle(slot);
            await releaseAll();
            blocker = late.holder;
            announce(late, true);
          } else {
            /** @type {Found | undefined} */
            let live;
            for (let i = 0; i < count; i += 1) {
              const found = await readHolder(paths[i]);
              if (found === undefined) {
                progressed = true; // freed meanwhile: look again at once
              } else if (isStale(found)) {
                if (await tryBreak(paths[i], found)) progressed = true;
              } else {
                live ??= found;
              }
            }
            blocker = live?.holder;
            if (!progressed) announce(live);
          }
        }
      } else {
        if (!intentHeld) {
          const record = { ...recordFor(-1), slot: undefined };
          intentHeld = await createExclusive(intent, JSON.stringify(record));
          if (!intentHeld) {
            const marker = await readHolder(intent);
            if (marker === undefined) progressed = true;
            else if (isStale(marker))
              progressed = await tryBreak(intent, marker);
            else {
              blocker = marker.holder;
              announce(marker, true);
            }
          }
        }
        if (intentHeld) {
          for (let i = 0; i < count; i += 1) {
            const record = recordFor(i);
            if (held.has(i)) {
              // Already ours.
            } else if (
              await createExclusive(paths[i], JSON.stringify(record))
            ) {
              held.set(i, record);
            } else {
              const found = await readHolder(paths[i]);
              if (found === undefined) progressed = true;
              else if (isStale(found) && (await tryBreak(paths[i], found)))
                progressed = true;
              else {
                blocker ??= found.holder;
                announce(found);
              }
            }
          }
          if (held.size === count) {
            // Every slot is ours: the next exclusive taker may queue.
            await removeIfOurs(intent, id);
            intentHeld = false;
            return handle('all');
          }
        }
      }
      if (!progressed) {
        if (Date.now() - start > timeoutMs) await giveUp(blocker);
        await delay(pollMs);
      }
    }
  } catch (error) {
    await releaseAll();
    throw error;
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

const USAGE =
  'Usage: run-lock.mjs [--label NAME] [--timeout-ms N] [--max-ms N] [--exclusive | --shared] [--lock PATH] [--slots N] -- command [args...]';

/**
 * The options named on the command line only (defaults are applied by the
 * caller).
 * @param {string[]} argv
 */
export const parseRunLockArgs = argv => {
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1) throw Error(USAGE);
  const own = argv.slice(0, split);
  const command = argv.slice(split + 1);
  /** @type {{ label?: string, timeoutMs?: number, lockPath?: string, maxMs?: number, slots?: number, mode?: 'shared' | 'exclusive' }} */
  const options = {};
  /**
   * @param {string} name
   * @param {string} value
   * @param {number} min
   */
  const whole = (name, value, min) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min)
      throw Error(`${name} takes a whole number >= ${min}`);
    return n;
  };
  /**
   * @param {string} arg
   * @param {string} value
   */
  const parseValue = (arg, value) => {
    if (arg === '--label') options.label = value;
    else if (arg === '--lock') options.lockPath = path.resolve(value);
    else if (arg === '--timeout-ms') {
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms < 0)
        throw Error('--timeout-ms takes a whole number of milliseconds');
      options.timeoutMs = ms;
    } else if (arg === '--max-ms') options.maxMs = whole(arg, value, 1);
    else if (arg === '--slots') options.slots = whole(arg, value, 1);
    else throw Error(`Unknown option ${arg}`);
  };
  for (let i = 0; i < own.length; i += 1) {
    const arg = own[i];
    if (arg === '--exclusive' || arg === '--shared') {
      const mode = arg === '--exclusive' ? 'exclusive' : 'shared';
      if (options.mode && options.mode !== mode)
        throw Error('--exclusive and --shared exclude each other');
      options.mode = mode;
    } else {
      const value = own[i + 1];
      if (value === undefined) throw Error(`${arg} needs a value`);
      i += 1;
      parseValue(arg, value);
    }
  }
  return { options, command };
};

/**
 * A label without directories: absolute or relative paths keep their last
 * part only, so no local path reaches the log or a lock record.
 * @param {string} text
 */
export const scrubLabel = text =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map(word => (word.includes('/') ? path.basename(word) : word))
    .join(' ')
    .slice(0, 80);

/**
 * The default label: the command's name and the names of the script or
 * test files it is given.
 * @param {string[]} command
 */
export const defaultLabel = command =>
  scrubLabel(
    [
      command[0],
      ...command.slice(1).filter(arg => /\.[cm]?js$/.test(arg)),
    ].join(' '),
  );

/**
 * The basename of the git worktree holding `dir`, or null outside one.
 * @param {string} dir
 */
export const laneOf = dir => {
  let at = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(at, '.git'))) return path.basename(at);
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
};

/**
 * Append one line to the run log: one write on an O_APPEND descriptor, so
 * lines from several writers never interleave.
 * @param {object} row
 * @param {Record<string, string | undefined>} [env]
 */
export const appendRunLog = async (row, env = process.env) => {
  const file = runLogPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.write(`${JSON.stringify(row)}\n`);
  } finally {
    await handle.close();
  }
};

/**
 * Signal a process group; false when it no longer exists.
 * @param {number} pgid
 * @param {NodeJS.Signals | 0} signal
 */
const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
};

/** @param {string[]} argv */
const main = async argv => {
  const startedAt = new Date();
  const env = process.env;
  /** @type {Record<string, unknown>} */
  const row = {
    at: startedAt.toISOString(),
    lane: laneOf(process.cwd()),
    agent: env.THIX_AGENT || null,
    label: null,
    mode: null,
    slot: null,
    waitedMs: 0,
    heldMs: 0,
    exitCode: 1,
    timedOut: false,
  };
  const log = () =>
    appendRunLog(row, env).catch(error =>
      process.stderr.write(`run-lock: run log not written: ${error.message}\n`),
    );
  let parsed;
  try {
    parsed = parseRunLockArgs(argv);
  } catch (error) {
    process.stderr.write(`run-lock: ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { options, command } = parsed;
  const label = scrubLabel(options.label ?? defaultLabel(command));
  const mode =
    options.mode ?? (namesPerfCheck(command) ? 'exclusive' : 'shared');
  let maxMs;
  try {
    maxMs = options.maxMs ?? maxMsFromEnv(env);
  } catch (error) {
    process.stderr.write(`run-lock: ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 1;
    return;
  }
  Object.assign(row, { label, mode });
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  /** @param {'SIGINT' | 'SIGTERM' | 'SIGHUP'} signal */
  const onSignal = signal => {
    if (child) {
      // Forwarded to the workload's group; the exit is logged when it ends.
      if (child.pid === undefined || !signalGroup(child.pid, signal))
        child.kill(signal);
      return;
    }
    // Still waiting for a slot: what this process created is stale once it
    // exits, and the next taker breaks it.
    row.waitedMs = Date.now() - startedAt.getTime();
    row.exitCode = signalCodes[signal];
    void log().then(() => process.exit(signalCodes[signal]));
  };
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']))
    process.on(signal, onSignal);
  /** @type {RunLock} */
  let lock;
  try {
    lock = await acquireRunLock({
      label,
      mode,
      ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
      ...(options.slots === undefined ? {} : { slots: options.slots }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      onEvent: event =>
        process.stderr.write(`run-lock: ${JSON.stringify(event)}\n`),
    });
  } catch (error) {
    process.stderr.write(`run-lock: ${/** @type {Error} */ (error).message}\n`);
    row.waitedMs = Date.now() - startedAt.getTime();
    await log();
    process.exitCode = 1;
    return;
  }
  row.waitedMs = lock.waitedMs;
  row.slot = lock.reentrant ? null : lock.slot;
  if (lock.reentrant) row.mode = 'reentrant';
  const heldFrom = Date.now();
  // Its own process group, so supervisors and workers it starts are
  // signalled with it.
  const workload = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    detached: true,
    env: { ...env, [RUN_LOCK_ENV]: lock.id },
  });
  child = workload;
  /** @type {Promise<void>} */
  let recorded = Promise.resolve();
  // Recorded as soon as it exists: if this wrapper is killed, the slot stays
  // held until the workload ends.
  workload.once('spawn', () => {
    if (workload.pid !== undefined)
      recorded = lock.recordWorkload(workload.pid).catch(error => {
        process.stderr.write(
          `run-lock: workload not recorded: ${error.message}\n`,
        );
      });
  });
  let timedOut = false;
  /** @type {NodeJS.Timeout | undefined} */
  let killTimer;
  const boxTimer = setTimeout(() => {
    timedOut = true;
    const pgid = workload.pid;
    if (pgid === undefined) return;
    signalGroup(pgid, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), KILL_GRACE_MS);
  }, maxMs);
  const code = await new Promise(resolve => {
    workload.once('error', error => {
      process.stderr.write(`run-lock: ${error.message}\n`);
      resolve(127);
    });
    workload.once('exit', (exitCode, signal) =>
      resolve(exitCode ?? (signal ? 128 : 1)),
    );
  });
  clearTimeout(boxTimer);
  if (timedOut && workload.pid !== undefined) {
    // The leader is gone; give the rest of its group the same grace.
    const pgid = workload.pid;
    const until = Date.now() + KILL_GRACE_MS;
    while (Date.now() < until && signalGroup(pgid, 0)) await delay(100);
    signalGroup(pgid, 'SIGKILL');
  }
  clearTimeout(killTimer);
  // A record written after the release would bring the slot file back.
  await recorded;
  await lock.release();
  const exitCode = timedOut ? TIMED_OUT_EXIT : /** @type {number} */ (code);
  Object.assign(row, {
    heldMs: Date.now() - heldFrom,
    exitCode,
    timedOut,
  });
  if (timedOut)
    process.stderr.write(
      `run-lock: TIMED OUT: "${label}" ran longer than --max-ms ${maxMs}; its process group was terminated (exit ${TIMED_OUT_EXIT})\n`,
    );
  await log();
  process.exitCode = exitCode;
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
