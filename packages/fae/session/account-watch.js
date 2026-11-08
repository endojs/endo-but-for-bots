// @ts-check

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeLatestTopic } from '@endo/hosted-agent/latest-topic.js';
import { accountResetKey } from './account-discovery.js';

/**
 * What Floot tells a view about the accounts its backends spend: for each
 * declared account identity that has an oracle, the plan, rate-limit windows with
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
 * @property {string} accountId Explicit provider/authority/member identity
 * @property {string} providerId
 * @property {Array<{backendId: string, subscriptionId?: string}>} uses
 * @property {string} [resetKey] Exact account/admin pair, never a label
 * @property {string} [label] the operator's name for that subscription
 * @property {string} title the account's display title
 * @property {{ planId: string, title: string, state: string, source: string }} plan
 * @property {AccountWindowView[]} windows
 * @property {boolean} limitReached
 * @property {{ balance: string | null, hasCredits: boolean, unlimited: boolean } | null} credits
 * @property {{ availableCount: number, credits: Array<{ id: string, status: string, grantedAt: string, expiresAt: string }> | null } | null} resetCredits
 * @property {{ pending: { creditId: string | null, startedAt: string, lastAttemptAt: string, attempts: number, lastAnswer: string } | null, last: { outcome: string, creditId: string | null, at: string } | null } | null} reset
 *   Present when an operator can redeem a banked reset here: a redeem whose
 *   answer is not known, and the last one that was settled.
 * @property {string} source observed | declared | remembered | unavailable
 * @property {string} observedAt
 */

/** @param {unknown} value */
const text = value =>
  value === null || value === undefined ? null : `${value}`;

/**
 * @param {{ accountId: string, providerId: string, uses: Array<{backendId: string, subscriptionId?: string}>, title: string, adminId?: string, admin?: any, label?: string }} backend
 * @param {any} snapshot `{ plan, rateLimits, rateCard }` from an oracle
 * @param {any} [reset] the subscription admin's `getResetState()`, if any
 * @returns {AccountView}
 */
export const projectAccount = (backend, snapshot, reset) => {
  const plan = snapshot?.plan ?? {};
  const limits = snapshot?.rateLimits ?? {};
  const windows = Array.isArray(limits.windows) ? limits.windows : [];
  return harden({
    accountId: backend.accountId,
    providerId: backend.providerId,
    uses: backend.uses,
    ...(backend.label === undefined ? {} : { label: backend.label }),
    ...(backend.admin === undefined
      ? {}
      : { resetKey: accountResetKey(backend.accountId, backend.adminId) }),
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
    reset:
      reset && typeof reset === 'object'
        ? {
            pending: reset.pending
              ? {
                  creditId: text(reset.pending.creditId),
                  startedAt: `${reset.pending.startedAt ?? ''}`,
                  lastAttemptAt: `${reset.pending.lastAttemptAt ?? ''}`,
                  attempts: Number(reset.pending.attempts) || 1,
                  lastAnswer:
                    reset.pending.lastAnswer === 'refused'
                      ? 'refused'
                      : 'unknown',
                }
              : null,
            last: reset.last
              ? {
                  outcome: `${reset.last.outcome}`,
                  creditId: text(reset.last.creditId),
                  at: `${reset.last.at ?? ''}`,
                }
              : null,
          }
        : null,
    source: `${limits.source ?? 'unavailable'}`,
    observedAt: `${limits.observedAt ?? ''}`,
  });
};
harden(projectAccount);

/**
 * One explicitly published account oracle to follow, independent of its uses.
 *
 * `admin` is the subscription's admin where the provider banks rate-limit
 * resets; it is asked for its state (which calls no provider) and, when an
 * operator says so, to redeem.
 *
 * @typedef {import('@endo/hosted-agent/account-bindings.js').AccountBinding & {sources: string[]}} OracleEntry
 */

/**
 * @param {object} powers
 * @param {() => Promise<{ entries: OracleEntry[], unknown: string[] }>} powers.listOracles
 *   The published account bindings and source names that could not be
 *   validated (whose prior display, not capabilities, is retained). Asked again
 *   whenever a view subscribes: an adapter binds its oracle after Floot has
 *   started.
 * @param {(callback: () => void, ms: number) => unknown} [powers.setTimer]
 * @param {(handle: any) => void} [powers.clearTimer]
 * @param {(...args: unknown[]) => void} [powers.log]
 */
export const makeAccountsWatch = ({
  listOracles,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = handle => globalThis.clearTimeout(handle),
  log = (...args) => console.error(...args),
}) => {
  const topic = makeLatestTopic();
  let closed = false;
  const pending = new Set();
  const retryTimers = new Set();
  const readers = new Set();
  const assertOpen = () => {
    if (closed) throw Error('Floot accounts watch is closed');
  };
  const track = promise => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const admit =
    operation =>
    (...args) => {
      assertOpen();
      return track(operation(...args));
    };
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
  /** @type {Map<string, { entry: OracleEntry, snapshot: any }>} */
  const held = new Map();
  /** @type {Map<string, OracleEntry>} */
  const bindings = new Map();
  /** @type {Map<string, any>} account key to its subscription admin */
  const admins = new Map();
  /** @type {Map<string, any>} account key to the admin's last reset state */
  const resets = new Map();

  const publish = () => {
    if (closed) return;
    topic.publish(
      harden({
        type: 'accounts',
        accounts: [...accounts.values()].sort((a, b) =>
          a.accountId.localeCompare(b.accountId),
        ),
      }),
    );
  };

  /**
   * Ask an account's admin where its redeems stand, and tell the views if
   * that changed. From the admin's memory and the broker's: no provider call.
   *
   * @param {string} key
   */
  const readReset = key =>
    track(
      (async () => {
        if (closed) return;
        const admin = admins.get(key);
        if (admin === undefined) return;
        /** @type {any} */
        let state;
        try {
          state = await E(admin).getResetState();
        } catch (_error) {
          // An admin that cannot answer leaves what was known standing.
          return;
        }
        if (closed || admins.get(key) !== admin) return;
        const before = JSON.stringify(resets.get(key) ?? null);
        resets.set(key, state);
        const last = held.get(key);
        if (last !== undefined && JSON.stringify(state) !== before) {
          accounts.set(key, projectAccount(last.entry, last.snapshot, state));
          publish();
        }
      })(),
    );

  /** @param {OracleEntry} entry */
  const follow = entry => {
    if (closed) return;
    const key = entry.accountId;
    following.set(key, entry.oracle);
    const run = async () => {
      let reader;
      try {
        const remote = await E(entry.oracle).watch();
        const snapshots = iterateReader(remote);
        let closingReader;
        reader = {
          key,
          oracle: entry.oracle,
          close: () => {
            // A stream's terminal rejection is historical, not cleanup proof.
            // Oracle readers expose an independent close acknowledgement.
            closingReader ??= E(remote)
              .close()
              .then(() => {
                readers.delete(reader);
              })
              .catch(error => {
                closingReader = undefined;
                throw error;
              });
            return closingReader;
          },
        };
        readers.add(reader);
        if (closed || following.get(key) !== entry.oracle) return;
        for await (const snapshot of snapshots) {
          if (closed || following.get(key) !== entry.oracle) {
            // Replaced by a newer binding; let that one speak.

            return;
          }
          outages.delete(key);
          const current = bindings.get(key);
          if (!current || current.oracle !== entry.oracle) return;
          held.set(key, { entry: current, snapshot });
          accounts.set(key, projectAccount(current, snapshot, resets.get(key)));
          publish();
          // A reading can settle a pending redeem (the credit reads redeemed).
          void readReset(key);
        }
      } catch (error) {
        const outage = outages.get(key);
        if (!closed && !outage?.logged) {
          log(
            `[floot-factory] account watch for ${key} failed:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        await reader?.close();
      }
      if (closed || following.get(key) !== entry.oracle) return;
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
        const timer = setTimer(() => {
          retryTimers.delete(timer);
          outage.pending = false;
          if (closed) return;
          void reconcile();
        }, outage.retryMs);
        retryTimers.add(timer);
        outage.retryMs = Math.min(outage.retryMs * 2, 60_000);
      }
    };
    void track(run()).catch(error => {
      if (!closed) log('[floot-factory] account reader cleanup failed:', error);
    });
  };

  const disableResets = () => {
    admins.clear();
    resets.clear();
    for (const [key, entry] of bindings) {
      const { admin: _admin, adminId: _adminId, ...display } = entry;
      bindings.set(key, display);
      const previous = held.get(key);
      if (previous) {
        held.set(key, { entry: display, snapshot: previous.snapshot });
        accounts.set(key, projectAccount(display, previous.snapshot));
      }
    }
    publish();
  };

  const reconcile = () => {
    reconciling = reconciling
      .then(async () => {
        if (closed) return;
        // No old UI key can spend while this discovery is unvalidated.
        disableResets();
        const { entries, unknown } = await listOracles();
        if (closed) return;
        const present = new Set(entries.map(entry => entry.accountId));
        const kept = key =>
          present.has(key) ||
          bindings.get(key)?.sources.some(source => unknown.includes(source));
        for (const key of [...bindings.keys()]) {
          if (!present.has(key)) following.delete(key);
          if (!kept(key)) {
            following.delete(key);
            accounts.delete(key);
            held.delete(key);
            bindings.delete(key);
            outages.delete(key);
          }
        }
        for (const entry of entries) {
          const key = entry.accountId;
          // An unreadable source might conflict with a known account. Keep
          // useful display but withhold all reset authority until validated.
          const { admin: _admin, adminId: _adminId, ...display } = entry;
          /** @type {OracleEntry} */
          const current = unknown.length ? display : entry;
          const previous = bindings.get(key);
          if (previous && previous.oracle !== entry.oracle) {
            held.delete(key);
            accounts.delete(key);
            resets.delete(key);
            outages.delete(key);
          }
          bindings.set(key, current);
          const reading = held.get(key);
          if (reading) {
            held.set(key, { entry: current, snapshot: reading.snapshot });
            accounts.set(key, projectAccount(current, reading.snapshot));
          }
          if (current.admin !== undefined) {
            admins.set(key, current.admin);
            void readReset(key);
          }
          const outage = outages.get(key);
          if (following.get(key) !== current.oracle && !outage?.pending) {
            follow(current);
          }
        }
        for (const reader of readers) {
          if (following.get(reader.key) !== reader.oracle) {
            void track(reader.close()).catch(error => {
              log(
                '[floot-factory] retired account reader cleanup failed:',
                error,
              );
            });
          }
        }
        publish();
      })
      .catch(error => {
        disableResets();
        following.clear();
        for (const reader of readers) {
          void track(reader.close()).catch(closeError => {
            log(
              '[floot-factory] unvalidated account reader cleanup failed:',
              closeError,
            );
          });
        }
        log(
          '[floot-factory] could not list account oracles:',
          error instanceof Error ? error.message : String(error),
        );
      });
    return track(reconciling);
  };

  const resetTarget = resetKey => {
    for (const [accountId, entry] of bindings) {
      if (
        entry.admin !== undefined &&
        accountResetKey(accountId, entry.adminId) === resetKey &&
        admins.get(accountId) === entry.admin
      ) {
        return { accountId, admin: entry.admin };
      }
    }
    throw Error(`No banked reset can be redeemed for ${resetKey}`);
  };

  return harden({
    /** A disposable stream: `{ type: 'accounts', accounts }`, now and on change. */
    watch: () => {
      assertOpen();
      void reconcile();
      return topic.watch();
    },
    /** Ask every account's provider once. A person asked. */
    refresh: admit(async () => {
      await reconcile();
      assertOpen();
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
      await Promise.all([...admins.keys()].map(readReset));
    }),
    /**
     * Spend one banked rate-limit reset of an account. A person asked: this
     * is the only path here that can, and nothing calls it on its own.
     *
     * @param {string} key
     * @param {{ creditId?: string, replay?: boolean }} [options]
     */
    redeemReset: admit(async (key, options = {}) => {
      await reconcile();
      assertOpen();
      const { accountId, admin } = resetTarget(key);
      try {
        return await E(admin).consumeResetCredit(harden({ ...options }));
      } finally {
        // Settled, refused or unconfirmed: the views are told which.
        await readReset(accountId);
      }
    }),
    /**
     * Give an account's unconfirmed redeem up. A person asked.
     *
     * @param {string} key
     */
    abandonReset: admit(async key => {
      await reconcile();
      assertOpen();
      const { accountId, admin } = resetTarget(key);
      try {
        return await E(admin).abandonResetIntent();
      } finally {
        await readReset(accountId);
      }
    }),
    close: async () => {
      closed = true;
      following.clear();
      topic.close();
      for (const timer of retryTimers) clearTimer(timer);
      retryTimers.clear();
      const outcomes = await Promise.allSettled(
        [...readers].map(reader => reader.close()),
      );
      const failures = outcomes.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      // A failed close may leave the follower waiting forever. Retain it for
      // retry and refuse acknowledgement instead of hiding that error.
      if (failures.length)
        throw AggregateError(failures, 'Floot account readers remain open');
      while (pending.size > 0) {
        // Admitted reset operations must settle with their real outcome.
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled([...pending]);
      }
      if (readers.size > 0)
        failures.push(Error('Account reader closure is unconfirmed'));
      if (failures.length)
        throw AggregateError(failures, 'Floot account readers remain open');
      admins.clear();
      resets.clear();
      held.clear();
      bindings.clear();
      accounts.clear();
    },
  });
};
harden(makeAccountsWatch);
