// @ts-check

/**
 * @file `OcapnWebSocketHandler` for the gateway's `/ocapn-cbor-np`
 *   WebSocket termination (design Feature 8).
 *
 * The gateway exposes a single canonical WebSocket path,
 * `/ocapn-cbor-np`, that runs OCapN over CBOR (codec) and Noise
 * Protocol (network). This module implements the *semantic* core of
 * Feature 8: given an upgraded WebSocket connection (modeled as a
 * `Reader<Uint8Array>` / `Writer<Uint8Array>` pair, per the
 * `@endo/ocapn-noise` transport convention), the handler reads the
 * first frame, extracts the 32-byte intended-responder Ed25519
 * public key from the prefixed-SYN's cleartext prefix, looks up the
 * registration that owns that key, and hands the byte stream off to
 * the registered daemon (or relay target) for the rest of the
 * session.
 *
 * The gateway does **not** terminate Noise: Noise's encryption and
 * peer-authentication run end-to-end between the dialing peer and
 * the registered daemon. The gateway is a frame-level proxy that
 * peeks at one cleartext byte range (the intended-responder prefix,
 * per `@endo/ocapn-noise` § Session Establishment) and otherwise
 * pumps ciphertext blobs without inspecting them.
 *
 * This module does **not** open an HTTP listener or perform the WS
 * upgrade handshake itself; that platform-bound concern (Node's
 * `http.createServer` + `WebSocketServer.handleUpgrade`) follows in
 * a separate PR alongside the Feature 4 sock listener. Until then,
 * embedders that already own an HTTP server (the daemon's
 * `ws-gateway.js`, a future `@endo/gateway-daemon` wrapper, a test
 * that pumps frames in-realm) hold the handler directly via
 * `makeGateway(...).getOcapnHandler()` and feed it the per-
 * connection byte-stream pair.
 *
 * The exo uses `makeExo` + `M.interface` per `project/CLAUDE.md` §
 * Exo and Interface Authoring, so CapTP introspection
 * (`__getMethodNames__`) works out of the box.
 *
 * Identifiers carried across the registered-daemon callback
 * (`reader`, `writer`) are streams of `Uint8Array`s. The gateway
 * forwards the prefixed-SYN frame verbatim (prefix included), so the
 * downstream Noise responder sees exactly the same bytes the dialing
 * peer sent.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E, Far } from '@endo/far';
import { makeError, q, X } from '@endo/errors';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';

/** @import { Reader, Writer } from '@endo/stream' */

/**
 * The canonical OCapN WebSocket path. Encodes the codec/transport
 * pair: `ocapn` (protocol family), `cbor` (payload codec, peer of
 * `@endo/syrups`), `np` (Noise Protocol network identifier). Future
 * siblings can land at `/ocapn-syrups-tcp`, `/ocapn-cbor-tls`, etc.,
 * without colliding on the bare `/ocapn` slot.
 *
 * Embedders that own the HTTP server compare the upgrade request's
 * `url` against this constant (or `OCAPN_WEBSOCKET_LEGACY_PATH` for
 * the transition-period compatibility alias).
 */
export const OCAPN_WEBSOCKET_PATH = '/ocapn-cbor-np';
harden(OCAPN_WEBSOCKET_PATH);

/**
 * Transition-period compatibility alias for {@link OCAPN_WEBSOCKET_PATH}.
 * The superseded `endo-gateway` design used the bare `/ocapn` path;
 * embedders that migrate from that design accept both paths during
 * the transition and emit a deprecation warning on the bare form.
 *
 * The gateway's handler treats both paths identically; the
 * compatibility-alias decision is the embedder's. We export the
 * legacy constant so the embedder does not have to hard-code it.
 */
export const OCAPN_WEBSOCKET_LEGACY_PATH = '/ocapn';
harden(OCAPN_WEBSOCKET_LEGACY_PATH);

/**
 * Test whether an upgrade-request URL path (the value before the
 * `?query`, after the host portion) names the OCapN WebSocket
 * endpoint. Recognizes both the canonical
 * {@link OCAPN_WEBSOCKET_PATH} and the transition-period legacy
 * alias {@link OCAPN_WEBSOCKET_LEGACY_PATH}. Embedders that own the
 * HTTP server compare their upgrade request's `url` against this
 * helper rather than hard-coding the strings.
 *
 * The comparison is exact on the path (the embedder strips the
 * query string before calling). A future variant may extend this to
 * accept `/ocapn-cbor-np/<session-id>` or similar; the helper hides
 * that policy decision behind a single boolean.
 *
 * @param {string} path
 * @returns {boolean}
 */
export const isOcapnWebSocketPath = path => {
  if (typeof path !== 'string') return false;
  return path === OCAPN_WEBSOCKET_PATH || path === OCAPN_WEBSOCKET_LEGACY_PATH;
};
harden(isOcapnWebSocketPath);

/**
 * Length in bytes of the intended-responder Ed25519 verifying key
 * carried as the cleartext prefix of the first WebSocket frame on an
 * OCapN-Noise session. Matches `@endo/ocapn-noise`'s
 * `INTENDED_RESPONDER_KEY_LENGTH`. We keep our own constant rather
 * than importing it from `@endo/ocapn-noise` so this module does
 * not pull the Noise WASM into the gateway's dependency graph: a
 * test that exercises the routing semantics in-realm has no need
 * for the cryptographic primitives, and the constant is fixed by
 * the OCapN-Noise specification.
 */
export const OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH = 32;
harden(OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH);

/**
 * Lower bound on the first frame's length. The OCapN-Noise spec
 * defines the prefixed-SYN as the 32-byte intended-responder prefix
 * followed by the 132-byte Noise IK message 1, for a total of 164
 * bytes. We check `>= 164` rather than `=== 164` because a future
 * Noise variant or pre-handshake extension could carry additional
 * bytes; rejecting the frame outright would foreclose that
 * extensibility for no security benefit (the responder's own Noise
 * decoder is the authoritative validator). The lower bound exists
 * only to catch a truncated or non-OCapN frame early.
 */
const OCAPN_PREFIXED_SYN_MIN_LENGTH = 32 + 132;

const OcapnWebSocketHandlerInterface = M.interface('OcapnWebSocketHandler', {
  handleConnection: M.call(M.any()).returns(M.promise()),
});
harden(OcapnWebSocketHandlerInterface);

/**
 * @typedef {object} OcapnByteStream The per-connection byte-stream
 *   pair the embedder hands to `handleConnection`. Mirrors
 *   `@endo/ocapn-noise/src/types.d.ts` `ByteStream`: a reader of
 *   incoming WebSocket binary frames as `Uint8Array` chunks and a
 *   writer the gateway uses to send outbound frames back to the
 *   dialing peer.
 *
 *   Each binary WebSocket frame becomes one `Uint8Array` chunk
 *   (per the design's *Framing* paragraph: one Noise message per
 *   WebSocket binary frame). The gateway does not concatenate or
 *   split frames; the embedder's WS adapter preserves message
 *   boundaries.
 * @property {Reader<Uint8Array>} reader
 * @property {Writer<Uint8Array>} writer
 */

/**
 * @typedef {object} OcapnSessionTarget The shape the gateway hands
 *   off to the registered daemon (or relay target) after looking up
 *   the registration by intended-responder public key. The two
 *   stream halves are independent: the `reader` yields incoming
 *   frames from the dialing peer (with the first frame replayed,
 *   prefix included), and the `writer` accepts outgoing frames to
 *   send back. The gateway does not inspect either side after the
 *   handoff.
 * @property {Reader<Uint8Array>} reader
 * @property {Writer<Uint8Array>} writer
 */

/**
 * @typedef {object} OcapnSessionHandler The remote-exo contract the
 *   gateway calls into. The registered daemon (or relay target)
 *   implements `handleOcapnSession`; the gateway forwards the
 *   per-connection stream pair and the registered daemon runs its
 *   own Noise responder over those bytes.
 *
 *   The method returns once the daemon has accepted ownership of
 *   the stream pair; the daemon's own background task pumps bytes
 *   thereafter. The gateway does not await the session's completion
 *   (that would require holding the eventual-send promise open for
 *   the lifetime of the WS connection, which is open-ended).
 * @property {(target: OcapnSessionTarget) => Promise<void>} handleOcapnSession
 */

/**
 * @typedef {object} RegistrationLookupResult The shape
 *   `lookupRegistrationByPublicKey` returns when a live registration
 *   claims the queried public key. Either `daemon` or `relayTarget`
 *   may be set (a registration is created via `register` with a
 *   `daemon` field, or `registerRelay` with a `relayTarget` field).
 *   Both are typed as `unknown` here because the gateway treats
 *   them as opaque exo handles: the only call site is
 *   `E(target).handleOcapnSession({ reader, writer })`.
 * @property {unknown} [daemon]
 * @property {unknown} [relayTarget]
 */

/**
 * @typedef {object} OcapnWebSocketDeps Inputs to
 *   {@link makeOcapnWebSocketHandler}.
 * @property {(publicKey: ArrayBuffer | Uint8Array) =>
 *   RegistrationLookupResult | undefined} lookupRegistrationByPublicKey
 *   The bootstrap module's lookup function (the third return value
 *   of `makeGatewayBootstrap`). Returns `undefined` when no live
 *   registration claims the key, in which case the handler closes
 *   the WebSocket without forwarding.
 */

/**
 * @typedef {object} OcapnWebSocketHandler CapTP-facing exo. The
 *   single method is `async` so it crosses the wire as an eventual
 *   send.
 * @property {(stream: OcapnByteStream) => Promise<void>} handleConnection
 *   Accept an upgraded WebSocket connection as a `{ reader, writer }`
 *   pair, route to the registered daemon by the intended-responder
 *   prefix on the first frame, or close the connection on
 *   protocol-level failure (missing first frame, frame too short,
 *   no registration claims the public key, registered exo throws).
 *
 *   Resolves once the dispatching step completes (registration
 *   lookup + handoff to the daemon's `handleOcapnSession`); does not
 *   wait for the WS session itself to drain.
 */

/**
 * Render a public-key view as lowercase hex; matches `bootstrap.js`'s
 * `publicKeyToHex` so the diagnostic phrasing is consistent across
 * modules.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
const publicKeyToHex = bytes => {
  const view = bytes instanceof Uint8Array ? bytes : bytesFromImmutable(bytes);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
};

/**
 * Best-effort `writer.return()` followed by `reader.return()`; swallow
 * any rejection because the peer or the WS adapter may have already
 * torn down the stream. Used in the failure paths below where the
 * gateway gives up on the connection.
 *
 * @param {OcapnByteStream} stream
 */
const closeStream = stream => {
  try {
    Promise.resolve(stream.writer.return(undefined)).catch(() => {});
  } catch (_e) {
    // ignore
  }
  try {
    Promise.resolve(stream.reader.return(undefined)).catch(() => {});
  } catch (_e) {
    // ignore
  }
};

/**
 * Build a `Reader<Uint8Array>` that yields `firstFrame` exactly once
 * and then delegates every subsequent operation to `tail`. The
 * embedder's downstream Noise responder needs to see the unmodified
 * prefixed-SYN as its first read; we cannot peek into `tail` without
 * consuming, so we wrap.
 *
 * The returned reader is `Far`-tagged so it crosses the CapTP
 * boundary into the registered daemon's `handleOcapnSession` exo
 * call without tripping passable-style enforcement; a plain
 * harden'd reader would fail `@endo/marshal`'s "remotables must be
 * explicitly declared" check.
 *
 * @param {Uint8Array} firstFrame
 * @param {Reader<Uint8Array>} tail
 * @returns {Reader<Uint8Array>}
 */
const prependFrame = (firstFrame, tail) => {
  let replayed = false;
  return /** @type {Reader<Uint8Array>} */ (
    /** @type {unknown} */ (
      Far('OcapnReplayReader', {
        next: async () => {
          if (!replayed) {
            replayed = true;
            return harden({ done: false, value: firstFrame });
          }
          return tail.next();
        },
        return: async value => {
          replayed = true;
          return tail.return(value);
        },
        throw: async err => {
          replayed = true;
          return tail.throw(err);
        },
      })
    )
  );
};

/**
 * Create the `OcapnWebSocketHandler` exo. The factory is total: it
 * returns the exo unconditionally and the caller (the gateway proper,
 * `index.js`) decides whether to expose it based on the
 * `ocapnWebSocket` feature toggle.
 *
 * @param {OcapnWebSocketDeps} deps
 * @returns {OcapnWebSocketHandler}
 */
export const makeOcapnWebSocketHandler = ({
  lookupRegistrationByPublicKey,
}) => {
  if (typeof lookupRegistrationByPublicKey !== 'function') {
    throw makeError(
      X`makeOcapnWebSocketHandler requires a lookupRegistrationByPublicKey function`,
    );
  }

  const exo = makeExo(
    'OcapnWebSocketHandler',
    OcapnWebSocketHandlerInterface,
    /** @type {any} */ ({
      /** @param {OcapnByteStream} stream */
      async handleConnection(stream) {
        if (stream === null || typeof stream !== 'object') {
          throw makeError(X`handleConnection expects a { reader, writer }`);
        }
        const { reader, writer } = stream;
        if (
          reader === null ||
          typeof reader !== 'object' ||
          typeof reader.next !== 'function'
        ) {
          throw makeError(X`handleConnection: stream.reader is not a Reader`);
        }
        if (
          writer === null ||
          typeof writer !== 'object' ||
          typeof writer.next !== 'function'
        ) {
          throw makeError(X`handleConnection: stream.writer is not a Writer`);
        }

        // Pull the first frame: the prefixed SYN. Any failure here
        // (peer closed before sending, transport error) means there
        // is no session to forward; close and return rather than
        // throwing into the embedder's upgrade handler.
        /** @type {IteratorResult<Uint8Array, undefined>} */
        let first;
        try {
          first = await reader.next();
        } catch (_e) {
          closeStream(stream);
          return;
        }
        if (first.done || first.value === undefined) {
          // Peer hung up before sending the SYN.
          closeStream(stream);
          return;
        }

        const firstFrame = first.value;
        if (!(firstFrame instanceof Uint8Array)) {
          closeStream(stream);
          throw makeError(
            X`OCapN WS first frame must be a Uint8Array, got ${q(typeof firstFrame)}`,
          );
        }
        if (firstFrame.length < OCAPN_PREFIXED_SYN_MIN_LENGTH) {
          // The dialing peer did not speak OCapN-Noise. Drop the
          // connection. We avoid letting a short-frame DOS escalate
          // into a busy registration lookup.
          closeStream(stream);
          return;
        }

        // The intended-responder Ed25519 verifying key is the first
        // 32 bytes of the prefixed SYN. Copy into a fresh Uint8Array
        // so a later mutation of `firstFrame` (e.g. by the WS adapter
        // recycling its buffer) cannot retroactively change the
        // lookup key.
        const intendedResponder = new Uint8Array(
          OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH,
        );
        intendedResponder.set(
          firstFrame.subarray(0, OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH),
        );

        const registration = lookupRegistrationByPublicKey(intendedResponder);
        if (registration === undefined) {
          // No daemon claims this identity. Closing without a more
          // specific signal matches the OCapN-Noise behavior on an
          // unknown responder (the peer's Noise handshake would
          // fail the same way against a wrong responder).
          // Diagnostic log uses console.error per `project/CLAUDE.md`
          // § Diagnostic discipline; the hex render is the same
          // shape the admin counter uses.
          console.error(
            `[Gateway] no registration for intended responder ${publicKeyToHex(intendedResponder)}`,
          );
          closeStream(stream);
          return;
        }

        const target = registration.daemon ?? registration.relayTarget;
        if (target === undefined) {
          // A registration without either a daemon or a relay
          // target is malformed; the bootstrap should never create
          // one. We log and close defensively.
          console.error(
            `[Gateway] registration for ${publicKeyToHex(intendedResponder)} has neither daemon nor relayTarget`,
          );
          closeStream(stream);
          return;
        }

        // Replay the first frame to the downstream Noise responder
        // so it sees the unmodified prefixed-SYN as its first read.
        //
        // This `prependFrame` wrap is a temporary workaround for the
        // read-then-replay constraint: the gateway must consume the
        // SYN to learn which daemon to route to, but the downstream
        // Noise responder in `packages/ocapn-noise/src/network.js`
        // `handleIncoming` does its own `readFrame(stream.reader)` to
        // read the SYN, so we have to put the bytes back. The bindings
        // layer (`packages/ocapn-noise/src/bindings.js` exposes
        // `responderReadSynWriteSynack(prefixedSyn, synack)`) already
        // accepts a pre-read SYN; only the network-layer session-init
        // entry point needs a parallel shape that takes an optional
        // pre-read SYN and skips the initial frame read. The daemon-side
        // `handleOcapnSession` exo would then accept the same shape and
        // forward it. Once that lands, this wrapper and the `prependFrame`
        // helper above can be removed in favor of a plain stream pass-
        // through plus a `prefixedSyn` parameter on the exo call below.
        //
        // Tracked: https://github.com/endojs/endo-but-for-bots/issues/406
        const replayReader = prependFrame(firstFrame, reader);
        // Wrap the writer as Far so it crosses the CapTP boundary
        // cleanly (see prependFrame's note on passable enforcement).
        // The embedder's WS-adapter writer is typically a plain
        // harden'd record; the wrap is a no-op when the embedder
        // already supplied a Far-tagged writer.
        const farWriter = /** @type {Writer<Uint8Array>} */ (
          /** @type {unknown} */ (
            Far('OcapnWsWriter', {
              next: async value => writer.next(value),
              return: async value => writer.return(value),
              throw: async err => writer.throw(err),
            })
          )
        );

        // Hand off. The registered daemon owns the stream pair from
        // this point; the gateway does not pump bytes itself and does
        // not await the session's completion. If the daemon rejects
        // synchronously (interface mismatch, lockdown failure), we
        // log and close: returning the error to the embedder would
        // typically surface as a 500-class WS close which is less
        // informative than a logged registration-side fault.
        try {
          await E(
            /** @type {OcapnSessionHandler} */ (target),
          ).handleOcapnSession(
            harden({ reader: replayReader, writer: farWriter }),
          );
        } catch (e) {
          console.error(
            `[Gateway] handleOcapnSession for ${publicKeyToHex(intendedResponder)} threw:`,
            /** @type {Error} */ (e).message,
          );
          closeStream(stream);
        }
      },
    }),
  );

  return /** @type {OcapnWebSocketHandler} */ (/** @type {unknown} */ (exo));
};
harden(makeOcapnWebSocketHandler);
