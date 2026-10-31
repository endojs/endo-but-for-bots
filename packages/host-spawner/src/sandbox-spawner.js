// @ts-check

/**
 * The sandbox engine for the {@link Spawner} seam: each spawn runs inside an
 * already-granted `@endo/sandbox` slice instead of on the host.  The slice's
 * `ProcessHandle` is adapted to {@link ProcessLike} so a caller (the
 * `@endo/exo-shell` Shell) drives either engine through one contract.  This
 * is the one implementation of that adapter; `@endo/sandbox/spawner.js`
 * re-exports it.
 */

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

/**
 * @import { ERef, FarRef } from '@endo/eventual-send'
 * @import { ProcessLike, SandboxSlice, SandboxTerminationSignal, Spawner } from './types.js'
 */

const TERMINATION_SIGNALS = harden([
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGKILL',
]);

/**
 * Runaway output guard the slice enforces on each stream, independent of the
 * caller's truncate-and-drain `maxOutputBytes`.
 */
export const DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT = 1024n ** 3n;
harden(DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT);

/**
 * Build a {@link Spawner} whose children run inside `slice`.
 *
 * Only argv and copy-data execution options cross the boundary.  Native
 * process ownership, the runaway output guard, and cleanup remain with the
 * slice's factory.  Commands receive EOF on stdin; stdout and stderr arrive
 * as separate Endo byte readers.  The adapter neither discloses nor relies
 * on a remote OS pid, so `pid` is always `0`.
 *
 * A per-spawn `timeoutMs` goes to the slice unchanged, so the slice bounds
 * the process tree even if the caller's own timer never fires.  A per-spawn
 * `maxOutputBytes` does not become a slice limit: like a host process, a
 * sandboxed one may write past the caller's cap, and the caller truncates
 * and drains.  The slice's construction-time `outputByteLimit` is the only
 * kernel-side byte bound.
 *
 * The slice reports every terminal cancellation as a rejected `wait()`.  The
 * adapter translates exactly one of them, the kill its own caller requested:
 * once `kill()` has resolved, which the slice does only after it has reaped
 * the process, `wait()` settles as the `{ code: null, signal }` exit a host
 * process killed the same way reports.  Every other rejection, including the
 * slice's own timeout or output guard and any containment failure, reaches
 * the caller unchanged, as does a rejected `kill()`.
 *
 * @param {ERef<SandboxSlice> | FarRef<SandboxSlice>} slice  A local slice or
 *   a remote reference to one.
 * @param {{ outputByteLimit?: bigint }} [limits]  Trusted construction
 *   setting: the slice's per-stream byte limit.
 * @returns {Spawner}
 */
export const makeSandboxSpawner = (
  slice,
  { outputByteLimit = DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT } = {},
) => {
  (typeof outputByteLimit === 'bigint' && outputByteLimit > 0n) ||
    Fail`Invalid sandbox output byte limit`;
  /** @type {Spawner} */
  const spawn = async (argv, options = {}) => {
    (Array.isArray(argv) && argv.length > 0) ||
      Fail`Sandbox spawner: argv must be a non-empty string array`;
    options.shell !== true || Fail`Sandbox spawner requires structured argv`;
    const { cwd, env, timeoutMs } = options;
    const handle = await E(slice).spawn(
      harden([...argv]),
      harden({
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env: { ...env } }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        captureStdout: true,
        captureStderr: true,
        stdoutByteLimit: outputByteLimit,
        stderrByteLimit: outputByteLimit,
      }),
    );

    /** @type {string | undefined} */
    let requestedSignal;
    /** @type {Promise<void>[]} */
    const kills = [];

    const exited = E(handle)
      .wait()
      .then(
        status => harden({ code: status.code, signal: status.signal }),
        async error => {
          if (requestedSignal === undefined) throw error;
          // The slice resolves a kill only once it has reaped the process,
          // and rejects it when cleanup cannot prove containment, so the
          // kill outcome, not the wait rejection, says how the process
          // ended.
          await Promise.all(kills);
          return harden({ code: null, signal: requestedSignal });
        },
      );
    // Do not await remote EOF acknowledgement before publishing the controls.
    // A stalled stdin close must not hide an already-admitted process from kill.
    const completion = Promise.all([
      iterateBytesWriter(E(handle).stdin()).return(),
      exited,
    ]).then(([, status]) => status);
    void completion.catch(() => {});

    /** @type {ProcessLike} */
    const processLike = harden({
      pid: 0,
      stdout: iterateBytesReader(E(handle).stdout()),
      stderr: iterateBytesReader(E(handle).stderr()),
      wait: () => completion,
      /** @param {string | number} [signal] */
      kill: (signal = 'SIGTERM') => {
        TERMINATION_SIGNALS.includes(/** @type {string} */ (signal)) ||
          Fail`Unsupported sandbox termination signal ${signal}`;
        requestedSignal ??= /** @type {string} */ (signal);
        // The slice's kill is idempotent: a second kill (the SIGKILL
        // escalation) shares the first one's reap, so there is no
        // already-reaped race to suppress and every rejection is a real
        // cleanup failure.
        const killed = E(handle).kill(
          /** @type {SandboxTerminationSignal} */ (signal),
        );
        kills.push(killed);
        void killed.catch(() => {});
        return killed;
      },
    });
    return processLike;
  };
  return harden(spawn);
};
harden(makeSandboxSpawner);
