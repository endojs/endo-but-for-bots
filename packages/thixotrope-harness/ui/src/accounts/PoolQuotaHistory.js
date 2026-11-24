// @ts-check
/** Pool totals and individual subscriptions share one paginated history read. */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { subscriptionLimits } from '../../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */
import { CreditGraph, reportsNumericCredits } from './CreditGraph.js';
import { accountBlocked, accountRows } from './labels.js';
import { PoolOverviewGraph } from './PoolOverviewGraph.js';
import { QuotaGraph, quotaGraphTexts } from './QuotaGraph.js';

/** How often an open view advances its clock. */
const QUOTA_TICK_MS = 30_000;

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * The browser's clock, advanced every `tickMs` while mounted and `running`
 * (no provider call: only the projection rules are re-applied). Nothing
 * runs while there is no graph to keep current.
 *
 * @param {() => number} now
 * @param {number} tickMs
 * @param {boolean} running
 */
const useNow = (now, tickMs, running) => {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const timer = globalThis.setInterval(() => tick(n => n + 1), tickMs);
    return () => globalThis.clearInterval(timer);
  }, [tickMs, running]);
  // A newly received provider reading may be newer than the last timer tick.
  return now();
};

const MAX_PAGES = Math.ceil(
  subscriptionLimits.maxPoolMembers / subscriptionLimits.historyPageMembers,
);

/**
 * Every page of a pool's history, joined; `null` when the adapter no longer
 * knows the pool.
 *
 * @param {import('./feed.js').AccountsFeed} feed
 * @param {any} backend
 */
const readHistory = async (feed, backend) => {
  const first = await feed.history(backend);
  if (first === undefined || first === null) return null;
  const members = [...(first.members ?? [])];
  let offset = Number(first.next);
  for (
    let page = 1;
    page < MAX_PAGES && Number.isSafeInteger(offset) && offset > 0;
    page += 1
  ) {
    // eslint-disable-next-line no-await-in-loop -- each page names the next
    const more = await feed.history(backend, offset);
    if (more === undefined || more === null) break;
    members.push(...(more.members ?? []));
    const next = Number(more.next);
    offset = next > offset ? next : NaN;
  }
  return harden({ ...first, members });
};

/** @param {{ account: any, member: any, nowMs: number, expanded: boolean }} props */
const IndividualSubscription = ({ account, member, nowMs, expanded }) => {
  const windows = member?.windows ?? [];
  const credits = reportsNumericCredits(account) ? member?.credits : undefined;
  return h(
    'li',
    {
      class: `m4-account m4-quota-member ${account.state}${accountBlocked(account, nowMs) ? ' blocked' : ''}`,
      'data-provider': account.provider,
      'data-provenance': account.provenance,
    },
    h(
      'h4',
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
    expanded && member && windows.length === 0 && !credits?.length
      ? h('p', { class: 'm4-note m4-quota-empty' }, quotaGraphTexts.noReadings)
      : null,
    expanded &&
      windows.map((/** @type {any} */ series) =>
        h(QuotaGraph, { series, account, nowMs }),
      ),
    expanded && credits?.length
      ? h(CreditGraph, { records: credits, account, nowMs })
      : null,
  );
};

/**
 * The quota history of one pool, asked again when `rev` moves.
 *
 * @param {{ feed: import('./feed.js').AccountsFeed, pool: any, rev: number, now?: () => number, tickMs?: number }} props
 */
export const PoolQuotaHistory = ({
  feed,
  pool,
  rev,
  now = Date.now,
  tickMs = QUOTA_TICK_MS,
}) => {
  const [state, setState] = useState(
    /** @type {{ history?: any, error?: string }} */ ({}),
  );
  const [expanded, setExpanded] = useState(false);
  const hasHistory = state.history?.members.some(
    (/** @type {any} */ member) =>
      member.windows.length || member.credits?.length,
  );
  const nowMs = useNow(now, tickMs, Boolean(hasHistory));
  useEffect(() => {
    let live = true;
    readHistory(feed, pool.backend).then(
      history => {
        if (live) setState({ history });
      },
      thrown => {
        // The last graph stays; the failure is said beside it.
        if (live)
          setState(previous => ({ ...previous, error: messageOf(thrown) }));
      },
    );
    return () => {
      live = false;
    };
  }, [feed, pool.backend, rev]);

  const { history, error } = state;
  const accounts = pool.members;
  return h(
    'section',
    {
      class: 'm4-quota',
      'aria-label': `${quotaGraphTexts.title}: ${pool.label}`,
      'data-kind': pool.kind,
    },
    error === undefined
      ? null
      : h(
          'p',
          { class: 'm4-note m4-quota-error', role: 'status' },
          `${history === undefined ? quotaGraphTexts.unavailable : quotaGraphTexts.stale}: ${error}`,
        ),
    history
      ? h(PoolOverviewGraph, { pool, history, nowMs })
      : history === null
        ? h(
            'p',
            { class: 'm4-note m4-quota-empty' },
            quotaGraphTexts.noReadings,
          )
        : error === undefined
          ? h('p', { class: 'm4-note' }, quotaGraphTexts.loading)
          : null,
    h(
      'details',
      {
        class: 'm4-individual-subscriptions',
        onToggle: (/** @type {Event} */ event) =>
          setExpanded(
            /** @type {HTMLDetailsElement} */ (event.currentTarget).open,
          ),
      },
      h('summary', null, `Individual subscriptions (${accounts.length})`),
      h(
        'ul',
        { class: 'm4-account-list' },
        accounts.map(
          (/** @type {any} */ account, /** @type {number} */ index) => {
            const entry = history?.members[index];
            const member =
              entry?.provider === account.provider &&
              entry.label === account.label
                ? entry
                : undefined;
            return h(IndividualSubscription, {
              account,
              member,
              nowMs,
              expanded,
            });
          },
        ),
      ),
    ),
  );
};
