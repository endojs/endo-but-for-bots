// @ts-check

/**
 * The Lal subscription-OAuth path: the authorization-code-with-PKCE flow and
 * the per-provider encrypted auth-storage exo from the
 * `endopi-provider-registry-and-oauth` design (milestone M3, phases 3 and 4).
 *
 * Scope: this is the genuinely-missing, unblocked OAuth slice. The provider-
 * registry refactor and the Lal-vs-Genie consolidation policy question the
 * design also raises are deliberately out of scope here.
 */

/** @import { ProviderOAuthConfig, OAuthCredentials, OAuthCryptoPowers, OAuthFetch } from './oauth.types.js' */

import { generateCodeVerifier, generatePkcePair } from './pkce.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './flow.js';

export {
  generateCodeVerifier,
  computeCodeChallenge,
  generatePkcePair,
} from './pkce.js';
export {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  isExpired,
} from './flow.js';
export { makeOAuthAuthStore } from './auth-store.js';
export { encodeBase64Url, decodeBase64Url } from './base64url.js';

/**
 * Bind an OAuth flow to one provider configuration. Returns a small client
 * that begins an authorization (generating PKCE + state and the consent URL),
 * completes it (trading the returned code for tokens), and refreshes tokens.
 * The crypto, `fetch`, and clock capabilities are injected.
 *
 * @param {ProviderOAuthConfig} config
 * @param {OAuthCryptoPowers & { fetch: OAuthFetch, now?: () => number, generateState?: () => string }} powers
 */
export const makeOAuthClient = (
  config,
  { sha256, getRandomValues, fetch, now = () => Date.now(), generateState },
) => {
  return harden({
    /**
     * Begin an authorization: generate a PKCE pair and state, and compose the
     * consent URL. The caller must retain `codeVerifier` and `state` to
     * complete the flow.
     *
     * Security obligation: `state` is the CSRF defense (RFC 6749 §10.12). The
     * caller MUST compare the `state` returned on the redirect against the one
     * issued here and abort on any mismatch before calling
     * `completeAuthorization`; this client issues `state` but cannot see the
     * redirect and so cannot verify it for you.
     */
    beginAuthorization() {
      const { codeVerifier, codeChallenge, codeChallengeMethod } =
        generatePkcePair({ sha256, getRandomValues });
      const state = generateState
        ? generateState()
        : generateCodeVerifier(getRandomValues);
      const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: config.authorizationEndpoint,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        state,
        codeChallenge,
        codeChallengeMethod,
        extraParams: config.extraAuthorizationParams,
      });
      return harden({ authorizationUrl, codeVerifier, state, codeChallenge });
    },

    /**
     * Complete an authorization by exchanging the returned code (with its PKCE
     * verifier) for tokens.
     *
     * @param {{ code: string, codeVerifier: string }} params
     * @returns {Promise<OAuthCredentials>}
     */
    async completeAuthorization({ code, codeVerifier }) {
      return exchangeAuthorizationCode(
        {
          tokenEndpoint: config.tokenEndpoint,
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          code,
          codeVerifier,
        },
        { fetch, now },
      );
    },

    /**
     * Refresh an access token from a refresh token.
     *
     * @param {string} refreshToken
     * @returns {Promise<OAuthCredentials>}
     */
    async refresh(refreshToken) {
      return refreshAccessToken(
        {
          tokenEndpoint: config.tokenEndpoint,
          clientId: config.clientId,
          refreshToken,
          scopes: config.scopes,
        },
        { fetch, now },
      );
    },
  });
};
harden(makeOAuthClient);
