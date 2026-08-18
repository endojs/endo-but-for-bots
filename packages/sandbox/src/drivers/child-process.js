// @ts-check

/* global Buffer, clearTimeout, process, setTimeout */

import { makeError, q, X } from '@endo/errors';

/**
 * Child-process helpers shared by the backend drivers.
 *
 * Both drivers shell out to short-lived control commands (`--version`
 * probes, `podman create`, `pasta`, `nft -f`) and both adapt the Node
 * streams of a long-lived child onto the `DriverProcess` contract. The
 * helpers live here rather than in each driver so the deadline policy
 * that the lifecycle depends on cannot be applied to one backend and
 * forgotten on the other, as it was when each driver carried its own
 * copy.
 */

/**
 * Spawn a child process and collect its stdout / stderr.
 *
 * A `timeoutMs` deadline or an `AbortSignal` bounds control commands
 * that must not stall the sandbox lifecycle: on expiry or abort the
 * child is hard-killed and the promise rejects with a structured error.
 *
 * @param {typeof import('child_process')} cpModule
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>}
 */
export const spawnAndCollect = (cpModule, command, args, options = {}) => {
  const { timeoutMs, signal: abortSignal } = options;
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(makeError(X`${q(command)} control command aborted`));
      return;
    }
    let child;
    try {
      child = cpModule.spawn(command, args, { stdio: 'pipe' });
    } catch (e) {
      reject(/** @type {Error} */ (e));
      return;
    }
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    /** @type {(() => void) | undefined} */
    let removeAbortListener;
    // Release the deadline timer and the abort listener on whichever
    // outcome lands first, so a settled command leaves nothing behind.
    const release = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      removeAbortListener?.();
    };
    /** @param {Error} failure */
    const abandon = failure => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The control command may already have exited.
      }
      release();
      reject(failure);
    };
    child.stdout?.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr?.on('data', chunk => stderrChunks.push(chunk));
    child.once('error', error => {
      release();
      reject(error);
    });
    child.once('close', (code, exitSignal) => {
      release();
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    if (timeoutMs !== undefined) {
      deadline = setTimeout(
        () =>
          abandon(
            makeError(
              X`${q(command)} control command timed out after ${q(timeoutMs)}ms`,
            ),
          ),
        timeoutMs,
      );
      if (typeof deadline.unref === 'function') deadline.unref();
    }
    if (abortSignal !== undefined) {
      const onAbort = () =>
        abandon(makeError(X`${q(command)} control command aborted`));
      abortSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () =>
        abortSignal.removeEventListener('abort', onAbort);
    }
  });
};
harden(spawnAndCollect);

/**
 * Wrap a Node `Readable` stream as a single-use async iterable of
 * `Uint8Array` chunks.  Each `[Symbol.asyncIterator]()` call returns
 * the SAME underlying stream iterator — Node streams are not
 * re-iterable.  The factory's reader-ref adapter consumes the
 * iterator exactly once.
 *
 * @param {NodeJS.ReadableStream | null} stream
 * @returns {AsyncIterable<Uint8Array> | null}
 */
export const readableToAsyncIterable = stream => {
  if (stream === null || stream === undefined) return null;
  /** @type {AsyncIterableIterator<Uint8Array> | null} */
  let cached = null;
  return {
    [Symbol.asyncIterator]() {
      if (cached === null) {
        cached = /** @type {any} */ (stream)[Symbol.asyncIterator]();
      }
      return /** @type {AsyncIterableIterator<Uint8Array>} */ (cached);
    },
  };
};
harden(readableToAsyncIterable);

/**
 * Terminate a detached child's whole process group.
 *
 * Drivers that spawn with `detached: true` own a distinct host process
 * group, so one negative-pid signal reaches the launcher, the sandbox
 * binary, and every descendant. `ESRCH` means the group is already
 * gone, which is the success case for a termination path; anything else
 * is a live failure the supervisor must see.
 *
 * Signalling a group only happens while the child is demonstrably live.
 * Node leaves `child.pid` populated after the child has been reaped, so
 * an unguarded `process.kill(-pid, …)` on an exited child aims a signal
 * at a pgid the kernel is free to have handed to somebody else — the
 * one failure mode where this function kills a process it does not own.
 * `child.pid` is also `undefined` when the spawn itself failed, and
 * exactly one of `exitCode` / `signalCode` becomes non-null once Node
 * reaps the child, while both are null for a live one.
 *
 * Declining to signal returns normally rather than throwing: the
 * caller's desired end state — that process group is gone — already
 * holds, which is the same reason `ESRCH` is swallowed below. The
 * supervisor treats any error out of a driver kill as a live backend
 * failure, so reporting here would manufacture a cleanup error out of
 * an ordinary already-exited process.
 *
 * The check remains a narrow TOCTOU: the child can exit between the
 * guard and the signal. It cannot be closed from here, because the pid
 * only becomes reusable once Node reaps the child, and that is the very
 * transition being observed. The guard removes the window that stays
 * open indefinitely — an already-reaped child — and leaves the residual
 * one, which is bounded by a single turn.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {NodeJS.Signals | number} signal
 * @returns {void}
 */
export const killProcessGroup = (child, signal) => {
  const { pid, exitCode, signalCode } = child;
  if (pid === undefined) return;
  if (exitCode !== null || signalCode !== null) return;
  try {
    process.kill(-pid, signal);
  } catch (e) {
    const err = /** @type {Error & { code?: string }} */ (e);
    if (err.code !== 'ESRCH') throw err;
  }
};
harden(killProcessGroup);
