// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeRefusalMarks,
  makeSubscriptionPool,
  normalizeSubscriptionSet,
  selectMembers,
  standingOf,
} from '../src/subscription-pool.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const at = iso => Date.parse(iso);

const limits = (windows, extra = {}) => ({
  windows,
  limitReached: false,
  source: 'observed',
  observedAt: '2026-09-20T11:59:00.000Z',
  ...extra,
});
const weekly = (usedFraction, resetsAt) => ({
  windowId: 'secondary',
  windowSeconds: 604_800,
  usedFraction,
  resetsAt,
});
const fiveHour = (usedFraction, resetsAt) => ({
  windowId: 'primary',
  windowSeconds: 18_000,
  usedFraction,
  resetsAt,
});

const members = harden([
  { id: 'work', label: 'Work', weight: 20 },
  { id: 'home', label: 'Home', weight: 1 },
  { id: 'spare', label: 'Spare', weight: 1 },
]);

const select = (readings, options = {}) =>
  selectMembers({
    members,
    readingOf: id => readings[id],
    refusedUntil: () => null,
    preference: 'auto',
    last: undefined,
    cacheLifetimeMs: 300_000,
    nowMs: NOW,
    ...options,
  });

test('the soonest reset is drained first, not the fullest or the emptiest', t => {
  const { order } = select({
    // 95% left, resets in six days.
    work: limits([weekly(0.05, '2026-09-26T12:00:00.000Z')]),
    // 40% left, resets in two hours: this is what is about to be lost.
    home: limits([weekly(0.6, '2026-09-20T14:00:00.000Z')]),
    spare: limits([weekly(0.5, '2026-09-23T12:00:00.000Z')]),
  });
  t.deepEqual(order, ['home', 'spare', 'work']);
});

test('equal resets go to the one nearly spent, then to declared order', t => {
  const reset = '2026-09-22T00:00:00.000Z';
  t.deepEqual(
    select({
      work: limits([weekly(0.2, reset)]),
      home: limits([weekly(0.9, reset)]),
      spare: limits([weekly(0.2, reset)]),
    }).order,
    ['home', 'work', 'spare'],
  );
});

test('running windows first, then the unknown, then those with nothing about to expire', t => {
  const { order } = select({
    // Its window reset yesterday: nothing of it is running.
    work: limits([weekly(0.8, '2026-09-19T00:00:00.000Z')]),
    home: undefined,
    spare: limits([weekly(0.1, '2026-09-25T00:00:00.000Z')]),
  });
  t.deepEqual(order, ['spare', 'home', 'work']);
  // Nothing known about any of them: declared order, deterministically.
  t.deepEqual(select({}).order, ['work', 'home', 'spare']);
});

test('a full window blocks until it resets, and a short one unblocks by itself', t => {
  const readings = {
    work: limits([
      fiveHour(1, '2026-09-20T13:00:00.000Z'),
      weekly(0.3, '2026-09-21T00:00:00.000Z'),
    ]),
    home: limits([weekly(0.3, '2026-09-24T00:00:00.000Z')]),
  };
  const blocked = select(readings);
  // Skipped although its long window resets soonest: accepted.
  t.deepEqual(blocked.order, ['home', 'spare']);
  t.is(blocked.earliestBackMs, at('2026-09-20T13:00:00.000Z'));
  // An hour later the same reading no longer blocks it.
  t.deepEqual(
    select(readings, { nowMs: at('2026-09-20T13:00:01.000Z') }).order,
    ['work', 'home', 'spare'],
  );
});

test('the provider’s word that the limit is reached ages by what the reading named', t => {
  const depleted = limits(
    [
      fiveHour(0.4, '2026-09-20T14:00:00.000Z'),
      weekly(0.4, '2026-09-23T00:00:00.000Z'),
    ],
    { limitReached: true },
  );
  t.true(standingOf(depleted, NOW).blocked);
  // One window resetting refills nothing.
  t.true(standingOf(depleted, at('2026-09-20T15:00:00.000Z')).blocked);
  t.false(standingOf(depleted, at('2026-09-23T00:00:01.000Z')).blocked);
  // With no window it is believed for an hour from the reading.
  const undated = limits([], { limitReached: true });
  t.true(standingOf(undated, NOW).blocked);
  t.is(standingOf(undated, NOW).blockedUntilMs, at('2026-09-20T12:59:00.000Z'));
  t.false(standingOf(undated, at('2026-09-20T13:30:00.000Z')).blocked);
  // Nothing read is not blocked, and not known.
  t.deepEqual(standingOf(undefined, NOW), {
    known: false,
    blocked: false,
    blockedUntilMs: null,
    longResetMs: null,
    longUsedFraction: null,
  });
  t.false(standingOf({ source: 'unavailable', windows: [] }, NOW).known);
});

test('a session stays where its cache is warm, and re-chooses once it is cold', t => {
  const readings = {
    work: limits([weekly(0.1, '2026-09-26T00:00:00.000Z')]),
    home: limits([weekly(0.6, '2026-09-20T14:00:00.000Z')]),
  };
  // Served by `work` a minute ago: stay, with the drain order behind it.
  t.deepEqual(
    select(readings, { last: { memberId: 'work', atMs: NOW - 60_000 } }).order,
    ['work', 'home', 'spare'],
  );
  // Ten minutes ago: the cache is gone either way. `spare` has never been
  // read, so it comes after the two whose windows are running.
  t.deepEqual(
    select(readings, { last: { memberId: 'work', atMs: NOW - 600_000 } }).order,
    ['home', 'work', 'spare'],
  );
  // Warm, but it refuses: move.
  t.deepEqual(
    select(
      { ...readings, work: limits([weekly(1, '2026-09-26T00:00:00.000Z')]) },
      { last: { memberId: 'work', atMs: NOW - 60_000 } },
    ).order,
    ['home', 'spare'],
  );
  // Served by a member that has since left the set: it is just not there.
  t.deepEqual(
    select(readings, { last: { memberId: 'gone', atMs: NOW - 1000 } }).order,
    ['home', 'work', 'spare'],
  );
});

test('a pinned session uses its subscription and no other', t => {
  const readings = {
    work: limits([weekly(1, '2026-09-26T00:00:00.000Z')]),
    home: limits([weekly(0.1, '2026-09-21T00:00:00.000Z')]),
  };
  t.deepEqual(select(readings, { preference: 'home' }).order, ['home']);
  // Exhausted: nothing to try, and the time shown is its own reset.
  const pinned = select(readings, { preference: 'work' });
  t.deepEqual(pinned.order, []);
  t.is(pinned.earliestBackMs, at('2026-09-26T00:00:00.000Z'));
  // Removed from the set: a distinct error, not a fall through.
  t.throws(() => select(readings, { preference: 'gone' }), {
    message: /"gone" is not in this provider's set/,
  });
});

test('a refusal outlives its reading, and an undated one backs off', t => {
  /** @type {any[]} */
  const saved = [];
  const marks = makeRefusalMarks({ onChange: next => saved.push(next) });
  // A dated refusal: skipped until the time it named.
  marks.refused('work', NOW, at('2026-09-20T17:00:00.000Z'));
  t.is(marks.blockedUntil('work', NOW), at('2026-09-20T17:00:00.000Z'));
  t.is(marks.blockedUntil('work', at('2026-09-20T17:00:01.000Z')), null);
  // Undated: a minute. Requests that were in flight when it drained all
  // report the same event: they are one refusal, not five in a row.
  marks.refused('home', NOW, null);
  for (let index = 0; index < 5; index += 1) marks.refused('home', NOW, null);
  t.is(marks.blockedUntil('home', NOW), NOW + 60_000);
  // Refused again right after the pause: two minutes, then four, and never
  // more than an hour.
  let clock = NOW + 61_000;
  marks.refused('home', clock, null);
  t.is(marks.blockedUntil('home', clock), clock + 120_000);
  for (let index = 0; index < 10; index += 1) {
    clock = /** @type {number} */ (marks.blockedUntil('home', clock)) + 1000;
    marks.refused('home', clock, null);
  }
  t.is(marks.blockedUntil('home', clock), clock + 3_600_000);
  // A refusal long after the last one starts over.
  clock += 86_400_000;
  marks.refused('home', clock, null);
  t.is(marks.blockedUntil('home', clock), clock + 60_000);
  // A time the provider names while already skipped extends the mark.
  marks.refused('home', clock, clock + 7_200_000);
  t.is(marks.blockedUntil('home', clock), clock + 7_200_000);
  // Serving clears it; every change was offered for keeping.
  marks.served('home');
  t.is(marks.blockedUntil('home', NOW), null);
  t.deepEqual(Object.keys(saved.at(-1)), ['work']);
  // A later incarnation starts from what was kept, so a restart does not
  // retry a drained account.
  const revived = makeRefusalMarks({ initial: saved.at(-1) });
  t.is(revived.blockedUntil('work', NOW), at('2026-09-20T17:00:00.000Z'));
  // Members that left the set take their marks with them.
  revived.retain(['home']);
  t.is(revived.blockedUntil('work', NOW), null);

  const chosen = select(
    { work: limits([weekly(0.1, '2026-09-21T00:00:00.000Z')]) },
    { refusedUntil: marks.blockedUntil },
  );
  t.deepEqual(chosen.order, ['home', 'spare']);
  t.is(chosen.earliestBackMs, at('2026-09-20T17:00:00.000Z'));
});

test('a pool keeps a session where it was served while warm, and hands it over when refused', t => {
  let clock = NOW;
  /** @type {Record<string, any>} */
  const readings = {
    work: limits([weekly(0.1, '2026-09-26T00:00:00.000Z')]),
    home: limits([weekly(0.6, '2026-09-20T14:00:00.000Z')]),
  };
  /** @type {any[]} */
  const kept = [];
  const pool = makeSubscriptionPool({
    members: () => members.slice(0, 2),
    readingOf: id => readings[id],
    cacheLifetimeMs: 300_000,
    now: () => clock,
    onChange: state => kept.push(state),
  });
  const session = pool.forSession('s1');
  // Cold: drain the one that resets in two hours.
  t.deepEqual(session.select(), ['home', 'work']);
  session.served('home');
  t.is(kept.length, 1);
  // Seconds later, mid-turn: stay. The advancing stamp is not re-kept.
  clock += 5000;
  t.deepEqual(session.select(), ['home', 'work']);
  session.served('home');
  t.is(kept.length, 1);
  // `home` drains: its refusal's reading arrived first, as the transport
  // guarantees, and says when it is back.
  readings.home = limits([weekly(1, '2026-09-20T14:00:00.000Z')], {
    limitReached: true,
  });
  session.exhausted('home');
  t.deepEqual(session.select(), ['work']);
  session.served('work');
  t.deepEqual(kept.at(-1).sessions.s1.memberId, 'work');
  t.is(kept.at(-1).refusals.home.untilMs, at('2026-09-20T14:00:00.000Z'));
  // Another session sees the same refusal.
  t.deepEqual(pool.forSession('s2').select(), ['work']);
  t.true(pool.standings().find(entry => entry.id === 'home').blocked);

  // After a restart the drained account is not retried, and the session is
  // still judged warm where it was.
  const revived = makeSubscriptionPool({
    members: () => members.slice(0, 2),
    readingOf: () => undefined,
    cacheLifetimeMs: 300_000,
    now: () => clock,
    initial: kept.at(-1),
  });
  t.deepEqual(revived.forSession('s1').select(), ['work']);
  // Once its reset time has passed it is back in the running.
  clock = at('2026-09-20T14:00:01.000Z');
  t.deepEqual(revived.forSession('s1').select(), ['work', 'home']);
  // A deleted session leaves no record.
  pool.forget('s1');
  t.false('s1' in kept.at(-1).sessions);
});

test('a raw reading, as a broker holds it, stands the same as a normalized one', t => {
  const raw = {
    windows: [
      {
        windowId: 'secondary',
        windowSeconds: 604_800,
        usedPercent: 100,
        resetsAt: '2026-09-23T00:00:00.000Z',
      },
    ],
    limitReached: false,
    observedAt: '2026-09-20T11:59:00.000Z',
  };
  const standing = standingOf(raw, NOW);
  t.true(standing.blocked);
  t.is(standing.blockedUntilMs, at('2026-09-23T00:00:00.000Z'));
  t.is(standing.longUsedFraction, 1);
});

test('a declared set is validated, defaulted and copied', t => {
  t.deepEqual(
    normalizeSubscriptionSet({
      members: [
        { id: 'work', label: 'Work Pro', weight: 20, accountRef: 'acct_1' },
        { id: 'home' },
      ],
    }),
    {
      cacheLifetimeSeconds: 300,
      members: [
        {
          id: 'work',
          label: 'Work Pro',
          weight: 20,
          secretName: 'work',
          accountRef: 'acct_1',
        },
        { id: 'home', label: 'home', weight: 1, secretName: 'home' },
      ],
    },
  );
  for (const bad of [
    undefined,
    { members: [] },
    { members: [{ id: 'auto' }] },
    { members: [{ id: 'a' }, { id: 'a' }] },
    { members: [{ id: 'has space' }] },
    { members: [{ id: 'a', weight: 0 }] },
    { members: [{ id: 'a', accountRef: 'not an account' }] },
    { members: [{ id: 'a' }], cacheLifetimeSeconds: -1 },
    {
      members: Array.from({ length: 17 }, (_, index) => ({ id: `m${index}` })),
    },
  ]) {
    t.throws(
      () => normalizeSubscriptionSet(bad),
      undefined,
      JSON.stringify(bad),
    );
  }
});

test('the record of where sessions were served is bounded', t => {
  let clock = NOW;
  /** @type {any} */
  let kept;
  const pool = makeSubscriptionPool({
    members: () => members.slice(0, 1),
    readingOf: () => undefined,
    cacheLifetimeMs: 300_000,
    now: () => clock,
    onChange: state => {
      kept = state;
    },
  });
  for (let index = 0; index < 300; index += 1) {
    clock += 1;
    pool.forSession(`s${index}`).served('work');
  }
  const ids = Object.keys(kept.sessions);
  t.is(ids.length, 256);
  t.false(ids.includes('s0'));
  t.true(ids.includes('s299'));
});

test('a five-hour limit blocks for five hours, not for the week', t => {
  // A Codex 429: the short window full, the long one not, and the provider's
  // word that the limit is reached. That word is about the full window.
  const refused = limits(
    [
      fiveHour(1, '2026-09-20T14:00:00.000Z'),
      weekly(0.4, '2026-09-25T00:00:00.000Z'),
    ],
    { limitReached: true },
  );
  t.true(standingOf(refused, NOW).blocked);
  t.is(standingOf(refused, NOW).blockedUntilMs, at('2026-09-20T14:00:00.000Z'));
  // A blocked member gets no request, so this same reading is all there is
  // two hours later: it must let the member back in.
  const later = standingOf(refused, at('2026-09-20T14:01:00.000Z'));
  t.false(later.blocked);
  t.is(later.longResetMs, at('2026-09-25T00:00:00.000Z'));
});

test('a window that does not say when it resets cannot block for ever', t => {
  // A 429 whose headers carry a percentage and no reset time.
  const undated = limits([
    { windowId: 'primary', usedPercent: 100, resetsAt: '' },
  ]);
  t.true(standingOf(undated, NOW).blocked);
  t.is(standingOf(undated, NOW).blockedUntilMs, at('2026-09-20T12:59:00.000Z'));
  t.false(standingOf(undated, at('2026-09-20T13:00:00.000Z')).blocked);
  // Beside a dated window: the undated one ages, the dated one is ranked on.
  const mixed = limits(
    [
      { windowId: 'primary', usedPercent: 100, resetsAt: '' },
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
      { windows: [{ windowId: 'primary', usedPercent: 100, resetsAt: '' }] },
      NOW,
    ).blocked,
  );
  // Two windows that give no length: the one the provider calls long is.
  t.is(
    standingOf(
      limits([
        {
          windowId: 'primary',
          usedFraction: 0.1,
          resetsAt: '2026-09-20T15:00:00.000Z',
        },
        {
          windowId: 'secondary',
          usedFraction: 0.1,
          resetsAt: '2026-09-27T00:00:00.000Z',
        },
      ]),
      NOW,
    ).longResetMs,
    at('2026-09-27T00:00:00.000Z'),
  );
});

test('a member that cannot be used at all is skipped for a while, not chosen for ever', t => {
  let clock = NOW;
  const pool = makeSubscriptionPool({
    members: () => members.slice(0, 2),
    readingOf: () => undefined,
    cacheLifetimeMs: () => 300_000,
    now: () => clock,
  });
  const session = pool.forSession('s1');
  t.deepEqual(session.select(), ['work', 'home']);
  // Its credential would not resolve. The request fails; the next goes
  // elsewhere.
  session.unusable('work');
  t.deepEqual(session.select(), ['home']);
  clock += 61_000;
  t.deepEqual(session.select(), ['work', 'home']);
});

test('two subscriptions may not share an account or a secret, and an OAuth set names every account', t => {
  t.throws(
    () =>
      normalizeSubscriptionSet({
        members: [
          { id: 'a', accountRef: 'acct_1' },
          { id: 'b', accountRef: 'acct_1' },
        ],
      }),
    { message: /must not share an account/ },
  );
  t.throws(
    () =>
      normalizeSubscriptionSet({
        members: [{ id: 'a' }, { id: 'b', secretName: 'a' }],
      }),
    { message: /must not share a secret/ },
  );
  t.throws(
    () =>
      normalizeSubscriptionSet(
        { members: [{ id: 'a', accountRef: 'acct_1' }, { id: 'b' }] },
        { requireAccountRef: true },
      ),
    { message: /must name its account/ },
  );
});

test('a subscription id cannot end the way setup names a member’s namespaces', t => {
  for (const id of ['work-powers', 'work-handle', 'powers', 'handle']) {
    t.throws(() => normalizeSubscriptionSet({ members: [{ id }] }), {
      message: /must not be or end in -powers or -handle/,
    });
  }
  t.notThrows(() =>
    normalizeSubscriptionSet({
      members: [{ id: 'superpowers' }, { id: 'handles' }],
    }),
  );
});
