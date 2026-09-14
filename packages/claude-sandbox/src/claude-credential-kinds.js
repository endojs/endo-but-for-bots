// @ts-check

import { Fail, q } from '@endo/errors';

/**
 * Credential kinds and the Claude Code env var each lands in. `apiKey` is a
 * raw Anthropic API key; `oauthToken` is the OAuth access token Claude Code
 * accepts headlessly (`claude setup-token`). Maps a kind to the environment
 * variable Claude Code reads it from inside the slice. The kind also selects
 * the header the provider broker sends the real credential under: `x-api-key`
 * for an API key, a Bearer token for a subscription token. Shared by the
 * broker policy, the hosted setup, the session plan, the daemon-owned native
 * controller, and the legacy per-session client module.
 */
export const CREDENTIAL_ENV_VARS = harden({
  apiKey: 'ANTHROPIC_API_KEY',
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
});

/** @typedef {keyof typeof CREDENTIAL_ENV_VARS} CredentialKind */

/** The credential kinds, in the order the table declares them. */
export const CREDENTIAL_KINDS = harden(Object.keys(CREDENTIAL_ENV_VARS));

/**
 * Narrow an untyped kind at a boundary: a formula environment, an operator
 * variable, a recorded plan.
 *
 * @param {unknown} kind
 * @returns {CredentialKind}
 */
export const assertCredentialKind = kind => {
  if (typeof kind !== 'string' || !Object.hasOwn(CREDENTIAL_ENV_VARS, kind)) {
    throw Fail`Claude credential kind must be one of ${q(CREDENTIAL_KINDS.join(', '))}, got ${q(kind)}`;
  }
  return /** @type {CredentialKind} */ (kind);
};
harden(assertCredentialKind);
