// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { spawn } from 'node:child_process';

import { killProcessGroup } from '../src/drivers/child-process.js';

/**
 * `killProcessGroup` aims a signal at a negative pid, so it is the one
 * helper in the driver layer that can reach a process the sandbox does
 * not own: Node leaves `child.pid` populated after the child is reaped,
 * and the kernel is free to reissue that pgid to an unrelated process
 * group belonging to the same user.  These tests pin the guard that
 * keeps the signal on the live-child path.
 */

/**
 * Spawn a long-lived detached child, so it leads its own process group
 * exactly as the drivers' sandboxed children do.  The child is killed
 * on teardown whether or not the test signalled it.
 *
 * @param {import('ava').ExecutionContext} t
 * @returns {import('child_process').ChildProcess}
 */
const spawnDetachedSleeper = t => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  t.teardown(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
      }
    } catch {
      // Already gone.
    }
  });
  return child;
};

/**
 * @param {import('child_process').ChildProcess} child
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
const whenExited = child =>
  new Promise(resolve =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );

test('killProcessGroup signals the group of a live child', async t => {
  t.timeout(20_000);
  const child = spawnDetachedSleeper(t);
  const exited = whenExited(child);
  killProcessGroup(child, 'SIGKILL');
  const { signal } = await exited;
  t.is(signal, 'SIGKILL');
});

test('killProcessGroup tolerates an already-exited child', async t => {
  t.timeout(20_000);
  const child = spawn(process.execPath, ['-e', ''], {
    detached: true,
    stdio: 'ignore',
  });
  await whenExited(child);
  // Node keeps `pid` after reaping; the helper must still return
  // normally, because "that group is gone" is the caller's desired end
  // state and the supervisor reads any throw as a live backend failure.
  t.not(child.pid, undefined);
  t.notThrows(() => killProcessGroup(child, 'SIGKILL'));
});

test('killProcessGroup does not signal a reused pgid', async t => {
  t.timeout(20_000);
  // Stand in for the dangerous shape: a reaped child whose recorded pid
  // now names somebody else's process group.  The bystander here is a
  // live group we own, so an unguarded `process.kill(-pid, …)` would
  // destroy it and fail this test.
  const bystander = spawnDetachedSleeper(t);
  const bystanderExited = whenExited(bystander);
  const reaped = /** @type {import('child_process').ChildProcess} */ (
    /** @type {unknown} */ ({
      pid: bystander.pid,
      exitCode: 0,
      signalCode: null,
    })
  );
  killProcessGroup(reaped, 'SIGKILL');
  const survived = await Promise.race([
    bystanderExited.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), 250)),
  ]);
  t.true(survived, 'the unrelated process group must be untouched');
  t.is(bystander.exitCode, null);
});

test('killProcessGroup ignores a child that never spawned', t => {
  const unspawned = /** @type {import('child_process').ChildProcess} */ (
    /** @type {unknown} */ ({
      pid: undefined,
      exitCode: null,
      signalCode: null,
    })
  );
  t.notThrows(() => killProcessGroup(unspawned, 'SIGKILL'));
});
