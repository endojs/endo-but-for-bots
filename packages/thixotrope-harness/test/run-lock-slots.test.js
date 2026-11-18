// @ts-check
/**
 * The run lock's slots, exclusive mode, intent marker, time box and run log
 * (scripts/run-lock.mjs). Plain Node, no supervisor; private locks under
 * the package's tmp/ and a private THIX_HARNESS_HOME, never the machine's.
 */
import test from '@endo/ses-ava/test.js';

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  RUN_LOCK_ENV,
  TEMPORARY_STALE_MS,
  TIMED_OUT_EXIT,
  acquireRunLock,
  defaultLabel,
  defaultLockPathFor,
  intentPath,
  isProcessAlive,
  laneOf,
  namesPerfCheck,
  parseRunLockArgs,
  processStartTime,
  scrubLabel,
  slotPaths,
} from '../scripts/run-lock.mjs';
import { harnessRoot, scratch } from './_helpers.js';

const runLockScript = path.join(harnessRoot, 'scripts', 'run-lock.mjs');

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} [ms]
 */
const waitFor = async (predicate, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  return false;
};

/** @param {string} file */
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

/** Fake liveness: a pid is alive while it is in `live`. */
const fakeLiveness = () => {
  const live = new Set();
  return {
    live,
    isAlive: (/** @type {number} */ p) => live.has(p),
    startTimeOf: () => undefined,
  };
};

/**
 * @param {string} home THIX_HARNESS_HOME for the run log
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null, stderr: string, ms: number }>}
 */
const runCli = (home, args, env = {}) =>
  new Promise(resolve => {
    const t0 = Date.now();
    const child = execFile(
      process.execPath,
      [runLockScript, ...args],
      {
        env: {
          ...process.env,
          [RUN_LOCK_ENV]: '',
          THIX_HARNESS_HOME: home,
          THIX_AGENT: '',
          ...env,
        },
      },
      (_error, _stdout, stderr) =>
        resolve({
          code: child.exitCode,
          stderr: String(stderr),
          ms: Date.now() - t0,
        }),
    );
  });

/** @param {string} home */
const runLog = async home =>
  (await readFile(path.join(home, 'runs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

test('the machine-wide lock lives under THIX_HARNESS_HOME', t => {
  t.is(
    defaultLockPathFor({ THIX_HARNESS_HOME: '/h' }),
    path.join('/h', 'run-lock', 'slot'),
  );
  t.deepEqual(slotPaths('/h/slot', 3), ['/h/slot', '/h/slot.1', '/h/slot.2']);
  t.is(intentPath('/h/slot'), '/h/slot.intent');
});

test('N shared takers hold N slots at once; the next one waits', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const { live, ...liveness } = fakeLiveness();
  const take = (/** @type {number} */ pid, extra = {}) => {
    live.add(pid);
    return acquireRunLock({
      lockPath,
      slots: 3,
      pid,
      env: {},
      pollMs: 10,
      ...liveness,
      ...extra,
    });
  };
  const held = [await take(1), await take(2), await take(3)];
  t.deepEqual(
    held.map(lock => lock.slot),
    [0, 1, 2],
  );
  t.true(held.every(lock => lock.mode === 'shared'));
  const records = await Promise.all(slotPaths(lockPath, 3).map(readJson));
  t.deepEqual(
    records.map(r => [r.pid, r.slot, r.mode]),
    [
      [1, 0, 'shared'],
      [2, 1, 'shared'],
      [3, 2, 'shared'],
    ],
  );
  await t.throwsAsync(() => take(4, { timeoutMs: 100 }), {
    message: /still held/,
  });
  const fourth = take(5);
  await sleep(50);
  await held[1].release();
  const got = await fourth;
  t.is(got.slot, 1);
  // eslint-disable-next-line no-await-in-loop
  for (const lock of [held[0], held[2], got]) await lock.release();
  t.deepEqual(await readdir(dir), []);
});

test('CLI takers on two slots: never more than two commands at once', async t => {
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const lock = path.join(dir, 'lock');
  const log = path.join(dir, 'log');
  const body = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'+\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'-\\n'),300);`;
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      runCli(home, [
        '--lock',
        lock,
        '--slots',
        '2',
        '--label',
        `c${i}`,
        '--',
        process.execPath,
        '-e',
        body,
      ]),
    ),
  );
  t.deepEqual(
    results.map(r => r.code),
    [0, 0, 0, 0, 0],
  );
  let inside = 0;
  let most = 0;
  for (const mark of (await readFile(log, 'utf8')).trim().split('\n')) {
    inside += mark === '+' ? 1 : -1;
    most = Math.max(most, inside);
  }
  t.is(most, 2);
  const rows = await runLog(home);
  t.is(rows.length, 5);
  t.deepEqual(new Set(rows.map(r => r.slot)), new Set([0, 1]));
});

test('an exclusive taker waits for every slot and holds them all under one id', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const { live, ...liveness } = fakeLiveness();
  live.add(1);
  live.add(9);
  const base = { lockPath, slots: 3, env: {}, pollMs: 10, ...liveness };
  const shared = await acquireRunLock({ ...base, pid: 1 });
  const events = [];
  const exclusive = acquireRunLock({
    ...base,
    pid: 9,
    mode: 'exclusive',
    onEvent: event => events.push(event),
  });
  t.true(await waitFor(() => events.length > 0));
  t.deepEqual(
    events.map(e => e.event),
    ['waiting'],
  );
  // While waiting it holds the intent marker and the free slots.
  t.is((await readJson(intentPath(lockPath))).pid, 9);
  await shared.release();
  const all = await exclusive;
  t.is(all.slot, 'all');
  t.is(all.mode, 'exclusive');
  const records = await Promise.all(slotPaths(lockPath, 3).map(readJson));
  t.true(records.every(r => r.id === all.id && r.mode === 'exclusive'));
  // The marker is gone once every slot is held, so the next one can queue.
  t.false((await readdir(dir)).includes('lock.intent'));
  await all.recordWorkload(process.pid);
  t.true(
    (await Promise.all(slotPaths(lockPath, 3).map(readJson))).every(
      r => r.workload?.pid === process.pid,
    ),
  );
  await all.release();
  t.deepEqual(await readdir(dir), []);
});

test('the intent marker: no new shared taker gets a free slot while an exclusive taker waits', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const { live, ...liveness } = fakeLiveness();
  for (const pid of [1, 2, 9]) live.add(pid);
  const base = { lockPath, slots: 2, env: {}, pollMs: 10, ...liveness };
  const a = await acquireRunLock({ ...base, pid: 1 });
  const order = [];
  const exclusive = acquireRunLock({ ...base, pid: 9, mode: 'exclusive' }).then(
    lock => {
      order.push('exclusive');
      return lock;
    },
  );
  await waitFor(async () => (await readdir(dir)).includes('lock.intent'));
  // Slot 1 is free (or held by the waiting exclusive taker), but B holds off.
  const events = [];
  await t.throwsAsync(
    () =>
      acquireRunLock({
        ...base,
        pid: 2,
        timeoutMs: 150,
        onEvent: event => events.push(event),
      }),
    { message: /still held/ },
  );
  t.deepEqual(events, [
    { event: 'waiting', holder: events[0].holder, intent: true },
  ]);
  t.is(events[0].holder.pid, 9);
  const b = acquireRunLock({ ...base, pid: 2 }).then(lock => {
    order.push('shared');
    return lock;
  });
  await sleep(50);
  await a.release();
  const all = await exclusive;
  await sleep(50);
  t.deepEqual(order, ['exclusive'], 'B still waits while all slots are held');
  await all.release();
  const second = await b;
  t.deepEqual(order, ['exclusive', 'shared']);
  await second.release();
  t.deepEqual(await readdir(dir), []);
});

test('a stale intent marker is broken by a shared taker', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const { live, ...liveness } = fakeLiveness();
  live.add(1);
  await writeFile(
    intentPath(lockPath),
    JSON.stringify({
      version: 2,
      id: 'dddddddddddddddddddddddd',
      pid: 77,
      mode: 'exclusive',
    }),
  );
  const events = [];
  const lock = await acquireRunLock({
    lockPath,
    slots: 2,
    pid: 1,
    env: {},
    pollMs: 10,
    timeoutMs: 2000,
    onEvent: event => events.push(event),
    ...liveness,
  });
  t.is(events[0]?.event, 'brokeStale');
  t.true(events[0]?.intent);
  t.is(lock.slot, 0);
  await lock.release();
  t.deepEqual(await readdir(dir), []);
});

test('stale slots: a shared taker clears them, an exclusive taker breaks all, a dead exclusive waiter is passed over', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const { live, ...liveness } = fakeLiveness();
  const base = { lockPath, slots: 3, env: {}, pollMs: 10, ...liveness };
  const stale = async () => {
    for (const [i, file] of slotPaths(lockPath, 3).entries())
      // eslint-disable-next-line no-await-in-loop
      await writeFile(
        file,
        JSON.stringify({ version: 2, id: `${i}`.repeat(24), pid: 100 + i }),
      );
  };
  await stale();
  live.add(1);
  const events = [];
  const one = await acquireRunLock({
    ...base,
    pid: 1,
    timeoutMs: 2000,
    onEvent: event => events.push(event),
  });
  // Every stale slot it met is cleared on the way.
  t.is(events.filter(e => e.event === 'brokeStale').length, 3);
  t.is(one.slot, 0);
  await one.release();
  await stale();
  live.add(2);
  const all = await acquireRunLock({
    ...base,
    pid: 2,
    mode: 'exclusive',
    timeoutMs: 2000,
  });
  t.is(all.slot, 'all');
  await all.release();
  // An exclusive taker died after taking the intent marker and slot 1: a
  // shared taker and then an exclusive one are not blocked by it.
  const dead = { version: 2, id: 'f'.repeat(24), pid: 44, mode: 'exclusive' };
  await writeFile(intentPath(lockPath), JSON.stringify(dead));
  await writeFile(slotPaths(lockPath, 3)[1], JSON.stringify(dead));
  live.add(5);
  const after = await acquireRunLock({ ...base, pid: 5, timeoutMs: 2000 });
  t.is(after.slot, 0);
  await after.release();
  await writeFile(intentPath(lockPath), JSON.stringify(dead));
  live.add(6);
  const whole = await acquireRunLock({
    ...base,
    pid: 6,
    mode: 'exclusive',
    timeoutMs: 2000,
  });
  t.is(whole.slot, 'all');
  await whole.release();
  t.deepEqual(await readdir(dir), []);
});

test('re-entry applies per slot and passes an exclusive waiter', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const { live, ...liveness } = fakeLiveness();
  for (const pid of [1, 2, 3, 9]) live.add(pid);
  const base = { lockPath, slots: 2, env: {}, pollMs: 10, ...liveness };
  const first = await acquireRunLock({ ...base, pid: 1 });
  const second = await acquireRunLock({ ...base, pid: 2 });
  t.is(second.slot, 1);
  const exclusive = acquireRunLock({ ...base, pid: 9, mode: 'exclusive' });
  await waitFor(async () => (await readdir(dir)).includes('lock.intent'));
  // Nested under slot 1's holder: through at once, in either mode.
  for (const mode of /** @type {const} */ (['shared', 'exclusive'])) {
    // eslint-disable-next-line no-await-in-loop
    const nested = await acquireRunLock({
      ...base,
      pid: 3,
      mode,
      env: { [RUN_LOCK_ENV]: /** @type {string} */ (second.id) },
      timeoutMs: 100,
    });
    t.true(nested.reentrant);
    t.is(nested.id, second.id);
    // eslint-disable-next-line no-await-in-loop
    await nested.release();
  }
  // A variable naming no held generation is no pass.
  await t.throwsAsync(
    () =>
      acquireRunLock({
        ...base,
        pid: 3,
        env: { [RUN_LOCK_ENV]: 'eeeeeeeeeeeeeeeeeeeeeeee' },
        timeoutMs: 80,
      }),
    { message: /still held/ },
  );
  t.is((await readJson(slotPaths(lockPath, 2)[1])).id, second.id);
  await first.release();
  await second.release();
  await (await exclusive).release();
  t.deepEqual(await readdir(dir), []);
});

test('the time box ends the whole process group, frees the slot, exits 124 and logs it', async t => {
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const lock = path.join(dir, 'lock');
  const pidFile = path.join(dir, 'grandchild');
  // The workload starts a grandchild that sleeps, then sleeps itself.
  const body = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000);`;
  const result = await runCli(home, [
    '--lock',
    lock,
    '--max-ms',
    '500',
    '--label',
    'sleeper',
    '--',
    process.execPath,
    '-e',
    body,
  ]);
  t.is(result.code, TIMED_OUT_EXIT);
  t.regex(result.stderr, /TIMED OUT: "sleeper" ran longer than --max-ms 500/);
  t.true(result.ms < 8000, `took ${result.ms} ms`);
  const grandchild = Number(await readFile(pidFile, 'utf8'));
  t.true(await waitFor(() => !isProcessAlive(grandchild), 3000));
  t.deepEqual(
    (await readdir(dir)).filter(name => name.startsWith('lock')),
    [],
  );
  const [row] = await runLog(home);
  t.like(row, { label: 'sleeper', timedOut: true, exitCode: 124, slot: 0 });
  t.true(Number(row.heldMs) >= 500);
});

test('a workload that ignores SIGTERM gets SIGKILL after the grace', async t => {
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const result = await runCli(home, [
    '--lock',
    path.join(dir, 'lock'),
    '--max-ms',
    '200',
    '--',
    process.execPath,
    '-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ]);
  t.is(result.code, TIMED_OUT_EXIT);
  t.true(result.ms >= 10_000 && result.ms < 20_000, `took ${result.ms} ms`);
});

test('the run log: one line per exit, safe with several writers, no paths', async t => {
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const lock = path.join(dir, 'lock');
  const codes = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      runCli(
        home,
        [
          '--lock',
          lock,
          '--slots',
          '4',
          '--label',
          `w${i} ${harnessRoot}/test/x.test.js`,
          '--',
          process.execPath,
          '-e',
          `process.exit(${i % 3})`,
        ],
        { THIX_AGENT: i % 2 ? 'agent-a' : '' },
      ).then(r => r.code),
    ),
  );
  t.deepEqual(codes, [0, 1, 2, 0, 1, 2, 0, 1]);
  const text = await readFile(path.join(home, 'runs.jsonl'), 'utf8');
  t.false(text.includes(harnessRoot), 'no absolute path is logged');
  const rows = await runLog(home);
  t.is(rows.length, 8);
  for (const row of rows) {
    t.deepEqual(Object.keys(row), [
      'at',
      'lane',
      'agent',
      'label',
      'mode',
      'slot',
      'waitedMs',
      'heldMs',
      'exitCode',
      'timedOut',
    ]);
    t.false(Number.isNaN(Date.parse(row.at)));
    t.is(row.lane, laneOf(process.cwd()));
    t.is(row.mode, 'shared');
    t.is(row.timedOut, false);
    const i = Number(/^w(\d)/.exec(row.label)?.[1]);
    t.is(row.label, `w${i} x.test.js`);
    t.is(row.exitCode, i % 3);
    t.is(row.agent, i % 2 ? 'agent-a' : null);
  }
  // A wait that times out is logged too.
  const holder = await acquireRunLock({ lockPath: lock, env: {} });
  const waited = await runCli(home, [
    '--lock',
    lock,
    '--timeout-ms',
    '100',
    '--',
    process.execPath,
    '-e',
    '',
  ]);
  await holder.release();
  t.is(waited.code, 1);
  t.like((await runLog(home))[8], { slot: null, exitCode: 1, heldMs: 0 });
});

test('a perf check runs exclusive by default; --shared overrides', async t => {
  t.true(namesPerfCheck(['node', 'perf/turn.perf.mjs']));
  t.true(namesPerfCheck(['/x/packages/h/perf/gc.perf.mjs', '--n']));
  t.false(namesPerfCheck(['node', 'perf/_harness.mjs']));
  t.false(namesPerfCheck(['node', 'test/perf.perf.mjs']));
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const lock = path.join(dir, 'lock');
  // node -e ignores the extra argument; the wrapper reads it.
  const command = ['--', process.execPath, '-e', '', 'perf/x.perf.mjs'];
  t.is(
    (await runCli(home, ['--lock', lock, '--slots', '2', ...command])).code,
    0,
  );
  t.is(
    (
      await runCli(home, [
        '--lock',
        lock,
        '--slots',
        '2',
        '--shared',
        ...command,
      ])
    ).code,
    0,
  );
  const rows = await runLog(home);
  t.like(rows[0], { mode: 'exclusive', slot: 'all' });
  t.like(rows[1], { mode: 'shared', slot: 0 });
});

test('argument parsing for modes, slots and the time box', t => {
  t.deepEqual(
    parseRunLockArgs([
      '--exclusive',
      '--max-ms',
      '5',
      '--slots',
      '2',
      '--',
      'a',
    ]),
    {
      options: { mode: 'exclusive', maxMs: 5, slots: 2 },
      command: ['a'],
    },
  );
  t.deepEqual(parseRunLockArgs(['--shared', '--', 'a']).options, {
    mode: 'shared',
  });
  t.throws(() => parseRunLockArgs(['--exclusive', '--shared', '--', 'a']), {
    message: /exclude/,
  });
  t.throws(() => parseRunLockArgs(['--max-ms', '0', '--', 'a']), {
    message: /whole number/,
  });
  t.is(scrubLabel('m2 /a/b/c.test.js rel/d.js'), 'm2 c.test.js d.js');
  t.is(
    defaultLabel([
      '/usr/bin/node',
      '--flag',
      '/abs/test/integration/x.test.js',
    ]),
    'node x.test.js',
  );
});

test('start times read the same in every time zone and locale', t => {
  const script = `import(${JSON.stringify(runLockScript)}).then(m=>process.stdout.write(String(m.processStartTime(${process.pid}))))`;
  const readIn = (/** @type {Record<string, string>} */ env) =>
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env },
    }).toString();
  const here = String(processStartTime(process.pid));
  t.not(here, 'undefined');
  t.is(readIn({ TZ: 'UTC' }), here);
  t.is(readIn({ TZ: 'Pacific/Honolulu', LC_ALL: 'de_DE.UTF-8' }), here);
  t.is(readIn({ TZ: 'Asia/Kolkata', LANG: 'fr_FR.UTF-8' }), here);
});

test('a waiter in another time zone never breaks a live holder', async t => {
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const lock = path.join(dir, 'lock');
  const go = path.join(dir, 'go');
  const body = `const fs=require('fs');const i=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)}))clearInterval(i)},20);`;
  const holder = runCli(
    home,
    ['--lock', lock, '--label', 'holder', '--', process.execPath, '-e', body],
    { TZ: 'Pacific/Honolulu' },
  );
  t.true(
    await waitFor(async () => {
      const record = await readJson(lock).catch(() => undefined);
      return record?.workload?.pid !== undefined;
    }),
  );
  const waiter = await runCli(
    home,
    ['--lock', lock, '--timeout-ms', '800', '--', process.execPath, '-e', ''],
    { TZ: 'UTC' },
  );
  t.is(waiter.code, 1);
  t.regex(waiter.stderr, /still held/);
  t.notRegex(waiter.stderr, /brokeStale/);
  await writeFile(go, '');
  t.is((await holder).code, 0);
});

test('temporary files of dead writers are removed once old; others are kept', async t => {
  const dir = await scratch(t, 'rs');
  const lockPath = path.join(dir, 'lock');
  const dead = Number(spawnSync(process.execPath, ['-e', '']).pid);
  t.false(isProcessAlive(dead));
  const old = new Date(Date.now() - TEMPORARY_STALE_MS - 5000);
  const write = async (
    /** @type {string} */ name,
    /** @type {string} */ text,
    /** @type {Date} */ when,
  ) => {
    const file = path.join(dir, name);
    await writeFile(file, text);
    await utimes(file, when, when);
  };
  const hex = (/** @type {string} */ c) => c.repeat(24);
  const deadRecord = JSON.stringify({ pid: dead, startedAt: 'x' });
  const liveRecord = JSON.stringify({
    pid: process.pid,
    startedAt: processStartTime(process.pid),
  });
  await write(`lock.2.n${hex('a')}`, deadRecord, old); // dead, old: removed
  await write(`lock.intent.n${hex('b')}`, '', old); // unreadable, old: removed
  await write(`lock.n${hex('c')}`, deadRecord, new Date()); // young: kept
  await write(`lock.1.n${hex('d')}`, liveRecord, old); // live writer: kept
  await write(`other.n${hex('e')}`, deadRecord, old); // not this lock's: kept
  const lock = await acquireRunLock({ lockPath, env: {}, timeoutMs: 2000 });
  await lock.release();
  t.deepEqual((await readdir(dir)).sort(), [
    `lock.1.n${hex('d')}`,
    `lock.n${hex('c')}`,
    `other.n${hex('e')}`,
  ]);
});

test('an in-process taker of the machine-wide lock logs its run on release', async t => {
  const dir = await scratch(t, 'rs');
  const env = { THIX_HARNESS_HOME: dir, THIX_AGENT: 'agent-b' };
  const lock = await acquireRunLock({ env, label: `it ${dir}/x.test.js` });
  t.is(lock.slot, 0);
  // Nested in it: passes through and logs nothing.
  const nested = await acquireRunLock({
    env: { ...env, [RUN_LOCK_ENV]: /** @type {string} */ (lock.id) },
  });
  t.true(nested.reentrant);
  await nested.release();
  await lock.release();
  await lock.release(); // a second release logs nothing
  // Opted out: no line.
  const quiet = await acquireRunLock({ env, runLog: false });
  await quiet.release();
  // A private lock: no line by default.
  const own = await acquireRunLock({ env, lockPath: path.join(dir, 'p') });
  await own.release();
  const rows = await runLog(dir);
  t.is(rows.length, 1);
  t.like(rows[0], {
    agent: 'agent-b',
    label: 'it x.test.js',
    mode: 'shared',
    slot: 0,
    exitCode: null,
    timedOut: false,
  });
  t.false(JSON.stringify(rows[0]).includes(dir), 'no absolute path');
});

test('processes a workload leaves in its group are ended before the slot is freed', async t => {
  const dir = await scratch(t, 'rs');
  const home = path.join(dir, 'home');
  const lock = path.join(dir, 'lock');
  const pidFile = path.join(dir, 'leaked');
  // The workload starts a child in its group and exits at once.
  const body = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
  const result = await runCli(home, [
    '--lock',
    lock,
    '--label',
    'leaker',
    '--',
    process.execPath,
    '-e',
    body,
  ]);
  t.is(result.code, 0);
  t.regex(result.stderr, /"leaker" exited and left processes in its group/);
  t.true(result.ms < 8000, `took ${result.ms} ms`);
  const leaked = Number(await readFile(pidFile, 'utf8'));
  t.true(await waitFor(() => !isProcessAlive(leaked), 3000));
  t.deepEqual(
    (await readdir(dir)).filter(name => name.startsWith('lock')),
    [],
  );
  t.like((await runLog(home))[0], { label: 'leaker', exitCode: 0 });
});
