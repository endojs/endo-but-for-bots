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
  (typeof accountId === 'string' &&
    accountId.length > 0 &&
    accountId.length <= 256) ||
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
 * @param {{ refresh(request: {refreshToken: string, accountId: string}): Promise<unknown> }} [powers.refresh]
 * - Token exchange on the broker's own outbound authority, never the lease's.
 * @param {{ replaceBase64(base64: string): Promise<unknown> }} [powers.rotate]
 * - Rotate-only secret capability: `replaceBase64` and nothing else.
 */
export const makeProviderBrokerLease = (
  policy,
  { secret, transport, now, audit = () => {}, refresh, rotate },
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
  const refreshSkewMs = policy.refreshSkewMs ?? 60_000;
  (Number.isInteger(refreshSkewMs) &&
    refreshSkewMs >= 0 &&
    refreshSkewMs <= 0x7fff_ffff) ||
    Fail`Invalid broker refresh skew`;
  // Provisioning, not preference: an OAuth lease that cannot refresh and cannot
  // write back is an API-key lease with a shorter life, and would fail its
  // first turn after expiry rather than at admission. Assembling the OAuth half
  // once, here, also makes its presence the mode: everything below asks whether
  // there is an `oauth` record rather than re-reading a mode string.
  if (authMode === 'oauth') {
    credentialHeader === 'bearer' || Fail`Unprovisioned broker OAuth mode`;
  }
  const oauth =
    authMode === 'oauth'
      ? harden({
          accountRef: accountRef ?? Fail`Unprovisioned broker OAuth mode`,
          refresh: refresh ?? Fail`Unprovisioned broker OAuth mode`,
          rotate: rotate ?? Fail`Unprovisioned broker OAuth mode`,
        })
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

  /** @type {Promise<BrokerOAuthState> | undefined} */
  let refreshing;
  /**
   * Exchange the refresh token for new OAuth state, write it back through the
   * rotate-only capability, and hand the result to every caller that arrived
   * while the exchange was in flight.
   *
   * Single-flight matters twice over: a provider that invalidates the old
   * refresh token on use turns a concurrent second exchange into a revoked
   * session, and the write-back would otherwise race itself.
   *
   * @param {BrokerOAuthState} stale
   * @param {NonNullable<typeof oauth>} powers
   */
  const exchange = (stale, powers) => {
    if (!refreshing) {
      refreshing = (async () => {
        await null;
        const refreshToken =
          stale.refreshToken ?? Fail`Broker credential expired`;
        const next = assertBrokerOAuthState(
          await E(powers.refresh).refresh(
            harden({ refreshToken, accountId: stale.accountId }),
          ),
        );
        // A refresh that comes back naming another account would move the
        // session's billing and quota to an account the lease was never bound
        // to. The lease's account is the one the operator selected.
        next.accountId === powers.accountRef ||
          Fail`Broker account binding changed`;
        await E(powers.rotate).replaceBase64(
          globalThis.btoa(JSON.stringify(next)),
        );
        return next;
      })().then(
        next => {
          refreshing = undefined;
          record('refreshed');
          return next;
        },
        error => {
          refreshing = undefined;
          record('refresh-failed');
          throw error;
        },
      );
    }
    return refreshing;
  };

  /**
   * Read the secret and, in OAuth mode, make sure the credential it carries is
   * good for the request about to be dispatched.
   *
   * The read is per dispatch by design: a credential rotated by this broker, by
   * a concurrent lease, or by an operator is picked up on the next request
   * without re-delegation, and every length derived below is derived from that
   * read rather than cached across it.
   *
   * @param {boolean} force - Refresh even when the credential looks current,
   * because the upstream has just rejected it.
   * @returns {Promise<ResolvedCredential>}
   */
  const resolveCredential = async force => {
    const encoded = await E(secret).readBase64();
    const decoded = decodeSecret(encoded);
    if (!oauth) {
      /^[\x21-\x7e]+$/.test(decoded) || Fail`Invalid credential`;
      return harden({ credential: decoded, screens: [decoded, encoded] });
    }
    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (_error) {
      Fail`Invalid credential`;
    }
    let state = assertBrokerOAuthState(parsed);
    state.accountId === oauth.accountRef ||
      Fail`Broker account binding changed`;
    if (force || now() + refreshSkewMs >= state.expiresAt) {
      state = await exchange(state, oauth);
    }
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
     * One attempt at the upstream, with one resolved credential. A refreshed
     * retry re-enters here, so every length and every echo screen below is
     * derived from the credential actually being sent.
     *
     * @param {ResolvedCredential} resolved
     */
    const dispatch = async ({ credential, screens }) => {
      await null;
      checkLive();
      const upstream = harden({
        url: `${origin}${path}`,
        method,
        headers: {
          ...(credentialHeader === 'bearer'
            ? { authorization: `Bearer ${credential}` }
            : { 'x-api-key': credential }),
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
      const echoes = text => screens.some(screen => text.includes(screen));
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
          screens.reduce((longest, screen) => {
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
      try {
        return await dispatch(await resolveCredential(false));
      } catch (error) {
        // One retry, and only for the one failure a refresh can fix. A turn
        // whose token was revoked or rotated elsewhere mid-session recovers
        // here; every other failure propagates as it happened. Nothing was
        // delivered to the caller yet: an upstream that rejects the credential
        // does so before the first response byte.
        if (!oauth || !isCredentialRejection(error)) throw error;
        record('credential-rejected');
        return await dispatch(await resolveCredential(true));
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
