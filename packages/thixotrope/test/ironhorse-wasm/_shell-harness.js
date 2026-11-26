// @ts-check
// Spawning Ironhorse worker processes, wasm and native, outside the
// Thixotrope host: the paths of the built artifacts, the limits the host
// passes by default, and a child whose output lines, stderr and exit are
// collected and which is killed at teardown whatever the test did.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @import { ExecutionContext } from 'ava' */
/** @import { ChildProcess, StdioOptions } from 'node:child_process' */

const repoPath = fileURLToPath(new URL('../../../../', import.meta.url));

/** The staged launcher; the wasm lane sets the variable. */
export const WASM_WORKER =
  process.env.THIXOTROPE_IRONHORSE_WASM_WORKER ||
  join(
    repoPath,
    'target/thixotrope-ironhorse-wasm/thixotrope-ironhorse-wasm-worker',
  );
/**
 * The native worker. The wasm lane points THIXOTROPE_IRONHORSE_WORKER at the
 * launcher, so the native worker has a variable of its own.
 */
export const NATIVE_WORKER =
  process.env.THIXOTROPE_IRONHORSE_NATIVE_WORKER ||
  join(repoPath, 'target/release/thixotrope-ironhorse-worker');
export const BOOT_PATHS = Object.freeze(
  ['boot.js', 'worker-peer.js'].map(name =>
    fileURLToPath(new URL(`../../dist-ironhorse/${name}`, import.meta.url)),
  ),
);
// Fail at module load, never turn missing CI artifacts into skipped tests.
await Promise.all(
  [WASM_WORKER, NATIVE_WORKER, ...BOOT_PATHS].map(path => access(path)),
);

/**
 * Worker limits as the engine passes them (`makeIronhorseLimits`'s
 * defaults), with overrides.
 *
 * @param {Record<string, unknown>} [overrides]
 */
export const limitsJson = (overrides = {}) =>
  JSON.stringify({
    crankBudget: '10000000',
    bootstrapBudget: '1000000000',
    slotCeiling: 1_000_000,
    chunkCeiling: 268_435_456,
    requestTimeoutMs: 60_000,
    ...overrides,
  });
export const PROFILE = 'thixotrope-wasm-shell-test';
export const READY = '{"features":["deliver-v1"],"op":"ready"}\n';

/** @param {Record<string, unknown>} request */
export const line = request => JSON.stringify(request);
/** @param {unknown} value */
export const result = value =>
  `${JSON.stringify({ op: 'result', result: value })}\n`;

/** @param {string} path */
export const sha256File = async path =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

/**
 * A temporary directory removed at teardown.
 *
 * @param {ExecutionContext} t
 * @param {string} [prefix]
 */
export const tempDir = async (t, prefix = 'thix-wasm-shell-') => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * @typedef {object} Worker
 * @property {ChildProcess} child
 * @property {number} pid
 * @property {string[]} lines complete stdout lines so far, terminators kept
 * @property {() => string} stdout everything read from stdout so far
 * @property {() => string} stderr everything read from stderr so far
 * @property {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} exited
 * @property {(count: number) => Promise<string[]>} waitForLines resolves
 *   once `count` lines have arrived, or rejects if the worker exits first
 */

/**
 * Start a worker process (`binary heap profile lease limits boot...`),
 * killed at teardown if it is still running.
 *
 * @param {ExecutionContext} t
 * @param {string} binary
 * @param {object} options
 * @param {string} options.heap
 * @param {string} options.lease
 * @param {string} [options.limits]
 * @param {ReadonlyArray<string>} [options.boots]
 * @param {string} [options.profile]
 * @param {StdioOptions} [options.stdio]
 * @param {boolean} [options.read] false to leave stdout unread until asked
 * @returns {Worker & { startReading: () => void }}
 */
export const startWorker = (
  t,
  binary,
  {
    heap,
    lease,
    limits = limitsJson(),
    boots = BOOT_PATHS,
    profile = PROFILE,
    stdio = ['pipe', 'pipe', 'pipe'],
    read = true,
  },
) => {
  const child = spawn(binary, [heap, profile, lease, limits, ...boots], {
    stdio,
  });
  let out = '';
  let err = '';
  /** @type {Array<() => void>} */
  const waiters = [];
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  t.teardown(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited.catch(() => {});
  });
  const worker = {
    child,
    pid: /** @type {number} */ (child.pid),
    lines: /** @type {string[]} */ ([]),
    stdout: () => out,
    stderr: () => err,
    exited,
    /** @param {number} count */
    waitForLines: count =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (worker.lines.length >= count) {
            resolve(worker.lines.slice(0, count));
            return true;
          }
          return false;
        };
        if (check()) return;
        waiters.push(() => {
          check();
        });
        void exited.then(({ code, signal }) => {
          if (!check()) {
            reject(
              Error(
                `worker exited (${code ?? signal}) after ${worker.lines.length} lines; stderr: ${err}`,
              ),
            );
          }
        });
      }),
    startReading: () => {
      if (!child.stdout) return;
      child.stdout.setEncoding('utf8');
      // Split only what arrived since the last complete line, so a reply
      // of megabytes in many chunks is not rescanned per chunk.
      let partial = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        const parts = chunk.split('\n');
        parts[0] = partial + parts[0];
        partial = /** @type {string} */ (parts.pop());
        for (const part of parts) worker.lines.push(`${part}\n`);
        for (const waiter of waiters) waiter();
      });
    },
  };
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      err += chunk;
    });
  }
  child.stdin?.on('error', () => {});
  if (read) worker.startReading();
  return worker;
};

/**
 * Run a worker over a heap with these request lines, then end its input;
 * answers its stdout lines, exit code and stderr.
 *
 * @param {ExecutionContext} t
 * @param {string} binary
 * @param {string} dir holds the heap's lease
 * @param {string} heap
 * @param {ReadonlyArray<string>} requests
 * @param {{ limits?: string, boots?: ReadonlyArray<string>, profile?: string }} [options]
 */
export const runWorker = async (t, binary, dir, heap, requests, options) => {
  const worker = startWorker(t, binary, {
    heap,
    lease: join(dir, 'lease'),
    ...options,
  });
  worker.child.stdin?.end(requests.map(request => `${request}\n`).join(''));
  const { code } = await worker.exited;
  return { lines: worker.lines, code, stderr: worker.stderr() };
};
