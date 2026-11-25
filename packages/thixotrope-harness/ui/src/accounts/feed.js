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
 * @property {() => Promise<void>} registerPools discover the durable pools on this adapter
 * @property {(backend?: any) => Promise<void>} refresh `Accounts.refresh`
 *   (on demand only, R4-85)
 * @property {(session: any) => Promise<any>} forSession `PoolAccounts` of
 *   the session's pool, or undefined
 * @property {(backend: any, offset?: number) => Promise<any>} history one
 *   `PoolHistory` page of a pool (observed quota records; `next` names the
 *   following page), or undefined; asked on demand, read-only
 * @property {() => Promise<any[]>} activeSecrets the active entries of the
 *   Secrets catalogue (`{ secret, label, description, ... }`; every page,
 *   at most `maxMembers`; never a value)
 * @property {(backend: any, secret: any) => Promise<{ ok: boolean, code?: string }>} checkCredential
 *   the adapter's `Accounts.checkCredential`: ok or a code, never the
 *   value
 * @property {(backend: any, member: { secret: any, label: string }) => Promise<any>} addSubscription
 *   the adapter's `Accounts.addMember`: the pool rules and the credential
 *   check, then the member made and added (a refusal makes nothing); then
 *   refresh that pool, which is the member's first usage read. Answers
 *   the `PoolMember`. The page never asks which way: the adapter uses
 *   the manager's own `addMember` when it has one, else keeps the
 *   addition over a pinned manager (m4-interfaces 3.5); the gateway
 *   refuses `__getMethodNames__`, so nothing here introspects.
 * @property {(backend: any, member: any) => Promise<void>} addUnpooled
 *   `addPoolMember` of a member an interrupted add left in no pool, then
 *   refresh; a manager that predates it refuses (the page then says to
 *   add it again with the same Secret and label)
 * @property {(provider: string) => Promise<{ member: any, label: string }[]>} unpooledMembers
 *   active members of `provider` in no pool (the adapter's
 *   `Accounts.poolMembers`, additions included): only what an
 *   interrupted add leaves (m4-interfaces 10)
 * @property {(member: any) => Promise<void>} retireMember `PoolMember.retire()`
 */

/** At most this many catalogue or member pages are read for the form. */
const MAX_PAGES = 4;

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
  /** @type {any} */
  let subscriptions;
  /** @type {any} */
  let secretsAdmin;
  const accounts = () => {
    if (!accountsP) {
      const made = (async () => {
        const secrets = await E(powers.operator).getSecrets();
        secretsAdmin = secrets;
        subscriptions = await E(secrets).subscriptions();
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
      const listed = await E(target).list();
      if (mine !== epoch) return;
      take(listed);
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

  /** @type {Promise<void> | undefined} */
  let registration;
  const registerPools = () => {
    if (!registration) {
      registration = (async () => {
        const target = await accounts();
        const { pools } = await E(subscriptions).listPools();
        await Promise.all(
          pools.map((/** @type {any} */ pool) => E(target).forBackend(pool)),
        );
      })().finally(() => {
        registration = undefined;
      });
    }
    return registration;
  };

  // Reopening joins an in-flight refresh-all. A refresh-all following a
  // pool-specific request waits for it, so provider calls cannot overlap.
  /** @type {Map<any, Promise<void>>} */
  const refreshing = new Map();
  /** @param {any} [backend] */
  const refresh = backend => {
    const existing = refreshing.get(undefined) ?? refreshing.get(backend);
    if (existing) return existing;
    const previous = [...refreshing.values()];
    const pending = (async () => {
      await Promise.allSettled(previous);
      const target = await accounts();
      const next =
        backend === undefined
          ? await E(target).refresh()
          : await E(target).refresh(backend);
      take(next);
    })().finally(() => {
      refreshing.delete(backend);
    });
    refreshing.set(backend, pending);
    return pending;
  };

  /** The `SubscriptionsAdmin` (after the first `accounts()`). */
  const admin = async () => {
    await accounts();
    return subscriptions;
  };

  /**
   * Every page of a paged list, at most `MAX_PAGES`.
   * @param {(cursor?: string) => Promise<any>} read
   * @param {string} field
   */
  const allPages = async (read, field) => {
    /** @type {any[]} */
    const all = [];
    /** @type {string | undefined} */
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await read(cursor);
      all.push(...answer[field]);
      cursor = answer.next;
      if (cursor === undefined) break;
    }
    return all;
  };

  /** @param {any} backend */
  const added = async backend => {
    // The adapter took `poolsChanged`: this reads the pool's new members.
    await refresh(backend);
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
    registerPools,
    refresh,
    forSession: async session => {
      const target = await accounts();
      return E(target).forSession(session);
    },
    history: async (backend, offset = 0) => {
      const target = await accounts();
      return offset === 0
        ? E(target).history(backend)
        : E(target).history(backend, offset);
    },
    activeSecrets: async () => {
      await accounts();
      const entries = await allPages(
        cursor =>
          cursor === undefined
            ? E(secretsAdmin).catalog()
            : E(secretsAdmin).catalog(cursor),
        'entries',
      );
      return entries.filter(entry => entry.state === 'active');
    },
    checkCredential: async (backend, secret) =>
      E(await accounts()).checkCredential(backend, secret),
    addSubscription: async (backend, { secret, label }) => {
      const target = await accounts();
      const member = await E(target).addMember(
        backend,
        harden({ label, credential: secret }),
      );
      // The add is done: a failed refresh is not a failed add (the
      // member shows its first read, or its failure, when it comes).
      await added(backend).catch(() => {});
      return member;
    },
    addUnpooled: async (backend, member) => {
      await E(await admin()).addPoolMember(backend, member);
      await added(backend);
    },
    unpooledMembers: async provider => {
      const target = await admin();
      const accountsView = await accounts();
      const [members, { pools }] = await Promise.all([
        allPages(
          cursor =>
            cursor === undefined
              ? E(target).listMembers()
              : E(target).listMembers(cursor),
          'members',
        ),
        E(target).listPools(),
      ]);
      // Each pool's members as the adapter serves them: the manager's,
      // and the additions it keeps over a manager that predates addMember.
      const described = await Promise.all(
        pools.map((/** @type {any} */ pool) =>
          E(accountsView).poolMembers(pool),
        ),
      );
      const pooled = new Set(described.flat());
      const infos = await Promise.all(
        members
          .filter(member => !pooled.has(member))
          .map(async member => ({ member, info: await E(member).describe() })),
      );
      return infos
        .filter(
          ({ info }) => info.state === 'active' && info.provider === provider,
        )
        .map(({ member, info }) => harden({ member, label: info.label }));
    },
    retireMember: async member => {
      await E(member).retire();
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
