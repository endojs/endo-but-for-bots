// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { SandboxHandle, TerminationSignal } from './types.js' */

const terminationSignals = harden([
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGKILL',
]);

/** Runaway output guard, independent of Shell's truncate-and-drain preview. */
export const DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT = 1024n ** 3n;
harden(DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT);

/**
 * Adapt an already-granted slice to the local Spawner seam used by exo-shell.
 * Only argv and copy-data execution options cross the boundary. Native process
 * ownership, output ceilings, and cleanup remain with the slice's factory.
 * Buffered commands receive EOF on stdin; stdout/stderr use separate Endo byte
 * readers. The local adapter does not disclose or rely on a remote OS PID.
 *
 * @param {ERef<SandboxHandle>} slice
 * @param {{ outputByteLimit?: bigint }} [limits] Trusted construction setting.
 */
export const makeSandboxSpawner = (
  slice,
  { outputByteLimit = DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT } = {},
) => {
  (typeof outputByteLimit === 'bigint' && outputByteLimit > 0n) ||
    Fail`Invalid sandbox output byte limit`;
  /**
   * @param {readonly string[]} argv
   * @param {{ cwd?: string, env?: Record<string, string>, shell?: boolean, timeoutMs?: number }} [options]
   */
  const spawn = async (argv, options = {}) => {
    options.shell !== true || Fail`Sandbox spawner requires structured argv`;
    const process = await E(slice).spawn(
      harden([...argv]),
      harden({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        captureStdout: true,
        captureStderr: true,
        stdoutByteLimit: outputByteLimit,
        stderrByteLimit: outputByteLimit,
      }),
    );
    const stdout = iterateBytesReader(E(process).stdout());
    const stderr = iterateBytesReader(E(process).stderr());
    // Do not await remote EOF acknowledgement before publishing the controls.
    // A stalled stdin close must not hide an already-admitted process from kill.
    const completion = Promise.all([
      iterateBytesWriter(E(process).stdin()).return(),
      E(process).wait(),
    ]).then(([, status]) => status);
    void completion.catch(() => {});
    return harden({
      pid: 0,
      stdout,
      stderr,
      wait: () => completion,
      /** @param {string | number} [signal] */
      kill: (signal = 'SIGTERM') => {
        terminationSignals.includes(/** @type {string} */ (signal)) ||
          Fail`Unsupported sandbox termination signal ${signal}`;
        return E(process).kill(/** @type {TerminationSignal} */ (signal));
      },
    });
  };
  return harden(spawn);
};
harden(makeSandboxSpawner);
