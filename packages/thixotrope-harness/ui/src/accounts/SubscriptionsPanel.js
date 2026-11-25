// @ts-check
/**
 * The Subscriptions panel (P-45; R4-84..R4-86, R6-54; m4-interfaces.md 6,
 * 9.1; W4.7) refreshes every configured subscription on opening. Each pool
 * shows its combined history and confirmed weekly resets. Individual
 * subscriptions disclose their plan, windows, status, balances and graphs.
 * Each pool offers "Add subscription" (`AddMember.js`); an add refreshes
 * that pool, so its list and graphs follow.
 */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { AddMember } from './AddMember.js';
import { accountsFeed } from './feed.js';
import { PoolQuotaHistory } from './PoolQuotaHistory.js';

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
});

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
  const { view, error: feedError } = feed ? feed.state() : {};

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
      feed &&
        h(AddMember, {
          feed,
          pool,
          call: context.call,
        }),
      pool.members.length === 0
        ? h('p', { class: 'm4-note' }, subscriptionsTexts.noMembers)
        : feed &&
            h(PoolQuotaHistory, {
              feed,
              pool,
              rev: Number(view?.rev ?? 0),
              now,
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
    view === undefined
      ? h('p', { class: 'm4-note' }, subscriptionsTexts.loading)
      : view.pools.length === 0
        ? h('p', { class: 'm4-note' }, subscriptionsTexts.none)
        : view.pools.map(poolView),
  );
};
