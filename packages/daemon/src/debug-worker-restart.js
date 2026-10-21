// @ts-check
/* eslint-disable no-bitwise -- CBOR integer encoding */

/**
 * @file Restart a worker under the XS debugger
 * (designs/daemon-debug-worker-restart.md, Phase 2).
 *
 * Sequences supervisor verbs: arm the worker's `debug-flag` (which the
 * supervisor refuses for a worker that cannot honor it), `suspend` the
 * worker to the CAS, then deliver a benign `ping` so the supervisor
 * resumes it with the debugger enabled.  The resumed XS machine pauses
 * at `<login>` before executing any code; the returned Debugger is
 * connected and the worker stays paused until the caller issues
 * `go()` or `step()`.
 */

import { makePromiseKit } from '@endo/promise-kit';
import { makeError, q, X } from '@endo/errors';
import { makeDebugSession } from './debug-session.js';
import { makeDebugger } from './debugger.js';

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { DebugSession, Debugger } from './types.js' */
/** @import { Envelope } from './envelope.js' */

/**
 * CBOR map `{"handle": <uint>}`, the payload of the `suspend`,
 * `debug-flag`, and `debug-unflag` control verbs.
 *
 * The supervisor's handle type is a signed 64-bit integer allocated
 * upward from 1, but the manager carries handles as JavaScript numbers
 * (envelope decoding included), so the encodable domain is narrowed to
 * the positive safe integers.
 *
 * @param {number} handle
 * @returns {Uint8Array}
 */
export const encodeHandleRequest = handle => {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw makeError(X`Invalid worker handle: ${q(handle)}`, RangeError);
  }
  // 0xa1: map(1); 0x66 "handle": text(6).
  const bytes = [0xa1, 0x66, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65];
  /** @param {number} value */
  const pushUint32 = value => {
    bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  };
  if (handle < 24) {
    bytes.push(handle);
  } else if (handle <= 0xff) {
    bytes.push(0x18, handle);
  } else if (handle <= 0xffff) {
    bytes.push(0x19, handle >> 8, handle & 0xff);
  } else if (handle <= 0xffff_ffff) {
    bytes.push(0x1a);
    pushUint32(handle);
  } else {
    bytes.push(0x1b);
    pushUint32(Math.floor(handle / 0x1_0000_0000));
    pushUint32(handle % 0x1_0000_0000);
  }
  return new Uint8Array(bytes);
};
harden(encodeHandleRequest);

/**
 * @typedef {object} PendingReply
 * @property {number[]} sources
 *   Envelope handles a reply may carry: 0 for the supervisor itself,
 *   or the worker whose reply the supervisor forwarded.
 * @property {string} success
 * @property {string[]} failures
 * @property {() => void} resolve
 * @property {(reason: Error) => void} reject
 */

/**
 * @param {object} powers
 * @param {(handle: number, verb: string, payload?: Uint8Array, nonce?: number) => void} powers.sendEnvelope
 * @param {() => number} powers.allocNonce
 * @param {Map<number, DebugSession>} powers.debugSessions
 *   Sessions the envelope dispatcher feeds `debug` traffic into.
 */
export const makeDebugWorkerRestarter = ({
  sendEnvelope,
  allocNonce,
  debugSessions,
}) => {
  /** @type {Map<number, PendingReply>} */
  const pendingReplies = new Map();
  /** @type {Set<number>} */
  const restarting = new Set();

  /**
   * Send a supervisor request and wait for its correlated reply.
   *
   * @param {string} verb
   * @param {number} workerHandle
   * @param {Omit<PendingReply, 'resolve' | 'reject'>} expected
   * @returns {Promise<void>}
   */
  const request = (verb, workerHandle, expected) => {
    const nonce = allocNonce();
    const { promise, resolve, reject } = /** @type {PromiseKit<void>} */ (
      makePromiseKit()
    );
    pendingReplies.set(nonce, harden({ ...expected, resolve, reject }));
    sendEnvelope(0, verb, encodeHandleRequest(workerHandle), nonce);
    return promise;
  };

  /**
   * Route a reply to a pending `debug-flag` or `suspend` request.
   * Returns whether the envelope answered one; an envelope from any
   * other source than the expected one is not an answer.
   *
   * @param {Envelope} envelope
   * @param {(bytes: Uint8Array) => string} decodeText
   */
  const handleReply = (envelope, decodeText) => {
    const pending = pendingReplies.get(envelope.nonce);
    if (!pending || !pending.sources.includes(envelope.handle)) {
      return false;
    }
    if (envelope.verb === pending.success) {
      pendingReplies.delete(envelope.nonce);
      pending.resolve();
      return true;
    }
    if (pending.failures.includes(envelope.verb)) {
      pendingReplies.delete(envelope.nonce);
      pending.reject(
        makeError(
          X`debugWorker: ${q(envelope.verb)} from the supervisor: ${q(decodeText(envelope.payload))}`,
        ),
      );
      return true;
    }
    return false;
  };

  /**
   * @param {number} workerHandle
   * @returns {Promise<Debugger>}
   */
  const restart = async workerHandle => {
    // The supervisor refuses a worker that cannot resume under the
    // debugger before anything changes its state.
    await request('debug-flag', workerHandle, {
      sources: [0],
      success: 'debug-flagged',
      failures: ['error'],
    });
    try {
      await request('suspend', workerHandle, {
        sources: [0, workerHandle],
        success: 'suspended',
        failures: ['suspend-error', 'error'],
      });
    } catch (error) {
      sendEnvelope(0, 'debug-unflag', encodeHandleRequest(workerHandle), 0);
      throw error;
    }
    const session = makeDebugSession(xmlBytes => {
      sendEnvelope(workerHandle, 'debug', xmlBytes);
    });
    const login = session.waitForLogin();
    // Registered before the resume so the <login> is not dropped.
    debugSessions.set(workerHandle, session);
    // Any envelope to a suspended handle resumes it; the worker
    // ignores the verb once restored.
    sendEnvelope(workerHandle, 'ping');
    await login;
    return makeDebugger(session);
  };

  /**
   * @param {number} workerHandle
   * @returns {Promise<Debugger>}
   */
  const debugWorker = async workerHandle => {
    if (debugSessions.has(workerHandle)) {
      throw makeError(
        X`Worker handle ${q(workerHandle)} already has a debugger attached`,
      );
    }
    if (restarting.has(workerHandle)) {
      throw makeError(
        X`Worker handle ${q(workerHandle)} is already restarting under the debugger`,
      );
    }
    // Reserved before the first await, so a concurrent call is refused
    // rather than racing this one's suspend.
    restarting.add(workerHandle);
    return restart(workerHandle).finally(() => {
      restarting.delete(workerHandle);
    });
  };

  return harden({ debugWorker, handleReply });
};
harden(makeDebugWorkerRestarter);
