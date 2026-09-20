// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { M } from '@endo/patterns';

import {
  INFERENCE_PATHS,
  forwardableHeaders,
  splitInferenceTarget,
} from './provider-paths.js';
import { makeUsageTap } from './provider-usage.js';
import { makeSecretRotator } from './secret-rotator.js';
import { emptyCounts, tokenCount } from './token-usage.js';

/**
 * @typedef {{ method: string, path: string }} Route
 * @typedef {{ origin: string, routes: Route[], models: string[],
 * clientAuthorization?: 'reject' | 'strip',
 * maxConcurrentRequests: number, maxRequestBytes: bigint, maxResponseBytes: bigint,
 * credentialHeader?: 'bearer' | 'x-api-key',
 * anthropicVersion?: string, anthropicBeta?: string,
 * authMode?: 'api-key' | 'oauth', accountRef?: string }} BrokerPolicy
 * @typedef {(request: {path: string, data: Readonly<Record<string, unknown>>}) =>
 *   {path: string, headers?: Readonly<Record<string, string>>}} ProviderRequestAdapter
 * @typedef {{ startedAt: number }} BrokerRefreshIntent
 * @typedef {{ version: 'BrokerOAuthStateV1', accessToken: string,
 * refreshToken?: string, expiresAt: number, accountId: string,
 * pendingRefresh?: BrokerRefreshIntent }} BrokerOAuthState
 * @typedef {{next(): Promise<{done: boolean, value: string}>, return(): void}} ProviderReader
 * @typedef {{status: number, reader: ProviderReader, closed?: Promise<void>}} ProviderStream
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
 * The message a transport uses to report that the upstream refused the request
 * because the subscription's allowance is used up: a 429 whose rate-limit
 * headers say so, as opposed to a moment's throttling or any other refusal.
 * Like the credential classification it is a bare message. When the allowance
 * comes back is in the account reading the same response produced, which the
 * transport hands to its observer before it throws this.
 *
 * It revises the decision recorded in designs/hosted-agent-broker-oauth.md
 * that one boolean's worth of information crosses this seam: a pool can only
 * hand a request to its next subscription if it can tell this refusal from a
 * failure. Text from the upstream still never crosses.
 *
 * @param {unknown} error
 */
export const isSubscriptionExhaustion = error =>
  error instanceof Error && error.message === 'Provider subscription exhausted';
harden(isSubscriptionExhaustion);

const MEMBER_UNAVAILABLE = 'Provider subscription unavailable';
const makeMemberUnavailable = () => Error(MEMBER_UNAVAILABLE);
/** @param {unknown} error */
const isMemberUnavailable = error =>
  error instanceof Error && error.message === MEMBER_UNAVAILABLE;

/**
 * The five counts of a settlement, as numbers and nothing else.
 *
 * @param {any} usage
 */
const projectCounts = usage =>
  harden({
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    cachedInputTokens: tokenCount(usage?.cachedInputTokens),
    cacheWriteInputTokens: tokenCount(usage?.cacheWriteInputTokens),
    reasoningOutputTokens: tokenCount(usage?.reasoningOutputTokens),
  });

/**
 * The provider may have done the work though nothing of its answer arrived:
 * the deadline passed with the request out, or a response broke off after it
 * had begun. Bare like the others. It changes nothing for the caller, who
 * sees a failed request; it tells whoever charges for the request that it
 * was not free.
 *
 * @param {unknown} error
 */
export const isResponseLost = error =>
  error instanceof Error && error.message === 'Provider response lost';
harden(isResponseLost);

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
 * account travels with the tokens and is checked against the grant's binding.
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
 * built here, by whoever composes the deployment, rather than inside a grant or
 * a grant issuer, so that sharing it across every grant and every issuer over
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
 * - Token exchange on the broker's own outbound authority, never a grant's.
 * @param {{ replaceBase64(base64: string, options?: {ifGeneration?: bigint}): Promise<unknown> }} powers.rotate
 * - A secret administration facet, attenuated here to replacement alone. It
 * must resolve to the generation it committed, as `SecretAdmin` does: the
 * write-ahead protocol below pins its second write to the version the first
 * produced, and re-reading to learn it would reopen the window that pin closes.
 * @param {() => number} powers.now - Trusted epoch-millisecond clock
 * @param {string} powers.accountRef - The operator's selected account.
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
      // grant, or to an operator's re-grant, is holding a refresh token that
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
      // session's billing and quota to one the grant was never bound to.
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
     * a concurrent grant, or by an operator is picked up on the next request
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
 * One subscription as a grant uses it.
 *
 * @typedef {object} BrokerGrantMember
 * @property {string} id
 * @property {{ readBase64(): Promise<string> }} secret
 * @property {{ request(request: UpstreamRequest): Promise<{status: number, body: string}>, requestStream?(request: UpstreamRequest): Promise<ProviderStream> }} transport
 *   This member's own transport, so that what its responses say of the
 *   account is read as this member's.
 * @property {ReturnType<typeof makeBrokerOAuthCredential>} [credential]
 * @property {ProviderRequestAdapter} [adaptRequest]
 * @property {string} [accountRef] The account an OAuth credential must name.
 * @property {{ provide(): Promise<any>, reset(endpoint: any): void }} [wrapped]
 *   In place of `secret` and `transport`: this member is somebody else's
 *   subscription. `provide` answers an inference endpoint opened on it for
 *   this grant's session, opening it on first use; `reset` forgets one that
 *   stopped working, so the next `provide` opens another. The request goes
 *   to it whole, no credential of this broker's is involved, and its response
 *   comes back untouched: the stream is the far subscription's own reader.
 */

/**
 * @typedef {object} BrokerGrantPool
 * @property {readonly BrokerGrantMember[]} members
 * @property {() => string[]} select The member ids to try for the request now
 *   being admitted, in order. May throw, for a pinned member that is gone.
 * @property {(memberId: string) => void} served
 * @property {(memberId: string) => void} exhausted The member refused the
 *   request as exhausted; its reading, with the time it is back, has already
 *   reached the member's transport observer.
 * @property {(memberId: string) => void} [unusable] The member's credential
 *   would not resolve, or was rejected even after a refresh. The request is
 *   not tried elsewhere (that failure is not a statement about the request),
 *   but the pool may skip the member for a while.
 */

/** The largest chunk a bytes response stream carries. */
export const RESPONSE_CHUNK_BYTES = 32_768;
harden(RESPONSE_CHUNK_BYTES);

/**
 * A grant's screened text reader (`next()` and `return()`, yielding strings
 * the echo screen has passed) as a bytes exo-stream. The screen works on
 * decoded text and cuts on character boundaries, so it stays beneath this and
 * its output is encoded again here. Chunks are cut to `RESPONSE_CHUNK_BYTES`,
 * which gives a consumer's read-ahead a known ceiling and its base64 string
 * limit a number to be set from.
 *
 * The cut pieces of one upstream chunk wait here between pulls, and the
 * screened reader is only consulted when they run out. `checkLive` is
 * therefore asked before each piece too: a revoked grant delivers nothing
 * more, including what was already cut.
 *
 * `RESPONSE_CHUNK_BYTES` may not grow past 49,152: a listener checks each
 * base64 chunk against a 65,536-character limit compiled into its image, and
 * the images deployed are the operator's to replace.
 *
 * @param {any} screened
 * @param {() => void} checkLive throws once the grant may deliver no more
 */
const makeScreenedBytesReader = (screened, checkLive) => {
  const encoder = new TextEncoder();
  /** @type {Uint8Array[]} */
  const queued = [];
  let ended = false;
  // Set only by this reader's own close. A pull that rejects for any other
  // reason is a failure and is reported as one.
  let closedByConsumer = false;
  const source = harden({
    next: async () => {
      await null;
      for (;;) {
        if (queued.length > 0) {
          try {
            checkLive();
          } catch (_error) {
            queued.length = 0;
            ended = true;
            // The same wording every other failure of this grant has.
            throw Fail`Provider request failed`;
          }
          return harden({ done: false, value: queued.shift() });
        }
        if (ended) return harden({ done: true, value: undefined });
        let chunk;
        try {
          // eslint-disable-next-line no-await-in-loop
          chunk = await E(screened).next();
        } catch (error) {
          // The consumer closed while this pull was parked, and the cancelled
          // upstream read rejected: that is the close, not a failure.
          if (closedByConsumer) return harden({ done: true, value: undefined });
          throw error;
        }
        if (chunk.done) {
          ended = true;
        } else {
          const bytes = encoder.encode(chunk.value);
          for (
            let offset = 0;
            offset < bytes.byteLength;
            offset += RESPONSE_CHUNK_BYTES
          ) {
            queued.push(bytes.subarray(offset, offset + RESPONSE_CHUNK_BYTES));
          }
        }
      }
    },
    return: async () => {
      closedByConsumer = true;
      ended = true;
      queued.length = 0;
      await E(screened).return();
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]: () => source,
  });
  return bytesReaderFromIterator(/** @type {any} */ (source), {
    // A consumer that closes while the upstream is quiet must not wait for
    // its next chunk: cancel the upstream read, which the pending pull then
    // settles on.
    cancelPending: () => {
      closedByConsumer = true;
      ended = true;
      return E(screened).return();
    },
  });
};

/**
 * A bounded inference capability, not an HTTP listener or sandbox attestation.
 * The trusted transport MUST enforce redirect:'error' before following any
 * redirect and maxResponseBytes while reading, and must not forward ambient
 * cookies or credentials. It alone receives the upstream credential.
 * Admission bounds simultaneous requests, not lifetime usage or spending.
 * Revocation prevents new dispatch and delivery, but cannot undo a request
 * already dispatched. Production transports must separately support teardown.
 * A transport with independent termination (such as a deadline) must expose
 * `closed` so an abandoned reader cannot keep an admission slot forever.
 * Literal token echoes are rejected as defense in depth; the upstream remains
 * trusted not to encode or otherwise disclose its own authorization credential.
 *
 * With `authMode: 'oauth'` the secret holds a `BrokerOAuthStateV1` document
 * instead of a bare credential, and the broker — never the grant — refreshes
 * and rotates it. Refresh travels on `powers.refresh`, a separate outbound
 * authority, because the route allowlist below admits inference paths only and
 * a token endpoint is neither that origin nor those paths.
 *
 * @param {BrokerPolicy} policy
 * @param {object} powers
 * @param {{ readBase64(): Promise<string> }} powers.secret - SecretBlob read facet
 * @param {{ request(request: UpstreamRequest): Promise<{status: number, body: string}>, requestStream?(request: UpstreamRequest): Promise<ProviderStream> }} powers.transport
 * @param {(event: {event: string, requests: bigint}) => void} [powers.audit]
 * @param {ReturnType<typeof makeBrokerOAuthCredential>} [powers.credential]
 * - The shared refreshing credential for this secret record, required by
 * `authMode: 'oauth'`. Shared rather than per grant so that concurrent
 * sessions cannot each redeem the same refresh token.
 * @param {ProviderRequestAdapter} [powers.adaptRequest]
 * Trusted provider code, never guest data or serialized operator policy.
 * Runs after route/model/body admission and before reading credentials.
 * May translate the path within the pinned origin and add non-credential
 * headers; cannot change the method, body, credential, or response bounds.
 * @param {BrokerGrantPool} [powers.pool]
 * Several subscriptions of one provider behind this grant, in place of
 * `secret`, `transport`, `credential` and `adaptRequest`, which describe one.
 * Each request is tried on the members the pool's `select` names, in order:
 * a member that refuses it because its allowance is used up (`Provider
 * subscription exhausted`) is reported to the pool and the request goes to
 * the next, built afresh for that member — its credential, its adapter
 * headers (an account header belongs to one account), its transport. Nothing
 * of a refused attempt reached the caller, so the caller sees one response.
 * At most one attempt per member per request, beside the one refresh retry
 * within a member. See designs/hosted-agent-subscriptions.md, "Handover".
 * @param {boolean} [powers.revealExhaustion]
 * Every failure of a request reaches the caller as `Provider request failed`.
 * With this, one more bare classification does: `Provider subscription
 * exhausted`, when the request failed because every subscription it could be
 * served from is used up; and `Provider response lost`, when the provider was
 * given the whole deadline or had begun to answer, so the work may have been
 * done. For an endpoint a share sits on, which must tell its holder a limit
 * from a fault and charge for what was not free; never for a slice's
 * listener.
 */
export const makeProviderBrokerGrant = (
  policy,
  {
    secret,
    transport,
    audit = () => {},
    credential,
    adaptRequest,
    pool,
    revealExhaustion = false,
  },
) => {
  // Copy and validate operator input so later mutation cannot widen authority.
  const { origin, maxConcurrentRequests, maxRequestBytes, maxResponseBytes } =
    policy;
  const authMode = policy.authMode ?? 'api-key';
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
  // Require refresh capability at admission so an OAuth session does not fail
  // its first turn merely because provisioning omitted that capability. Binding it here also makes its
  // presence the mode: everything below asks whether there is an `oauth`
  // record rather than re-reading a mode string.
  //
  // The shape is checked, not just the presence, because the credential is now
  // supplied rather than built here and an object that cannot refresh would
  // otherwise be admitted and fail on the first request. Both properties are
  // read synchronously, which requires the credential to be a local object: the
  // single-flight guard it carries only excludes callers sharing that object,
  // so a remote presence to it would not be the guard this mode needs anyway.
  /** @type {readonly BrokerGrantMember[]} */
  const members = harden(
    pool === undefined
      ? [{ id: 'default', secret, transport, credential, adaptRequest }]
      : pool.members.map(member => ({ ...member })),
  );
  (members.length > 0 &&
    new Set(members.map(member => member.id)).size === members.length &&
    members.every(
      member =>
        typeof member.id === 'string' &&
        member.id !== '' &&
        (member.wrapped !== undefined ||
          (member.secret !== undefined && member.transport !== undefined)),
    )) ||
    Fail`Invalid broker subscription set`;
  if (authMode === 'oauth') {
    credentialHeader === 'bearer' || Fail`Unprovisioned broker OAuth mode`;
    // A member's account is the operator's selection; a credential for some
    // other account is a different subscription's, not this one's.
    for (const member of members) {
      // A wrapped member authenticates wherever its subscription lives.
      member.wrapped !== undefined ||
        (member.credential !== undefined &&
          typeof member.credential.current === 'function' &&
          member.credential.accountRef === (member.accountRef ?? accountRef)) ||
        Fail`Unprovisioned broker OAuth mode`;
    }
  }
  const oauthMode = authMode === 'oauth';
  const membersById = new Map(members.map(member => [member.id, member]));
  // The members to try for a request. A pool may name one this grant does not
  // hold: the grant took the set as it was when it was issued, and an
  // operator has since added to it. Such a member is not this grant's to use.
  const selectOrder = () =>
    pool === undefined
      ? ['default']
      : [...new Set(pool.select())].filter(id => membersById.has(id));
  /**
   * The pool's bookkeeping must not change how a request settles: a response
   * already received is delivered whatever the pool's hook does.
   *
   * @param {'served' | 'exhausted' | 'unusable'} hook
   * @param {string} memberId
   */
  const tellPool = (hook, memberId) => {
    try {
      pool?.[hook]?.(memberId);
    } catch (_error) {
      // Bookkeeping only.
    }
  };
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
    // Exact targets only: no normalization, fragment, percent escaping,
    // alternate authority or dot segments can affect dispatch. A query is
    // admitted, but as part of the exact target — never as a wildcard.
    const target = splitInferenceTarget(path);
    (method === 'POST' &&
      target !== undefined &&
      INFERENCE_PATHS.includes(target.pathname) &&
      /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(target.pathname)) ||
      Fail`Invalid inference route`;
    return `${method} ${path}`;
  });
  routes.length > 0 || Fail`Inference routes required`;
  const models = [...policy.models];
  (models.length > 0 &&
    models.every(model => typeof model === 'string' && model.length > 0)) ||
    Fail`Models required`;
  // Simultaneous request slots are a deployment allocation, not a usage budget.
  (Number.isInteger(maxConcurrentRequests) &&
    maxConcurrentRequests > 0 &&
    maxConcurrentRequests <= 0xffff_ffff) ||
    Fail`Invalid provider concurrency limit`;
  for (const limit of [maxRequestBytes, maxResponseBytes]) {
    (typeof limit === 'bigint' && limit > 0n) || Fail`Positive quota required`;
  }
  /** @type {Set<() => void>} */
  const streams = new Set();
  let revoked = false;
  let requests = 0n;
  let activeRequests = 0;
  const checkLive = () => {
    !revoked || Fail`Broker grant inactive`;
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
    'ProviderInferenceGrant',
    M.interface('ProviderInferenceGrant', {
      // `headers` is optional, not merely nullable: a caller that curates no
      // headers of its own — every in-process caller before the listener
      // existed — omits the key, and `M.opt` inside the required half would
      // still demand it be present.
      request: M.call(
        M.splitRecord(
          {
            method: M.string(),
            path: M.string(),
            body: BodyShape,
          },
          { headers: M.recordOf(M.string(), M.string()) },
        ),
      ).returns(M.promise()),

      requestStream: M.call(
        M.splitRecord(
          {
            method: M.string(),
            path: M.string(),
            body: BodyShape,
          },
          { headers: M.recordOf(M.string(), M.string()) },
        ),
      ).returns(M.promise()),

      requestByteStream: M.call(
        M.splitRecord(
          {
            method: M.string(),
            path: M.string(),
            body: BodyShape,
          },
          { headers: M.recordOf(M.string(), M.string()) },
        ),
      ).returns(M.promise()),
    }),
    {
      /** @param {{method: string, path: string, body: string, headers?: Record<string, string>}} request */
      async request(request) {
        return perform(request, false);
      },
      /** @param {{method: string, path: string, body: string, headers?: Record<string, string>}} request */
      async requestStream(request) {
        // The older reader, for a listener image from before the bytes
        // stream. It is handed no settlement it would never look at.
        const { status, reader, contentType } = await perform(
          request,
          true,
          false,
        );
        return harden({ status, reader, contentType });
      },
      /**
       * The same response as `requestStream`, as a bytes exo-stream: a reader
       * that a consumer may read ahead of (`iterateBytesReader(reader, {
       * buffer })`), so a response crossing a slow link does not pay a round
       * trip per chunk. `requestStream` stays, because the listener is an
       * image pinned by the operator and an older one knows only that.
       *
       * What the producer holds for a consumer that reads ahead is bounded by
       * the response byte limit and not by the consumer's read-ahead: in
       * exo-stream the consumer grants credit, and one that grants a great
       * deal and reads nothing makes the producer drain the upstream at once.
       * That costs at most `maxResponseBytes`, a third more in base64, per
       * open response, and `maxConcurrentRequests` of those per grant. Over
       * the private pipe the pipe's own queue bound trips first and closes
       * that consumer's pipe alone.
       *
       * @param {{method: string, path: string, body: string, headers?: Record<string, string>}} request
       */
      async requestByteStream(request) {
        const { status, reader, contentType, usage, bytesReader } =
          await perform(request, true, true);
        return harden({
          status,
          contentType,
          reader: bytesReader ?? makeScreenedBytesReader(reader, checkLive),
          // What the response cost, once the producer has read its end:
          // `{ usage, began }` (`provider-usage.js`). It always fulfils.
          usage,
        });
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
   * Everything the upstream could echo back that the grant must not deliver.
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
   * a concurrent grant, or by an operator is picked up on the next request
   * without re-delegation, and every length derived below is derived from that
   * read rather than cached across it.
   *
   * @param {BrokerGrantMember} member
   * @param {string} [rejected] - An access token the upstream has just refused,
   * so a credential that still looks current is replaced too.
   * @returns {Promise<ResolvedCredential>}
   */
  const resolveCredential = async (member, rejected) => {
    const oauth = oauthMode ? member.credential : undefined;
    if (!oauth) {
      const encoded = await E(member.secret).readBase64();
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
   * @param {{method: string, path: string, body: string, headers?: Record<string, string>}} request
   * @param {boolean} streaming
   * @param bytesOk
   */
  const perform = async (
    { method, path, body, headers },
    streaming,
    bytesOk = !streaming,
  ) => {
    // Re-screen on this side of the seam: the listener already dropped the
    // owned headers, and the broker does not take its word for it.
    const forwarded = forwardableHeaders(headers ?? {});
    checkLive();
    routes.includes(`${method} ${path}`) || Fail`Inference route denied`;
    const requestBytes = BigInt(new TextEncoder().encode(body).length);
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
    /**
     * A member's translation of the canonical request. Per member, because
     * what an adapter adds can belong to one account (a ChatGPT account
     * header), so a request built for one member cannot be replayed under
     * another.
     *
     * @param {BrokerGrantMember} member
     */
    const adaptFor = member => {
      // Somebody else's subscription translates the request where it lives.
      if (member.wrapped !== undefined) {
        return harden({ upstreamPath: path, adapterHeaders: {} });
      }
      const adapted = member.adaptRequest
        ? member.adaptRequest(harden({ path, data }))
        : { path };
      const upstreamPath = adapted.path;
      const target = splitInferenceTarget(upstreamPath);
      (target &&
        /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(target.pathname)) ||
        Fail`Invalid adapted inference target`;
      const adapterHeaders = forwardableHeaders(adapted.headers ?? {});
      Object.entries(adapted.headers ?? {}).every(
        ([name, value]) => adapterHeaders[name] === value,
      ) || Fail`Invalid adapted inference headers`;
      return harden({ upstreamPath, adapterHeaders });
    };
    // Which subscriptions to try, in order, and the first one's translation:
    // both before a slot is reserved or any credential read, as the single
    // translation always was. With a pool a failure here is collapsed like
    // any other of the request's: what the pool says, a pinned id included,
    // is the operator's and not for whoever holds the endpoint.
    /** @type {BrokerGrantMember[]} */
    let candidates;
    let firstAdapted;
    try {
      candidates = selectOrder()
        .map(id => membersById.get(id) ?? Fail`Unknown broker subscription`)
        // Somebody else's subscription streams bytes only. A listener from
        // before the bytes stream is served by the operator's own accounts,
        // rather than have a far response started that nobody could read.
        .filter(member => bytesOk || member.wrapped === undefined);
      if (candidates.length === 0) {
        record('subscriptions-exhausted');
        throw Fail`Provider subscriptions exhausted`;
      }
      firstAdapted = adaptFor(candidates[0]);
    } catch (error) {
      if (pool === undefined) throw error;
      if (
        revealExhaustion &&
        error instanceof Error &&
        error.message === 'Provider subscriptions exhausted'
      ) {
        throw Error('Provider subscription exhausted');
      }
      return Fail`Provider request failed`;
    }
    activeRequests < maxConcurrentRequests ||
      Fail`Provider concurrency limit reached`;
    // Reserve before the secret read; an open stream retains its slot until
    // upstream EOF, cancellation, or failure. Completed requests consume no slot.
    activeRequests += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests -= 1;
    };
    requests += 1n;
    record('admitted');
    // What this request cost, for whoever charges for it. Settled once, by
    // whichever comes first: the end of the response, its failure or
    // cancellation, or a refusal before any response. It never rejects.
    /**
     * @typedef {object} UsageSettlement
     * @property {any} usage The five counts, or null when the response never
     *   said.
     * @property {boolean} began Whether the provider may have done the work.
     * @property {boolean} complete Whether the producer read the response to
     *   its end. One cut short is charged no less than it was reserved at.
     * @property {number} responseBytes What the producer read of it.
     */
    /** @type {(settlement: UsageSettlement) => void} */
    let settleUsage = () => {};
    /** @type {Promise<UsageSettlement>} */
    const usageSettled = new Promise(resolve => {
      let settled = false;
      settleUsage = settlement => {
        if (settled) return;
        settled = true;
        resolve(harden(settlement));
      };
    });
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
     * @param {BrokerGrantMember} member
     * @param {{ upstreamPath: string, adapterHeaders: Record<string, string> }} adapted
     * @param {ResolvedCredential} resolved
     */
    const dispatch = async (
      member,
      { upstreamPath, adapterHeaders },
      { credential: token, screens },
    ) => {
      await null;
      checkLive();
      const { transport: memberTransport } = member;
      for (const screen of screens) {
        if (!exposed.includes(screen)) exposed.push(screen);
      }
      const upstream = harden({
        url: `${origin}${upstreamPath}`,
        method,
        headers: {
          // The harness describes its own request; the broker authenticates it.
          // Re-screened here rather than trusted from the listener, so the
          // owned set is enforced on this side of the seam too. Policy values
          // fill in only what the harness did not send, and the credential is
          // applied last and unconditionally.
          ...forwarded,
          ...(anthropicVersion === undefined ||
          forwarded['anthropic-version'] !== undefined
            ? {}
            : { 'anthropic-version': anthropicVersion }),
          ...(anthropicBeta === undefined ||
          forwarded['anthropic-beta'] !== undefined
            ? {}
            : { 'anthropic-beta': anthropicBeta }),
          'content-type': 'application/json',
          ...adapterHeaders,
          ...(credentialHeader === 'bearer'
            ? { authorization: `Bearer ${token}` }
            : { 'x-api-key': token }),
        },
        body: canonicalBody,
        redirect: /** @type {const} */ ('error'),
        maxResponseBytes,
      });
      /** @param {string} text */
      const echoes = text => exposed.some(screen => text.includes(screen));
      if (streaming) {
        const response = await E(memberTransport).requestStream(upstream);
        const tap = makeUsageTap();
        let bytes = 0n;
        const cancel = () => {
          // Release ownership before the eventual send, including if it fails.
          if (!streams.delete(cancel)) return;
          finish();
          // The response began and was cut short, so it is not free, and not
          // cheaper than one that ran: what it said of its cost so far and
          // how much of it was read, for a meter to set against what it
          // reserved.
          settleUsage({
            usage: tap.finish() ?? null,
            began: true,
            complete: false,
            responseBytes: Number(bytes),
          });
          void E(response.reader)
            .return()
            .catch(() => {});
        };
        streams.add(cancel);
        if (response.closed !== undefined) {
          // The transport can terminate while the consumer is not pulling.
          // Do not discard buffered final output when normal EOF closes it.
          void response.closed.then((/** @type {any} */ ending) => {
            // The transport says how it ended. Only the end of the body is
            // a response read to its end; a deadline or a reset closes it
            // too, and that is one cut short, whatever it had already said
            // of its cost.
            if (ending?.complete !== true) {
              cancel();
              return;
            }
            streams.delete(cancel);
            finish();
            settleUsage({
              usage: tap.finish() ?? null,
              began: true,
              complete: true,
              responseBytes: Number(bytes),
            });
          }, cancel);
        }
        let held = '';
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
                  // Numbers only, and from what the producer read: a consumer
                  // that stops reading does not make the response cheaper.
                  tap.push(chunk.value);
                  if (chunk.done) {
                    ended = true;
                    streams.delete(cancel);
                    finish();
                    settleUsage({
                      usage: tap.finish() ?? null,
                      began: true,
                      complete: true,
                      responseBytes: Number(bytes),
                    });
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
            usage: usageSettled,
          });
        } catch (_error) {
          cancel();
          throw _error;
        }
      }
      const response = await E(memberTransport).request(upstream);
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
      finish();
      const whole = makeUsageTap();
      whole.push(response.body);
      const settlement = harden({
        usage: whole.finish() ?? null,
        began: true,
        complete: true,
        responseBytes: new TextEncoder().encode(response.body).length,
      });
      settleUsage(settlement);
      // No upstream headers (including cookies or authentication challenges)
      // escape through the grant. Upstream error bodies are never returned.
      return harden({
        status: response.status,
        body: response.body,
        usage: settlement,
      });
    };
    /**
     * The request, whole, to a member that is somebody else's subscription.
     * What comes back is theirs: the stream is their reader, handed on and
     * not read here, and what it cost is what they settle. A refusal by their
     * limits reads as this member being used up, so the request goes on to
     * the next, as it would from an account of the operator's own.
     *
     * @param {BrokerGrantMember} member
     */
    const dispatchWrapped = async member => {
      await null;
      checkLive();
      const { wrapped } = member;
      if (wrapped === undefined) throw Fail`Invalid broker subscription set`;
      const message = harden({
        method,
        path,
        body: canonicalBody,
        ...(Object.keys(forwarded).length > 0 ? { headers: forwarded } : {}),
      });
      /**
       * The far side's bare words for the request itself. Anything else it
       * throws (its endpoint was closed, its daemon restarted, the connection
       * to it dropped) is about the endpoint, and nothing was delivered.
       *
       * @param {unknown} error
       */
      const aboutTheRequest = error =>
        error instanceof Error &&
        [
          'Provider request failed',
          'Provider response lost',
          'Model denied',
          'Invalid inference JSON',
          'Inference route denied',
          'Request byte quota exceeded',
          'Provider concurrency limit reached',
        ].includes(error.message);
      /** @param {unknown} error */
      const usedUp = error =>
        error instanceof Error &&
        (error.message === 'Provider share exhausted' ||
          error.message === 'Provider subscription exhausted');
      /** @param {any} far */
      const send = far =>
        streaming ? E(far).requestByteStream(message) : E(far).request(message);
      let result;
      try {
        let first;
        try {
          first = await wrapped.provide();
        } catch (_error) {
          throw makeMemberUnavailable();
        }
        try {
          result = await send(first);
        } catch (error) {
          if (usedUp(error) || aboutTheRequest(error)) throw error;
          const word = error instanceof Error ? error.message : '';
          if (word !== 'Inference endpoint revoked') {
            // The share itself cannot serve just now (its store, what is
            // beneath it, a revocation), or the connection to it failed.
            // The request is not sent again: it may have arrived. The
            // endpoint is left as it is, since another request of this
            // session may be streaming from it; only a lost connection
            // forgets it, so the next request opens another.
            if (word !== 'Provider share unavailable') wrapped.reset(first);
            throw makeMemberUnavailable();
          }
          // The far side's own word that this endpoint is gone (its daemon
          // restarted, or it closed the one used least recently): nothing
          // of the request was taken up, so it is sent once more, on
          // another.
          wrapped.reset(first);
          checkLive();
          let again;
          try {
            again = await wrapped.provide();
          } catch (_error) {
            throw makeMemberUnavailable();
          }
          try {
            result = await send(again);
          } catch (retryError) {
            if (usedUp(retryError) || aboutTheRequest(retryError)) {
              throw retryError;
            }
            throw makeMemberUnavailable();
          }
        }
      } catch (error) {
        if (usedUp(error)) throw Error('Provider subscription exhausted');
        throw error;
      }
      /** Give a far response nobody will read back to where it came from. */
      const abandon = () => {
        const reader = result?.reader;
        if (reader === undefined || reader === null) return;
        // A bytes reader is closed by taking it up and returning at once:
        // that is what tells its producer to stop.
        try {
          void Promise.resolve(
            iterateBytesReader(reader, { buffer: 0 }).return(undefined),
          ).catch(() => {});
        } catch (_error) {
          // Not a reader after all; there is nothing to give back.
        }
      };
      try {
        checkLive();
        (result !== null &&
          typeof result === 'object' &&
          Number.isInteger(result.status) &&
          Number(result.status) >= 200 &&
          Number(result.status) < 300 &&
          (streaming
            ? result.reader !== undefined && result.reader !== null
            : typeof result.body === 'string' &&
              BigInt(new TextEncoder().encode(result.body).length) <=
                maxResponseBytes)) ||
          Fail`Invalid provider response`;
      } catch (error) {
        abandon();
        throw error;
      }
      // Numbers, and only the ones a settlement has: nothing else another
      // daemon put there goes on to the next holder.
      const settled = Promise.resolve(result.usage).then(
        settlement =>
          settlement !== null &&
          typeof settlement === 'object' &&
          typeof settlement.began === 'boolean'
            ? {
                usage:
                  settlement.usage === null || settlement.usage === undefined
                    ? null
                    : projectCounts(settlement.usage),
                began: settlement.began,
                complete: settlement.complete === true,
                responseBytes: tokenCount(settlement.responseBytes),
              }
            : { usage: null, began: true, complete: false, responseBytes: 0 },
        () => ({ usage: null, began: true, complete: false, responseBytes: 0 }),
      );
      if (!streaming) {
        record('completed');
        finish();
        const settlement = harden(await settled);
        settleUsage(settlement);
        return harden({
          status: result.status,
          body: result.body,
          usage: settlement,
        });
      }
      // The slot is held until the far side has read the end of the stream,
      // which is when it settles what the response cost. A revoked grant
      // gives the stream back.
      const cancel = () => {
        if (!streams.delete(cancel)) return;
        abandon();
      };
      streams.add(cancel);
      void settled.then(settlement => {
        streams.delete(cancel);
        finish();
        record(settlement.complete ? 'completed' : 'failed');
        settleUsage(settlement);
      });
      return harden({
        status: result.status,
        contentType:
          data.stream === true ? 'text/event-stream' : 'application/json',
        usage: usageSettled,
        // Not a text reader: the bytes stream itself, for `requestByteStream`
        // to hand on.
        reader: undefined,
        bytesReader: result.reader,
      });
    };
    /**
     * One subscription's attempt at the request, with its one refresh retry.
     *
     * @param {BrokerGrantMember} member
     * @param {ReturnType<typeof adaptFor>} adapted
     */
    const attempt = async (member, adapted) => {
      if (member.wrapped !== undefined) return dispatchWrapped(member);
      const first = await resolveCredential(member).catch(error => {
        tellPool('unusable', member.id);
        throw error;
      });
      try {
        return await dispatch(member, adapted, first);
      } catch (error) {
        // One retry, and only for the one failure a refresh can fix. A turn
        // whose token was revoked or rotated elsewhere mid-session recovers
        // here; every other failure propagates as it happened. Nothing was
        // delivered to the caller yet: an upstream that rejects the credential
        // does so before the first response byte.
        if (!oauthMode || !isCredentialRejection(error)) {
          // A key the upstream rejects cannot be refreshed: the member is
          // unusable until its secret is replaced.
          if (isCredentialRejection(error)) tellPool('unusable', member.id);
          throw error;
        }
        record('credential-rejected');
        // Naming the refused token is what lets the shared credential tell
        // "replace this one" from "another grant already replaced it": it
        // exchanges only if the record still holds the token that just failed.
        try {
          return await dispatch(
            member,
            adapted,
            await resolveCredential(member, first.credential),
          );
        } catch (retryError) {
          // Refused again with a fresh credential, or no fresh one to be
          // had: this member cannot serve until somebody mends it.
          tellPool('unusable', member.id);
          throw retryError;
        }
      }
    };
    try {
      checkLive();
      /** @type {unknown} */
      let refusal;
      for (const [index, member] of candidates.entries()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await attempt(
            member,
            index === 0 ? firstAdapted : adaptFor(member),
          );
          tellPool('served', member.id);
          return result;
        } catch (error) {
          // A subscription that is used up refuses at admission, before any
          // response byte, so the same request can go to the next one. Any
          // other failure is the request's, and is not tried elsewhere.
          if (pool !== undefined && isMemberUnavailable(error)) {
            // A grant revoked meanwhile is why, not the member.
            checkLive();
            // Nothing the next member could not also be given, so it may
            // have the request. The pool skips this one for a while, as it
            // does a dead credential. If none is left, the request was
            // refused by what the subscription can do now and not by
            // anything about the request, which is what exhaustion means to
            // whoever holds this: their pool moves on.
            refusal = Error('Provider subscription exhausted');
            record('subscription-unavailable');
            tellPool('unusable', member.id);
            // eslint-disable-next-line no-continue
            continue;
          }
          if (pool === undefined || !isSubscriptionExhaustion(error)) {
            throw error;
          }
          refusal = error;
          record('subscription-exhausted');
          tellPool('exhausted', member.id);
          checkLive();
        }
      }
      throw refusal;
    } catch (error) {
      finish();
      record('failed');
      // Refused before any response: nothing was spent. Unless the provider
      // was given the whole deadline, or had begun to answer: then the work
      // may have been done, and it is charged as a response cut short.
      settleUsage(
        isResponseLost(error)
          ? { usage: null, began: true, complete: false, responseBytes: 0 }
          : {
              usage: emptyCounts(),
              began: false,
              complete: true,
              responseBytes: 0,
            },
      );
      if (
        revealExhaustion &&
        (isSubscriptionExhaustion(error) ||
          (error instanceof Error &&
            error.message === 'Provider subscriptions exhausted'))
      ) {
        throw Error('Provider subscription exhausted');
      }
      // A caller that fails gets no `usage` to await, so an endpoint a share
      // sits on is told this way that the request it lost was not free.
      if (revealExhaustion && isResponseLost(error)) {
        throw Error('Provider response lost');
      }
      return Fail`Provider request failed`;
    }
  };
  const admin = makeExo(
    'ProviderInferenceGrantAdmin',
    M.interface('ProviderInferenceGrantAdmin', {
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
          activeRequests,
          authMode,
        });
      },
    },
  );
  return harden({ endpoint, admin });
};
harden(makeProviderBrokerGrant);
