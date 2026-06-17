// @ts-check
/* global Buffer */
/**
 * @import { Credentials } from '../../protocol.types.js'
 */

import https from 'node:https';
import { URL } from 'node:url';

/**
 * RFC 6749 §6 refresh-token grant. Returns a `refresh()` callback
 * suitable for `makeBroker`'s `refresher` option. Operators call
 * `refresh()` once at startup to obtain the seed `initialCredentials`
 * for `makeBroker` (see `bin/claude-broker`), then hand the same
 * callback to the broker so it can drive subsequent rotations.
 *
 * The long-lived refresh token lives only inside this closure; the
 * broker process holds it in memory and never writes it to the
 * formula store, the persisted sessions.json, or any wire frame
 * crossing into a guest VM. Only the short-lived access token
 * reaches subscribers.
 *
 * If the IdP rotates the refresh token on every response (Anthropic
 * does this; most OAuth2 providers do too — RFC 6749 §10.4
 * recommends it), the new token replaces the in-memory one. There
 * is no on-disk persistence today; a broker restart re-uses the
 * original refresh token from configuration and walks forward
 * from there.
 *
 * @typedef {object} OAuthRefresherOpts
 * @property {string} tokenUrl              OAuth2 token endpoint, e.g.
 *   `https://auth.example.com/oauth/token`.
 * @property {string} clientId
 * @property {string} [clientSecret]        Optional for public clients
 *   that use PKCE only; required for confidential clients per RFC 6749 §3.2.1.
 * @property {string} refreshToken          The long-lived secret. Stays in
 *   this closure for the lifetime of the broker process.
 * @property {string[]} [scope]             Optional scope request; joined
 *   with spaces per RFC 6749 §3.3.
 * @property {(req: { url: string, body: Record<string, string> }) =>
 *   Promise<{ status: number, body: any }>} [httpFetch]
 *   Injectable for tests. Default is a tiny `https.request` wrapper.
 * @property {(level: 'info'|'warn'|'error', msg: string) => void} [log]
 *
 * @param {OAuthRefresherOpts} opts
 */
export const makeOAuthRefresher = opts => {
  const {
    tokenUrl,
    clientId,
    clientSecret,
    scope,
    httpFetch = defaultHttpFetch,
    log = () => {},
  } = opts;
  let currentRefreshToken = opts.refreshToken;

  /**
   * @returns {Promise<Credentials>}
   */
  const refresh = async () => {
    /** @type {Record<string, string>} */
    const body = {
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: clientId,
    };
    if (clientSecret) body.client_secret = clientSecret;
    if (scope && scope.length > 0) body.scope = scope.join(' ');

    const res = await httpFetch({ url: tokenUrl, body });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `OAuth refresh failed: HTTP ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    const payload = res.body ?? {};
    const accessToken = payload.access_token;
    const expiresIn = Number(payload.expires_in);
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('OAuth refresh: response missing access_token');
    }
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('OAuth refresh: response missing valid expires_in');
    }
    // Rotated refresh token — RFC 6749 §10.4 recommends this.
    const newRefresh = payload.refresh_token;
    if (typeof newRefresh === 'string' && newRefresh.length > 0) {
      currentRefreshToken = newRefresh;
      log('info', 'OAuth refresh: refresh token rotated');
    }
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    return harden({
      oauthToken: { accessToken, expiresAt },
    });
  };

  return harden({ refresh });
};
harden(makeOAuthRefresher);

/**
 * Default form-urlencoded POST. The body is `application/x-www-form-urlencoded`
 * per RFC 6749 §3.2. Response is parsed as JSON regardless of HTTP
 * status so the caller can surface IdP error payloads
 * (`{error: 'invalid_grant', error_description: '...'}`) in its
 * thrown message.
 *
 * @type {NonNullable<OAuthRefresherOpts['httpFetch']>}
 */
const defaultHttpFetch = ({ url, body }) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const form = new URLSearchParams(body).toString();
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(form),
          accept: 'application/json',
        },
      },
      res => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            parsed = { rawBody: text };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(form);
    req.end();
  });
