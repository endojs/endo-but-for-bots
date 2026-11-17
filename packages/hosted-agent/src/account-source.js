// @ts-check

import { makeExo } from '@endo/exo';
import { Fail } from '@endo/errors';
import { M } from '@endo/patterns';

import { makeLatestTopic } from './latest-topic.js';

/**
 * What a provider broker knows about the account behind its credential, as a
 * capability that cannot reach the credential.
 *
 * A broker's transport reads the rate-limit headers of every inference
 * response (`rate-limit-headers.js`) and hands each reading to `accept`. This
 * keeps the newest, merged over what it already had, and offers it to an
 * account oracle three ways:
 *
 * - `observe()` — the last reading, from memory. **It never touches the
 *   network**, so an oracle that asks on its first read after a restart stays
 *   dormant, and gets `{}` until a request has been served.
 * - `watch()` — that reading now and each later one, coalesced.
 * - `refresh()` — one active read of the provider, where the adapter supplied
 *   one (OpenRouter's key endpoint, Codex's usage endpoint). Only ever on
 *   request. Without one it does nothing: the headers are the mechanism.
 *
 * A reading is raw account data, `{ plan?, rateLimits? }`, in the shape
 * `account-oracle.js` normalizes. It is not durable here; the oracle journals.
 */
export const ProviderAccountSourceInterface = M.interface(
  'ProviderAccountSource',
  {
    observe: M.call().returns(M.promise()),
    watch: M.call().returns(M.remotable()),
    refresh: M.call().returns(M.promise()),
    help: M.call().optional(M.string()).returns(M.string()),
  },
);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ProviderAccountSourceInterface);

/**
 * @param {object} [options]
 * @param {() => string} [options.now] ISO 8601 clock.
 * @param {() => Promise<any>} [options.activeRead] One read of the provider,
 *   returning a raw reading or undefined. Host-only: it holds the credential.
 * @param {(error: unknown) => void} [options.reportError]
 * @param {() => void} [options.onChange] Called after each reading is kept.
 */
export const makeAccountReadingSource = ({
  now = () => new Date().toISOString(),
  activeRead,
  reportError = () => {},
  onChange = () => {},
} = {}) => {
  /** @type {{ plan?: any, rateLimits?: any }} */
  let last = harden({});
  const topic = makeLatestTopic();
  /** @type {Promise<void> | undefined} */
  let refreshing;
  let closed = false;
  const checkLive = () => {
    !closed || Fail`Provider account source is closed`;
  };

  /**
   * Merge a reading over the last. Headers carry the windows and the credit
   * balance; only an active read carries the plan and the banked resets. A
   * section or a field one kind of reading never has must not erase what the
   * other kind learned.
   *
   * @param {any} reading
   */
  const accept = reading => {
    if (closed) return;
    if (reading === null || typeof reading !== 'object') return;
    const observedAt = now();
    /** @type {{ plan?: any, rateLimits?: any }} */
    const next = { ...last };
    if (reading.plan && typeof reading.plan === 'object') {
      next.plan = harden({ ...reading.plan, observedAt });
    }
    if (reading.rateLimits && typeof reading.rateLimits === 'object') {
      const before = last.rateLimits ?? {};
      const incoming = reading.rateLimits;
      // Windows merge by id: a response that names one window, or none (a
      // refusal can carry only the word that the limit is reached), must not
      // erase the others and the reset times they carry.
      const windows = new Map();
      for (const window of before.windows ?? []) {
        windows.set(window.windowId, window);
      }
      for (const window of Array.isArray(incoming.windows)
        ? incoming.windows
        : []) {
        windows.set(window.windowId, window);
      }
      // Credits and banked resets keep the time they were read. Carried under
      // a newer reading of the windows they would otherwise pass for fresh.
      const stamped = (/** @type {any} */ section) =>
        section && typeof section === 'object'
          ? { ...section, observedAt }
          : undefined;
      const credits = stamped(incoming.credits) ?? before.credits;
      const resetCredits =
        stamped(incoming.resetCredits) ?? before.resetCredits;
      next.rateLimits = harden({
        windows: [...windows.values()],
        limitReached: incoming.limitReached === true,
        ...(credits === undefined ? {} : { credits }),
        ...(resetCredits === undefined ? {} : { resetCredits }),
        observedAt,
      });
    }
    last = harden(next);
    topic.publish(last);
    // For the broker's own status (`broker-subscription.js`); a hook of the
    // host's that must not change how a reading is kept.
    try {
      onChange();
    } catch (_error) {
      // Nothing to do about it here.
    }
  };

  const refresh = () => {
    checkLive();
    if (activeRead === undefined) return Promise.resolve();
    refreshing ??= (async () => {
      try {
        accept(await activeRead());
      } catch (error) {
        // A provider that cannot be asked leaves the last reading standing.
        reportError(error);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const source = makeExo(
    'ProviderAccountSource',
    ProviderAccountSourceInterface,
    {
      async observe() {
        checkLive();
        return last;
      },
      watch() {
        checkLive();
        return topic.watch();
      },
      async refresh() {
        await refresh();
      },
      /** @param {string} [methodName] */
      help(methodName) {
        const docs = {
          observe:
            'observe() — The last account reading this broker took, { plan?, rateLimits? }, from memory; {} before any request was served. Never calls the provider.',
          watch:
            'watch() — A disposable stream of that reading: the current one, then each later one, coalesced to the newest.',
          refresh:
            'refresh() — Ask the provider once, where this provider has a usage endpoint; otherwise nothing. Readings normally arrive with inference responses.',
        };
        if (methodName === undefined) {
          return 'Provider account source: observe(), watch(), refresh(). Plan and rate limits of the account behind a broker’s credential; it cannot reach the credential.';
        }
        return (
          docs[/** @type {keyof typeof docs} */ (methodName)] ||
          `No documentation for method "${methodName}".`
        );
      },
    },
  );

  return harden({
    accept,
    source,
    /** The last reading, synchronously, for a pool that ranks on it. */
    peek: () => last,
    close: async () => {
      closed = true;
      topic.close();
      await refreshing;
    },
  });
};
harden(makeAccountReadingSource);
