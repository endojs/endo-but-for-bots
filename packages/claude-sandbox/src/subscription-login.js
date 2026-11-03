// @ts-check
import { createHash, randomBytes } from 'node:crypto';
import { Fail } from '@endo/errors';
import { boundedJson } from '@endo/hosted-agent/bounded-json.js';
import { importClaudeSubscription } from './subscription-auth.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** Browser PKCE login using the same public OAuth flow as ycc. No CLI process,
 * credential export, or provider key is required. The returned renewal record
 * belongs in Secrets, never a recipe, environment, log or inventory value.
 * @param {{fetch?: typeof globalThis.fetch, accountRef: string}} options
 */
export const makeClaudeSubscriptionLogin = ({
  fetch = globalThis.fetch,
  accountRef,
}) => {
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(accountRef) ||
    Fail`Invalid Claude account binding`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('https://claude.com/cai/oauth/authorize');
  url.search = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  }).toString();
  let used = false;
  return harden({
    authorizationUrl: url.href,
    /** @param {string} reply */
    async exchange(reply) {
      await null;
      !used || Fail`Claude login already exchanged; start a new login`;
      const parts = typeof reply === 'string' ? reply.trim().split('#') : [];
      (parts.length === 2 &&
        /^[A-Za-z0-9_-]{1,4096}$/.test(parts[0]) &&
        parts[1] === verifier) ||
        Fail`Invalid Claude authorization code or state`;
      used = true;
      try {
        const response = await fetch(
          'https://platform.claude.com/v1/oauth/token',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: CLIENT_ID,
              code: parts[0],
              state: verifier,
              redirect_uri: REDIRECT,
              code_verifier: verifier,
            }),
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw Error('Login refused');
        }
        const token = await boundedJson(response, 64 * 1024, 'Claude login');
        (typeof token.scope === 'string' &&
          token.token_type?.toLowerCase() === 'bearer') ||
          Fail`Invalid Claude login response`;
        // Discard the short-lived access token. The existing broker owns the
        // durable renewal/CAS protocol and obtains its own memory-only token.
        return importClaudeSubscription(
          {
            refreshToken: token.refresh_token,
            scopes: token.scope.split(/ +/),
          },
          accountRef,
        );
      } catch {
        throw Error('Claude login failed; start a new login');
      }
    },
  });
};
harden(makeClaudeSubscriptionLogin);
