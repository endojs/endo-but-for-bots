// @ts-check

/**
 * The Anthropic provider broker for the Claude sandbox: the shared provider
 * broker kit (`@endo/hosted-agent/provider-broker-service.js`) under the
 * Anthropic Messages policy. The slice reaches only the listener's loopback
 * endpoint; the host injects the credential upstream, under the header the
 * credential's kind needs. The Claude CLI insists on a credential of its own
 * and sends it — as `x-api-key` for an API key, which the listener never
 * forwards, or as a Bearer token for a subscription token, which the listener
 * admits and strips (`clientAuthorization: 'strip'`).
 *
 * @module
 */

import { Fail, q } from '@endo/errors';
import {
  assertBrokerModels,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  makeProviderBrokerKit,
  makeProviderBrokerServiceKit,
} from '@endo/hosted-agent/provider-broker-service.js';

import { assertCredentialKind } from './claude-credential-kinds.js';

/** @import { BrokerPolicy } from '@endo/hosted-agent/provider-broker.js' */

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
/**
 * Claude Code appends `?beta=true` to the messages route when it authenticates
 * with an OAuth subscription grant rather than an API key. Admission matches
 * the whole request target, query included, so this is a distinct allowed path
 * and not a variant of the one above.
 */
export const ANTHROPIC_MESSAGES_BETA_PATH = `${ANTHROPIC_MESSAGES_PATH}?beta=true`;
export const ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_BROKER_ACCOUNT = 'anthropic';
harden(ANTHROPIC_ORIGIN);
harden(ANTHROPIC_MESSAGES_PATH);
harden(ANTHROPIC_VERSION);
harden(CLAUDE_BROKER_ACCOUNT);

/**
 * The beta capabilities the Claude CLI's subscription tokens are accepted
 * under. An operator overrides the list in the broker profile when the CLI
 * pinned in the slice image needs others; the listener forwards none of the
 * CLI's own headers, so this list is the only `anthropic-beta` upstream sees.
 */
export const DEFAULT_OAUTH_BETA = 'oauth-2025-04-20';
harden(DEFAULT_OAUTH_BETA);

/**
 * A comma-separated capability list that cannot carry a header separator or
 * a second header: the shape the broker grant checks at every admission
 * (`@endo/hosted-agent/provider-broker.js`), checked here so setup refuses a
 * bad list before minting a broker every session would fail against.
 */
export const ANTHROPIC_BETA_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:,[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
harden(ANTHROPIC_BETA_PATTERN);

/**
 * The operator policy for one Anthropic lease issuer. Exported so the
 * deployment can assert the exact origin, route, and credential handling it
 * configured without reproducing the literal.
 *
 * @param {object} options
 * @param {readonly string[]} options.models - model ids the lease admits
 * @param {string} options.credentialKind - `apiKey` (sent as `x-api-key`) or
 *   `oauthToken` (sent as a Bearer token with the OAuth beta capability)
 * @param {string} [options.anthropicBeta] - beta capabilities to send; the
 *   OAuth default applies to subscription tokens when omitted
 * @param {number} [options.maxConcurrentRequests]
 * @param {bigint} [options.maxRequestBytes]
 * @param {bigint} [options.maxResponseBytes]
 * @returns {BrokerPolicy}
 */
export const buildClaudeBrokerPolicy = ({
  models,
  credentialKind,
  anthropicBeta,
  maxConcurrentRequests = 4,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) => {
  const oauth = assertCredentialKind(credentialKind) === 'oauthToken';
  /** @type {'bearer' | 'x-api-key'} */
  const credentialHeader = oauth ? 'bearer' : 'x-api-key';
  const beta = anthropicBeta ?? (oauth ? DEFAULT_OAUTH_BETA : undefined);
  beta === undefined ||
    ANTHROPIC_BETA_PATTERN.test(beta) ||
    Fail`Invalid Anthropic beta capabilities: ${q(beta)}`;
  return harden({
    origin: ANTHROPIC_ORIGIN,
    authMode: /** @type {const} */ ('api-key'),
    routes: [
      {
        method: /** @type {const} */ ('POST'),
        path: ANTHROPIC_MESSAGES_PATH,
      },
      // Only for a subscription grant: an API-key deployment never sends the
      // beta target, so admitting it there would widen the policy for nothing.
      ...(oauth
        ? [
            {
              method: /** @type {const} */ ('POST'),
              path: ANTHROPIC_MESSAGES_BETA_PATH,
            },
          ]
        : []),
    ],
    clientAuthorization: /** @type {const} */ ('strip'),
    credentialHeader,
    anthropicVersion: ANTHROPIC_VERSION,
    ...(beta === undefined ? {} : { anthropicBeta: beta }),
    models: assertBrokerModels(models, 'Claude'),
    maxConcurrentRequests,
    maxRequestBytes,
    maxResponseBytes,
  });
};
harden(buildClaudeBrokerPolicy);

/**
 * @typedef {Omit<Parameters<typeof makeProviderBrokerKit>[0], 'label' | 'policy' | 'accountRef'> & { models: readonly string[], credentialKind: string, anthropicBeta?: string }} ClaudeBrokerOptions
 */

/**
 * Construct an inert Anthropic broker owner. Retain the kit before start().
 * @param {ClaudeBrokerOptions} options
 */
export const makeClaudeBrokerKit = ({
  models,
  credentialKind,
  anthropicBeta,
  ...options
}) =>
  makeProviderBrokerKit({
    ...options,
    label: 'Claude',
    policy: buildClaudeBrokerPolicy({ models, credentialKind, anthropicBeta }),
    accountRef: CLAUDE_BROKER_ACCOUNT,
  });
harden(makeClaudeBrokerKit);

/**
 * Retain one operator broker before exposing inert per-session scope facets;
 * see `@endo/hosted-agent/provider-broker-service.js`.
 * @param {ClaudeBrokerOptions} options
 */
export const makeClaudeBrokerServiceKit = ({
  models,
  credentialKind,
  anthropicBeta,
  ...options
}) =>
  makeProviderBrokerServiceKit({
    ...options,
    label: 'Claude',
    policy: buildClaudeBrokerPolicy({ models, credentialKind, anthropicBeta }),
    accountRef: CLAUDE_BROKER_ACCOUNT,
  });
harden(makeClaudeBrokerServiceKit);
