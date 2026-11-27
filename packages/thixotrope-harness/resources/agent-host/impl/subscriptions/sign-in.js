// @ts-check
/**
 * Subscription sign-in with the providers (the browser's "Add account"
 * flow, `gateway/extensions/subscription-signin.js`, and the CLI,
 * `scripts/subscription-login.mjs`): the provider requests and the
 * credential they produce, in the stored form of `credentials.js`.
 *
 * - **Claude**: the authorization-code flow with PKCE (S256), as
 *   claude-sandbox `subscription-login.js` (1315bef86) does it.
 *   `claudeAuthorization()` makes the authorization page URL with an
 *   independent `state` (the URL is seen by the browser, its history and any
 *   proxy, so it never carries the verifier); `parseCodePaste` checks the
 *   pasted `code#state`; `claudeExchange` posts the code and verifier
 *   (JSON) to the token endpoint.
 * - **ChatGPT / Codex**: the device-code flow of the open-source Codex CLI's
 *   `codex login --device-auth` (openai/codex `codex-rs/login/src/
 *   device_code_auth.rs`, `server.rs` `exchange_code_for_tokens`, at
 *   bee5dc55ac). `codexRequestCode` posts `{ client_id }` (JSON) to
 *   `{issuer}/api/accounts/deviceauth/usercode` and answers the device id,
 *   the user code and the poll interval (a decimal string in the answer);
 *   the person enters the code at `{issuer}/codex/device`. `codexPoll`
 *   posts `{ device_auth_id, user_code }` to `.../deviceauth/token`: 403 or
 *   404 mean "not yet", 2xx answers `{ authorization_code, code_challenge,
 *   code_verifier }` (the server keeps the PKCE pair). `codexExchange`
 *   posts the authorization-code grant, form-encoded, to `{issuer}/oauth/token`
 *   with `redirect_uri = {issuer}/deviceauth/callback`; the answer's
 *   `id_token`, `access_token` and `refresh_token` become the credential.
 *   The account id is the `chatgpt_account_id` of the tokens' namespaced
 *   auth claim (`credentials.js` `codexAccountOf`); the expiry is the access
 *   token's `exp` (the CLI reads no `expires_in` here). No API-key exchange
 *   is made: the CLI's device login makes none either.
 * - `credentialFromLoginFile`: the fallback for either provider, a pasted
 *   login file (Codex `auth.json`, a Claude credentials export) checked by
 *   `credentials.js` and turned into the stored form.
 *
 * Every request: redirects refused (`redirect: 'error'`, and a 3xx answer
 * refused), no cookies, a time box (`signInLimits.exchangeTimeoutMs`), an
 * answer of at most `signInLimits.answerBytes` read as a stream. Failures
 * are `SignInError`s with a fixed code and plain words (`signInTexts`):
 * never a token, a code, a provider body or a URL query.
 *
 * Node only (adapter, CLI). Values never enter a vat (D-6).
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  codexAccountOf,
  formatCredential,
  jwtClaims,
  parseCredential,
} from './credentials.js';
import { providerEndpoints } from './index.js';

/** The bounds of a sign-in (none is a lifetime cap: each bounds held state). */
export const signInLimits = harden({
  /** A provider answer, bytes. */
  answerBytes: 64 * 1024,
  /** One request's time box (the reference's exchange timeout). */
  exchangeTimeoutMs: 30_000,
  /** A pending sign-in lives this long (the Codex CLI's 15 minutes). */
  pendingMs: 15 * 60_000,
  /** Sign-ins waiting at once. */
  maxPending: 4,
  /** The device poll interval when the provider names none. */
  pollDefaultMs: 5000,
  /** The device poll interval is kept within these. */
  pollMinMs: 1000,
  pollMaxMs: 30_000,
  /** Failed polls in a row (no answer) before the sign-in fails. */
  pollFailures: 3,
  /** A pasted login file, bytes. */
  loginFileBytes: 64 * 1024,
  /** A pasted `code#state`, characters. */
  pasteUnits: 8192,
});

/**
 * The providers' sign-in constants. Claude: claude-sandbox
 * `subscription-login.js` (1315bef86). Codex: the Codex CLI's issuer and
 * public client id (openai/codex `login/src/server.rs` `DEFAULT_ISSUER`,
 * `auth/manager.rs` `CLIENT_ID`) and its device paths.
 */
export const signInDefaults = harden({
  claude: {
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: providerEndpoints.claude.tokenUrl,
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    clientId: providerEndpoints.claude.clientId,
    scopes: harden([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ]),
  },
  codex: {
    userCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
    verificationUrl: 'https://auth.openai.com/codex/device',
    tokenUrl: providerEndpoints.codex.tokenUrl,
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
    clientId: providerEndpoints.codex.clientId,
  },
});

/** @typedef {typeof signInDefaults.claude} ClaudeSignInEndpoints */
/** @typedef {typeof signInDefaults.codex} CodexSignInEndpoints */

/** Plain words for each failure (shown to the person as they are). */
export const signInTexts = harden({
  BAD_CODE:
    'That is not a sign-in code. Copy the whole code the page shows after you approve (it looks like code#state) and paste it here.',
  WRONG_STATE:
    'That code belongs to another sign-in. Paste the code from the page this sign-in opened, or start again.',
  EXPIRED: 'This sign-in expired after 15 minutes. Start again.',
  CANCELLED: 'This sign-in was cancelled.',
  REFUSED: 'The provider refused the sign-in. Start again.',
  DEVICE_NOT_ENABLED:
    'ChatGPT did not offer a device code. Device-code sign-in may need to be turned on in the security settings of this ChatGPT account; or paste an auth.json below.',
  TIMED_OUT: 'The provider did not answer in time. Start again.',
  UNREACHABLE: 'The provider could not be reached. Start again.',
  TOO_LARGE: 'The provider answered more than a sign-in needs; it was refused.',
  REDIRECTED: 'The provider answered with a redirect, which sign-in refuses.',
  BAD_ANSWER: 'The provider answered something that is not a sign-in answer.',
  NO_TOKENS: 'The provider answered without usable tokens. Start again.',
  NO_ACCOUNT:
    'The ChatGPT sign-in carried no account id, so it cannot serve as a subscription.',
  INVALID_LOGIN:
    'That text is not a usable login file for this provider. A ChatGPT auth.json needs its tokens and no API key; a Claude export needs its OAuth tokens.',
  TOO_MANY: `At most ${signInLimits.maxPending} sign-ins can wait at once. Finish or cancel one first.`,
  BUSY: 'This sign-in is already finishing.',
  OTHER_ACCOUNT:
    'You signed in to a different ChatGPT account than this subscription uses. Sign in with the same account, or add the other one as a new account.',
  CHANGED:
    'The subscription was changed meanwhile (perhaps renewed). Start again.',
  LABEL_TAKEN: 'The pool already has a subscription with this label.',
  WRONG_POOL: 'That pool is for another provider.',
  NOT_A_MEMBER: 'That subscription is not an active member of the pool.',
  BAD_LABEL: 'Enter a label of 1 to 256 characters on one line.',
  UNKNOWN_PROVIDER: 'Choose Claude or ChatGPT.',
  NOT_READY: 'The agent host is not ready yet. Try again in a moment.',
  SAVE_FAILED: 'The sign-in worked but its credential could not be saved.',
  ADD_FAILED:
    'The sign-in worked but the subscription could not be added to the pool; nothing was kept. Start again.',
});

/** @typedef {keyof typeof signInTexts} SignInCode */

/**
 * A sign-in failure: a fixed code and its plain words, plus an HTTP status
 * where the provider answered one (never a body).
 * @param {SignInCode} code
 * @param {{ status?: number, detail?: string }} [extra]
 */
export const signInError = (code, { status, detail } = {}) => {
  const words = signInTexts[code] ?? signInTexts.REFUSED;
  const text =
    status === undefined
      ? words
      : words.replace(/\.( |$)/u, ` (HTTP ${status}).$1`);
  return Object.assign(Error(detail ? `${text} ${detail}` : text), {
    code,
    ...(status === undefined ? {} : { status }),
  });
};
harden(signInError);

/**
 * The code of a failure: a `SignInError`'s, else `fallback`.
 * @param {unknown} error
 * @param {SignInCode} fallback
 * @returns {SignInCode}
 */
export const signInCodeOf = (error, fallback) => {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && code in signInTexts
    ? /** @type {SignInCode} */ (code)
    : fallback;
};
harden(signInCodeOf);

/**
 * An endpoint URL: https, or http to loopback (tests' fake providers).
 * @param {string} text
 */
const assertEndpoint = text => {
  const url = new URL(text);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  )
    throw Error('A sign-in endpoint is https (or http to loopback)');
  return text;
};

/**
 * Check a whole endpoint table (every URL-valued field).
 * @template {Record<string, unknown>} T
 * @param {T} endpoints
 * @returns {T}
 */
export const checkEndpoints = endpoints => {
  for (const [name, value] of Object.entries(endpoints))
    if (typeof value === 'string' && /Url$|Uri$/u.test(name))
      assertEndpoint(value);
  return endpoints;
};
harden(checkEndpoints);

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A response body of at most `maxBytes`, read as a stream; more is refused
 * (`TOO_LARGE`) and the rest cancelled.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
const boundedText = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw signInError('TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream, chunk by chunk
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // eslint-disable-next-line no-await-in-loop -- leaves the loop
      await reader.cancel().catch(() => {});
      throw signInError('TOO_LARGE');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return fatalUtf8.decode(all);
  } catch {
    throw signInError('BAD_ANSWER');
  }
};

/**
 * Whether `error` (or a cause of it) is named `name` or says `pattern`.
 * @param {unknown} error
 * @param {string} name
 * @param {RegExp} [pattern]
 */
const causedBy = (error, name, pattern) => {
  let cause = /** @type {any} */ (error);
  for (let depth = 0; depth < 4 && cause; depth += 1) {
    if (cause.name === name) return true;
    if (pattern && typeof cause.message === 'string')
      if (pattern.test(cause.message)) return true;
    cause = cause.cause;
  }
  return false;
};

/**
 * @typedef {object} RequestOptions
 * @property {typeof globalThis.fetch} fetch
 * @property {AbortSignal} [signal] the sign-in's own (cancel, expiry)
 * @property {number} [timeoutMs]
 * @property {number} [answerBytes]
 */

/**
 * One bounded POST: redirects refused, no cookies, time-boxed, the answer
 * read up to `answerBytes`. Answers the status and the parsed JSON (or
 * `undefined` for an empty or non-JSON body).
 * @param {string} url
 * @param {{ headers: Record<string, string>, body: string }} request
 * @param {RequestOptions} options
 * @returns {Promise<{ status: number, json: any }>}
 */
const post = async (
  url,
  { headers, body },
  {
    fetch,
    signal,
    timeoutMs = signInLimits.exchangeTimeoutMs,
    answerBytes = signInLimits.answerBytes,
  },
) => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      credentials: 'omit',
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw signInError('CANCELLED');
    if (timeout.aborted || causedBy(error, 'TimeoutError'))
      throw signInError('TIMED_OUT');
    if (causedBy(error, '', /redirect/iu)) throw signInError('REDIRECTED');
    throw signInError('UNREACHABLE');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw signInError('REDIRECTED');
  }
  /** @type {string} */
  let text;
  try {
    text = await boundedText(response, answerBytes);
  } catch (error) {
    if (signInCodeOf(error, 'UNREACHABLE') !== 'UNREACHABLE') throw error;
    if (signal?.aborted) throw signInError('CANCELLED');
    if (timeout.aborted) throw signInError('TIMED_OUT');
    throw signInError('UNREACHABLE');
  }
  /** @type {any} */
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
};

const jsonHeaders = harden({ 'content-type': 'application/json' });
const formHeaders = harden({
  'content-type': 'application/x-www-form-urlencoded',
});

/** @param {unknown} value */
const isRecord = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {number} bytes */
const randomText = bytes => randomBytes(bytes).toString('base64url');

// ------------------------------------------------------------------ Claude

/**
 * A Claude authorization: the page URL to open, and what the exchange
 * needs (kept by the caller, in memory only).
 * @param {object} [options]
 * @param {ClaudeSignInEndpoints} [options.endpoints]
 * @returns {{ url: string, state: string, verifier: string }}
 */
export const claudeAuthorization = ({
  endpoints = signInDefaults.claude,
} = {}) => {
  const verifier = randomText(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // An independent OAuth state (M4-FIX): never the verifier.
  const state = randomText(32);
  const page = new URL(endpoints.authorizeUrl);
  page.search = new URLSearchParams({
    code: 'true',
    client_id: endpoints.clientId,
    response_type: 'code',
    redirect_uri: endpoints.redirectUri,
    scope: endpoints.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return harden({ url: page.href, state, verifier });
};
harden(claudeAuthorization);

/**
 * The code of a pasted `code#state`, checked against this sign-in's state.
 * @param {unknown} pasted
 * @param {string} state
 * @returns {string}
 */
export const parseCodePaste = (pasted, state) => {
  if (typeof pasted !== 'string' || pasted.length > signInLimits.pasteUnits)
    throw signInError('BAD_CODE');
  const parts = pasted.trim().split('#');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,4096}$/u.test(parts[0]))
    throw signInError('BAD_CODE');
  if (parts[1] !== state) throw signInError('WRONG_STATE');
  return parts[0];
};
harden(parseCodePaste);

/**
 * Exchange a Claude authorization code; answers the credential in the
 * stored form (`credentials.js` `formatCredential`).
 * @param {object} options
 * @param {string} options.code
 * @param {string} options.state
 * @param {string} options.verifier
 * @param {typeof globalThis.fetch} options.fetch
 * @param {() => number} [options.now]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] one request's time box (tests)
 * @param {ClaudeSignInEndpoints} [options.endpoints]
 * @returns {Promise<string>}
 */
export const claudeExchange = async ({
  code,
  state,
  verifier,
  fetch,
  now = () => Date.now(),
  signal,
  endpoints = signInDefaults.claude,
  timeoutMs,
}) => {
  const { status, json } = await post(
    endpoints.tokenUrl,
    {
      headers: jsonHeaders,
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: endpoints.clientId,
        code,
        state,
        redirect_uri: endpoints.redirectUri,
        code_verifier: verifier,
      }),
    },
    {
      fetch,
      ...(signal ? { signal } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  if (status < 200 || status >= 300) throw signInError('REFUSED', { status });
  const expiresIn = Number(json?.expires_in);
  if (
    typeof json?.access_token !== 'string' ||
    typeof json?.refresh_token !== 'string' ||
    !(expiresIn > 0)
  )
    throw signInError('NO_TOKENS');
  try {
    return formatCredential(
      harden({
        provider: 'claude',
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAtMs: now() + expiresIn * 1000,
        scopes:
          typeof json.scope === 'string' && json.scope.trim() !== ''
            ? json.scope.trim().split(/ +/u)
            : [...endpoints.scopes],
      }),
    );
  } catch {
    throw signInError('NO_TOKENS');
  }
};
harden(claudeExchange);

// ------------------------------------------------------------------- Codex

/**
 * Ask for a device code (`codex login --device-auth`'s first request).
 * @param {object} options
 * @param {typeof globalThis.fetch} options.fetch
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] one request's time box (tests)
 * @param {() => number} [options.now]
 * @param {CodexSignInEndpoints} [options.endpoints]
 * @returns {Promise<{ deviceAuthId: string, userCode: string, intervalMs: number, verificationUrl: string, expiresAtMs?: number }>}
 */
export const codexRequestCode = async ({
  fetch,
  signal,
  now = () => Date.now(),
  endpoints = signInDefaults.codex,
  timeoutMs,
}) => {
  const { status, json } = await post(
    endpoints.userCodeUrl,
    {
      headers: jsonHeaders,
      body: JSON.stringify({ client_id: endpoints.clientId }),
    },
    {
      fetch,
      ...(signal ? { signal } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  if (status === 404) throw signInError('DEVICE_NOT_ENABLED');
  if (status < 200 || status >= 300) throw signInError('REFUSED', { status });
  const userCode = json?.user_code ?? json?.usercode;
  const deviceAuthId = json?.device_auth_id;
  if (
    typeof deviceAuthId !== 'string' ||
    !/^[\x21-\x7e]{1,512}$/u.test(deviceAuthId) ||
    typeof userCode !== 'string' ||
    !/^[A-Za-z0-9-]{1,64}$/u.test(userCode)
  )
    throw signInError('BAD_ANSWER');
  // The CLI parses a decimal string (`deserialize_interval`); a number is
  // taken too. Kept within the poll bounds.
  const seconds = Number(
    typeof json.interval === 'string' ? json.interval.trim() : json.interval,
  );
  const intervalMs = Math.min(
    signInLimits.pollMaxMs,
    Math.max(
      signInLimits.pollMinMs,
      Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : signInLimits.pollDefaultMs,
    ),
  );
  const expiresAt =
    typeof json.expires_at === 'string' ? Date.parse(json.expires_at) : NaN;
  return harden({
    deviceAuthId,
    userCode,
    intervalMs,
    verificationUrl: endpoints.verificationUrl,
    ...(Number.isFinite(expiresAt) && expiresAt > now()
      ? { expiresAtMs: expiresAt }
      : {}),
  });
};
harden(codexRequestCode);

/**
 * One device poll: `undefined` while the person has not approved (403 or
 * 404, as the CLI reads them), else the authorization code and the PKCE
 * verifier the server kept.
 * @param {object} options
 * @param {string} options.deviceAuthId
 * @param {string} options.userCode
 * @param {typeof globalThis.fetch} options.fetch
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] one request's time box (tests)
 * @param {CodexSignInEndpoints} [options.endpoints]
 * @returns {Promise<{ authorizationCode: string, codeVerifier: string } | undefined>}
 */
export const codexPoll = async ({
  deviceAuthId,
  userCode,
  fetch,
  signal,
  endpoints = signInDefaults.codex,
  timeoutMs,
}) => {
  const { status, json } = await post(
    endpoints.pollUrl,
    {
      headers: jsonHeaders,
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    },
    {
      fetch,
      ...(signal ? { signal } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  if (status === 403 || status === 404) return undefined;
  if (status < 200 || status >= 300) throw signInError('REFUSED', { status });
  const authorizationCode = json?.authorization_code;
  const codeVerifier = json?.code_verifier;
  if (
    typeof authorizationCode !== 'string' ||
    authorizationCode === '' ||
    typeof codeVerifier !== 'string' ||
    codeVerifier === ''
  )
    throw signInError('BAD_ANSWER');
  return harden({ authorizationCode, codeVerifier });
};
harden(codexPoll);

/**
 * A Codex credential in the stored form from the token answer's fields.
 * @param {{ access_token?: unknown, refresh_token?: unknown, id_token?: unknown, expires_in?: unknown }} tokens
 * @param {() => number} now
 * @returns {string}
 */
export const codexCredential = (tokens, now) => {
  const { access_token: accessToken, refresh_token: refreshToken } = tokens;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string')
    throw signInError('NO_TOKENS');
  const accessClaims = jwtClaims(accessToken);
  const idClaims =
    typeof tokens.id_token === 'string'
      ? jwtClaims(tokens.id_token)
      : undefined;
  const accountId =
    (accessClaims && codexAccountOf(accessClaims)) ??
    (idClaims && codexAccountOf(idClaims));
  if (accountId === undefined) throw signInError('NO_ACCOUNT');
  const expiresIn = Number(tokens.expires_in);
  const expiresAtMs =
    typeof accessClaims?.exp === 'number' && Number.isFinite(accessClaims.exp)
      ? accessClaims.exp * 1000
      : expiresIn > 0
        ? now() + expiresIn * 1000
        : undefined;
  if (expiresAtMs === undefined || expiresAtMs <= now())
    throw signInError('NO_TOKENS');
  try {
    return formatCredential(
      harden({
        provider: 'codex',
        accessToken,
        refreshToken,
        expiresAtMs,
        accountId,
      }),
    );
  } catch {
    throw signInError('NO_TOKENS');
  }
};
harden(codexCredential);

/**
 * Exchange the device flow's authorization code (form-encoded, as the CLI's
 * `exchange_code_for_tokens`); answers the stored form.
 * @param {object} options
 * @param {string} options.authorizationCode
 * @param {string} options.codeVerifier
 * @param {typeof globalThis.fetch} options.fetch
 * @param {() => number} [options.now]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] one request's time box (tests)
 * @param {CodexSignInEndpoints} [options.endpoints]
 * @returns {Promise<string>}
 */
export const codexExchange = async ({
  authorizationCode,
  codeVerifier,
  fetch,
  now = () => Date.now(),
  signal,
  endpoints = signInDefaults.codex,
  timeoutMs,
}) => {
  const { status, json } = await post(
    endpoints.tokenUrl,
    {
      headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: endpoints.clientId,
        code: authorizationCode,
        redirect_uri: endpoints.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    },
    {
      fetch,
      ...(signal ? { signal } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  if (status < 200 || status >= 300) throw signInError('REFUSED', { status });
  if (!isRecord(json)) throw signInError('NO_TOKENS');
  return codexCredential(json, now);
};
harden(codexExchange);

/**
 * Wait for the person to approve the device code, then exchange it.
 * Polls every `intervalMs` until `signal` aborts (the caller's expiry or
 * cancel); `pollFailures` polls in a row that got no answer fail it.
 * @param {object} options
 * @param {{ deviceAuthId: string, userCode: string, intervalMs: number }} options.code
 * @param {typeof globalThis.fetch} options.fetch
 * @param {AbortSignal} options.signal
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} options.sleep
 * @param {() => number} [options.now]
 * @param {CodexSignInEndpoints} [options.endpoints]
 * @param {() => void} [options.onApproved] called before the exchange
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>} the stored form
 */
export const codexAwaitApproval = async ({
  code,
  fetch,
  signal,
  sleep,
  now = () => Date.now(),
  endpoints = signInDefaults.codex,
  onApproved = () => {},
  timeoutMs,
}) => {
  let failures = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one poll per interval
    await sleep(code.intervalMs, signal);
    if (signal.aborted) throw signInError('CANCELLED');
    /** @type {{ authorizationCode: string, codeVerifier: string } | undefined} */
    let approved;
    try {
      // eslint-disable-next-line no-await-in-loop -- polls follow each other
      approved = await codexPoll({
        ...code,
        fetch,
        signal,
        endpoints,
        timeoutMs,
      });
      failures = 0;
    } catch (error) {
      const failed = signInCodeOf(error, 'UNREACHABLE');
      if (failed !== 'UNREACHABLE' && failed !== 'TIMED_OUT') throw error;
      failures += 1;
      if (failures >= signInLimits.pollFailures) throw error;
    }
    if (approved !== undefined) {
      onApproved();
      return codexExchange({
        ...approved,
        fetch,
        now,
        signal,
        endpoints,
        timeoutMs,
      });
    }
  }
};
harden(codexAwaitApproval);

// -------------------------------------------------------------- login file

/**
 * The stored form of a pasted login file: Codex's `auth.json` (`tokens`,
 * no API key) or a Claude credentials export (`claudeAiOauth`), checked by
 * `credentials.js` (`INVALID_LOGIN` otherwise). Extra fields (Codex's
 * `id_token`, `last_refresh`) are dropped, so the stored value stays small.
 * @param {unknown} text
 * @param {'claude' | 'codex'} provider
 * @returns {string}
 */
export const credentialFromLoginFile = (text, provider) => {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > signInLimits.loginFileBytes
  )
    throw signInError('INVALID_LOGIN');
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw signInError('INVALID_LOGIN');
  }
  if (!isRecord(input)) throw signInError('INVALID_LOGIN');
  /** @type {Record<string, unknown>} */
  let reduced;
  if (provider === 'codex') {
    const { tokens } = input;
    if (input.OPENAI_API_KEY || !isRecord(tokens))
      throw signInError('INVALID_LOGIN');
    reduced = {
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: tokens.account_id,
      },
    };
  } else {
    const auth = isRecord(input.claudeAiOauth) ? input.claudeAiOauth : input;
    reduced = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
      scopes: auth.scopes,
    };
  }
  try {
    return formatCredential(parseCredential(JSON.stringify(reduced), provider));
  } catch {
    throw signInError('INVALID_LOGIN');
  }
};
harden(credentialFromLoginFile);
