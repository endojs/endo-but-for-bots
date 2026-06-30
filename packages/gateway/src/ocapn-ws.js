// @ts-check

/**
 * @file OCapN WebSocket subprotocol path scheme for the gateway.
 *
 * The gateway exposes a single canonical WebSocket path,
 * `/ocapn-cbor-np`, that carries OCapN over the **CBOR** codec and
 * the **Noise Protocol** network (`designs/gateway-package.md` §
 * Feature 8). The path name encodes the codec/network pair so that
 * future siblings (`/ocapn-syrups-tcp`, `/ocapn-cbor-tls`) can land
 * at distinct slots without colliding on the bare `/ocapn` name the
 * superseded `endo-gateway` design used. The bare `/ocapn` survives
 * as a compatibility alias for `/ocapn-cbor-np` during the
 * transition.
 *
 * This module is the phase-1 increment for Feature 8: the path
 * scheme itself (recognition, decomposition into the
 * protocol/codec/network triple, the legacy alias, and the OCapN
 * locator connection hint). It is pure logic and holds no socket;
 * the live WebSocket listener and the Noise frame relay land with
 * the rest of the network surface in later phases (the relay is
 * Feature 6, phase 4, which pumps frames in both directions without
 * inspecting them). Keeping the path scheme here lets the daemon and
 * the future `@endo/gateway-daemon` wrapper agree on the wire path
 * before either opens a socket, mirroring how `vhost.js` holds the
 * routing table and `config.js` holds the bind parsing ahead of the
 * listener.
 */

import { makeError, q, X } from '@endo/errors';

/** @import { OcapnWebSocketRoute } from '../types.d.ts' */

/**
 * The OCapN protocol family, the first segment of every
 * `/ocapn-*` path.
 */
export const OCAPN_PROTOCOL_FAMILY = 'ocapn';
harden(OCAPN_PROTOCOL_FAMILY);

/**
 * The codec carried by the canonical path: CBOR (peer of
 * `@endo/syrups`), per the design's Feature 8.
 */
export const OCAPN_WS_CODEC = 'cbor';
harden(OCAPN_WS_CODEC);

/**
 * The network identifier carried by the canonical path: `np`, the
 * Noise Protocol network identifier (`@endo/ocapn-noise` reports
 * `networkId: 'np'`), per the design's Feature 8.
 */
export const OCAPN_WS_NETWORK = 'np';
harden(OCAPN_WS_NETWORK);

/**
 * The canonical OCapN WebSocket path, `/ocapn-cbor-np`.
 */
export const OCAPN_WS_PATH = `/${OCAPN_PROTOCOL_FAMILY}-${OCAPN_WS_CODEC}-${OCAPN_WS_NETWORK}`;
harden(OCAPN_WS_PATH);

/**
 * The legacy `/ocapn` path the superseded `endo-gateway` design
 * served. It is accepted as a compatibility alias that maps to
 * {@link OCAPN_WS_PATH} during the transition.
 */
export const OCAPN_WS_LEGACY_ALIAS_PATH = `/${OCAPN_PROTOCOL_FAMILY}`;
harden(OCAPN_WS_LEGACY_ALIAS_PATH);

/**
 * The (codec, network) pairs the gateway serves today. Phase 1
 * serves only CBOR-over-Noise; sibling pairs (`syrups`/`tcp`,
 * `cbor`/`tls`) are reserved by the path scheme but not yet
 * implemented, so a request for one is recognized as an OCapN
 * endpoint but reported unsupported rather than mistaken for a
 * different resource.
 *
 * @type {ReadonlyArray<{ codec: string, network: string }>}
 */
export const OCAPN_WS_SUPPORTED = harden([
  { codec: OCAPN_WS_CODEC, network: OCAPN_WS_NETWORK },
]);

const isSupportedPair = (codec, network) =>
  OCAPN_WS_SUPPORTED.some(
    pair => pair.codec === codec && pair.network === network,
  );

/**
 * Reduce a raw request path to its bare pathname: drop any query
 * string or fragment a WebSocket upgrade URL may carry, and strip a
 * single trailing slash (so `/ocapn-cbor-np/` matches
 * `/ocapn-cbor-np`). A lone `/` is preserved; the empty string is
 * returned unchanged. Both fall through to a routing miss.
 *
 * @param {string} rawPath
 * @returns {string}
 */
const barePath = rawPath => {
  if (typeof rawPath !== 'string') {
    throw makeError(X`WebSocket path must be a string, got ${q(rawPath)}`);
  }
  let path = rawPath;
  const queryIndex = path.indexOf('?');
  if (queryIndex >= 0) {
    path = path.slice(0, queryIndex);
  }
  const hashIndex = path.indexOf('#');
  if (hashIndex >= 0) {
    path = path.slice(0, hashIndex);
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
};

/**
 * Recognize an OCapN WebSocket path and decompose it into its
 * protocol/codec/network triple. This is the router predicate the
 * future WebSocket-upgrade handler consults: it returns a route
 * descriptor for the canonical path and the legacy alias, and
 * `undefined` for any path that is not in the OCapN family at all
 * (so the caller answers 404).
 *
 * A path that *is* in the OCapN family but names a codec/network the
 * gateway does not yet serve (a reserved sibling like
 * `/ocapn-syrups-tcp`) returns a descriptor with
 * `isSupported === false`, so the caller can answer with a specific
 * "unsupported subprotocol" rather than a generic miss.
 *
 * @param {string} rawPath
 * @returns {OcapnWebSocketRoute | undefined}
 */
export const matchOcapnWebSocketPath = rawPath => {
  const path = barePath(rawPath);

  if (path === OCAPN_WS_LEGACY_ALIAS_PATH) {
    return harden({
      requestedPath: path,
      canonicalPath: OCAPN_WS_PATH,
      protocol: OCAPN_PROTOCOL_FAMILY,
      codec: OCAPN_WS_CODEC,
      network: OCAPN_WS_NETWORK,
      isAlias: true,
      isSupported: true,
    });
  }

  // The full form is `/ocapn-<codec>-<network>`: exactly three
  // hyphen-separated segments, the first of which is `ocapn`. Each
  // codec/network segment is a lowercase ASCII token (letters and
  // digits), matching `cbor`, `np`, `syrups`, `tcp`, `tls`.
  if (!path.startsWith('/')) {
    return undefined;
  }
  const segments = path.slice(1).split('-');
  if (segments.length !== 3 || segments[0] !== OCAPN_PROTOCOL_FAMILY) {
    return undefined;
  }
  const [, codec, network] = segments;
  if (!/^[a-z0-9]+$/.test(codec) || !/^[a-z0-9]+$/.test(network)) {
    return undefined;
  }

  return harden({
    requestedPath: path,
    canonicalPath: `/${OCAPN_PROTOCOL_FAMILY}-${codec}-${network}`,
    protocol: OCAPN_PROTOCOL_FAMILY,
    codec,
    network,
    isAlias: false,
    isSupported: isSupportedPair(codec, network),
  });
};
harden(matchOcapnWebSocketPath);

/**
 * Parse and require a *supported* OCapN WebSocket path, returning
 * its route descriptor. Throws when the path is not an OCapN
 * endpoint, or names a codec/network the gateway does not serve.
 * Use this where an unsupported or malformed path is a
 * configuration error worth failing loudly (validating an
 * advertised locator); use {@link matchOcapnWebSocketPath} on the
 * request-routing hot path, where a miss is a routine 404.
 *
 * @param {string} rawPath
 * @returns {OcapnWebSocketRoute}
 */
export const parseOcapnWebSocketPath = rawPath => {
  const route = matchOcapnWebSocketPath(rawPath);
  if (route === undefined) {
    throw makeError(
      X`Not an OCapN WebSocket path: ${q(rawPath)} (expected ${q(OCAPN_WS_PATH)} or the ${q(OCAPN_WS_LEGACY_ALIAS_PATH)} alias)`,
    );
  }
  if (!route.isSupported) {
    throw makeError(
      X`Unsupported OCapN codec/network ${q(`${route.codec}/${route.network}`)}; this gateway serves ${q(`${OCAPN_WS_CODEC}/${OCAPN_WS_NETWORK}`)}`,
    );
  }
  return route;
};
harden(parseOcapnWebSocketPath);

/**
 * Build the OCapN locator connection hint for reaching a
 * gateway-hosted endpoint, per the design's Feature 8:
 * `wss:host=<hostname>;path=/ocapn-cbor-np;np`. The `wss:` form is
 * for a gateway behind an HTTPS-terminating proxy; the `ws:` form is
 * for a plain deployment (Feature 9: OCapN confidentiality is
 * provided by Noise in-band, so TLS on this endpoint is
 * defense-in-depth only).
 *
 * @param {object} args
 * @param {string} args.host A hostname or IP literal.
 * @param {boolean} [args.secure] `true` for `wss:`, `false` (the
 *   default) for `ws:`.
 * @returns {string}
 */
export const ocapnWebSocketConnectionHint = ({ host, secure = false }) => {
  if (typeof host !== 'string' || host.length === 0) {
    throw makeError(
      X`Connection hint host must be a non-empty string, got ${q(host)}`,
    );
  }
  // The host is interpolated into a `;`-delimited locator string, so
  // a host carrying `;`, whitespace, or a control character could
  // inject spurious locator fields. Reject those rather than emit a
  // malformed hint. Hostnames, IPv4, and bracketed IPv6 literals
  // (`[::1]`) use only the characters this allows.
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    throw makeError(
      X`Connection hint host contains characters that would corrupt the locator: ${q(host)}`,
    );
  }
  const scheme = secure ? 'wss' : 'ws';
  return `${scheme}:host=${host};path=${OCAPN_WS_PATH};${OCAPN_WS_NETWORK}`;
};
harden(ocapnWebSocketConnectionHint);
