// @ts-check
/**
 * Speech engine child processes (`designs/m11-interfaces.md` 3.3, 6.2;
 * D-M11-10, D-M11-15). The `process` kind's engines are children of the
 * agent-host adapter: Endo's Moonshine daemon (speech in, resident) and
 * Piper (speech out, one process per reply). This module is what both
 * directions share:
 *
 * - `spawnEngineProcess(options)`: one child, spawned with the
 *   `engineEnvironment` allowlist only, in its own process group (so a kill
 *   reaches `uv run`'s Python child too), stdin and stdout piped, stderr
 *   discarded (an engine's diagnostics may quote audio text: R5-59, section
 *   10). Output is either JSON lines through a bounded line reader
 *   (`engineLineBytes`; a longer line kills the engine) or raw bytes. A
 *   lines engine is ready at its ready line, within `engineLoadMs` or it is
 *   killed; a bytes engine is ready at spawn. `terminate()` closes stdin
 *   (every engine exits at end of input, D-M11-15), sends SIGTERM, and
 *   SIGKILL after `killGraceMs`.
 * - `makeRestartPacing(options)`: `engineRestart` pacing, a bound on the
 *   start rate kept as at most `failuresInWindow` timestamps.
 * - `makeChildEngine(options)`: a resident engine: at most one process at a
 *   time, started on use (`start()`), respawned on the next use after it
 *   died (R5-15), paced by `makeRestartPacing`.
 *
 * Node only (adapter). Nothing here logs a line of engine output, an
 * argument, a path or an environment value: log events are
 * `engine-protocol.js` `speechLogEvents` with the caller's `logAs` fields,
 * a pid, exit code and signal, and a fixed reason.
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import { audioLimits, audioTimeouts } from './audio-protocol.js';
import { engineEnvironment, engineRestart } from './engine-protocol.js';

/**
 * Why a process ended: `exit` it exited on its own; `spawn-failed` it could
 * not be started; `load-timeout` no ready line within `engineLoadMs`;
 * `line-too-long` an output line over `engineLineBytes`; `terminated`
 * `terminate()` was called.
 *
 * @typedef {'exit' | 'spawn-failed' | 'load-timeout' | 'line-too-long' | 'terminated'} ExitReason
 */

/**
 * @typedef {object} EngineExit
 * @property {number | null} code
 * @property {string | null} signal
 * @property {ExitReason} reason
 * @property {boolean} wasReady whether the process reached ready
 */

/**
 * @typedef {object} EngineProcess one engine child
 * @property {number | undefined} pid
 * @property {Promise<boolean>} ready true at ready, false when the process
 *   ended first; never rejects
 * @property {() => boolean} isReady
 * @property {() => boolean} alive not yet ended
 * @property {(record: unknown) => boolean} writeLine one JSON line to stdin;
 *   false when stdin is closed
 * @property {(chunk: string | Uint8Array) => boolean} write raw stdin
 *   bytes; false when stdin is closed
 * @property {() => number} queuedBytes stdin bytes Node holds because the
 *   engine has not read them yet (backlog)
 * @property {() => void} pauseOutput stop reading stdout (backpressure);
 *   the engine blocks when its pipe fills
 * @property {() => void} resumeOutput
 * @property {() => void} endInput close stdin; the engine exits
 * @property {(reason?: ExitReason) => Promise<EngineExit>} terminate end
 *   input, SIGTERM to the process group, SIGKILL after `killGraceMs`;
 *   resolves at exit
 * @property {Promise<EngineExit>} exited
 */

/**
 * @typedef {object} EngineSpawnOptions
 * @property {readonly string[]} command argv: the program, then its
 *   arguments (configuration from `SpeechSettings`, written only on the
 *   provisioning path, D-M11-21)
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [environment] the source
 *   the allowlist is taken from (default `process.env`)
 * @property {'lines' | 'bytes'} output
 * @property {string} [readyEvent] lines mode: the `event` of the ready line
 *   (`{"event":"ready"}`); absent, the process is ready at spawn
 * @property {number} [lineBytes] default `audioLimits.engineLineBytes`
 * @property {number} [loadMs] default `audioTimeouts.engineLoadMs`
 * @property {number} [killGraceMs] default `audioTimeouts.killGraceMs`
 * @property {(event: Record<string, unknown>) => void} [log]
 * @property {Record<string, string>} [logAs] fields of every log event,
 *   e.g. `{ direction: 'speech-in', kind: 'process' }`
 */

/**
 * @typedef {object} EngineHandlers
 * @property {(record: Record<string, unknown>) => void} [onLine] a JSON
 *   object line after ready (other lines are dropped)
 * @property {(bytes: Uint8Array) => void} [onData] bytes mode: stdout data
 * @property {() => void} [onReady]
 * @property {(exit: EngineExit) => void} [onExit] once
 */

const NEWLINE = 0x0a;
const noop = () => {};

/**
 * A host timer that does not keep the adapter alive.
 * @param {number} ms
 * @param {() => void} fn
 * @returns {() => void} cancel
 */
export const afterMs = (ms, fn) => {
  const handle = setTimeout(fn, Math.max(0, ms));
  handle.unref();
  return () => clearTimeout(handle);
};
harden(afterMs);

/**
 * The environment an engine gets: the `engineEnvironment` names that are
 * set in `source`, nothing else.
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export const engineEnvironmentOf = (source = process.env) => {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of engineEnvironment) {
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  return harden(env);
};
harden(engineEnvironmentOf);

/**
 * Splits bytes into lines; a line (or a run without a newline) over
 * `maxBytes` calls `onOverflow` once and the reader drops everything after.
 * Holds at most `maxBytes` bytes.
 * @param {object} options
 * @param {number} options.maxBytes
 * @param {(line: string) => void} options.onLine
 * @param {() => void} options.onOverflow
 */
export const makeLineReader = ({ maxBytes, onLine, onOverflow }) => {
  /** @type {Buffer[]} */
  let held = [];
  let heldBytes = 0;
  let overflowed = false;
  /** @param {Buffer} chunk */
  const push = chunk => {
    let start = 0;
    while (!overflowed && start < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      const end = nl === -1 ? chunk.length : nl;
      if (heldBytes + (end - start) > maxBytes) {
        overflowed = true;
        held = [];
        heldBytes = 0;
        onOverflow();
        return;
      }
      if (nl === -1) {
        held.push(chunk.subarray(start));
        heldBytes += chunk.length - start;
        return;
      }
      const piece = chunk.subarray(start, nl);
      const line =
        held.length === 0
          ? piece.toString('utf8')
          : Buffer.concat([...held, piece]).toString('utf8');
      held = [];
      heldBytes = 0;
      start = nl + 1;
      onLine(line);
    }
  };
  return harden({ push });
};
harden(makeLineReader);

/**
 * @param {string} line
 * @returns {Record<string, unknown> | undefined}
 */
const parseRecord = line => {
  const text = line.trim();
  if (text === '') return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Starts one engine child.
 * @param {EngineSpawnOptions} options
 * @param {EngineHandlers} [handlers]
 * @returns {EngineProcess}
 */
export const spawnEngineProcess = (options, handlers = {}) => {
  const {
    command,
    cwd,
    environment,
    output,
    readyEvent,
    lineBytes = audioLimits.engineLineBytes,
    loadMs = audioTimeouts.engineLoadMs,
    killGraceMs = audioTimeouts.killGraceMs,
    log = noop,
    logAs = {},
  } = options;
  const {
    onLine = noop,
    onData = noop,
    onReady = noop,
    onExit = noop,
  } = handlers;
  const startedAt = Date.now();

  /** @type {(value: boolean) => void} */
  let resolveReady = noop;
  /** @type {Promise<boolean>} */
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  /** @type {(exit: EngineExit) => void} */
  let resolveExited = noop;
  /** @type {Promise<EngineExit>} */
  const exited = new Promise(resolve => {
    resolveExited = resolve;
  });

  let isReady = false;
  let ended = false;
  /** @type {ExitReason | undefined} */
  let stopReason;
  let cancelLoad = noop;
  let cancelKill = noop;

  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...engineEnvironmentOf(environment) },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  const { pid } = child;

  /** @param {NodeJS.Signals} signal */
  const signalGroup = signal => {
    if (pid === undefined || ended) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };

  /**
   * @param {number | null} code
   * @param {string | null} signal
   * @param {ExitReason} fallback
   */
  const finish = (code, signal, fallback) => {
    if (ended) return;
    ended = true;
    cancelLoad();
    cancelKill();
    /** @type {EngineExit} */
    const exit = harden({
      code,
      signal,
      reason: stopReason ?? fallback,
      wasReady: isReady,
    });
    log({
      event: 'speech-engine-exit',
      ...logAs,
      pid,
      code,
      signal,
      reason: exit.reason,
    });
    if (!isReady) resolveReady(false);
    resolveExited(exit);
    onExit(exit);
  };

  const markReady = () => {
    if (isReady || ended) return;
    isReady = true;
    cancelLoad();
    log({
      event: 'speech-engine-ready',
      ...logAs,
      pid,
      ms: Date.now() - startedAt,
    });
    resolveReady(true);
    onReady();
  };

  /** @param {ExitReason} [reason] */
  const terminate = (reason = 'terminated') => {
    if (ended) return exited;
    if (stopReason === undefined) stopReason = reason;
    endInput();
    signalGroup('SIGTERM');
    cancelKill();
    cancelKill = afterMs(killGraceMs, () => signalGroup('SIGKILL'));
    return exited;
  };

  const endInput = () => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  };

  child.on('error', () => {
    // ENOENT and the like: no process, no 'close' guaranteed.
    if (pid === undefined) finish(null, null, 'spawn-failed');
  });
  child.on('close', (code, signal) => finish(code, signal, 'exit'));
  child.stdin?.on('error', noop);

  if (output === 'lines') {
    const reader = makeLineReader({
      maxBytes: lineBytes,
      onLine: line => {
        if (ended) return;
        const record = parseRecord(line);
        if (record === undefined) return;
        if (!isReady) {
          if (readyEvent !== undefined && record.event === readyEvent) {
            markReady();
          }
          return;
        }
        onLine(record);
      },
      onOverflow: () => {
        log({
          event: 'speech-engine-failed',
          ...logAs,
          pid,
          reason: 'line-too-long',
        });
        void terminate('line-too-long');
      },
    });
    child.stdout?.on('data', chunk => reader.push(chunk));
  } else {
    child.stdout?.on('data', chunk => {
      if (!ended) onData(chunk);
    });
  }

  if (pid !== undefined) {
    log({ event: 'speech-engine-start', ...logAs, pid });
    if (output === 'lines' && readyEvent !== undefined) {
      cancelLoad = afterMs(loadMs, () => {
        log({
          event: 'speech-engine-timeout',
          ...logAs,
          pid,
          reason: 'load-timeout',
        });
        void terminate('load-timeout');
      });
    } else {
      void Promise.resolve().then(markReady);
    }
  }

  const stdinOpen = () =>
    !ended && !!child.stdin && child.stdin.writable && !child.stdin.destroyed;

  return harden({
    pid,
    ready,
    isReady: () => isReady,
    alive: () => !ended,
    writeLine: record => {
      if (!stdinOpen()) return false;
      child.stdin?.write(`${JSON.stringify(record)}\n`);
      return true;
    },
    write: chunk => {
      if (!stdinOpen()) return false;
      child.stdin?.write(chunk);
      return true;
    },
    queuedBytes: () => child.stdin?.writableLength ?? 0,
    pauseOutput: () => {
      child.stdout?.pause();
    },
    resumeOutput: () => {
      child.stdout?.resume();
    },
    endInput,
    terminate,
    exited,
  });
};
harden(spawnEngineProcess);

/**
 * `engineRestart` pacing: after `failuresInWindow` failed starts within
 * `windowMs`, no start until `backoffMs` after the last of them. Keeps at
 * most `failuresInWindow` timestamps (a rate, not a lifetime count).
 * @param {object} [options]
 * @param {{ failuresInWindow: number, windowMs: number, backoffMs: number }} [options.restart]
 * @param {() => number} [options.now]
 */
export const makeRestartPacing = ({
  restart = engineRestart,
  now = Date.now,
} = {}) => {
  /** @type {number[]} */
  let failures = [];
  const prune = () => {
    const t = now();
    failures = failures.filter(at => t - at < restart.windowMs);
  };
  return harden({
    /** A start failed. */
    failed: () => {
      prune();
      failures.push(now());
      if (failures.length > restart.failuresInWindow) failures.shift();
    },
    /** A start succeeded: the failures before it no longer count. */
    succeeded: () => {
      failures = [];
    },
    /** Whether the next start must wait. */
    holds: () => {
      prune();
      if (failures.length < restart.failuresInWindow) return false;
      return now() - failures[failures.length - 1] < restart.backoffMs;
    },
  });
};
harden(makeRestartPacing);

/**
 * @typedef {object} ChildEngineHandlers
 * @property {(record: Record<string, unknown>, proc: EngineProcess) => void} [onLine]
 * @property {(bytes: Uint8Array, proc: EngineProcess) => void} [onData]
 * @property {(proc: EngineProcess) => void} [onReady]
 * @property {(exit: EngineExit, proc: EngineProcess) => void} [onExit]
 */

/**
 * A resident engine: at most one process, started by `start()` when none
 * runs (respawn on next use, R5-15), paced by `makeRestartPacing`. A start
 * fails when its process ends before ready for any reason other than
 * `stop()` or `restart()`.
 * @param {EngineSpawnOptions & { restart?: { failuresInWindow: number, windowMs: number, backoffMs: number }, now?: () => number }} options
 * @param {ChildEngineHandlers} [handlers]
 */
export const makeChildEngine = (options, handlers = {}) => {
  const { restart, now, ...spawnOptions } = options;
  const pacing = makeRestartPacing({ restart, now });
  const {
    onLine = noop,
    onData = noop,
    onReady = noop,
    onExit = noop,
  } = handlers;
  /** @type {EngineProcess | undefined} */
  let current;
  let stopped = false;

  /** @returns {import('./engine-types.js').DirectionState} */
  const state = () => {
    if (current !== undefined) return current.isReady() ? 'ready' : 'starting';
    return pacing.holds() ? 'failed' : 'idle';
  };

  /**
   * The running process, or a new one; undefined after `stop()` or while
   * the pacing holds.
   * @returns {EngineProcess | undefined}
   */
  const start = () => {
    if (stopped) return undefined;
    if (current !== undefined) return current;
    if (pacing.holds()) return undefined;
    // The handlers run after this returns (child events are asynchronous).
    const proc = spawnEngineProcess(spawnOptions, {
      onLine: record => onLine(record, proc),
      onData: bytes => onData(bytes, proc),
      onReady: () => {
        pacing.succeeded();
        onReady(proc);
      },
      onExit: exit => {
        if (current === proc) current = undefined;
        if (!exit.wasReady && exit.reason !== 'terminated') pacing.failed();
        onExit(exit, proc);
      },
    });
    // A spawn failure may already have ended it (no pid).
    if (proc.alive()) current = proc;
    return proc;
  };

  /**
   * End the running process (it is respawned on the next `start()`).
   * @param {ExitReason} [reason]
   */
  const restartProcess = async (reason = 'terminated') => {
    const proc = current;
    if (proc === undefined) return;
    await proc.terminate(reason);
  };

  const stop = async () => {
    stopped = true;
    await restartProcess();
  };

  return harden({
    state,
    start,
    current: () => current,
    restart: restartProcess,
    stop,
  });
};
harden(makeChildEngine);
