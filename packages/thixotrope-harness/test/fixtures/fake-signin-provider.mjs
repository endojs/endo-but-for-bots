// @ts-check
/**
 * A fake sign-in provider for the browser sign-in tests (Claude's
 * authorization-code flow with PKCE, ChatGPT's device-code flow), on
 * 127.0.0.1 and a free port only.
 *
 * - `GET /authorize?...&code_challenge=..&state=..`: a fake consent page
 *   answering JSON `{ code, state }` (a test pastes `code#state`).
 * - `POST /v1/oauth/token` (JSON, `authorization_code`): checks the code,
 *   its S256 challenge and the redirect URI; answers Claude tokens.
 * - `POST /api/accounts/deviceauth/usercode` (JSON `{ client_id }`): a
 *   device id, a user code and `interval: "1"` (a string, as the provider
 *   answers it), `expires_at`.
 * - `POST /api/accounts/deviceauth/token` (JSON `{ device_auth_id,
 *   user_code }`): 403 for the first `pendingPolls` polls, then
 *   `{ authorization_code, code_challenge, code_verifier }`; 404 for an
 *   unknown device id.
 * - `POST /oauth/token` (form, `authorization_code`): checks the code, the
 *   verifier and `redirect_uri = <base>/deviceauth/callback`; answers
 *   `{ id_token, access_token, refresh_token }`, the access token a JWT
 *   with `exp` and the `chatgpt_account_id` claim.
 *
 * `plan(path, entries)` queues answers for the next requests to `path`:
 * `{ status, body? }`, `{ redirect: true }` (302 to `/elsewhere`),
 * `{ oversize: true }` (a 200 of 128 KiB), `{ hang: true }` (no answer
 * until the client goes away). `requests()` lists `{ method, path, grant?,
 * status }` (never a token or code). `setAccount(id)` changes the account
 * the next ChatGPT tokens name.
 *
 * Node only (tests).
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** @param {unknown} value */
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * An unsigned JWT-shaped token (never key-shaped).
 * @param {Record<string, unknown>} claims
 */
export const fakeJwt = claims =>
  [part({ alg: 'none', typ: 'JWT' }), part(claims), 'unsigned'].join('.');

const mint = (/** @type {string} */ kind) =>
  ['fake', kind, randomBytes(6).toString('hex')].join('-');

/**
 * @typedef {{ status: number, body?: unknown } | { redirect: true } | { oversize: true } | { hang: true }} PlanEntry
 */

export const startFakeSignInProvider = async ({ pendingPolls = 1 } = {}) => {
  /** @type {Map<string, PlanEntry[]>} */
  const plans = new Map();
  /** @type {{ method: string, path: string, grant?: string, status?: number }[]} */
  const log = [];
  /** Claude codes: code -> { challenge, redirectUri }. */
  const claudeCodes = new Map();
  /** Devices: id -> { userCode, polls, code, verifier }. */
  const devices = new Map();
  /** ChatGPT authorization codes: code -> verifier. */
  const deviceCodes = new Map();
  let account = 'acct-1';
  /** @type {Set<import('node:http').ServerResponse>} */
  const hanging = new Set();

  /** @type {string} */
  let base = '';

  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(String(request.url), base);
      const path = url.pathname;
      const text = Buffer.concat(chunks).toString('utf8');
      const type = String(request.headers['content-type'] ?? '');
      /** @type {Record<string, any>} */
      let body = {};
      try {
        body = type.includes('json')
          ? JSON.parse(text || '{}')
          : Object.fromEntries(new URLSearchParams(text));
      } catch {
        body = {};
      }
      /** @type {{ method: string, path: string, grant?: string, status?: number }} */
      const entry = { method: String(request.method), path };
      if (typeof body.grant_type === 'string') entry.grant = body.grant_type;
      log.push(entry);
      /**
       * @param {number} status
       * @param {unknown} [answer]
       */
      const send = (status, answer) => {
        entry.status = status;
        const out = answer === undefined ? '' : JSON.stringify(answer);
        response.writeHead(status, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(out)),
        });
        response.end(out);
      };
      const planned = plans.get(path)?.shift();
      if (planned !== undefined) {
        if ('hang' in planned) {
          entry.status = 0;
          hanging.add(response);
          response.on('close', () => hanging.delete(response));
          return;
        }
        if ('redirect' in planned) {
          entry.status = 302;
          response.writeHead(302, {
            location: `${base}/elsewhere`,
            'content-length': '0',
          });
          response.end();
          return;
        }
        if ('oversize' in planned) {
          entry.status = 200;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(`"${'x'.repeat(128 * 1024)}"`);
          return;
        }
        send(planned.status, planned.body);
        return;
      }
      if (request.method === 'GET' && path === '/authorize') {
        const code = mint('code').replace(/-/gu, '_');
        claudeCodes.set(code, {
          challenge: url.searchParams.get('code_challenge'),
          redirectUri: url.searchParams.get('redirect_uri'),
        });
        send(200, { code, state: url.searchParams.get('state') });
        return;
      }
      if (request.method === 'POST' && path === '/v1/oauth/token') {
        const known = claudeCodes.get(body.code);
        const challenge = createHash('sha256')
          .update(String(body.code_verifier ?? ''))
          .digest('base64url');
        if (
          body.grant_type !== 'authorization_code' ||
          known === undefined ||
          known.challenge !== challenge ||
          known.redirectUri !== body.redirect_uri
        ) {
          send(400, { error: 'invalid_grant' });
          return;
        }
        claudeCodes.delete(body.code);
        send(200, {
          access_token: mint('access'),
          refresh_token: mint('refresh'),
          expires_in: 3600,
          scope: 'user:inference user:profile',
        });
        return;
      }
      if (
        request.method === 'POST' &&
        path === '/api/accounts/deviceauth/usercode'
      ) {
        if (typeof body.client_id !== 'string') {
          send(400, { error: 'no client' });
          return;
        }
        const id = mint('device');
        const userCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
        devices.set(id, { userCode, polls: 0 });
        send(200, {
          device_auth_id: id,
          user_code: userCode,
          interval: '1',
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        return;
      }
      if (
        request.method === 'POST' &&
        path === '/api/accounts/deviceauth/token'
      ) {
        const device = devices.get(body.device_auth_id);
        if (device === undefined || device.userCode !== body.user_code) {
          send(404, { error: { code: 'deviceauth_not_found' } });
          return;
        }
        device.polls += 1;
        if (device.polls <= pendingPolls) {
          send(403, { error: { code: 'deviceauth_authorization_pending' } });
          return;
        }
        const code = mint('authcode');
        const verifier = mint('verifier');
        deviceCodes.set(code, verifier);
        devices.delete(body.device_auth_id);
        send(200, {
          authorization_code: code,
          code_challenge: createHash('sha256')
            .update(verifier)
            .digest('base64url'),
          code_verifier: verifier,
        });
        return;
      }
      if (request.method === 'POST' && path === '/oauth/token') {
        const verifier = deviceCodes.get(body.code);
        if (
          body.grant_type !== 'authorization_code' ||
          verifier === undefined ||
          verifier !== body.code_verifier ||
          body.redirect_uri !== `${base}/deviceauth/callback` ||
          !type.includes('x-www-form-urlencoded')
        ) {
          send(400, { error: 'invalid_grant' });
          return;
        }
        deviceCodes.delete(body.code);
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const auth = { chatgpt_account_id: account };
        send(200, {
          id_token: fakeJwt({ exp, 'https://api.openai.com/auth': auth }),
          access_token: fakeJwt({ exp, 'https://api.openai.com/auth': auth }),
          refresh_token: mint('refresh'),
        });
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  base = `http://127.0.0.1:${address.port}`;
  return harden({
    base,
    claude: harden({
      authorizeUrl: `${base}/authorize`,
      tokenUrl: `${base}/v1/oauth/token`,
      redirectUri: 'https://platform.claude.com/oauth/code/callback',
      clientId: 'fake-claude-client',
      scopes: harden(['user:inference', 'user:profile']),
    }),
    codex: harden({
      userCodeUrl: `${base}/api/accounts/deviceauth/usercode`,
      pollUrl: `${base}/api/accounts/deviceauth/token`,
      verificationUrl: `${base}/codex/device`,
      tokenUrl: `${base}/oauth/token`,
      redirectUri: `${base}/deviceauth/callback`,
      clientId: 'fake-codex-client',
    }),
    /**
     * @param {string} path
     * @param {PlanEntry[]} entries
     */
    plan: (path, entries) => {
      plans.set(path, [...(plans.get(path) ?? []), ...entries]);
    },
    /** @param {string} id */
    setAccount: id => {
      account = id;
    },
    requests: () => log.map(entry => ({ ...entry })),
    close: async () => {
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  });
};
