// @ts-check

import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { encodeJsonLine, parseJsonLines } from './codex-protocol.js';

/** @import { SandboxHandle, ProcessHandle } from '@endo/sandbox/types.js' */

const DEFAULT_STDOUT_LIMIT = 64n * 1024n * 1024n;
const DEFAULT_STDERR_LIMIT = 1024n * 1024n;

/**
 * Start one long-lived `codex app-server` process inside an already-confined
 * sandbox slice. This adapter owns only stdio and process lifetime; credentials,
 * mounts, network policy, and slice disposal remain explicit caller powers.
 *
 * @param {object} options
 * @param {SandboxHandle} options.slice
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env]
 * @param {string} [options.executable]
 * @param {number} [options.maxLineBytes]
 * @param {bigint} [options.stdoutByteLimit]
 * @param {bigint} [options.stderrByteLimit]
 * @param {number} [options.maxRequestBytes]
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
}) => {
  const proc = /** @type {ProcessHandle} */ (
    await E(slice).spawn(
      harden([executable, 'app-server', '--listen', 'stdio://']),
      harden({
        cwd,
        env: harden({ ...env }),
        captureStdout: true,
        captureStderr: true,
        stdoutByteLimit,
        stderrByteLimit,
      }),
    )
  );

  /** @type {Promise<void>} */
  let stderrDone = Promise.resolve();
  try {
    const input = iterateBytesWriter(
      /** @type {any} */ (await E(proc).stdin()),
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

    const stdout = await E(proc).stdout();
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
            input.return(),
            E(proc).kill(),
          ]);
          if (inputResult.status === 'rejected')
            failures.push(inputResult.reason);
          if (killResult.status === 'rejected')
            failures.push(killResult.reason);
          try {
            await E(proc).wait();
          } catch (error) {
            failures.push(error);
          }
          try {
            await stderrDone;
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
      diagnostics: () => stderrTail,
    });
  } catch (error) {
    const failures = [error];
    const cleanup = await Promise.allSettled([
      E(proc).kill(),
      E(proc).wait(),
      stderrDone,
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
