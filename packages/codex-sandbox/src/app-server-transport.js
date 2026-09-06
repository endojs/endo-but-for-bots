// @ts-check

import { clearTimeout, setTimeout } from 'node:timers';

import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { encodeJsonLine, parseJsonLines } from './codex-protocol.js';

/** @import { SandboxHandle, ProcessHandle } from '@endo/sandbox/types.js' */

const DEFAULT_STDOUT_LIMIT = 64n * 1024n * 1024n;
const DEFAULT_STDERR_LIMIT = 1024n * 1024n;

const withDeadline = async (operation, label, timeoutMs) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error(`Codex app-server ${label} timed out`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Start one long-lived `codex app-server` process inside an already-confined
 * sandbox slice. This adapter owns only stdio and process lifetime; credentials,
 * mounts, network policy, and slice disposal remain explicit caller powers.
 *
 * @param {object} options
 * @param {SandboxHandle} options.slice
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env] reserved; custom entries denied
 * @param {string} [options.executable]
 * @param {number} [options.maxLineBytes]
 * @param {bigint} [options.stdoutByteLimit]
 * @param {bigint} [options.stderrByteLimit]
 * @param {number} [options.maxRequestBytes]
 * @param {number} [options.setupTimeoutMs]
 * @param {number} [options.teardownTimeoutMs]
 */
export const startAppServerTransport = async ({
  slice,
  cwd = '/workspace',
  env = {},
  executable = 'codex',
  maxLineBytes,
  stdoutByteLimit = DEFAULT_STDOUT_LIMIT,
  stderrByteLimit = DEFAULT_STDERR_LIMIT,
  maxRequestBytes = 2 * 1024 * 1024,
  setupTimeoutMs = 30_000,
  teardownTimeoutMs = 30_000,
}) => {
  const customNames = Object.keys(env);
  if (customNames.length > 0) {
    throw Error(
      `Custom app-server environment denied: ${customNames.sort().join(', ')}`,
    );
  }
  const effectiveEnv = harden({
    CODEX_HOME: '/codex-home',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TEMP: '/tmp',
    TMP: '/tmp',
    TMPDIR: '/tmp',
    TZ: 'UTC',
  });
  const proc = /** @type {ProcessHandle} */ (
    await E(slice).spawn(
      harden([executable, 'app-server', '--listen', 'stdio://']),
      harden({
        cwd,
        env: effectiveEnv,
        captureStdout: true,
        captureStderr: true,
        stdoutByteLimit,
        stderrByteLimit,
      }),
    )
  );

  // The sandbox answers a process it was asked to kill by rejecting `wait`
  // ("sandbox process cancelled") once its own reap has completed, so after a
  // kill a rejection is the expected way to learn the process is gone, not a
  // failure to reap it. Only a `wait` that never settles is. The reason is
  // kept for diagnostics rather than dropped.
  let reapNote = '';
  const reaped = () =>
    E(proc)
      .wait()
      .then(
        () => undefined,
        error => {
          reapNote = error instanceof Error ? error.message : `${error}`;
        },
      );

  /** @type {Promise<void>} */
  let stderrDone = Promise.resolve();
  try {
    const input = iterateBytesWriter(
      /** @type {any} */ (
        await withDeadline(E(proc).stdin(), 'stdin acquisition', setupTimeoutMs)
      ),
      { buffer: 0 },
    );
    let writeChain = Promise.resolve();
    let closed = false;
    /** @type {Promise<void> | undefined} */
    let closeP;
    let stderrTail = '';

    stderrDone = (async () => {
      const decoder = new TextDecoder();
      await null;
      try {
        const stderr = await E(proc).stderr();
        for await (const chunk of iterateBytesReader(stderr, { buffer: 16 })) {
          stderrTail += decoder.decode(chunk, { stream: true });
          if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
        }
        stderrTail += decoder.decode();
      } catch (error) {
        stderrTail = `${stderrTail}\n[stderr drain failed: ${
          error instanceof Error ? error.message : `${error}`
        }]`.slice(-8192);
      }
    })();

    const stdout = await withDeadline(
      E(proc).stdout(),
      'stdout acquisition',
      setupTimeoutMs,
    );
    const messages = parseJsonLines(
      iterateBytesReader(stdout, { buffer: 16 }),
      maxLineBytes === undefined ? {} : { maxLineBytes },
    );

    const send = message => {
      if (closed)
        return Promise.reject(Error('Codex app-server transport closed'));
      const bytes = encodeJsonLine(message, maxRequestBytes);
      writeChain = writeChain.then(async () => {
        if (closed) throw Error('Codex app-server transport closed');
        const result = await input.next(bytes);
        if (result.done) {
          throw Error('Codex app-server stdin closed before request write');
        }
      });
      return writeChain;
    };

    const close = () => {
      if (!closeP) {
        closed = true;
        closeP = (async () => {
          await null;
          const failures = [];
          const [inputResult, killResult] = await Promise.allSettled([
            withDeadline(input.return(), 'stdin close', teardownTimeoutMs),
            withDeadline(E(proc).kill(), 'kill', teardownTimeoutMs),
          ]);
          if (inputResult.status === 'rejected')
            failures.push(inputResult.reason);
          if (killResult.status === 'rejected')
            failures.push(killResult.reason);
          try {
            await withDeadline(reaped(), 'process reap', teardownTimeoutMs);
          } catch (error) {
            failures.push(error);
          }
          try {
            await withDeadline(stderrDone, 'stderr drain', teardownTimeoutMs);
          } catch (error) {
            failures.push(error);
          }
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              'Codex app-server teardown failed',
            );
          }
        })();
        closeP.catch(() => undefined);
      }
      return closeP;
    };

    return harden({
      messages,
      send,
      close,
      wait: () => E(proc).wait(),
      diagnostics: () =>
        reapNote === '' ? stderrTail : `${stderrTail}\n[process: ${reapNote}]`,
    });
  } catch (error) {
    const failures = [error];
    const cleanup = await Promise.allSettled([
      withDeadline(E(proc).kill(), 'kill', teardownTimeoutMs),
      withDeadline(reaped(), 'process reap', teardownTimeoutMs),
      withDeadline(stderrDone, 'stderr drain', teardownTimeoutMs),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Codex app-server setup and cleanup failed',
        { cause: error },
      );
    }
    throw error;
  }
};
harden(startAppServerTransport);
