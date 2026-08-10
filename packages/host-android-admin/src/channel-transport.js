// @ts-check
/// <reference types="ses"/>
/* global setTimeout, clearTimeout */

/**
 * An {@link AdminTransport} over a message-oriented channel to the privileged
 * Android side of the bridge.
 *
 * The protocol itself (`@endo/exo-android-admin`'s `PROTOCOL.md`) carries no
 * correlation id: it assumes an ordered channel and leaves multiplexing to
 * the adapter.  This adapter is that layer.  It wraps each request envelope in
 * a frame carrying a monotonic id, matches replies back to their pending
 * promise, and bounds every call with a timeout so a wedged or crashed Android
 * side surfaces as a rejection rather than a CapTP call that never settles —
 * which, over a remote iroh link, would otherwise look like a hung operator
 * console.
 */

import { Fail, makeError, q, X } from '@endo/errors';

/**
 * @import { AdminRequest, AdminResult } from '@endo/exo-android-admin'
 * @import { BridgeChannel } from './types.js'
 */

/** Default per-call bound, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build a transport over a channel.
 *
 * @param {object} args
 * @param {BridgeChannel} args.channel - the raw duplex channel.  `send`
 *   delivers a frame to the Android side; `subscribe` registers the reply
 *   handler and returns an unsubscribe function.
 * @param {number} [args.timeoutMs] - per-call bound; a call that outlives it
 *   rejects and stops occupying the pending table.
 * @returns {{
 *   transport: (request: AdminRequest) => Promise<AdminResult>,
 *   stop: () => void,
 * }}
 */
export const makeChannelTransport = ({
  channel,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  (channel && typeof channel.send === 'function') ||
    Fail`makeChannelTransport: channel must provide a send function`;
  typeof channel.subscribe === 'function' ||
    Fail`makeChannelTransport: channel must provide a subscribe function`;
  (Number.isInteger(timeoutMs) && timeoutMs > 0) ||
    Fail`makeChannelTransport: timeoutMs must be a positive integer, got ${q(timeoutMs)}`;

  let nextId = 0;
  /**
   * Calls awaiting a reply, keyed by frame id.
   *
   * @type {Map<number, {
   *   resolve: (result: AdminResult) => void,
   *   reject: (reason: Error) => void,
   *   timer: ReturnType<typeof setTimeout>,
   * }>}
   */
  const pending = new Map();

  /**
   * Settle and forget a pending call.  Clearing the timer here rather than at
   * each call site is what keeps a late reply from firing a timeout that has
   * already been answered.
   *
   * @param {number} id
   */
  const takePending = id => {
    const entry = pending.get(id);
    if (entry === undefined) {
      return undefined;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  };

  /**
   * Handle one inbound frame.  A frame for an unknown id is dropped rather
   * than thrown: it is almost always a reply to a call that already timed out,
   * and a throw here would escape into the channel's listener.
   *
   * @param {unknown} frame
   */
  const onFrame = frame => {
    if (frame === null || typeof frame !== 'object') {
      console.error(
        '@endo/host-android-admin: dropping non-object frame from bridge',
      );
      return;
    }
    const { id, result } = /** @type {{ id?: unknown, result?: unknown }} */ (
      frame
    );
    if (typeof id !== 'number') {
      console.error(
        '@endo/host-android-admin: dropping bridge frame with no numeric id',
      );
      return;
    }
    const entry = takePending(id);
    if (entry === undefined) {
      return;
    }
    entry.resolve(/** @type {AdminResult} */ (result));
  };

  const unsubscribe = channel.subscribe(onFrame);

  /**
   * @param {AdminRequest} request
   * @returns {Promise<AdminResult>}
   */
  const transport = request => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          makeError(
            X`android admin bridge did not answer ${q(request.action)} within ${q(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        channel.send(harden({ id, request }));
      } catch (err) {
        takePending(id);
        reject(
          makeError(
            X`android admin bridge send failed for ${q(request.action)}: ${
              /** @type {Error} */ (err).message
            }`,
          ),
        );
      }
    });
  };

  /**
   * Tear down the transport: unsubscribe from the channel and fail every
   * in-flight call.  Wired to formula cancellation so a cancelled capability
   * does not leave callers waiting on a channel nobody is reading.
   */
  const stop = () => {
    unsubscribe();
    for (const id of [...pending.keys()]) {
      const entry = takePending(id);
      entry?.reject(makeError(X`android admin bridge transport was stopped`));
    }
  };

  return harden({ transport, stop });
};
harden(makeChannelTransport);
