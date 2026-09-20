// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeSecretRotator } from './secret-rotator.js';

/**
 * @typedef {{version: 'BrokerOAuthRefreshStateV1', refreshToken: string,
 * accountId: string, scopes: string[], pendingRefresh?: {startedAt: number}}} BrokerOAuthRefreshState
 * @typedef {{version: 'BrokerOAuthStateV1', accessToken: string,
 * expiresAt: number, accountId: string}} AccessState
 */

/**
 * @param {unknown} value
 * @returns {BrokerOAuthRefreshState}
 */
export const assertBrokerOAuthRefreshState = value => {
  const state = /** @type {any} */ (value);
  (state &&
    typeof state === 'object' &&
    !Array.isArray(state) &&
    state.version === 'BrokerOAuthRefreshStateV1' &&
    typeof state.refreshToken === 'string' &&
    /^[\x21-\x7e]+$/.test(state.refreshToken) &&
    typeof state.accountId === 'string' &&
    /^[\x20-\x7e]{1,256}$/.test(state.accountId) &&
    Array.isArray(state.scopes) &&
    state.scopes.every(
      scope => typeof scope === 'string' && /^[\x21-\x7e]+$/.test(scope),
    )) ||
    Fail`Invalid broker renewal credential`;
  const { pendingRefresh } = state;
  pendingRefresh === undefined ||
    (pendingRefresh &&
      typeof pendingRefresh === 'object' &&
      !Array.isArray(pendingRefresh) &&
      typeof pendingRefresh.startedAt === 'number' &&
      Number.isFinite(pendingRefresh.startedAt)) ||
    Fail`Invalid broker renewal intent`;
  // Explicit projection: neither imported access tokens nor provider metadata
  // may hitch a ride on a durable renewal write.
  return harden({
    version: /** @type {const} */ ('BrokerOAuthRefreshStateV1'),
    refreshToken: state.refreshToken,
    accountId: state.accountId,
    scopes: [...state.scopes],
    ...(pendingRefresh === undefined
      ? {}
      : { pendingRefresh: { startedAt: pendingRefresh.startedAt } }),
  });
};
harden(assertBrokerOAuthRefreshState);

/**
 * One renewal owner per Secret. Only renewal authority is durable; access
 * tokens live in this object's cache, keyed by the Secret generation. Restart
 * requires a new exchange. Every exchange first writes an intent, and only a
 * successful generation-pinned result write allows its access token to escape.
 * An ambiguous outcome leaves the intent in place, including across restart.
 * Account identity is the operator's binding, not a provider-verified claim.
 *
 * @param {object} powers
 * @param {{readBase64WithGeneration(): Promise<{base64:string,generation:bigint}>}} powers.secret
 * @param {{replaceBase64(base64:string, options?:{ifGeneration?:bigint}):Promise<unknown>}} powers.rotate
 * @param {{refresh(request:{refreshToken:string,accountId:string,scopes:string[]}):Promise<unknown>}} powers.refresh
 * @param {string} powers.accountRef
 * @param {()=>number} powers.now
 * @param {number} [powers.refreshSkewMs]
 */
export const makeBrokerMemoryOAuthCredential = ({
  secret,
  rotate: admin,
  refresh,
  accountRef,
  now,
  refreshSkewMs = 60_000,
}) => {
  (secret && refresh && typeof now === 'function') ||
    Fail`Unprovisioned broker renewal credential`;
  (typeof accountRef === 'string' && /^[\x20-\x7e]{1,256}$/.test(accountRef)) ||
    Fail`Invalid broker account binding`;
  (Number.isInteger(refreshSkewMs) &&
    refreshSkewMs >= 0 &&
    refreshSkewMs <= 0x7fff_ffff) ||
    Fail`Invalid broker refresh skew`;
  const rotate = makeSecretRotator(admin);
  /** @type {{generation:bigint, state:AccessState}|undefined} */
  let cache;
  /** @type {Promise<{state:AccessState,outcome:'unchanged'|'refreshed'}>|undefined} */
  let refreshing;
  const read = async () => {
    const record = await E(secret).readBase64WithGeneration();
    (record &&
      typeof record.base64 === 'string' &&
      typeof record.generation === 'bigint') ||
      Fail`Invalid credential`;
    let parsed;
    try {
      parsed = JSON.parse(globalThis.atob(record.base64));
    } catch (_error) {
      Fail`Invalid credential`;
    }
    const state = assertBrokerOAuthRefreshState(parsed);
    state.accountId === accountRef || Fail`Broker account binding changed`;
    if (cache?.generation !== record.generation) cache = undefined;
    return harden({ state, generation: record.generation });
  };
  /** @param {string} [rejected] */
  const cached = rejected => {
    const time = now();
    Number.isFinite(time) || Fail`Invalid broker clock`;
    return cache &&
      time + refreshSkewMs < cache.state.expiresAt &&
      cache.state.accessToken !== rejected
      ? cache.state
      : undefined;
  };
  /** @param {string} [rejected] */
  const exchange = rejected => {
    if (refreshing) return refreshing;
    const started = (async () => {
      await null;
      const { state, generation } = await read();
      const access = cached(rejected);
      if (access)
        return harden({
          state: access,
          outcome: /** @type {const} */ ('unchanged'),
        });
      state.pendingRefresh === undefined || Fail`Broker credential consumed`;
      const startedAt = now();
      Number.isFinite(startedAt) || Fail`Invalid broker clock`;
      cache = undefined;
      const intentGeneration = await E(rotate).replaceBase64(
        globalThis.btoa(
          JSON.stringify({ ...state, pendingRefresh: { startedAt } }),
        ),
        harden({ ifGeneration: generation }),
      );
      if (typeof intentGeneration !== 'bigint')
        throw Fail`Broker refresh intent unusable`;
      const result = /** @type {any} */ (
        await E(refresh).refresh(
          harden({
            refreshToken: state.refreshToken,
            accountId: state.accountId,
            scopes: state.scopes,
          }),
        )
      );
      (result &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        result.version === 'BrokerOAuthStateV1' &&
        typeof result.accessToken === 'string' &&
        /^[\x21-\x7e]+$/.test(result.accessToken) &&
        typeof result.expiresAt === 'number' &&
        Number.isFinite(result.expiresAt)) ||
        Fail`Invalid broker OAuth state`;
      result.accountId === accountRef || Fail`Broker account binding changed`;
      const expiresAt = /** @type {number} */ (result.expiresAt);
      const time = now();
      (Number.isFinite(time) && expiresAt > time + refreshSkewMs) ||
        Fail`Broker refresh did not advance expiry`;
      const durable = assertBrokerOAuthRefreshState({
        version: 'BrokerOAuthRefreshStateV1',
        refreshToken: result.refreshToken ?? state.refreshToken,
        accountId: accountRef,
        scopes: result.scopes ?? state.scopes,
      });
      const committed = await E(rotate).replaceBase64(
        globalThis.btoa(JSON.stringify(durable)),
        harden({ ifGeneration: intentGeneration }),
      );
      if (typeof committed !== 'bigint')
        throw Fail`Broker credential rotation failed`;
      const accessState = harden({
        version: /** @type {const} */ ('BrokerOAuthStateV1'),
        accessToken: result.accessToken,
        expiresAt,
        accountId: accountRef,
      });
      cache = { generation: committed, state: accessState };
      // Observe an operator replacement before handing out the new token.
      const current = await read();
      current.generation === committed ||
        Fail`Broker credential replaced during renewal`;
      return harden({
        state: accessState,
        outcome: /** @type {const} */ ('refreshed'),
      });
    })().finally(() => {
      refreshing = undefined;
    });
    refreshing = started;
    return started;
  };
  return harden({
    accountRef,
    /** @param {{rejected?:string}} [options] */
    async current({ rejected } = {}) {
      // Join first: a read during our own intent must not invalidate the cache
      // belonging to the result that the same in-flight exchange will commit.
      if (refreshing) return refreshing;
      await read();
      const state = cached(rejected);
      if (state)
        return harden({ state, outcome: /** @type {const} */ ('unchanged') });
      return exchange(rejected);
    },
  });
};
harden(makeBrokerMemoryOAuthCredential);
