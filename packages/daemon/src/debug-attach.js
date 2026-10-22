// @ts-check

/**
 * @file Hot-attach the XS debugger to a running worker
 * (designs/daemon-xs-worker-debugger.md, Layer 6).
 *
 * Sends the worker a `debug-attach` envelope and, once the worker
 * acknowledges with `debug-attached`, registers a DebugSession the
 * envelope dispatcher feeds the worker's `debug` traffic into and
 * resolves to a Debugger exo over that session.  Concurrent attaches to
 * one worker share one request; an attach to a worker that already has
 * a session reuses it.  A worker that goes away rejects its pending
 * attach rather than leaving the caller waiting forever.
 */

import { makePromiseKit } from '@endo/promise-kit';
import { makeError, q, X } from '@endo/errors';
import { makeDebugSession } from './debug-session.js';
import { makeDebugger } from './debugger.js';

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { DebugSession, Debugger } from './types.js' */
/** @import { Envelope } from './envelope.js' */

/**
 * @param {object} powers
 * @param {(handle: number, verb: string, payload?: Uint8Array, nonce?: number) => void} powers.sendEnvelope
 * @param {() => number} powers.allocNonce
 * @param {Map<number, DebugSession>} powers.debugSessions
 *   Sessions the envelope dispatcher feeds `debug` traffic into.
 */
export const makeDebugAttacher = ({
  sendEnvelope,
  allocNonce,
  debugSessions,
}) => {
  /** @type {Map<number, { workerHandle: number, kit: PromiseKit<Debugger> }>} */
  const pendingByNonce = new Map();
  /** @type {Map<number, Promise<Debugger>>} */
  const pendingByHandle = new Map();

  /**
   * @param {number} workerHandle
   * @returns {Promise<Debugger>}
   */
  const attach = workerHandle => {
    const session = debugSessions.get(workerHandle);
    if (session !== undefined) {
      return Promise.resolve(makeDebugger(session));
    }
    const pending = pendingByHandle.get(workerHandle);
    if (pending !== undefined) {
      return pending;
    }
    const nonce = allocNonce();
    const kit = /** @type {PromiseKit<Debugger>} */ (makePromiseKit());
    pendingByNonce.set(nonce, { workerHandle, kit });
    pendingByHandle.set(workerHandle, kit.promise);
    sendEnvelope(workerHandle, 'debug-attach', undefined, nonce);
    return kit.promise;
  };

  /**
   * Route a `debug-attached` acknowledgement to its pending attach.
   * Returns whether the envelope answered one; an acknowledgement from
   * a different worker than the one asked is not an answer.
   *
   * @param {Envelope} envelope
   */
  const handleAttached = envelope => {
    const pending = pendingByNonce.get(envelope.nonce);
    if (!pending || pending.workerHandle !== envelope.handle) {
      return false;
    }
    const { workerHandle, kit } = pending;
    pendingByNonce.delete(envelope.nonce);
    pendingByHandle.delete(workerHandle);
    const session = makeDebugSession(xmlBytes => {
      sendEnvelope(workerHandle, 'debug', xmlBytes);
    });
    debugSessions.set(workerHandle, session);
    kit.resolve(makeDebugger(session));
    return true;
  };

  /**
   * Return the worker's debug hooks to dormant.  Detaching a worker
   * with no debugger attached does nothing.
   *
   * @param {number} workerHandle
   */
  const detach = workerHandle => {
    if (!debugSessions.delete(workerHandle)) {
      return;
    }
    sendEnvelope(workerHandle, 'debug-detach', undefined, allocNonce());
  };

  /**
   * Forget a worker whose connection closed, rejecting an attach still
   * waiting on it.
   *
   * @param {number} workerHandle
   */
  const forgetWorker = workerHandle => {
    debugSessions.delete(workerHandle);
    pendingByHandle.delete(workerHandle);
    for (const [nonce, pending] of pendingByNonce) {
      if (pending.workerHandle === workerHandle) {
        pendingByNonce.delete(nonce);
        pending.kit.reject(
          makeError(
            X`attachDebugger: worker handle ${q(workerHandle)} closed before the debugger attached`,
          ),
        );
      }
    }
  };

  return harden({ attach, handleAttached, detach, forgetWorker });
};
harden(makeDebugAttacher);
