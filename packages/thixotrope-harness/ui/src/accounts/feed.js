// @ts-check
/**
 * The page's one view of the accounts channel (R4-85: pushed, never
 * polled; m4-interfaces.md 6, 9.1; W4.7). `Operator.getSecrets()` ->
 * `subscriptions()` -> `accounts()` gives the adapter-local `Accounts`;
 * the feed reads `list()` once, then `watch(rev)` and keeps exactly one
 * `next()` waiting while any component listens. Each `AccountsBatch` is the
 * whole view; a batch with an older `rev` is dropped, the keepalive answer
 * (same `rev`) is taken as it is.
 *
 * Eviction (m4-interfaces 6): a subscriber the adapter evicted (idle, or
 * closed) answers `next()` with `{ closed: true, reason }` (HR-SYN-34); the
 * feed then calls `watch(lastRev)` again, at most `REWATCH_LIMIT` times in a
 * row (then it stops with `subscriptionTexts.accountsWatchClosed` shown). A
 * rejection (the connection went away) stops it with the error shown; a reconnect brings new powers
 * and with them a new feed. When the last listener leaves, the feed closes
 * its subscription.
 *
 * One feed per connection's powers (a `WeakMap`), shared by the
 * Subscriptions panel and the account chip.
 */
import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { subscriptionTexts } from '../../../guest/lib/subscription-texts.js';

/** Re-watches in a row with no batch in between before the feed gives up. */
export const REWATCH_LIMIT = 3;

/**
 * @typedef {object} AccountsFeed
 * @property {() => { view?: any, error?: string }} state the newest
 *   `AccountsView` / `AccountsBatch` and the error that stopped the feed
 * @property {(listener: () => void) => () => void} subscribe
 * @property {(backend?: any) => Promise<void>} refresh `Accounts.refresh`
 *   (on demand only, R4-85)
 * @property {(session: any) => Promise<any>} forSession `PoolAccounts` of
 *   the session's pool, or undefined
 * @property {(backend: any) => Promise<any>} history `PoolHistory` of one
 *   pool (observed quota samples), or undefined; asked on demand
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @param {any} powers
 * @returns {AccountsFeed}
 */
const makeFeed = powers => {
  /** @type {Promise<any> | undefined} */
  let accountsP;
  const accounts = () => {
    if (!accountsP) {
      const made = (async () => {
        const secrets = await E(powers.operator).getSecrets();
        const subscriptions = await E(secrets).subscriptions();
        return E(subscriptions).accounts();
      })();
      accountsP = made;
      made.catch(() => {
        if (accountsP === made) accountsP = undefined;
      });
    }
    return accountsP;
  };

  /** @type {any} */
  let view;
  /** @type {string | undefined} */
  let error;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let epoch = 0;
  /** @type {any} */
  let subscription;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** @param {any} next */
  const take = next => {
    if (next && (view === undefined || Number(next.rev) >= Number(view.rev))) {
      view = next;
      error = undefined;
      notify();
    }
  };

  /**
   * `watch(rev)`; a watch that answers after the feed stopped is closed.
   *
   * @param {any} target
   * @param {number} mine
   */
  const watchFrom = async (target, mine) => {
    const made = await E(target).watch(view.rev);
    if (mine !== epoch) {
      E(made)
        .close()
        .catch(() => {});
      return false;
    }
    subscription = made;
    return true;
  };

  /** @param {number} mine */
  const run = async mine => {
    const target = await accounts();
    if (mine !== epoch) return;
    if (view === undefined) {
      take(await E(target).list());
      if (mine !== epoch) return;
    }
    const watching = await watchFrom(target, mine);
    if (!watching) return;
    let rewatches = 0;
    while (mine === epoch) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await E(subscription).next();
      if (mine !== epoch) return;
      if (batch.closed === true) {
        // The adapter ended the watch (HR-SYN-34: the field, never the
        // text): watch again from the last rev, a bounded number of times.
        if (rewatches >= REWATCH_LIMIT) {
          throw Error(subscriptionTexts.accountsWatchClosed);
        }
        rewatches += 1;
        // eslint-disable-next-line no-await-in-loop
        const again = await watchFrom(target, mine);
        if (!again) return;
      } else {
        rewatches = 0;
        take(batch);
      }
    }
  };

  const start = () => {
    epoch += 1;
    const mine = epoch;
    run(mine).catch(thrown => {
      if (mine !== epoch) return;
      error = messageOf(thrown);
      notify();
    });
  };

  const stop = () => {
    epoch += 1;
    const closing = subscription;
    subscription = undefined;
    if (closing) {
      E(closing)
        .close()
        .catch(() => {});
    }
  };

  return harden({
    state: () => ({ view, error }),
    subscribe: listener => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    refresh: async backend => {
      const target = await accounts();
      take(
        await (backend === undefined
          ? E(target).refresh()
          : E(target).refresh(backend)),
      );
    },
    forSession: async session => {
      const target = await accounts();
      return E(target).forSession(session);
    },
    history: async backend => {
      const target = await accounts();
      return E(target).history(backend);
    },
  });
};

/** @type {WeakMap<object, AccountsFeed>} */
const feeds = new WeakMap();

/**
 * The feed of a connection's powers (undefined before the first attach).
 *
 * @param {any} powers
 * @returns {AccountsFeed | undefined}
 */
export const accountsFeed = powers => {
  if (!powers) return undefined;
  let feed = feeds.get(powers);
  if (!feed) {
    feed = makeFeed(powers);
    feeds.set(powers, feed);
  }
  return feed;
};
