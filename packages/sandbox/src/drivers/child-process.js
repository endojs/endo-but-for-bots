// @ts-check

/* global Buffer, clearTimeout, process, setTimeout */

import { makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';

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
 * Start a control command with separate outcome and native lifetime evidence.
 * Timeout, cancellation, and error can reject result before closed settles.
 * The host owner must retain the command until closed; neither a rejected
 * result nor accepted SIGKILL proves the child has been reaped.
 *
 * closed covers this direct child and its stdio, not arbitrary descendants or
 * remote engine work. wasInterrupted records a requested termination, not proof
 * of its effect; drivers must preserve uncertain effects for reconciliation.
 * hasChild records whether spawn returned a child handle. False proves that
 * this attempt acquired none; true does not prove that native startup succeeded.
 *
 * @param {typeof import('child_process')} cpModule
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cancelled?: import('@endo/cancel').Cancelled, isCancelled?: import('@endo/cancel').IsCancelled, env?: Readonly<Record<string,string>> }} [options]
 */
export const startControlCommand = (cpModule, command, args, options = {}) => {
  const { timeoutMs, cancelled, isCancelled, env } = options;
  /** @type {ReturnType<typeof makePromiseKit<{ code: number | null; signal: string | null; stdout: string; stderr: string }>>} */
  const outcome = makePromiseKit();
  /** @type {ReturnType<typeof makePromiseKit<void>>} */
  const closure = makePromiseKit();
  /** @type {import('child_process').ChildProcess | undefined} */
  let child;
  let settled = false;
  let exited = false;
  let closed = false;
  let interrupted = false;
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  /** @type {Buffer[]} */
  const stderrChunks = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let deadline;
  const release = () => {
    settled = true;
    if (deadline !== undefined) clearTimeout(deadline);
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
  };
  /** @param {Error} error */
  const fail = error => {
    if (settled) return;
    release();
    outcome.reject(error);
  };
  /** @param {Error} [reason] */
  const abort = (
    reason = makeError(X`${q(command)} control command aborted`),
  ) => {
    if (closed) return;
    fail(reason);
    // Node can retain pid after exit while inherited pipes remain open. Never
    // signal that stale identity; closure still waits for the pipes to settle.
    if (child !== undefined && !exited) {
      interrupted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Failure is not a release. The owner still has the unresolved closure.
      }
    }
  };
  const control = harden({
    result: outcome.promise,
    closed: closure.promise,
    abort,
    wasInterrupted: () => interrupted,
    hasChild: () => child !== undefined,
  });
  if (isCancelled?.()) {
    fail(makeError(X`${q(command)} control command aborted`));
    closed = true;
    closure.resolve(undefined);
    return control;
  }
  try {
    child = cpModule.spawn(command, args, {
      stdio: 'pipe',
      ...(env ? { env } : {}),
    });
  } catch (error) {
    fail(/** @type {Error} */ (error));
    closed = true; // No child was acquired.
    closure.resolve(undefined);
    return control;
  }
  child.stdout?.on('data', chunk => {
    if (!settled) stdoutChunks.push(chunk);
  });
  child.stderr?.on('data', chunk => {
    if (!settled) stderrChunks.push(chunk);
  });
  child.once('error', fail);
  child.once('exit', () => {
    exited = true;
  });
  child.once('close', (code, signal) => {
    closed = true;
    if (!settled) {
      outcome.resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
      release();
    }
    closure.resolve(undefined);
  });
  if (timeoutMs !== undefined) {
    deadline = setTimeout(
      () =>
        abort(
          makeError(
            X`${q(command)} control command timed out after ${q(timeoutMs)}ms`,
          ),
        ),
      timeoutMs,
    );
    if (typeof deadline.unref === 'function') deadline.unref();
  }
  if (cancelled !== undefined) {
    void cancelled.catch(() => abort());
  }
  return control;
};
harden(startControlCommand);

/**
 * Collect a command outcome. Callers that own resources the command can create
 * must use startControlCommand and retain its separate closure evidence.
 * A deadline bounds result settlement, not child or descendant lifetime.
 *
 * @param {typeof import('child_process')} cpModule
 * @param {string} command
 * @param {string[]} args
 * @param {Parameters<typeof startControlCommand>[3]} [options]
 */
export const spawnAndCollect = (cpModule, command, args, options = {}) =>
  startControlCommand(cpModule, command, args, options).result;
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
