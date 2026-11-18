// @ts-check
/**
 * The Subscriptions panel (P-45; R4-84..R4-86, R6-54; m4-interfaces.md 6,
 * 9.1; W4.7): every pool's accounts from the accounts channel, live
 * (`feed.js`), with Refresh for all pools or one (`Accounts.refresh`, on
 * demand only). Per member: plan, windows (percent used, reset), status,
 * credits, banked resets (read-only: no redeem, decision 8) and the
 * provenance of the figures. Selection is always `auto` (D-M4-6).
 */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { accountsFeed } from './feed.js';
import { accountBlocked, accountRows } from './labels.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

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
  const nowMs = now();

  /** @param {any} [backend] */
  const refresh = async backend => {
    await null;
    if (!feed) return;
    setBusy(true);
    setError('');
    try {
      await context.call(() => feed.refresh(backend));
    } catch (thrown) {
      setError(messageOf(thrown));
    } finally {
      setBusy(false);
    }
  };

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

  /** @param {Record<string, any>} account */
  const member = account =>
    h(
      'li',
      {
        class: `m4-account ${account.state}${
          accountBlocked(account, nowMs) ? ' blocked' : ''
        }`,
        'data-provenance': account.provenance,
      },
      h(
        'div',
        { class: 'm4-account-head' },
        h('span', { class: 'm4-account-label' }, account.label),
        h('span', { class: 'm4-secret-facts' }, account.provider),
      ),
      h(
        'dl',
        { class: 'm4-account-rows' },
        accountRows(account, nowMs).flatMap(([name, value]) => [
          h('dt', null, name),
          h('dd', null, value),
        ]),
      ),
    );

  /** @param {Record<string, any>} pool */
  const poolView = pool =>
    h(
      'section',
      { class: 'm4-pool', 'data-kind': pool.kind },
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
      pool.members.length === 0
        ? h('p', { class: 'm4-note' }, subscriptionsTexts.noMembers)
        : h('ul', { class: 'm4-account-list' }, pool.members.map(member)),
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
      button('refresh-all', subscriptionsTexts.refreshAll, () => refresh()),
    ),
    view === undefined
      ? h('p', { class: 'm4-note' }, subscriptionsTexts.loading)
      : view.pools.length === 0
        ? h('p', { class: 'm4-note' }, subscriptionsTexts.none)
        : view.pools.map(poolView),
  );
};
