// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { authRetryStatus, makeLaunch } from '../src/launch.js';

/** @param {number} status */
const retryLine = status =>
  JSON.stringify({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    error_status: status,
    error: 'authentication_failed',
  });

test('authRetryStatus recognises only rejected-credential retries', t => {
  t.is(authRetryStatus(retryLine(401)), 401);
  t.is(authRetryStatus(retryLine(403)), 403);
  t.is(authRetryStatus(retryLine(529)), undefined);
  t.is(authRetryStatus('{"type":"system","subtype":"init"}'), undefined);
  t.is(authRetryStatus('{"subtype":"api_retry"'), undefined);
});

/**
 * A child that writes `lines` to stdout, split mid-line, and closes only when
 * killed.
 *
 * @param {string[]} lines
 */
const makeFakeSpawn = lines => {
  /** @type {string[]} */
  const killed = [];
  const spawn = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = undefined;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    /** @param {string} signal */
    child.kill = signal => {
      killed.push(signal);
      setImmediate(() => child.emit('close', null));
    };
    const text = lines.map(line => `${line}\n`).join('');
    const middle = Math.floor(text.length / 2);
    setImmediate(() => {
      child.stdout.write(text.slice(0, middle));
      child.stdout.write(text.slice(middle));
    });
    return child;
  };
  return { spawn, killed };
};

const limits = harden({
  wallClockMs: 60_000,
  outputByteCap: 1_000_000,
  maxTurns: 4,
});

test('repeated 401 retries stop the child as auth-failed', async t => {
  const { spawn, killed } = makeFakeSpawn([
    '{"type":"system","subtype":"init"}',
    retryLine(401),
    retryLine(401),
  ]);
  const launch = makeLaunch({
    spawn,
    claudePath: '/usr/bin/claude',
    cwd: '/',
    kill: child => child.kill('SIGKILL'),
  });
  const result = await launch(
    /** @type {any} */ ({ argv: [], env: {}, prompt: 'p', limits }),
  );
  t.deepEqual({ ...result }, { type: 'auth-failed', status: 401 });
  t.deepEqual(killed, ['SIGKILL']);
});

test('a single 401 retry is tolerated under the limit', async t => {
  const { spawn } = makeFakeSpawn([retryLine(401)]);
  const launch = makeLaunch({
    spawn,
    claudePath: '/usr/bin/claude',
    cwd: '/',
    authRetryLimit: 2,
    kill: child => child.kill('SIGKILL'),
  });
  const result = await launch(
    /** @type {any} */ ({
      argv: [],
      env: {},
      prompt: 'p',
      limits: { ...limits, wallClockMs: 200 },
    }),
  );
  t.deepEqual({ ...result }, { type: 'limit-exceeded', which: 'wall-clock' });
});
