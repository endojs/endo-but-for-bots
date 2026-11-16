// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile, spawn } from 'node:child_process';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  RUN_LOCK_ENV,
  acquireRunLock,
  parseRunLockArgs,
  withRunLock,
} from '../scripts/run-lock.mjs';
import { harnessRoot, scratch } from './_helpers.js';

const runLockScript = path.join(harnessRoot, 'scripts', 'run-lock.mjs');

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
      { env: { ...process.env, [RUN_LOCK_ENV]: '', ...env } },
      (_error, _stdout, stderr) =>
        resolve({ code: child.exitCode, stderr: String(stderr) }),
    );
  });

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
  const nested = await acquireRunLock({
    lockPath,
    pid: process.pid + 1_000_000,
    env: { [RUN_LOCK_ENV]: String(process.pid) },
    timeoutMs: 100,
  });
  t.true(nested.reentrant);
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
