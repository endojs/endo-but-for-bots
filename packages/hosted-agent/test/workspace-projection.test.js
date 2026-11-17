// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeWorkspaceProjection } from '../src/workspace-projection.js';

const plan = harden({
  workspaceRootPath: '/srv/worktrees/session-1',
  workspaceMountPoint: '/run/codex/session-1/workspace',
  mounterSocketDir: '/run/codex/session-1/9p',
  mounterEnv: harden({
    MOUNT_PROGRAM: 'sudo mount',
    NINEP_SOCKET_DIR: '/recorded/should/not/win',
  }),
});

const makeHarness = () => {
  const events = [];
  let closed = 0;
  const powers = harden({
    env: harden({ MOUNT_PROGRAM: '/bin/mount', UMOUNT_PROGRAM: '/bin/umount' }),
    makeMounter: env => {
      events.push(['mounter', env]);
      return harden({
        mounter: Far('Mounter', {
          mount: async (filesystem, destination, options) => {
            events.push(['mount', filesystem, destination, options]);
            return Far('Mount', {});
          },
        }),
        close: async () => {
          closed += 1;
        },
      });
    },
    makeFilesystem: rootPath => {
      events.push(['filesystem', rootPath]);
      return Far('Filesystem', {});
    },
  });
  return { events, powers, closedCount: () => closed };
};

test('the mount settings are composed in one order, and nothing else decides them', async t => {
  const { events, powers } = makeHarness();
  const projection = makeWorkspaceProjection(plan, powers);
  // Construction performs no I/O: the kit exists, the tree is not read and
  // the kernel mount is not established until `mount()`.
  t.deepEqual(
    events.map(event => event[0]),
    ['mounter'],
  );
  t.deepEqual(events[0][1], {
    // The operator's trusted configuration …
    MOUNT_PROGRAM: 'sudo mount',
    UMOUNT_PROGRAM: '/bin/umount',
    // … under the plan's recorded overrides (MOUNT_PROGRAM above) …
    // … under this session's own socket directory, which a recorded
    // setting may not choose.
    XDG_RUNTIME_DIR: plan.mounterSocketDir,
    NINEP_SOCKET_DIR: plan.mounterSocketDir,
  });
  t.is(projection.mountPoint, plan.workspaceMountPoint);

  await projection.mount();
  t.deepEqual(
    events.map(event => event[0]),
    ['mounter', 'filesystem', 'mount'],
  );
  t.is(events[1][1], plan.workspaceRootPath);
  const [, , destination, options] = events[2];
  t.is(destination, plan.workspaceMountPoint);
  // The promise `reclaimRecordedMount` relies on when it removes the mount
  // point on a lost worker's behalf.
  t.deepEqual(options, { removeMountPointOnUnmount: true });
});

test('a projection is closable whether or not it was ever mounted', async t => {
  const { powers, closedCount } = makeHarness();
  const projection = makeWorkspaceProjection(plan, powers);
  await projection.close();
  t.is(closedCount(), 1);
});

test('a projection needs a tree, a mount point, and a private socket directory', t => {
  const { powers } = makeHarness();
  /** @type {[string, object, RegExp][]} */
  const rejected = [
    [
      'no tree',
      { ...plan, workspaceRootPath: '' },
      /workspace root path is required/,
    ],
    [
      'no mount point',
      { ...plan, workspaceMountPoint: undefined },
      /workspace mount point is required/,
    ],
    [
      'no socket directory',
      { ...plan, mounterSocketDir: undefined },
      /socket directory is required/,
    ],
  ];
  for (const [label, broken, message] of rejected) {
    t.throws(
      () => makeWorkspaceProjection(/** @type {any} */ (broken), powers),
      { message },
      label,
    );
  }
});
