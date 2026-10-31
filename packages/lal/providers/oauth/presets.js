// @ts-check

/**
 * Verified provider presets for the subscription-OAuth flow: concrete,
 * validated `ProviderOAuthConfig` values for a real OAuth server, so the flow
 * carries a genuine integration rather than only test fakes.
 *
 * The pure flow modules (`flow.js`, `pkce.js`) embed no provider constants by
 * design, so the flow stays provider-agnostic and testable. This module is the
 * one place a provider's concrete endpoints live, kept separate to preserve
 * that discipline.
 *
 * Presets included:
 *
 * - `minion-town-mcp`: the minion.town MCP resource server (an OAuth 2.1
 *   protected resource per RFC 9728), whose authorization server is Amazon
 *   Cognito. This is an MCP resource server a user authenticates *to*, which is
 *   distinct in kind from the subscription providers a user authenticates
 *   *against*; it serves as the design's concrete validation target, exercising
 *   the authorization-code-with-PKCE flow against a real RFC-9728/8414-shaped
 *   deployment rather than only fakes.
 *
 * Not yet included (follow-ups): the subscription providers the README names
 * (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot). Each needs a registered
 * OAuth client id per provider, which this change does not mint.
 */

/** @import { ProviderOAuthConfig } from './oauth.types.js' */

// The two redirect URIs registered on the minion.town MCP's public Cognito
// client. The token endpoint rejects any `redirect_uri` that was not registered
// and does not exactly match the one sent to the authorization endpoint, so a
// preset must pin one of these. `http://localhost:8080/callback` is the
// daemon-only build's loopback listener; `https://minion.town/callback` is the
// deployed web callback.
const MINION_TOWN_MCP_REGISTERED_REDIRECT_URIS = harden([
  'http://localhost:8080/callback',
  'https://minion.town/callback',
]);

// The scopes the minion.town MCP publishes in its protected-resource metadata
// (RFC 9728). Each maps to a tool-authorization gate on the server:
// `mcp/tools` is the route-level gate, `mcp/minions:read` and
// `mcp/minions:write` are the per-tool gates.
const MINION_TOWN_MCP_SCOPES = harden([
  'mcp/tools',
  'mcp/minions:read',
  'mcp/minions:write',
]);

/**
 * The validated OAuth configuration for the minion.town MCP resource server.
 *
 * The endpoints, client id, scopes, and registered redirect URIs were
 * confirmed against the live deployment's published metadata (the RFC 9728
 * protected-resource document at
 * `https://minion.town/.well-known/oauth-protected-resource/mcp` and the
 * Cognito OIDC discovery document its `authorization_servers` names) on
 * 2026-07-13. The client is a public PKCE client (RFC 7636), so it carries no
 * secret; the client id is a non-secret constant published in the minion.town
 * deployment.
 *
 * @param {object} [options]
 * @param {string} [options.redirectUri] one of the registered callbacks; the
 *   value sent to both the authorization and token endpoints, which must match.
 * @param {string[]} [options.scopes] a subset of the published scopes; defaults
 *   to all three.
 * @returns {ProviderOAuthConfig}
 */
export const makeMinionTownMcpOAuthConfig = ({
  redirectUri = 'http://localhost:8080/callback',
  scopes = MINION_TOWN_MCP_SCOPES,
} = {}) => {
  if (!MINION_TOWN_MCP_REGISTERED_REDIRECT_URIS.includes(redirectUri)) {
    throw new Error(
      `minion.town MCP OAuth redirectUri must be one of the registered callbacks (${MINION_TOWN_MCP_REGISTERED_REDIRECT_URIS.join(
        ', ',
      )}); got ${JSON.stringify(redirectUri)}.`,
    );
  }
  return harden({
    provider: 'minion-town-mcp',
    authorizationEndpoint:
      'https://minion-town.auth.us-west-1.amazoncognito.com/oauth2/authorize',
    tokenEndpoint:
      'https://minion-town.auth.us-west-1.amazoncognito.com/oauth2/token',
    clientId: '1uesun672b9a0lidth983v0vc9',
    redirectUri,
    scopes: harden([...scopes]),
  });
};
harden(makeMinionTownMcpOAuthConfig);

export { MINION_TOWN_MCP_REGISTERED_REDIRECT_URIS, MINION_TOWN_MCP_SCOPES };
