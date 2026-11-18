// @ts-check
/**
 * Credential renewal of one pool member (M4 W4.4; `designs/m4-interfaces.md`
 * 7 and 10; R7-16, R7-29, R7-30; D-M4-8). Port of hosted-agent
 * `provider-broker.js` `makeBrokerOAuthCredential` (1315bef86) onto the
 * harness's Secrets store, with the claude-sandbox and codex-sandbox
 * refresh requests.
 *
 * One `MemberCredential` per member and adapter incarnation. It holds the
 * accessor of one store key (`credentialFor(key)`, W-5) and nothing else.
 *
 * - `current()` reads the credential every call (audited; an operator's
 *   replace takes effect at the next round) and renews when the access
 *   token is within `refreshSkewMs` of expiry.
 * - `renewAfterRejection(rejected)` renews after a 401 for that exact
 *   access token (R4-25's one credential-refresh retry).
 *
 * The exchange is single-flight per member and **write-ahead**, so a
 * refresh token is never presented twice:
 *
 * 1. re-read inside the flight: a credential renewed by another flight or
 *    replaced by the operator wins;
 * 2. a credential already carrying `pendingRefresh` fails closed with
 *    `CONSUMED`: its refresh token reached a token endpoint and nothing
 *    recorded the answer; only a new sign-in clears it;
 * 3. write the same credential plus `pendingRefresh: { startedAtMs }`,
 *    conditioned on the generation read (a lost race: `GENERATION_CONFLICT`,
 *    re-read, adopt the winner's credential when it is usable);
 * 4. POST the refresh-token grant (redirects refused, bounded answer);
 * 5. write the answer conditioned on the intent's generation; a missing
 *    refresh token keeps the old one (RFC 6749 section 6); an answer naming
 *    another account is refused (`INVALID`). After the POST no refresh
 *    token the answer carries is dropped: an answer that fails a later check
 *    (token type, lifetime, an `exp` in the past) still has its refresh
 *    token written back, with the access token marked spent, before the
 *    round fails; a lifetime within `refreshSkewMs` is written and served.
 *
 * A failure the request provably never left (connection refused, name not
 * resolved) undoes the intent by restoring the exact value it replaced at
 * the intent's generation; any other failure leaves the intent, so the next
 * read fails `CONSUMED` (fail closed). Nothing is retried automatically
 * after an uncertain POST.
 *
 * The provider's token endpoint and OAuth client id are options
 * (`tokenUrl`, `clientId`): this module names no provider host. A member
 * with no `tokenUrl` cannot renew (`RENEWAL_FAILED`, before any write).
 *
 * Errors carry a fixed text and a code (`subscriptionCodes`); no token, header value
 * or provider body is ever put in an error or logged.
 *
 * Node only (adapter).
 */
import { providerBaseUrl } from '../providers/http.js';
import {
  credentialError,
  formatCredential,
  jwtClaims,
  codexAccountOf,
  parseCredential,
  assertToken,
  assertScopes,
} from './credentials.js';

/** @import { StoredCredential } from './credentials.js' */

/** Refresh answers are small JSON; anything larger is refused. */
const ANSWER_BYTES = 64 * 1024;
/** A token lifetime the answer may state (reference: > 60 s, <= 366 days). */
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 366 * 86_400;
/** Error codes of a fetch that provably never sent its request. */
const UNDISPATCHED = harden(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * The renewal settings (`config/subscription-defaults.js` `subscriptionDefaults`,
 * W4.1: `refreshSkewMs` 120,000).
 * @typedef {object} RenewalSettings
 * @property {number} [refreshSkewMs]
 * @property {number} [renewalTimeoutMs] the token request (default 15 s, as
 *   the reference)
 */

/** @param {unknown} error */
const codeOf = error => {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : undefined;
};

/**
 * Whether a fetch failure provably happened before the request left: the
 * connection was refused or the name did not resolve.
 * @param {unknown} error
 */
const isUndispatched = error => {
  /** @type {any} */
  let cause = error;
  for (let depth = 0; depth < 4 && cause; depth += 1) {
    if (UNDISPATCHED.includes(cause.code)) return true;
    cause = cause.cause;
  }
  return false;
};

/**
 * Read a JSON answer of at most `ANSWER_BYTES`, or throw.
 * @param {Response} response
 */
const boundedJson = async response => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ANSWER_BYTES)
    throw Error('answer too large');
  const reader = response.body?.getReader();
  if (reader === undefined) throw Error('no answer');
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ANSWER_BYTES) throw Error('answer too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
};

/**
 * @param {object} options
 * @param {import('./types.js').CredentialAccess} options.access the one
 *   key's accessor (`credentialFor(key)`)
 * @param {import('./types.js').Provider} options.provider
 * @param {string} [options.tokenUrl] the provider's token endpoint (tests:
 *   the fake OAuth server's)
 * @param {string} [options.clientId] the provider's public OAuth client id
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} options.now
 * @param {RenewalSettings} [options.settings]
 * @returns {import('./types.js').MemberCredential & { stats: () => Record<string, number> }}
 */
export const makeMemberCredential = ({
  access,
  provider,
  tokenUrl,
  clientId,
  fetch = globalThis.fetch,
  now,
  settings = {},
}) => {
  const { refreshSkewMs = 120_000, renewalTimeoutMs = 15_000 } = settings;
  const counters = {
    reads: 0,
    flights: 0,
    posts: 0,
    adopted: 0,
    undone: 0,
    kept: 0,
  };

  /** @returns {Promise<{ credential: StoredCredential, generation: number, value: string }>} */
  const read = async () => {
    counters.reads += 1;
    /** @type {{ value: string, generation: number }} */
    let stored;
    try {
      stored = await access.read();
    } catch (error) {
      throw credentialError(codeOf(error) ?? 'READ_FAILED');
    }
    const credential = parseCredential(stored.value, provider);
    return { credential, generation: stored.generation, value: stored.value };
  };

  /**
   * Whether this credential must be replaced: near expiry, or the exact
   * access token a provider has just refused.
   * @param {StoredCredential} credential
   * @param {string} [rejected]
   */
  const spent = (credential, rejected) =>
    now() + refreshSkewMs >= credential.expiresAtMs ||
    (rejected !== undefined && credential.accessToken === rejected);

  /**
   * After a conditioned write lost to another writer: adopt what is stored
   * now when it is usable (newer, not mid-renewal, not spent).
   * @param {number} lostAt the generation the write was pinned to
   * @param {string} [rejected]
   * @param {string} [failCode]
   */
  const adoptAfterConflict = async (
    lostAt,
    rejected,
    failCode = 'GENERATION_CONFLICT',
  ) => {
    const now2 = await read();
    if (
      now2.generation !== lostAt &&
      now2.credential.pendingRefresh === undefined &&
      !spent(now2.credential, rejected)
    ) {
      counters.adopted += 1;
      return { credential: now2.credential, generation: now2.generation };
    }
    throw credentialError(failCode);
  };

  /**
   * POST the refresh-token grant; the answer as JSON, or throw with
   * `undispatched` set when the request provably never left.
   * @param {StoredCredential} credential
   * @param {string} refreshToken
   */
  const post = async (credential, refreshToken) => {
    /** @type {string} */
    let url;
    try {
      // INT-M4: the M2 review's base URL rule (https, or http to loopback)
      // holds for the token endpoint too; a refused URL is never posted to.
      url = providerBaseUrl(tokenUrl, '');
    } catch {
      throw Object.assign(credentialError('RENEWAL_FAILED'), {
        undispatched: true,
      });
    }
    counters.posts += 1;
    /** @type {Response} */
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...(clientId === undefined ? {} : { client_id: clientId }),
          ...(provider === 'claude' && credential.scopes !== undefined
            ? { scope: credential.scopes.join(' ') }
            : {}),
        }),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(renewalTimeoutMs),
      });
    } catch (error) {
      throw Object.assign(credentialError('RENEWAL_FAILED'), {
        undispatched: isUndispatched(error),
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // A refusal (4xx) spent nothing we can trust to be unspent: the
      // intent stays; the code says the provider refused.
      throw credentialError(
        response.status < 500 ? 'REJECTED' : 'RENEWAL_FAILED',
      );
    }
    try {
      return await boundedJson(response);
    } catch {
      throw credentialError('RENEWAL_FAILED');
    }
  };

  /**
   * The renewed credential from a token answer (claude-sandbox and
   * codex-sandbox `make*SubscriptionRefresh`).
   * @param {StoredCredential} credential
   * @param {string} refreshToken
   * @param {any} answer
   * @returns {StoredCredential}
   */
  const renewedFrom = (credential, refreshToken, answer) => {
    if (typeof answer !== 'object' || answer === null)
      throw credentialError('RENEWAL_FAILED');
    if (
      answer.token_type !== undefined &&
      !(
        typeof answer.token_type === 'string' &&
        answer.token_type.toLowerCase() === 'bearer'
      )
    )
      throw credentialError('INVALID');
    const accessToken = assertToken(answer.access_token);
    const claims = jwtClaims(accessToken);
    let expiresAtMs;
    const lifetime = answer.expires_in;
    if (lifetime !== undefined) {
      if (
        typeof lifetime !== 'number' ||
        !Number.isFinite(lifetime) ||
        lifetime <= MIN_LIFETIME_S ||
        lifetime > MAX_LIFETIME_S
      )
        throw credentialError('INVALID');
      expiresAtMs = now() + lifetime * 1000;
    } else if (claims !== undefined && Number.isFinite(claims.exp)) {
      expiresAtMs = claims.exp * 1000;
    } else {
      throw credentialError('INVALID');
    }
    // The account the answer names: Codex in its token's claims, either
    // provider as `account_id` or `account.uuid` in the answer itself.
    const named =
      (provider === 'codex' && claims !== undefined
        ? codexAccountOf(claims)
        : undefined) ??
      (typeof answer.account_id === 'string' ? answer.account_id : undefined) ??
      (typeof answer.account?.uuid === 'string'
        ? answer.account.uuid
        : undefined);
    if (
      credential.accountId !== undefined &&
      named !== undefined &&
      named !== credential.accountId
    )
      throw credentialError('INVALID');
    const accountId = credential.accountId ?? named;
    let { scopes } = credential;
    if (provider === 'claude' && typeof answer.scope === 'string')
      scopes = assertScopes(answer.scope.split(/ +/), true);
    return harden({
      provider,
      accessToken,
      refreshToken:
        answer.refresh_token === undefined
          ? refreshToken
          : assertToken(answer.refresh_token),
      expiresAtMs,
      ...(accountId === undefined ? {} : { accountId }),
      ...(scopes === undefined ? {} : { scopes }),
    });
  };

  /**
   * What survives an answer `renewedFrom` refused, after the POST: the old
   * credential with the answer's refresh token (or the old one when the
   * answer names none, RFC 6749 6), its access token marked spent so the
   * next round renews. Nothing survives an answer that is not an object,
   * carries an unusable refresh token, or names another account (that
   * token is not this member's: fail closed).
   * @param {StoredCredential} credential
   * @param {string} refreshToken
   * @param {any} answer
   * @returns {StoredCredential | undefined}
   */
  const salvaged = (credential, refreshToken, answer) => {
    if (typeof answer !== 'object' || answer === null) return undefined;
    let kept = refreshToken;
    if (answer.refresh_token !== undefined) {
      try {
        kept = assertToken(answer.refresh_token);
      } catch {
        return undefined;
      }
    }
    if (credential.accountId !== undefined) {
      const named =
        typeof answer.account_id === 'string'
          ? answer.account_id
          : typeof answer.account?.uuid === 'string'
            ? answer.account.uuid
            : undefined;
      if (named !== undefined && named !== credential.accountId)
        return undefined;
      if (provider === 'codex' && typeof answer.access_token === 'string') {
        const claims = jwtClaims(answer.access_token);
        const bound = claims === undefined ? undefined : codexAccountOf(claims);
        if (bound !== undefined && bound !== credential.accountId)
          return undefined;
      }
    }
    const { pendingRefresh: _intent, ...rest } = credential;
    return harden({
      ...rest,
      refreshToken: kept,
      expiresAtMs: Math.min(credential.expiresAtMs, now()),
    });
  };

  /**
   * Write a credential over the intent; a failure leaves the intent (the
   * next read fails `CONSUMED`), a conflict means a newer writer won.
   * @param {StoredCredential} credential
   * @param {number} intentGeneration
   */
  const keep = async (credential, intentGeneration) => {
    try {
      await access.replace(formatCredential(credential), intentGeneration);
      counters.kept += 1;
    } catch {
      // Fail closed: the intent stays.
    }
  };

  /**
   * One exchange (single-flight per member).
   * @param {string} [rejected]
   * @returns {Promise<{ credential: StoredCredential, generation: number }>}
   */
  const exchange = async rejected => {
    counters.flights += 1;
    const { credential, generation, value } = await read();
    if (!spent(credential, rejected)) return { credential, generation };
    if (credential.pendingRefresh !== undefined)
      throw credentialError('CONSUMED');
    const { refreshToken } = credential;
    if (refreshToken === undefined) {
      // No renewal authority: a still-valid token is served to its end.
      if (rejected === undefined && now() < credential.expiresAtMs)
        return { credential, generation };
      throw credentialError(rejected === undefined ? 'EXPIRED' : 'REJECTED');
    }
    if (tokenUrl === undefined) throw credentialError('RENEWAL_FAILED');

    // Write-ahead (D-M4-8): from here a token may be spent with nothing
    // recording it, so the record says so first.
    const startedAtMs = now();
    /** @type {number} */
    let intentGeneration;
    try {
      intentGeneration = await access.replace(
        formatCredential({ ...credential, pendingRefresh: { startedAtMs } }),
        generation,
      );
    } catch (error) {
      const code = codeOf(error);
      if (code === 'GENERATION_CONFLICT')
        return adoptAfterConflict(generation, rejected);
      throw credentialError(code ?? 'RENEWAL_FAILED');
    }

    /** @type {any} */
    let answer;
    try {
      answer = await post(credential, refreshToken);
    } catch (error) {
      if (/** @type {any} */ (error).undispatched === true) {
        // Provably never sent: restore exactly what the intent replaced,
        // pinned to the intent's own generation (never by its bytes).
        await access.replace(value, intentGeneration).then(
          () => {
            counters.undone += 1;
          },
          () => {},
        );
      }
      throw error;
    }

    // From here the old refresh token is spent at the provider, so a
    // refresh token the answer carries must not be dropped (M4-FIX).
    /** @type {StoredCredential} */
    let next;
    try {
      next = renewedFrom(credential, refreshToken, answer);
    } catch (error) {
      const kept = salvaged(credential, refreshToken, answer);
      if (kept !== undefined) await keep(kept, intentGeneration);
      throw error;
    }
    if (now() >= next.expiresAtMs) {
      // Already expired (a `exp` claim in the past): keep the rotated
      // refresh token for the next round, serve nothing now.
      await keep(next, intentGeneration);
      throw credentialError('RENEWAL_FAILED');
    }
    // A lifetime within `refreshSkewMs` (61-120 s with the defaults) is
    // written back and served; the next round renews again.
    try {
      const nextGeneration = await access.replace(
        formatCredential(next),
        intentGeneration,
      );
      return { credential: next, generation: nextGeneration };
    } catch (error) {
      // Only a conflict means another writer stored something newer (an
      // operator's sign-in); anything else leaves the intent, which refuses
      // the next exchange.
      if (codeOf(error) === 'GENERATION_CONFLICT')
        return adoptAfterConflict(intentGeneration, rejected, 'RENEWAL_FAILED');
      throw credentialError('RENEWAL_FAILED');
    }
  };

  /** @type {Promise<{ credential: StoredCredential, generation: number }> | undefined} */
  let flight;
  /** @param {string} [rejected] */
  const renew = rejected => {
    if (flight !== undefined) return flight;
    const started = exchange(rejected).finally(() => {
      flight = undefined;
    });
    flight = started;
    return started;
  };

  return harden({
    current: async () => {
      const { credential, generation } = await read();
      if (!spent(credential)) return harden({ credential, generation });
      const renewed = await renew();
      return harden(renewed);
    },
    /** @param {import('./types.js').Credential} rejected */
    renewAfterRejection: async rejected => {
      const { credential } = await renew(rejected.accessToken);
      return credential;
    },
    stats: () => harden({ ...counters }),
  });
};
harden(makeMemberCredential);
