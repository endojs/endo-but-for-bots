// @ts-check
/* eslint-disable no-bitwise -- CBOR integer encoding */

/**
 * @file Restart a worker under the XS debugger
 * (designs/daemon-debug-worker-restart.md, Phase 2).
 *
 * Sequences existing supervisor verbs: `suspend` the worker to the
 * CAS, set its `debug-flag`, then deliver a benign `ping` so the
 * supervisor resumes it with the debugger enabled.  The resumed XS
 * machine pauses at `<login>` before executing any code; the
 * returned Debugger is connected and the worker stays paused until
 * the caller issues `go()` or `step()`.
 */

import { makePromiseKit } from '@endo/promise-kit';
import { makeDebugSession } from './debug-session.js';
import { makeDebugger } from './debugger.js';

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { DebugSession, Debugger } from './types.js' */
/** @import { Envelope } from './envelope.js' */

/**
 * CBOR map `{"handle": <uint>}`, the payload of the `suspend` and
 * `debug-flag` control verbs.
 *
 * @param {number} handle
 * @returns {Uint8Array}
 */
export const encodeHandleRequest = handle => {
  if (!Number.isSafeInteger(handle) || handle <= 0 || handle > 0xffff_ffff) {
    throw new RangeError(`Invalid worker handle: ${handle}`);
  }
  // 0xa1: map(1); 0x66 "handle": text(6).
  const buf = [0xa1, 0x66, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65];
  if (handle < 24) {
    buf.push(handle);
  } else if (handle <= 0xff) {
    buf.push(0x18, handle);
  } else if (handle <= 0xffff) {
    buf.push(0x19, handle >> 8, handle & 0xff);
  } else {
    buf.push(
      0x1a,
      (handle >>> 24) & 0xff,
      (handle >> 16) & 0xff,
      (handle >> 8) & 0xff,
      handle & 0xff,
    );
  }
  return new Uint8Array(buf);
};
harden(encodeHandleRequest);

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
  /** @type {Map<number, { resolve: () => void, reject: (reason: Error) => void }>} */
  const pendingSuspends = new Map();

  /**
   * Fire-and-forget: the next resume of `workerHandle` enables the
   * XS debugger before machine restoration.
   *
   * @param {number} workerHandle
   */
  const debugFlag = workerHandle => {
    sendEnvelope(0, 'debug-flag', encodeHandleRequest(workerHandle), 0);
  };

  /**
   * Suspend a worker and wait for its `suspended` reply.
   *
   * @param {number} workerHandle
   * @returns {Promise<void>}
   */
  const requestSuspend = workerHandle => {
    const nonce = allocNonce();
    const { promise, resolve, reject } = /** @type {PromiseKit<void>} */ (
      makePromiseKit()
    );
    pendingSuspends.set(nonce, { resolve, reject });
    sendEnvelope(0, 'suspend', encodeHandleRequest(workerHandle), nonce);
    return promise;
  };

  /**
   * Route a `suspended`, `suspend-error`, or `error` reply.
   * Returns whether the envelope answered a pending suspend.
   *
   * @param {Envelope} env
   * @param {(bytes: Uint8Array) => string} decodeText
   */
  const handleSuspendReply = (env, decodeText) => {
    const pending = pendingSuspends.get(env.nonce);
    if (!pending) {
      return false;
    }
    if (env.verb === 'suspended') {
      pendingSuspends.delete(env.nonce);
      pending.resolve();
      return true;
    }
    if (env.verb === 'suspend-error' || env.verb === 'error') {
      pendingSuspends.delete(env.nonce);
      pending.reject(Error(decodeText(env.payload)));
      return true;
    }
    return false;
  };

  /**
   * @param {number} workerHandle
   * @returns {Promise<Debugger>}
   */
  const debugWorker = async workerHandle => {
    if (debugSessions.has(workerHandle)) {
      throw Error(
        `Worker handle ${workerHandle} already has a debugger attached`,
      );
    }
    await requestSuspend(workerHandle);
    debugFlag(workerHandle);
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

  return harden({ debugWorker, debugFlag, handleSuspendReply });
};
harden(makeDebugWorkerRestarter);
