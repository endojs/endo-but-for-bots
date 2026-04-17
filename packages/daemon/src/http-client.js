// @ts-check
/* global fetch */

import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { q, Fail } from '@endo/errors';

import {
  HttpClientInterface,
  HttpClientControlInterface,
} from './interfaces.js';

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Parse the origin from a URL string.
 *
 * @param {string} urlString
 * @returns {string} The origin (e.g., "https://api.github.com")
 */
const originOf = urlString => {
  const url = new URL(urlString);
  return url.origin;
};
harden(originOf);

/**
 * Create an HttpClient / HttpClientControl facet pair.
 *
 * The HttpClient lets an agent make HTTP requests to a host-controlled
 * allowlist of origins.  The HttpClientControl lets the host adjust
 * limits and revoke access.
 *
 * @param {object} options
 * @param {string[]} options.allowedOrigins - Initial origin allowlist.
 * @param {number} [options.maxRequestsPerMinute]
 * @param {number} [options.maxResponseBytes]
 * @param {typeof globalThis.fetch} [options.fetchFn] - Injected fetch for testing.
 * @returns {{ client: object, control: object }}
 */
export const makeHttpClientKit = options => {
  const {
    allowedOrigins: initialOrigins,
    maxRequestsPerMinute = DEFAULT_MAX_REQUESTS_PER_MINUTE,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchFn = fetch,
  } = options;

  let allowedOrigins = new Set(initialOrigins);
  let currentMaxRequestsPerMinute = maxRequestsPerMinute;
  let currentMaxResponseBytes = maxResponseBytes;
  let revoked = false;

  // Sliding window rate limiter: track timestamps of recent requests.
  /** @type {number[]} */
  const requestTimestamps = [];

  const assertNotRevoked = () => {
    if (revoked) {
      throw Fail`HttpClient has been revoked`;
    }
  };

  const assertAllowedOrigin = origin => {
    allowedOrigins.has(origin) ||
      Fail`Origin ${q(origin)} is not in the allowlist`;
  };

  const assertRateLimit = () => {
    const now = Date.now();
    const windowStart = now - 60_000;
    // Remove timestamps outside the window.
    while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
      requestTimestamps.shift();
    }
    requestTimestamps.length < currentMaxRequestsPerMinute ||
      Fail`Rate limit exceeded: ${q(currentMaxRequestsPerMinute)} requests per minute`;
    requestTimestamps.push(now);
  };

  const client = makeExo('HttpClient', HttpClientInterface, {
    /**
     * @param {string} url
     * @param {object} [opts]
     */
    fetch: async (url, opts = undefined) => {
      assertNotRevoked();

      const origin = originOf(url);
      assertAllowedOrigin(origin);
      assertRateLimit();

      const { method = 'GET', headers = {}, body = undefined } = opts || {};

      const protocol = new URL(url).protocol;
      protocol === 'https:' ||
        protocol === 'http:' ||
        Fail`Only HTTP and HTTPS protocols are supported, got ${q(protocol)}`;

      const response = await fetchFn(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });

      // Read response text, truncated to max size.
      const text = await response.text();
      const truncated =
        text.length > currentMaxResponseBytes
          ? text.slice(0, currentMaxResponseBytes)
          : text;

      /** @type {Record<string, string>} */
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return harden({
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: responseHeaders,
        text: truncated,
      });
    },

    allowedOrigins: () => harden([...allowedOrigins]),

    help: () =>
      `HttpClient makes HTTP requests to allowed origins. ` +
      `Methods: fetch(url, opts?), allowedOrigins(), help(). ` +
      `Allowed origins: ${[...allowedOrigins].join(', ') || '(none)'}. ` +
      `Limits: ${currentMaxRequestsPerMinute} req/min, ${currentMaxResponseBytes} max bytes.`,
  });

  const control = makeExo(
    'HttpClientControl',
    HttpClientControlInterface,
    {
      /** @param {string[]} origins */
      setAllowedOrigins: origins => {
        allowedOrigins = new Set(origins);
      },
      /** @param {number} n */
      setMaxRequestsPerMinute: n => {
        n >= 1 || Fail`maxRequestsPerMinute must be >= 1`;
        currentMaxRequestsPerMinute = n;
      },
      /** @param {number} n */
      setMaxResponseBytes: n => {
        n >= 1 || Fail`maxResponseBytes must be >= 1`;
        currentMaxResponseBytes = n;
      },
      revoke: () => {
        revoked = true;
      },
      help: () =>
        `HttpClientControl manages an HttpClient. ` +
        `Methods: setAllowedOrigins(origins), setMaxRequestsPerMinute(n), ` +
        `setMaxResponseBytes(n), revoke(), help().`,
    },
  );

  return harden({ client, control });
};
harden(makeHttpClientKit);
