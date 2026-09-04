// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import {
  HostedAccountInterface,
  estimateCostAtRate,
  formatMicroUnits,
  normalizeAccountPlan,
  normalizeRateCard,
  normalizeRateLimits,
  unknownPlan,
  unknownRateCard,
  unknownRateLimits,
} from './account.js';

/**
 * Build the read-only account facet over two sources and one durable memory.
 *
 * The oracle exists because plan and quota are facts about the *account behind
 * a credential*, not about the credential: they change while the capability
 * stays the same, and they must be answerable to a UI, a session, or a model
 * that must never hold the credential itself.
 *
 * Three things can be true of any answer, and the snapshot always says which:
 * it was observed from the provider just now, it was declared by the operator,
 * or it is the last durable observation replayed because the provider could not
 * be reached (or because the daemon restarted). Nothing is ever fabricated —
 * a provider that publishes no plan yields `source: 'unavailable'`, which is a
 * more useful answer than an invented one.
 *
 * @param {object} options
 * @param {string} options.providerId
 * @param {() => Promise<any>} [options.provideDeclared] - The operator's
 *   configured profile: `{ plan?, rateLimits?, rateCard? }` in raw form.
 * @param {() => Promise<any>} [options.provideObserved] - A live read from the
 *   provider or a hosted backend, in the same raw shape. Failures are
 *   swallowed into `remembered`/`declared`, never propagated to a reader.
 * @param {{ read: () => Promise<any>, write: (snapshot: any) => Promise<void> }} [options.journal]
 * @param {() => string} [options.now] - ISO 8601 clock, injectable for tests.
 */
export const makeAccountOracle = ({
  providerId,
  provideDeclared,
  provideObserved,
  journal,
  now = () => new Date().toISOString(),
}) => {
  (typeof providerId === 'string' && providerId !== '') ||
    Fail`Account oracle requires a providerId`;

  /** @type {any} */
  let snapshot;
  /** @type {Promise<any> | undefined} */
  let refreshP;

  /**
   * Re-stamp a snapshot loaded from the journal. Its numbers were true when
   * they were written and may not be now, so every section is downgraded to
   * `remembered` — except one that was already `unavailable`, which stays
   * unavailable rather than becoming a memory of nothing.
   *
   * @param {any} stored
   */
  const asRemembered = stored => {
    /** @param {any} section */
    const remember = section =>
      section.source === 'unavailable'
        ? section
        : { ...section, source: 'remembered' };
    return harden({
      plan: normalizeAccountPlan(remember(stored.plan)),
      rateLimits: normalizeRateLimits(remember(stored.rateLimits)),
      rateCard: normalizeRateCard(remember(stored.rateCard)),
    });
  };

  /**
   * @param {any} raw
   * @param {string} source
   * @param {string} observedAt
   */
  const project = (raw, source, observedAt) => {
    if (!raw || typeof raw !== 'object') return harden({});
    /** @type {any} */
    const out = {};
    if (raw.plan) {
      out.plan = normalizeAccountPlan({
        providerId,
        observedAt,
        source,
        ...raw.plan,
      });
    }
    if (raw.rateLimits) {
      out.rateLimits = normalizeRateLimits({
        observedAt,
        source,
        ...raw.rateLimits,
      });
    }
    if (raw.rateCard) {
      out.rateCard = normalizeRateCard({ observedAt, source, ...raw.rateCard });
    }
    return harden(out);
  };

  const build = async () => {
    await null;
    const observedAt = now();
    /** @type {any} */
    let observed = {};
    if (provideObserved) {
      try {
        observed = project(await provideObserved(), 'observed', observedAt);
      } catch (error) {
        // A provider that cannot be reached must not take the whole answer
        // down: the caller still gets the declared or remembered view, marked
        // as such.
        console.error(
          `[account-oracle] ${providerId}: live read failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    /** @type {any} */
    let declared = {};
    if (provideDeclared) {
      try {
        declared = project(await provideDeclared(), 'declared', observedAt);
      } catch (error) {
        console.error(
          `[account-oracle] ${providerId}: declared profile unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    /** @type {any} */
    let remembered = {};
    if (journal) {
      try {
        const stored = await journal.read();
        if (stored) remembered = asRemembered(stored);
      } catch (error) {
        console.error(
          `[account-oracle] ${providerId}: stored snapshot unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const next = harden({
      plan:
        observed.plan ||
        declared.plan ||
        remembered.plan ||
        unknownPlan(providerId, observedAt),
      rateLimits:
        observed.rateLimits ||
        declared.rateLimits ||
        remembered.rateLimits ||
        unknownRateLimits(observedAt),
      rateCard:
        observed.rateCard ||
        declared.rateCard ||
        remembered.rateCard ||
        unknownRateCard(observedAt),
    });
    // Only a live read is worth remembering. Writing back a declared or
    // remembered view would launder an assertion into an observation and
    // overwrite a real measurement with it.
    if (
      journal &&
      (observed.plan || observed.rateLimits || observed.rateCard)
    ) {
      try {
        await journal.write(next);
      } catch (error) {
        console.error(
          `[account-oracle] ${providerId}: could not persist snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return next;
  };

  /**
   * Serialize refreshes so concurrent readers share one live read rather than
   * racing to overwrite the journal.
   */
  const refresh = () => {
    if (!refreshP) {
      refreshP = build().then(
        next => {
          snapshot = next;
          refreshP = undefined;
          return next;
        },
        error => {
          refreshP = undefined;
          throw error;
        },
      );
    }
    return refreshP;
  };

  const current = async () => snapshot || refresh();

  return makeExo('HostedAccount', HostedAccountInterface, {
    async getPlan() {
      await null;
      return (await current()).plan;
    },

    async getRateLimits() {
      await null;
      return (await current()).rateLimits;
    },

    async getRateCard() {
      await null;
      return (await current()).rateCard;
    },

    /**
     * Estimate what a token count costs at the current list price.
     *
     * The guard admits any record, so the shape is checked here rather than
     * asserted in the signature: this is the boundary where an untyped caller
     * arrives.
     *
     * @param {Record<string, any>} usage - `{ modelId, inputTokens?,
     *   outputTokens?, cachedInputTokens? }` with bigint counts.
     */
    async estimateCost(usage) {
      const modelId = usage?.modelId;
      (typeof modelId === 'string' && modelId !== '') ||
        Fail`estimateCost requires a modelId, got ${q(modelId)}`;
      const { rateCard } = await current();
      const rate = rateCard.rates.find(entry => entry.modelId === modelId);
      const estimate = estimateCostAtRate(usage, rate);
      return harden({
        modelId,
        currency: estimate.currency,
        microUnits: estimate.microUnits,
        display: formatMicroUnits(estimate.microUnits, estimate.currency),
        // What the rate card could not price. A non-empty list means the
        // amount above is a floor, not the cost.
        missing: estimate.missing,
        source: rateCard.source,
        observedAt: rateCard.observedAt,
      });
    },

    async refresh() {
      return refresh();
    },

    /** @param {string} [methodName] */
    help(methodName) {
      const docs = {
        getPlan:
          'getPlan() — The subscription plan behind this credential: { providerId, planId, title, state, renewsAt, seats, observedAt, source }.',
        getRateLimits:
          'getRateLimits() — Rate-limit windows: { windows: [{ windowId, title, limit, used, remaining, usedFraction, resetsAt }], observedAt, source }. Counts are bigints; a null means the provider does not publish that figure.',
        getRateCard:
          'getRateCard() — List prices per model, as integer micro-units of the currency per million tokens.',
        estimateCost:
          'estimateCost({ modelId, inputTokens, outputTokens, cachedInputTokens }) — Cost of a token count at the current list price, in micro-units. `missing` names what the rate card could not price.',
        refresh:
          'refresh() — Re-read the provider now and persist the result, so the next answer is observed rather than remembered.',
      };
      if (methodName === undefined) {
        return 'Account oracle: getPlan(), getRateLimits(), getRateCard(), estimateCost(usage), refresh(). Every answer carries observedAt and a source of observed | declared | remembered | unavailable.';
      }
      return docs[methodName] || `No documentation for method "${methodName}".`;
    },
  });
};
harden(makeAccountOracle);

/**
 * A durable, append-only snapshot journal over an Endo pet store.
 *
 * Same recipe as Floot's session registry: every version has a unique name, so
 * a crash leaves either the previous complete snapshot or the next one and can
 * never erase the sole record. Reads take the highest-numbered entry.
 *
 * @param {object} options
 * @param {any} options.powers - A namespace with has/list/lookup/storeValue.
 * @param {string} [options.prefix]
 * @param {number} [options.keep] - Older snapshots to retain.
 */
export const makeAccountJournal = ({
  powers,
  prefix = 'account-snapshot-v1-',
  keep = 4,
}) => {
  const sequenceWidth = 20;
  const namePattern = new RegExp(`^${prefix}[0-9]{${sequenceWidth}}$`);
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  const listNames = async () => {
    const names = await E(powers).list();
    return (Array.isArray(names) ? names : [])
      .filter(name => typeof name === 'string' && namePattern.test(name))
      .sort();
  };

  return harden({
    read: async () => {
      const names = await listNames();
      if (names.length === 0) return undefined;
      return E(powers).lookup(names[names.length - 1]);
    },
    /** @param {any} snapshot */
    write: async snapshot => {
      const result = writeChain.then(async () => {
        const names = await listNames();
        const last = names[names.length - 1];
        const sequence = last ? BigInt(last.slice(prefix.length)) + 1n : 0n;
        const name = `${prefix}${`${sequence}`.padStart(sequenceWidth, '0')}`;
        await E(powers).storeValue(snapshot, name);
        // Trim only after the new snapshot is durable, so the journal is never
        // momentarily empty.
        for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
          // eslint-disable-next-line no-await-in-loop
          await E(powers)
            .remove(stale)
            .catch(() => {});
        }
      });
      writeChain = result.catch(() => {});
      return result;
    },
  });
};
harden(makeAccountJournal);
