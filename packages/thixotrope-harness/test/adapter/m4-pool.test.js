// @ts-check
// M4 W4.2: the pool core (resources/agent-host/impl/subscriptions/pool.js;
// designs/m4-interfaces.md 5.1; R4-24, R4-25, R4-103). Ported from
// hosted-agent test/subscription-pool.test.js (1315bef86) with object keys
// (PoolMember and Session presences, never ids) and without pinning, shares
// or the set normaliser (D-M4-6). No supervisor; runs in well under a second.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import {
  makePoolCore,
  makeRefusalMarks,
  MAX_DATED_MARK_MS,
  selectMembers,
  standingOf,
} from '../../resources/agent-host/impl/subscriptions/pool.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const at = (/** @type {string} */ iso) => Date.parse(iso);
const READ_AT = at('2026-09-20T11:59:00.000Z');

/**
 * @param {any[]} windows
 * @param {object} [extra]
 * @returns {any}
 */
const reading = (windows, extra = {}) =>
  harden({
    at: READ_AT,
    source: 'observed',
    windows,
    limitReached: false,
    ...extra,
  });
const weekly = (/** @type {number} */ used, /** @type {string} */ resets) => ({
  name: 'secondary',
  windowMinutes: 10_080,
  usedPercent: used * 100,
  resetsAtMs: at(resets),
});
const fiveHour = (
  /** @type {number} */ used,
  /** @type {string} */ resets,
) => ({
  name: 'primary',
  windowMinutes: 300,
  usedPercent: used * 100,
  resetsAtMs: at(resets),
});

/**
 * @param {string} label
 * @returns {import('../../resources/agent-host/impl/subscriptions/types.js').MemberEntry}
 */
const entry = label =>
  harden({
    member: Far('PoolMember', {}),
    label,
    provider: 'claude',
    weight: 1,
    key: `k-${label}`,
    state: 'active',
  });
const work = entry('Work');
const home = entry('Home');
const spare = entry('Spare');
const members = harden([work, home, spare]);
/**
 * Labels of an order, for readable assertions only.
 * @param {readonly any[]} order
 */
const labels = order => order.map(e => e.label);

const noMarks = () => makeRefusalMarks();

/**
 * @param {Map<any, any> | Record<string, any>} readings by entry
 * @param {object} [options]
 */
const select = (readings, options = {}) => {
  const byMember = new Map();
  for (const [e, r] of readings instanceof Map
    ? readings
    : Object.entries(readings).map(([name, value]) => [
        members.find(m => m.label === name),
        value,
      ])) {
    byMember.set(/** @type {any} */ (e).member, r);
  }
  return selectMembers({
    members,
    readingOf: member => byMember.get(member),
    marks: noMarks(),
    last: undefined,
    cacheLifetimeMs: 300_000,
    nowMs: NOW,
    ...options,
  });
};

test('the soonest reset is drained first, not the fullest or the emptiest', t => {
  const { order } = select({
    Work: reading([weekly(0.05, '2026-09-26T12:00:00.000Z')]),
    Home: reading([weekly(0.6, '2026-09-20T14:00:00.000Z')]),
    Spare: reading([weekly(0.5, '2026-09-23T12:00:00.000Z')]),
  });
  t.deepEqual(labels(order), ['Home', 'Spare', 'Work']);
  // The order holds the entries themselves (objects, not names).
  t.is(order[0], home);
});

test('equal resets go to the one nearly spent, then to declared order', t => {
  const reset = '2026-09-22T00:00:00.000Z';
  t.deepEqual(
    labels(
      select({
        Work: reading([weekly(0.2, reset)]),
        Home: reading([weekly(0.9, reset)]),
        Spare: reading([weekly(0.2, reset)]),
      }).order,
    ),
    ['Home', 'Work', 'Spare'],
  );
});

test('running windows first, then the unknown, then nothing about to expire', t => {
  const { order } = select({
    Work: reading([weekly(0.8, '2026-09-19T00:00:00.000Z')]),
    Spare: reading([weekly(0.1, '2026-09-25T00:00:00.000Z')]),
  });
  t.deepEqual(labels(order), ['Spare', 'Home', 'Work']);
  t.deepEqual(labels(select({}).order), ['Work', 'Home', 'Spare']);
});

test('retired members are never chosen', t => {
  const retired = harden({ ...spare, state: /** @type {const} */ ('retired') });
  const { order } = selectMembers({
    members: [work, home, retired],
    readingOf: () => undefined,
    marks: noMarks(),
    last: undefined,
    cacheLifetimeMs: 300_000,
    nowMs: NOW,
  });
  t.deepEqual(labels(order), ['Work', 'Home']);
});

test('a full window blocks until it resets, and a short one unblocks by itself', t => {
  const readings = {
    Work: reading([
      fiveHour(1, '2026-09-20T13:00:00.000Z'),
      weekly(0.3, '2026-09-21T00:00:00.000Z'),
    ]),
    Home: reading([weekly(0.3, '2026-09-24T00:00:00.000Z')]),
  };
  const blocked = select(readings);
  t.deepEqual(labels(blocked.order), ['Home', 'Spare']);
  t.is(blocked.earliestBackMs, at('2026-09-20T13:00:00.000Z'));
  t.is(blocked.earliestDatedBackMs, at('2026-09-20T13:00:00.000Z'));
  t.deepEqual(
    labels(select(readings, { nowMs: at('2026-09-20T13:00:01.000Z') }).order),
    ['Work', 'Home', 'Spare'],
  );
});

test('the provider’s word that the limit is reached ages by what the reading named', t => {
  const depleted = reading(
    [
      fiveHour(0.4, '2026-09-20T14:00:00.000Z'),
      weekly(0.4, '2026-09-23T00:00:00.000Z'),
    ],
    { limitReached: true },
  );
  t.true(standingOf(depleted, NOW).blocked);
  t.true(standingOf(depleted, at('2026-09-20T15:00:00.000Z')).blocked);
  t.false(standingOf(depleted, at('2026-09-23T00:00:01.000Z')).blocked);
  // With no window it is believed for an hour from the reading (R4-25).
  const undated = reading([], { limitReached: true });
  t.true(standingOf(undated, NOW).blocked);
  t.is(standingOf(undated, NOW).blockedUntilMs, at('2026-09-20T12:59:00.000Z'));
  t.false(standingOf(undated, NOW).blockedDated);
  t.false(standingOf(undated, at('2026-09-20T13:30:00.000Z')).blocked);
  t.deepEqual(standingOf(undefined, NOW), {
    known: false,
    blocked: false,
    blockedUntilMs: null,
    blockedDated: false,
    longResetMs: null,
    longUsedFraction: null,
  });
});

test('a session stays where its cache is warm, and re-chooses once it is cold', t => {
  const readings = {
    Work: reading([weekly(0.1, '2026-09-26T00:00:00.000Z')]),
    Home: reading([weekly(0.6, '2026-09-20T14:00:00.000Z')]),
  };
  t.deepEqual(
    labels(
      select(readings, { last: { member: work.member, at: NOW - 60_000 } })
        .order,
    ),
    ['Work', 'Home', 'Spare'],
  );
  t.deepEqual(
    labels(
      select(readings, { last: { member: work.member, at: NOW - 600_000 } })
        .order,
    ),
    ['Home', 'Work', 'Spare'],
  );
  // Warm, but it refuses: move.
  t.deepEqual(
    labels(
      select(
        { ...readings, Work: reading([weekly(1, '2026-09-26T00:00:00.000Z')]) },
        { last: { member: work.member, at: NOW - 60_000 } },
      ).order,
    ),
    ['Home', 'Spare'],
  );
  // Served by a member that has since left the pool: it is just not there.
  t.deepEqual(
    labels(
      select(readings, {
        last: { member: Far('PoolMember', {}), at: NOW - 1000 },
      }).order,
    ),
    ['Home', 'Work', 'Spare'],
  );
});

test('a refusal outlives its reading, and an undated one backs off', t => {
  /** @type {any[]} */
  const changes = [];
  const marks = makeRefusalMarks({
    onChange: (member, mark) => changes.push({ member, mark }),
  });
  const w = work.member;
  const h = home.member;
  marks.refused(w, NOW, at('2026-09-20T17:00:00.000Z'));
  t.is(marks.blockedUntil(w, NOW), at('2026-09-20T17:00:00.000Z'));
  t.is(marks.blockedUntil(w, at('2026-09-20T17:00:01.000Z')), null);
  // Undated: a minute; in-flight refusals of the same drain are one.
  marks.refused(h, NOW, null);
  const sent = changes.length;
  for (let index = 0; index < 5; index += 1) marks.refused(h, NOW, null);
  t.is(changes.length, sent, 'repeat refusals send nothing');
  t.is(marks.blockedUntil(h, NOW), NOW + 60_000);
  let clock = NOW + 61_000;
  marks.refused(h, clock, null);
  t.is(marks.blockedUntil(h, clock), clock + 120_000);
  for (let index = 0; index < 10; index += 1) {
    clock = /** @type {number} */ (marks.blockedUntil(h, clock)) + 1000;
    marks.refused(h, clock, null);
  }
  t.is(marks.blockedUntil(h, clock), clock + 3_600_000);
  clock += 86_400_000;
  marks.refused(h, clock, null);
  t.is(marks.blockedUntil(h, clock), clock + 60_000);
  marks.refused(h, clock, clock + 7_200_000);
  t.is(marks.blockedUntil(h, clock), clock + 7_200_000);
  marks.served(h);
  t.is(marks.blockedUntil(h, NOW), null);
  t.deepEqual(changes.at(-1), { member: h, mark: undefined });
  // A later incarnation starts from what the manager kept.
  const revived = makeRefusalMarks({
    initial: [{ member: w, mark: /** @type {any} */ (marks.get(w)) }],
  });
  t.is(revived.blockedUntil(w, NOW), at('2026-09-20T17:00:00.000Z'));
  revived.retain([h]);
  t.is(revived.blockedUntil(w, NOW), null);

  const chosen = select(
    { Work: reading([weekly(0.1, '2026-09-21T00:00:00.000Z')]) },
    { marks },
  );
  t.deepEqual(labels(chosen.order), ['Home', 'Spare']);
  t.is(chosen.earliestBackMs, at('2026-09-20T17:00:00.000Z'));
});

test('M4-FIX: a dated mark reaches at most eight days ahead, whatever the provider names', t => {
  const marks = makeRefusalMarks();
  const w = work.member;
  // A reset header of the year 2099 (accepted by the header parser).
  marks.refused(w, NOW, at('2099-01-01T00:00:00.000Z'));
  t.is(MAX_DATED_MARK_MS, 8 * 86_400_000);
  t.is(marks.blockedUntil(w, NOW), NOW + MAX_DATED_MARK_MS);
  t.is(marks.blockedUntil(w, NOW + MAX_DATED_MARK_MS + 1), null);
  // A week's reset is kept as named.
  const h = home.member;
  marks.refused(h, NOW, NOW + 7 * 86_400_000);
  t.is(marks.blockedUntil(h, NOW), NOW + 7 * 86_400_000);
});

test('a newer reading that shows the windows open supersedes a dated mark', t => {
  /** @type {any[]} */
  const changes = [];
  const marks = makeRefusalMarks({
    onChange: (member, mark) => changes.push({ member, mark }),
  });
  const weekOut = '2026-09-27T00:00:00.000Z';
  marks.refused(work.member, NOW, at(weekOut));
  const later = at('2026-09-20T13:00:00.000Z');
  const options = { marks, nowMs: later };
  const stale = reading([weekly(0.05, weekOut)]);
  t.deepEqual(labels(select({ Work: stale }, options).order), [
    'Home',
    'Spare',
  ]);
  const full = reading([weekly(1, weekOut)], {
    at: at('2026-09-20T12:30:00.000Z'),
  });
  t.deepEqual(labels(select({ Work: full }, options).order), ['Home', 'Spare']);
  t.is(changes.length, 1);
  const open = reading([weekly(0.05, weekOut)], {
    at: at('2026-09-20T12:30:00.000Z'),
  });
  t.deepEqual(labels(select({ Work: open }, options).order), [
    'Work',
    'Home',
    'Spare',
  ]);
  t.is(marks.blockedUntil(work.member, later), null);
  t.deepEqual(changes.at(-1), { member: work.member, mark: undefined });
  // The refusal's own reading never supersedes the mark it came with.
  marks.refused(work.member, later, at(weekOut));
  const own = reading([weekly(0.05, weekOut)], { at: later });
  t.deepEqual(
    labels(select({ Work: own }, { ...options, nowMs: later + 1000 }).order),
    ['Home', 'Spare'],
  );
  // A backoff mark (member unusable) is not about capacity: no reading lifts it.
  marks.refused(spare.member, later, null);
  const fresh = reading([weekly(0.05, weekOut)], { at: later + 30_000 });
  t.deepEqual(
    labels(
      select({ Spare: fresh }, { ...options, nowMs: later + 40_000 }).order,
    ),
    ['Home'],
  );
  t.is(marks.blockedUntil(spare.member, later + 40_000), later + 60_000);
});

test('the pool core keeps a session while warm and hands it over when refused', t => {
  let clock = NOW;
  const readings = new Map([
    [work.member, reading([weekly(0.1, '2026-09-26T00:00:00.000Z')])],
    [home.member, reading([weekly(0.6, '2026-09-20T14:00:00.000Z')])],
  ]);
  /** @type {any[]} */
  const changes = [];
  const two = harden([work, home]);
  const core = makePoolCore({
    members: () => two,
    readingOf: member => readings.get(member),
    cacheLifetimeMs: 300_000,
    now: () => clock,
    onChange: change => changes.push(change),
  });
  const s1 = Far('Session', {});
  const ticket = core.forSession(s1);
  t.deepEqual(labels(ticket.select()), ['Home', 'Work']);
  ticket.served(home.member);
  t.deepEqual(changes, [
    { served: [{ session: s1, member: home.member, at: NOW }] },
  ]);
  clock += 5000;
  t.deepEqual(labels(ticket.select()), ['Home', 'Work']);
  ticket.served(home.member);
  t.is(changes.length, 1, 'an advancing stamp is not reported');
  // A minute later the kept stamp is re-reported (servedStampMs).
  clock += 60_000;
  ticket.served(home.member);
  t.is(changes.length, 2);
  // Home drains: the refusal's reading arrived first and says until when.
  readings.set(
    home.member,
    reading([weekly(1, '2026-09-20T14:00:00.000Z')], { limitReached: true }),
  );
  ticket.exhausted(home.member, null);
  t.like(changes.at(-1).marks[0], { member: home.member });
  t.like(changes.at(-1).marks[0].mark, {
    untilMs: at('2026-09-20T14:00:00.000Z'),
    dated: true,
    sinceMs: clock,
  });
  t.deepEqual(labels(ticket.select()), ['Work']);
  ticket.served(work.member);
  t.deepEqual(changes.at(-1), {
    served: [{ session: s1, member: work.member, at: clock }],
  });
  // Another session sees the same mark.
  t.deepEqual(labels(core.forSession(Far('Session', {})).select()), ['Work']);
  t.is(core.marks().size, 1);
  t.deepEqual(core.earliestBackMs(), {
    earliestBackMs: at('2026-09-20T14:00:00.000Z'),
    earliestDatedBackMs: at('2026-09-20T14:00:00.000Z'),
  });
  // An exhaustion whose headers named the time uses it directly.
  ticket.exhausted(work.member, at('2026-09-21T00:00:00.000Z'));
  t.deepEqual(ticket.select(), []);
  t.is(
    ticket.earliestBackMs().earliestDatedBackMs,
    at('2026-09-20T14:00:00.000Z'),
  );

  // A newer open reading lifts the dated mark through `observed` (R4-25).
  clock += 60_000;
  const open = reading([weekly(0.2, '2026-09-20T14:00:00.000Z')], {
    at: clock,
  });
  readings.set(home.member, open);
  core.observed(home.member, open);
  t.deepEqual(changes.at(-1), { marks: [{ member: home.member }] });
  t.deepEqual(labels(core.forSession(Far('Session', {})).select()), ['Home']);
});

test('a restarted core starts from what the manager kept', t => {
  let clock = NOW;
  const s1 = Far('Session', {});
  const two = harden([work, home]);
  const core = makePoolCore({
    members: two,
    readingOf: () => undefined,
    now: () => clock,
    initial: {
      marks: [
        {
          member: work.member,
          mark: {
            untilMs: at('2026-09-20T14:00:00.000Z'),
            strikes: 1,
            sinceMs: NOW - 1000,
            dated: true,
          },
        },
      ],
      served: [{ session: s1, member: home.member, at: NOW - 30_000 }],
    },
  });
  // Work stays marked across the restart; s1 is still warm on Home.
  t.deepEqual(labels(core.forSession(s1).select()), ['Home']);
  clock = at('2026-09-20T14:00:01.000Z');
  // Cold now and Work is back: declaration order.
  t.deepEqual(labels(core.forSession(s1).select()), ['Work', 'Home']);
});

test('a member that cannot be used at all is skipped for a while, not for ever', t => {
  let clock = NOW;
  /** @type {any[]} */
  const changes = [];
  const core = makePoolCore({
    members: () => [work, home],
    readingOf: () => undefined,
    cacheLifetimeMs: () => 300_000,
    now: () => clock,
    onChange: change => changes.push(change),
  });
  const ticket = core.forSession(Far('Session', {}));
  t.deepEqual(labels(ticket.select()), ['Work', 'Home']);
  ticket.unusable(work.member);
  t.like(changes.at(-1).marks[0].mark, { dated: false, strikes: 1 });
  t.deepEqual(labels(ticket.select()), ['Home']);
  t.is(ticket.earliestBackMs().earliestDatedBackMs, null);
  t.is(ticket.earliestBackMs().earliestBackMs, NOW + 60_000);
  clock += 61_000;
  t.deepEqual(labels(ticket.select()), ['Work', 'Home']);
});

test('the record of where sessions were served is bounded at 256', t => {
  let clock = NOW;
  /** @type {any[]} */
  const served = [];
  const one = harden([work]);
  const core = makePoolCore({
    members: one,
    readingOf: () => undefined,
    now: () => clock,
    onChange: change => served.push(...(change.served ?? [])),
  });
  const sessions = Array.from({ length: 300 }, () => Far('Session', {}));
  for (const session of sessions) {
    clock += 1;
    core.forSession(session).served(work.member);
  }
  t.is(served.length, 300);
  // The first session's record was dropped: serving it again is a move.
  const before = served.length;
  core.forSession(sessions[0]).served(work.member);
  t.is(served.length, before + 1);
  // The last one's was kept: serving it again soon is not reported.
  core.forSession(sessions[299]).served(work.member);
  t.is(served.length, before + 1);
});

test('a five-hour limit blocks for five hours, not for the week', t => {
  const refused = reading(
    [
      fiveHour(1, '2026-09-20T14:00:00.000Z'),
      weekly(0.4, '2026-09-25T00:00:00.000Z'),
    ],
    { limitReached: true },
  );
  t.true(standingOf(refused, NOW).blocked);
  t.is(standingOf(refused, NOW).blockedUntilMs, at('2026-09-20T14:00:00.000Z'));
  const later = standingOf(refused, at('2026-09-20T14:01:00.000Z'));
  t.false(later.blocked);
  t.is(later.longResetMs, at('2026-09-25T00:00:00.000Z'));
});

test('a window that does not say when it resets cannot block for ever', t => {
  const undated = reading([{ name: 'primary', usedPercent: 100 }]);
  t.true(standingOf(undated, NOW).blocked);
  t.is(standingOf(undated, NOW).blockedUntilMs, at('2026-09-20T12:59:00.000Z'));
  t.false(standingOf(undated, NOW).blockedDated);
  t.false(standingOf(undated, at('2026-09-20T13:00:00.000Z')).blocked);
  const mixed = reading(
    [
      { name: 'primary', usedPercent: 100 },
      weekly(0.2, '2026-09-24T00:00:00.000Z'),
    ],
    { limitReached: true },
  );
  t.true(standingOf(mixed, NOW).blocked);
  const aged = standingOf(mixed, at('2026-09-20T13:30:00.000Z'));
  t.false(aged.blocked);
  t.is(aged.longResetMs, at('2026-09-24T00:00:00.000Z'));
  // With no time on the reading either, it says nothing.
  t.false(
    standingOf(
      /** @type {any} */ ({ windows: [{ name: 'primary', usedPercent: 100 }] }),
      NOW,
    ).blocked,
  );
  // Two windows that give no length: the one the provider calls long is.
  t.is(
    standingOf(
      reading([
        {
          name: 'primary',
          usedPercent: 10,
          resetsAtMs: at('2026-09-20T15:00:00.000Z'),
        },
        {
          name: 'secondary',
          usedPercent: 10,
          resetsAtMs: at('2026-09-27T00:00:00.000Z'),
        },
      ]),
      NOW,
    ).longResetMs,
    at('2026-09-27T00:00:00.000Z'),
  );
});

test('settings shorten the backoff and the stamp age (tests and perf use them)', t => {
  let clock = NOW;
  /** @type {any[]} */
  const changes = [];
  const core = makePoolCore({
    members: [work],
    readingOf: () => undefined,
    now: () => clock,
    onChange: change => changes.push(change),
    settings: { backoffStartMs: 10, servedStampMs: 5 },
  });
  const ticket = core.forSession(Far('Session', {}));
  ticket.unusable(work.member);
  t.is(changes.at(-1).marks[0].mark.untilMs, NOW + 10);
  clock += 11;
  ticket.served(work.member);
  const count = changes.length;
  clock += 5;
  ticket.served(work.member);
  t.is(changes.length, count + 1);
});
