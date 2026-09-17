// @ts-check

import { Fail } from '@endo/errors';

/** @import { BrokerPolicy, ProviderRequestAdapter } from '@endo/hosted-agent/provider-broker.js' */

/**
 * Fixed host-side ChatGPT subscription translation. OAuth describes the
 * credential mechanism; this adapter, not the shared broker, owns the
 * subscription endpoint and account headers.
 * No origin, path, or header override comes from operator JSON or the guest.
 *
 * @param {{accountRef: string, models: readonly string[]}} config
 * @returns {{accountRef: string, policy: BrokerPolicy, adaptRequest: ProviderRequestAdapter}}
 */
export const makeCodexSubscriptionProfile = ({ accountRef, models }) => {
  /^[A-Za-z0-9_-]{1,256}$/.test(accountRef) ||
    Fail`Invalid Codex subscription account`;
  return harden({
    accountRef,
    policy: {
      origin: 'https://chatgpt.com',
      authMode: 'oauth',
      routes: [{ method: 'POST', path: '/v1/responses' }],
      models: [...models],
      maxConcurrentRequests: 4,
      maxRequestBytes: 8n * 1024n ** 2n,
      maxResponseBytes: 16n * 1024n ** 2n,
    },
    adaptRequest: ({ path, data }) => {
      path === '/v1/responses' || Fail`Codex subscription route denied`;
      (data.store === false && data.stream === true) ||
        Fail`Subscription inference requires non-stored streaming responses`;
      return harden({
        path: '/backend-api/codex/responses',
        headers: {
          'chatgpt-account-id': accountRef,
          originator: 'codex_cli_rs',
        },
      });
    },
  });
};
harden(makeCodexSubscriptionProfile);
