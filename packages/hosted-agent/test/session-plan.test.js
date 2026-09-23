// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  containsPath,
  isNormalizedAbsolutePath,
  makeSandboxSessionId,
  readMounterEnv,
  readPinnedRootfs,
  readRecordedPath,
  readSessionPlacement,
} from '../src/session-plan.js';

const digest = `sha256:${'a'.repeat(64)}`;
const plan = harden({
  sessionId: 'session-a',
  sandboxSessionId: makeSandboxSessionId('session-a'),
  rootfs: `oci:example@${digest}`,
  networkPolicy: 'off',
  workspaceDir: '/workspaces/a',
  workspaceMountPoint: '/private/a/workspace',
  mounterSocketDir: '/private/a/9p',
});

test('the pinned image is the one shared image field, in the spelling the runtime admits', t => {
  t.deepEqual(readPinnedRootfs(`oci:example@${digest}`, 'Test'), {
    rootfs: `oci:example@${digest}`,
    imageRef: `example@${digest}`,
    imageDigest: digest,
  });
  t.deepEqual(readPinnedRootfs(`oci:localhost:5000/a/b@${digest}`), {
    rootfs: `oci:localhost:5000/a/b@${digest}`,
    imageRef: `localhost:5000/a/b@${digest}`,
    imageDigest: digest,
  });
  /** @type {[unknown, RegExp][]} */
  const refused = [
    [undefined, /Missing session plan field "rootfs"/],
    ['', /must be an "oci:<image>@<digest>" reference/],
    [`example@${digest}`, /must be an "oci:<image>@<digest>" reference/],
    ['oci:', /must be an "oci:<image>@<digest>" reference/],
    ['oci:host-bind', /pinned to a digest/],
    ['oci:example:latest', /pinned to a digest/],
    ['oci:example@sha256:abc', /pinned to a digest/],
    [`oci:example:tag@${digest}`, /native runtime will accept/],
    [7, /must be an "oci:<image>@<digest>" reference/],
  ];
  for (const [value, message] of refused) {
    t.throws(() => readPinnedRootfs(value, 'Test'), { message });
  }
});

test('the shared placement reads the pinned image and refuses any field no reader knows', t => {
  const { placement, recorded } = readSessionPlacement(JSON.stringify(plan), {
    label: 'Test',
  });
  t.is(placement.rootfs, plan.rootfs);
  t.is(recorded.rootfs, plan.rootfs);
  // An adapter's own fields and private paths are known by declaration.
  const own = readSessionPlacement(
    JSON.stringify({ ...plan, mcpDir: '/private/a/mcp', kind: 'x' }),
    { label: 'Test', privatePaths: ['mcpDir'], fields: ['kind'] },
  );
  t.is(own.placement.mcpDir, '/private/a/mcp');
  t.is(own.recorded.kind, 'x');
  for (const [name, text] of [
    ['nativeProfile', JSON.stringify({ ...plan, nativeProfile: {} })],
    ['imageRef', JSON.stringify({ ...plan, imageRef: 'x' })],
    ['mcpDir', JSON.stringify({ ...plan, mcpDir: '/private/a/mcp' })],
    ['kind', JSON.stringify({ ...plan, kind: 'x' })],
  ]) {
    t.throws(() => readSessionPlacement(text, { label: 'Test' }), {
      message: new RegExp(`Unknown session plan field "${name}"; recreate`),
    });
  }
  const { rootfs: _, ...unpinned } = plan;
  t.throws(
    () => readSessionPlacement(JSON.stringify(unpinned), { label: 'Test' }),
    { message: /Missing session plan field "rootfs"/ },
  );
});

test('recorded paths are normalized, absolute, non-root, and NUL-free', t => {
  for (const good of ['/a', '/a/b', '/private/var/x']) {
    t.true(isNormalizedAbsolutePath(good));
    t.is(readRecordedPath('name', good), good);
  }
  for (const bad of ['', '/', 'relative', '/a/', '/a/../b', '/a\0b', 7]) {
    t.false(isNormalizedAbsolutePath(bad));
    t.throws(() => readRecordedPath('name', bad), {
      message: /requires a recorded absolute path for "name"/,
    });
  }
  t.true(containsPath('/a', '/a'));
  t.true(containsPath('/a', '/a/b'));
  t.false(containsPath('/a', '/ab'));
  t.false(containsPath('/a/b', '/a'));
});

test('mounter settings admit only the three named keys and the mount caplet’s own program check', t => {
  const settings = { NINEP_SUDO: '1', NINEP_MOUNT_PROGRAM: 'sudo -n mount' };
  t.deepEqual(readMounterEnv(settings), settings);
  t.deepEqual(readMounterEnv({}), {});
  /** @type {[unknown, RegExp][]} */
  const refused = [
    [{ NINEP_SOCKET_DIR: '/x' }, /Unknown mounter setting "NINEP_SOCKET_DIR"/],
    [{ XDG_RUNTIME_DIR: '/x' }, /Unknown mounter setting "XDG_RUNTIME_DIR"/],
    [{ NINEP_SUDO: '0' }, /"NINEP_SUDO" must be "1"/],
    [{ NINEP_MOUNT_PROGRAM: '' }, /must be non-empty text/],
    [
      { NINEP_UMOUNT_PROGRAM: 'rm -rf' },
      /"NINEP_UMOUNT_PROGRAM" must invoke "umount"/,
    ],
    [['mount'], /must be a record/],
    [null, /must be a record/],
  ];
  for (const [value, message] of refused) {
    t.throws(() => readMounterEnv(value), { message });
  }
});

test('the sandbox session id is a bounded slug plus a stable digest, with the adapter’s fallback', t => {
  const id = makeSandboxSessionId('Session A');
  t.regex(id, /^session-a-[0-9a-f]{12}$/);
  t.is(id, makeSandboxSessionId('Session A'));
  t.not(id, makeSandboxSessionId('Session B'));
  t.regex(makeSandboxSessionId('***'), /^session-[0-9a-f]{12}$/);
  t.regex(makeSandboxSessionId('***', 'opencode'), /^opencode-[0-9a-f]{12}$/);
  t.is(makeSandboxSessionId('x'.repeat(100)).length, 64 + 1 + 12);
});
