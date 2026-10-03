// @ts-check
// spell-out-exempt: `num_turns` is a field of Claude Code's result event.
// prefer-endo-primitives-exempt: the projection and the grant's `release`
// must be remotable functions, which only `Far` can make.

import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { CredentialSourceInterface } from '@endo/inference/guards.js';

/** @import { CredentialGrant, CredentialRefusal, GuestToolProjection, InferRequest, ShapeTable } from '@endo/inference/types.js' */
/** @import { ChildProcessLike, ScratchDirectory, Spawn, SpawnOptions } from '../src/backends.types.js' */

export const FORMULA_IDENTIFIER = 'formula-label-0123456789abcdef';
export const CREDENTIAL = 'sk-ant-oat01-test-credential';

/**
 * @param {unknown} [server]
 */
export const makeProjection = (
  server = harden({ kind: 'test-mcp-server' }),
) => {
  const calls = { buildMcpServer: 0 };
  /** @type {GuestToolProjection} */
  const guest = harden({
    buildMcpServer: Far('buildMcpServer', () => {
      calls.buildMcpServer += 1;
      return server;
    }),
    toolNames: harden(['readText', 'writeText']),
    formulaIdentifier: FORMULA_IDENTIFIER,
  });
  return { guest, calls };
};

/**
 * @param {object} [overrides]
 * @param {GuestToolProjection} [overrides.guest]
 * @param {Promise<unknown>} [overrides.cancelled]
 * @param {string} [overrides.model]
 * @param {Partial<{ maxWallClockMs: number, maxOutputBytes: number, maxTurns: number }>} [overrides.limits]
 * @returns {InferRequest}
 */
export const makeRequest = ({
  guest = makeProjection().guest,
  cancelled = new Promise(() => {}),
  model,
  limits = {},
} = {}) =>
  harden({
    prompt: 'write then read',
    promptOrigin: 'root-authored',
    guest,
    limits: harden({
      maxWallClockMs: 60_000,
      maxOutputBytes: 1_000_000,
      maxTurns: 4,
      ...limits,
    }),
    cancelled,
    ...(model === undefined ? {} : { model }),
  });

/**
 * A credential source that grants `environment` (or refuses with `refusal`, or
 * rejects with `failure`) and counts acquisitions and releases.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.environment]
 * @param {CredentialRefusal['admission']} [options.refusal]
 * @param {Error} [options.failure]
 */
export const makeCredentialSource = ({
  environment = { ANTHROPIC_AUTH_TOKEN: CREDENTIAL },
  refusal,
  failure,
} = {}) => {
  const counts = { acquired: 0, released: 0 };
  const credentialSource = makeExo(
    'TestCredentialSource',
    CredentialSourceInterface,
    {
      /** @returns {Promise<CredentialGrant | CredentialRefusal>} */
      async acquire() {
        counts.acquired += 1;
        if (failure !== undefined) {
          throw failure;
        }
        if (refusal !== undefined) {
          return harden({ type: 'refused', admission: harden(refusal) });
        }
        return harden({
          type: 'granted',
          environment: harden({ ...environment }),
          release: Far('release', () => {
            counts.released += 1;
          }),
        });
      },
    },
  );
  return { credentialSource, counts };
};

/**
 * An in-memory scratch directory that records the files written to it.
 */
export const makeMemoryScratch = () => {
  /** @type {Map<string, string>} */
  const files = new Map();
  const state = { made: 0, removed: 0 };
  /** @returns {Promise<ScratchDirectory>} */
  const makeScratchDirectory = async () => {
    state.made += 1;
    return harden({
      path: '/scratch/turn',
      configDirectory: '/scratch/turn/config',
      writeFile: async (name, contents) => {
        const path = `/scratch/turn/${name}`;
        files.set(path, contents);
        return path;
      },
      remove: async () => {
        state.removed += 1;
      },
    });
  };
  return { makeScratchDirectory, files, state };
};

/**
 * Timers whose callbacks run only when the test calls `fire()`.
 */
export const makeManualTimers = () => {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let next = 0;
  const timers = harden({
    /** @param {() => void} callback */
    setTimeout: callback => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    /** @param {number} handle */
    clearTimeout: handle => {
      pending.delete(handle);
    },
  });
  const fire = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback();
  };
  return { timers, fire, pending };
};

/**
 * @typedef {object} FakeChildScript
 * @property {(string | Uint8Array)[]} [stdout]  chunks written to stdout after stdin
 *   closes
 * @property {string | string[]} [stderr]  a single chunk, or several emitted
 *   in sequence
 * @property {number | null} [exitCode]
 * @property {string | null} [signal]
 * @property {boolean} [hang]  never exits on its own
 * @property {boolean} [lingers]  exits, but a descendant keeps the pipes
 *   open, so `close` never comes
 * @property {string} [spawnError]  emits `error` instead of running
 */

/**
 * A `spawn` power whose child replays a script once its stdin closes, and
 * which records each spawn and every signal sent to a process group.
 *
 * @param {FakeChildScript} script
 */
export const makeFakeSpawn = script => {
  /** @type {{ command: string, commandArguments: readonly string[], options: SpawnOptions, stdin: string }[]} */
  const spawns = [];
  /** @type {{ pid: number, signal: string }[]} */
  const kills = [];
  /** @type {((name: string, ...values: any[]) => void)[]} */
  const emitters = [];
  let nextPid = 4000;

  /** @type {Spawn} */
  const spawn = (command, commandArguments, options) => {
    nextPid += 1;
    const record = { command, commandArguments, options, stdin: '' };
    spawns.push(record);
    /** @type {Record<string, ((...values: any[]) => void)[]>} */
    const listeners = {
      error: [],
      exit: [],
      close: [],
      stdout: [],
      stderr: [],
    };
    const emit = (
      /** @type {string} */ name,
      /** @type {any[]} */ ...values
    ) => {
      for (const listener of listeners[name]) listener(...values);
    };
    emitters.push(emit);
    const run = async () => {
      await null;
      if (script.spawnError !== undefined) {
        emit(
          'error',
          Object.assign(Error('spawn failed'), { code: script.spawnError }),
        );
        return;
      }
      for (const chunk of script.stdout ?? []) {
        emit('stdout', chunk);
        // eslint-disable-next-line no-await-in-loop
        await null;
      }
      for (const chunk of [script.stderr ?? []].flat()) emit('stderr', chunk);
      if (!script.hang) {
        emit('exit', script.exitCode ?? 0, script.signal ?? null);
        if (!script.lingers) {
          emit('close', script.exitCode ?? 0, script.signal ?? null);
        }
      }
    };
    /** @type {ChildProcessLike} */
    const child = {
      pid: nextPid,
      stdin: {
        on: () => {},
        write: data => {
          record.stdin += data;
        },
        end: () => {
          void run();
        },
      },
      stdout: { on: (_event, listener) => listeners.stdout.push(listener) },
      stderr: { on: (_event, listener) => listeners.stderr.push(listener) },
      on: (/** @type {string} */ event, /** @type {any} */ listener) => {
        listeners[event].push(listener);
      },
    };
    return child;
  };
  /**
   * @param {number} pid
   * @param {string} signal
   */
  const kill = (pid, signal) => {
    kills.push({ pid, signal });
  };
  return { spawn, kill, spawns, kills, emitters };
};

/**
 * Hardens a test's response-shape table under its declared type.
 *
 * @param {ShapeTable} table
 * @returns {ShapeTable}
 */
export const shapeTable = table => harden(table);

/** @param {Record<string, unknown>} event */
export const line = event => `${JSON.stringify(event)}\n`;

/**
 * @param {string} id
 * @param {string} text
 */
export const assistant = (id, text) =>
  line({
    type: 'assistant',
    message: { id, content: [{ type: 'text', text }] },
  });

/**
 * @param {Record<string, unknown>} [fields]
 */
export const successResult = (fields = {}) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 2,
    duration_ms: 40,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...fields,
  });

/**
 * Settles every promise reaction queued so far, several hops deep.
 */
export const settle = async () => {
  for (let hop = 0; hop < 50; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};
