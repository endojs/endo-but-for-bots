// Shared type definitions for the Lal subscription-OAuth path (the
// authorization-code-with-PKCE flow and the per-provider encrypted
// auth-storage exo). Implementation modules pull these in with a
// top-of-file `/** @import { ... } from './oauth.types.js' */` (the `.js`
// specifier resolves to this `.d.ts` under TypeScript module resolution).

/**
 * OAuth 2.0 credentials for one provider account, normalized from a token
 * endpoint response. Times are epoch milliseconds.
 */
export type OAuthCredentials = {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: number;
  obtainedAt?: number;
};

/**
 * Static configuration for one subscription provider's OAuth endpoints.
 * The concrete values (client id, endpoints, scopes) are provider-specific
 * and supplied by the caller; this module does not embed provider presets.
 */
export type ProviderOAuthConfig = {
  provider: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  extraAuthorizationParams?: Record<string, string>;
};

/** A PKCE code-verifier / code-challenge pair (S256 method). */
export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
};

/**
 * The crypto capabilities the PKCE flow needs, injected rather than reached
 * for as ambient authority so the flow stays testable and confinement-safe.
 */
export type OAuthCryptoPowers = {
  sha256: (bytes: Uint8Array) => Uint8Array;
  getRandomValues: (into: Uint8Array) => Uint8Array;
};

/**
 * A symmetric authenticated-encryption capability used to seal credentials
 * at rest. The auth-storage exo holds only sealed bytes; the cipher (and the
 * key behind it) is the caller's to provide and guard.
 */
export type Cipher = {
  encrypt: (plaintext: Uint8Array) => Uint8Array;
  decrypt: (sealed: Uint8Array) => Uint8Array;
};

/** The minimal response shape the flow needs from an injected `fetch`. */
export type OAuthFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

/** A `fetch`-like capability injected into the token-exchange calls. */
export type OAuthFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<OAuthFetchResponse>;
