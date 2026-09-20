// @ts-check

import { Fail, q } from '@endo/errors';

/**
 * Which of a provider's subscriptions serves a request.
 *
 * What is lost when a rate-limit window resets is the part of it nobody used,
 * so the default **drains the subscription whose allowance expires soonest**.
 * A conversation's prompt cache does not follow it to another account, so a
 * session **stays where it is while its cache is warm**, and re-chooses only
 * once the cache is gone anyway or its subscription refuses. A session may
 * instead be **pinned** to one subscription.
 *
 * This module is the rule and nothing else: it holds no credential and makes
 * no request. Its inputs are the declared set, each member's last account
 * reading (`rateLimits` as `account.js` normalizes it, or undefined), where a
 * session was last served, and the marks left by refusals.
 *
 * See designs/hosted-agent-subscriptions.md, "Selection".
 */

/** How long a "limit reached" that names no window is believed. */
const UNDATED_BLOCK_MS = 3_600_000;
/** A refusal with no readable reset time: one minute, doubling to an hour. */
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;

/**
 * @typedef {object} PoolMember
 * @property {string} id
 * @property {string} label
 * @property {number} weight Relative size of the plan; for display and ties.
 */

/**
 * @typedef {object} Standing
 * @property {boolean} known Whether any reading exists.
 * @property {boolean} blocked
 * @property {number | null} blockedUntilMs When it is expected back, if known.
 * @property {number | null} longResetMs When the long window resets, if one is
 *   running.
 * @property {number | null} longUsedFraction How full that window is.
 */

/**
 * Where one subscription stands at an instant, from its last reading. A
 * reading ages: a window whose reset time has passed is empty again, whatever
 * the reading said.
 *
 * - A full window blocks until it resets.
 * - The provider's own word that the limit is reached, with no window full
 *   (depleted credits, a spend control), stands until every window the
 *   reading named has reset.
 * - With no window at all it cannot say when it lifts, so it is believed for
 *   an hour from the reading.
 *
 * @param {any} rateLimits
 * @param {number} nowMs
 * @returns {Standing}
 */
export const standingOf = (rateLimits, nowMs) => {
  if (
    rateLimits === null ||
    typeof rateLimits !== 'object' ||
    rateLimits.source === 'unavailable'
  ) {
    return harden({
      known: false,
      blocked: false,
      blockedUntilMs: null,
      longResetMs: null,
      longUsedFraction: null,
    });
  }
  /**
   * @typedef {object} WindowNow
   * @property {number | null} untilMs When it stops counting: its reset time,
   *   or for a window that gives none, an hour after the reading.
   * @property {boolean} dated Whether the provider gave a reset time.
   * @property {boolean} expired
   * @property {number} seconds
   * @property {boolean} long Whether the provider calls it the long window.
   * @property {number | null} usedFraction As it stands now: 0 once expired.
   * @property {boolean} wasFull Whether the reading said it was full.
   */
  const observedMs = Date.parse(rateLimits.observedAt);
  /** @type {any[]} */
  const declared = Array.isArray(rateLimits.windows) ? rateLimits.windows : [];
  /** @type {WindowNow[]} */
  const windows = declared.map(window => {
    const resetMs = Date.parse(window.resetsAt);
    const dated = Number.isFinite(resetMs);
    // A window that does not say when it resets cannot be believed for ever:
    // a member it blocked would get no request, so no reading would ever
    // replace it. It ages an hour from the reading; with no time on the
    // reading either, it does not count at all.
    let untilMs = null;
    if (dated) untilMs = resetMs;
    else if (Number.isFinite(observedMs))
      untilMs = observedMs + UNDATED_BLOCK_MS;
    const expired = untilMs === null || untilMs <= nowMs;
    // A normalized reading carries `usedFraction`; a raw one, as a broker's
    // account source holds it, carries `usedPercent`.
    /** @type {number | null} */
    let fraction = null;
    if (typeof window.usedFraction === 'number') {
      fraction = window.usedFraction;
    } else if (typeof window.usedPercent === 'number') {
      fraction = window.usedPercent / 100;
    }
    return {
      untilMs,
      dated,
      expired,
      seconds:
        typeof window.windowSeconds === 'number' ? window.windowSeconds : 0,
      long: window.windowId === 'secondary',
      usedFraction: expired ? 0 : fraction,
      wasFull: Number(fraction ?? 0) >= 1,
    };
  });
  const running = windows.filter(window => !window.expired);
  const latest = (/** @type {WindowNow[]} */ list) =>
    Math.max(...list.map(window => /** @type {number} */ (window.untilMs)));
  let blocked = false;
  /** @type {number | null} */
  let blockedUntilMs = null;
  const everFull = windows.filter(window => window.wasFull);
  if (everFull.length > 0) {
    // The provider's word that the limit is reached, beside a full window,
    // is about that window: it lifts when the window resets, not when the
    // others do. A five-hour limit must not block a member for the week.
    const stillFull = everFull.filter(window => !window.expired);
    blocked = stillFull.length > 0;
    blockedUntilMs = blocked ? latest(stillFull) : null;
  } else if (rateLimits.limitReached === true) {
    if (windows.length > 0) {
      // No window was full (depleted credits, a spend control): it stands
      // until every window the reading named has reset.
      blocked = running.length > 0;
      blockedUntilMs = blocked ? latest(running) : null;
    } else if (Number.isFinite(observedMs)) {
      blocked = nowMs - observedMs < UNDATED_BLOCK_MS;
      blockedUntilMs = blocked ? observedMs + UNDATED_BLOCK_MS : null;
    }
  }
  // The long window is the one that runs out: the longest still running that
  // says when it resets. Where lengths tie or are not given, the one the
  // provider calls the long one.
  const long = running
    .filter(window => window.dated)
    .sort(
      (a, b) => b.seconds - a.seconds || Number(b.long) - Number(a.long),
    )[0];
  return harden({
    known: true,
    blocked,
    blockedUntilMs,
    longResetMs: long ? long.untilMs : null,
    longUsedFraction: long ? long.usedFraction : null,
  });
};
harden(standingOf);

/**
 * The refusals a pool has seen, which outlive the reading that came with
 * them: a member that refused is skipped until the time it named, or, when it
 * named none, for a pause that doubles with each refusal in a row.
 *
 * @param {object} [options]
 * @param {Record<string, { untilMs: number, strikes: number }>} [options.initial]
 *   What a previous incarnation recorded.
 * @param {(marks: Record<string, { untilMs: number, strikes: number }>) => void} [options.onChange]
 *   Called when the marks change, for the owner to make durable.
 */
export const makeRefusalMarks = ({
  initial = {},
  onChange = () => {},
} = {}) => {
  /** @type {Map<string, { untilMs: number, strikes: number }>} */
  const marks = new Map(Object.entries(initial));
  const changed = () => onChange(harden(Object.fromEntries(marks)));
  return harden({
    /**
     * @param {string} memberId
     * @param {number} nowMs
     * @param {number | null} untilMs The reset time the refusal's reading
     *   gave, or null.
     */
    refused: (memberId, nowMs, untilMs) => {
      const before = marks.get(memberId);
      const dated = untilMs !== null && untilMs > nowMs ? untilMs : null;
      if (before !== undefined && before.untilMs > nowMs) {
        // Already skipped: requests that were in flight when it drained all
        // report the same event, and are not refusals "in a row". A later
        // time the provider named still extends the mark.
        if (dated !== null && dated > before.untilMs) {
          marks.set(memberId, { untilMs: dated, strikes: before.strikes });
          changed();
        }
        return;
      }
      // A refusal right after a mark lapsed is the next in a row; any other
      // starts over. "Right after" is one more pause of the size it had.
      const lastPause =
        before === undefined
          ? 0
          : Math.min(
              BACKOFF_START_MS * 2 ** (before.strikes - 1),
              BACKOFF_MAX_MS,
            );
      const inARow =
        before !== undefined && nowMs - before.untilMs <= lastPause;
      const strikes = inARow ? before.strikes + 1 : 1;
      const pause = Math.min(
        BACKOFF_START_MS * 2 ** (strikes - 1),
        BACKOFF_MAX_MS,
      );
      marks.set(memberId, { untilMs: dated ?? nowMs + pause, strikes });
      changed();
    },
    /** @param {string} memberId */
    served: memberId => {
      if (marks.delete(memberId)) changed();
    },
    /**
     * @param {string} memberId
     * @param {number} nowMs
     * @returns {number | null} until when it is skipped, or null
     */
    blockedUntil: (memberId, nowMs) => {
      const mark = marks.get(memberId);
      return mark && mark.untilMs > nowMs ? mark.untilMs : null;
    },
    /**
     * Drop marks for members no longer in the set. @param {string[]} ids
     * @param ids
     */
    retain: ids => {
      let dropped = false;
      for (const id of [...marks.keys()]) {
        if (!ids.includes(id)) dropped = marks.delete(id) || dropped;
      }
      if (dropped) changed();
    },
  });
};
harden(makeRefusalMarks);

/**
 * The subscriptions to try for one request, in order. The first is the
 * choice; the rest are where the request is handed if the ones before refuse
 * it as exhausted.
 *
 * @param {object} options
 * @param {readonly PoolMember[]} options.members In declared order.
 * @param {(memberId: string) => any} options.readingOf The member's last
 *   `rateLimits` reading, or undefined.
 * @param {(memberId: string, nowMs: number) => number | null} options.refusedUntil
 * @param {string} options.preference `'auto'` or a member id.
 * @param {{ memberId: string, atMs: number } | undefined} options.last Where
 *   this session was last served.
 * @param {number} options.cacheLifetimeMs How long the provider keeps a
 *   prompt cache warm; declared, since it cannot be observed.
 * @param {number} options.nowMs
 * @returns {{ order: string[], earliestBackMs: number | null }}
 */
export const selectMembers = ({
  members,
  readingOf,
  refusedUntil,
  preference,
  last,
  cacheLifetimeMs,
  nowMs,
}) => {
  const ids = members.map(member => member.id);
  if (preference !== 'auto') {
    // A pinned session uses its subscription and no other, and does not fall
    // through when that subscription has left the set.
    ids.includes(preference) ||
      Fail`Subscription ${q(preference)} is not in this provider's set`;
  }
  const candidates = members
    .filter(member => preference === 'auto' || member.id === preference)
    .map((member, index) => {
      const standing = standingOf(readingOf(member.id), nowMs);
      const refused = refusedUntil(member.id, nowMs);
      const blocked = standing.blocked || refused !== null;
      let backMs = null;
      if (blocked) {
        const times = [standing.blockedUntilMs, refused].filter(
          time => time !== null,
        );
        backMs = times.length
          ? Math.max(.../** @type {number[]} */ (times))
          : null;
      }
      // 0: a long window is running; 1: nothing known; 2: no window running,
      // so nothing of it is about to expire.
      let rank = 1;
      if (standing.known) rank = standing.longResetMs === null ? 2 : 0;
      return { member, index, standing, blocked, backMs, rank };
    });
  const open = candidates.filter(candidate => !candidate.blocked);
  open.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 0) {
      const byReset =
        /** @type {number} */ (a.standing.longResetMs) -
        /** @type {number} */ (b.standing.longResetMs);
      if (byReset !== 0) return byReset;
      // Least remaining first: finish the one that is nearly spent.
      const byUsed =
        (b.standing.longUsedFraction ?? 0) - (a.standing.longUsedFraction ?? 0);
      if (byUsed !== 0) return byUsed;
    }
    return a.index - b.index;
  });
  let order = open.map(candidate => candidate.member.id);
  // Stay while warm: a move costs a full-context uncached read, and a cold
  // move costs nothing.
  if (
    last !== undefined &&
    order.includes(last.memberId) &&
    nowMs - last.atMs < cacheLifetimeMs
  ) {
    order = [last.memberId, ...order.filter(id => id !== last.memberId)];
  }
  const backs = candidates
    .filter(candidate => candidate.blocked && candidate.backMs !== null)
    .map(candidate => /** @type {number} */ (candidate.backMs));
  return harden({
    order,
    earliestBackMs: backs.length ? Math.min(...backs) : null,
  });
};
harden(selectMembers);

/** How stale a session's persisted "last served" time may be. */
const SERVED_STAMP_MS = 60_000;
/**
 * How many sessions' last-served records a pool keeps. A pool is never told
 * that a session was deleted, so the record is bounded instead: past this the
 * least recently served is dropped, which costs that session one cold choice.
 */
const MAX_SESSION_RECORDS = 256;

const SUBSCRIPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Validate and copy an operator's declared set, as it is stored:
 * `{ cacheLifetimeSeconds?, members: [{ id, label?, weight?, accountRef?,
 * secretName? }] }`. Order is the declared order, which breaks ties.
 *
 * Two members may not name one account or one secret: a handover would retry
 * the account that just refused, and two credential objects over one secret
 * record would each redeem its refresh token.
 *
 * @param {any} candidate
 * @param {object} [options]
 * @param {boolean} [options.requireAccountRef] For a provider whose
 *   credential names an account (OAuth): every member must say which, since
 *   there is no pool-wide account for it to inherit.
 */
export const normalizeSubscriptionSet = (
  candidate,
  { requireAccountRef = false } = {},
) => {
  (candidate !== null && typeof candidate === 'object') ||
    Fail`A subscription set must be a record`;
  const { members, cacheLifetimeSeconds = 300 } = candidate;
  (Array.isArray(members) && members.length > 0 && members.length <= 16) ||
    Fail`A subscription set must list between 1 and 16 members`;
  (typeof cacheLifetimeSeconds === 'number' &&
    Number.isFinite(cacheLifetimeSeconds) &&
    cacheLifetimeSeconds >= 0 &&
    cacheLifetimeSeconds <= 86_400) ||
    Fail`Invalid prompt cache lifetime`;
  const projected = members.map(member => {
    (member !== null && typeof member === 'object') ||
      Fail`A subscription must be a record`;
    const { id, label = id, weight = 1, accountRef, secretName = id } = member;
    (typeof id === 'string' && SUBSCRIPTION_ID.test(id) && id !== 'auto') ||
      Fail`Invalid subscription id ${q(id)}`;
    (typeof label === 'string' && label.length > 0 && label.length <= 128) ||
      Fail`Invalid label for subscription ${q(id)}`;
    (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) ||
      Fail`Invalid weight for subscription ${q(id)}`;
    accountRef === undefined ||
      (typeof accountRef === 'string' &&
        /^[A-Za-z0-9_-]{1,256}$/.test(accountRef)) ||
      Fail`Invalid account for subscription ${q(id)}`;
    (typeof secretName === 'string' && SUBSCRIPTION_ID.test(secretName)) ||
      Fail`Invalid secret name for subscription ${q(id)}`;
    return harden({
      id,
      label,
      weight,
      secretName,
      ...(accountRef === undefined ? {} : { accountRef }),
    });
  });
  const distinct = (/** @type {unknown[]} */ values) =>
    new Set(values).size === values.length;
  distinct(projected.map(member => member.id)) ||
    Fail`Subscription ids must be distinct`;
  distinct(projected.map(member => member.secretName)) ||
    Fail`Subscriptions must not share a secret`;
  const accounts = projected.flatMap(member =>
    member.accountRef === undefined ? [] : [member.accountRef],
  );
  distinct(accounts) || Fail`Subscriptions must not share an account`;
  !requireAccountRef ||
    accounts.length === projected.length ||
    Fail`Every subscription of this provider must name its account`;
  return harden({ cacheLifetimeSeconds, members: projected });
};
harden(normalizeSubscriptionSet);

/**
 * @typedef {object} PoolState What of a pool outlives a restart.
 * @property {Record<string, { untilMs: number, strikes: number }>} refusals
 * @property {Record<string, { memberId: string, atMs: number }>} sessions
 */

/**
 * A provider's subscriptions as one chooser. It holds no credential; it
 * applies `selectMembers` for each request of each session, remembers where a
 * session was last served and which members refused, and offers both for
 * keeping whenever they change materially.
 *
 * @param {object} options
 * @param {() => readonly PoolMember[]} options.members The declared set now.
 *   Asked per request: a member added or removed is seen at once.
 * @param {(memberId: string) => any} options.readingOf
 * @param {number | (() => number)} options.cacheLifetimeMs A number, or a
 *   function asked per request so that an operator's edit of the set applies.
 * @param {() => number} [options.now]
 * @param {PoolState} [options.initial] What a previous incarnation kept.
 * @param {(state: PoolState) => void} [options.onChange] Called with the
 *   state to keep; not called for a served time that merely advanced.
 */
export const makeSubscriptionPool = ({
  members,
  readingOf,
  cacheLifetimeMs,
  now = Date.now,
  initial,
  onChange = () => {},
}) => {
  const cacheLifetime = () => {
    const value =
      typeof cacheLifetimeMs === 'function'
        ? cacheLifetimeMs()
        : cacheLifetimeMs;
    (Number.isFinite(value) && value >= 0) ||
      Fail`Invalid prompt cache lifetime`;
    return value;
  };
  cacheLifetime();
  /** @type {Map<string, { memberId: string, atMs: number }>} */
  const sessions = new Map(Object.entries(initial?.sessions ?? {}));
  /** What was last offered for keeping, per session. */
  /** @type {Map<string, { memberId: string, atMs: number }>} */
  const kept = new Map(sessions);
  /** @type {Record<string, { untilMs: number, strikes: number }>} */
  let refusals = initial?.refusals ?? {};
  const save = () =>
    onChange(harden({ refusals, sessions: Object.fromEntries(kept) }));
  const marks = makeRefusalMarks({
    initial: refusals,
    onChange: next => {
      refusals = next;
      save();
    },
  });

  /**
   * What a grant's `pool` needs for one session.
   *
   * @param {string} sessionId
   * @param {string} [preference] `'auto'` or a member id.
   */
  const forSession = (sessionId, preference = 'auto') =>
    harden({
      select: () => {
        const declared = members();
        marks.retain(declared.map(member => member.id));
        return [
          ...selectMembers({
            members: declared,
            readingOf,
            refusedUntil: marks.blockedUntil,
            preference,
            last: sessions.get(sessionId),
            cacheLifetimeMs: cacheLifetime(),
            nowMs: now(),
          }).order,
        ];
      },
      /** @param {string} memberId */
      served: memberId => {
        const atMs = now();
        sessions.set(sessionId, { memberId, atMs });
        marks.served(memberId);
        const before = kept.get(sessionId);
        // Kept when the session moved, or the stamp kept is a minute old: a
        // restart then errs by at most that in judging the cache warm.
        if (
          before === undefined ||
          before.memberId !== memberId ||
          atMs - before.atMs >= SERVED_STAMP_MS
        ) {
          // Re-inserted, so the map's order is least recently served first.
          kept.delete(sessionId);
          kept.set(sessionId, { memberId, atMs });
          while (kept.size > MAX_SESSION_RECORDS) {
            const [oldest] = kept.keys();
            kept.delete(oldest);
            sessions.delete(oldest);
          }
          save();
        }
      },
      /**
       * The member could not be used at all: its credential would not
       * resolve, or the upstream rejected it even after a refresh. It is
       * skipped for a pause that doubles, so one broken member does not wedge
       * every cold session onto itself while the others sit idle.
       *
       * @param {string} memberId
       */
      unusable: memberId => marks.refused(memberId, now(), null),
      /** @param {string} memberId */
      exhausted: memberId => {
        const nowMs = now();
        // The refusal's own reading reached the member's account source
        // before the refusal was thrown, so it says until when.
        const { blockedUntilMs } = standingOf(readingOf(memberId), nowMs);
        marks.refused(memberId, nowMs, blockedUntilMs);
      },
    });

  return harden({
    forSession,
    /**
     * A session is gone: its record is not kept. @param {string} sessionId
     * @param sessionId
     */
    forget: sessionId => {
      sessions.delete(sessionId);
      if (kept.delete(sessionId)) save();
    },
    /** Where every member stands now, for status. */
    standings: () => {
      const nowMs = now();
      return harden(
        members().map(member => {
          const standing = standingOf(readingOf(member.id), nowMs);
          const refused = marks.blockedUntil(member.id, nowMs);
          return {
            ...member,
            ...standing,
            blocked: standing.blocked || refused !== null,
            blockedUntilMs:
              refused !== null &&
              (standing.blockedUntilMs === null ||
                refused > standing.blockedUntilMs)
                ? refused
                : standing.blockedUntilMs,
          };
        }),
      );
    },
  });
};
harden(makeSubscriptionPool);
