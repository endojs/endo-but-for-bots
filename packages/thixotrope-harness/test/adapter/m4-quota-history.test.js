// @ts-check
// Quota history (quota-history.js, accounts.js `history`, account-file.js
// format 3): observed samples per member key, provider and window, from
// Claude and Codex rate-limit headers and usage reads; duplicate reads
// extend a sample (count, last confirmation, latest reported reset)
// instead of adding one; bounded; read in pages; durable across
// incarnations; older files (the v2 migration) load with no history (never
// backfilled); weekly windows in either slot; no store key or credential in
// an answer. Node adapter tests, fake clock.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { m4Shapes } from '../../guest/lib/interfaces-m4.js';
import { subscriptionLimits } from '../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */
import {
  makeAccounts,
  readingFromClaudeUsage,
  readingFromCodexUsage,
} from '../../resources/agent-host/impl/subscriptions/accounts.js';
import {
  READINGS_FORMAT,
  loadReadings,
} from '../../resources/agent-host/impl/subscriptions/account-file.js';
import { readingFromHeaders } from '../../resources/agent-host/impl/subscriptions/rate-limit-headers.js';
import {
  checkHistory,
  recordObservation,
} from '../../resources/agent-host/impl/subscriptions/quota-history.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const T0 = Date.parse('2026-11-18T00:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

const makeTimers = () =>
  harden({
    after:
      (/** @type {number} */ _ms, /** @type {() => void} */ _fn) => () => {},
  });

/**
 * @param {string} label
 * @param {string} key
 * @param {'claude' | 'codex'} provider
 * @returns {any}
 */
const memberEntry = (label, key, provider) =>
  harden({
    member: Far('PoolMember', {}),
    label,
    provider,
    weight: 1,
    key,
    state: 'active',
  });

/** @param {Record<string, string>} headers */
const getter = headers => (/** @type {string} */ name) =>
  headers[name.toLowerCase()];

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ readers?: any }} [options]
 */
const setup = async (t, { readers = {} } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'thix-quota-history-'));
  let now = T0;
  const file = join(dir, 'subscriptions', 'readings.json');
  const make = () =>
    makeAccounts({ file, timers: makeTimers(), now: () => now, readers });
  const core = make();
  t.teardown(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    file,
    core,
    make,
    /** @param {number} ms */
    at: ms => {
      now = ms;
    },
  };
};

/**
 * Claude unified headers at `at` (utilisation as a fraction).
 * @param {number} at
 * @param {number} five
 * @param {number} seven
 */
const claudeHeaders = (at, five, seven) =>
  /** @type {any} */ (
    readingFromHeaders(
      getter({
        'anthropic-ratelimit-unified-5h-utilization': String(five),
        'anthropic-ratelimit-unified-5h-reset': String((T0 + 4 * HOUR) / 1000),
        'anthropic-ratelimit-unified-7d-utilization': String(seven),
        'anthropic-ratelimit-unified-7d-reset': String(
          (T0 + 3 * 24 * HOUR) / 1000,
        ),
        'anthropic-ratelimit-unified-status': 'allowed',
      }),
      at,
    )
  );

test('recordObservation: append on change, extend on a duplicate, drop out of order', t => {
  /** @type {any[]} */
  let series = [];
  const window = (/** @type {number} */ used, reset = T0 + HOUR) => ({
    name: /** @type {const} */ ('primary'),
    usedPercent: used,
    windowMinutes: 300,
    resetsAtMs: reset,
  });
  series = /** @type {any} */ (recordObservation(series, T0, [window(10)]));
  // A repeat of the same value (reset jitter within tolerance) extends it.
  series = /** @type {any} */ (
    recordObservation(series, T0 + MIN, [window(10, T0 + HOUR + 30_000)])
  );
  // The latest reported reset is kept (providers recompute it each read).
  t.deepEqual(series[0].samples, [
    {
      at: T0,
      usedPercent: 10,
      resetsAtMs: T0 + HOUR + 30_000,
      lastAt: T0 + MIN,
      count: 2,
    },
  ]);
  // Older than the last confirmation: nothing changes.
  t.is(recordObservation(series, T0 + 30_000, [window(50)]), undefined);
  t.is(recordObservation(series, T0 + MIN, [window(10)]), undefined);
  // A change appends; fractional noise is rounded to 0.01.
  series = /** @type {any} */ (
    recordObservation(series, T0 + 2 * MIN, [window(12.000_000_001)])
  );
  t.deepEqual(
    series[0].samples.map((/** @type {any} */ s) => s.usedPercent),
    [10, 12],
  );
  // A slot whose period changes is another window.
  series = /** @type {any} */ (
    recordObservation(series, T0 + 3 * MIN, [
      { name: 'primary', usedPercent: 3, windowMinutes: 10_080 },
    ])
  );
  t.deepEqual(
    series.map((/** @type {any} */ s) => [s.name, s.windowMinutes]),
    [
      ['primary', 300],
      ['primary', 10_080],
    ],
  );
  t.is(recordObservation(series, T0 + 4 * MIN, []), undefined);
});

test('recordObservation and checkHistory are bounded: samples per window, windows per member', t => {
  /** @type {any[]} */
  let series = [];
  for (let i = 0; i < subscriptionLimits.historySamples + 10; i += 1) {
    series = /** @type {any} */ (
      recordObservation(series, T0 + i * MIN, [
        { name: 'secondary', usedPercent: i % 100, windowMinutes: 10_080 },
      ])
    );
  }
  t.is(series[0].samples.length, subscriptionLimits.historySamples);
  t.is(series[0].samples[0].at, T0 + 10 * MIN, 'the oldest go first');
  for (let w = 0; w < subscriptionLimits.maxWindows + 2; w += 1) {
    series = /** @type {any} */ (
      recordObservation(series, T0 + (100 + w) * MIN, [
        { name: 'other', usedPercent: 1, windowMinutes: 60 + w },
      ])
    );
  }
  t.is(series.length, subscriptionLimits.maxWindows);
  // A damaged file loses samples, never gains unknown fields or disorder.
  const checked = checkHistory([
    {
      name: 'primary',
      windowMinutes: 300,
      token: 'sk-secret',
      samples: [
        { at: T0, usedPercent: 5, extra: 'x' },
        { at: T0 - 1, usedPercent: 6 },
        { at: 'later', usedPercent: 7 },
        { at: T0 + MIN, usedPercent: 500, lastAt: T0 },
      ],
    },
    { name: 'bogus', samples: [{ at: T0, usedPercent: 1 }] },
    'nonsense',
  ]);
  t.deepEqual(checked, [
    {
      name: 'primary',
      windowMinutes: 300,
      samples: [
        { at: T0, usedPercent: 5 },
        { at: T0 + MIN, usedPercent: 100 },
      ],
    },
  ]);
  t.deepEqual(checkHistory(undefined), []);
});

test('Claude: header readings become samples per window; duplicates extend; history matches PoolHistory', async t => {
  const { core } = await setup(t);
  const pool = Far('Backend', {});
  const claude = memberEntry('claude-max', 'k1', 'claude');
  core.register(pool, {
    kind: 'claude-pool',
    label: 'team',
    members: [claude],
  });
  core.observe(pool, claude, claudeHeaders(T0, 0.1, 0.4));
  core.observe(pool, claude, claudeHeaders(T0 + MIN, 0.1, 0.4));
  core.observe(pool, claude, claudeHeaders(T0 + 2 * MIN, 0.1, 0.4));
  core.observe(pool, claude, claudeHeaders(T0 + 20 * MIN, 0.25, 0.42));
  const history = await core.accounts.history(pool);
  t.true(matches(history, m4Shapes.PoolHistory));
  t.is(history.backend, pool);
  const [member] = history.members;
  t.is(member.label, 'claude-max');
  t.is(member.provider, 'claude');
  t.false('credits' in member);
  t.false(JSON.stringify(member).includes('k1'), 'no store key');
  t.deepEqual(member.windows, [
    {
      name: 'primary',
      windowMinutes: 300,
      records: [
        {
          from: iso(T0),
          usedPercent: 10,
          resetsAt: iso(T0 + 4 * HOUR),
          to: iso(T0 + 2 * MIN),
          count: 3,
        },
        {
          from: iso(T0 + 20 * MIN),
          usedPercent: 25,
          resetsAt: iso(T0 + 4 * HOUR),
        },
      ],
    },
    {
      name: 'secondary',
      windowMinutes: 10_080,
      records: [
        {
          from: iso(T0),
          usedPercent: 40,
          resetsAt: iso(T0 + 72 * HOUR),
          to: iso(T0 + 2 * MIN),
          count: 3,
        },
        {
          from: iso(T0 + 20 * MIN),
          usedPercent: 42,
          resetsAt: iso(T0 + 72 * HOUR),
        },
      ],
    },
  ]);
  t.is(await core.accounts.history(Far('Backend', {})), undefined);
});

test('Codex: usage reads and header slots record only what each reading reported', async t => {
  let snapshot = readingFromCodexUsage(
    {
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: (T0 + 2 * HOUR) / 1000,
        },
        secondary_window: {
          used_percent: 55,
          limit_window_seconds: 604_800,
          reset_at: (T0 + 5 * 24 * HOUR) / 1000,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: '17' },
    },
    T0,
  );
  const { core, at } = await setup(t, {
    readers: { usage: async () => snapshot },
  });
  const pool = Far('Backend', {});
  const codex = memberEntry('codex-pro', 'k2', 'codex');
  core.register(pool, { kind: 'codex-pool', label: 'codex', members: [codex] });
  await core.accounts.refresh(pool);
  // Headers: the primary moved; the secondary slot came zero-filled (no
  // evidence) and must not become a 0% sample.
  core.observe(
    pool,
    codex,
    /** @type {any} */ (
      readingFromHeaders(
        getter({
          'x-codex-primary-used-percent': '35',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String((T0 + 2 * HOUR) / 1000),
          'x-codex-secondary-used-percent': '0',
        }),
        T0 + 30 * MIN,
      )
    ),
  );
  // A later usage read repeating the secondary extends its sample.
  snapshot = readingFromCodexUsage(
    {
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 35,
          limit_window_seconds: 18_000,
          reset_at: (T0 + 2 * HOUR) / 1000,
        },
        secondary_window: {
          used_percent: 55,
          limit_window_seconds: 604_800,
          reset_at: (T0 + 5 * 24 * HOUR) / 1000,
        },
      },
    },
    T0 + 40 * MIN,
  );
  at(T0 + 40 * MIN);
  await core.accounts.refresh(pool);
  const history = await core.accounts.history(pool);
  t.true(matches(history, m4Shapes.PoolHistory));
  const [member] = history.members;
  t.is(member.provider, 'codex');
  const byMinutes = Object.fromEntries(
    member.windows.map((/** @type {any} */ s) => [s.windowMinutes, s.records]),
  );
  t.deepEqual(byMinutes[300], [
    { from: iso(T0), usedPercent: 20, resetsAt: iso(T0 + 2 * HOUR) },
    {
      from: iso(T0 + 30 * MIN),
      usedPercent: 35,
      resetsAt: iso(T0 + 2 * HOUR),
      to: iso(T0 + 40 * MIN),
      count: 2,
    },
  ]);
  t.deepEqual(byMinutes[10_080], [
    {
      from: iso(T0),
      usedPercent: 55,
      resetsAt: iso(T0 + 120 * HOUR),
      to: iso(T0 + 40 * MIN),
      count: 2,
    },
  ]);
  t.false(
    byMinutes[10_080].some((/** @type {any} */ s) => s.usedPercent === 0),
    'a zero-filled header slot is not an observation',
  );
});

test('persistence: history survives an incarnation; format 2 loads with none; no credential on disk', async t => {
  const { core, file, make } = await setup(t);
  const pool = Far('Backend', {});
  const claude = memberEntry('claude-max', 'k1', 'claude');
  core.register(pool, {
    kind: 'claude-pool',
    label: 'team',
    members: [claude],
  });
  core.observe(pool, claude, claudeHeaders(T0, 0.1, 0.4));
  core.observe(pool, claude, claudeHeaders(T0 + 30 * MIN, 0.3, 0.45));
  const before = await core.accounts.history(pool);
  await core.flush();
  const text = await readFile(file, 'utf8');
  const parsed = JSON.parse(text);
  t.is(parsed.format, READINGS_FORMAT);
  t.is(parsed.members[0].history.length, 2);
  t.false(/token|authorization|anthropic-|sk-/i.test(text), 'no secret text');
  t.is(loadReadings(file)[0].history?.[0].samples.length, 2);

  const again = make();
  again.register(pool, {
    kind: 'claude-pool',
    label: 'team',
    members: [claude],
  });
  t.deepEqual(await again.accounts.history(pool), before);
  // The next reading in the new incarnation appends to the kept series.
  again.observe(pool, claude, claudeHeaders(T0 + HOUR, 0.4, 0.5));
  const after = await again.accounts.history(pool);
  t.is(after.members[0].windows[0].records.length, 3);
  await again.close();

  // A key now naming another provider's account starts empty.
  const swapped = make();
  const codex = memberEntry('same-key', 'k1', 'codex');
  swapped.register(pool, { kind: 'codex-pool', label: 'c', members: [codex] });
  t.deepEqual((await swapped.accounts.history(pool)).members[0].windows, []);
  await swapped.close();

  // Format 2 (no history): the remembered reading is shown, nothing backfilled.
  await writeFile(
    file,
    JSON.stringify({
      format: 'thixotrope-harness-readings-2',
      members: [
        {
          key: 'k1',
          provider: 'claude',
          reading: {
            at: T0,
            windows: [{ name: 'primary', usedPercent: 50, windowMinutes: 300 }],
            limitReached: false,
          },
          history: [
            { name: 'primary', samples: [{ at: T0 - HOUR, usedPercent: 1 }] },
          ],
        },
      ],
    }),
  );
  const legacy = make();
  legacy.register(pool, {
    kind: 'claude-pool',
    label: 'team',
    members: [claude],
  });
  t.is(legacy.accounts.list().pools[0].members[0].provenance, 'remembered');
  t.deepEqual((await legacy.accounts.history(pool)).members[0].windows, []);
  await legacy.close();
});

test('Claude usage reads share the header windows (same series)', async t => {
  const snapshot = readingFromClaudeUsage(
    {
      five_hour: { utilization: 30, resets_at: iso(T0 + 4 * HOUR) },
      seven_day: { utilization: 41, resets_at: iso(T0 + 72 * HOUR) },
    },
    T0 + 10 * MIN,
  );
  const { core, at } = await setup(t, {
    readers: { usage: async () => snapshot },
  });
  const pool = Far('Backend', {});
  const claude = memberEntry('claude-max', 'k1', 'claude');
  core.register(pool, {
    kind: 'claude-pool',
    label: 'team',
    members: [claude],
  });
  core.observe(pool, claude, claudeHeaders(T0, 0.1, 0.4));
  at(T0 + 10 * MIN);
  await core.accounts.refresh(pool);
  const { windows: series } = (await core.accounts.history(pool)).members[0];
  t.is(series.length, 2);
  t.deepEqual(
    series.map((/** @type {any} */ s) =>
      s.records.map((/** @type {any} */ x) => x.usedPercent),
    ),
    [
      [10, 30],
      [40, 41],
    ],
  );
});

test('review: two equal readings 15 minutes apart are one record of count 2; the latest reset is kept', async t => {
  const { core } = await setup(t);
  const pool = Far('Backend', {});
  const claude = memberEntry('claude-max', 'k1', 'claude');
  core.register(pool, {
    kind: 'claude-pool',
    label: 'team',
    members: [claude],
  });
  const weekReset = T0 + 3 * 24 * HOUR;
  /**
   * @param {number} at
   * @param {number} reset
   */
  const read = (at, reset) =>
    /** @type {any} */ (
      readingFromHeaders(
        getter({
          'anthropic-ratelimit-unified-7d-utilization': '0.6',
          'anthropic-ratelimit-unified-7d-reset': String(reset / 1000),
          'anthropic-ratelimit-unified-status': 'allowed',
        }),
        at,
      )
    );
  // 40% remaining at 10:00 and again at 10:15; the provider recomputed the
  // reset one second later the second time (within the tolerance).
  core.observe(pool, claude, read(T0 + 10 * HOUR, weekReset));
  core.observe(pool, claude, read(T0 + 10 * HOUR + 15 * MIN, weekReset + 1000));
  const history = await core.accounts.history(pool);
  t.true(matches(history, m4Shapes.PoolHistory));
  const [weekly] = history.members[0].windows;
  t.is(weekly.name, 'secondary');
  t.is(weekly.windowMinutes, 10_080);
  t.deepEqual(weekly.records, [
    {
      from: iso(T0 + 10 * HOUR),
      to: iso(T0 + 10 * HOUR + 15 * MIN),
      count: 2,
      usedPercent: 60,
      resetsAt: iso(weekReset + 1000),
    },
  ]);
  // A third repeat counts on; a reading not newer is dropped, not counted.
  core.observe(pool, claude, read(T0 + 10 * HOUR + 30 * MIN, weekReset + 2000));
  core.observe(pool, claude, read(T0 + 10 * HOUR + 20 * MIN, weekReset + 2000));
  const [again] = (await core.accounts.history(pool)).members[0].windows;
  t.is(again.records.length, 1);
  t.is(again.records[0].count, 3);
  t.is(again.records[0].to, iso(T0 + 10 * HOUR + 30 * MIN));
  t.is(again.records[0].resetsAt, iso(weekReset + 2000));
  // A reset beyond the tolerance is a new record, not an extension.
  core.observe(pool, claude, read(T0 + 11 * HOUR, weekReset + 7 * 24 * HOUR));
  const [split] = (await core.accounts.history(pool)).members[0].windows;
  t.is(split.records.length, 2);
  t.is(split.records[1].count, undefined);
});

test('review: count survives the file; a damaged count is read as 2', t => {
  const kept = checkHistory([
    {
      name: 'primary',
      windowMinutes: 300,
      samples: [
        { at: T0, usedPercent: 5, lastAt: T0 + MIN, count: 7 },
        { at: T0 + 2 * MIN, usedPercent: 6, lastAt: T0 + 3 * MIN, count: -1 },
        { at: T0 + 4 * MIN, usedPercent: 7, count: 9 },
      ],
    },
  ]);
  t.deepEqual(
    kept[0].samples.map(sample => sample.count),
    [7, 2, undefined],
    'a count goes with a last confirmation only',
  );
});

test('review: history is read in bounded pages of historyPageMembers', async t => {
  const { core } = await setup(t);
  const pool = Far('Backend', {});
  const members = Array.from({ length: 6 }, (_, i) =>
    memberEntry(`m${i}`, `k${i + 1}`, 'claude'),
  );
  core.register(pool, { kind: 'claude-pool', label: 'team', members });
  for (const member of members) {
    core.observe(pool, member, claudeHeaders(T0, 0.1, 0.4));
  }
  const first = await core.accounts.history(pool);
  t.true(matches(first, m4Shapes.PoolHistory));
  t.is(first.members.length, subscriptionLimits.historyPageMembers);
  t.is(first.next, subscriptionLimits.historyPageMembers);
  const second = await core.accounts.history(pool, first.next);
  t.true(matches(second, m4Shapes.PoolHistory));
  t.deepEqual(
    second.members.map((/** @type {any} */ m) => m.label),
    ['m4', 'm5'],
  );
  t.is(second.next, undefined);
  t.deepEqual((await core.accounts.history(pool, 99)).members, []);
  // The page bound is the guard's: a page of more members is refused.
  t.false(
    matches(
      harden({ ...first, members: [...first.members, ...second.members] }),
      m4Shapes.PoolHistory,
    ),
  );
});

test('review: Codex weekly windows are recorded in whichever slot reported them', async t => {
  const snapshot = readingFromCodexUsage(
    {
      plan_type: 'free',
      rate_limit: {
        // A plan with only a weekly window reports it as the primary.
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 604_800,
          reset_at: (T0 + 4 * 24 * HOUR) / 1000,
        },
      },
    },
    T0,
  );
  const { core } = await setup(t, { readers: { usage: async () => snapshot } });
  const pool = Far('Backend', {});
  const codex = memberEntry('codex-free', 'k1', 'codex');
  const plus = memberEntry('codex-plus', 'k2', 'codex');
  core.register(pool, {
    kind: 'codex-pool',
    label: 'codex',
    members: [codex, plus],
  });
  core.observe(pool, codex, snapshot);
  // Headers of another account naming the weekly window as the secondary.
  core.observe(
    pool,
    plus,
    /** @type {any} */ (
      readingFromHeaders(
        getter({
          'x-codex-primary-used-percent': '12',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String((T0 + 2 * HOUR) / 1000),
          'x-codex-secondary-used-percent': '44',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': String((T0 + 3 * 24 * HOUR) / 1000),
        }),
        T0 + MIN,
      )
    ),
  );
  const history = await core.accounts.history(pool);
  t.true(matches(history, m4Shapes.PoolHistory));
  const slots = history.members.map((/** @type {any} */ member) =>
    member.windows.map((/** @type {any} */ w) => [w.name, w.windowMinutes]),
  );
  t.deepEqual(slots, [
    [['primary', 10_080]],
    [
      ['primary', 300],
      ['secondary', 10_080],
    ],
  ]);
});

test('credit wallet records only real decimal observations, survives restart and starts a new series after a gap', async t => {
  let reads = 0;
  let full = readingFromCodexUsage(
    { credits: { balance: '62500.0000000000' } },
    T0,
  );
  const { core, make } = await setup(t, {
    readers: {
      usage: async () => {
        reads += 1;
        return full;
      },
    },
  });
  const pool = Far('Backend', {});
  const member = memberEntry('member', 'k1', 'codex');
  const info = {
    kind: /** @type {const} */ ('codex-pool'),
    label: 'pool',
    members: [member],
  };
  core.register(pool, info);
  const creditsOf = async (/** @type {typeof core} */ service) => {
    const page = await service.accounts.history(pool);
    return page.members[0].credits;
  };
  t.is(await creditsOf(core), undefined);
  await core.accounts.refresh(pool);
  const header = (
    /** @type {Record<string, string>} */ headers,
    /** @type {number} */ offset,
  ) =>
    core.observe(
      pool,
      member,
      /** @type {any} */ (
        readingFromHeaders(getter(headers), T0 + offset * MIN)
      ),
    );
  header({ 'x-codex-primary-used-percent': '13' }, 1);
  t.deepEqual(await creditsOf(core), [
    { from: iso(T0), value: '62500.0000000000' },
  ]);
  header({ 'x-codex-credits-balance': '62500.00' }, 2);
  header({ 'x-codex-credits-balance': '62500.00' }, 2);
  const exact = '999999999999999999999999.000000000001';
  header({ 'x-codex-credits-balance': exact }, 3);
  header({ 'x-codex-credits-balance': '0' }, 4);
  await core.flush();
  const again = make();
  t.teardown(() => again.close());
  again.register(pool, info);
  t.deepEqual(await creditsOf(again), [
    { from: iso(T0), value: '62500.00', to: iso(T0 + 2 * MIN), count: 2 },
    { from: iso(T0 + 3 * MIN), value: exact },
    { from: iso(T0 + 4 * MIN), value: '0' },
  ]);
  t.is(reads, 1, 'passive history and restart did not fetch usage');
  again.register(pool, { ...info, members: [{ ...member, state: 'retired' }] });
  await again.accounts.refresh(pool);
  t.is(reads, 1, 'retired accounts are never refreshed');
  t.is(
    (await creditsOf(again)).at(-1).value,
    '0',
    'past evidence remains readable',
  );
  again.register(pool, info);
  const restartedHeader = (
    /** @type {Record<string, string>} */ headers,
    /** @type {number} */ offset,
  ) =>
    again.observe(
      pool,
      member,
      /** @type {any} */ (
        readingFromHeaders(getter(headers), T0 + offset * MIN)
      ),
    );
  restartedHeader(
    { 'x-codex-credits-unlimited': 'true', 'x-codex-credits-balance': '0' },
    5,
  );
  t.is(await creditsOf(again), undefined);
  restartedHeader({ 'x-codex-credits-balance': '11.5' }, 6);
  t.deepEqual(await creditsOf(again), [
    { from: iso(T0 + 6 * MIN), value: '11.5' },
  ]);
  restartedHeader({ 'x-codex-credits-balance': 'unknown' }, 7);
  t.is(await creditsOf(again), undefined);
  for (let i = 0; i < 51; i += 1)
    restartedHeader({ 'x-codex-credits-balance': String(i) }, i + 8);
  const bounded = await creditsOf(again);
  t.is(bounded.length, 48);
  t.is(bounded[0].value, '3');
  full = readingFromCodexUsage({}, T0 + 60 * MIN);
  await again.accounts.refresh(pool);
  t.is(await creditsOf(again), undefined);
});
