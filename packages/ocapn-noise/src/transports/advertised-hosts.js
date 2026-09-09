// @ts-check

/**
 * @file Shared host-advertisement policy for the byte-stream transports
 * that bind a real socket (`tcp`, `ws`).
 *
 * A listener advertises a **priority-ordered list** of dial hosts so a
 * peer can reach it over any of its link-layer addresses. The policy,
 * per the OCapN-Noise network design (`designs/ocapn-noise-network.md`
 * § Transport Hint Format):
 *
 * - **Prefer omitting a hint over advertising loopback.** A peer cannot
 *   dial your `127.0.0.1` / `::1`, so a wildcard bind that resolves to
 *   nothing routable advertises an **empty** list rather than loopback.
 * - **IPv6 before IPv4.** A global IPv6 address is unlikely to collide
 *   across networks and is relay-free on a partitioned LAN, so it sorts
 *   ahead of IPv4.
 * - **Multiple hints per protocol.** Every routable interface address
 *   becomes its own hint (multiple link-layer addresses on one
 *   transport).
 * - **Pluggable public-IP discovery.** A `discoverHosts` callback (e.g.
 *   a future STUN probe) folds its results into the list. This module
 *   ships only the seam; it implements no discovery itself.
 */

import os from 'node:os';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::ffff:0.0.0.0', '']);

/** @param {string} host */
export const isWildcardHost = host => WILDCARD_HOSTS.has(host);

/** @param {string} addr */
const isIpv6 = addr => addr.includes(':');

/** @param {string} addr */
const isLoopback = addr =>
  addr === '::1' ||
  addr === '::ffff:127.0.0.1' ||
  addr.startsWith('127.') ||
  addr.startsWith('::ffff:127.');

/**
 * Stable-sort a host list so every IPv6 literal precedes every IPv4
 * literal, preserving relative order within each family.
 *
 * @param {string[]} hosts
 * @returns {string[]}
 */
const ipv6First = hosts => [
  ...hosts.filter(isIpv6),
  ...hosts.filter(addr => !isIpv6(addr)),
];

/**
 * Enumerate the routable (non-internal) interface addresses of this
 * host, IPv6 first. Link-local IPv6 (`fe80::/10`) is skipped: it is
 * undialable without a zone/scope id the hint cannot carry.
 *
 * @returns {string[]}
 */
const enumerateRoutableHosts = () => {
  /** @type {string[]} */
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const infos of Object.values(ifaces)) {
    for (const info of infos ?? []) {
      const linkLocalIpv6 =
        isIpv6(info.address) && info.address.toLowerCase().startsWith('fe80');
      if (!info.internal && !linkLocalIpv6) {
        out.push(info.address);
      }
    }
  }
  return ipv6First(out);
};

/**
 * Bracket an IPv6 literal so the advertised `scheme://host:port` URL
 * round-trips back through `new URL()` on the connecting peer. IPv4
 * literals and hostnames pass through unchanged.
 *
 * @param {string} host
 * @returns {string}
 */
export const bracketHost = host => (isIpv6(host) ? `[${host}]` : host);

/**
 * Compute the priority-ordered list of hosts to advertise for a
 * listener.
 *
 * - `hosts` (explicit override) is advertised as given (IPv6-first),
 *   loopback included — a deliberate caller choice.
 * - Otherwise a **wildcard** bind enumerates routable interfaces and
 *   drops loopback (omitting rather than advertising `127.0.0.1`), and
 *   a **specific** bind advertises that single host as chosen (a
 *   deliberate loopback bind — e.g. a local test — is honored).
 * - `discoverHosts` results are folded in after the base set, with
 *   loopback dropped.
 *
 * @param {object} params
 * @param {string} params.bindHost - The host the listener was asked to bind.
 * @param {string} params.boundAddress - The address the OS reports it bound to.
 * @param {string[]} [params.hosts] - Explicit advertise-these override.
 * @param {() => (string[] | Promise<string[]>)} [params.discoverHosts]
 *   Pluggable public-IP discovery seam.
 * @returns {Promise<string[]>}
 */
export const computeAdvertisedHosts = async ({
  bindHost,
  boundAddress,
  hosts,
  discoverHosts,
}) => {
  await null;
  /** @type {string[]} */
  const result = [];
  const seen = new Set();
  /**
   * @param {string | undefined} host
   * @param {{ dropLoopback: boolean }} opts
   */
  const push = (host, { dropLoopback }) => {
    if (host === undefined || isWildcardHost(host)) return;
    if (dropLoopback && isLoopback(host)) return;
    if (seen.has(host)) return;
    seen.add(host);
    result.push(host);
  };

  if (hosts !== undefined) {
    for (const host of ipv6First([...hosts])) {
      push(host, { dropLoopback: false });
    }
  } else if (isWildcardHost(bindHost) || isWildcardHost(boundAddress)) {
    for (const host of enumerateRoutableHosts()) {
      push(host, { dropLoopback: true });
    }
  } else {
    push(boundAddress, { dropLoopback: false });
  }

  if (discoverHosts) {
    for (const host of ipv6First([...(await discoverHosts())])) {
      push(host, { dropLoopback: true });
    }
  }
  return result;
};
