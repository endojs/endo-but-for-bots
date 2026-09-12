// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
import { E } from '@endo/far';
import harden from '@endo/harden';
import { makeOcapn } from '@endo/ocapn';
import { encodeSwissnum, swissnumFromBytes } from '@endo/ocapn/client/util';

import { derivePipeResumption } from './pipe-network.js';

/**
 * A disposable host observer. Accepted guest calls remain durable, but its
 * pending answers and imported references end with this client. Session keys
 * must be unique and must never be reused, including across host restarts.
 * @param {Pick<NodePowers, 'randomBytes'>} powers
 * @param {{codec: any, hub: any, sessionKey: string}} options
 */
export const makeEphemeralHubClient = async (
  powers,
  { codec, hub, sessionKey },
) => {
  const resumption = derivePipeResumption({
    codec,
    workerId: sessionKey,
    role: 'worker',
  });
  let closed = false;
  let forgotten = false;
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
      return closed;
    },
    /** @param {Uint8Array} bytes */
    write: bytes => {
      if (closed) return;
      if (sink === undefined) outbound.push(bytes);
      else sink.deliver(bytes);
    },
    end: () => {
      if (!closed) close();
    },
  });
  const client = await makeOcapn({
    randomBytes: length => powers.randomBytes(length),
    logger: harden({ log: () => {}, error: () => {}, info: () => {} }),
    codec,
    debugLabel: sessionKey,
    network: (/** @type {any} */ nextHandlers) => {
      handlers = nextHandlers;
      return harden({
        networkId: 'thixotrope-transient',
        codec,
        location: resumption.peerLocation,
        shutdown: () => {
          if (!closed) close();
        },
      });
    },
  });
  const close = () => {
    if (forgotten) return;
    const wasClosed = closed;
    closed = true;
    outbound.length = 0;
    try {
      if (!wasClosed)
        handlers.handleConnectionClose(
          connection,
          Error('Ephemeral client closed'),
        );
    } finally {
      try {
        hub.forgetSession(sessionKey);
        forgotten = true;
      } finally {
        client.shutdown();
      }
    }
  };
  try {
    handlers.resumeSession(connection, resumption);
    sink = hub.attachSession(sessionKey, {
      durable: false,
      send: (/** @type {Uint8Array} */ bytes) => {
        if (!closed) handlers.handleMessageData(connection, bytes);
      },
      onAbort: close,
    });
    for (const bytes of outbound.splice(0)) sink.deliver(bytes);
    const session = await client.provideSession(resumption.peerLocation);
    return harden({
      /**
       * @param {string | Uint8Array} secret
       * @returns {Promise<any>}
       */
      lookup: async secret => {
        if (closed) throw Error('Ephemeral client closed');
        const bytes =
          typeof secret === 'string'
            ? encodeSwissnum(secret)
            : swissnumFromBytes(secret);
        return E(session.getBootstrap()).fetch(bytes);
      },
      close,
    });
  } catch (error) {
    close();
    throw error;
  }
};
harden(makeEphemeralHubClient);
