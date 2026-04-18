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
 * Create a WebhookEndpoint / WebhookControl facet pair.
 *
 * @param {object} options
 * @param {string} options.webhookId - Unique identifier for the webhook URL path.
 * @param {string} options.gatewayBaseUrl - Base URL of the gateway (e.g., "https://my-daemon.example.com").
 * @param {number} [options.maxPayloadBytes]
 * @param {number} [options.rateLimit] - Max requests per minute.
 * @param {(payload: string, headers: Record<string, string>) => void} [options.onPayload] - Callback when a payload is received.
 * @returns {{ endpoint: object, control: object, handleRequest: (body: string, headers: Record<string, string>) => { status: number, body: string } }}
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
   * @param {string} body - Request body.
   * @param {Record<string, string>} headers - Request headers.
   * @returns {{ status: number, body: string }}
   */
  const handleRequest = (body, headers) => {
    if (revoked) {
      return { status: 410, body: 'Gone' };
    }
    if (!enabled) {
      return { status: 503, body: 'Webhook disabled' };
    }

    // Rate limit check
    const now = Date.now();
    const windowStart = now - 60_000;
    while (
      requestTimestamps.length > 0 &&
      requestTimestamps[0] < windowStart
    ) {
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

    if (onPayload) {
      onPayload(body, headers);
    }

    return { status: 200, body: 'OK' };
  };

  const endpoint = makeExo(
    'WebhookEndpoint',
    WebhookEndpointInterface,
    {
      url: () => {
        assertNotRevoked();
        return webhookUrl;
      },
      secret: () => {
        assertNotRevoked();
        return webhookSecret;
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
        `Methods: url(), secret(), disable(), enable(), help(). ` +
        `Status: ${enabled ? 'enabled' : 'disabled'}.`,
    },
  );

  const control = makeExo(
    'WebhookControl',
    WebhookControlInterface,
    {
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
    },
  );

  return harden({ endpoint, control, handleRequest });
};
harden(makeWebhookKit);
