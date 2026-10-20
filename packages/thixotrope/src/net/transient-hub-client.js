// @ts-check
/** @import { RandomPowers } from '../platform/random.js' */
import { E } from '@endo/far';
import harden from '@endo/harden';
import { encodeSwissnum, swissnumFromBytes } from '@endo/ocapn/client/util';

import { silentLogger } from '../platform/logging.js';
import { makeInProcessHubSession } from './in-process-session.js';

/**
 * A disposable host observer. Accepted guest calls remain durable, but its
 * pending answers and imported references end with this client. Session keys
 * must be unique and must never be reused, including across host restarts.
 * @param {RandomPowers} random
 * @param {{codec: any, hub: any, sessionKey: string}} options
 */
export const makeTransientHubClient = async (
  random,
  { codec, hub, sessionKey },
) => {
  let closed = false;
  let forgotten = false;
  /** @type {() => void} */
  let close;
  const hubSession = await makeInProcessHubSession({
    random,
    codec,
    hub,
    id: sessionKey,
    sessionKey,
    networkId: 'thixotrope-transient',
    logger: silentLogger,
    debugLabel: sessionKey,
    isClosed: () => closed,
    onEnd: () => {
      if (!closed) close();
    },
    onShutdown: () => {
      if (!closed) close();
    },
  });
  const { client, connection } = hubSession;
  close = () => {
    if (forgotten) return;
    const wasClosed = closed;
    closed = true;
    hubSession.discardOutbound();
    try {
      if (!wasClosed)
        hubSession
          .handlers()
          .handleConnectionClose(connection, Error('Transient client closed'));
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
    hubSession.resume();
    hubSession.attach({ durable: false, onAbort: close });
    const session = await client.provideSession(
      hubSession.resumption.peerLocation,
    );
    return harden({
      /**
       * @param {string | Uint8Array} secret
       * @returns {Promise<any>}
       */
      lookup: async secret => {
        if (closed) throw Error('Transient client closed');
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
harden(makeTransientHubClient);
