// @ts-check
/* eslint-disable no-bitwise, no-continue */
// Bitwise operators (`<<`, `>>>`, `|`, `&`) are the natural way to
// pack IPv4 octets into a 32-bit word and to apply a CIDR mask. A
// `continue` statement in a `for` loop is the cleanest expression
// of "skip this iteration when the current entry is malformed".
// Both rules apply across the file; the file is small and dense
// in this idiom.

/**
 * @file `X-Forwarded-*` header parser for the gateway's
 *   HTTPS-terminating-proxy compat layer (design Feature 9).
 *
 * The gateway never terminates TLS itself. An external reverse
 * proxy (nginx, Caddy, Cloudflare, Traefik, AWS ALB, ...)
 * terminates TLS in front and reaches the gateway over plain HTTP.
 * The proxy rewrites a small set of request headers so the gateway
 * can recover what the original client request looked like:
 *
 *   `X-Forwarded-For`   the original client IP (and the IPs of any
 *                       intermediate proxies, comma-separated, left
 *                       to right in original order).
 *   `X-Forwarded-Proto` the original scheme (`https` or `http`).
 *   `X-Forwarded-Host`  the original `Host` header (for virtual-
 *                       host routing the embedder may then perform
 *                       on the recovered host name).
 *
 * The **trust model** is the load-bearing part. A client can
 * fabricate any header it likes, so a naive gateway that always
 * believed `X-Forwarded-For` would let any caller masquerade as
 * any other IP. The gateway therefore trusts these headers only
 * when the immediate TCP peer (the `peerAddress` field on the
 * request) is inside the configured trusted-proxy CIDR allowlist.
 * Requests from outside the allowlist are treated as direct client
 * requests: the headers are ignored, the TCP peer is the caller,
 * and the `Host` header is taken at face value.
 *
 * This module exports two surfaces:
 *
 *   `matchTrustedProxy(peer, cidrs)`: predicate the request path
 *     uses to decide whether to honor the X-Forwarded headers.
 *
 *   `parseForwardedRequest({ headers, peerAddress, trustedCidrs,
 *     maxHops })`: the per-request parser that returns the
 *     recovered `{ callerIp, scheme, host, trusted }` shape.
 *
 * The parser is pure; it consults no clock, no random, no I/O. It
 * is exported so embedders that own their HTTP listener can call
 * it directly to feed downstream handlers (the Git smart-HTTP
 * handler, the OCapN-WS upgrade) the recovered request shape.
 *
 * See `designs/gateway-package.md` § Feature 9 for the deployment
 * shape; this module implements the parser + trust gate, plus
 * exports the warning string the gateway emits at startup when a
 * non-loopback bind is configured with no trusted-proxy list.
 */

import { makeError, q, X } from '@endo/errors';

/** @import { BindAddress } from './types.d.ts' */

/**
 * Header names the parser reads. Lowercased to match HTTP/2 and
 * the way embedders typically present the headers array.
 */
export const X_FORWARDED_FOR_HEADER = 'x-forwarded-for';
harden(X_FORWARDED_FOR_HEADER);

export const X_FORWARDED_PROTO_HEADER = 'x-forwarded-proto';
harden(X_FORWARDED_PROTO_HEADER);

export const X_FORWARDED_HOST_HEADER = 'x-forwarded-host';
harden(X_FORWARDED_HOST_HEADER);

/**
 * The startup-warning text the gateway emits when it is bound to a
 * non-loopback address with no trusted-proxy configuration. The
 * exact wording is fixed by the design (`designs/gateway-package.md`
 * § Feature 9) so an operator who grep-searches the docs finds the
 * same string the gateway prints.
 */
export const NO_TRUSTED_PROXY_WARNING_PREAMBLE = '[Gateway]';
harden(NO_TRUSTED_PROXY_WARNING_PREAMBLE);

/**
 * Render the design-pinned startup warning the gateway emits when a
 * non-loopback bind is configured without a trusted-proxy CIDR list.
 *
 * @param {string} renderedBindAddress The `host:port` (or
 *   `[ipv6]:port`) form already rendered by the gateway's
 *   `renderBindAddress`.
 * @returns {string}
 */
export const renderNoTrustedProxyWarning = renderedBindAddress => {
  if (typeof renderedBindAddress !== 'string') {
    throw makeError(
      X`renderNoTrustedProxyWarning expects a string, got ${q(typeof renderedBindAddress)}`,
    );
  }
  return `${NO_TRUSTED_PROXY_WARNING_PREAMBLE} Bound to ${renderedBindAddress} with no trusted proxy configured.\nBrowser-facing endpoints transmit bearer tokens; ensure TLS termination if this gateway is reachable from the internet.`;
};
harden(renderNoTrustedProxyWarning);

/**
 * Loopback predicate. An IPv4 address in `127.0.0.0/8` or the IPv6
 * `::1` literal counts as loopback; everything else (including the
 * unspecified addresses `0.0.0.0` and `::`, which mean "bind every
 * interface") does not. The startup warning fires when the bind is
 * not loopback and no trust list is configured.
 *
 * @param {BindAddress} bind
 * @returns {boolean}
 */
export const isLoopbackBindAddress = bind => {
  if (bind === null || typeof bind !== 'object') return false;
  const { host, kind } = bind;
  if (typeof host !== 'string') return false;
  if (kind === 'ipv4') {
    return host.startsWith('127.');
  }
  if (kind === 'ipv6') {
    // `::1` is the canonical IPv6 loopback. Other representations
    // (`0:0:0:0:0:0:0:1`) are not the canonical form
    // `parseBindAddress` returns, so we recognize only the
    // canonical literal here. An operator who hand-writes the long
    // form is in a corner case where the warning firing is the
    // safer outcome than silently treating an unfamiliar literal
    // as loopback.
    return host === '::1';
  }
  if (kind === 'hostname') {
    return host === 'localhost';
  }
  return false;
};
harden(isLoopbackBindAddress);

/**
 * Parse a dotted-quad IPv4 literal into its four octets. Returns
 * `undefined` on malformed input.
 *
 * @param {string} ip
 * @returns {ReadonlyArray<number> | undefined}
 */
const parseIpv4 = ip => {
  if (typeof ip !== 'string') return undefined;
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  /** @type {number[]} */
  const octets = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return undefined;
    // Reject leading zeros on multi-digit components; `010` is
    // ambiguous between octal and decimal across implementations.
    if (part.length > 1 && part.startsWith('0')) return undefined;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    octets.push(n);
  }
  return harden(octets);
};

/**
 * Pack four IPv4 octets into a single 32-bit unsigned integer (in
 * network byte order). Used for CIDR matching via mask arithmetic.
 *
 * @param {ReadonlyArray<number>} octets
 * @returns {number}
 */
const ipv4ToUint32 = octets => {
  // `>>> 0` coerces the result to an unsigned 32-bit integer so
  // negative results from sign-extension do not leak into the
  // comparison.
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
};

/**
 * Parse an IPv6 literal into its eight 16-bit groups, expanding a
 * single `::` shorthand into the appropriate number of zero groups.
 * Returns `undefined` on malformed input.
 *
 * Embedded IPv4 (`::ffff:1.2.3.4`) is recognized: the trailing
 * dotted-quad is folded into the last two groups.
 *
 * @param {string} ip
 * @returns {ReadonlyArray<number> | undefined}
 */
const parseIpv6 = ip => {
  if (typeof ip !== 'string' || ip.length === 0) return undefined;
  // The `%zone` suffix on link-local addresses is a host-side
  // annotation; strip it before parsing.
  const percent = ip.indexOf('%');
  const bare = percent >= 0 ? ip.slice(0, percent) : ip;

  // Split on `::` (at most once). `0` means no `::`, `1` means
  // one occurrence.
  const doubleColon = bare.indexOf('::');
  if (doubleColon >= 0) {
    // Reject multiple `::`.
    if (bare.indexOf('::', doubleColon + 1) >= 0) return undefined;
  }

  /**
   * Parse a colon-separated list of 16-bit hex groups, possibly
   * ending in an embedded IPv4 dotted-quad.
   *
   * @param {string} segment
   * @returns {number[] | undefined}
   */
  const parseGroups = segment => {
    if (segment.length === 0) return [];
    const parts = segment.split(':');
    /** @type {number[]} */
    const groups = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (i === parts.length - 1 && part.includes('.')) {
        // Embedded IPv4 in the trailing position.
        const v4 = parseIpv4(part);
        if (v4 === undefined) return undefined;
        groups.push((v4[0] << 8) | v4[1]);
        groups.push((v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  /** @type {number[]} */
  let groups;
  if (doubleColon < 0) {
    const all = parseGroups(bare);
    if (all === undefined) return undefined;
    if (all.length !== 8) return undefined;
    groups = all;
  } else {
    const head = parseGroups(bare.slice(0, doubleColon));
    const tail = parseGroups(bare.slice(doubleColon + 2));
    if (head === undefined || tail === undefined) return undefined;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return undefined;
    groups = head.concat(Array.from({ length: fill }, () => 0)).concat(tail);
    if (groups.length !== 8) return undefined;
  }
  return harden(groups);
};

/**
 * Parse a CIDR specifier like `10.0.0.0/8`, `192.168.1.1`,
 * `2001:db8::/32`, or `::1`. A bare IP is treated as a `/32` (v4)
 * or `/128` (v6) host range. Returns `undefined` on malformed
 * input.
 *
 * @param {string} cidr
 * @returns {{
 *   kind: 'ipv4',
 *   network: number,
 *   prefix: number,
 * } | {
 *   kind: 'ipv6',
 *   network: ReadonlyArray<number>,
 *   prefix: number,
 * } | undefined}
 */
export const parseCidr = cidr => {
  if (typeof cidr !== 'string' || cidr.length === 0) return undefined;
  const slash = cidr.indexOf('/');
  const ipPart = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const prefixPart = slash >= 0 ? cidr.slice(slash + 1) : undefined;

  // IPv4 takes precedence when the IP part has no colon. The two
  // address families are mutually exclusive at the syntactic level.
  if (!ipPart.includes(':')) {
    const octets = parseIpv4(ipPart);
    if (octets === undefined) return undefined;
    let prefix = 32;
    if (prefixPart !== undefined) {
      if (!/^[0-9]+$/.test(prefixPart)) return undefined;
      prefix = Number(prefixPart);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return undefined;
      }
    }
    const address = ipv4ToUint32(octets);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return harden({
      kind: /** @type {'ipv4'} */ ('ipv4'),
      network: (address & mask) >>> 0,
      prefix,
    });
  }

  const groups = parseIpv6(ipPart);
  if (groups === undefined) return undefined;
  let prefix = 128;
  if (prefixPart !== undefined) {
    if (!/^[0-9]+$/.test(prefixPart)) return undefined;
    prefix = Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
      return undefined;
    }
  }
  // Mask the network out group by group. Each group is 16 bits.
  /** @type {number[]} */
  const masked = [];
  for (let i = 0; i < 8; i += 1) {
    const remainingBits = prefix - i * 16;
    let groupMask;
    if (remainingBits >= 16) groupMask = 0xffff;
    else if (remainingBits <= 0) groupMask = 0;
    else groupMask = (0xffff << (16 - remainingBits)) & 0xffff;
    masked.push(groups[i] & groupMask);
  }
  return harden({
    kind: /** @type {'ipv6'} */ ('ipv6'),
    network: harden(masked),
    prefix,
  });
};
harden(parseCidr);

/**
 * Test whether a peer IP (literal IPv4 or IPv6 string) falls inside
 * any of the supplied CIDR ranges. The caller's `peer` argument is
 * the IP literal extracted from the TCP socket; `cidrs` is the
 * gateway's configured `trustedProxyCidrs` array. Malformed CIDR
 * entries are skipped silently (a malformed entry is treated as a
 * miss; the gateway logs at startup but never crashes mid-request).
 *
 * The function is total and fail-closed: an unparseable peer
 * address returns `false`; an empty `cidrs` array returns `false`.
 *
 * @param {string} peer
 * @param {ReadonlyArray<string>} cidrs
 * @returns {boolean}
 */
export const matchTrustedProxy = (peer, cidrs) => {
  if (typeof peer !== 'string' || peer.length === 0) return false;
  if (!Array.isArray(cidrs) || cidrs.length === 0) return false;
  // Strip a bracketed IPv6 (`[::1]`) shape; embedders sometimes
  // pass the bracketed form through verbatim.
  let bare = peer;
  if (bare.startsWith('[') && bare.endsWith(']')) {
    bare = bare.slice(1, -1);
  }
  // Strip an `%zone` suffix from a link-local literal.
  const pct = bare.indexOf('%');
  if (pct >= 0) bare = bare.slice(0, pct);

  /** @type {number | undefined} */
  let peerV4;
  /** @type {ReadonlyArray<number> | undefined} */
  let peerV6;
  if (bare.includes(':')) {
    const groups = parseIpv6(bare);
    if (groups === undefined) return false;
    peerV6 = groups;
  } else {
    const octets = parseIpv4(bare);
    if (octets === undefined) return false;
    peerV4 = ipv4ToUint32(octets);
  }

  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed === undefined) continue;
    if (parsed.kind === 'ipv4' && peerV4 !== undefined) {
      const mask =
        parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
      if ((peerV4 & mask) >>> 0 === parsed.network) return true;
    } else if (parsed.kind === 'ipv6' && peerV6 !== undefined) {
      let matched = true;
      for (let i = 0; i < 8; i += 1) {
        const remainingBits = parsed.prefix - i * 16;
        let groupMask;
        if (remainingBits >= 16) groupMask = 0xffff;
        else if (remainingBits <= 0) groupMask = 0;
        else groupMask = (0xffff << (16 - remainingBits)) & 0xffff;
        if ((peerV6[i] & groupMask) !== parsed.network[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return false;
};
harden(matchTrustedProxy);

/**
 * Header lookup helper. The headers array shape mirrors what the
 * `GitHttpHandler` already accepts; we keep it for consistency so
 * an embedder feeds the same header pairs to either handler. Names
 * are compared case-insensitively per RFC 7230.
 *
 * @param {ReadonlyArray<readonly [string, string]>} headers
 * @param {string} name
 * @returns {string | undefined}
 */
const findHeader = (headers, name) => {
  if (!Array.isArray(headers)) return undefined;
  const target = name.toLowerCase();
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [k, v] = pair;
    if (typeof k === 'string' && typeof v === 'string') {
      if (k.toLowerCase() === target) return v;
    }
  }
  return undefined;
};

/**
 * The recovered request shape returned by {@link parseForwardedRequest}.
 *
 * @typedef {object} ForwardedRequest
 * @property {string} callerIp The original client IP. When the
 *   peer is trusted and `X-Forwarded-For` is present, the leftmost
 *   eligible hop (under the configured `maxHops` budget). Otherwise
 *   the TCP peer's IP.
 * @property {'http' | 'https'} scheme The original request scheme.
 *   When the peer is trusted and `X-Forwarded-Proto` is present and
 *   recognizable, that value; otherwise `http` (the gateway never
 *   terminates TLS itself, so the default is `http`).
 * @property {string | undefined} host The original `Host` header.
 *   When the peer is trusted and `X-Forwarded-Host` is present,
 *   that value; otherwise the `Host` header from the request, or
 *   `undefined` if neither is set.
 * @property {boolean} trusted `true` iff the TCP peer was inside
 *   the configured trusted-proxy CIDR list and the `X-Forwarded-*`
 *   headers were honored; `false` for direct client requests.
 */

/**
 * Parse an HTTP request's `X-Forwarded-*` headers under the
 * trusted-proxy gate.
 *
 * Inputs:
 *
 *   `headers`: the request header pairs (lowercase or otherwise;
 *     matched case-insensitively).
 *   `peerAddress`: the TCP peer's IP literal as the embedder's
 *     listener observed it. The bracketed-IPv6 (`[::1]`) shape is
 *     tolerated.
 *   `trustedCidrs`: the gateway's `trustedProxyCidrs` config. An
 *     empty array means no proxy is trusted; X-Forwarded headers
 *     are ignored.
 *   `maxHops`: the maximum number of `X-Forwarded-For` hops to
 *     trust, counting from the right (the most recent hop). An
 *     `X-Forwarded-For` list of `client, proxy1, proxy2` with the
 *     gateway one hop in and `maxHops: 1` returns `proxy2` (the
 *     immediate-upstream peer's view of "who sent to me"). With
 *     `maxHops: 3` or more, the leftmost (`client`) is returned.
 *     When `X-Forwarded-For` is shorter than `maxHops`, the
 *     leftmost is returned.
 *
 * Output: a `ForwardedRequest` shape.
 *
 * The function is pure and fail-closed: any malformed input
 * (non-string peer, non-array headers, missing fields) collapses
 * to "treat as direct client" and returns the TCP-peer shape.
 *
 * @param {object} args
 * @param {ReadonlyArray<readonly [string, string]>} args.headers
 * @param {string} args.peerAddress
 * @param {ReadonlyArray<string>} args.trustedCidrs
 * @param {number} args.maxHops
 * @returns {ForwardedRequest}
 */
export const parseForwardedRequest = ({
  headers,
  peerAddress,
  trustedCidrs,
  maxHops,
}) => {
  // Normalize the peer for the returned `callerIp`. The trust
  // predicate strips brackets itself, so it does not matter for
  // `matchTrustedProxy`, but the returned `callerIp` should be the
  // bare literal so callers do not have to do bracket-stripping.
  let normalizedPeer = typeof peerAddress === 'string' ? peerAddress : '';
  if (normalizedPeer.startsWith('[') && normalizedPeer.endsWith(']')) {
    normalizedPeer = normalizedPeer.slice(1, -1);
  }
  const pct = normalizedPeer.indexOf('%');
  if (pct >= 0) normalizedPeer = normalizedPeer.slice(0, pct);

  const hostHeader = findHeader(headers, 'host');

  const trusted = matchTrustedProxy(peerAddress, trustedCidrs);
  if (!trusted) {
    return harden({
      callerIp: normalizedPeer,
      scheme: /** @type {'http'} */ ('http'),
      host: hostHeader,
      trusted: false,
    });
  }

  // Trusted: honor the X-Forwarded headers under the maxHops
  // budget. A non-integer or non-positive `maxHops` collapses to
  // 1 (the safe minimum: trust only the immediate hop).
  const effectiveMaxHops =
    typeof maxHops === 'number' && Number.isInteger(maxHops) && maxHops >= 1
      ? maxHops
      : 1;

  const xff = findHeader(headers, X_FORWARDED_FOR_HEADER);
  /** @type {string} */
  let callerIp = normalizedPeer;
  if (typeof xff === 'string' && xff.length > 0) {
    // `X-Forwarded-For` is a comma-separated list, leftmost is the
    // original client. With a budget of N hops, we walk N entries
    // back from the right (the most recent hop) and take the
    // leftmost of those. When the list is shorter than the budget,
    // the leftmost entry of the whole list is the result.
    const hops = xff
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (hops.length > 0) {
      const budget = Math.min(effectiveMaxHops, hops.length);
      callerIp = hops[hops.length - budget];
    }
  }

  /** @type {'http' | 'https'} */
  let scheme = 'http';
  const xfp = findHeader(headers, X_FORWARDED_PROTO_HEADER);
  if (typeof xfp === 'string') {
    // The header may list multiple values (proxy chains); the
    // leftmost is the original. Lowercase so `HTTPS` matches.
    const first = xfp.split(',')[0].trim().toLowerCase();
    if (first === 'https' || first === 'http') {
      scheme = /** @type {'http' | 'https'} */ (first);
    }
  }

  /** @type {string | undefined} */
  let host = hostHeader;
  const xfh = findHeader(headers, X_FORWARDED_HOST_HEADER);
  if (typeof xfh === 'string' && xfh.length > 0) {
    // The header may list multiple values; the leftmost is the
    // original.
    const first = xfh.split(',')[0].trim();
    if (first.length > 0) host = first;
  }

  return harden({
    callerIp,
    scheme,
    host,
    trusted: true,
  });
};
harden(parseForwardedRequest);
