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

import { Fail } from '@endo/errors';
import {
  BROKER_OWNER_PATTERN,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  makeProviderBrokerKit,
} from '@endo/hosted-agent/provider-broker-service.js';

/** @import { BrokerPolicy } from '@endo/hosted-agent/provider-broker.js' */

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_INFERENCE_PATH = '/api/v1/chat/completions';
export const OPENCODE_BROKER_ACCOUNT = 'openrouter';
export const OPENCODE_BROKER_VERSION = 'OpencodeProviderBrokerV1';

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
 * @param {object} options
 * @param {readonly string[]} options.models - provider-scoped model ids the lease admits
 * @param {number} [options.maxConcurrentRequests]
 * @param {bigint} [options.maxRequestBytes]
 * @param {bigint} [options.maxResponseBytes]
 * @returns {BrokerPolicy}
 */
export const buildOpencodeBrokerPolicy = ({
  models,
  maxConcurrentRequests = 4,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) => {
  (Array.isArray(models) &&
    models.length > 0 &&
    models.every(
      model =>
        typeof model === 'string' && model.length > 0 && !model.includes(' '),
    )) ||
    Fail`OpenCode broker models must be a nonempty list of model ids`;
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
    models: [...models],
    maxConcurrentRequests,
    maxRequestBytes,
    maxResponseBytes,
  });
};

/**
 * Construct an inert OpenRouter broker owner over the shared provider broker
 * kit (`@endo/hosted-agent/provider-broker-service.js`), bound to the
 * OpenRouter policy and account. Retain the kit before start().
 *
 * @param {Omit<Parameters<typeof makeProviderBrokerKit>[0], 'label' | 'policy' | 'accountRef'> & { models: readonly string[] }} options
 */
export const makeOpencodeBrokerKit = ({ models, ...options }) =>
  makeProviderBrokerKit({
    ...options,
    label: 'OpenCode',
    policy: buildOpencodeBrokerPolicy({ models }),
    accountRef: OPENCODE_BROKER_ACCOUNT,
  });
harden(makeOpencodeBrokerKit);

/**
 * Transitional convenience entrypoint. If startup and rollback both fail, the
 * rejected promise does not retain a public cleanup handle or prove release.
 * Native owners must retain makeOpencodeBrokerKit() before starting instead.
 * @param {Parameters<typeof makeOpencodeBrokerKit>[0]} options
 */
export const makeOpencodeBroker = async options => {
  const kit = makeOpencodeBrokerKit(options);
  try {
    const broker = await kit.start();
    return harden({ ...broker, dispose: kit.close });
  } catch (error) {
    try {
      await kit.close();
    } catch (cleanupError) {
      throw AggregateError(
        [error, cleanupError],
        'OpenCode broker startup and cleanup failed',
      );
    }
    throw error;
  }
};
harden(makeOpencodeBroker);
