// @ts-check

import { Fail, q } from '@endo/errors';

/**
 * Provider-specific OAuth modes stay data, rather than conditionals spread
 * through the registry. Enabling one later requires evidence, an issuer
 * adapter, and changing that entry; provider records need no schema change.
 */
/** @type {Record<string, { kind: string, state: 'enabled' | 'unavailable', reason: string }>} */
export const INFERENCE_PROVIDER_OAUTH_MODES = harden({
  'claude-subscription': harden({
    kind: 'anthropic',
    state: 'unavailable',
    reason:
      'Claude subscription OAuth is not enabled: no documented third-party broker role',
  }),
  'chatgpt-subscription': harden({
    kind: 'openai',
    state: 'unavailable',
    reason:
      'ChatGPT subscription OAuth is not enabled: individual-plan and token-persistence evidence is incomplete',
  }),
  'github-copilot-subscription': harden({
    kind: 'github-copilot',
    state: 'unavailable',
    reason:
      'GitHub Copilot subscription OAuth is not enabled: no reviewed provider adapter is installed',
  }),
});
harden(INFERENCE_PROVIDER_OAUTH_MODES);

/**
 * @param {string} oauthProvider
 * @param {string} kind
 */
export const assertInferenceProviderOAuthAvailable = (oauthProvider, kind) => {
  const entry = INFERENCE_PROVIDER_OAUTH_MODES[oauthProvider];
  entry !== undefined ||
    Fail`Unknown inference OAuth provider ${q(oauthProvider)}`;
  entry.kind === kind ||
    Fail`Inference OAuth provider ${q(oauthProvider)} does not serve ${q(kind)}`;
  entry.state === 'enabled' || Fail`${entry.reason}`;
};
harden(assertInferenceProviderOAuthAvailable);
