// @ts-check
/* global crypto */

import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { q, Fail } from '@endo/errors';

import {
  WebhookEndpointInterface,
  WebhookControlInterface,
} from './interfaces.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_RATE_LIMIT = 60; // requests per minute

const textEncoder = new TextEncoder();

/**
 * Generate a random hex secret for HMAC verification.
 *
 * @returns {string}
 */
const generateSecret = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
};
harden(generateSecret);

/**
 * Decode a lowercase hex string to bytes.
 * Returns undefined if the input is not even-length lowercase hex.
 *
 * @param {string} hex
 * @returns {Uint8Array | undefined}
 */
const hexToBytes = hex => {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return undefined;
    out[i] = byte;
  }
  return out;
};
harden(hexToBytes);

/**
 * Constant-time comparison of two equal-length byte arrays.
 * Always inspects every position; never short-circuits on first mismatch.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
};
harden(timingSafeEqual);

/**
 * Create a WebhookEndpoint / WebhookControl facet pair.
 *
 * @param {object} options
 * @param {string} options.webhookId - Unique identifier for the webhook URL path.
 * @param {string} options.gatewayBaseUrl - Base URL of the gateway (e.g., "https://my-daemon.example.com").
 * @param {number} [options.maxPayloadBytes]
 * @param {number} [options.rateLimit] - Max requests per minute.
 * @param {(payload: string, headers: Record<string, string>) => void} [options.onPayload] - Callback when a payload is received.
 * @returns {{ endpoint: object, control: object, handleRequest: (body: string, headers: Record<string, string>) => Promise<{ status: number, body: string }> }}
 */
export const makeWebhookKit = options => {
  const {
    webhookId,
    gatewayBaseUrl,
    maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
    rateLimit = DEFAULT_RATE_LIMIT,
    onPayload = undefined,
  } = options;

  let currentMaxPayloadBytes = maxPayloadBytes;
  let currentRateLimit = rateLimit;
  let enabled = true;
  let revoked = false;
  const webhookSecret = generateSecret();
  const secretBytes = /** @type {Uint8Array} */ (hexToBytes(webhookSecret));

  // HMAC-SHA256 key material derived from the hex secret.  The promise is
  // memoized so concurrent verify() calls share one import.
  /** @type {Promise<CryptoKey> | undefined} */
  let hmacKeyPromise;
  const getHmacKey = () => {
    if (hmacKeyPromise === undefined) {
      hmacKeyPromise = crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    }
    return hmacKeyPromise;
  };

  /**
   * Verify a hex-encoded HMAC-SHA256 signature for the given body.
   * Uses constant-time comparison so verify() leaks no information
   * about which byte first diverged between the expected and received
   * signatures.
   *
   * @param {string} body - The exact bytes-as-string the sender signed.
   * @param {string} signatureHex - Hex-encoded HMAC the sender computed
   *   using this webhook's secret.
   * @returns {Promise<boolean>}
   */
  const verifySignature = async (body, signatureHex) => {
    const provided = hexToBytes(signatureHex);
    if (provided === undefined) return false;
    const key = await getHmacKey();
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, textEncoder.encode(body)),
    );
    return timingSafeEqual(expected, provided);
  };

  // Sliding window rate limiter
  /** @type {number[]} */
  const requestTimestamps = [];

  const webhookUrl = `${gatewayBaseUrl}/webhooks/${webhookId}`;

  const assertNotRevoked = () => {
    if (revoked) {
      throw Fail`Webhook has been revoked`;
    }
  };

  /**
   * Handle an incoming webhook request.
   *
   * If the request carries an `x-webhook-signature` header, the HMAC is
   * verified in constant time before the payload is delivered.  Requests
   * without the header are delivered unconditionally; callers that want
   * to require a signature should reject unsigned payloads inside
   * `onPayload` (or use `endpoint.verify(body, signatureHex)` directly).
   *
   * @param {string} body - Request body.
   * @param {Record<string, string>} headers - Request headers.
   * @returns {Promise<{ status: number, body: string }>}
   */
  const handleRequest = async (body, headers) => {
    if (revoked) {
      return { status: 410, body: 'Gone' };
    }
    if (!enabled) {
      return { status: 503, body: 'Webhook disabled' };
    }

    // Rate limit check
    const now = Date.now();
    const windowStart = now - 60_000;
    while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length >= currentRateLimit) {
      return { status: 429, body: 'Rate limit exceeded' };
    }
    requestTimestamps.push(now);

    // Payload size check
    if (body.length > currentMaxPayloadBytes) {
      return { status: 413, body: 'Payload too large' };
    }

    // Constant-time HMAC verification for signed payloads.
    const signatureHex = headers['x-webhook-signature'];
    if (signatureHex !== undefined) {
      const ok = await verifySignature(body, signatureHex);
      if (!ok) {
        return { status: 401, body: 'Invalid signature' };
      }
    }

    if (onPayload) {
      onPayload(body, headers);
    }

    return { status: 200, body: 'OK' };
  };

  const endpoint = makeExo('WebhookEndpoint', WebhookEndpointInterface, {
    url: () => {
      assertNotRevoked();
      return webhookUrl;
    },
    secret: () => {
      assertNotRevoked();
      return webhookSecret;
    },
    /**
     * @param {string} body
     * @param {string} signatureHex
     */
    verify: async (body, signatureHex) => {
      assertNotRevoked();
      return verifySignature(body, signatureHex);
    },
    disable: () => {
      assertNotRevoked();
      enabled = false;
    },
    enable: () => {
      assertNotRevoked();
      enabled = true;
    },
    help: () =>
      `WebhookEndpoint receives HTTP POSTs at ${webhookUrl}. ` +
      `Methods: url(), secret(), verify(body, signatureHex), ` +
      `disable(), enable(), help(). ` +
      `Status: ${enabled ? 'enabled' : 'disabled'}.`,
  });

  const control = makeExo('WebhookControl', WebhookControlInterface, {
    setMaxPayloadBytes: n => {
      n >= 1 || Fail`maxPayloadBytes must be >= 1`;
      currentMaxPayloadBytes = n;
    },
    setRateLimit: n => {
      n >= 1 || Fail`rateLimit must be >= 1`;
      currentRateLimit = n;
    },
    revoke: () => {
      revoked = true;
    },
    help: () =>
      `WebhookControl manages a webhook endpoint. ` +
      `Methods: setMaxPayloadBytes(n), setRateLimit(n), revoke(), help().`,
  });

  return harden({ endpoint, control, handleRequest });
};
harden(makeWebhookKit);
