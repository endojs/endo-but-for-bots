// @ts-check
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { SocketConnection, SocketListener, SocketPowers } from '../platform/sockets.js' */
/** @import { SyncFilePowers } from '../platform/sync-files.js' */
import { Fail } from '@endo/errors';
import harden from '@endo/harden';
import { locationToLocationId } from '@endo/ocapn/client/util';
import { writeOcapnHandshakeMessage } from '@endo/ocapn/operations';

/** @import { Connection, NetlayerHandlers, Logger, NetLayer, SelfIdentity } from '@endo/ocapn/client/types' */

// Bound each physical fragment, not the already-admitted logical message.
const maxFrameLength = 1024 * 1024;
const continuationFlag = 0x8000_0000;
const networkId = 'thix-unix';

/**
 * Validate before importing a reference or recording session intent. The path
 * profile fits macOS and Linux sockaddr_un, including the terminal NUL byte.
 * Parent ownership protects durable-session bearer tokens from other users.
 * @param {object} powers
 * @param {SyncFilePowers} powers.syncFiles
 * @param {PathPowers} powers.paths
 * @param {any} location
 */
export const assertUnixPeerLocation = ({ syncFiles, paths }, location) => {
  (location !== null &&
    typeof location === 'object' &&
    location.type === 'ocapn-peer' &&
    (location.network ?? location.transport) === networkId &&
    (location.transport === undefined || location.transport === networkId) &&
    typeof location.designator === 'string' &&
    paths.isAbsolute(location.designator) &&
    !location.designator.includes('\0') &&
    new TextEncoder().encode(location.designator).length <= 103) ||
    Fail`Invalid Unix peer location`;
  const parent = paths.dirname(location.designator);
  (syncFiles.stat(parent).kind === 'directory' &&
    syncFiles.isPrivateToUser(parent)) ||
    Fail`Unix socket directory must be private and owned by this user`;
  return harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: networkId,
    transport: networkId,
    designator: location.designator,
    hints: {},
  });
};
harden(assertUnixPeerLocation);

/**
 * A same-user, private-directory Unix transport. Each fragment has a four-byte
 * unsigned big-endian header: the high bit means more fragments follow, and
 * the remaining bits are its payload length (at most one MiB). Logical messages
 * are reassembled before delivery; socket loss discards incomplete messages. The caller must hold
 * exclusive ownership of the directory throughout the server lifetime and
 * remove any stale socket only after acquiring that ownership. This function
 * never unlinks a preexisting path or asynchronously unlinks a successor.
 * After shutdown(), await closed before releasing directory ownership.
 *
 * @param {object} powers
 * @param {SocketPowers} powers.sockets
 * @param {SyncFilePowers} powers.syncFiles
 * @param {PathPowers} powers.paths
 * @param {object} options
 * @param {string} options.socketPath
 * @param {NetlayerHandlers} options.handlers
 * @param {Logger} options.logger
 */
export const makeUnixNetLayer = async (
  { sockets, syncFiles, paths },
  { socketPath, handlers, logger },
) => {
  assertUnixPeerLocation(
    { syncFiles, paths },
    {
      type: 'ocapn-peer',
      network: networkId,
      designator: socketPath,
    },
  );
  /** @type {Map<SocketConnection, () => void>} */
  const connections = new Map();
  let stopped = false;
  /** @type {SocketListener} */
  let listener;
  const location = harden({
    type: /** @type {const} */ ('ocapn-peer'),
    network: networkId,
    transport: networkId,
    designator: socketPath,
    hints: {},
  });

  /**
   * @param {SocketConnection} socket
   * @param {boolean} originator
   */
  const attach = (socket, originator) => {
    let open = true;
    const drop = () => {
      if (!open) return;
      open = false;
      void socket.writer.throw(Error('Unix connection dropped'));
    };
    connections.set(socket, drop);
    const connection = handlers.makeConnection(netlayer, originator, {
      write(bytes) {
        (!stopped && open) || Fail`Unix connection is closed`;
        bytes.length > 0 || Fail`Invalid Unix frame length`;
        for (let offset = 0; offset < bytes.length; offset += maxFrameLength) {
          const payload = bytes.subarray(offset, offset + maxFrameLength);
          const more = offset + payload.length < bytes.length;
          const frame = new Uint8Array(4 + payload.length);
          new DataView(frame.buffer).setUint32(
            0,
            payload.length + (more ? continuationFlag : 0),
          );
          frame.set(payload, 4);
          // Writes are paced by the host, not awaited here: the OCapN
          // connection's write is synchronous. A write the host could not
          // complete ends the connection.
          socket.writer.next(frame).catch(error => {
            if (!open) return;
            logger.error('Unix socket write failed', error);
            drop();
          });
        }
      },
      end: drop,
    });
    const header = new Uint8Array(4);
    let headerUsed = 0;
    let payload = new Uint8Array();
    let payloadUsed = 0;
    let more = false;
    /** @type {Uint8Array[]} */
    let fragments = [];
    let messageLength = 0;
    /** @param {Uint8Array} data */
    const feed = data => {
      let offset = 0;
      while (offset < data.length && open) {
        if (headerUsed < 4) {
          const count = Math.min(4 - headerUsed, data.length - offset);
          header.set(data.subarray(offset, offset + count), headerUsed);
          headerUsed += count;
          offset += count;
          if (headerUsed < 4) return;
          const encodedSize = new DataView(header.buffer).getUint32(0);
          more = encodedSize >= continuationFlag;
          const size = encodedSize % continuationFlag;
          (size > 0 && size <= maxFrameLength) ||
            Fail`Invalid Unix frame length`;
          payload = new Uint8Array(size);
        }
        const count = Math.min(
          payload.length - payloadUsed,
          data.length - offset,
        );
        payload.set(data.subarray(offset, offset + count), payloadUsed);
        payloadUsed += count;
        offset += count;
        if (payloadUsed === payload.length) {
          const complete = payload;
          headerUsed = 0;
          payloadUsed = 0;
          payload = new Uint8Array();
          if (more) {
            fragments.push(complete);
            messageLength += complete.length;
          } else if (fragments.length === 0) {
            handlers.handleMessageData(connection, complete);
          } else {
            const message = new Uint8Array(messageLength + complete.length);
            let messageOffset = 0;
            for (const fragment of fragments) {
              message.set(fragment, messageOffset);
              messageOffset += fragment.length;
            }
            message.set(complete, messageOffset);
            fragments = [];
            messageLength = 0;
            handlers.handleMessageData(connection, message);
          }
        }
      }
    };
    void (async () => {
      let failed = false;
      try {
        // A frame the peer sends after we drop the socket is not read: the
        // loop ends because the reader does.
        for await (const data of socket.reader) feed(data);
      } catch (error) {
        failed = true;
        logger.error('Unix socket failed', error);
      }
      if (failed) {
        drop();
      } else {
        // The peer ended its side, or we dropped ours: end ours in turn so
        // anything still buffered is flushed rather than discarded.
        open = false;
        void socket.writer.return(undefined).catch(() => {});
      }
      await socket.closed;
      connections.delete(socket);
      connection.end();
      handlers.handleConnectionClose(connection);
    })().catch(error => logger.error('Unix connection teardown failed', error));
    return connection;
  };

  /** @type {NetLayer & { closed: Promise<void>, networkId: string, sendSessionHandshake: (connection: Connection, version: string, identity: SelfIdentity, codec: any) => void }} */
  const netlayer = harden({
    networkId,
    get closed() {
      return listener.closed;
    },
    location,
    locationId: locationToLocationId(location),
    connect(remote) {
      !stopped || Fail`Unix netlayer is shut down`;
      assertUnixPeerLocation({ syncFiles, paths }, remote);
      // The durable layer owns logical session reuse. Sharing a physical
      // stream here would mix envelopes from distinct session tokens.
      return attach(sockets.connectPath(remote.designator), true);
    },
    shutdown() {
      if (stopped) return;
      stopped = true;
      // The listener power closes its listening handle (and unlinks its own
      // socket) here. Never perform a later unlink in the asynchronous close
      // callback.
      listener.close();
      for (const drop of connections.values()) drop();
    },
    sendSessionHandshake(connection, captpVersion, identity, codec) {
      const { keyPair, location: peerLocation, locationSignature } = identity;
      connection.write(
        writeOcapnHandshakeMessage(
          {
            type: 'op:start-session',
            captpVersion,
            sessionPublicKey: keyPair.publicKey.descriptor,
            location: peerLocation,
            locationSignature,
          },
          codec,
        ),
      );
    },
  });
  listener = await sockets.listenPath({
    path: socketPath,
    mode: 0o600,
    onConnection: connection => {
      if (stopped)
        void connection.writer.throw(Error('Unix netlayer is shut down'));
      else attach(connection, false);
    },
    onError: error => logger.error('Unix listener failed', error),
  });
  return netlayer;
};
harden(makeUnixNetLayer);
