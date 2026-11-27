// @ts-check
/**
 * The Subscriptions panel (P-45; R4-84..R4-86, R6-54; m4-interfaces.md 6,
 * 9.1; W4.7) refreshes every configured subscription on opening. Each pool
 * shows its combined history and confirmed weekly resets. Individual
 * subscriptions disclose their plan, windows, status, balances and graphs.
 * Each pool offers "Add subscription" (`AddMember.js`); an add refreshes
 * that pool, so its list and graphs follow, and the new member shows its
 * first usage read result (`MemberStatus`), as every member shows its last
 * failed usage or model list read. "Add account" (`SignIn.js`) signs a new
 * Claude or ChatGPT account in from this page, into a pool (made when the
 * provider has none); "Sign in again" on a member's row replaces its
 * credential in place.
 */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { AddMember, MemberStatus } from './AddMember.js';
import { accountsFeed } from './feed.js';
import { PoolQuotaHistory } from './PoolQuotaHistory.js';
import { AddAccount, SignInAgain } from './SignIn.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** The panel's own words (harness texts). */
export const subscriptionsTexts = harden({
  title: 'Subscriptions',
  refresh: 'Refresh',
  refreshAll: 'Refresh all',
  loading: 'Reading accounts…',
  none: 'No subscription pools.',
  selection: 'selection: auto',
  noMembers: 'No members.',
  /**
   * A pool's `additionsNote` (m4-interfaces 3.5): some subscriptions added
   * here over a manager that predates adding are not served yet.
   * @param {number} count
   * @param {string} code
   */
  unrestored: (count, code) =>
    `${count} added subscription${count === 1 ? '' : 's'} could not be restored: ${code}`,
  /**
   * The adapter's file of added subscriptions could not be read.
   * @param {string} code
   */
  additionsFile: code =>
    `The added subscriptions could not be read (${code}); none can be added until the agent host is restarted after checking pool-additions.json`,
});

/**
 * The words of a pool's `additionsNote`, or '' for none.
 * @param {{ code: string, unrestored?: number } | undefined} note
 */
export const additionsNoteText = note => {
  if (note === undefined) return '';
  if (note.unrestored !== undefined && note.unrestored > 0)
    return subscriptionsTexts.unrestored(note.unrestored, note.code);
  return subscriptionsTexts.additionsFile(note.code);
};

/**
 * Re-render the calling component on every change of the connection's
 * accounts feed; answer the feed.
 *
 * @param {FeatureContext} context
 */
export const useAccountsFeed = context => {
  const feed = accountsFeed(context.powers);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!feed) return undefined;
    return feed.subscribe(() => setTick(n => n + 1));
  }, [feed]);
  return feed;
};

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * @param {{ context: FeatureContext, now?: () => number }} props
 */
export const SubscriptionsPanel = ({ context, now = Date.now }) => {
  const feed = useAccountsFeed(context);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The member each pool added last in this opening, until dismissed.
  /** @type {[Map<any, { label: string, member: any }>, (v: Map<any, { label: string, member: any }>) => void]} */
  const [added, setAdded] = useState(
    /** @type {Map<any, { label: string, member: any }>} */ (new Map()),
  );
  /**
   * @param {any} backend
   * @param {{ label: string, member: any } | undefined} entry
   */
  const markAdded = (backend, entry) => {
    const next = new Map(added);
    if (entry === undefined) next.delete(backend);
    else next.set(backend, entry);
    setAdded(next);
  };
  const { view, error: feedError } = feed ? feed.state() : {};
  // The member being signed in again ("Sign in again" on its row).
  /** @type {[{ pool: any, label: string } | undefined, (v: { pool: any, label: string } | undefined) => void]} */
  const [again, setAgain] = useState(
    /** @type {{ pool: any, label: string } | undefined} */ (undefined),
  );

  // Keep request state tied to this opening and these connection powers.
  const requestToken = useRef(0);
  const refresh = async (
    /** @type {any} */ backend = undefined,
    register = false,
  ) => {
    if (!feed) return;
    requestToken.current += 1;
    const token = requestToken.current;
    setBusy(true);
    setError('');
    await null;
    try {
      await context.call(async () => {
        await (register ? feed.registerPools() : undefined);
        if (requestToken.current === token) await feed.refresh(backend);
      });
    } catch (thrown) {
      if (requestToken.current === token) setError(messageOf(thrown));
    } finally {
      if (requestToken.current === token) setBusy(false);
    }
  };

  useEffect(() => {
    if (!feed) return undefined;
    let live = true;
    let registered = false;
    let started = false;
    const refreshWhenReady = () => {
      if (!live || !registered || started || !feed.state().view?.pools.length)
        return;
      started = true;
      void refresh();
    };
    const unsubscribe = feed.subscribe(refreshWhenReady);
    setBusy(true);
    setError('');
    feed.registerPools().then(
      () => {
        if (!live) return;
        registered = true;
        setBusy(false);
        refreshWhenReady();
      },
      thrown => {
        if (!live) return;
        setBusy(false);
        setError(messageOf(thrown));
      },
    );
    return () => {
      live = false;
      requestToken.current += 1;
      unsubscribe();
    };
  }, [feed]);

  /**
   * @param {string} action
   * @param {string} text
   * @param {() => void} onClick
   */
  const button = (action, text, onClick) =>
    h(
      'button',
      {
        type: 'button',
        class: 'm4-btn',
        'data-action': action,
        disabled: busy,
        onClick,
      },
      text,
    );

  /**
   * After a sign-in: the pools again (a new pool), then their readings.
   * @param {any} [backend]
   */
  const signedIn = async backend => {
    if (!feed) return;
    await context
      .call(async () => {
        await feed.registerPools();
        await feed.refresh(backend);
      })
      .catch((/** @type {unknown} */ thrown) => setError(messageOf(thrown)));
  };

  /** @param {Record<string, any>} pool */
  const signInAgainOf = pool => (/** @type {any} */ account) =>
    setAgain({ pool, label: String(account.label) });

  /** @param {Record<string, any>} pool */
  const poolView = pool =>
    h(
      'section',
      { key: pool.backend, class: 'm4-pool', 'data-kind': pool.kind },
      h(
        'div',
        { class: 'm4-pool-head' },
        h('h3', null, pool.label),
        h(
          'span',
          { class: 'm4-secret-facts' },
          `${pool.kind} · ${subscriptionsTexts.selection}`,
        ),
        button('refresh-pool', subscriptionsTexts.refresh, () =>
          refresh(pool.backend),
        ),
      ),
      pool.additionsNote === undefined
        ? null
        : h(
            'p',
            {
              class: 'm4-note',
              role: 'status',
              'data-note': 'additions',
              'data-code': pool.additionsNote.code,
            },
            additionsNoteText(pool.additionsNote),
          ),
      feed &&
        h(AddMember, {
          feed,
          pool,
          call: context.call,
          onAdded: entry => markAdded(pool.backend, entry),
        }),
      feed &&
        h(MemberStatus, {
          feed,
          pool,
          added: added.get(pool.backend),
          call: context.call,
          onDone: () => markAdded(pool.backend, undefined),
          onSignInAgain: signInAgainOf(pool),
        }),
      feed && again !== undefined && again.pool.backend === pool.backend
        ? h(SignInAgain, {
            key: again.label,
            feed,
            pool,
            label: again.label,
            call: context.call,
            onChanged: signedIn,
            onClose: () => setAgain(undefined),
          })
        : null,
      pool.members.length === 0
        ? h('p', { class: 'm4-note' }, subscriptionsTexts.noMembers)
        : feed &&
            h(PoolQuotaHistory, {
              feed,
              pool,
              rev: Number(view?.rev ?? 0),
              now,
              onSignInAgain: signInAgainOf(pool),
            }),
    );

  const shownError = error || feedError;
  return h(
    'div',
    { class: 'm4-panel m4-subscriptions' },
    h('h2', null, subscriptionsTexts.title),
    shownError
      ? h('div', { class: 'm4-error', role: 'alert' }, shownError)
      : null,
    h(
      'div',
      { class: 'm4-secret-actions' },
      button('refresh-all', subscriptionsTexts.refreshAll, () =>
        refresh(undefined, true),
      ),
    ),
    feed && view !== undefined
      ? h(AddAccount, {
          feed,
          pools: view.pools,
          call: context.call,
          onChanged: signedIn,
        })
      : null,
    view === undefined
      ? h('p', { class: 'm4-note' }, subscriptionsTexts.loading)
      : view.pools.length === 0
        ? h('p', { class: 'm4-note' }, subscriptionsTexts.none)
        : view.pools.map(poolView),
  );
};
