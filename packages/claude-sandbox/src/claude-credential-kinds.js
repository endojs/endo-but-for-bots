// @ts-check

/**
 * Credential kinds and the Claude Code env var each lands in. `apiKey` is a
 * raw Anthropic API key; `oauthToken` is the OAuth access token Claude Code
 * accepts headlessly (`claude setup-token`). Maps a kind to the environment
 * variable Claude Code reads it from inside the slice; see
 * `claude-sandbox-factory.js` for the peer-hosted, short-lived-secret
 * rationale. Shared by the credentials factory and module, the daemon-owned
 * native controller, and the legacy per-session client module.
 */
export const CREDENTIAL_ENV_VARS = harden({
  apiKey: 'ANTHROPIC_API_KEY',
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
});

/** The credential kinds, in the order the table declares them. */
export const CREDENTIAL_KINDS = harden(Object.keys(CREDENTIAL_ENV_VARS));
