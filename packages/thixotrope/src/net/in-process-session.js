// @ts-check
/** @import { RandomPowers } from '../platform/random.js' */
import harden from '@endo/harden';
import { makeOcapn } from '@endo/ocapn';

import { derivePipeResumption } from './pipe-network.js';

/**
 * An OCapN client in this process whose one session is a session on the
 * hub: no socket and no handshake. Frames the client writes go to the hub's
 * sink, queued until the session is attached; frames the hub sends go to
 * the client's message handler. The endpoint and the transient client are
 * both this, differing in what they attach and when.
 *
 * @param {object} options
 * @param {RandomPowers} options.random
 * @param {any} options.codec
 * @param {any} options.hub
 * @param {string} options.id what the session's identity is derived from
 * @param {string} options.sessionKey the hub's key for the session
 * @param {string} options.networkId
 * @param {any} options.logger
 * @param {string} options.debugLabel
 * @param {Record<string, any>} [options.sessionHooks]
 * @param {any} [options.location] the client's own location; the session's
 *   peer location by default
 * @param {() => boolean} options.isClosed
 * @param {() => void} options.onEnd what ending the connection does
 * @param {() => void} options.onShutdown what shutting the network down does
 */
export const makeInProcessHubSession = async ({
  random,
  codec,
  hub,
  id,
  sessionKey,
  networkId,
  logger,
  debugLabel,
  sessionHooks = undefined,
  location = undefined,
  isClosed,
  onEnd,
  onShutdown,
}) => {
  const resumption = derivePipeResumption({
    codec,
    workerId: id,
    role: 'worker',
  });
  /** @type {any} */
  let handlers;
  /** @type {any} */
  let sink;
  /** @type {Uint8Array[]} */
  const outbound = [];
  const connection = harden({
    netlayer: harden({ location: resumption.peerLocation }),
    isOutgoing: true,
    get isDestroyed() {
      return isClosed();
    },
    /** @param {Uint8Array} bytes */
    write: bytes => {
      if (isClosed()) return;
      if (sink === undefined) outbound.push(bytes);
      else sink.deliver(bytes);
    },
    end: onEnd,
  });
  const client = await makeOcapn({
    randomBytes: length => random.randomBytes(length),
    logger,
    codec,
    debugLabel,
    ...(sessionHooks === undefined ? {} : { sessionHooks }),
    network: (/** @type {any} */ nextHandlers) => {
      handlers = nextHandlers;
      return harden({
        networkId,
        codec,
        location: location ?? resumption.peerLocation,
        shutdown: onShutdown,
      });
    },
  });
  return harden({
    client,
    connection,
    resumption,
    /** The client's handlers, for the connection's close. */
    handlers: () => handlers,
    /**
     * Establish the session through the resume seam: no handshake, and
     * exports the client can restore.
     */
    resume: () => handlers.resumeSession(connection, resumption),
    /**
     * Attach the session to the hub and deliver the frames written before.
     * @param {Record<string, any>} [options] the hub's attach options
     *   beside `send`
     */
    attach: (options = {}) => {
      sink = hub.attachSession(sessionKey, {
        ...options,
        send: (/** @type {Uint8Array} */ bytes) => {
          if (!isClosed()) handlers.handleMessageData(connection, bytes);
        },
      });
      for (const bytes of outbound.splice(0)) sink.deliver(bytes);
      return sink;
    },
    /** Drop the frames written and not yet delivered. */
    discardOutbound: () => {
      outbound.length = 0;
    },
  });
};
harden(makeInProcessHubSession);
