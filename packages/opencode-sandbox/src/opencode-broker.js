// @ts-check

// Provider broker and optional shared public egress for the OpenCode sandbox.
//
// Phase 1 injected the OpenRouter key into the slice and let it reach
// https://openrouter.ai directly, which meant a session with network policy
// "off" could not run a turn at all. This composition gives the slice a
// loopback-only network namespace that it shares with a provider listener
// container: the listener is connected to nothing, the host daemon performs
// the HTTPS request with the credential, and the slice sees only
// http://127.0.0.1:<port>. The opencode SDK insists on an API key and sends it
// as a Bearer header, so the listener admits a client Authorization and never
// forwards it (`clientAuthorization: 'strip'`); the broker injects the real
// OpenRouter key upstream.

import {
  BROKER_OWNER_PATTERN,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '@endo/hosted-agent/provider-broker-service.js';

/** @import { BrokerPolicy } from '@endo/hosted-agent/provider-broker.js' */

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_INFERENCE_PATH = '/api/v1/chat/completions';

// The shared budgets and owner pattern, re-exported for this package's users.
export {
  BROKER_OWNER_PATTERN,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
};

/**
 * The operator policy for one OpenRouter lease issuer. Exported so the
 * deployment can assert the exact origin, route, and credential handling it
 * configured without reproducing the literal.
 *
 * Models are not part of the policy: the account's own OpenRouter catalog
 * admits them (`@endo/hosted-agent/model-catalog.js`).
 *
 * @param {object} [options]
 * @param {number} [options.maxConcurrentRequests]
 * @param {bigint} [options.maxRequestBytes]
 * @param {bigint} [options.maxResponseBytes]
 * @returns {BrokerPolicy}
 */
export const buildOpencodeBrokerPolicy = ({
  maxConcurrentRequests = 4,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) => {
  return harden({
    origin: OPENROUTER_ORIGIN,
    authMode: /** @type {const} */ ('api-key'),
    routes: [
      {
        method: /** @type {const} */ ('POST'),
        path: OPENROUTER_INFERENCE_PATH,
      },
    ],
    clientAuthorization: /** @type {const} */ ('strip'),
    maxConcurrentRequests,
    maxRequestBytes,
    maxResponseBytes,
  });
};
