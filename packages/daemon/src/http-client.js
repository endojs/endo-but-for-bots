// @ts-check
/* global fetch, AbortController */

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
 * Read a fetch Response body chunk-by-chunk, accumulating bytes
 * until either the stream ends or the cumulative byte count reaches
 * `maxBytes`.  When the cap is hit, the stream is aborted and the
 * accumulated prefix is returned.  This bounds the buffer the
 * client allocates per response, regardless of the Content-Length
 * header (which a malicious origin can lie about).
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortController} controller - The AbortController whose
 *   signal was passed to `fetch`; aborted when the cap is reached.
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
const readResponseBoundedText = async (response, maxBytes, controller) => {
  const body = response.body;
  if (body === null || body === undefined) {
    return { text: '', truncated: false };
  }
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  // Concatenate exactly `total` bytes (cheaper than `Buffer.concat`-style
  // pre-sizing miscalculations: each chunk's `byteLength` already added).
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // `fatal: false` so a truncation that lands mid-multibyte-codepoint
  // produces a replacement character rather than a thrown decode error.
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(out),
    truncated,
  };
};
harden(readResponseBoundedText);

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

      const protocol = new URL(url).protocol;
      protocol === 'https:' ||
        protocol === 'http:' ||
        Fail`Only HTTP and HTTPS protocols are supported, got ${q(protocol)}`;

      const origin = originOf(url);
      assertAllowedOrigin(origin);
      assertRateLimit();

      const { method = 'GET', headers = {}, body = undefined } = opts || {};

      const controller = new AbortController();
      // `redirect: 'manual'` prevents the server from steering the
      // client off the allowlist via a `Location:` header.  The
      // allowlist guards only the URL the caller supplied; with the
      // default `'follow'` mode an allowed origin could redirect to
      // 169.254.169.254 (cloud metadata), 127.0.0.1, or any RFC1918
      // address the daemon happens to be able to reach (SSRF).
      // 3xx responses are surfaced to the caller as-is so they can
      // re-issue against an explicitly allowlisted target if desired.
      const response = await fetchFn(url, {
        method,
        headers,
        signal: controller.signal,
        redirect: 'manual',
        ...(body !== undefined ? { body } : {}),
      });

      // Stream the response body with a hard byte cap.  This bounds the
      // memory the daemon will allocate for the response regardless of
      // a malicious origin advertising (or omitting) a Content-Length.
      // The AbortController signal is fired when the cap is reached so
      // the underlying socket is closed promptly.
      const { text, truncated } = await readResponseBoundedText(
        response,
        currentMaxResponseBytes,
        controller,
      );

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
        text,
        truncated,
        maxResponseBytes: currentMaxResponseBytes,
      });
    },

    allowedOrigins: () => harden([...allowedOrigins]),

    help: () =>
      `HttpClient makes HTTP requests to allowed origins. ` +
      `Methods: fetch(url, opts?), allowedOrigins(), help(). ` +
      `Allowed origins: ${[...allowedOrigins].join(', ') || '(none)'}. ` +
      `Limits: ${currentMaxRequestsPerMinute} req/min, ${currentMaxResponseBytes} max bytes.`,
  });

  const control = makeExo('HttpClientControl', HttpClientControlInterface, {
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
  });

  return harden({ client, control });
};
harden(makeHttpClientKit);
