// @ts-check
/**
 * Which member of a subscription pool serves a round (M4 W4.2;
 * `designs/m4-interfaces.md` 5.1; R4-24, R4-25, R4-103). Port of
 * hosted-agent `src/subscription-pool.js` (1315bef86): `standingOf`,
 * `makeRefusalMarks`, `selectMembers` and `makeSubscriptionPool` (here
 * `makePoolCore`), with two changes:
 *
 * - **Objects, not ids.** A member is its `PoolMember` presence (the
 *   `member` of a `MemberEntry`), a session its `Session` presence; marks
 *   and last-served records are Maps keyed by those presences. Nothing here
 *   takes or makes a name.
 * - **No pinning, no shares** (D-M4-6): selection is always `auto`, so the
 *   reference's `preference`, `pinnedOnly` and the set normaliser are gone
 *   (the manager vat validates a `PoolSpec`, W4.1).
 *
 * What a session loses when a rate-limit window resets is the part nobody
 * used, so `auto` drains the member whose long window resets soonest; a
 * prompt cache does not follow a session to another account, so a session
 * stays on the member that last served it while that cache is warm.
 *
 * This module is the rule and nothing else: it holds no credential, makes
 * no request and sends nothing. Durable state leaves it only through
 * `onChange(PoolChange)` (the manager bridge, `pool-state.js`, sends it on);
 * it is rebuilt from `initial` (the manager's `PoolState`) at an
 * incarnation's first use of the pool.
 *
 * Node only.
 */

/** @typedef {import('./types.js').MemberEntry} MemberEntry */
/** @typedef {import('./types.js').Mark} Mark */
/** @typedef {import('./types.js').Reading} Reading */
/** @typedef {import('./types.js').PoolChange} PoolChange */
/** @typedef {import('./types.js').PoolCore} PoolCore */
/** @typedef {import('./types.js').PoolTicket} PoolTicket */
/**
 * When the first blocked member is expected back (any mark, and only times a
 * provider named): the "expected back at" of a round that found every member
 * blocked (`m4TextOf.subscriptionsExhausted`).
 * @typedef {{ earliestBackMs: number | null, earliestDatedBackMs: number | null }} BackTimes
 * @typedef {PoolTicket & { earliestBackMs: () => BackTimes }} PoolTicketKit
 *   `PoolTicket` (types.js) plus `earliestBackMs()` (W4.2 addition)
 * @typedef {Omit<PoolCore, 'forSession'> & { forSession: (session: any) => PoolTicketKit, earliestBackMs: () => BackTimes }} PoolCoreKit
 *   `PoolCore` (types.js) whose tickets are `PoolTicketKit`s, plus
 *   `earliestBackMs()` for no session in particular
 */

/**
 * The selection settings, as `config/defaults-m4.js` `subscriptionDefaults`
 * (W4.1) names them; equal values. A caller passes `subscriptionDefaults` (or
 * a test's shorter times) as `settings`; anything left out falls back here.
 *
 * @typedef {object} PoolSettings
 * @property {number} backoffStartMs an undated refusal: one minute ...
 * @property {number} backoffMaxMs ... doubling to an hour while in a row
 * @property {number} undatedBlockMs how long a reading that names no reset
 *   time is believed
 * @property {number} servedStampMs a kept last-served stamp is re-sent once
 *   this old (the reference's `SERVED_STAMP_MS`)
 * @property {number} servedRecords last-served records per pool (R4-103)
 * @property {number} cacheLifetimeMs default prompt-cache lifetime (R4-103)
 */

/** @type {PoolSettings} */
export const poolSettingsDefaults = harden({
  backoffStartMs: 60_000,
  backoffMaxMs: 3_600_000,
  undatedBlockMs: 3_600_000,
  servedStampMs: 60_000,
  servedRecords: 256,
  cacheLifetimeMs: 300_000,
});

/**
 * @param {Partial<PoolSettings> | undefined} settings
 * @returns {PoolSettings}
 */
const settingsOf = settings => harden({ ...poolSettingsDefaults, ...settings });

/**
 * @typedef {object} Standing
 * @property {boolean} known whether any reading exists
 * @property {boolean} blocked
 * @property {number | null} blockedUntilMs when it is expected back, if known
 * @property {boolean} blockedDated whether that time is one the provider
 *   named (a window's reset), not an hour assumed for an undated reading
 * @property {number | null} longResetMs when the long window resets, if one
 *   is running
 * @property {number | null} longUsedFraction how full that window is
 */

const UNKNOWN = harden({
  known: false,
  blocked: false,
  blockedUntilMs: null,
  blockedDated: false,
  longResetMs: null,
  longUsedFraction: null,
});

/**
 * Where one member stands at an instant, from its last reading. A reading
 * ages: a window whose reset time has passed is empty again, whatever the
 * reading said.
 *
 * - A full window blocks until it resets (a five-hour limit does not block
 *   for the week).
 * - The provider's word that the limit is reached, with no window full
 *   (depleted credits, a spend control), stands until every window the
 *   reading named has reset.
 * - With no window at all it cannot say when it lifts: it is believed for
 *   `undatedBlockMs` (an hour) from the reading.
 * - A window that names no reset time ages `undatedBlockMs` from the
 *   reading, so it cannot block a member for ever.
 *
 * @param {Reading | undefined} reading
 * @param {number} nowMs
 * @param {Partial<PoolSettings>} [settings]
 * @returns {Standing}
 */
export const standingOf = (reading, nowMs, settings) => {
  if (reading === null || typeof reading !== 'object') return UNKNOWN;
  const { undatedBlockMs } = settingsOf(settings);
  const observedMs =
    typeof reading.at === 'number' && Number.isFinite(reading.at)
      ? reading.at
      : NaN;
  const declared = Array.isArray(reading.windows) ? reading.windows : [];
  const windows = declared.map(window => {
    const dated =
      typeof window.resetsAtMs === 'number' &&
      Number.isFinite(window.resetsAtMs);
    /** @type {number | null} */
    let untilMs = null;
    if (dated) untilMs = /** @type {number} */ (window.resetsAtMs);
    else if (Number.isFinite(observedMs)) untilMs = observedMs + undatedBlockMs;
    const expired = untilMs === null || untilMs <= nowMs;
    const fraction =
      typeof window.usedPercent === 'number' ? window.usedPercent / 100 : null;
    return {
      untilMs,
      dated,
      expired,
      minutes:
        typeof window.windowMinutes === 'number' ? window.windowMinutes : 0,
      long: window.name === 'secondary',
      usedFraction: expired ? 0 : fraction,
      wasFull: Number(fraction ?? 0) >= 1,
    };
  });
  /** @typedef {(typeof windows)[number]} WindowNow */
  const running = windows.filter(window => !window.expired);
  const latest = (/** @type {WindowNow[]} */ list) =>
    Math.max(...list.map(window => /** @type {number} */ (window.untilMs)));
  let blocked = false;
  /** @type {number | null} */
  let blockedUntilMs = null;
  let blockedDated = false;
  const everFull = windows.filter(window => window.wasFull);
  if (everFull.length > 0) {
    const stillFull = everFull.filter(window => !window.expired);
    blocked = stillFull.length > 0;
    blockedUntilMs = blocked ? latest(stillFull) : null;
    blockedDated = blocked && stillFull.every(window => window.dated);
  } else if (reading.limitReached === true) {
    if (windows.length > 0) {
      blocked = running.length > 0;
      blockedUntilMs = blocked ? latest(running) : null;
      blockedDated = blocked && running.every(window => window.dated);
    } else if (Number.isFinite(observedMs)) {
      blocked = nowMs - observedMs < undatedBlockMs;
      blockedUntilMs = blocked ? observedMs + undatedBlockMs : null;
    }
  }
  // The long window is the one that runs out: the longest still running that
  // names its reset; where lengths tie or are not given, the one the
  // provider calls long (`secondary`).
  const long = running
    .filter(window => window.dated)
    .sort(
      (a, b) => b.minutes - a.minutes || Number(b.long) - Number(a.long),
    )[0];
  return harden({
    known: true,
    blocked,
    blockedUntilMs,
    blockedDated,
    longResetMs: long ? long.untilMs : null,
    longUsedFraction: long ? long.usedFraction : null,
  });
};
harden(standingOf);

/**
 * @typedef {object} RefusalMarks
 * @property {(member: any, nowMs: number, untilMs: number | null) => void} refused
 * @property {(member: any) => void} served
 * @property {(member: any, nowMs: number) => number | null} blockedUntil
 * @property {(member: any) => Mark | undefined} get
 * @property {(member: any, observedMs: number) => boolean} supersededBy
 * @property {(members: readonly any[]) => void} retain drops the marks of
 *   members no longer in the pool, in memory only (a member's mark is shared
 *   by every pool it is in, so leaving one pool lifts nothing durable)
 * @property {() => Map<any, Mark>} snapshot
 */

/**
 * The refusals a pool has seen, which outlive the reading that came with
 * them: a member that refused is skipped until the time it named, or, when
 * it named none, for a pause that doubles with each refusal in a row (one
 * minute to an hour). A mark remembers when it was set (`sinceMs`) so a
 * reading taken later can outrank it (`supersededBy`).
 *
 * `onChange(member, mark | undefined)` is called once per durable change
 * (a new or extended mark, a lifted one); a refusal of a member already
 * skipped (requests in flight when it drained) changes nothing durable.
 *
 * @param {object} [options]
 * @param {Iterable<{ member: any, mark?: Mark }>} [options.initial] what the
 *   manager kept (`PoolState.members[].mark`)
 * @param {(member: any, mark: Mark | undefined) => void} [options.onChange]
 * @param {Partial<PoolSettings>} [options.settings]
 * @returns {RefusalMarks}
 */
/**
 * The furthest a dated mark reaches: the longest provider window (a week)
 * plus a day.
 */
export const MAX_DATED_MARK_MS = 8 * 86_400_000;

export const makeRefusalMarks = ({
  initial = [],
  onChange = () => {},
  settings,
} = {}) => {
  const { backoffStartMs, backoffMaxMs } = settingsOf(settings);
  /** @type {Map<any, Mark>} */
  const marks = new Map();
  for (const { member, mark } of initial) {
    if (mark !== undefined) {
      marks.set(
        member,
        harden({
          untilMs: mark.untilMs,
          strikes: mark.strikes,
          sinceMs: mark.sinceMs ?? 0,
          dated: mark.dated !== false,
        }),
      );
    }
  }
  /** @param {number} strikes */
  const pauseOf = strikes =>
    Math.min(backoffStartMs * 2 ** (strikes - 1), backoffMaxMs);
  /**
   * @param {any} member
   * @param {Mark} mark
   */
  const set = (member, mark) => {
    const frozen = harden(mark);
    marks.set(member, frozen);
    onChange(member, frozen);
  };

  return harden({
    refused: (member, nowMs, untilMs) => {
      const before = marks.get(member);
      // A provider's reset time is believed up to `MAX_DATED_MARK_MS` ahead
      // (M4-FIX): one answer cannot park a member for years.
      const dated =
        untilMs !== null && untilMs > nowMs
          ? Math.min(untilMs, nowMs + MAX_DATED_MARK_MS)
          : null;
      if (before !== undefined && before.untilMs > nowMs) {
        // Already skipped: in-flight requests report the same drain, and
        // are not refusals in a row. A later time the provider named still
        // extends the mark.
        if (dated !== null && dated > before.untilMs) {
          set(member, {
            untilMs: dated,
            strikes: before.strikes,
            sinceMs: nowMs,
            dated: true,
          });
        } else {
          // Its own reading must not outrank the mark: in memory only.
          marks.set(member, harden({ ...before, sinceMs: nowMs }));
        }
        return;
      }
      // A refusal right after a mark lapsed is the next in a row; any other
      // starts over. "Right after" is one more pause of the size it had.
      const lastPause = before === undefined ? 0 : pauseOf(before.strikes);
      const inARow =
        before !== undefined && nowMs - before.untilMs <= lastPause;
      const strikes = inARow ? before.strikes + 1 : 1;
      set(member, {
        untilMs: dated ?? nowMs + pauseOf(strikes),
        strikes,
        sinceMs: nowMs,
        dated: dated !== null,
      });
    },
    served: member => {
      if (marks.delete(member)) onChange(member, undefined);
    },
    blockedUntil: (member, nowMs) => {
      const mark = marks.get(member);
      return mark && mark.untilMs > nowMs ? mark.untilMs : null;
    },
    get: member => marks.get(member),
    supersededBy: (member, observedMs) => {
      const mark = marks.get(member);
      // Only a mark about capacity (dated) yields to a reading; a backoff
      // for a member that could not be used at all lapses by itself.
      if (mark === undefined || !mark.dated || !(observedMs > mark.sinceMs)) {
        return false;
      }
      marks.delete(member);
      onChange(member, undefined);
      return true;
    },
    retain: members => {
      const keep = new Set(members);
      for (const member of [...marks.keys()]) {
        if (!keep.has(member)) marks.delete(member);
      }
    },
    snapshot: () => new Map(marks),
  });
};
harden(makeRefusalMarks);

/**
 * A member's mark as it stands against its reading: until when it is
 * skipped, or null when it has none or a reading taken since the mark shows
 * its windows open (the newer word wins and the mark goes).
 *
 * @param {object} args
 * @param {any} args.member
 * @param {Reading | undefined} args.reading
 * @param {Standing} args.standing
 * @param {number} args.nowMs
 * @param {RefusalMarks} args.marks
 */
const refusalAgainstReading = ({ member, reading, standing, nowMs, marks }) => {
  const refused = marks.blockedUntil(member, nowMs);
  if (refused === null || !standing.known || standing.blocked) return refused;
  const observedMs = reading?.at;
  return typeof observedMs === 'number' &&
    Number.isFinite(observedMs) &&
    marks.supersededBy(member, observedMs)
    ? null
    : refused;
};

/**
 * The members to try for one round, in order (R4-24): the first is the
 * choice, the rest are where the round is handed if the ones before refuse
 * it as exhausted (R4-25). Retired and marked members are left out. Among
 * the open ones: those whose long window is running, by its reset (soonest
 * first), ties by the larger used fraction; then members with no reading;
 * then those with nothing running; declaration order breaks every tie. A
 * session stays on the member that last served it while that was within
 * `cacheLifetimeMs`.
 *
 * `earliestBackMs` is when the first blocked member is expected back;
 * `earliestDatedBackMs` the same over times a provider named (the "expected
 * back at" of `m4TextOf.subscriptionsExhausted`).
 *
 * @param {object} options
 * @param {readonly MemberEntry[]} options.members in declared order
 * @param {(member: any) => Reading | undefined} options.readingOf by the
 *   PoolMember presence
 * @param {RefusalMarks} options.marks
 * @param {{ member: any, at: number } | undefined} options.last where this
 *   session was last served
 * @param {number} options.cacheLifetimeMs
 * @param {number} options.nowMs
 * @param {Partial<PoolSettings>} [options.settings]
 * @returns {{ order: MemberEntry[], earliestBackMs: number | null, earliestDatedBackMs: number | null }}
 */
export const selectMembers = ({
  members,
  readingOf,
  marks,
  last,
  cacheLifetimeMs,
  nowMs,
  settings,
}) => {
  const candidates = members
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.state === 'active')
    .map(({ entry, index }) => {
      const reading = readingOf(entry.member);
      const standing = standingOf(reading, nowMs, settings);
      const refused = refusalAgainstReading({
        member: entry.member,
        reading,
        standing,
        nowMs,
        marks,
      });
      const blocked = standing.blocked || refused !== null;
      /** @type {number | null} */
      let backMs = null;
      let dated = false;
      if (blocked) {
        /** @type {{ at: number, dated: boolean }[]} */
        const times = [];
        if (standing.blocked && standing.blockedUntilMs !== null) {
          times.push({
            at: standing.blockedUntilMs,
            dated: standing.blockedDated,
          });
        }
        if (refused !== null) {
          times.push({
            at: refused,
            dated: marks.get(entry.member)?.dated === true,
          });
        }
        if (times.length > 0) {
          backMs = Math.max(...times.map(time => time.at));
          dated = times.every(time => time.dated);
        }
      }
      // 0: a long window is running; 1: nothing known; 2: no window running.
      let rank = 1;
      if (standing.known) rank = standing.longResetMs === null ? 2 : 0;
      return { entry, index, standing, blocked, backMs, dated, rank };
    });
  const open = candidates.filter(candidate => !candidate.blocked);
  open.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 0) {
      const byReset =
        /** @type {number} */ (a.standing.longResetMs) -
        /** @type {number} */ (b.standing.longResetMs);
      if (byReset !== 0) return byReset;
      const byUsed =
        (b.standing.longUsedFraction ?? 0) - (a.standing.longUsedFraction ?? 0);
      if (byUsed !== 0) return byUsed;
    }
    return a.index - b.index;
  });
  let order = open.map(candidate => candidate.entry);
  // Stay while warm: a move costs a full-context uncached read.
  if (last !== undefined && nowMs - last.at < cacheLifetimeMs) {
    const kept = order.find(entry => entry.member === last.member);
    if (kept !== undefined) {
      order = [kept, ...order.filter(entry => entry !== kept)];
    }
  }
  const blocked = candidates.filter(
    candidate => candidate.blocked && candidate.backMs !== null,
  );
  const earliest = (/** @type {typeof blocked} */ list) =>
    list.length
      ? Math.min(
          ...list.map(candidate => /** @type {number} */ (candidate.backMs)),
        )
      : null;
  return harden({
    order,
    earliestBackMs: earliest(blocked),
    earliestDatedBackMs: earliest(blocked.filter(candidate => candidate.dated)),
  });
};
harden(selectMembers);

/**
 * One pool's chooser for this incarnation (the reference's
 * `makeSubscriptionPool`). It applies `selectMembers` for each round of each
 * session, remembers where a session was last served and which members
 * refused, and reports durable changes through `onChange(PoolChange)`:
 *
 * - a mark set, extended or lifted: `{ marks: [{ member, mark? }] }`, once
 *   per change (the bridge sends it at once);
 * - a last-served stamp worth keeping: `{ served: [{ session, member, at }] }`
 *   when the session moved to another member or the kept stamp is
 *   `servedStampMs` old (the bridge coalesces them). A stamp that merely
 *   advanced is not reported.
 *
 * Last-served records are bounded at `servedRecords` (256) per pool, least
 * recently served dropped (a pool is never told that a session was deleted;
 * a dropped one costs that session one cold choice).
 *
 * @param {object} options
 * @param {readonly MemberEntry[] | (() => readonly MemberEntry[])} options.members
 *   the pool's members in declared order (asked per round when a function)
 * @param {(member: any) => Reading | undefined} options.readingOf
 * @param {number | (() => number)} [options.cacheLifetimeMs] `PoolSpec.cacheLifetimeMs`
 * @param {() => number} [options.now]
 * @param {{ marks?: Iterable<{ member: any, mark?: Mark }>, served?: Iterable<{ session: any, member: any, at: number }> }} [options.initial]
 *   what the manager kept (`initialFromPoolState`, `pool-state.js`)
 * @param {(change: PoolChange) => void} [options.onChange]
 * @param {Partial<PoolSettings>} [options.settings]
 * @returns {PoolCoreKit}
 */
export const makePoolCore = ({
  members,
  readingOf,
  cacheLifetimeMs,
  now = Date.now,
  initial,
  onChange = () => {},
  settings,
}) => {
  const resolved = settingsOf(settings);
  const membersNow = typeof members === 'function' ? members : () => members;
  const cacheLifetime = () => {
    const value =
      typeof cacheLifetimeMs === 'function'
        ? cacheLifetimeMs()
        : (cacheLifetimeMs ?? resolved.cacheLifetimeMs);
    if (!(Number.isFinite(value) && value >= 0)) {
      throw Error('Invalid prompt cache lifetime');
    }
    return value;
  };
  cacheLifetime();

  /**
   * Where each session was last served (live stamps), and what was last
   * reported for keeping; both in least-recently-kept order, same keys.
   * @type {Map<any, { member: any, at: number }>}
   */
  const sessions = new Map();
  /** @type {Map<any, { member: any, at: number }>} */
  const kept = new Map();
  for (const { session, member, at } of initial?.served ?? []) {
    kept.delete(session);
    kept.set(session, harden({ member, at }));
    sessions.set(session, harden({ member, at }));
  }
  const trim = () => {
    while (kept.size > resolved.servedRecords) {
      const [oldest] = kept.keys();
      kept.delete(oldest);
      sessions.delete(oldest);
    }
  };
  trim();

  const marks = makeRefusalMarks({
    initial: initial?.marks,
    settings: resolved,
    onChange: (member, mark) =>
      onChange(
        harden({
          marks: [mark === undefined ? { member } : { member, mark }],
        }),
      ),
  });

  /** @param {any} session */
  const choose = session => {
    const declared = membersNow();
    marks.retain(declared.map(entry => entry.member));
    return selectMembers({
      members: declared,
      readingOf,
      marks,
      last: sessions.get(session),
      cacheLifetimeMs: cacheLifetime(),
      nowMs: now(),
      settings: resolved,
    });
  };

  /**
   * @param {any} session
   * @returns {PoolTicketKit}
   */
  const forSession = session =>
    harden({
      select: () => [...choose(session).order],
      earliestBackMs: () => {
        const { earliestBackMs, earliestDatedBackMs } = choose(session);
        return harden({ earliestBackMs, earliestDatedBackMs });
      },
      served: member => {
        const at = now();
        sessions.set(session, harden({ member, at }));
        marks.served(member);
        const before = kept.get(session);
        if (
          before === undefined ||
          before.member !== member ||
          at - before.at >= resolved.servedStampMs
        ) {
          // Re-inserted so the map is least recently kept first.
          kept.delete(session);
          kept.set(session, harden({ member, at }));
          trim();
          onChange(harden({ served: [{ session, member, at }] }));
        }
      },
      unusable: member => marks.refused(member, now(), null),
      exhausted: (member, untilMs) => {
        const nowMs = now();
        // The refusal's own reading reached `readingOf` before the refusal
        // was reported (the wire calls `onReading` first), so when the
        // headers named no time the reading's standing may.
        const until =
          untilMs ??
          standingOf(readingOf(member), nowMs, resolved).blockedUntilMs;
        marks.refused(member, nowMs, until);
      },
    });

  return harden({
    forSession,
    marks: () => marks.snapshot(),
    observed: (member, reading) => {
      const standing = standingOf(reading, now(), resolved);
      if (standing.known && !standing.blocked) {
        marks.supersededBy(member, reading.at);
      }
    },
    earliestBackMs: () => {
      const { earliestBackMs, earliestDatedBackMs } = selectMembers({
        members: membersNow(),
        readingOf,
        marks,
        last: undefined,
        cacheLifetimeMs: cacheLifetime(),
        nowMs: now(),
        settings: resolved,
      });
      return harden({ earliestBackMs, earliestDatedBackMs });
    },
  });
};
harden(makePoolCore);
