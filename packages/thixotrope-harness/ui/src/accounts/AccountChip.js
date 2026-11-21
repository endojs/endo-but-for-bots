// @ts-check
/**
 * The account chips of the status bar (R6-52, R6-54; m4-interfaces.md 9.1
 * item 1; W4.7): for the session on screen, one chip per member account
 * of its pool (retired members left out), live from the accounts channel;
 * the chips turn red when every account is at its limit. Nothing is shown
 * when the session's backend is not a pool (`Accounts.forSession` answers
 * undefined).
 *
 * The session object: the controller's `activeSession()` when it offers
 * one, else `SessionFactory.findSession(activeKey)` (F.2 d: the key names
 * the row on screen). The pool is then found in each new view by its
 * `Backend` presence, never by its label.
 */
import { E } from '@endo/far';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { accountBlocked, chipText, confirmedWindows } from './labels.js';
import { useAccountsFeed } from './SubscriptionsPanel.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * The `Session` presence of the session on screen, or undefined.
 *
 * @param {FeatureContext} context
 * @param {string | undefined} key the controller's `activeKey`
 */
export const activeSessionOf = async (context, key) => {
  const controller = context.controller;
  if (typeof controller.activeSession === 'function') {
    return controller.activeSession();
  }
  if (key === undefined || !context.powers) return undefined;
  const factory = await E(context.powers.operator).getFactory();
  return E(factory).findSession(key);
};

/**
 * `when`: shown only while a session is on screen; the component itself
 * shows nothing for a backend that is not a pool.
 *
 * @param {FeatureContext} context
 */
export const chipWhen = context => Boolean(context.controller.getState().view);

/**
 * @param {{ context: FeatureContext, now?: () => number }} props
 */
export const AccountChip = ({ context, now = Date.now }) => {
  const feed = useAccountsFeed(context);
  const activeKey = context.controller.getState().activeKey;
  /** @type {[any, (v: any) => void]} */
  const [found, setFound] = useState(/** @type {any} */ (undefined));

  useEffect(() => {
    let current = true;
    setFound(undefined);
    if (!feed) return undefined;
    (async () => {
      const session = await activeSessionOf(context, activeKey);
      if (!current || session === undefined) return;
      const pool = await feed.forSession(session);
      if (current) setFound(pool);
    })().catch(() => {
      // No chip: the status line already reports daemon failures.
    });
    return () => {
      current = false;
    };
    // `context` is the controller's one context; `feed` follows its powers.
  }, [feed, activeKey]);

  if (!found) return null;
  const view = feed ? feed.state().view : undefined;
  const pool =
    (view &&
      view.pools.find(
        (/** @type {any} */ candidate) => candidate.backend === found.backend,
      )) ||
    found;
  const nowMs = now();
  const members = pool.members.filter(
    (/** @type {any} */ account) => account.state !== 'retired',
  );
  if (members.length === 0) return null;
  const blocked = members.map((/** @type {any} */ account) =>
    accountBlocked(account, nowMs),
  );
  const allBlocked = blocked.every(Boolean);
  return h(
    'span',
    {
      class: `m4-chips${allBlocked ? ' all-blocked' : ''}`,
      'data-pool': pool.label,
    },
    members.map((/** @type {any} */ account, /** @type {number} */ index) =>
      h(
        'span',
        {
          key: index,
          class: `m4-chip chip${blocked[index] ? ' blocked' : ''}`,
          title: [
            pool.label,
            account.provider,
            ...(confirmedWindows(account).length
              ? [
                  "Percent of this account's subscription allowance used in each provider window.",
                ]
              : []),
          ].join(' · '),
        },
        chipText(account, nowMs),
      ),
    ),
  );
};
