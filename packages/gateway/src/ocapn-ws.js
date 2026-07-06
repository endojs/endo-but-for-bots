// @ts-check

/**
 * @file The gateway's OCapN-over-WebSocket endpoint (Feature 8 of
 * `designs/gateway-package.md`).
 *
 * The gateway terminates the public HTTP surface and, for a
 * WebSocket upgrade on the canonical OCapN path, hands the framed
 * connection to the embedded Noise-over-WebSocket OCapN transport.
 * The gateway is a **frame relay**: it never inspects, decrypts,
 * or interprets the OCapN payload (design § Capability Surface,
 * "`/ocapn-cbor-np`: frame-relay, no application-level exo exposed
 * by the gateway"). Confidentiality and peer authentication are
 * Noise's, in-band, per
 * [`ocapn-noise-network`](../../../designs/ocapn-noise-network.md).
 *
 * The canonical path is **`/ocapn-cbor-np`** (design § Feature 8):
 * `ocapn` (protocol) / `cbor` (codec) / `np` (Noise Protocol
 * network identifier). The bare **`/ocapn`** path is the
 * compatibility alias the superseded `endo-gateway` design used and
 * maps to the canonical path during the transition.
 *
 * This module is package-local and powers-injected: it takes the
 * OCapN connection sink (the netlayer's `listen` handler) as a
 * parameter rather than standing up a real `@endo/ocapn-noise`
 * network, so it is exercised in unit tests with a fake WebSocket
 * and a fake sink. Wiring the sink to the daemon's netlayer and the
 * `@apps` NameHub is the named seam deferred to the daemon
 * integration (see `index.js`).
 *
 * The WebSocket-to-byte-stream adapter mirrors
 * `@endo/ocapn-noise`'s `src/transports/ws-node.js`: one binary
 * WebSocket message becomes one `Uint8Array` chunk; non-binary
 * frames are a protocol error (the OCapN-Noise wire is exclusively
 * ciphertext blobs).
 */

import { makeQueue } from '@endo/stream';
import { makeError, q, X } from '@endo/errors';

/**
 * @import { AsyncQueue, Reader, Writer } from '@endo/stream'
 * @import {
 *   ByteStream,
 *   OcapnConnectionHandler,
 *   OcapnPathMatch,
 *   OcapnWebSocketEndpoint,
 *   WebSocketLike,
 * } from '../types.d.ts'
 */

/**
 * The canonical OCapN WebSocket path. `ocapn` is the protocol
 * family, `cbor` the payload codec, `np` the Noise Protocol network
 * identifier. Advertised to peers as the `path=` component of a
 * `wss:`/`ws:` connection hint.
 */
export const OCAPN_CANONICAL_PATH = '/ocapn-cbor-np';
harden(OCAPN_CANONICAL_PATH);

/**
 * The compatibility alias. The superseded `endo-gateway` design
 * used the bare `/ocapn`; it maps to {@link OCAPN_CANONICAL_PATH}
 * during the transition so existing locators keep resolving.
 */
export const OCAPN_COMPAT_PATH = '/ocapn';
harden(OCAPN_COMPAT_PATH);

/**
 * Classify a request path against the OCapN endpoint. Returns
 * `null` when the path is not an OCapN endpoint, otherwise the
 * resolved match. A query string or fragment (`/ocapn?x=1`) is
 * tolerated and stripped; anything else (a sub-path, a trailing
 * slash) does not match — the gateway is strict with server-side
 * input, matching the virtual-host name policy in `vhost.js`.
 *
 * @param {string} pathname
 * @returns {OcapnPathMatch | null}
 */
export const matchOcapnPath = pathname => {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return null;
  }
  // A raw HTTP upgrade `request.url` may carry a query or fragment;
  // route on the path portion only.
  const path = pathname.split(/[?#]/, 1)[0];
  if (path === OCAPN_CANONICAL_PATH) {
    return harden({
      canonicalPath: OCAPN_CANONICAL_PATH,
      requestedPath: path,
      viaAlias: false,
    });
  }
  if (path === OCAPN_COMPAT_PATH) {
    return harden({
      canonicalPath: OCAPN_CANONICAL_PATH,
      requestedPath: path,
      viaAlias: true,
    });
  }
  return null;
};
harden(matchOcapnPath);

/**
 * Adapt a `WebSocket`-shaped object (browser `WebSocket`, Node `ws`
 * instance) into an `@endo/stream` byte-stream. Each binary
 * WebSocket message becomes one `Uint8Array` chunk; the netlayer
 * supplies its own Noise framing. A non-binary frame is surfaced as
 * a protocol error rather than silently dropped, so a pending
 * `reader.next()` fails fast instead of hanging until close.
 *
 * Mirrors `@endo/ocapn-noise`'s `src/transports/ws-node.js`
 * adapter; kept package-local so the gateway consumes only its own
 * WebSocket capability and does not import the netlayer's transport
 * machinery (design § Package Shape, "consumes WebSocket capability
 * rather than implementing it").
 *
 * @param {WebSocketLike} ws
 * @returns {ByteStream}
 */
export const adaptWebSocket = ws => {
  if ('binaryType' in ws) {
    ws.binaryType = 'arraybuffer';
  }

  /** @type {AsyncQueue<IteratorResult<Uint8Array, undefined>>} */
  const incoming = makeQueue();
  let closed = false;

  ws.onmessage = ev => {
    if (closed) {
      return;
    }
    const { data } = ev;
    /** @type {Uint8Array} */
    let bytes;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (ArrayBuffer.isView(data)) {
      // A non-Uint8Array typed-array view (or DataView), e.g. a Node
      // `ws` frame delivered as a Buffer subclass in some modes.
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      // The OCapN-Noise wire is exclusively ciphertext blobs. A text
      // frame is a protocol violation; fail the stream rather than
      // leaving a pending `reader.next()` hanging.
      closed = true;
      const err = makeError(
        X`@endo/gateway OCapN endpoint: received non-binary WebSocket frame`,
      );
      incoming.put(harden(Promise.reject(err)));
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }
    incoming.put(harden({ done: false, value: bytes }));
  };

  ws.onclose = () => {
    closed = true;
    incoming.put(harden({ done: true, value: undefined }));
  };

  // Route a mid-session error into the queue so a pending
  // `reader.next()` rejects with the real error rather than
  // silently seeing `{ done: true }` from the subsequent close.
  ws.onerror = ev => {
    if (closed) {
      return;
    }
    closed = true;
    const cause =
      ev && typeof ev === 'object' && 'error' in ev ? ev.error : undefined;
    const err =
      cause instanceof Error
        ? cause
        : makeError(
            X`@endo/gateway OCapN endpoint: WebSocket connection errored`,
          );
    incoming.put(harden(Promise.reject(err)));
  };

  /** @type {Reader<Uint8Array>} */
  const reader = harden({
    next: () => incoming.get(),
    return: async () => {
      if (!closed) {
        ws.close();
      }
      return harden({ done: true, value: undefined });
    },
    /** @param {Error} err */
    throw: async err => {
      if (!closed) {
        ws.close();
      }
      throw err;
    },
    [Symbol.asyncIterator]() {
      return reader;
    },
  });

  /** @type {Writer<Uint8Array>} */
  const writer = harden({
    /** @param {Uint8Array} value */
    next: async value => {
      if (!closed) {
        ws.send(value);
      }
      return harden({ done: false, value: undefined });
    },
    return: async () => {
      if (!closed) {
        ws.close();
      }
      return harden({ done: true, value: undefined });
    },
    /** @param {Error} err */
    throw: async err => {
      if (!closed) {
        ws.close();
      }
      throw err;
    },
    [Symbol.asyncIterator]() {
      return writer;
    },
  });

  return harden({ reader, writer });
};
harden(adaptWebSocket);

/**
 * A connection sink that rejects every connection. Installed when
 * the OCapN feature is enabled but no netlayer sink is injected, so
 * a stray `/ocapn` upgrade fails loudly rather than being silently
 * accepted and dropped. The real sink — the daemon's netlayer plus
 * the `@apps` NameHub — is the named seam the daemon integration
 * fills.
 *
 * @type {OcapnConnectionHandler}
 */
const unwiredSink = () => {
  throw makeError(
    X`@endo/gateway OCapN endpoint: no connection sink is wired; inject powers.ocapn.onConnection (the daemon netlayer + @apps integration is the deferred seam)`,
  );
};

/**
 * Create the gateway's OCapN WebSocket endpoint. The returned
 * object is the seam a host's HTTP upgrade router uses: it decides
 * whether an upgrade path is the OCapN endpoint ({@link
 * OcapnWebSocketEndpoint.matchPath}) and, for a matched upgrade,
 * adapts the socket and hands the framed byte-stream to the
 * injected `onConnection` sink ({@link
 * OcapnWebSocketEndpoint.accept}).
 *
 * @param {object} args
 * @param {OcapnConnectionHandler} [args.onConnection] The netlayer
 *   sink: `(connection, meta) => void`, matching the OCapN-Noise
 *   transport `listen` handler contract. Defaults to a sink that
 *   throws on any connection.
 * @returns {OcapnWebSocketEndpoint}
 */
export const makeOcapnWebSocketEndpoint = ({
  onConnection = unwiredSink,
} = {}) => {
  if (typeof onConnection !== 'function') {
    throw makeError(
      X`OCapN connection sink must be a function, got ${q(onConnection)}`,
    );
  }

  return harden({
    canonicalPath: OCAPN_CANONICAL_PATH,
    aliasPath: OCAPN_COMPAT_PATH,
    paths: harden([OCAPN_CANONICAL_PATH, OCAPN_COMPAT_PATH]),

    /**
     * @param {string} pathname
     * @returns {OcapnPathMatch | null}
     */
    matchPath: pathname => matchOcapnPath(pathname),

    /**
     * Accept a matched WebSocket upgrade: adapt the socket to a
     * byte-stream and hand it to the injected sink. Throws when the
     * path is not an OCapN endpoint (defense in depth; the upgrade
     * router should have filtered non-matching paths already).
     *
     * @param {string} pathname
     * @param {WebSocketLike} ws
     * @returns {void}
     */
    accept: (pathname, ws) => {
      const match = matchOcapnPath(pathname);
      if (match === null) {
        throw makeError(
          X`Not an OCapN endpoint path: ${q(pathname)}; expected ${q(OCAPN_CANONICAL_PATH)} or ${q(OCAPN_COMPAT_PATH)}`,
        );
      }
      const connection = adaptWebSocket(ws);
      onConnection(
        connection,
        harden({
          requestedPath: match.requestedPath,
          canonicalPath: match.canonicalPath,
          viaAlias: match.viaAlias,
        }),
      );
    },
  });
};
harden(makeOcapnWebSocketEndpoint);
