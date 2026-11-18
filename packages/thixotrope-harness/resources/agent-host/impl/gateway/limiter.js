// @ts-check
/**
 * The failed sign-in limiter and the client address it keys on (M3 W3.1;
 * m3-interfaces.md 4.3; R6-76, R7-49, W-8).
 *
 * - Per client address: a failed comparison pushes the address's next
 *   allowed attempt `penaltyMs` later, counted from max(now, its previous
 *   deadline); an attempt before that deadline is refused with
 *   `m3TextOf.rateLimited(ms)` without comparing; the entry is forgotten
 *   `forgetMs` after its deadline. A success clears only the caller's entry.
 * - Global ceiling: more than `perMinute` failures from all addresses in the
 *   last 60 s refuse every attempt with `m3Texts.signInCeiling` until the
 *   oldest ages out.
 *
 * Retained state is bounded by what fails, and a failure needs a comparison
 * the ceiling admitted: the failure window holds at most `perMinute + 1`
 * times, and the address map at most the addresses that failed in the last
 * `penaltyMs + forgetMs` plus a minute's ceiling (both swept on every call).
 *
 * Memory only: lost at a restart by contract (m3-interfaces.md 3.2).
 *
 * Node only (adapter).
 */
import { isIP } from 'node:net';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { m3TextOf, m3Texts } from '../../../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import { gatewayLimits } from './contract-m3.js';

const WINDOW_MS = 60_000;

/**
 * @typedef {{ ok: true } | { ok: false, text: string }} LimiterVerdict
 *
 * @typedef {object} SignInLimiter
 * @property {(address: string) => LimiterVerdict} check before comparing
 * @property {(address: string) => void} failed after a failed comparison
 * @property {(address: string) => void} succeeded after a good one
 * @property {() => { addresses: number, failures: number }} size for tests
 */

/**
 * @param {object} options
 * @param {() => number} options.now milliseconds (a fake clock in tests)
 * @param {number} [options.penaltyMs]
 * @param {number} [options.forgetMs]
 * @param {number} [options.perMinute] the global ceiling
 * @returns {SignInLimiter}
 */
export const makeSignInLimiter = ({
  now,
  penaltyMs = gatewayLimits.signInPenaltyMs,
  forgetMs = gatewayLimits.signInForgetMs,
  perMinute = gatewayLimits.signInFailuresPerMinute,
}) => {
  /** @type {Map<string, number>} address -> next allowed attempt */
  const deadlines = new Map();
  /** @type {number[]} failure times, oldest first */
  const failures = [];

  /** @param {number} t */
  const sweep = t => {
    while (failures.length > 0 && failures[0] <= t - WINDOW_MS) {
      failures.shift();
    }
    for (const [address, deadline] of deadlines) {
      if (deadline + forgetMs <= t) deadlines.delete(address);
    }
  };

  /** @param {string} address */
  const check = address => {
    const t = now();
    sweep(t);
    if (failures.length > perMinute) {
      return harden({ ok: false, text: m3Texts.signInCeiling });
    }
    const deadline = deadlines.get(address);
    if (deadline !== undefined && deadline > t) {
      return harden({ ok: false, text: m3TextOf.rateLimited(deadline - t) });
    }
    return harden({ ok: true });
  };

  /** @param {string} address */
  const failed = address => {
    const t = now();
    sweep(t);
    const previous = deadlines.get(address) ?? t;
    // Delete first so the map's order follows the latest failure.
    deadlines.delete(address);
    deadlines.set(address, Math.max(t, previous) + penaltyMs);
    failures.push(t);
    // The ceiling refuses before comparing, so this only trims a burst of
    // comparisons that were admitted together.
    while (failures.length > perMinute + 1) failures.shift();
  };

  /** @param {string} address */
  const succeeded = address => {
    deadlines.delete(address);
  };

  const size = () =>
    harden({ addresses: deadlines.size, failures: failures.length });

  return harden({ check, failed, succeeded, size });
};
harden(makeSignInLimiter);

/**
 * An address as text without the IPv4-mapped IPv6 prefix, the brackets of
 * an IPv6 literal or a port; `undefined` when it is not an IP address.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
const normalizeAddress = text => {
  let value = text.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return undefined;
    value = value.slice(1, end);
  } else if (isIP(value) === 0) {
    // `a.b.c.d:port`
    const colon = value.lastIndexOf(':');
    if (colon > 0 && value.indexOf(':') === colon) {
      value = value.slice(0, colon);
    }
  }
  const lower = value.toLowerCase();
  if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) {
    return lower.slice(7);
  }
  return isIP(lower) === 0 ? undefined : lower;
};

/**
 * The client address of a request (W-8): the socket peer, unless the peer is
 * a trusted proxy; then the right-most `X-Forwarded-For` entry that is not a
 * trusted proxy (the peer if every entry is one, or if that entry is not an
 * IP address: a proxy writing garbage gets one shared key, never one the
 * client chose). An untrusted peer's `X-Forwarded-For` is ignored.
 *
 * @param {object} options
 * @param {string | undefined} options.socketAddress
 * @param {string | string[]} [options.forwardedFor] the header (Node joins
 *   repeated headers with ", "; an array is accepted too)
 * @param {Iterable<string>} [options.trustedProxies]
 * @returns {string}
 */
export const clientAddress = ({
  socketAddress,
  forwardedFor,
  trustedProxies = [],
}) => {
  const peer =
    socketAddress === undefined
      ? 'unknown'
      : (normalizeAddress(socketAddress) ?? socketAddress);
  const trusted = new Set();
  for (const proxy of trustedProxies) {
    const address = normalizeAddress(proxy);
    if (address !== undefined) trusted.add(address);
  }
  if (!trusted.has(peer) || forwardedFor === undefined) return peer;
  const header = Array.isArray(forwardedFor)
    ? forwardedFor.join(',')
    : forwardedFor;
  // The header is bounded by the server's `maxHeaderBytes`.
  const entries = header.split(',');
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i].trim();
    if (entry !== '') {
      const address = normalizeAddress(entry);
      if (address === undefined) return peer;
      if (!trusted.has(address)) return address;
    }
  }
  return peer;
};
harden(clientAddress);
