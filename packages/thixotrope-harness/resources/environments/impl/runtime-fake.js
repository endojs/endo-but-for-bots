// @ts-check
/**
 * The `fake` runtime of the environments adapter (contract
 * `designs/m6-interfaces.md` D-M6-8, 5.3): each command is a host child
 * process in the session's workspace directory, with the session's home as
 * `HOME` and an environment of exactly A.3's variables, in its own process
 * group. **Not a sandbox**: it proves everything the runner, the shell port
 * and the turn do with a command, never the isolation properties
 * (`[real-runtime]` items).
 *
 * Each live process group is recorded as one file `<run>/<pgid>` (JSON
 * `{ pgid, startedAt }`), written synchronously right after the spawn, so a
 * SIGKILL of the adapter leaves a record the next incarnation's `sweep`
 * kills from. A record is removed when its group has no live member (at the
 * command's end, at `stop`, at `sweep`), so `run/` holds live groups only.
 * A record older than the host's boot names a process group of an earlier
 * boot, whose number may belong to anyone now: it is removed without a
 * signal.
 *
 * The runtime keeps, per run directory, the groups this incarnation
 * started and has not seen die (bounded by the commands in flight plus the
 * groups that outlived their leader until the next `stop`), and nothing
 * else.
 *
 * Node only (adapter).
 */
import { spawn as spawnChild } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { kill as processKill } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { environmentTextOf } from '../../../guest/lib/guards/environments.js';
/* eslint-enable import/no-relative-packages */

/**
 * @typedef {object} RuntimeEnv what the runner hands every runtime call
 *   (contract 5.3)
 * @property {string} key the manager's `e<n>`
 * @property {string} name the container name, `thix-<tag>-<key>`
 * @property {string} tag this state's tag
 * @property {string} workspace the workspace directory (`/workspace`)
 * @property {string} home the home directory (`/home/node`)
 * @property {string} run the fake runtime's process-group records
 * @property {any} settings the resource's `EnvironmentSettings`
 */

/**
 * @typedef {object} RawResult a command's raw result (contract 5.3)
 * @property {Uint8Array} stdout the first `streamBytes` bytes
 * @property {Uint8Array} stderr the first `streamBytes` bytes
 * @property {boolean} stdoutCut
 * @property {boolean} stderrCut
 * @property {number | null} exitCode
 * @property {string | null} signal
 * @property {boolean} timedOut
 * @property {number} ms
 */

/**
 * @typedef {object} ExecOptions
 * @property {number} timeoutMs SIGTERM to the group after this long
 * @property {number} killGraceMs SIGKILL this long after the SIGTERM
 * @property {number} streamBytes bytes kept per stream; the rest is drained
 */

/**
 * @typedef {object} SweepScope what a runtime's `sweep` may visit besides
 *   its tag: the fake's records live in the sessions' run directories
 * @property {string[]} [runDirs]
 */

/**
 * @typedef {object} Runtime the runtime contract (5.3)
 * @property {'fake' | 'podman' | 'docker'} kind
 * @property {(settings: any) => Promise<{ ok: true } | { ok: false, reason: string }>} check
 * @property {(env: RuntimeEnv) => Promise<void>} start
 * @property {(env: RuntimeEnv, argv: string[], options: ExecOptions) => Promise<RawResult>} exec
 * @property {(env: RuntimeEnv) => Promise<void>} stop
 * @property {(env: RuntimeEnv) => Promise<void>} remove
 * @property {(tag: string, scope?: SweepScope) => Promise<{ stopped: number }>} sweep
 */

/**
 * After the command's own process exits, how long the runtime waits for
 * its output pipes to close before it stops reading: a background process
 * it left holding stdout must not keep the result back (R3-46: background
 * processes have no lifetime across calls; the next `stop` kills them).
 * The pipe buffer left behind an exited writer is read in well under this.
 */
export const exitLingerMs = 200;

/** How often `stop` looks whether a killed group has gone. */
const goneProbeMs = 10;

/**
 * The host directories the fake runs programs from, after the session's
 * `~/.cargo/bin` (A.3's `PATH` without its image-only entries).
 */
export const fakeHostPath = '/usr/local/bin:/usr/bin:/bin';

/**
 * A.3's environment, with the session's home for `/home/node` (R3-45: no
 * host variable, no credential).
 * @param {string} home
 * @param {string} hostPath
 */
export const fakeCommandEnv = (home, hostPath = fakeHostPath) =>
  harden({
    HOME: home,
    CARGO_HOME: join(home, '.cargo'),
    RUSTUP_HOME: join(home, '.rustup'),
    CARGO_TARGET_DIR: join(home, 'target'),
    PATH: `${join(home, '.cargo', 'bin')}:${hostPath}`,
    LANG: 'C.UTF-8',
  });
harden(fakeCommandEnv);

/** @param {unknown} error */
const codeOf = error => /** @type {any} */ (error)?.code;

/**
 * The records of one run directory (the file name is the group).
 * @param {string} run
 * @returns {{ pgid: number, file: string }[]}
 */
const recordsOf = run => {
  let names;
  try {
    names = readdirSync(run);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter(name => /^[1-9][0-9]*$/.test(name))
    .map(name => ({ pgid: Number(name), file: join(run, name) }));
};

/** How long `stop`, `remove` and `sweep` wait for killed groups to go. */
const goneWaitMs = 2000;

/**
 * Keeps the first `limit` bytes of a stream and drains the rest.
 * @param {number} limit
 */
const makeKeeper = limit => {
  /** @type {Uint8Array[]} */
  const kept = [];
  let size = 0;
  let cut = false;
  return {
    /** @param {Uint8Array} chunk */
    add: chunk => {
      const room = limit - size;
      if (room <= 0) {
        if (chunk.length > 0) cut = true;
        return;
      }
      if (chunk.length > room) {
        kept.push(chunk.subarray(0, room));
        size += room;
        cut = true;
      } else {
        kept.push(chunk);
        size += chunk.length;
      }
    },
    bytes: () => {
      const out = new Uint8Array(size);
      let at = 0;
      for (const piece of kept) {
        out.set(piece, at);
        at += piece.length;
      }
      return out;
    },
    cut: () => cut,
  };
};

/**
 * @param {object} [options]
 * @param {typeof spawnChild} [options.spawn] `child_process.spawn` (tests
 *   wrap it to count spawns)
 * @param {(pid: number, signal: string | number) => void} [options.kill]
 *   `process.kill` (tests wrap it to see the signals)
 * @param {string} [options.hostPath] the host part of `PATH`
 *   (`fakeHostPath`)
 * @param {() => number} [options.bootTime] the host's boot time, epoch ms
 * @returns {Runtime}
 */
export const makeFakeRuntime = ({
  spawn = spawnChild,
  kill = processKill,
  hostPath = fakeHostPath,
  bootTime = () => Date.now() - uptime() * 1000,
} = {}) => {
  /** @type {Map<string, Set<number>>} live groups by run directory */
  const groupsByRun = new Map();

  /** @param {number} pgid */
  const groupAlive = pgid => {
    try {
      kill(-pgid, 0);
      return true;
    } catch {
      // EPERM: the number is someone else's group now; not ours to signal.
      return false;
    }
  };

  /**
   * @param {number} pgid
   * @param {string} signal
   */
  const signalGroup = (pgid, signal) => {
    try {
      kill(-pgid, signal);
    } catch (error) {
      if (codeOf(error) !== 'ESRCH' && codeOf(error) !== 'EPERM') throw error;
    }
  };

  /**
   * @param {string} run
   * @param {number} pgid
   */
  const forget = (run, pgid) => {
    groupsByRun.get(run)?.delete(pgid);
    if (groupsByRun.get(run)?.size === 0) groupsByRun.delete(run);
    try {
      unlinkSync(join(run, String(pgid)));
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
  };

  /**
   * SIGKILL every group of a run directory (records and the ones this
   * incarnation holds), wait until they are gone (at most `waitMs`), and
   * remove their records.
   * @param {string} run
   * @param {number} waitMs
   * @param {(file: string) => boolean} [mayKill] false: forget the record
   *   without a signal
   */
  const killRun = async (run, waitMs, mayKill = () => true) => {
    const groups = new Set(groupsByRun.get(run) ?? []);
    for (const { pgid, file } of recordsOf(run)) {
      if (groups.has(pgid) || mayKill(file)) groups.add(pgid);
      else forget(run, pgid);
    }
    let stopped = 0;
    for (const pgid of groups) {
      if (groupAlive(pgid)) {
        stopped += 1;
        signalGroup(pgid, 'SIGKILL');
      }
    }
    const deadline = performance.now() + waitMs;
    for (const pgid of groups) {
      while (groupAlive(pgid) && performance.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- one probe at a time
        await new Promise(resolve => setTimeout(resolve, goneProbeMs));
      }
      forget(run, pgid);
    }
    return stopped;
  };

  /** @type {Runtime['exec']} */
  const exec = (env, argv, { timeoutMs, killGraceMs, streamBytes }) =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      const [program, ...args] = argv;
      let child;
      try {
        child = spawn(program, args, {
          cwd: env.workspace,
          env: fakeCommandEnv(env.home, hostPath),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(Error(environmentTextOf.runtimeFailed(String(codeOf(error)))));
        return;
      }
      const out = makeKeeper(streamBytes);
      const err = makeKeeper(streamBytes);
      child.stdout?.on('data', chunk => out.add(chunk));
      child.stderr?.on('data', chunk => err.add(chunk));
      const pgid = child.pid;
      if (pgid !== undefined) {
        const groups = groupsByRun.get(env.run) ?? new Set();
        groupsByRun.set(env.run, groups);
        groups.add(pgid);
        writeFileSync(
          join(env.run, String(pgid)),
          JSON.stringify({ pgid, startedAt: Date.now() }),
          { mode: 0o600 },
        );
      }

      let timedOut = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let graceTimer;
      const timeoutTimer = setTimeout(() => {
        if (pgid === undefined) return;
        timedOut = true;
        signalGroup(pgid, 'SIGTERM');
        graceTimer = setTimeout(
          () => signalGroup(pgid, 'SIGKILL'),
          killGraceMs,
        );
      }, timeoutMs);

      /** @type {{ code: number | null, signal: string | null } | undefined} */
      let exit;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let lingerTimer;
      let settled = false;
      const finish = () => {
        if (settled || exit === undefined) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(lingerTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (pgid !== undefined) {
          // A timed-out command's group goes with it (exo-shell's kill).
          if (timedOut) signalGroup(pgid, 'SIGKILL');
          if (timedOut || !groupAlive(pgid)) forget(env.run, pgid);
        }
        resolve(
          harden({
            stdout: out.bytes(),
            stderr: err.bytes(),
            stdoutCut: out.cut(),
            stderrCut: err.cut(),
            exitCode: exit.code,
            signal: exit.signal,
            timedOut,
            ms: performance.now() - started,
          }),
        );
      };
      child.on('error', error => {
        if (exit !== undefined || settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (pgid !== undefined) forget(env.run, pgid);
        // The code only (ENOENT, EACCES): never the host path of the spawn.
        reject(
          Error(
            environmentTextOf.runtimeFailed(`${program}: ${codeOf(error)}`),
          ),
        );
      });
      child.on('exit', (code, signal) => {
        exit = { code, signal };
        lingerTimer = setTimeout(finish, exitLingerMs);
      });
      child.on('close', finish);
    });

  return harden({
    kind: 'fake',
    /** The fake has no image to check (`[real-runtime]` covers the pin). */
    check: async () => harden({ ok: true }),
    /** @param {RuntimeEnv} env */
    start: async env => {
      mkdirSync(env.run, { recursive: true, mode: 0o700 });
    },
    exec,
    /** @param {RuntimeEnv} env */
    stop: async env => {
      await killRun(env.run, goneWaitMs);
    },
    /** @param {RuntimeEnv} env */
    remove: async env => {
      await killRun(env.run, goneWaitMs);
    },
    /**
     * Kill every recorded group of the given run directories: leftovers of
     * an earlier incarnation of this state. The tag is the OCI runtimes'
     * label; the fake's records are already this state's by their place.
     * @param {string} _tag
     * @param {SweepScope} [scope]
     */
    sweep: async (_tag, { runDirs = [] } = {}) => {
      const boot = bootTime();
      /** @param {string} file */
      const sinceBoot = file => {
        try {
          return statSync(file).mtimeMs >= boot;
        } catch (error) {
          if (codeOf(error) === 'ENOENT') return false;
          throw error;
        }
      };
      let stopped = 0;
      for (const run of runDirs) {
        // eslint-disable-next-line no-await-in-loop -- one directory at a time
        stopped += await killRun(run, goneWaitMs, sinceBoot);
      }
      return harden({ stopped });
    },
  });
};
harden(makeFakeRuntime);

/**
 * The live process groups recorded in a run directory (tests and the
 * integration helper's `environmentProcesses`).
 * @param {string} run
 * @param {(pid: number, signal: number) => void} [kill]
 * @returns {number[]}
 */
export const liveGroupsOf = (run, kill = processKill) => {
  const live = [];
  for (const { pgid } of recordsOf(run)) {
    try {
      kill(-pgid, 0);
      live.push(pgid);
    } catch {
      // gone
    }
  }
  return harden(live);
};
harden(liveGroupsOf);
