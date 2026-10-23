// @ts-check

/**
 * The sandbox engine for the {@link Spawner} seam: each spawn runs inside an
 * `@endo/sandbox` slice instead of on the host.  The slice's `ProcessHandle`
 * is adapted to {@link ProcessLike} so a caller (the `@endo/exo-shell` Shell)
 * drives either engine through one contract.
 */

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

/**
 * @import { ERef } from '@endo/eventual-send'
 * @import { ProcessLike, SandboxSlice, Spawner } from './types.js'
 */

const TERMINATION_SIGNALS = harden([
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGKILL',
]);

/**
 * Count the bytes an async-iterable stream yields, so the adapter can tell an
 * output-limit termination from any other slice failure without parsing error
 * messages.  `drained` settles once the consumer's iteration ends, however it
 * ends.
 *
 * @param {AsyncIterable<Uint8Array>} stream
 */
const makeCountedStream = stream => {
  let byteCount = 0;
  /** @type {() => void} */
  let markDrained = () => {};
  /** @type {Promise<void>} */
  const drained = new Promise(resolve => {
    markDrained = () => resolve(undefined);
  });
  const counted = harden({
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          byteCount += chunk.byteLength;
          yield chunk;
        }
      } finally {
        markDrained();
      }
    },
  });
  return harden({ counted, drained, byteCount: () => byteCount });
};

/**
 * Build a {@link Spawner} whose children run inside `slice`.
 *
 * Per-spawn `timeoutMs` and `maxOutputBytes` become the slice's kernel-side
 * `timeoutMs` and `stdoutByteLimit` / `stderrByteLimit`, so the slice enforces
 * the same bounds the caller does.  The byte limit is one more than
 * `maxOutputBytes`: the slice terminates a process once a stream reaches its
 * limit, and the caller can only flag truncation if it observes a byte past
 * its own cap.
 *
 * The slice reports every terminal cancellation (a kill, its own timeout, a
 * byte limit) as a rejected `wait()`.  The adapter turns the expected ones
 * into the `{ code: null, signal }` exit a host process killed the same way
 * reports.  Any other rejection, such as a containment failure, still rejects.
 *
 * Shell mode is refused: argv runs as given, never through `/bin/sh -c`.
 *
 * @param {ERef<SandboxSlice>} slice
 * @returns {Spawner}
 */
export const makeSandboxSpawner = slice => {
  /** @type {Spawner} */
  const spawn = async (argv, opts = {}) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw Error('sandbox spawner: argv must be a non-empty string array');
    }
    if (opts.shell === true) {
      throw Error(
        'sandbox spawner: shell mode is not supported; pass an argv array',
      );
    }
    const { cwd, env, timeoutMs, maxOutputBytes } = opts;
    const byteLimit =
      maxOutputBytes === undefined ? undefined : BigInt(maxOutputBytes) + 1n;
    const handle = await E(slice).spawn(
      harden([...argv]),
      harden({
        ...(cwd !== undefined ? { cwd } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(byteLimit !== undefined
          ? { stdoutByteLimit: byteLimit, stderrByteLimit: byteLimit }
          : {}),
      }),
    );
    const startedAt = Date.now();
    const pid = await E(handle).pid();

    /** @type {string | undefined} */
    let requestedSignal;
    const stdout = makeCountedStream(iterateBytesReader(E(handle).stdout()));
    const stderr = makeCountedStream(iterateBytesReader(E(handle).stderr()));
    const overLimit = () =>
      maxOutputBytes !== undefined &&
      (stdout.byteCount() > maxOutputBytes ||
        stderr.byteCount() > maxOutputBytes);
    const pastDeadline = () =>
      timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs;

    const exited = E(handle)
      .wait()
      .then(
        status => harden({ code: status.code, signal: status.signal }),
        async error => {
          // The slice can reject before the caller has read the overflowing
          // bytes, so the verdict waits for both drains.  As with a host
          // child, whose `close` follows the end of its stdio, the caller is
          // expected to drain stdout and stderr.
          await Promise.all([stdout.drained, stderr.drained]);
          if (requestedSignal !== undefined) {
            return harden({ code: null, signal: requestedSignal });
          }
          // The slice terminates with its supervisor's SIGTERM-to-SIGKILL
          // ladder; the process is reaped by the uncatchable signal.
          if (overLimit() || pastDeadline()) {
            return harden({ code: null, signal: 'SIGKILL' });
          }
          throw error;
        },
      );

    /** @type {ProcessLike} */
    const processLike = harden({
      pid,
      stdout: stdout.counted,
      stderr: stderr.counted,
      wait: () => exited,
      /** @param {string | number} [signal] */
      kill: async (signal = 'SIGTERM') => {
        const name = String(signal);
        if (!TERMINATION_SIGNALS.includes(name)) {
          throw Error(`sandbox spawner: unsupported signal ${name}`);
        }
        if (requestedSignal === undefined) {
          requestedSignal = name;
        }
        // A second kill (the SIGKILL escalation) can race the first one's
        // reaping, and the slice may reject it once the process is gone.
        // `wait()` carries the outcome, so the kill itself never rejects.
        await E(handle)
          .kill(/** @type {any} */ (name))
          .catch(() => {});
      },
    });
    return processLike;
  };
  return harden(spawn);
};
harden(makeSandboxSpawner);
