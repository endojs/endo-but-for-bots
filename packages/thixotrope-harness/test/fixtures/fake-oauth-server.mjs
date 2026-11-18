// @ts-check
/**
 * The fake OAuth server (M4 W4.4; designs/m4-interfaces.md 7, 10, 12).
 *
 * An HTTP server on 127.0.0.1 and a free port, never another address. It
 * mints placeholder tokens (built at run time, never shaped like a provider
 * key) and answers:
 *
 * - `POST /token`, `grant_type: refresh_token`: a live refresh token is
 *   consumed and a new access token (and, with `rotate`, a new refresh
 *   token) is answered with `expires_in`; a consumed one is answered 400
 *   `invalid_grant` and recorded as a `replay`; an unknown one 400.
 * - `POST /token`, `grant_type: authorization_code`: the code of an earlier
 *   `/authorize`, checked against its PKCE challenge (S256) and
 *   `redirect_uri`; answers tokens as above (the sign-in helper's path).
 * - `GET /authorize?code_challenge=...&code_challenge_method=S256&state=...`:
 *   a fake consent page that answers JSON `{ code, state }` at once (no
 *   redirect), so a test can paste `code#state` to the sign-in helper.
 *
 * Bodies are JSON or form-encoded. `setPlan([...])` queues answers for the
 * next token requests: `{ status, body? }` (the grant is not processed),
 * `{ disconnect: true }` (socket destroyed after the request was read; the
 * grant is processed first: the token is spent and the answer lost) or
 * `{ hang: true }` (no answer). `hold()` holds the next token answer after
 * the grant was processed, until `release()` or the client goes away
 * (kill point K-6).
 *
 * `requests()` reports per request: `method`, `path`, `grant`, `tokenSerial`
 * (the serial of the refresh token presented, or of the code), `replay`,
 * `status`, `headerNames`. Never a token value. `presented(serial)` counts
 * how often a refresh token was presented.
 *
 * Node only (tests and perf).
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * @typedef {{ status: number, body?: unknown } | { disconnect: true } | { hang: true }} OAuthPlanEntry
 * @typedef {{ method: string, path: string, grant?: string, tokenSerial?: number, replay?: boolean, status?: number, headerNames: string[] }} OAuthRequest
 */

/**
 * A placeholder token: joined at run time, never key-shaped.
 * @param {string} kind
 * @param {number} serial
 */
const mintText = (kind, serial) =>
  ['fake', kind, String(serial), randomBytes(6).toString('hex')].join('-');

/**
 * An unsigned JWT-shaped token carrying `exp` and an account claim (the
 * Codex form, so `credentials.js` can read the expiry and account).
 * @param {number} serial
 * @param {number} expSeconds
 * @param {string} accountId
 */
const mintJwt = (serial, expSeconds, accountId) => {
  const part = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      exp: expSeconds,
      serial,
      auth: { chatgpt_account_id: accountId },
    }),
    'unsigned',
  ].join('.');
};

/**
 * @param {object} [options]
 * @param {number} [options.expiresIn] seconds (default 3,600)
 * @param {boolean} [options.rotate] answer a new refresh token (default true)
 * @param {boolean} [options.jwt] mint JWT-shaped access tokens (Codex form)
 * @param {string} [options.accountId] answered account (default `acct-1`)
 * @param {boolean} [options.answerAccount] put `account_id` in answers
 * @param {number} [options.delayMs] before every token answer (default 0)
 * @param {() => number} [options.now] for `exp` claims (default Date.now)
 */
export const startFakeOAuthServer = async (options = {}) => {
  const {
    expiresIn = 3600,
    rotate = true,
    jwt = false,
    answerAccount = false,
    delayMs = 0,
    now = () => Date.now(),
  } = options;
  let { accountId = 'acct-1' } = options;
  let serial = 0;
  /**
   * Refresh token -> record.
   * @type {Map<string, { serial: number, live: boolean, presented: number }>}
   */
  const refreshTokens = new Map();
  /** @type {Map<number, number>} serial -> times presented */
  const presentedBySerial = new Map();
  /**
   * Code -> PKCE record.
   * @type {Map<string, { serial: number, challenge: string, redirectUri?: string, used: boolean }>}
   */
  const codes = new Map();
  /** @type {OAuthRequest[]} */
  const log = [];
  /** @type {OAuthPlanEntry[]} */
  let plan = [];
  /** @type {{ arrived: () => void, released: Promise<void>, release: () => void } | undefined} */
  let holding;

  /** Mint a token pair the server will honour. */
  const mintPair = () => {
    serial += 1;
    const accessToken = jwt
      ? mintJwt(serial, Math.floor(now() / 1000) + expiresIn, accountId)
      : mintText('access', serial);
    const refreshToken = mintText('refresh', serial);
    refreshTokens.set(refreshToken, { serial, live: true, presented: 0 });
    return { accessToken, refreshToken, serial };
  };

  /**
   * @param {{ accessToken: string, refreshToken?: string }} pair
   */
  const answerOf = pair => ({
    access_token: pair.accessToken,
    ...(pair.refreshToken === undefined
      ? {}
      : { refresh_token: pair.refreshToken }),
    expires_in: expiresIn,
    token_type: 'Bearer',
    ...(answerAccount ? { account_id: accountId } : {}),
  });

  /** @param {import('node:http').IncomingMessage} req */
  const bodyOf = async req => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '') return {};
    if ((req.headers['content-type'] ?? '').includes('json')) {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(text));
  };

  /**
   * Process a token grant; the status and answer.
   * @param {Record<string, any>} body
   * @param {OAuthRequest} entry
   * @returns {{ status: number, answer: unknown }}
   */
  const grant = (body, entry) => {
    entry.grant = body.grant_type;
    if (body.grant_type === 'refresh_token') {
      const record = refreshTokens.get(body.refresh_token);
      if (record === undefined)
        return { status: 400, answer: { error: 'invalid_grant' } };
      entry.tokenSerial = record.serial;
      record.presented += 1;
      presentedBySerial.set(record.serial, record.presented);
      if (!record.live) {
        entry.replay = true;
        return { status: 400, answer: { error: 'invalid_grant' } };
      }
      record.live = false;
      const pair = mintPair();
      if (!rotate) {
        refreshTokens.delete(pair.refreshToken);
        record.live = true;
        return { status: 200, answer: answerOf({ accessToken: pair.accessToken }) };
      }
      return { status: 200, answer: answerOf(pair) };
    }
    if (body.grant_type === 'authorization_code') {
      const record = codes.get(body.code);
      if (record === undefined || record.used)
        return { status: 400, answer: { error: 'invalid_grant' } };
      entry.tokenSerial = record.serial;
      record.used = true;
      const verifier = String(body.code_verifier ?? '');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        challenge !== record.challenge ||
        (record.redirectUri !== undefined &&
          body.redirect_uri !== record.redirectUri)
      )
        return { status: 400, answer: { error: 'invalid_grant' } };
      return { status: 200, answer: answerOf(mintPair()) };
    }
    return { status: 400, answer: { error: 'unsupported_grant_type' } };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    /** @type {OAuthRequest} */
    const entry = {
      method: req.method ?? '',
      path: url.pathname,
      headerNames: Object.keys(req.headers).sort(),
    };
    log.push(entry);
    /**
     * @param {number} status
     * @param {unknown} answer
     */
    const send = (status, answer) => {
      entry.status = status;
      const text = JSON.stringify(answer);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };
    (async () => {
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const challenge = url.searchParams.get('code_challenge') ?? '';
        if (url.searchParams.get('code_challenge_method') !== 'S256')
          return send(400, { error: 'invalid_request' });
        serial += 1;
        const code = mintText('code', serial);
        const redirectUri = url.searchParams.get('redirect_uri') ?? undefined;
        codes.set(code, { serial, challenge, redirectUri, used: false });
        entry.tokenSerial = serial;
        return send(200, { code, state: url.searchParams.get('state') ?? '' });
      }
      if (req.method !== 'POST' || url.pathname !== '/token') {
        await bodyOf(req);
        return send(404, { error: 'not_found' });
      }
      const body = await bodyOf(req);
      const step = plan.shift();
      if (step !== undefined && 'hang' in step) return undefined;
      if (step !== undefined && 'status' in step) {
        entry.grant = body.grant_type;
        return send(step.status, step.body ?? { error: 'planned' });
      }
      const { status, answer } = grant(body, entry);
      if (step !== undefined && 'disconnect' in step) {
        res.socket?.destroy();
        return undefined;
      }
      if (delayMs > 0) await sleep(delayMs);
      if (holding !== undefined) {
        const held = holding;
        holding = undefined;
        held.arrived();
        await Promise.race([
          held.released,
          new Promise(resolve => res.on('close', resolve)),
        ]);
        if (res.destroyed || res.socket?.destroyed) return undefined;
      }
      return send(status, answer);
    })().catch(() => {
      if (!res.headersSent) send(500, { error: 'fake_failure' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  const url = `http://127.0.0.1:${address.port}`;

  return harden({
    url,
    tokenUrl: `${url}/token`,
    authorizeUrl: `${url}/authorize`,
    /** A token pair the server honours (a signed-in account). */
    issue: () => {
      const { accessToken, refreshToken, serial: issued } = mintPair();
      return harden({ accessToken, refreshToken, serial: issued, expiresIn });
    },
    /** @param {string} id the account later answers name */
    setAccount: id => {
      accountId = id;
    },
    /** @param {OAuthPlanEntry[]} entries */
    setPlan: entries => {
      plan = [...entries];
    },
    /**
     * Hold the next token answer (after its grant was processed).
     * @returns {{ arrived: Promise<void>, release: () => void }}
     */
    hold: () => {
      /** @type {() => void} */
      let arrived = () => {};
      /** @type {() => void} */
      let release = () => {};
      const arrivedP = new Promise(resolve => {
        arrived = () => resolve(undefined);
      });
      const released = new Promise(resolve => {
        release = () => resolve(undefined);
      });
      holding = {
        arrived,
        released: /** @type {Promise<void>} */ (released),
        release,
      };
      return harden({
        arrived: /** @type {Promise<void>} */ (arrivedP),
        release,
      });
    },
    requests: () => harden(log.map(entry => ({ ...entry }))),
    /** @param {number} tokenSerial */
    presented: tokenSerial => presentedBySerial.get(tokenSerial) ?? 0,
    close: async () => {
      holding?.release();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  });
};
