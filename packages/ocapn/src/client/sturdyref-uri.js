// @ts-check

/**
 * The `ocapn://…` URI codec for sturdyref locators.
 *
 * A sturdyref serializes two ways: the in-band Syrup wire form
 * (`OcapnSturdyRefCodec` in `../codecs/descriptors.js`) and this
 * out-of-band URI form for carriage a human can print, mail, or paste.
 * The URI is `ocapn://<designator>.<transport>[/s/<swiss>][?hint=…]`,
 * with the swiss-num path segment carried as base64url (RFC 4648 §5)
 * without padding — the encoding the OCapN Locators draft's URI
 * Serialization section specifies and the Spritely Goblins reference
 * implementation (`string->ocapn-id` in `goblins/ocapn/ids.scm`) reads.
 *
 * This codec previously lived in `@endo/goblin-chat`
 * (`parseLocator`/`formatLocator`); it is promoted here so any OCapN
 * consumer — and, in later cuts, the daemon's closely-held bridge —
 * shares one grammar. `@endo/goblin-chat` now delegates to these.
 *
 * The swiss-num is the unforgeable secret: the URI is a bearer
 * capability. Emission is a deliberate act at the trusted/host tier;
 * confining who may read or write a URI is the caller's concern, not
 * this pure codec's.
 *
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { SwissNum } from './types.js'
 */

import harden from '@endo/harden';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { swissnumFromBytes, swissnumToBytes } from './util.js';

/**
 * Encode bytes as base64url (RFC 4648 §5) without trailing padding.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const encodeBase64Url = bytes =>
  encodeBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

/**
 * Decode a base64url string (with or without padding) into bytes. The
 * caller validates the alphabet before calling; `decodeBase64` performs
 * the final alphabet check after the URL-alphabet substitutions.
 *
 * @param {string} value
 * @param {string} [name]
 * @returns {Uint8Array}
 */
const decodeBase64Url = (value, name) => {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return decodeBase64(padded, name);
};

/**
 * Decode a base64url-encoded (no-padding) URI path segment into a raw
 * `SwissNum`. The Spritely Goblins reference `string->ocapn-id`
 * (`goblins/ocapn/ids.scm`) treats the `/s/<value>` segment exactly this
 * way:
 *
 *   (base64-decode (substring path …)
 *                  #:alphabet base64-url-alphabet
 *                  #:padding? #f)
 *
 * The OCapN draft's Syrup serialization carries `swiss-num` as a
 * bytevector (and `OcapnSturdyRefCodec` uses `read/writeBytestring`), so
 * decoding to raw bytes is the only interoperable interpretation.
 *
 * Validation is strict: the alphabet check rejects characters the
 * underlying decoder would otherwise silently skip, which would let a
 * typo produce a wrong-but-plausible swiss-num that fails far from here.
 *
 * @param {string} value  Path segment as it appears after `/s/` (already
 *   percent-decoded by the caller).
 * @returns {SwissNum}
 */
const decodeBase64UrlSwissnum = value => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw Error(
      `Sturdyref swiss-num must be base64url (RFC 4648 §5) without padding: ${value}`,
    );
  }
  return swissnumFromBytes(decodeBase64Url(value, 'swiss-num'));
};

/**
 * @typedef {object} ParsedSturdyRefUri
 * @property {OcapnLocation} location
 *   The peer locator (designator + transport + hints).
 * @property {SwissNum | undefined} swissNum
 *   Present for sturdyref URIs (`/s/<swiss>`); `undefined` for a plain
 *   peer URI carrying no swiss-num.
 * @property {'peer' | 'sturdyref'} kind
 */

/**
 * Parse an OCapN locator URI of the form
 *   `ocapn://<designator>.<transport>[/s/<swiss>][?hint=value&…]`
 *
 * The swiss-num, when present, is base64url(no-padding) of the raw
 * swiss-num bytes per the OCapN Locators draft and the Spritely Goblins
 * reference implementation (`goblins/ocapn/ids.scm`); no other encoding
 * is accepted.
 *
 * The host portion encodes a `<designator>.<transport>` pair, with the
 * transport occupying the last dot-separated label. The standard `URL`
 * parser does the heavy lifting (scheme, percent-decoding, query
 * parameters); only that final split is special-cased.
 *
 * @param {string} uri
 * @returns {ParsedSturdyRefUri}
 */
export const parseSturdyRefUri = uri => {
  const trimmed = uri.trim();
  if (!URL.canParse(trimmed)) {
    throw Error(`Not a valid ocapn:// URI: ${uri}`);
  }
  const url = new URL(trimmed);
  if (url.protocol !== 'ocapn:') {
    throw Error(`Not a valid ocapn:// URI: ${uri}`);
  }
  // `URL` exposes the authority via `host` for hierarchical schemes like
  // `ocapn://`. An empty host means a malformed URI.
  const hostPart = url.host;
  if (!hostPart) {
    throw Error(`OCapN URI is missing a host: ${uri}`);
  }
  if (url.username || url.password || url.port) {
    throw Error(`OCapN URI must not carry userinfo or port: ${uri}`);
  }

  const lastDot = hostPart.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === hostPart.length - 1) {
    throw Error(
      `OCapN URI host must be of the form <designator>.<transport>: ${hostPart}`,
    );
  }
  const designator = hostPart.slice(0, lastDot);
  const transport = hostPart.slice(lastDot + 1);

  /** @type {Record<string, string>} */
  const hints = {};
  for (const [key, value] of url.searchParams) {
    hints[key] = value;
  }

  /** @type {'peer' | 'sturdyref'} */
  let kind = 'peer';
  /** @type {SwissNum | undefined} */
  let swissNum;
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.length > 0) {
    const sMatch = path.match(/^\/s\/(.+)$/u);
    if (!sMatch) {
      throw Error(`Unsupported OCapN URI path: ${url.pathname}`);
    }
    kind = 'sturdyref';
    swissNum = decodeBase64UrlSwissnum(decodeURIComponent(sMatch[1]));
  }

  /** @type {OcapnLocation} */
  const location = {
    type: 'ocapn-peer',
    designator,
    transport,
    hints: Object.keys(hints).length === 0 ? false : hints,
  };

  return {
    location,
    swissNum,
    kind,
  };
};
harden(parseSturdyRefUri);

/**
 * Render a hints map onto a URI query string. Keys are sorted for
 * byte-stable output — hint ordering is not meaningful on the wire, but
 * a stable URI is friendlier to log/snapshot diffs and to humans
 * comparing two URIs by eye.
 *
 * @param {OcapnLocation['hints']} hints
 * @returns {string}
 */
const formatHintsQuery = hints => {
  if (!hints || typeof hints !== 'object') return '';
  const keys = Object.keys(hints).sort();
  if (keys.length === 0) return '';
  const params = new URLSearchParams();
  for (const key of keys) {
    params.append(key, String(hints[key]));
  }
  return `?${params.toString()}`;
};

/**
 * Format an OCapN sturdyref (or plain peer) URI from a peer location and
 * an optional swiss-num. The swiss-num rides the `/s/<…>` path segment
 * as base64url(no-padding) of its raw bytes, symmetric with
 * {@link parseSturdyRefUri}; omit it to format a plain peer URI.
 *
 * @param {object} parts
 * @param {OcapnLocation} parts.location
 * @param {SwissNum | Uint8Array} [parts.swissNum]
 * @returns {string}
 */
export const formatSturdyRefUri = ({ location, swissNum }) => {
  const { designator, transport, hints } = location;
  const authority = `${designator}.${transport}`;
  const query = formatHintsQuery(hints);
  if (swissNum === undefined) {
    return `ocapn://${authority}${query}`;
  }
  const swissBytes =
    swissNum instanceof Uint8Array ? swissNum : swissnumToBytes(swissNum);
  const segment = encodeBase64Url(swissBytes);
  return `ocapn://${authority}/s/${segment}${query}`;
};
harden(formatSturdyRefUri);
