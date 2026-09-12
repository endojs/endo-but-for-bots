// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { INFERENCE_PATHS } from './provider-paths.js';
import { makeSecretRotator } from './secret-rotator.js';

/**
 * @typedef {{ method: string, path: string }} Route
 * @typedef {{ origin: string, routes: Route[], models: string[], expiresAt: number,
 * clientAuthorization?: 'reject' | 'strip',
 * maxRequests: bigint, maxRequestBytes: bigint, maxResponseBytes: bigint,
 * maxTotalBytes: bigint, maxCostMicrounits: bigint,
 * maxCostMicrounitsPerRequest: bigint, credentialHeader?: 'bearer' | 'x-api-key',
 * anthropicVersion?: string, anthropicBeta?: string,
 * authMode?: 'api-key' | 'oauth' | 'subscription', accountRef?: string }} BrokerPolicy
 * @typedef {{ startedAt: number }} BrokerRefreshIntent
 * @typedef {{ version: 'BrokerOAuthStateV1', accessToken: string,
 * refreshToken?: string, expiresAt: number, accountId: string,
 * pendingRefresh?: BrokerRefreshIntent }} BrokerOAuthState
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
 * Whether a rotation was refused because the record moved under it, as opposed
 * to failing outright.
 *
 * The distinction is load-bearing and cannot be re-derived by looking at the
 * record afterwards: a conflict means another writer stored something newer and
 * this exchange's result is safely discarded, while any other failure means
 * nothing stored anything and a refresh token has been burned for nothing. The
 * secret manager reports the two differently; collapsing them and inferring
 * from a later read gets the second case wrong.
 *
 * The code is `@endo/daemon`'s, matched on rather than imported because this
 * package deliberately does not depend on the daemon.
 *
 * @param {unknown} error
 */
export const isGenerationConflict = error =>
  error instanceof Error && error.message.includes('GENERATION_CONFLICT');
harden(isGenerationConflict);

/**
 * Whether a refresh authority is asserting that its request never reached the
 * provider, so the refresh token it was given is certainly still unspent.
 *
 * The default assumption is the opposite. A token endpoint that rejects after
 * the request left — a lost response, a timeout, a proxy error — may well have
 * consumed the token, and a broker that assumed otherwise would present it
 * again. Only an authority that can actually distinguish a pre-dispatch
 * failure, such as a DNS or connect error, is in a position to say so, and it
 * says so with this message.
 *
 * @param {unknown} error
 */
export const isUndispatchedRefresh = error =>
  error instanceof Error && error.message === 'Refresh not dispatched';
harden(isUndispatchedRefresh);

/**
 * Validate an OAuth state document read from the secret manager.
 *
 * The document, not a bare bearer string, is what `authMode: 'oauth'` stores:
 * refreshing rotates every field at once, and a state that named a different
 * account after a rotation would silently move a session's billing, so the
 * account travels with the tokens and is checked against the lease's binding.
 *
 * `pendingRefresh` is the write-ahead intent: present, it says this record's
 * refresh token was handed to a token endpoint and nothing recorded the
 * outcome. It is part of the stored document rather than a record of its own
 * because it must be set and cleared atomically with the tokens it describes,
 * and one record has one generation to pin those writes to.
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
  const { accessToken, refreshToken, expiresAt, accountId, pendingRefresh } =
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
  // Validated rather than tolerated: an unreadable intent is the one field
  // whose meaning is "refuse to exchange", so a shape this code cannot
  // interpret must fail the document rather than be dropped on the way to the
  // check that reads it.
  pendingRefresh === undefined ||
    (pendingRefresh !== null &&
      typeof pendingRefresh === 'object' &&
      !Array.isArray(pendingRefresh) &&
      typeof pendingRefresh.startedAt === 'number' &&
      Number.isFinite(pendingRefresh.startedAt)) ||
    Fail`Invalid broker OAuth state`;
  return harden({
    version: /** @type {const} */ ('BrokerOAuthStateV1'),
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt,
    accountId,
    ...(pendingRefresh === undefined
      ? {}
      : { pendingRefresh: { startedAt: pendingRefresh.startedAt } }),
  });
};
harden(assertBrokerOAuthState);

/**
 * The refreshing OAuth credential behind one secret record.
 *
 * **Exactly one of these must exist per secret record.** The refresh token
 * lives in the record, not in a session, so the single-flight guard below only
 * excludes what shares this object: two of them over one record each redeem the
 * same refresh token, and a provider that invalidates a refresh token on use
 * reads the second redemption as a replay and revokes the whole grant. It is
 * built here, by whoever composes the deployment, rather than inside a lease or
 * a lease issuer, so that sharing it across every lease and every issuer over
 * that record is a visible act rather than an accident of construction.
 *
 * Ownership cannot be enforced from inside this module — a second daemon over
 * the same record is outside its reach — so every write is additionally pinned
 * to a generation. That turns a lost race into a refused write rather than a
 * silent overwrite, which is what makes the invariant recoverable when it is
 * violated rather than merely stated.
 *
 * Every exchange is write-ahead: the record is marked with a pending-refresh
 * intent, conditionally, *before* the refresh token is presented, and the
 * result is committed against the generation that mark produced. So a refresh
 * whose outcome was never recorded — a crash, a lost response, a write that
 * failed — leaves the record saying so, and the next holder over that record
 * refuses to exchange rather than presenting a token that may already be
 * spent. The refusal is in the record rather than in the process that lost the
 * exchange, which is the whole point: an in-memory fence is cleared by exactly
 * the restart that a stuck refresh tends to provoke. How durable that is, is
 * the secret manager's property and not this module's claim; what is
 * demonstrated here is that a credential rebuilt over the same record refuses.
 *
 * The mark refuses *exchanging*, not *using*. A still-valid access token goes
 * on serving every concurrent turn over the record, because otherwise one
 * holder's refresh would be an outage for every session sharing it.
 *
 * `rotate` is attenuated here rather than by the caller, so the narrow
 * capability is produced where it is used and a full `SecretAdmin` handed in
 * still cannot reach the exchange below with `revoke`, `delete` and
 * `setDescription` intact.
 *
 * @param {object} powers
 * @param {{ readBase64WithGeneration(): Promise<{base64: string, generation: bigint}> }} powers.secret
 * - SecretBlob read facet. The generation-carrying read is required: a
 * rotation that cannot name the version it read cannot be made conditional.
 * @param {{ refresh(request: {refreshToken: string, accountId: string}): Promise<unknown> }} powers.refresh
 * - Token exchange on the broker's own outbound authority, never a lease's.
 * @param {{ replaceBase64(base64: string, options?: {ifGeneration?: bigint}): Promise<unknown> }} powers.rotate
 * - A secret administration facet, attenuated here to replacement alone. It
 * must resolve to the generation it committed, as `SecretAdmin` does: the
 * write-ahead protocol below pins its second write to the version the first
 * produced, and re-reading to learn it would reopen the window that pin closes.
 * @param {string} powers.accountRef - The operator's selected account.
 * @param {() => number} powers.now - Trusted epoch-millisecond clock
 * @param {number} [powers.refreshSkewMs] - Refresh this long before expiry.
 */
export const makeBrokerOAuthCredential = ({
  secret,
  refresh,
  rotate: admin,
  accountRef,
  now,
  refreshSkewMs = 60_000,
}) => {
  (secret && refresh && admin && typeof now === 'function') ||
    Fail`Unprovisioned broker OAuth credential`;
  const rotate = makeSecretRotator(admin);
  (typeof accountRef === 'string' &&
    accountRef.length > 0 &&
    accountRef.length <= 256) ||
    Fail`Invalid broker account binding`;
  (Number.isInteger(refreshSkewMs) &&
    refreshSkewMs >= 0 &&
    refreshSkewMs <= 0x7fff_ffff) ||
    Fail`Invalid broker refresh skew`;

  const read = async () => {
    const versioned = await E(secret).readBase64WithGeneration();
    (versioned &&
      typeof versioned.base64 === 'string' &&
      typeof versioned.generation === 'bigint') ||
      Fail`Invalid credential`;
    let parsed;
    try {
      parsed = JSON.parse(globalThis.atob(versioned.base64));
    } catch (_error) {
      Fail`Invalid credential`;
    }
    const state = assertBrokerOAuthState(parsed);
    state.accountId === accountRef || Fail`Broker account binding changed`;
    // The raw bytes travel with the parsed state so an intent this credential
    // wrote but never spent can be undone by restoring exactly what was there,
    // rather than by re-serializing a parse of it.
    return harden({
      state,
      generation: versioned.generation,
      base64: versioned.base64,
    });
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

  /**
   * Undo a mark this credential is certain it wrote and certain it never spent
   * against, restoring the exact bytes the mark replaced.
   *
   * Naming the generation that write committed is the whole safety argument,
   * and it is why there is no sibling of this function for the case where that
   * generation is unknown. Identifying a mark by its bytes instead looks
   * equivalent and is not: two holders over one record — the invariant this
   * credential states but cannot enforce — write byte-identical marks, since
   * the state is the same and `startedAt` has millisecond resolution. A write
   * that passes the secret manager's pin and then fails at the backend reports
   * no conflict and lands nothing, so the mark such a holder finds may be one
   * another holder wrote and is at that moment presenting the token against.
   * Clearing it would turn a violated invariant into the replay the whole
   * protocol exists to prevent, which is worse than the failed turn the
   * generation pin otherwise bounds it to. So where the mark's own generation
   * is unknown, nothing is undone and the record stays fenced.
   *
   * The outcome is swallowed: the caller is already failing for its own
   * reason, and an undo that cannot land leaves the conservative state, which
   * an operator holding the record's read capability can see as a
   * `pendingRefresh` and the secret manager's audit trail records as a refused
   * or failed write. That costs an operator re-grant for a token nothing ever
   * presented, which is the same direction every other trade here errs in.
   *
   * This is the one place the reported generation is trusted for a write
   * rather than for a refusal. Everywhere else a wrong value merely conflicts
   * and fails closed; here a rotator that named a generation it did not commit
   * would roll back whatever is at that generation instead. The rotator is
   * already the authority that can overwrite this record at will, so it is not
   * a new trust — but it is the only asymmetric use of the value.
   *
   * @param {string} restoreBase64
   * @param {bigint} intentGeneration
   */
  const undoIntentAt = (restoreBase64, intentGeneration) =>
    E(rotate)
      .replaceBase64(restoreBase64, harden({ ifGeneration: intentGeneration }))
      .then(
        () => {},
        () => {},
      );

  /** @type {Promise<{state: BrokerOAuthState, outcome: 'unchanged' | 'refreshed' | 'adopted'}> | undefined} */
  let refreshing;
  /** @param {string} [rejected] */
  const exchange = rejected => {
    // Returned rather than read back out of `refreshing`, so the type is a
    // definite promise: the flag is bookkeeping for the next caller, not the
    // value this one is owed.
    if (refreshing) return refreshing;
    const started = (async () => {
      await null;
      // Re-read inside the guard. A caller that lost the race to another
      // lease, or to an operator's re-grant, is holding a refresh token that
      // is already spent; exchanging it again is the replay this guard
      // exists to prevent. Whatever is in the record now wins.
      const { state, generation, base64 } = await read();
      if (!spent(state, rejected))
        return harden({
          state,
          outcome: /** @type {const} */ ('unchanged'),
        });
      // Refusing to exchange is the point of the mark: this record's refresh
      // token reached a token endpoint and nothing recorded what came back, so
      // presenting it again is the replay that revokes the grant. Only a new
      // grant clears it, and the record says so however the last holder died.
      state.pendingRefresh === undefined || Fail`Broker credential consumed`;
      const refreshToken =
        state.refreshToken ?? Fail`Broker credential expired`;
      // Write-ahead. Everything from the dispatch below to a committed result
      // is a window in which the token may be spent and nothing says so —
      // including the shape, account and expiry checks, which an earlier
      // version of this code left outside its fence. Marking the record first
      // makes that window fail closed no matter how it is left, up to and
      // including the process not surviving it.
      //
      // The clock is read once and checked, because this value is about to
      // become part of a stored document: a non-finite one serializes to
      // `null` and makes the record unreadable to the validator that has to
      // parse it back, which reports as a corrupt credential rather than as
      // the broken clock it is.
      const startedAt = now();
      Number.isFinite(startedAt) || Fail`Invalid broker clock`;
      const intentBase64 = globalThis.btoa(
        JSON.stringify(harden({ ...state, pendingRefresh: { startedAt } })),
      );
      // A write that fails here leaves the mark alone, deliberately, and this
      // is the one failure where that costs something: nothing was dispatched,
      // so the stored refresh token is certainly still good, and a mark that
      // did land locks a live credential until an operator re-grants it.
      // Undoing it would mean recognising it by its bytes, which is not safe —
      // see `undoIntentAt` — so the cost is taken rather than guessed away.
      const intentGeneration = await E(rotate)
        .replaceBase64(intentBase64, harden({ ifGeneration: generation }))
        .then(committed => {
          // A rotator that does not report its generation cannot be used to
          // stage a write-ahead protocol: the commit below would have nothing
          // safe to pin to. Refused here, before the token is presented,
          // rather than discovered after it has been spent. Narrowed rather
          // than asserted, so the pin below is a `bigint` because this checked
          // it, not because a cast said so.
          if (typeof committed !== 'bigint')
            throw Fail`Broker refresh intent unusable`;
          return committed;
        });
      const result = await E(refresh)
        .refresh(harden({ refreshToken, accountId: state.accountId }))
        .catch(async error => {
          await null;
          // A rejection is assumed to have consumed the token unless the
          // authority can prove the request never left. Here the mark's own
          // generation is known, so the undo can name it.
          if (isUndispatchedRefresh(error))
            await undoIntentAt(base64, intentGeneration);
          throw error;
        });
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
          // The mark is this broker's bookkeeping about its own dispatch, so
          // an upstream that echoed the field back cannot store one. Left in,
          // it would commit a credential that immediately refuses its own next
          // refresh, with nothing but an operator re-grant to clear it.
          pendingRefresh: undefined,
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
      // Pinned to the generation the intent write committed. Nothing can have
      // written since without moving the record past it, so this both clears
      // the mark and stores the result in one step, and an operator who
      // installed a new grant while the exchange was in flight is refused
      // rather than overwritten with a credential derived from the grant they
      // replaced.
      let conflicted = false;
      const rotated = await E(rotate)
        .replaceBase64(
          globalThis.btoa(JSON.stringify(next)),
          harden({ ifGeneration: intentGeneration }),
        )
        .then(
          () => true,
          error => {
            conflicted = isGenerationConflict(error);
            return false;
          },
        );
      if (rotated)
        return harden({
          state: next,
          outcome: /** @type {const} */ ('refreshed'),
        });
      // Nothing stored the credential just minted, so it must not be handed
      // out. Only a conflict means another writer stored something newer; any
      // other failure leaves the record marked, and that mark is what refuses
      // the next exchange — failing this request alone would only postpone the
      // replay by a turn, and would not survive the process at all.
      conflicted || Fail`Broker credential rotation failed`;
      const current = await read();
      // Adopting another writer's credential is only safe if it is usable:
      // returning one that is already expiring, that is the very token an
      // upstream just refused, or that is itself mid-exchange would spend the
      // caller's one retry on a credential known to be dead or contested.
      (current.generation !== intentGeneration &&
        current.state.pendingRefresh === undefined &&
        !spent(current.state, rejected)) ||
        Fail`Broker credential rotation failed`;
      return harden({
        state: current.state,
        outcome: /** @type {const} */ ('adopted'),
      });
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
    // The body above cannot settle before this assignment: it opens with
    // `await null`, so the handlers that clear the flag run in a later turn.
    refreshing = started;
    return started;
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
      const { state } = await read();
      if (!spent(state, rejected))
        return harden({
          state,
          outcome: /** @type {const} */ ('unchanged'),
        });
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
  // Subscription is a fixed ChatGPT inference profile, not an arbitrary OAuth
  // proxy. Account/login/refresh routes remain on separate host-only powers.
  authMode === 'api-key' ||
    authMode === 'oauth' ||
    authMode === 'subscription' ||
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
  // Provisioning, not preference: an OAuth lease with no usable refreshing
  // credential is an API-key lease with a shorter life, and would fail its
  // first turn rather than at admission. Binding it here also makes its
  // presence the mode: everything below asks whether there is an `oauth`
  // record rather than re-reading a mode string.
  //
  // The shape is checked, not just the presence, because the credential is now
  // supplied rather than built here and an object that cannot refresh would
  // otherwise be admitted and fail on the first request. Both properties are
  // read synchronously, which requires the credential to be a local object: the
  // single-flight guard it carries only excludes callers sharing that object,
  // so a remote presence to it would not be the guard this mode needs anyway.
  if (authMode === 'oauth' || authMode === 'subscription') {
    credentialHeader === 'bearer' || Fail`Unprovisioned broker OAuth mode`;
    // The lease's account is the operator's selection; a credential for some
    // other account is a different session's, not this one's.
    (credential !== undefined &&
      typeof credential.current === 'function' &&
      credential.accountRef === accountRef) ||
      Fail`Unprovisioned broker OAuth mode`;
  }
  const oauth =
    authMode === 'oauth' || authMode === 'subscription'
      ? (credential ?? Fail`Unprovisioned broker OAuth mode`)
      : undefined;
  const parsedOrigin = new URL(origin);
  (parsedOrigin.protocol === 'https:' &&
    parsedOrigin.origin === origin &&
    !parsedOrigin.username &&
    !parsedOrigin.password) ||
    Fail`Invalid provider origin`;
  const clientAuthorization = policy.clientAuthorization ?? 'reject';
  clientAuthorization === 'reject' ||
    clientAuthorization === 'strip' ||
    Fail`Unsupported client authorization mode`;
  const routes = policy.routes.map(({ method, path }) => {
    // Exact paths only: no normalization, query, fragment, percent escaping,
    // alternate authority or dot segments can affect dispatch.
    (method === 'POST' &&
      INFERENCE_PATHS.includes(path) &&
      /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) ||
      Fail`Invalid inference route`;
    return `${method} ${path}`;
  });
  routes.length > 0 || Fail`Inference routes required`;
  if (authMode === 'subscription') {
    (origin === 'https://chatgpt.com' &&
      credentialHeader === 'bearer' &&
      clientAuthorization === 'reject' &&
      anthropicVersion === undefined &&
      anthropicBeta === undefined &&
      typeof accountRef === 'string' &&
      /^[A-Za-z0-9_-]{1,256}$/.test(accountRef) &&
      routes.length === 1 &&
      routes[0] === 'POST /v1/responses') ||
      Fail`Invalid ChatGPT subscription profile`;
  }
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
  // Keep the existing small-body admission envelope, but allow configured
  // larger prompts up to the private pipe's 8MiB frame ceiling. UTF-8 byte
  // accounting below remains authoritative (characters are not bytes).
  const BodyShape = M.string({
    stringLengthLimit: Math.max(
      100_000,
      Number(maxRequestBytes < 8_388_608n ? maxRequestBytes : 8_388_608n),
    ),
  });
  const endpoint = makeExo(
    'ProviderInferenceLease',
    M.interface('ProviderInferenceLease', {
      request: M.call(
        M.splitRecord({
          method: M.string(),
          path: M.string(),
          body: BodyShape,
        }),
      ).returns(M.promise()),

      requestStream: M.call(
        M.splitRecord({
          method: M.string(),
          path: M.string(),
          body: BodyShape,
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
    const resolved = await E(oauth)
      .current(harden(rejected === undefined ? {} : { rejected }))
      .catch(error => {
        record('refresh-failed');
        throw error;
      });
    // A refresh that was minted and then discarded is not a refresh: the
    // audit trail has to distinguish "this turn installed a new credential"
    // from "this turn burned a refresh token and adopted someone else's".
    if (resolved.outcome === 'refreshed') record('refreshed');
    if (resolved.outcome === 'adopted') record('refresh-discarded');
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
    if (authMode === 'subscription') {
      (data.store === false && data.stream === true) ||
        Fail`Subscription inference requires non-stored streaming responses`;
    }
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
        url:
          authMode === 'subscription'
            ? 'https://chatgpt.com/backend-api/codex/responses'
            : `${origin}${path}`,
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
          ...(authMode === 'subscription'
            ? {
                'chatgpt-account-id': accountRef,
                originator: 'codex_cli_rs',
              }
            : {}),
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
