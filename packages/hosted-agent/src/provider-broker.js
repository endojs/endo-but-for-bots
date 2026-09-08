// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * @typedef {{ method: string, path: string }} Route
 * @typedef {{ origin: string, routes: Route[], models: string[], expiresAt: number,
 * maxRequests: bigint, maxRequestBytes: bigint, maxResponseBytes: bigint,
 * maxTotalBytes: bigint, maxCostMicrounits: bigint,
 * maxCostMicrounitsPerRequest: bigint, credentialHeader?: 'bearer' | 'x-api-key',
 * anthropicVersion?: string, anthropicBeta?: string,
 * authMode?: 'api-key' | 'oauth', accountRef?: string,
 * refreshSkewMs?: number }} BrokerPolicy
 * @typedef {{ version: 'BrokerOAuthStateV1', accessToken: string,
 * refreshToken?: string, expiresAt: number, accountId: string }} BrokerOAuthState
 * @typedef {{next(): Promise<{done: boolean, value: string}>, return(): void}} ProviderReader
 * @typedef {{status: number, reader: ProviderReader}} ProviderStream
 * @typedef {{ url: string, method: string, headers: Record<string, string>,
 * body: string, redirect: 'error', maxResponseBytes: bigint }} UpstreamRequest
 */

/**
 * The one message a transport uses to report that the upstream rejected the
 * credential itself, rather than the request. It is a classification and
 * nothing more: no upstream body, headers, or authentication challenge crosses
 * this seam, because none of them is needed to decide whether one refresh is
 * worth one retry.
 *
 * A transport that does not classify simply never triggers the retry, which
 * degrades to the proactive expiry refresh below rather than to a failure.
 *
 * @param {unknown} error
 */
export const isCredentialRejection = error =>
  error instanceof Error && error.message === 'Provider credential rejected';
harden(isCredentialRejection);

/**
 * Validate an OAuth state document read from the secret manager.
 *
 * The document, not a bare bearer string, is what `authMode: 'oauth'` stores:
 * refreshing rotates every field at once, and a state that named a different
 * account after a rotation would silently move a session's billing, so the
 * account travels with the tokens and is checked against the lease's binding.
 *
 * @param {unknown} value
 * @returns {BrokerOAuthState}
 */
export const assertBrokerOAuthState = value => {
  (value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    /** @type {any} */ (value).version === 'BrokerOAuthStateV1') ||
    Fail`Invalid broker OAuth state`;
  const { accessToken, refreshToken, expiresAt, accountId } =
    /** @type {any} */ (value);
  // Header-safe by construction: a token carrying a control character or a
  // space could otherwise split or smuggle a request line upstream.
  (typeof accessToken === 'string' && /^[\x21-\x7e]+$/.test(accessToken)) ||
    Fail`Invalid broker OAuth state`;
  refreshToken === undefined ||
    (typeof refreshToken === 'string' && /^[\x21-\x7e]+$/.test(refreshToken)) ||
    Fail`Invalid broker OAuth state`;
  (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) ||
    Fail`Invalid broker OAuth state`;
  // ASCII, because the document round-trips through `btoa`/`atob`, which are
  // Latin-1. A wider account id would decode to mojibake and fail the binding
  // check for a reason no operator could read off the error.
  (typeof accountId === 'string' &&
    accountId.length > 0 &&
    accountId.length <= 256 &&
    /^[\x20-\x7e]+$/.test(accountId)) ||
    Fail`Invalid broker OAuth state`;
  return harden({
    version: /** @type {const} */ ('BrokerOAuthStateV1'),
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt,
    accountId,
  });
};
harden(assertBrokerOAuthState);

/**
 * The refreshing OAuth credential behind one secret record.
 *
 * Deliberately not per lease. The refresh token lives in the record, not in a
 * session, so a single-flight guard that lived on a lease would let two
 * concurrent sessions over the same account each redeem the same refresh
 * token — and a provider that invalidates a refresh token on use reads the
 * second redemption as a replay and revokes the whole grant, killing the
 * credential the first session just stored. One of these is made per record
 * and handed to every lease over it, so the guard is where the token is.
 *
 * @param {object} powers
 * @param {{ readBase64(): Promise<string> }} powers.secret - SecretBlob read facet
 * @param {{ refresh(request: {refreshToken: string, accountId: string}): Promise<unknown> }} powers.refresh
 * - Token exchange on the broker's own outbound authority, never a lease's.
 * @param {{ replaceBase64(base64: string): Promise<unknown> }} powers.rotate
 * - Rotate-only secret capability: `replaceBase64` and nothing else.
 * @param {string} powers.accountRef - The operator's selected account.
 * @param {() => number} powers.now - Trusted epoch-millisecond clock
 * @param {number} [powers.refreshSkewMs] - Refresh this long before expiry.
 */
export const makeBrokerOAuthCredential = ({
  secret,
  refresh,
  rotate,
  accountRef,
  now,
  refreshSkewMs = 60_000,
}) => {
  (secret && refresh && rotate && typeof now === 'function') ||
    Fail`Unprovisioned broker OAuth credential`;
  (typeof accountRef === 'string' &&
    accountRef.length > 0 &&
    accountRef.length <= 256) ||
    Fail`Invalid broker account binding`;
  (Number.isInteger(refreshSkewMs) &&
    refreshSkewMs >= 0 &&
    refreshSkewMs <= 0x7fff_ffff) ||
    Fail`Invalid broker refresh skew`;

  const read = async () => {
    const encoded = await E(secret).readBase64();
    typeof encoded === 'string' || Fail`Invalid credential`;
    let parsed;
    try {
      parsed = JSON.parse(globalThis.atob(encoded));
    } catch (_error) {
      Fail`Invalid credential`;
    }
    const state = assertBrokerOAuthState(parsed);
    state.accountId === accountRef || Fail`Broker account binding changed`;
    return state;
  };

  /**
   * Whether the stored credential is the one to replace: near enough to expiry,
   * or the exact token an upstream has just refused.
   *
   * @param {BrokerOAuthState} state
   * @param {string} [rejected]
   */
  const spent = (state, rejected) =>
    now() + refreshSkewMs >= state.expiresAt ||
    (rejected !== undefined && state.accessToken === rejected);

  /** @type {Promise<{state: BrokerOAuthState, exchanged: boolean}> | undefined} */
  let refreshing;
  /** @param {string} [rejected] */
  const exchange = rejected => {
    if (!refreshing) {
      refreshing = (async () => {
        await null;
        // Re-read inside the guard. A caller that lost the race to another
        // lease, or to an operator's re-grant, is holding a refresh token that
        // is already spent; exchanging it again is the replay this guard
        // exists to prevent. Whatever is in the record now wins.
        const state = await read();
        if (!spent(state, rejected)) return harden({ state, exchanged: false });
        const refreshToken =
          state.refreshToken ?? Fail`Broker credential expired`;
        const result = await E(refresh).refresh(
          harden({ refreshToken, accountId: state.accountId }),
        );
        (result && typeof result === 'object' && !Array.isArray(result)) ||
          Fail`Invalid broker OAuth state`;
        // A response that omits the refresh token means "keep the one you
        // have" (RFC 6749 section 6), which is how a non-rotating provider
        // answers. Persisting the response verbatim would drop it and strand
        // the record at its next expiry with nothing left to exchange.
        const next = assertBrokerOAuthState(
          harden({
            .../** @type {any} */ (result),
            refreshToken:
              /** @type {any} */ (result).refreshToken ?? refreshToken,
          }),
        );
        // A refreshed credential that names another account would move the
        // session's billing and quota to one the lease was never bound to.
        next.accountId === accountRef || Fail`Broker account binding changed`;
        // The refreshed credential must not itself be spent. An `expires_in`
        // duration mistaken for an instant, a badly skewed clock, or a token
        // lifetime shorter than the operator's skew all produce a state the
        // very next request would refresh again, indefinitely and silently.
        !spent(next) || Fail`Broker refresh did not advance expiry`;
        await E(rotate).replaceBase64(globalThis.btoa(JSON.stringify(next)));
        return harden({ state: next, exchanged: true });
      })().then(
        next => {
          refreshing = undefined;
          return next;
        },
        error => {
          refreshing = undefined;
          throw error;
        },
      );
    }
    return refreshing;
  };

  return harden({
    accountRef,
    /**
     * The credential to present now, refreshed if the stored one is spent.
     *
     * The read is per call by design: a credential rotated by this broker, by
     * a concurrent lease, or by an operator is picked up on the next request
     * with no re-delegation.
     *
     * @param {object} [options]
     * @param {string} [options.rejected] - An access token the upstream has
     * just refused, so a still-current-looking credential is replaced too.
     */
    current: async ({ rejected } = {}) => {
      const state = await read();
      if (!spent(state, rejected)) return harden({ state, exchanged: false });
      return exchange(rejected);
    },
  });
};
harden(makeBrokerOAuthCredential);

/**
 * A bounded inference capability, not an HTTP listener or sandbox attestation.
 * The trusted transport MUST enforce redirect:'error' before following any
 * redirect and maxResponseBytes while reading, and must not forward ambient
 * cookies or credentials. It alone receives the upstream credential.
 * The operator must supply a conservative upper cost bound for each request;
 * reservations are never refunded, including on failure. This is admission
 * accounting, not a claim about actual provider billing.
 * Revocation prevents new dispatch and delivery, but cannot undo a request
 * already dispatched. Production transports must separately support teardown.
 * Literal token echoes are rejected as defense in depth; the upstream remains
 * trusted not to encode or otherwise disclose its own authorization credential.
 *
 * With `authMode: 'oauth'` the secret holds a `BrokerOAuthStateV1` document
 * instead of a bare credential, and the broker — never the lease — refreshes
 * and rotates it. Refresh travels on `powers.refresh`, a separate outbound
 * authority, because the route allowlist below admits inference paths only and
 * a token endpoint is neither that origin nor those paths.
 *
 * @param {BrokerPolicy} policy
 * @param {object} powers
 * @param {{ readBase64(): Promise<string> }} powers.secret - SecretBlob read facet
 * @param {{ request(request: UpstreamRequest): Promise<{status: number, body: string}>, requestStream?(request: UpstreamRequest): Promise<ProviderStream> }} powers.transport
 * @param {() => number} powers.now - Trusted epoch-millisecond clock
 * @param {(event: {event: string, requests: bigint}) => void} [powers.audit]
 * @param {ReturnType<typeof makeBrokerOAuthCredential>} [powers.credential]
 * - The shared refreshing credential for this secret record, required by
 * `authMode: 'oauth'`. Shared rather than per lease so that concurrent
 * sessions cannot each redeem the same refresh token.
 */
export const makeProviderBrokerLease = (
  policy,
  { secret, transport, now, audit = () => {}, credential },
) => {
  // Copy and validate operator input so later mutation cannot widen authority.
  const {
    origin,
    expiresAt,
    maxRequests,
    maxRequestBytes,
    maxResponseBytes,
    maxTotalBytes,
    maxCostMicrounits,
    maxCostMicrounitsPerRequest,
  } = policy;
  const authMode = policy.authMode ?? 'api-key';
  // 'subscription' is deliberately absent. Neither vendor documents a
  // configuration in which the broker holds an individual subscription
  // credential and the slice does not: Codex's proxy mode
  // (`requires_openai_auth`) authenticates with the CLI's own `auth.json`, and
  // a Claude Code gateway credential replaces the claude.ai login rather than
  // carrying it. See packages/codex-sandbox/SUBSCRIPTION-AUTH.md.
  authMode === 'api-key' ||
    authMode === 'oauth' ||
    Fail`Unsupported broker authentication mode`;
  const credentialHeader = policy.credentialHeader ?? 'bearer';
  credentialHeader === 'bearer' ||
    credentialHeader === 'x-api-key' ||
    Fail`Unsupported credential header`;
  const { anthropicVersion, anthropicBeta } = policy;
  anthropicVersion === undefined ||
    /^\d{4}-\d{2}-\d{2}$/.test(anthropicVersion) ||
    Fail`Invalid Anthropic version`;
  // A comma-separated capability list, as the gateway contract describes it.
  // The operator supplies the values; the broker only proves they cannot carry
  // a header separator or a second header.
  anthropicBeta === undefined ||
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:,[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(
      anthropicBeta,
    ) ||
    Fail`Invalid Anthropic beta capabilities`;
  const { accountRef } = policy;
  accountRef === undefined ||
    (typeof accountRef === 'string' &&
      accountRef.length > 0 &&
      accountRef.length <= 256) ||
    Fail`Invalid broker account binding`;
  // Provisioning, not preference: an OAuth lease with no refreshing credential
  // is an API-key lease with a shorter life, and would fail its first turn
  // after expiry rather than at admission. Binding it here also makes its
  // presence the mode: everything below asks whether there is an `oauth`
  // record rather than re-reading a mode string.
  if (authMode === 'oauth') {
    credentialHeader === 'bearer' || Fail`Unprovisioned broker OAuth mode`;
    // The lease's account is the operator's selection; a credential for some
    // other account is a different session's, not this one's.
    (credential !== undefined && credential.accountRef === accountRef) ||
      Fail`Unprovisioned broker OAuth mode`;
  }
  const oauth =
    authMode === 'oauth'
      ? (credential ?? Fail`Unprovisioned broker OAuth mode`)
      : undefined;
  const parsedOrigin = new URL(origin);
  (parsedOrigin.protocol === 'https:' &&
    parsedOrigin.origin === origin &&
    !parsedOrigin.username &&
    !parsedOrigin.password) ||
    Fail`Invalid provider origin`;
  const routes = policy.routes.map(({ method, path }) => {
    // Exact paths only: no normalization, query, fragment, percent escaping,
    // alternate authority or dot segments can affect dispatch.
    (method === 'POST' &&
      ['/v1/responses', '/v1/messages', '/v1/chat/completions'].includes(
        path,
      ) &&
      /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) ||
      Fail`Invalid inference route`;
    return `${method} ${path}`;
  });
  routes.length > 0 || Fail`Inference routes required`;
  const models = [...policy.models];
  (models.length > 0 &&
    models.every(model => typeof model === 'string' && model.length > 0)) ||
    Fail`Models required`;
  Number.isFinite(expiresAt) || Fail`Invalid expiry`;
  for (const limit of [
    maxRequests,
    maxRequestBytes,
    maxResponseBytes,
    maxTotalBytes,
    maxCostMicrounits,
    maxCostMicrounitsPerRequest,
  ]) {
    (typeof limit === 'bigint' && limit > 0n) || Fail`Positive quota required`;
  }
  /** @type {Set<() => void>} */
  const streams = new Set();
  let revoked = false;
  let requests = 0n;
  let reservedBytes = 0n;
  let reservedCostMicrounits = 0n;
  const checkLive = () => {
    const time = now();
    (!revoked && Number.isFinite(time) && time < expiresAt) ||
      Fail`Broker lease inactive`;
  };
  /** @param {string} event */
  const record = event => {
    // Never pass errors, request data, headers, model names or credentials to
    // an audit hook. A failing sink must not expose its own exception either.
    try {
      audit(harden({ event, requests }));
    } catch (_error) {
      revoked = true;
    }
  };
  const endpoint = makeExo(
    'ProviderInferenceLease',
    M.interface('ProviderInferenceLease', {
      request: M.call(
        M.splitRecord({
          method: M.string(),
          path: M.string(),
          body: M.string(),
        }),
      ).returns(M.promise()),

      requestStream: M.call(
        M.splitRecord({
          method: M.string(),
          path: M.string(),
          body: M.string(),
        }),
      ).returns(M.promise()),
    }),
    {
      /** @param {{method: string, path: string, body: string}} request */
      async request(request) {
        return perform(request, false);
      },
      /** @param {{method: string, path: string, body: string}} request */
      async requestStream(request) {
        return perform(request, true);
      },
    },
  );

  /**
   * The credential for one dispatch, with everything that must never appear in
   * a response beside it.
   *
   * @typedef {{ credential: string, screens: string[] }} ResolvedCredential
   */

  /** @param {string} encoded */
  const decodeSecret = encoded => {
    typeof encoded === 'string' || Fail`Invalid credential`;
    return globalThis.atob(encoded);
  };

  /**
   * Everything the upstream could echo back that the lease must not deliver.
   * The base64 spellings are included because the broker itself is the only
   * place either form exists, so either form appearing downstream is a leak.
   *
   * @param {string[]} values
   */
  const screensFor = values =>
    harden(
      values
        .filter(value => value !== '')
        .flatMap(value => [value, globalThis.btoa(value)]),
    );

  /**
   * Read the secret and, in OAuth mode, make sure the credential it carries is
   * good for the request about to be dispatched.
   *
   * The read is per dispatch by design: a credential rotated by this broker, by
   * a concurrent lease, or by an operator is picked up on the next request
   * without re-delegation, and every length derived below is derived from that
   * read rather than cached across it.
   *
   * @param {string} [rejected] - An access token the upstream has just refused,
   * so a credential that still looks current is replaced too.
   * @returns {Promise<ResolvedCredential>}
   */
  const resolveCredential = async rejected => {
    if (!oauth) {
      const encoded = await E(secret).readBase64();
      const decoded = decodeSecret(encoded);
      /^[\x21-\x7e]+$/.test(decoded) || Fail`Invalid credential`;
      return harden({ credential: decoded, screens: [decoded, encoded] });
    }
    let resolved;
    try {
      resolved = await E(oauth).current(
        harden(rejected === undefined ? {} : { rejected }),
      );
    } catch (error) {
      record('refresh-failed');
      throw error;
    }
    if (resolved.exchanged) record('refreshed');
    const { state } = resolved;
    return harden({
      credential: state.accessToken,
      screens: screensFor([state.accessToken, state.refreshToken ?? '']),
    });
  };

  /**
   * @overload
   * @param {{method: string, path: string, body: string}} request
   * @param {false} streaming
   * @returns {Promise<{status: number, body: string}>}
   */
  /**
   * @overload
   * @param {{method: string, path: string, body: string}} request
   * @param {true} streaming
   * @returns {Promise<ProviderStream & {contentType: string}>}
   */
  /**
   * @param {{method: string, path: string, body: string}} request
   * @param {boolean} streaming
   */
  const perform = async ({ method, path, body }, streaming) => {
    checkLive();
    routes.includes(`${method} ${path}`) || Fail`Inference route denied`;
    let requestBytes = BigInt(new TextEncoder().encode(body).length);
    requestBytes <= maxRequestBytes || Fail`Request byte quota exceeded`;
    let data;
    try {
      data = JSON.parse(body);
    } catch (_error) {
      Fail`Invalid inference JSON`;
    }
    (data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      typeof data.model === 'string' &&
      models.includes(data.model)) ||
      Fail`Model denied`;
    const canonicalBody = JSON.stringify(data);
    const canonicalBytes = BigInt(
      new TextEncoder().encode(canonicalBody).length,
    );
    canonicalBytes <= maxRequestBytes || Fail`Request byte quota exceeded`;
    if (canonicalBytes > requestBytes) requestBytes = canonicalBytes;
    const reservation = requestBytes + maxResponseBytes;
    (requests < maxRequests &&
      reservedBytes + reservation <= maxTotalBytes &&
      reservedCostMicrounits + maxCostMicrounitsPerRequest <=
        maxCostMicrounits) ||
      Fail`Broker quota exhausted`;
    // Reserve synchronously, before retrieving the secret: concurrent calls
    // cannot each spend the same remaining quota.
    requests += 1n;
    reservedBytes += reservation;
    reservedCostMicrounits += maxCostMicrounitsPerRequest;
    record('admitted');
    /**
     * Every credential this request has handed the upstream, in every form it
     * could come back as. It accumulates across a refreshed retry rather than
     * being replaced: the first attempt's token reached the upstream, so a
     * response screened only against the second one could deliver the first
     * back to the slice — and after a 403 that first token is often still live.
     *
     * @type {string[]}
     */
    const exposed = [];
    /**
     * One attempt at the upstream, with one resolved credential. A refreshed
     * retry re-enters here, so every length below is derived from the
     * credentials actually sent rather than cached across the request.
     *
     * @param {ResolvedCredential} resolved
     */
    const dispatch = async ({ credential: token, screens }) => {
      await null;
      checkLive();
      for (const screen of screens) {
        if (!exposed.includes(screen)) exposed.push(screen);
      }
      const upstream = harden({
        url: `${origin}${path}`,
        method,
        headers: {
          ...(credentialHeader === 'bearer'
            ? { authorization: `Bearer ${token}` }
            : { 'x-api-key': token }),
          ...(anthropicVersion === undefined
            ? {}
            : { 'anthropic-version': anthropicVersion }),
          ...(anthropicBeta === undefined
            ? {}
            : { 'anthropic-beta': anthropicBeta }),
          'content-type': 'application/json',
        },
        body: canonicalBody,
        redirect: /** @type {const} */ ('error'),
        maxResponseBytes,
      });
      /** @param {string} text */
      const echoes = text => exposed.some(screen => text.includes(screen));
      if (streaming) {
        const response = await E(transport).requestStream(upstream);
        const cancel = () => {
          // Release ownership before the eventual send, including if it fails.
          if (!streams.delete(cancel)) return;
          void E(response.reader)
            .return()
            .catch(() => {});
        };
        streams.add(cancel);
        let held = '';
        let bytes = 0n;
        let reading = false;
        let ended = false;
        const keep =
          exposed.reduce((longest, screen) => {
            return screen.length > longest ? screen.length : longest;
          }, 0) - 1;
        const stream = makeExo(
          'BrokerResponseReader',
          M.interface('BrokerResponseReader', {
            next: M.call().returns(M.promise()),
            return: M.call().returns(M.undefined()),
          }),
          {
            async next() {
              !reading || Fail`Concurrent provider read`;
              reading = true;
              try {
                checkLive();
                if (ended) return harden({ done: true, value: '' });
                for (;;) {
                  // eslint-disable-next-line no-await-in-loop
                  const chunk = await E(response.reader).next();
                  checkLive();
                  !ended || Fail`Provider stream cancelled`;
                  typeof chunk.value === 'string' ||
                    Fail`Invalid provider chunk`;
                  bytes += BigInt(new TextEncoder().encode(chunk.value).length);
                  bytes <= maxResponseBytes ||
                    Fail`Response byte quota exceeded`;
                  held += chunk.value;
                  !echoes(held) || Fail`Invalid provider response`;
                  if (chunk.done) {
                    ended = true;
                    streams.delete(cancel);
                    record('completed');
                    checkLive();
                    const value = held;
                    held = '';
                    return harden({ done: value.length === 0, value });
                  }
                  // Keep the longest possible secret prefix private until
                  // enough following characters have been checked.
                  if (held.length > keep) {
                    let cut = held.length - keep;
                    // Do not split a surrogate pair into separate UTF-8 writes.
                    if (cut > 0 && /[\uD800-\uDBFF]/.test(held[cut - 1]))
                      cut -= 1;
                    if (cut > 0) {
                      const value = held.slice(0, cut);
                      held = held.slice(cut);
                      return harden({ done: false, value });
                    }
                  }
                }
              } catch (_error) {
                ended = true;
                held = '';
                cancel();
                record('failed');
                return Fail`Provider request failed`;
              } finally {
                reading = false;
              }
            },
            return() {
              ended = true;
              held = '';
              cancel();
            },
          },
        );
        try {
          checkLive();
          (Number.isInteger(response.status) &&
            response.status >= 200 &&
            response.status < 300) ||
            Fail`Invalid provider response`;
          return harden({
            status: response.status,
            reader: stream,
            contentType:
              data.stream === true ? 'text/event-stream' : 'application/json',
          });
        } catch (_error) {
          cancel();
          throw _error;
        }
      }
      const response = await E(transport).request(upstream);
      checkLive();
      (Number.isInteger(response.status) &&
        response.status >= 200 &&
        response.status < 300 &&
        typeof response.body === 'string' &&
        BigInt(new TextEncoder().encode(response.body).length) <=
          maxResponseBytes &&
        !echoes(response.body)) ||
        Fail`Invalid provider response`;
      record('completed');
      checkLive();
      // No upstream headers (including cookies or authentication challenges)
      // escape through the lease. Upstream error bodies are never returned.
      return harden({ status: response.status, body: response.body });
    };
    try {
      checkLive();
      const first = await resolveCredential();
      try {
        return await dispatch(first);
      } catch (error) {
        // One retry, and only for the one failure a refresh can fix. A turn
        // whose token was revoked or rotated elsewhere mid-session recovers
        // here; every other failure propagates as it happened. Nothing was
        // delivered to the caller yet: an upstream that rejects the credential
        // does so before the first response byte.
        if (!oauth || !isCredentialRejection(error)) throw error;
        record('credential-rejected');
        // Naming the refused token is what lets the shared credential tell
        // "replace this one" from "another lease already replaced it": it
        // exchanges only if the record still holds the token that just failed.
        return await dispatch(await resolveCredential(first.credential));
      }
    } catch (_error) {
      record('failed');
      return Fail`Provider request failed`;
    }
  };
  const admin = makeExo(
    'ProviderInferenceLeaseAdmin',
    M.interface('ProviderInferenceLeaseAdmin', {
      revoke: M.call().returns(M.undefined()),
      getStatus: M.call().returns(M.record()),
    }),
    {
      revoke() {
        revoked = true;
        for (const cancel of streams) cancel();
        record('revoked');
      },
      getStatus() {
        return harden({
          revoked,
          requests,
          reservedBytes,
          reservedCostMicrounits,
          expiresAt,
          authMode,
        });
      },
    },
  );
  return harden({ endpoint, admin });
};
harden(makeProviderBrokerLease);
