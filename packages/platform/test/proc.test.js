// @ts-check

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import test from '@endo/ses-ava/prepare-endo.js';

import { waitForExit, waitForExitOrCancel, waitForSpawn } from '../src/proc.js';

for (const code of [0, 7]) {
  test.serial(`waitForExit preserves normal exit code ${code}`, async t => {
    t.timeout(5000);
    const child = spawn(process.execPath, ['-e', `process.exit(${code})`]);
    t.teardown(() => child.kill());
    t.is(await waitForExit(child), code);
  });
}

for (const cancellable of [false, true]) {
  test.serial(
    `signal exit is a failure with cancellation support ${cancellable}`,
    async t => {
      t.timeout(5000);
      const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      t.teardown(() => child.kill());
      const exited = cancellable
        ? waitForExitOrCancel(child, new Promise(() => {}))
        : waitForExit(child);
      await waitForSpawn(child);
      child.kill('SIGTERM');
      t.is(await exited, 128 + constants.signals.SIGTERM);
    },
  );
}

test.serial('cancellation still rejects and terminates the child', async t => {
  t.timeout(5000);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.teardown(() => child.kill());
  /** @type {(reason: Error) => void} */
  let cancel = () => {
    throw Error('Cancellation not initialized');
  };
  /** @type {Promise<never>} */
  const cancelled = new Promise((_, reject) => {
    cancel = reject;
  });
  const exited = waitForExit(child);
  const result = waitForExitOrCancel(child, cancelled);
  await waitForSpawn(child);
  cancel(Error('cancelled by owner'));
  await t.throwsAsync(result, { message: 'cancelled by owner' });
  t.not(await exited, 0);
});
