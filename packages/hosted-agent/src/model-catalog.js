// @ts-check

import { Fail } from '@endo/errors';

import { normalizeHostedModelDescriptor } from './hosted-backend.js';

/**
 * What one account's model catalog is, as the broker holds it between reads
 * of the provider: an observation of what the account may be served, with
 * the time it was taken. It is deliberately not durable. A daemon restart
 * reads the provider again through the same credential owner; nothing
 * replayed from it can spend anything or name a model the account no longer
 * lists. What is durable is the session plan's exact pin, which this checks
 * and never rewrites.
 *
 * - `current`: observed within the lifetime, and the last read succeeded.
 * - `stale`: an observation is held, but the provider could not be read
 *   since it aged past the lifetime, or the last read failed. Admission
 *   still trusts it until the maximum age, so a provider's catalog endpoint
 *   being down does not stop turns on models the account was seen to have.
 * - `unavailable`: nothing usable was observed. Nothing is admitted.
 * - `unsupported`: this account has no discovery at all. Nothing is admitted;
 *   missing discovery is not permission.
 *
 * @typedef {'current' | 'stale' | 'unavailable' | 'unsupported'} CatalogState
 * @typedef {ReturnType<typeof normalizeHostedModelDescriptor>} HostedModelDescriptor
 * @typedef {{ state: CatalogState, observedAt: number | null, models: HostedModelDescriptor[] }} CatalogSnapshot
 */

export const CATALOG_STATES = harden([
  'current',
  'stale',
  'unavailable',
  'unsupported',
]);

/** How long an observation counts as current before the provider is asked again. */
export const DEFAULT_CATALOG_LIFETIME_MS = 15 * 60_000;
harden(DEFAULT_CATALOG_LIFETIME_MS);

/** Past this age an observation admits nothing, however the provider fares. */
export const DEFAULT_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
harden(DEFAULT_CATALOG_MAX_AGE_MS);

/** After a failed read, how long before the provider is asked again. */
export const DEFAULT_CATALOG_RETRY_MS = 60_000;
harden(DEFAULT_CATALOG_RETRY_MS);

const MAX_CATALOG_MODELS = 4096;

/**
 * Validate what a provider read returned before anything trusts it: a
 * finite observation time and at most 4096 distinct hosted descriptors.
 *
 * @param {any} snapshot
 * @returns {{ observedAt: number, models: HostedModelDescriptor[] }}
 */
export const normalizeCatalogObservation = snapshot => {
  const observedAt = /** @type {unknown} */ (snapshot?.observedAt);
  (typeof observedAt === 'number' &&
    Number.isFinite(observedAt) &&
    observedAt >= 0 &&
    Array.isArray(snapshot.models) &&
    Number(snapshot.models.length) <= MAX_CATALOG_MODELS) ||
    Fail`Invalid provider model catalog`;
  const models = harden(
    /** @type {any[]} */ (snapshot.models).map(normalizeHostedModelDescriptor),
  );
  new Set(models.map(model => model.id)).size === models.length ||
    Fail`Duplicate provider model identity`;
  return harden({ observedAt: /** @type {number} */ (observedAt), models });
};
harden(normalizeCatalogObservation);

/**
 * One account's catalog owner. `read` is the provider read over that
 * account's existing credential owner (undefined where the provider has no
 * discovery). Reads are single-flight; a read already in flight answers
 * everybody who asks meanwhile.
 *
 * `snapshot()` is for showing: it reads again when the observation is past
 * its lifetime or the last read failed, so a picker sees the provider's
 * current answer, or `stale`/`unavailable` when it cannot be had.
 *
 * `admits(model)` is for a request being admitted: it answers from the
 * observation it holds when that is usable, and reads again in the
 * background once the observation is past its lifetime, so a turn is not
 * held behind the provider's catalog endpoint. Only with nothing usable does
 * it wait for a read.
 *
 * `close()` retires the owner: it admits nothing afterwards and reports
 * `unavailable`, and it waits for a read in flight, so that a member's
 * retirement is not acknowledged while a read can still use its credential.
 *
 * @param {object} powers
 * @param {(() => Promise<any>) | undefined} powers.read
 * @param {() => number} [powers.now]
 * @param {number} [powers.lifetimeMs]
 * @param {number} [powers.maxAgeMs]
 * @param {number} [powers.retryMs] After a failed read, how long before the
 *   provider is asked again, so an outage is not a read per request.
 */
export const makeModelCatalogOwner = ({
  read,
  now = Date.now,
  lifetimeMs = DEFAULT_CATALOG_LIFETIME_MS,
  maxAgeMs = DEFAULT_CATALOG_MAX_AGE_MS,
  retryMs = DEFAULT_CATALOG_RETRY_MS,
}) => {
  read === undefined ||
    typeof read === 'function' ||
    Fail`Model catalog read must be a function`;
  (Number.isFinite(lifetimeMs) &&
    lifetimeMs > 0 &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= lifetimeMs &&
    Number.isFinite(retryMs) &&
    retryMs >= 0) ||
    Fail`Invalid model catalog lifetimes`;
  /**
   * `readAt` is this owner's clock when the read completed, and is what the
   * observation ages by; `observedAt` is what the reader reported, shown as
   * data. The two agree in production and differ in a test with a scripted
   * reader, and it is how long since this owner heard that matters.
   * @type {{ readAt: number, observedAt: number, models: HostedModelDescriptor[], ids: Set<string> } | undefined}
   */
  let observation;
  let failed = false;
  /** @type {number | undefined} */
  let failedAt;
  /** @type {Promise<void> | undefined} */
  let refreshing;
  let closed = false;

  const age = () =>
    observation === undefined ? Infinity : now() - observation.readAt;
  const usable = () => observation !== undefined && age() < maxAgeMs;
  const fresh = () => observation !== undefined && age() < lifetimeMs;
  // Worth asking again: not current, and not just refused.
  const due = () =>
    !closed &&
    read !== undefined &&
    (!fresh() || failed) &&
    (failedAt === undefined || now() - failedAt >= retryMs);

  /** Never rejects: failure is a state, not an error, and never carries a cause. */
  const refresh = () => {
    if (refreshing !== undefined) return refreshing;
    const attempt = (async () => {
      await null;
      if (closed || read === undefined) return;
      try {
        const next = normalizeCatalogObservation(await read());
        if (closed) return;
        observation = {
          readAt: now(),
          observedAt: next.observedAt,
          models: next.models,
          ids: new Set(next.models.map(model => model.id)),
        };
        failed = false;
      } catch (_error) {
        // The read's failure may quote a credential or a provider body.
        failed = true;
        failedAt = now();
      }
    })().finally(() => {
      if (refreshing === attempt) refreshing = undefined;
    });
    refreshing = attempt;
    return attempt;
  };

  /** @returns {CatalogSnapshot} */
  const project = () => {
    if (read === undefined) {
      return harden({ state: 'unsupported', observedAt: null, models: [] });
    }
    if (closed || !usable()) {
      return harden({ state: 'unavailable', observedAt: null, models: [] });
    }
    const current = /** @type {NonNullable<typeof observation>} */ (
      observation
    );
    return harden({
      state: failed || !fresh() ? 'stale' : 'current',
      observedAt: current.observedAt,
      models: current.models,
    });
  };

  return harden({
    /** @returns {Promise<CatalogSnapshot>} */
    snapshot: async () => {
      // A read in flight is awaited whether or not one is due: it may be
      // the answer.
      if (refreshing !== undefined || due()) await refresh();
      return project();
    },
    /**
     * @param {string} model
     * @returns {Promise<boolean>}
     */
    admits: async model => {
      if (closed || read === undefined || typeof model !== 'string') {
        return false;
      }
      if (!usable()) {
        if (refreshing !== undefined || due()) await refresh();
      } else if (due()) {
        void refresh();
      }
      return (
        !closed &&
        usable() &&
        /** @type {NonNullable<typeof observation>} */ (observation).ids.has(
          model,
        )
      );
    },
    /** What is held now, without asking the provider. */
    peek: project,
    close: async () => {
      closed = true;
      observation = undefined;
      await refreshing;
    },
  });
};
harden(makeModelCatalogOwner);
