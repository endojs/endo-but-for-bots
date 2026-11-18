// @ts-check
// Accounts (W4.5; designs/m4-interfaces.md section 6): provenance per
// source, push per change with zero vat deliveries, refresh on demand only,
// keepalive and idle eviction (40 abandoned watchers, then a new watch; 32
// live watchers refuse a 33rd), the readings file round trip and atomic
// write, the `accountStatus` text in Fae's rendering, banked credits shown
// read-only, and the usage readers. Node adapter tests with a fake clock;
// no supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { m4Shapes, m4Texts } from '../../guest/lib/interfaces-m4.js';
/* eslint-enable import/no-relative-packages */
import {
  accountsWatchLimitText,
  makeAccounts,
  makeUsageReader,
  readingFromClaudeUsage,
  readingFromCodexUsage,
  renderAccountStatus,
} from '../../resources/agent-host/impl/subscriptions/accounts.js';
import {
  READINGS_FORMAT,
  loadReadings,
  makeReadingsWriter,
} from '../../resources/agent-host/impl/subscriptions/account-file.js';
import {
  accountStatusDescription,
  makeAccountStatusTool,
} from '../../resources/agent-host/impl/subscriptions/account-tool.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const T0 = Date.parse('2026-11-18T00:00:00.000Z');

/** Let every pending promise job run (exo `callWhen` methods start a job later). */
const settle = () =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

/**
 * A fake clock: `after` timers fire when `advance` passes them.
 * @param {number} [start]
 */
const makeClock = (start = T0) => {
  let t = start;
  /** @type {Set<{ due: number, fn: () => void }>} */
  const pending = new Set();
  /**
   * @param {number} ms
   * @param {() => void} fn
   */
  const after = (ms, fn) => {
    const entry = { due: t + Math.max(0, ms), fn };
    pending.add(entry);
    return () => {
      pending.delete(entry);
    };
  };
  return {
    now: () => t,
    timers: harden({
      after,
      /** @param {number} ms */
      delay: ms =>
        new Promise(resolve => {
          after(ms, () => resolve(undefined));
        }),
    }),
    /** @param {number} ms */
    advance: async ms => {
      await settle();
      const end = t + ms;
      for (;;) {
        let next;
        for (const entry of pending)
          if (entry.due <= end && (next === undefined || entry.due < next.due))
            next = entry;
        if (next === undefined) break;
        pending.delete(next);
        t = next.due;
        next.fn();
        // Let the answered promises settle before the next timer.
        // eslint-disable-next-line no-await-in-loop -- one timer at a time
        await settle();
      }
      t = end;
      await settle();
    },
    armed: () => pending.size,
  };
};

const tempDir = async () => mkdtemp(join(tmpdir(), 'thix-m4-accounts-'));

/**
 * @param {string} label
 * @param {string} key
 * @param {'claude' | 'codex'} [provider]
 * @param {object} [extra]
 */
const memberEntry = (label, key, provider = 'claude', extra = {}) =>
  harden({
    member: Far('PoolMember', {}),
    label,
    provider,
    weight: 1,
    key,
    state: 'active',
    ...extra,
  });

/**
 * @param {number} usedPercent
 * @param {number} [at]
 * @returns {any}
 */
const readingOf = (usedPercent, at = T0) =>
  harden({
    at,
    source: 'observed',
    windows: [
      {
        name: 'primary',
        usedPercent,
        windowMinutes: 300,
        resetsAtMs: at + 3_600_000,
      },
    ],
    limitReached: false,
    plan: 'Max',
  });

/**
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {any} [options.readers]
 * @param {any} [options.settings]
 */
const setup = async (t, { readers = {}, settings = {} } = {}) => {
  const dir = await tempDir();
  const clock = makeClock();
  const file = join(dir, 'subscriptions', 'readings.json');
  const core = makeAccounts({
    file,
    timers: clock.timers,
    now: clock.now,
    readers,
    settings,
  });
  t.teardown(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file, clock, core };
};

test('provenance per source: observed, remembered, declared, unavailable', async t => {
  const dir = await tempDir();
  const file = join(dir, 'readings.json');
  await writeFile(
    file,
    JSON.stringify({
      format: READINGS_FORMAT,
      members: [
        {
          key: 'k2',
          provider: 'claude',
          reading: { at: T0 - 60_000, windows: [], limitReached: true },
        },
        // Wrong provider for k3's member: not shown as its reading.
        {
          key: 'k3',
          provider: 'codex',
          reading: { at: T0, windows: [], limitReached: false },
        },
        { key: 'not-a-key', provider: 'claude', reading: { at: 1 } },
      ],
    }),
  );
  const clock = makeClock();
  const core = makeAccounts({ file, timers: clock.timers, now: clock.now });
  t.teardown(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  const pool = Far('Backend', {});
  const m1 = memberEntry('one', 'k1');
  const m2 = memberEntry('two', 'k2');
  const m3 = memberEntry('three', 'k3', 'claude', {
    declared: { plan: 'Pro', windows: [{ name: 'primary', usedPercent: 0 }] },
  });
  const m4 = memberEntry('four', 'k4');
  core.register(pool, {
    kind: 'claude-pool',
    label: 'pool',
    members: [m1, m2, m3, m4],
  });
  core.observe(pool, m1, readingOf(25));
  const view = core.accounts.list();
  t.true(matches(view, m4Shapes.AccountsView), 'the view fits its guard');
  const [accounts] = view.pools;
  t.is(accounts.backend, pool);
  t.is(accounts.selection, 'auto');
  t.deepEqual(
    accounts.members.map(m => [m.label, m.provenance]),
    [
      ['one', 'observed'],
      ['two', 'remembered'],
      ['three', 'declared'],
      ['four', 'unavailable'],
    ],
  );
  const [one, two, three, four] = accounts.members;
  t.deepEqual(one.windows, [
    {
      name: 'primary',
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: '2026-11-18T01:00:00.000Z',
    },
  ]);
  t.is(one.at, '2026-11-18T00:00:00.000Z');
  t.is(one.plan, 'Max');
  t.true(two.limitReached);
  t.is(three.plan, 'Pro');
  t.deepEqual(four.windows, []);
  t.is(one.state, 'ok');
});

test('member state, marks and retirement are shown; one publish per change', async t => {
  const { core } = await setup(t);
  const pool = Far('Backend', {});
  const m1 = memberEntry('one', 'k1');
  const m2 = memberEntry('two', 'k2', 'claude', {
    mark: { untilMs: T0 + 60_000, strikes: 1, sinceMs: T0, dated: false },
  });
  const m3 = memberEntry('three', 'k3', 'claude', { state: 'retired' });
  core.register(pool, {
    kind: 'claude-pool',
    label: 'p',
    members: [m1, m2, m3],
  });
  const rev0 = core.rev();
  core.memberState(pool, m1, 'unusable', 'CONSUMED');
  core.memberState(pool, m1, 'unusable', 'CONSUMED'); // no change
  t.is(core.rev(), rev0 + 1);
  const members = core.accounts.list().pools[0].members;
  t.is(members[0].state, 'unusable');
  t.is(members[0].code, 'CONSUMED');
  t.is(members[1].state, 'marked');
  t.is(members[1].markedUntil, '2026-11-18T00:01:00.000Z');
  t.is(members[2].state, 'retired');
});

test('push per change: a watcher gets one batch per change, no reader is called', async t => {
  let usageReads = 0;
  let poolOfCalls = 0;
  const { core } = await setup(t, {
    readers: {
      usage: async () => {
        usageReads += 1;
        return undefined;
      },
      poolOf: async () => {
        poolOfCalls += 1;
        return undefined;
      },
    },
  });
  const pool = Far('Backend', {});
  const m1 = memberEntry('one', 'k1');
  core.register(pool, { kind: 'claude-pool', label: 'p', members: [m1] });
  const sub = core.accounts.watch();
  const first = await sub.next();
  t.is(first.rev, core.rev(), 'a fresh watch answers the current view');
  const waiting = sub.next();
  core.observe(pool, m1, readingOf(10));
  const batch = await waiting;
  t.is(batch.rev, first.rev + 1);
  t.is(batch.pools[0].members[0].provenance, 'observed');
  t.true(matches(batch, m4Shapes.AccountsBatch));
  // An older reading than the one kept changes nothing.
  core.observe(pool, m1, readingOf(90, T0 - 1));
  t.is(core.rev(), batch.rev);
  // A session that opened the pool here is answered without the sink.
  const session = Far('Session', {});
  core.sessionOpened(pool, session);
  const forSession = await core.accounts.forSession(session);
  t.is(forSession?.backend, pool);
  t.is(poolOfCalls, 0);
  // One we did not see asks the sink once and answers undefined.
  t.is(await core.accounts.forSession(Far('Session', {})), undefined);
  t.is(poolOfCalls, 1);
  t.is(usageReads, 0, 'list, watch, forBackend and forSession read nothing');
  await core.accounts.forBackend(pool);
  t.is(usageReads, 0);
  sub.close();
});

test('refresh reads on demand, once per member; a failed read demotes to remembered', async t => {
  /** @type {any[]} */
  const reads = [];
  const { core, clock } = await setup(t, {
    readers: {
      /**
       * @param {any} _backend
       * @param {any} entry
       */
      usage: async (_backend, entry) => {
        reads.push(entry.label);
        if (entry.label === 'bad')
          throw Error('usage read failed: READ_FAILED');
        return readingOf(40, clock.now());
      },
    },
  });
  const poolA = Far('Backend', {});
  const poolB = Far('Backend', {});
  const good = memberEntry('good', 'k1');
  const bad = memberEntry('bad', 'k2');
  core.register(poolA, {
    kind: 'claude-pool',
    label: 'a',
    members: [good, bad],
  });
  core.register(poolB, { kind: 'claude-pool', label: 'b', members: [good] });
  core.observe(poolA, bad, readingOf(5));
  await clock.advance(1000);
  const sub = core.accounts.watch(core.rev());
  const waiting = sub.next();
  const view = await core.accounts.refresh();
  t.deepEqual(
    reads.sort(),
    ['bad', 'good'],
    'a member in two pools is read once',
  );
  const members = view.pools[0].members;
  t.is(members[0].provenance, 'observed');
  t.is(members[0].at, new Date(T0 + 1000).toISOString());
  t.is(members[1].provenance, 'remembered', 'the failed read demotes');
  const batch = await waiting;
  t.is(batch.rev, view.rev, 'one batch for the whole refresh');
  reads.length = 0;
  await core.accounts.refresh(poolB);
  t.deepEqual(reads, ['good'], 'refresh(pool) reads that pool only');
  sub.close();
});

test('forBackend of an unregistered pool asks the readers once; not a pool is undefined', async t => {
  let describes = 0;
  const pool = Far('Backend', {});
  const api = Far('Backend', {});
  const m1 = memberEntry('one', 'k1');
  const { core } = await setup(t, {
    readers: {
      /** @param {any} backend */
      describe: async backend => {
        describes += 1;
        return backend === pool
          ? { kind: 'codex-pool', label: 'c', members: [m1] }
          : undefined;
      },
    },
  });
  const answer = await core.accounts.forBackend(pool);
  t.is(answer?.kind, 'codex-pool');
  await core.accounts.forBackend(pool);
  t.is(describes, 1);
  t.is(await core.accounts.forBackend(api), undefined);
});

test('keepalive: a waiting next() is answered again after 30 s with the same rev', async t => {
  const { core, clock } = await setup(t);
  const sub = core.accounts.watch(core.rev());
  let answered;
  const waiting = sub.next().then(batch => {
    answered = batch;
  });
  await clock.advance(29_999);
  t.is(answered, undefined);
  await clock.advance(1);
  await waiting;
  t.is(/** @type {any} */ (answered).rev, core.rev());
  t.is(clock.armed(), 0, 'no timer left once answered');
  sub.close();
});

test('idle eviction: 40 abandoned watchers in batches, then a new watch succeeds and gets the next change', async t => {
  const { core, clock } = await setup(t);
  const pool = Far('Backend', {});
  const m1 = memberEntry('one', 'k1');
  core.register(pool, { kind: 'claude-pool', label: 'p', members: [m1] });
  /** @type {any[]} */
  const abandoned = [];
  for (const size of [16, 16, 8]) {
    for (let i = 0; i < size; i += 1) {
      const sub = core.accounts.watch(core.rev());
      // One next() each (it waits; the keepalive answers it), then nothing.
      void sub.next();
      abandoned.push(sub);
    }
    // eslint-disable-next-line no-await-in-loop -- the batches are in sequence
    await clock.advance(61_000);
  }
  t.true(core.subscriberCount() <= 8);
  const sub = core.accounts.watch(core.rev());
  t.is(core.subscriberCount(), 1, 'every abandoned watcher was evicted');
  const waiting = sub.next();
  core.observe(pool, m1, readingOf(50, clock.now()));
  const batch = await waiting;
  t.is(batch.rev, core.rev());
  t.is(batch.pools[0].members[0].windows[0].usedPercent, 50);
  await t.throwsAsync(() => abandoned[0].next(), {
    message: m4Texts.accountsWatchClosed,
  });
  sub.close();
});

test('32 live watchers make a 33rd watch fail; an idle one is evicted for a new one', async t => {
  const { core, clock } = await setup(t);
  /** @type {any[]} */
  const live = [];
  for (let i = 0; i < 32; i += 1) {
    const sub = core.accounts.watch(core.rev());
    void sub.next().catch(() => {});
    live.push(sub);
  }
  t.throws(() => core.accounts.watch(), { message: accountsWatchLimitText });
  // Keepalives answer all 32 at 30 s; a live page calls next() again.
  await clock.advance(30_000);
  for (const sub of live.slice(1)) void sub.next().catch(() => {});
  t.throws(() => core.accounts.watch(), {
    message: accountsWatchLimitText,
  });
  // live[0] made no call since 0: idle at 60 s, evicted for the newcomer.
  await clock.advance(30_000);
  for (const sub of live.slice(1)) void sub.next().catch(() => {});
  const newcomer = core.accounts.watch();
  t.is(core.subscriberCount(), 32);
  await t.throwsAsync(() => live[0].next(), {
    message: m4Texts.accountsWatchClosed,
  });
  newcomer.close();
  for (const sub of live) sub.close();
  t.is(core.subscriberCount(), 0);
});

test('readings file: round trip, no source written, atomic replace, bad file is empty', async t => {
  const { dir, file, core, clock } = await setup(t);
  const pool = Far('Backend', {});
  const m1 = memberEntry('one', 'k1', 'codex');
  core.register(pool, { kind: 'codex-pool', label: 'p', members: [m1] });
  core.observe(pool, m1, {
    ...readingOf(70),
    banked: [{ expiresAtMs: T0 + 86_400_000 }],
    credits: '12.5',
  });
  await core.flush();
  const text = await readFile(file, 'utf8');
  const parsed = JSON.parse(text);
  t.is(parsed.format, READINGS_FORMAT);
  t.is(parsed.members[0].key, 'k1');
  t.false('source' in parsed.members[0].reading);
  t.deepEqual(await readdir(join(dir, 'subscriptions')), ['readings.json']);
  const [loaded] = loadReadings(file);
  t.is(loaded.reading.source, 'remembered');
  t.is(loaded.reading.credits, '12.5');
  // A new incarnation shows it as remembered.
  const again = makeAccounts({ file, timers: clock.timers, now: clock.now });
  again.register(pool, { kind: 'codex-pool', label: 'p', members: [m1] });
  t.is(again.accounts.list().pools[0].members[0].provenance, 'remembered');
  await again.close();
  await writeFile(file, '{not json');
  t.deepEqual(loadReadings(file), []);
  t.deepEqual(loadReadings(join(dir, 'missing.json')), []);
});

test('readings writer: a burst within flushMs is one write of the newest state', async t => {
  const dir = await tempDir();
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const clock = makeClock();
  const file = join(dir, 'r.json');
  const writer = makeReadingsWriter({
    file,
    timers: clock.timers,
    flushMs: 5000,
  });
  for (let i = 0; i < 10; i += 1) {
    const at = T0 + i;
    writer.update(() => [
      {
        key: 'k1',
        provider: 'claude',
        reading: { at, source: 'observed', windows: [], limitReached: false },
      },
    ]);
  }
  t.is(writer.writes(), 0);
  await clock.advance(5000);
  await writer.flush();
  t.is(writer.writes(), 1);
  t.is(loadReadings(file)[0].reading.at, T0 + 9);
  await writer.close();
});

test('accountStatus: Fae rendering with provenance, usage not attributed, no cost', async t => {
  const { core } = await setup(t);
  const pool = Far('Backend', {});
  const api = Far('Backend', {});
  const m1 = memberEntry('main', 'k1', 'codex');
  const m2 = memberEntry('spare', 'k2', 'codex', {
    declared: { plan: 'Plus' },
  });
  core.register(pool, { kind: 'codex-pool', label: 'team', members: [m1, m2] });
  core.observe(pool, m1, {
    ...readingOf(30),
    banked: [{ expiresAtMs: T0 + 86_400_000 }, {}],
  });
  let usageCalls = 0;
  const session = Far('Session', {
    getUsage: () => {
      usageCalls += 1;
      return harden({ inputTokens: 1200, outputTokens: 340 });
    },
  });
  const subscriptions = harden({ accounts: core });
  const tool = makeAccountStatusTool({ subscriptions, backend: pool, session });
  const outcome = await tool.execute(harden({ opId: 'o1', args: '{}' }));
  t.is(outcome.status, 'ok');
  const text = outcome.text;
  t.regex(text, /^Account selection: auto/);
  t.regex(text, /Account: main \(codex\) — state ok\./);
  t.regex(
    text,
    /observed: read from the provider as of 2026-11-18T00:00:00\.000Z/,
  );
  t.regex(
    text,
    /5-hour window: 70% remaining \(30% used\), resets 2026-11-18T01:00:00\.000Z/,
  );
  t.regex(
    text,
    /Plan: Plus \(declared: declared by the operator, not measured\)/,
  );
  t.regex(
    text,
    /Banked reset credits: 2 \(shown only; they are not redeemed here\)/,
  );
  t.regex(text, /expires 2026-11-19T00:00:00\.000Z/);
  t.regex(text, /1200 input and 340 output tokens \(not attributed/);
  t.false(text.includes('cost'));
  t.is(usageCalls, 1, 'one session delivery per call');
  t.is(text, core.statusText(pool, { inputTokens: 1200, outputTokens: 340 }));

  const apiTool = makeAccountStatusTool({
    subscriptions,
    backend: api,
    session,
  });
  const apiOutcome = await apiTool.execute(harden({ opId: 'o2', args: '' }));
  t.is(apiOutcome.status, 'ok');
  t.true(apiOutcome.text.startsWith(m4Texts.noSubscriptionAccounts));

  const bad = await tool.execute(
    harden({ opId: 'o3', args: '{"reset":true}' }),
  );
  t.is(bad.status, 'failed');
  t.regex(bad.text, /reset/);
  const notBool = await tool.execute(
    harden({ opId: 'o4', args: '{"refresh":"yes"}' }),
  );
  t.is(notBool.status, 'failed');
  t.is(accountStatusDescription.name, 'accountStatus');
  t.notThrows(() => JSON.parse(accountStatusDescription.parameters));
});

test('accountStatus refresh reads the provider first; the text is bounded', async t => {
  let reads = 0;
  const { core } = await setup(t, {
    readers: {
      usage: async () => {
        reads += 1;
        return readingOf(80);
      },
    },
  });
  const pool = Far('Backend', {});
  const m1 = memberEntry('one', 'k1');
  core.register(pool, { kind: 'claude-pool', label: 'p', members: [m1] });
  const tool = makeAccountStatusTool({
    subscriptions: harden({ accounts: core }),
    backend: pool,
  });
  const outcome = await tool.execute(
    harden({ opId: 'o1', args: '{"refresh":true}' }),
  );
  t.is(reads, 1);
  t.regex(outcome.text, /20% remaining \(80% used\)/);
  // A full pool of long labels stays under the tool output limit.
  const members = Array.from({ length: 16 }, (_, i) =>
    harden({
      label: `${'x'.repeat(250)}${i}`,
      provider: 'codex',
      provenance: 'observed',
      state: 'ok',
      windows: [{ name: 'primary', usedPercent: 1 }],
      limitReached: false,
      banked: Array.from({ length: 16 }, () => ({ label: 'y'.repeat(256) })),
    }),
  );
  const text = renderAccountStatus(
    { label: 'p', selection: 'auto', members },
    undefined,
  );
  t.true(text.length <= 32_768);
});

test('usage readings: Claude and Codex payloads, symbolic only', t => {
  const claude = readingFromClaudeUsage(
    {
      five_hour: { utilization: 42, resets_at: '2026-11-18T05:00:00Z' },
      seven_day: { utilization: 120 },
      extra: 'ignored prose',
    },
    T0,
  );
  t.deepEqual(claude.windows, [
    {
      name: 'primary',
      usedPercent: 42,
      windowMinutes: 300,
      resetsAtMs: Date.parse('2026-11-18T05:00:00Z'),
    },
    { name: 'secondary', usedPercent: 100, windowMinutes: 10_080 },
  ]);
  t.true(claude.limitReached);
  const codex = readingFromCodexUsage(
    {
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 12,
          limit_window_seconds: 18_000,
          reset_at: 1_795_000_000,
        },
        secondary_window: { used_percent: 3, limit_window_seconds: 604_800 },
      },
      credits: { balance: '5.25', has_credits: true },
      rate_limit_reset_credits: {
        available_count: 3,
        credits: [
          { id: 'c1', status: 'available', expires_at: 1_795_000_000 },
          { id: 'c2', status: 'redeemed' },
        ],
      },
    },
    T0,
  );
  t.is(codex.plan, 'Pro');
  t.is(codex.credits, '5.25');
  t.deepEqual(
    codex.windows.map(w => [w.name, w.usedPercent, w.windowMinutes]),
    [
      ['primary', 12, 300],
      ['secondary', 3, 10_080],
    ],
  );
  t.is(codex.banked?.length, 3, 'one dated, two known by count only');
  t.is(codex.banked?.[0].expiresAtMs, 1_795_000_000_000);
  t.is(
    readingFromCodexUsage({ plan_type: 'mystery' }, T0).plan,
    'Unknown plan',
  );
});

test('usage reader: headers by provider, redirects refused, failures carry a status only', async t => {
  // Built at run time so no key-shaped literal is in the source.
  const token = ['test', 'access', String(T0)].join('-');
  /** @type {any[]} */
  const calls = [];
  let status = 200;
  /** @type {any} */
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return new Response(
      status === 200
        ? JSON.stringify({ five_hour: { utilization: 5 } })
        : `body that mentions ${token}`,
      { status },
    );
  };
  const read = makeUsageReader({
    url: () => 'http://127.0.0.1:9/usage',
    credential: async member =>
      member.provider === 'codex'
        ? { accessToken: token, accountId: 'acct' }
        : { accessToken: token },
    fetch,
    now: () => T0,
  });
  const pool = Far('Backend', {});
  const reading = await read(pool, memberEntry('one', 'k1'));
  t.is(reading?.windows[0].usedPercent, 5);
  t.is(calls[0].init.redirect, 'error');
  t.is(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  await read(pool, memberEntry('two', 'k2', 'codex'));
  t.is(calls[1].init.headers['chatgpt-account-id'], 'acct');
  status = 500;
  const error = await t.throwsAsync(() => read(pool, memberEntry('one', 'k1')));
  t.is(error?.message, 'usage read failed: READ_FAILED (HTTP 500)');
  t.false(String(error?.message).includes(token));
  const noUrl = makeUsageReader({
    url: () => undefined,
    credential: async () => ({ accessToken: token }),
    fetch,
  });
  t.is(await noUrl(pool, memberEntry('one', 'k1')), undefined);
});
