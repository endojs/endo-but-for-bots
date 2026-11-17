// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeStateStorageOperations } from '../src/session-state-storage.js';

for (const stage of [
  'directory-created',
  'record-opened',
  'record-written',
  'record-published',
]) {
  test.serial(`native state recovers after SIGKILL at ${stage}`, async t => {
    t.timeout(15_000);
    const base = await mkdtemp(path.join(tmpdir(), 'state-process-loss-'));
    const root = path.join(await realpath(base), 'state');
    const child = fork(
      fileURLToPath(new URL('./_state-crash-worker.js', import.meta.url)),
      [root, stage],
      { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', bytes => {
      stderr = `${stderr}${String(bytes)}`.slice(-8192);
    });
    const exited = new Promise(resolve => {
      // close also fires after a spawn error, when there was no exit event.
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    t.teardown(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
      await rm(base, { recursive: true, force: true });
    });
    await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('message', message => {
          if (
            message !== null &&
            typeof message === 'object' &&
            'stage' in message &&
            message.stage === stage
          ) {
            resolve(undefined);
          } else {
            reject(Error('Unexpected worker checkpoint'));
          }
        });
      }),
      exited.then(() => {
        throw Error(`Worker exited before checkpoint: ${stderr}`);
      }),
    ]);
    t.true(child.kill('SIGKILL'));
    t.deepEqual(await exited, { code: null, signal: 'SIGKILL' });

    const recovered = makeStateStorageOperations(root);
    const before = await recovered.inspectAllocations();
    t.is(before.length, 1);
    const oldAllocation = before[0].allocation;
    const { directory } =
      await recovered.prepareSessionDirectory('crash-session');
    const record = JSON.parse(
      await readFile(`${root}/.owners/crash-session`, 'utf8'),
    );
    t.is(directory, `${root}/native_allocations/${record.allocation}/data`);
    if (stage === 'record-published') {
      t.is(record.allocation, oldAllocation);
      t.is(before[0].state, 'published');
    } else {
      t.not(
        record.allocation,
        oldAllocation,
        'never adopt an unpublished allocation',
      );
      if (stage === 'record-written') {
        t.is(before[0].state, 'unreferenced');
        await recovered.removeUnreferencedAllocation(oldAllocation);
      } else {
        t.is(before[0].state, 'unproven');
        await t.throwsAsync(
          recovered.removeUnreferencedAllocation(oldAllocation),
          { message: /ownership is unproven/ },
        );
      }
    }
    t.deepEqual(await recovered.prepareSessionDirectory('crash-session'), {
      directory,
    });
  });
}
