// @ts-check

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeLatestTopic } from '@endo/hosted-agent/latest-topic.js';

/**
 * What Floot tells a view about the accounts its backends spend: for each
 * backend that has an account oracle, the plan, the rate-limit windows with
 * how full they are and when they reset, credits, and banked resets.
 *
 * A view subscribes (`factory.watchAccounts()`) and is told the whole list
 * now and whenever any account changes, coalesced to the newest. Nothing is
 * polled: each oracle pushes (`HostedAccount.watch()`), and an oracle is fed
 * by its broker as a side effect of serving requests. Subscribing calls no
 * provider; only `refresh()` does, and only when a person asks.
 *
 * The list is plain data for a confined view: no capability, and no bigint
 * (a published quota becomes decimal text).
 */

/**
 * @typedef {object} AccountWindowView
 * @property {string} windowId `primary` is the short window, `secondary` the long one
 * @property {string} title
 * @property {number | null} usedPercent 0 to 100
 * @property {string} resetsAt ISO instant, or ''
 * @property {number | null} windowSeconds
 * @property {string | null} limit
 * @property {string | null} used
 * @property {string | null} remaining
 */

/**
 * @typedef {object} AccountView
 * @property {string} key `backendId`, or `backendId:subscriptionId`
 * @property {string} backendId
 * @property {string} [subscriptionId] when the backend holds several
 * @property {string} [label] the operator's name for that subscription
 * @property {string} title the backend's title
 * @property {{ planId: string, title: string, state: string, source: string }} plan
 * @property {AccountWindowView[]} windows
 * @property {boolean} limitReached
 * @property {{ balance: string | null, hasCredits: boolean, unlimited: boolean } | null} credits
 * @property {{ availableCount: number, credits: Array<{ id: string, status: string, grantedAt: string, expiresAt: string }> | null } | null} resetCredits
 * @property {string} source observed | declared | remembered | unavailable
 * @property {string} observedAt
 */

/** @param {unknown} value */
const text = value =>
  value === null || value === undefined ? null : `${value}`;

/**
 * @param {{ backendId: string, title: string, key?: string, subscriptionId?: string, label?: string }} backend
 * @param {any} snapshot `{ plan, rateLimits, rateCard }` from an oracle
 * @returns {AccountView}
 */
export const projectAccount = (backend, snapshot) => {
  const plan = snapshot?.plan ?? {};
  const limits = snapshot?.rateLimits ?? {};
  const windows = Array.isArray(limits.windows) ? limits.windows : [];
  return harden({
    key: backend.key ?? backend.backendId,
    backendId: backend.backendId,
    ...(backend.subscriptionId === undefined
      ? {}
      : {
          subscriptionId: backend.subscriptionId,
          label: backend.label ?? backend.subscriptionId,
        }),
    title: backend.title,
    plan: {
      planId: `${plan.planId ?? ''}`,
      title: `${plan.title ?? ''}`,
      state: `${plan.state ?? 'unknown'}`,
      source: `${plan.source ?? 'unavailable'}`,
    },
    windows: windows.map(window => ({
      windowId: `${window.windowId}`,
      title: `${window.title ?? ''}`,
      usedPercent:
        typeof window.usedFraction === 'number'
          ? Math.round(window.usedFraction * 1000) / 10
          : null,
      resetsAt: `${window.resetsAt ?? ''}`,
      windowSeconds:
        typeof window.windowSeconds === 'number' ? window.windowSeconds : null,
      limit: text(window.limit),
      used: text(window.used),
      remaining: text(window.remaining),
    })),
    limitReached: limits.limitReached === true,
    credits: limits.credits
      ? {
          balance: text(limits.credits.balance),
          hasCredits: limits.credits.hasCredits === true,
          unlimited: limits.credits.unlimited === true,
        }
      : null,
    resetCredits: limits.resetCredits
      ? {
          availableCount: Number(limits.resetCredits.availableCount) || 0,
          credits: Array.isArray(limits.resetCredits.credits)
            ? limits.resetCredits.credits.map(credit => ({
                id: `${credit.id}`,
                status: `${credit.status}`,
                grantedAt: `${credit.grantedAt ?? ''}`,
                expiresAt: `${credit.expiresAt ?? ''}`,
              }))
            : null,
        }
      : null,
    source: `${limits.source ?? 'unavailable'}`,
    observedAt: `${limits.observedAt ?? ''}`,
  });
};
harden(projectAccount);

/**
 * One account oracle to follow. `key` tells a backend's subscriptions apart;
 * a backend over one credential has none and is keyed by its id.
 *
 * @typedef {{ backendId: string, title: string, oracle: any, key?: string, subscriptionId?: string, label?: string }} OracleEntry
 */

/**
 * @param {object} powers
 * @param {() => Promise<{ entries: OracleEntry[], unknown: string[] }>} powers.listOracles
 *   The account oracles bound now, and the backend ids that could not be
 *   looked up this time (whose followers are left alone). Asked again
 *   whenever a view subscribes: an adapter binds its oracle after Floot has
 *   started.
 * @param {(callback: () => void, ms: number) => unknown} [powers.setTimer]
 * @param {(...args: unknown[]) => void} [powers.log]
 */
export const makeAccountsWatch = ({
  listOracles,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  log = (...args) => console.error(...args),
}) => {
  const topic = makeLatestTopic();
  /** @type {Map<string, AccountView>} */
  const accounts = new Map();
  /** @type {Map<string, any>} account key to the oracle being followed */
  const following = new Map();
  // How long to wait before looking for a backend's oracle again, and whether
  // its outage has been said. Per backend and across attempts: an oracle from
  // before it had `watch()` fails every time, and must cost a line once and a
  // retry a minute, not a line every five seconds.
  /** @type {Map<string, { retryMs: number, logged: boolean, pending: boolean }>} */
  const outages = new Map();
  let reconciling = Promise.resolve();

  const publish = () =>
    topic.publish(
      harden({
        type: 'accounts',
        accounts: [...accounts.values()].sort((a, b) =>
          a.key.localeCompare(b.key),
        ),
      }),
    );

  /** @param {OracleEntry} entry */
  const follow = entry => {
    const key = entry.key ?? entry.backendId;
    following.set(key, entry.oracle);
    const run = async () => {
      try {
        const snapshots = iterateReader(E(entry.oracle).watch());
        for await (const snapshot of snapshots) {
          if (following.get(key) !== entry.oracle) {
            // Replaced by a newer binding; let that one speak.

            await snapshots.return?.(undefined);
            return;
          }
          outages.delete(key);
          accounts.set(key, projectAccount(entry, snapshot));
          publish();
        }
      } catch (error) {
        const outage = outages.get(key);
        if (!outage?.logged) {
          log(
            `[floot-factory] account watch for ${key} failed:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (following.get(key) !== entry.oracle) return;
      // The oracle's stream ended: it was re-minted, it closed this reader, or
      // it cannot stream at all. Look for it again while somebody is watching.
      following.delete(key);
      const outage = outages.get(key) ?? {
        retryMs: 5000,
        logged: false,
        pending: false,
      };
      outage.logged = true;
      outages.set(key, outage);
      if (topic.watcherCount() > 0 && !outage.pending) {
        outage.pending = true;
        setTimer(() => {
          outage.pending = false;

          void reconcile();
        }, outage.retryMs);
        outage.retryMs = Math.min(outage.retryMs * 2, 60_000);
      }
    };
    void run();
  };

  const reconcile = () => {
    reconciling = reconciling
      .then(async () => {
        const { entries, unknown } = await listOracles();
        const keyOf = (/** @type {OracleEntry} */ entry) =>
          entry.key ?? entry.backendId;
        const present = new Set(entries.map(keyOf));
        // A backend that could not be looked up this time keeps what it had,
        // every subscription of it: one failed lookup must not drop a working
        // follower.
        const kept = (/** @type {string} */ key) =>
          present.has(key) ||
          unknown.some(
            backendId => key === backendId || key.startsWith(`${backendId}:`),
          );
        for (const key of [...following.keys()]) {
          if (!kept(key)) {
            following.delete(key);
            accounts.delete(key);
          }
        }
        for (const key of [...accounts.keys()]) {
          if (!kept(key)) accounts.delete(key);
        }
        for (const entry of entries) {
          const key = keyOf(entry);
          const outage = outages.get(key);
          if (following.get(key) !== entry.oracle && !outage?.pending) {
            follow(entry);
          }
        }
        publish();
      })
      .catch(error => {
        log(
          '[floot-factory] could not list account oracles:',
          error instanceof Error ? error.message : String(error),
        );
      });
    return reconciling;
  };

  return harden({
    /** A disposable stream: `{ type: 'accounts', accounts }`, now and on change. */
    watch: () => {
      void reconcile();
      return topic.watch();
    },
    /** Ask every account's provider once. A person asked. */
    refresh: async () => {
      await reconcile();
      await Promise.all(
        [...following.values()].map(oracle =>
          E(oracle)
            .refresh()
            .catch(error =>
              log(
                '[floot-factory] account refresh failed:',
                error instanceof Error ? error.message : String(error),
              ),
            ),
        ),
      );
    },
    close: () => {
      following.clear();
      topic.close();
    },
  });
};
harden(makeAccountsWatch);
