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

/**
 * Adapt an already-granted slice to the local Spawner seam used by exo-shell.
 * Only argv and copy-data execution options cross the boundary. Native process
 * ownership, output ceilings, and cleanup remain with the slice's factory.
 * Buffered commands receive EOF on stdin; stdout/stderr use separate Endo byte
 * readers. The local adapter does not disclose or rely on a remote OS PID.
 *
 * @param {ERef<SandboxHandle>} slice
 */
export const makeSandboxSpawner = slice => {
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
