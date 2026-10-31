// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  killProcessGroup,
  startControlCommand,
} from '../src/drivers/child-process.js';

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

/** @param {import('ava').ExecutionContext} t */
const controlFixture = t => {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals = [];
  let refusesKill = false;
  Object.assign(child, {
    stdout,
    stderr,
    kill: signal => {
      signals.push(signal);
      if (refusesKill) throw Error('kill refused');
      return true;
    },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stdout.end();
    stderr.end();
    child.emit('close', 0, null);
  };
  t.teardown(close);
  return {
    cp: /** @type {any} */ ({ spawn: () => child }),
    child,
    stdout,
    stderr,
    signals,
    close,
    refuseKill: () => {
      refusesKill = true;
    },
  };
};

test('control cancellation reports failure while retaining native closure', async t => {
  t.timeout(3000);
  const f = controlFixture(t);
  const control = startControlCommand(f.cp, 'command', []);
  const rejected = t.throwsAsync(control.result, { message: /aborted/ });
  let closed = false;
  void control.closed.then(() => {
    closed = true;
  });
  control.abort();
  await rejected;
  t.deepEqual(f.signals, ['SIGKILL']);
  t.true(control.wasInterrupted());
  t.false(closed);
  f.close();
  await control.closed;
  t.true(closed);
  control.abort();
  t.deepEqual(f.signals, ['SIGKILL']);
});

test('a control error and failed kill do not release process ownership', async t => {
  t.timeout(3000);
  const f = controlFixture(t);
  const control = startControlCommand(f.cp, 'command', []);
  const rejected = t.throwsAsync(control.result, { message: 'control error' });
  f.child.emit('error', Error('control error'));
  await rejected;
  let closed = false;
  void control.closed.then(() => {
    closed = true;
  });
  f.refuseKill();
  control.abort();
  await Promise.resolve();
  t.false(closed);
  t.true(control.wasInterrupted());
  f.close();
  await control.closed;
});

test('a control deadline bounds the result but not native closure', async t => {
  t.timeout(3000);
  const f = controlFixture(t);
  const control = startControlCommand(f.cp, 'command', [], { timeoutMs: 5 });
  await t.throwsAsync(control.result, { message: /timed out/ });
  let closed = false;
  void control.closed.then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  t.deepEqual(f.signals, ['SIGKILL']);
  f.close();
  await control.closed;
});

test('a reaped control child is not signalled while inherited pipes remain open', async t => {
  t.timeout(3000);
  const f = controlFixture(t);
  const control = startControlCommand(f.cp, 'command', []);
  const rejected = t.throwsAsync(control.result, { message: /aborted/ });
  f.child.emit('exit', 0, null);
  control.abort();
  await rejected;
  t.deepEqual(f.signals, []);
  t.false(control.wasInterrupted());
  f.close();
  await control.closed;
});

test('natural control completion retains captured output without an interruption', async t => {
  const f = controlFixture(t);
  const control = startControlCommand(f.cp, 'command', []);
  f.stdout.write('output');
  f.stderr.write('diagnostic');
  f.child.emit('exit', 0, null);
  f.close();
  t.deepEqual(await control.result, {
    code: 0,
    signal: null,
    stdout: 'output',
    stderr: 'diagnostic',
  });
  await control.closed;
  t.false(control.wasInterrupted());
});

test('failed or cancelled spawning has no acquired child to retain', async t => {
  const noSpawn = /** @type {any} */ ({
    spawn: () => {
      throw Error('spawn failed');
    },
  });
  const failed = startControlCommand(noSpawn, 'command', []);
  t.false(failed.hasChild());
  await t.throwsAsync(failed.result, { message: 'spawn failed' });
  await failed.closed;
  const cancelled = startControlCommand(noSpawn, 'command', [], {
    isCancelled: () => true,
  });
  t.false(cancelled.hasChild());
  await t.throwsAsync(cancelled.result, { message: /aborted/ });
  await cancelled.closed;
  t.false(cancelled.wasInterrupted());
});

test('control lifetime observes real Node process closure', async t => {
  t.timeout(5000);
  const control = startControlCommand(
    /** @type {any} */ ({ spawn }),
    process.execPath,
    ['-e', "process.stdout.write('hello')"],
  );
  t.teardown(async () => {
    control.abort();
    await control.closed;
  });
  const result = await control.result;
  await control.closed;
  t.true(control.hasChild());
  t.is(result.code, 0);
  t.is(result.stdout, 'hello');
  t.false(control.wasInterrupted());
});
