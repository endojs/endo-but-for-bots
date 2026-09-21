// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  containsPath,
  isNormalizedAbsolutePath,
  makeSandboxSessionId,
  readMounterEnv,
  readRecordedPath,
} from '../src/session-plan.js';

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
