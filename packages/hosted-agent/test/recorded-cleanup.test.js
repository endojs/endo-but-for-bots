// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { reclaimRecordedMount } from '../src/recorded-cleanup.js';

/** A recorded native placement, rooted in a fresh temporary directory. */
const makeRecorded = async (t, { mounterEnv = undefined } = {}) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'endo-reclaim-'));
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const workspaceMountPoint = path.join(base, 'workspace');
  const mounterSocketDir = path.join(base, '9p');
  await mkdir(workspaceMountPoint);
  await mkdir(mounterSocketDir);
  return harden({
    workspaceMountPoint,
    mounterSocketDir,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
};

/** Record every program invocation instead of running one. */
const makeRunner = (behaviour = () => undefined) => {
  const calls = [];
  return {
    calls,
    runProgram: async (file, args) => {
      calls.push([file, ...args]);
      const outcome = behaviour(file, args);
      if (outcome) throw outcome;
      return undefined;
    },
  };
};

const listenOn = async (t, socketPath) => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  t.teardown(
    () => new Promise(resolve => server.close(() => resolve(undefined))),
  );
  return server;
};

/**
 * A real socket inode with no listener: exactly what a lost worker leaves
 * behind. `close()` unlinks the path it bound, so hard-link the inode first
 * and keep that name.
 */
const makeStaleSocket = async (t, socketPath) => {
  const bound = `${socketPath}.bound`;
  const server = await listenOn(t, bound);
  await link(bound, socketPath);
  await new Promise(resolve => server.close(() => resolve(undefined)));
};

const exists = async target => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

test('a dead socket directory is reclaimed: unmounted, then removed', async t => {
  const recorded = await makeRecorded(t);
  // A leftover socket inode whose server has exited: connecting to it is
  // refused, which is what proves the bridge is gone. The ordinary files
  // beside it are not endpoints and must not be probed as though they were.
  await makeStaleSocket(t, path.join(recorded.mounterSocketDir, 'endo-9p-1.sock'));
  await writeFile(path.join(recorded.mounterSocketDir, 'notes.txt'), 'x');
  const runner = makeRunner();

  await reclaimRecordedMount(recorded, { runProgram: runner.runProgram });

  t.deepEqual(runner.calls, [['umount', '--', recorded.workspaceMountPoint]]);
  t.false(await exists(recorded.workspaceMountPoint), 'mount point removed');
});

test('an empty or missing socket directory is still reclaimed', async t => {
  const recorded = await makeRecorded(t);
  const runner = makeRunner();
  await reclaimRecordedMount(recorded, { runProgram: runner.runProgram });
  t.is(runner.calls.length, 1);

  const gone = await makeRecorded(t);
  await rm(gone.mounterSocketDir, { recursive: true });
  const second = makeRunner();
  await reclaimRecordedMount(gone, { runProgram: second.runProgram });
  t.is(second.calls.length, 1);
});

test('a live 9P bridge refuses the reclamation, and nothing is unmounted', async t => {
  // The safety property: a reconstructed controller must never take down a
  // mount whose bridge is still serving it. This is a check, not an inference
  // from the worker's absence.
  const recorded = await makeRecorded(t);
  await listenOn(t, path.join(recorded.mounterSocketDir, 'endo-9p-live.sock'));
  const runner = makeRunner();

  await t.throwsAsync(
    reclaimRecordedMount(recorded, { runProgram: runner.runProgram }),
    { message: /still serving/ },
  );
  t.deepEqual(runner.calls, [], 'umount was never attempted');
  t.true(await exists(recorded.workspaceMountPoint), 'mount point kept');
});

test('"not mounted" is the state the caller asked for; any other failure is raised', async t => {
  const tolerated = await makeRecorded(t);
  const first = makeRunner(() =>
    Object.assign(Error('exit 32'), {
      stderr: 'umount: /x: not mounted.\n',
    }),
  );
  await reclaimRecordedMount(tolerated, { runProgram: first.runProgram });
  t.false(await exists(tolerated.workspaceMountPoint), 'still removed');

  const refused = await makeRecorded(t);
  const second = makeRunner(() =>
    Object.assign(Error('exit 32'), {
      stderr: 'umount: /x: target is busy.\n',
    }),
  );
  await t.throwsAsync(
    reclaimRecordedMount(refused, { runProgram: second.runProgram }),
    { message: /exit 32/ },
  );
  t.true(
    await exists(refused.workspaceMountPoint),
    'a mount point whose unmount failed is never removed',
  );
});

test('the recorded operator settings choose the umount program', async t => {
  const sudo = await makeRecorded(t, { mounterEnv: { NINEP_SUDO: '1' } });
  const first = makeRunner();
  await reclaimRecordedMount(sudo, { runProgram: first.runProgram });
  t.deepEqual(first.calls, [
    ['sudo', 'umount', '--', sudo.workspaceMountPoint],
  ]);

  const helper = await makeRecorded(t, {
    mounterEnv: { NINEP_UMOUNT_PROGRAM: '/run/wrappers/bin/sudo -u endo umount' },
  });
  const second = makeRunner();
  await reclaimRecordedMount(helper, { runProgram: second.runProgram });
  t.deepEqual(second.calls, [
    [
      '/run/wrappers/bin/sudo',
      '-u',
      'endo',
      'umount',
      '--',
      helper.workspaceMountPoint,
    ],
  ]);
});

test('a recorded program that does not invoke umount is refused', async t => {
  // The mounter's own footgun guard, reached through the recorded settings:
  // this helper runs a privileged program against a recorded path.
  const recorded = await makeRecorded(t, {
    mounterEnv: { NINEP_UMOUNT_PROGRAM: 'rm' },
  });
  const runner = makeRunner();
  await t.throwsAsync(
    reclaimRecordedMount(recorded, { runProgram: runner.runProgram }),
    { message: /must invoke "umount"/ },
  );
  t.deepEqual(runner.calls, []);
});

test('an incomplete record is refused rather than guessed at', async t => {
  await t.throwsAsync(
    reclaimRecordedMount(
      // @ts-expect-error deliberately incomplete
      harden({ mounterSocketDir: '/private/a/9p' }),
      {},
    ),
    { message: /mount point is required/ },
  );
  await t.throwsAsync(
    reclaimRecordedMount(
      // @ts-expect-error deliberately incomplete
      harden({ workspaceMountPoint: '/private/a/workspace' }),
      {},
    ),
    { message: /socket directory is required/ },
  );
});
