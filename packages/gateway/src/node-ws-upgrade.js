// @ts-check

/**
 * @file Node-backed `wsUpgrade` adapter for the gateway's HTTP
 *   listener.
 *
 * The portable listener in `./http-listener.js` consumes a
 * `wsUpgrade` adapter shape; an embedder running under Node hands
 * this adapter in to perform the actual WebSocket handshake on the
 * raw `(request, socket, head)` triple. The adapter wraps the
 * `ws` package's `WebSocketServer({ noServer: true })` so the
 * gateway's own listener owns the HTTP server and the handshake
 * is the only thing `ws` does for it.
 *
 * Kept in a separate module (alongside `./node-crypto-powers.js`
 * and `./node-familiar-publish-powers.js`) so the portable core
 * never imports `ws`. Embedders running under a non-Node host
 * (Endor, a browser bundle) supply their own adapter that maps
 * to the host's WebSocket primitive.
 *
 * The byte-stream shape returned to the listener is
 * `Far`-tagged: each binary WebSocket frame becomes one
 * `Uint8Array` yielded by the reader; the writer's `next(bytes)`
 * sends one binary frame. Text frames are rejected (the OCapN
 * subprotocol uses binary). A closed socket terminates the
 * reader.
 */

/* global Buffer */

import { WebSocketServer } from 'ws';

import { makePipe } from '@endo/stream';
import { Far } from '@endo/far';
import { makeError, X } from '@endo/errors';

import { makeWsWriter } from './http-listener.js';

/** @import { WebSocket } from 'ws' */
/** @import { Reader, Writer } from '@endo/stream' */
/** @import { WsUpgradeAdapter, WsUpgradeContext } from './types.d.ts' */

/**
 * Construct a `wsUpgrade` adapter backed by the `ws` package. The
 * factory returns a function the listener calls per upgrade
 * event; the factory itself is called once at gateway start so
 * the single `WebSocketServer` instance is reused across
 * connections.
 *
 * The factory is total: it never throws. A handshake failure
 * during `handleUpgrade` resolves the per-upgrade promise with
 * `undefined`; the `ws` package itself destroys the socket in
 * that case.
 *
 * @returns {WsUpgradeAdapter}
 */
export const makeNodeWsUpgrade = () => {
  const wss = new WebSocketServer({ noServer: true });
  /**
   * @param {WsUpgradeContext} context
   */
  const upgrade = async context => {
    if (context === null || typeof context !== 'object') {
      throw makeError(X`makeNodeWsUpgrade: expected a WsUpgradeContext`);
    }
    const { request, socket, head } = context;
    /** @type {Promise<WebSocket | undefined>} */
    const handshake = new Promise(resolve => {
      try {
        wss.handleUpgrade(request, socket, head, ws => {
          resolve(ws);
        });
      } catch (e) {
        // `ws` rarely throws synchronously from `handleUpgrade`,
        // but be defensive: destroy the socket and resolve with
        // `undefined`. The listener treats `undefined` as
        // "adapter declined".
        try {
          socket.destroy();
        } catch (_e) {
          // ignore
        }
        console.error(
          `[Gateway] WebSocketServer.handleUpgrade threw: ${/** @type {Error} */ (e).message}`,
        );
        resolve(undefined);
      }
    });
    const ws = await handshake;
    if (ws === undefined) {
      return undefined;
    }
    return harden(streamPairFromWebSocket(ws));
  };
  return upgrade;
};
harden(makeNodeWsUpgrade);

/**
 * Build a `{ reader, writer }` byte-stream pair from a connected
 * `ws.WebSocket`. The reader yields one `Uint8Array` per binary
 * frame; text frames are rejected (the OCapN subprotocol uses
 * binary).
 *
 * Exported for reuse by an embedder that owns a `WebSocket`
 * instance through some non-listener path (a test harness, an
 * already-upgraded socket from a third-party WS server).
 *
 * @param {WebSocket} ws
 * @returns {{ reader: Reader<Uint8Array>, writer: Writer<Uint8Array> }}
 */
export const streamPairFromWebSocket = ws => {
  if (ws === null || typeof ws !== 'object') {
    throw makeError(X`streamPairFromWebSocket: expected a ws.WebSocket`);
  }
  const [pipeReader, pipeWriter] = makePipe();

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Text frames are not part of the OCapN subprotocol; close
      // the connection so the dialing peer notices a contract
      // violation rather than the bytes silently disappearing.
      ws.close(1003, 'binary frames only');
      pipeWriter.throw(makeError(X`OCapN WebSocket received non-binary frame`));
      return;
    }
    /** @type {Uint8Array} */
    let bytes;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (Array.isArray(data)) {
      // A fragmented frame; concat into one Uint8Array.
      const total = Buffer.concat(data);
      bytes = new Uint8Array(total.buffer, total.byteOffset, total.byteLength);
    } else {
      // `ws` documents Buffer | ArrayBuffer | Buffer[]; the
      // ArrayBuffer branch maps cleanly.
      const buf = Buffer.from(/** @type {ArrayBuffer} */ (data));
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    pipeWriter.next(bytes);
  });

  ws.on('close', () => {
    pipeWriter.return(undefined);
  });

  ws.on('error', err => {
    pipeWriter.throw(err);
  });

  // The portable listener exports `makeWsWriter`; we feed it a
  // `{ send, close }` sink built around the `ws` instance. The
  // `binary: true` flag on `send` keeps the wire shape uniform
  // with what the daemon's existing `ws-gateway.js` produces.
  const writer = makeWsWriter({
    send: bytes => {
      ws.send(bytes, { binary: true });
    },
    close: () => {
      ws.close();
    },
  });

  // The `Far`-tag on the reader matches the convention the
  // ocapn-ws.js handler uses for its replay reader and writer
  // wrappers; a plain harden'd reader would fail `@endo/marshal`'s
  // passable-style enforcement when the handler hands the stream
  // pair to the registered daemon.
  const reader = /** @type {Reader<Uint8Array>} */ (
    /** @type {unknown} */ (
      Far('GatewayWsReader', {
        next: async () => pipeReader.next(),
        return: async value => pipeReader.return(value),
        throw: async err => pipeReader.throw(err),
      })
    )
  );

  return { reader, writer };
};
harden(streamPairFromWebSocket);
