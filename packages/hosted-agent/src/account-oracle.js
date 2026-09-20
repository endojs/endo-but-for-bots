// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeLatestTopic } from './latest-topic.js';

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
 * @param {() => Promise<any>} [options.watchObserved] - A stream of live
 *   readings in that raw shape (an exo-stream reader, or undefined when the
 *   source has none), for a source that
 *   learns of the account as a side effect of serving requests. Each reading
 *   is pushed into the answer as it arrives; nothing is polled.
 * @param {() => Promise<void>} [options.refreshObserved] - Ask the source to
 *   read its provider now. Run only by an explicit `refresh()`, never by a
 *   first read, so an oracle nobody refreshed makes no request of its own.
 * @param {{ read: () => Promise<any>, write: (snapshot: any) => Promise<void> }} [options.journal]
 * @param {() => string} [options.now] - ISO 8601 clock, injectable for tests.
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 */
export const makeAccountOracle = ({
  providerId,
  provideDeclared,
  provideObserved,
  watchObserved,
  refreshObserved,
  journal,
  now = () => new Date().toISOString(),
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
}) => {
  (typeof providerId === 'string' && providerId !== '') ||
    Fail`Account oracle requires a providerId`;

  /** @type {any} */
  let snapshot;
  /** @type {Promise<any> | undefined} */
  let refreshP;
  // What the journal holds: the observed sections last written. A pushed
  // reading is written only when it differs from this materially.
  /** @type {Record<string, any>} */
  let journalled = {};
  let journalLoaded = false;
  const topic = makeLatestTopic();

  const SECTIONS = harden(['plan', 'rateLimits', 'rateCard']);

  /**
   * What of a record is worth a write. A reading arrives with every inference
   * response and its percentages creep; what a restart must not forget is
   * coarser: whether the account may spend, when its windows reset, its plan,
   * its credits, and roughly how full each window is. Five-point steps keep a
   * busy session to a handful of writes per window.
   *
   * @param {Record<string, any>} record
   */
  const materialOf = record => {
    const { plan, rateLimits, rateCard } = record;
    return JSON.stringify({
      plan: plan && [plan.planId, plan.state, plan.renewsAt, `${plan.seats}`],
      rates: rateCard && rateCard.rates.map(rate => `${rate.modelId}`),
      limits: rateLimits && {
        reached: rateLimits.limitReached,
        credits: rateLimits.credits && [
          rateLimits.credits.hasCredits,
          rateLimits.credits.unlimited,
          `${rateLimits.credits.balance ?? ''}`.split('.')[0],
        ],
        resets: rateLimits.resetCredits && [
          rateLimits.resetCredits.availableCount,
          (rateLimits.resetCredits.credits ?? []).map(credit => [
            credit.id,
            credit.status,
            credit.expiresAt,
          ]),
        ],
        windows: rateLimits.windows.map(window => [
          window.windowId,
          window.resetsAt,
          window.usedFraction === null
            ? null
            : Math.floor(window.usedFraction * 20),
          Number(window.usedFraction ?? 0) >= 1,
          `${window.limit}`,
        ]),
      },
    });
  };

  /**
   * The sections of a stored snapshot that were genuinely observed.
   *
   * Only a live reading is worth remembering, and only a live reading may be
   * replayed as one. A stored section marked `declared` or `unavailable` is
   * dropped rather than re-stamped: replaying a declaration as a `remembered`
   * observation is exactly the laundering this module exists to prevent, and
   * it is what a snapshot written before this check could contain.
   *
   * @param {any} stored
   */
  const observedSectionsOf = stored => {
    /** @type {any} */
    const out = {};
    if (!stored || typeof stored !== 'object') return harden(out);
    for (const section of SECTIONS) {
      const value = stored[section];
      if (value && typeof value === 'object' && value.source === 'observed') {
        out[section] = value;
      }
    }
    return harden(out);
  };

  /**
   * Re-stamp the observed sections of a stored snapshot. Their numbers were
   * true when they were written and may not be now, so each is downgraded to
   * `remembered`.
   *
   * @param {any} stored
   */
  const asRemembered = stored => {
    const observedSections = observedSectionsOf(stored);
    /** @type {any} */
    const out = {};
    const normalize = {
      plan: normalizeAccountPlan,
      rateLimits: normalizeRateLimits,
      rateCard: normalizeRateCard,
    };
    for (const section of SECTIONS) {
      if (observedSections[section]) {
        try {
          out[section] = normalize[section]({
            ...observedSections[section],
            source: 'remembered',
          });
        } catch (error) {
          // Per section, so one snapshot written before a normalizer was
          // tightened does not take the other two down with it — and, because
          // this never throws, does not stop the journal being written and
          // superseded. A stored section nothing can read is one nothing
          // remembers.
          console.error(
            `[account-oracle] ${providerId}: stored ${section} is unreadable and will be replaced: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return harden(out);
  };

  /**
   * @param {any} raw
   * @param {string} source
   * @param {string} observedAt
   */
  /**
   * When a section's figures were taken.
   *
   * The source's own answer wins, because only it knows: a backend that caches
   * provider quota reports the instant it actually queried, and overwriting
   * that with the local clock would present hour-old numbers as measured just
   * now. But it is bounded by that clock — a reading cannot have been taken
   * later than the moment it was read — and canonicalized, so a stamp that
   * would make a stale figure look fresh, or that is not an instant at all,
   * falls back rather than being replayed to a model as gospel.
   *
   * @param {unknown} reported
   * @param {string} fallback
   */
  const observedAtFrom = (reported, fallback) => {
    if (typeof reported !== 'string' || reported === '') return fallback;
    const parsed = Date.parse(reported);
    if (!Number.isFinite(parsed)) return fallback;
    const limit = Date.parse(fallback);
    // `!Number.isFinite(limit)`, not `parsed > limit`: an injected clock that
    // is not an instant makes every comparison false, which would silently
    // turn the clamp off — accepting exactly the future stamps it exists to
    // refuse.
    if (!Number.isFinite(limit) || parsed > limit) return fallback;
    return new Date(parsed).toISOString();
  };

  const project = (raw, source, observedAt) => {
    if (!raw || typeof raw !== 'object') return harden({});
    /** @type {any} */
    const out = {};
    /**
     * Per section, so one unreadable figure costs its own section and not the
     * whole reading. All-or-nothing projection meant a plan with a malformed
     * timestamp discarded a perfectly good rate-limit reading beside it — and,
     * because only an observed section is journalled, stopped the journal
     * being written at all.
     *
     * @param {string} section
     * @param {(candidate: any) => any} normalize
     */
    const take = (section, normalize) => {
      if (!raw[section]) return;
      try {
        out[section] = normalize({
          ...raw[section],
          observedAt: observedAtFrom(raw[section].observedAt, observedAt),
          source,
        });
      } catch (error) {
        console.error(
          `[account-oracle] ${providerId}: ${source} ${section} is unusable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    // `source` and `providerId` are stamped *after* the payload. Spread first,
    // a source that names its own `source` decides whether the oracle presents
    // its figures as measured — a declared profile could claim `observed`, and
    // an observed payload could disown itself — and `providerId` would be
    // whatever the payload said rather than the credential this oracle
    // describes. Whose reading this is, and how much to trust it, are the
    // oracle's to state; when it was taken is the source's, within bounds.
    take('plan', candidate =>
      normalizeAccountPlan({ ...candidate, providerId }),
    );
    take('rateLimits', normalizeRateLimits);
    take('rateCard', normalizeRateCard);
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
    let stored;
    let storedUnreadable = false;
    if (journal) {
      try {
        stored = await journal.read();
      } catch (error) {
        storedUnreadable = true;
        console.error(
          `[account-oracle] ${providerId}: stored snapshot unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // `asRemembered` swallows a malformed section rather than throwing, so a
    // bad stored snapshot never blocks the write that would replace it.
    const remembered = stored ? asRemembered(stored) : {};
    if (!storedUnreadable) {
      journalled = {};
      for (const section of SECTIONS) {
        if (remembered[section]) {
          journalled[section] = harden({
            ...remembered[section],
            source: 'observed',
          });
        }
      }
      journalLoaded = true;
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

    // What gets journalled is the *observed* sections, over whatever was
    // observed before — never the merged answer above.
    //
    // The merged answer carries a declared section wherever the provider
    // published nothing, and `asRemembered` would replay that as a past
    // observation: an assertion laundered into a measurement. It also carries
    // `unavailable` for a section the provider happened not to answer this
    // time, which would erase a real earlier reading of it.
    //
    // A journal that could not be read is not written either: with no idea
    // what is already there, a partial live read would replace it wholesale.
    if (journal && !storedUnreadable) {
      const record = {};
      for (const section of SECTIONS) {
        // A section the provider did not answer this time keeps its previous
        // reading *and its original `observedAt`*, so it reads as `remembered`
        // with the instant it was actually taken. That is what lets a consumer
        // judge a figure the provider has quietly stopped publishing: it does
        // not expire, but it visibly ages.
        const carried = remembered[section]
          ? harden({ ...remembered[section], source: 'observed' })
          : undefined;
        const value = observed[section] || carried;
        if (value) record[section] = value;
      }
      if (SECTIONS.some(section => observed[section])) {
        try {
          await journal.write(harden(record));
          journalled = { ...record };
        } catch (error) {
          console.error(
            `[account-oracle] ${providerId}: could not persist snapshot: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return next;
  };

  // Everything that changes the answer or the journal runs in this one
  // order: a whole build, or one pushed reading. A reading pushed while a
  // build was reading the journal used to be applied and then overwritten by
  // that build's older view of the source, in the answer and in the journal —
  // and a drained account serves nothing more, so nothing ever corrected it.
  /** @type {Promise<unknown>} */
  let order = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  const inOrder = step => {
    const result = order.then(step);
    order = result.catch(() => {});
    return result;
  };

  const adopt = (/** @type {any} */ next) => {
    snapshot = next;
    topic.publish(next);
    return next;
  };

  /**
   * Concurrent readers share one live read rather than racing to overwrite
   * the journal.
   */
  const refresh = () => {
    if (!refreshP) {
      refreshP = inOrder(build).then(
        next => {
          refreshP = undefined;
          return adopt(next);
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

  /**
   * A reading the source pushed. It replaces the observed sections of the
   * answer at once, is published to watchers, and is journalled only when it
   * differs materially from what the journal holds.
   *
   * @param {unknown} raw
   */
  const applyObserved = raw =>
    inOrder(async () => {
      // A build inside the order, not `current()`: that would queue a build
      // behind this step and wait for it.
      const base = snapshot || adopt(await build());
      const observed = project(raw, 'observed', now());
      if (!SECTIONS.some(section => observed[section])) return;
      adopt(harden({ ...base, ...observed }));
      if (!journal) return;
      if (!journalLoaded) {
        // The journal could not be read when the answer was built. Without
        // knowing what it holds a partial reading would replace it wholesale,
        // so look again before writing, and leave it alone if it still fails.
        try {
          const stored = await journal.read();
          journalled = {};
          const remembered = stored ? asRemembered(stored) : {};
          for (const section of SECTIONS) {
            if (remembered[section]) {
              journalled[section] = harden({
                ...remembered[section],
                source: 'observed',
              });
            }
          }
          journalLoaded = true;
        } catch (_error) {
          return;
        }
      }
      const record = { ...journalled, ...observed };
      if (materialOf(record) === materialOf(journalled)) return;
      try {
        await journal.write(harden(record));
        journalled = record;
      } catch (error) {
        console.error(
          `[account-oracle] ${providerId}: could not persist snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });

  // One subscription to the source's readings, started by the first reader
  // and restarted, with a growing pause, only while somebody is watching: a
  // source that was re-minted ends its stream, and nobody polls an oracle
  // that has no audience. There is at most one loop and one pending retry.
  let watching = false;
  let retryPending = false;
  let retryMs = 5000;
  let failureLogged = false;
  const ensureWatching = () => {
    if (watching || retryPending || watchObserved === undefined) return;
    watching = true;
    void (async () => {
      try {
        const ref = await watchObserved();
        // A source with nothing to subscribe to is not retried on a timer;
        // the next reader asks again, which is how a source bound later is
        // found.
        if (ref === undefined) {
          watching = false;
          return;
        }
        const readings = iterateReader(ref);
        for await (const raw of readings) {
          retryMs = 5000;
          failureLogged = false;

          await applyObserved(raw).catch(() => {});
        }
      } catch (error) {
        // Once per outage, not once per attempt.
        if (!failureLogged) {
          failureLogged = true;
          console.error(
            `[account-oracle] ${providerId}: reading stream failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      watching = false;
      if (topic.watcherCount() > 0) {
        retryPending = true;
        setTimer(() => {
          retryPending = false;
          ensureWatching();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 60_000);
      }
    })();
  };

  return makeExo('HostedAccount', HostedAccountInterface, {
    async getPlan() {
      await null;
      ensureWatching();
      return (await current()).plan;
    },

    async getRateLimits() {
      await null;
      ensureWatching();
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
      await null;
      ensureWatching();
      if (refreshObserved !== undefined) {
        try {
          await refreshObserved();
        } catch (error) {
          console.error(
            `[account-oracle] ${providerId}: provider read failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return refresh();
    },

    /**
     * The whole answer, `{ plan, rateLimits, rateCard }`, now and whenever it
     * changes, coalesced to the newest. Subscribe instead of asking again.
     */
    watch() {
      ensureWatching();
      if (snapshot === undefined) void current().catch(() => {});
      return topic.watch();
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
        watch:
          'watch() — A disposable stream of { plan, rateLimits, rateCard }: the current answer, then each change, coalesced to the newest. A rate-limit window carries usedPercent and resetsAt; rateLimits also carries limitReached, credits and resetCredits.',
      };
      if (methodName === undefined) {
        return 'Account oracle: getPlan(), getRateLimits(), getRateCard(), estimateCost(usage), refresh(), watch(). Every answer carries observedAt and a source of observed | declared | remembered | unavailable.';
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
