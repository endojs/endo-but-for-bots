// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile, spawn } from 'node:child_process';
import {
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  RUN_LOCK_ENV,
  acquireRunLock,
  isRecordAlive,
  isProcessAlive,
  parseRunLockArgs,
  processStartTime,
  withRunLock,
} from '../scripts/run-lock.mjs';
import { harnessRoot, scratch } from './_helpers.js';

const runLockScript = path.join(harnessRoot, 'scripts', 'run-lock.mjs');
// The CLI's run log goes here, never to the machine's real one.
const testHome = path.join(harnessRoot, 'tmp', `rlh${process.pid}`);
const takerScript = path.join(
  harnessRoot,
  'test',
  'fixtures',
  'run-lock-taker.mjs',
);

/** A pid that no longer exists: a child that has exited. */
const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.once('exit', resolve));
  return /** @type {number} */ (child.pid);
};

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
const runCli = (args, env = {}) =>
  new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [runLockScript, ...args],
      {
        env: {
          ...process.env,
          [RUN_LOCK_ENV]: '',
          THIX_HARNESS_HOME: testHome,
          ...env,
        },
      },
      (_error, _stdout, stderr) =>
        resolve({ code: child.exitCode, stderr: String(stderr) }),
    );
  });

test.after.always(() => rm(testHome, { recursive: true, force: true }));

test('two CLI takers serialise: one command runs at a time', async t => {
  const dir = await scratch(t, 'rl');
  const lock = path.join(dir, 'lock');
  const log = path.join(dir, 'log');
  // Each command logs start, holds for 400 ms, logs end.
  const body = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start '+process.pid+'\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'end '+process.pid+'\\n'),400);`;
  const results = await Promise.all([
    runCli([
      '--lock',
      lock,
      '--label',
      'a',
      '--',
      process.execPath,
      '-e',
      body,
    ]),
    runCli([
      '--lock',
      lock,
      '--label',
      'b',
      '--',
      process.execPath,
      '-e',
      body,
    ]),
  ]);
  t.deepEqual(
    results.map(r => r.code),
    [0, 0],
  );
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  t.is(lines.length, 4);
  const [s1, e1, s2, e2] = lines.map(line => line.split(' '));
  t.deepEqual(
    [s1[0], e1[0], s2[0], e2[0]],
    ['start', 'end', 'start', 'end'],
    lines.join(' | '),
  );
  t.is(s1[1], e1[1]);
  t.is(s2[1], e2[1]);
  t.not(s1[1], s2[1]);
  // One of the two said it waited; the lock is gone afterwards.
  t.true(results.some(r => r.stderr.includes('"event":"waiting"')));
  await t.throwsAsync(() => stat(lock), { code: 'ENOENT' });
});

test('in-process takers serialise and a release lets the next one in', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const order = [];
  // Distinct holder pids so the second taker cannot mistake the first for itself.
  const first = await acquireRunLock({ lockPath, pid: process.pid, env: {} });
  const second = withRunLock(
    {
      lockPath,
      pollMs: 20,
      env: {},
      pid: process.pid + 1_000_000,
      isAlive: () => true,
    },
    async () => order.push('second'),
  );
  await new Promise(resolve => setTimeout(resolve, 150));
  order.push('first');
  await first.release();
  await second;
  t.deepEqual(order, ['first', 'second']);
});

test('a lock whose holder pid is gone is broken', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const pid = await deadPid();
  await writeFile(lockPath, JSON.stringify({ pid, label: 'crashed', at: 'x' }));
  const events = [];
  const lock = await acquireRunLock({
    lockPath,
    env: {},
    timeoutMs: 2000,
    onEvent: event => events.push(event),
  });
  t.false(lock.reentrant);
  t.deepEqual(events, [
    { event: 'brokeStale', holder: { pid, label: 'crashed', at: 'x' } },
  ]);
  t.is(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  await lock.release();
  await t.throwsAsync(() => stat(lockPath), { code: 'ENOENT' });
});

test('two waiters breaking one stale lock: exactly one holds it at a time', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  await writeFile(lockPath, JSON.stringify({ pid: await deadPid() }));
  let inside = 0;
  let maxInside = 0;
  const take = (/** @type {number} */ pid) =>
    withRunLock(
      {
        lockPath,
        pid,
        env: {},
        pollMs: 10,
        isAlive: p => p === 1e6 + 1 || p === 1e6 + 2,
      },
      async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise(resolve => setTimeout(resolve, 50));
        inside -= 1;
      },
    );
  await Promise.all([take(1e6 + 1), take(1e6 + 2)]);
  t.is(maxInside, 1);
});

test('an unreadable lock is stale only once it is old', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  await writeFile(lockPath, '');
  await t.throwsAsync(
    () => acquireRunLock({ lockPath, env: {}, pollMs: 20, timeoutMs: 100 }),
    { message: /still held/ },
  );
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const lock = await acquireRunLock({ lockPath, env: {}, timeoutMs: 1000 });
  await lock.release();
  t.pass();
});

test('a live holder is waited for until the timeout', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const held = await acquireRunLock({ lockPath, env: {} });
  await t.throwsAsync(
    () =>
      acquireRunLock({
        lockPath,
        env: {},
        pid: process.pid + 1_000_000,
        pollMs: 20,
        timeoutMs: 100,
      }),
    { message: /still held after 100 ms/ },
  );
  await held.release();
});

test('a nested taker under the holder passes through', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const held = await acquireRunLock({ lockPath, env: {} });
  // A pid alone does not let a taker in: the variable names a generation.
  await t.throwsAsync(
    () =>
      acquireRunLock({
        lockPath,
        pid: process.pid + 1_000_000,
        env: { [RUN_LOCK_ENV]: String(process.pid) },
        pollMs: 20,
        timeoutMs: 60,
      }),
    { message: /still held/ },
  );
  const nested = await acquireRunLock({
    lockPath,
    pid: process.pid + 1_000_000,
    env: { [RUN_LOCK_ENV]: held.id },
    timeoutMs: 100,
  });
  t.true(nested.reentrant);
  t.is(nested.id, held.id);
  await nested.release();
  // The nested release leaves the holder's lock in place.
  t.is(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  await held.release();
});

test('release never removes a lock someone else now holds', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const mine = await acquireRunLock({ lockPath, env: {} });
  await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1_000_000 }));
  await mine.release();
  t.is(
    JSON.parse(await readFile(lockPath, 'utf8')).pid,
    process.pid + 1_000_000,
  );
});

test('the CLI passes the command exit code through and refuses bad arguments', async t => {
  const dir = await scratch(t, 'rl');
  const lock = path.join(dir, 'lock');
  const failed = await runCli([
    '--lock',
    lock,
    '--',
    process.execPath,
    '-e',
    'process.exit(3)',
  ]);
  t.is(failed.code, 3);
  const env = await runCli([
    '--lock',
    lock,
    '--',
    process.execPath,
    '-e',
    `process.exit(process.env.${RUN_LOCK_ENV} ? 0 : 4)`,
  ]);
  t.is(env.code, 0, 'the command sees the holder variable');
  t.is((await runCli(['no-separator'])).code, 1);
  t.throws(() => parseRunLockArgs(['--label']), {
    message: /Usage|needs a value/,
  });
  t.throws(() => parseRunLockArgs(['--what', 'x', '--', 'true']), {
    message: /Unknown option/,
  });
  t.deepEqual(parseRunLockArgs(['--timeout-ms', '5', '--', 'a', 'b']), {
    options: { timeoutMs: 5 },
    command: ['a', 'b'],
  });
});

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
const readLock = async file => JSON.parse(await readFile(file, 'utf8'));

test('a taken lock records the taker with its start time and a generation id', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const lock = await acquireRunLock({ lockPath, env: {} });
  const record = await readLock(lockPath);
  t.is(record.version, 2);
  t.is(record.id, lock.id);
  t.regex(record.id, /^[0-9a-f]{24}$/);
  t.is(record.pid, process.pid);
  t.is(record.startedAt, processStartTime(process.pid));
  t.truthy(record.startedAt);
  await lock.release();
  // No temporary or token files are left beside it.
  t.deepEqual(await readdir(dir), []);
});

test('the CLI records the workload; killing the wrapper leaves the lock held until the workload ends', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const release = path.join(dir, 'go');
  // The workload runs until the file `go` appears.
  const body = `const fs=require('fs');const i=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(i)}},20);`;
  const wrapper = spawn(
    process.execPath,
    [runLockScript, '--lock', lockPath, '--', process.execPath, '-e', body],
    {
      stdio: 'ignore',
      env: { ...process.env, [RUN_LOCK_ENV]: '', THIX_HARNESS_HOME: testHome },
    },
  );
  t.true(
    await waitFor(async () => {
      const record = await readLock(lockPath).catch(() => undefined);
      return record?.workload?.pid !== undefined;
    }),
    'the workload pid is recorded',
  );
  const record = await readLock(lockPath);
  t.is(record.pid, wrapper.pid);
  t.not(record.workload.pid, wrapper.pid);
  t.is(record.workload.startedAt, processStartTime(record.workload.pid));
  wrapper.kill('SIGKILL');
  await new Promise(resolve => wrapper.once('exit', resolve));
  t.false(isProcessAlive(/** @type {number} */ (wrapper.pid)));
  t.true(
    isProcessAlive(record.workload.pid),
    'the workload outlives the wrapper',
  );
  // The lock is not stale while the workload runs.
  await t.throwsAsync(
    () => acquireRunLock({ lockPath, env: {}, pollMs: 20, timeoutMs: 300 }),
    { message: /still held/ },
  );
  t.is((await readLock(lockPath)).id, record.id);
  await writeFile(release, '');
  t.true(await waitFor(() => !isProcessAlive(record.workload.pid)));
  const events = [];
  const next = await acquireRunLock({
    lockPath,
    env: {},
    pollMs: 20,
    timeoutMs: 2000,
    onEvent: event => events.push(event),
  });
  t.is(events[0]?.event, 'brokeStale');
  await next.release();
});

test('a live pid with another start time is a reused pid: the lock is stale', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 2,
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      pid: process.pid,
      startedAt: 'Thu Jan  1 00:00:00 1970',
    }),
  );
  const liveness = { isAlive: isProcessAlive, startTimeOf: processStartTime };
  t.false(
    isRecordAlive(
      { pid: process.pid, startedAt: 'Thu Jan 1 00:00:00 1970' },
      liveness,
    ),
  );
  t.true(
    isRecordAlive(
      { pid: process.pid, startedAt: processStartTime(process.pid) },
      liveness,
    ),
  );
  const lock = await acquireRunLock({
    lockPath,
    env: {},
    pid: process.pid + 1_000_000,
    timeoutMs: 2000,
  });
  t.not((await readLock(lockPath)).id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  await lock.release();
});

test('many takers racing a live holder never break it', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const held = await acquireRunLock({ lockPath, env: {} });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      acquireRunLock({
        lockPath,
        env: {},
        pid: process.pid + 1_000_000 + i,
        pollMs: 1,
        timeoutMs: 200,
      }),
    ),
  );
  t.true(results.every(r => r.status === 'rejected'));
  t.is((await readLock(lockPath)).id, held.id);
  await held.release();
});

test('in-process takers racing over repeatedly abandoned locks: one holder at a time', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  // Fake pids: a taker "dies" by leaving its pid out of the live set.
  const live = new Set();
  const liveness = {
    isAlive: (/** @type {number} */ p) => live.has(p),
    startTimeOf: () => undefined,
  };
  let inside = 0;
  let maxInside = 0;
  let taken = 0;
  const takers = Array.from({ length: 10 }, async (_, i) => {
    for (let round = 0; round < 6; round += 1) {
      const pid = 2_000_000 + i * 100 + round;
      live.add(pid);
      // eslint-disable-next-line no-await-in-loop
      const lock = await acquireRunLock({
        lockPath,
        env: {},
        pid,
        pollMs: 1,
        timeoutMs: 20_000,
        ...liveness,
      });
      inside += 1;
      taken += 1;
      maxInside = Math.max(maxInside, inside);
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.random() * 4);
      inside -= 1;
      // Every other round the holder dies holding the lock.
      if (round % 2) live.delete(pid);
      // eslint-disable-next-line no-await-in-loop
      else await lock.release();
    }
  });
  await Promise.all(takers);
  t.is(taken, 60);
  t.is(maxInside, 1);
  const left = (await readdir(dir)).filter(name => name !== 'lock');
  t.deepEqual(left, [], 'no temporary files or break tokens are left');
});

test('a break token whose owner died is passed over', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const gone = await deadPid();
  const id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  await writeFile(lockPath, JSON.stringify({ version: 2, id, pid: gone }));
  // A breaker that died holding token 0 for this generation.
  await writeFile(`${lockPath}.break-${id}-0`, JSON.stringify({ pid: gone }));
  const lock = await acquireRunLock({ lockPath, env: {}, timeoutMs: 2000 });
  t.is((await readLock(lockPath)).id, lock.id);
  await lock.release();
  t.deepEqual(await readdir(dir), []);
});

test('a break token whose owner is alive is respected', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const id = 'cccccccccccccccccccccccc';
  await writeFile(
    lockPath,
    JSON.stringify({ version: 2, id, pid: await deadPid() }),
  );
  await writeFile(
    `${lockPath}.break-${id}-0`,
    JSON.stringify({ pid: process.pid }),
  );
  await t.throwsAsync(
    () => acquireRunLock({ lockPath, env: {}, pollMs: 20, timeoutMs: 150 }),
    { message: /still held/ },
  );
  t.is((await readLock(lockPath)).id, id);
});

test('separate processes racing, half of them dying with the lock held: never two holders', async t => {
  const dir = await scratch(t, 'rl');
  const lockPath = path.join(dir, 'lock');
  const marker = path.join(dir, 'inside');
  const log = path.join(dir, 'log');
  await writeFile(log, '');
  const N = 24;
  const codes = await Promise.all(
    Array.from(
      { length: N },
      (_, i) =>
        new Promise(resolve => {
          const child = spawn(
            process.execPath,
            [takerScript, lockPath, marker, log, i % 2 ? 'die' : 'release'],
            { stdio: ['ignore', 'ignore', 'inherit'] },
          );
          child.once('exit', code => resolve(code));
        }),
    ),
  );
  t.deepEqual(
    codes,
    Array.from({ length: N }, () => 0),
  );
  const lines = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  t.is(lines.filter(line => line.overlap).length, 0, 'no two holders');
  t.is(lines.filter(line => line.held).length, N);
  t.true(
    lines.some(line => line.event === 'brokeStale'),
    'stale locks were broken',
  );
  const left = (await readdir(dir)).filter(
    name => !['lock', 'log'].includes(name),
  );
  t.deepEqual(left, []);
});
