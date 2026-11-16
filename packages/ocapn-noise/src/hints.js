// @ts-check

/**
 * Grammar for OCapN-Noise connection hints, per
 * `designs/ocapn-network-transport-separation.md` § Target Model.
 *
 * A hint is keyed by a `<transport>+<codec>` combination (for example
 * `tcp+cbor` or `wss+cbor`) and carries the single dial string a peer needs
 * to reach that combination.
 * In an external locator each hint is one `@`-delimited path component of the
 * form `<transport>+<codec>:<address>`.
 * The locator layer percent-encodes and decodes the whole component, so every
 * function here works on decoded strings.
 *
 * The address grammar depends on the transport:
 *
 * - `tcp` publishes a `host:port` authority, with IPv6 literals bracketed
 *   (`[::1]:3469`).
 * - `ws` and `wss` publish `host:port/path`, and the path is required.
 *
 * Hosts are returned unbracketed, ready for `net.createConnection`.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

/** @import {Authority, AuthorityPath, Hint, HintKey} from './types.js' */

const namePattern = /^[a-z][a-z0-9-]*$/;
const regNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ipv6Pattern = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*$/;
const portPattern = /^[1-9][0-9]{0,4}$/;
// A path begins with a slash and holds no query, fragment, whitespace, or
// control characters.
const pathPattern = /^\/[^?#\s\p{Cc}]*$/u;

/**
 * @param {string} kind
 * @param {unknown} name
 */
const assertName = (kind, name) => {
  if (typeof name !== 'string' || !namePattern.test(name)) {
    throw makeError(X`ocapn-noise hint: invalid ${q(kind)} name ${q(name)}`);
  }
};

/**
 * Compose the hint key for a transport-and-codec combination.
 *
 * @param {string} transport
 * @param {string} codec
 * @returns {string}
 */
export const makeHintKey = (transport, codec) => {
  assertName('transport', transport);
  assertName('codec', codec);
  return `${transport}+${codec}`;
};
harden(makeHintKey);

/**
 * Split a `<transport>+<codec>` hint key into its two names.
 *
 * @param {string} key
 * @returns {HintKey}
 */
export const parseHintKey = key => {
  if (typeof key !== 'string') {
    throw makeError(X`ocapn-noise hint: key must be a string, got ${q(key)}`);
  }
  const plus = key.indexOf('+');
  if (plus < 0) {
    throw makeError(
      X`ocapn-noise hint: key ${q(key)} must have the form <transport>+<codec>`,
    );
  }
  const transport = key.slice(0, plus);
  const codec = key.slice(plus + 1);
  assertName('transport', transport);
  assertName('codec', codec);
  return harden({ transport, codec });
};
harden(parseHintKey);

/**
 * Render a hint as a decoded locator component, `<transport>+<codec>:<address>`.
 *
 * @param {string} key
 * @param {string} address
 * @returns {string}
 */
export const formatHint = (key, address) => {
  parseHintKey(key);
  if (typeof address !== 'string' || address === '') {
    throw makeError(
      X`ocapn-noise hint: ${q(key)} address must be a non-empty string`,
    );
  }
  return `${key}:${address}`;
};
harden(formatHint);

/**
 * Parse a decoded locator component, `<transport>+<codec>:<address>`.
 * Only the key is validated here; the address's grammar belongs to the
 * transport (see `parseAuthority` and `parseAuthorityPath`).
 *
 * @param {string} component
 * @returns {Hint}
 */
export const parseHint = component => {
  if (typeof component !== 'string') {
    throw makeError(
      X`ocapn-noise hint: component must be a string, got ${q(component)}`,
    );
  }
  const colon = component.indexOf(':');
  if (colon < 0) {
    throw makeError(
      X`ocapn-noise hint: component ${q(component)} must have the form <transport>+<codec>:<address>`,
    );
  }
  const key = component.slice(0, colon);
  const address = component.slice(colon + 1);
  const { transport, codec } = parseHintKey(key);
  if (address === '') {
    throw makeError(X`ocapn-noise hint: ${q(key)} has an empty address`);
  }
  return harden({ key, transport, codec, address });
};
harden(parseHint);

/**
 * @param {unknown} host
 * @returns {string} the host as it appears in an authority
 */
const formatHost = host => {
  if (typeof host === 'string') {
    if (host.includes(':')) {
      if (ipv6Pattern.test(host)) return `[${host}]`;
    } else if (regNamePattern.test(host)) {
      return host;
    }
  }
  throw makeError(X`ocapn-noise hint: invalid host ${q(host)}`);
};

/**
 * @param {unknown} port
 */
const assertPort = port => {
  if (
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw makeError(X`ocapn-noise hint: invalid port ${q(port)}`);
  }
};

/**
 * @param {string} address
 * @param {string} authority
 * @returns {Authority}
 */
const parseAuthorityText = (address, authority) => {
  let host;
  let rest;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) {
      throw makeError(
        X`ocapn-noise hint: unterminated IPv6 literal in ${q(address)}`,
      );
    }
    host = authority.slice(1, close);
    if (!ipv6Pattern.test(host)) {
      throw makeError(
        X`ocapn-noise hint: invalid IPv6 literal in ${q(address)}`,
      );
    }
    rest = authority.slice(close + 1);
    if (!rest.startsWith(':')) {
      throw makeError(X`ocapn-noise hint: missing port in ${q(address)}`);
    }
    rest = rest.slice(1);
  } else {
    const colon = authority.indexOf(':');
    if (colon < 0) {
      throw makeError(X`ocapn-noise hint: missing port in ${q(address)}`);
    }
    host = authority.slice(0, colon);
    rest = authority.slice(colon + 1);
    if (!regNamePattern.test(host)) {
      throw makeError(
        X`ocapn-noise hint: invalid host in ${q(address)} (IPv6 literals must be bracketed)`,
      );
    }
  }
  if (!portPattern.test(rest) || Number(rest) > 65_535) {
    throw makeError(X`ocapn-noise hint: invalid port in ${q(address)}`);
  }
  return harden({ host, port: Number(rest) });
};

/**
 * Render a `host:port` authority, bracketing an IPv6 host.
 * This is the `tcp+cbor` hint address.
 *
 * @param {Authority} authority
 * @returns {string}
 */
export const formatAuthority = ({ host, port }) => {
  const hostText = formatHost(host);
  assertPort(port);
  return `${hostText}:${port}`;
};
harden(formatAuthority);

/**
 * Parse a `host:port` authority, such as a `tcp+cbor` hint address.
 * A bracketed IPv6 host is returned without its brackets.
 *
 * @param {string} address
 * @returns {Authority}
 */
export const parseAuthority = address => {
  if (typeof address !== 'string') {
    throw makeError(X`ocapn-noise hint: authority must be a string`);
  }
  return parseAuthorityText(address, address);
};
harden(parseAuthority);

/**
 * Render a `host:port/path` address, the `ws+cbor` and `wss+cbor` hint address.
 * The path is required and must begin with `/`.
 *
 * @param {AuthorityPath} authorityPath
 * @returns {string}
 */
export const formatAuthorityPath = ({ host, port, path }) => {
  if (typeof path !== 'string' || !pathPattern.test(path)) {
    throw makeError(X`ocapn-noise hint: invalid path ${q(path)}`);
  }
  return `${formatAuthority({ host, port })}${path}`;
};
harden(formatAuthorityPath);

/**
 * Parse a `host:port/path` address, such as a `wss+cbor` hint address.
 * The path is required; a bare authority is rejected.
 *
 * @param {string} address
 * @returns {AuthorityPath}
 */
export const parseAuthorityPath = address => {
  if (typeof address !== 'string') {
    throw makeError(X`ocapn-noise hint: address must be a string`);
  }
  // The authority ends at the first slash after any bracketed IPv6 literal.
  const searchFrom = address.startsWith('[') ? address.indexOf(']') + 1 : 0;
  if (searchFrom === 0 && address.startsWith('[')) {
    throw makeError(
      X`ocapn-noise hint: unterminated IPv6 literal in ${q(address)}`,
    );
  }
  const slash = address.indexOf('/', searchFrom);
  if (slash < 0) {
    throw makeError(X`ocapn-noise hint: missing path in ${q(address)}`);
  }
  const path = address.slice(slash);
  if (!pathPattern.test(path)) {
    throw makeError(X`ocapn-noise hint: invalid path in ${q(address)}`);
  }
  const { host, port } = parseAuthorityText(address, address.slice(0, slash));
  return harden({ host, port, path });
};
harden(parseAuthorityPath);
