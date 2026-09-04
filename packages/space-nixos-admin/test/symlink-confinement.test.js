// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { make } from '../caplet.js';

/**
 * A checkout holding a tracked symlink that points out of it. Git can carry
 * such a link, and the caplet cannot create one, so it is the pre-existing
 * hazard `assertNoSymlinkTraversal` exists to neutralize.
 *
 * @param {import('ava').ExecutionContext} t
 */
const makeCheckoutWithEscapeLink = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nixos-symlink-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const outside = join(dir, 'outside');
  const lockDir = join(dir, 'locks');
  await Promise.all([mkdir(configDir), mkdir(outside), mkdir(lockDir)]);
  await writeFile(join(outside, 'secret'), 'do not delete', 'utf8');
  await symlink(outside, join(configDir, 'escape'));

  const admin = await make(undefined, undefined, {
    env: {
      ENDO_NIXOS_CONFIG_DIR: configDir,
      ENDO_NIXOS_DIR: join(dir, 'spool'),
      ENDO_NIXOS_LOCK_DIR: lockDir,
      ENDO_NIXOS_POLL_MS: '10',
      ENDO_NIXOS_WATCH_LIMIT_MS: '2000',
    },
    systemPaths:
      process.platform === 'linux'
        ? { flock: '/usr/bin/flock', shell: '/bin/sh' }
        : {},
  });
  return { admin, configDir, outside };
};

test('revertFiles cannot delete through a symlinked parent', async t => {
  // `resolveWithin` is only LEXICAL: `escape/secret` stays inside the checkout
  // as a string. The removal paths used to resolve captured entries with it
  // alone, on the reasoning that a `text: null` entry names a file that should
  // not exist — but `rm` resolves every component except the last, so the link
  // redirected the unlink outside the checkout. `revertFiles` takes its
  // argument straight from the caller, so this needed no prior stage.
  const { admin, outside } = await makeCheckoutWithEscapeLink(t);

  await t.throwsAsync(
    () => admin.revertFiles([{ path: 'escape/secret', text: null }]),
    { message: /Refusing to follow config symlink/ },
  );
  await t.notThrowsAsync(
    () => access(join(outside, 'secret')),
    'the file outside the checkout survived',
  );
});

test('revertFiles cannot write through a symlinked parent', async t => {
  const { admin, outside } = await makeCheckoutWithEscapeLink(t);

  await t.throwsAsync(
    () => admin.revertFiles([{ path: 'escape/planted', text: 'x' }]),
    { message: /Refusing to follow config symlink/ },
  );
  await t.throwsAsync(
    () => access(join(outside, 'planted')),
    { code: 'ENOENT' },
    'nothing was planted outside the checkout',
  );
});

test('stageFiles cannot capture or write through a symlinked parent', async t => {
  const { admin, outside } = await makeCheckoutWithEscapeLink(t);

  await t.throwsAsync(
    () => admin.stageFiles([{ path: 'escape/secret', text: 'x' }]),
    { message: /Refusing to follow config symlink/ },
  );
  const contents = await import('node:fs/promises').then(fs =>
    fs.readFile(join(outside, 'secret'), 'utf8'),
  );
  t.is(contents, 'do not delete', 'the file outside the checkout is untouched');
});

test('a non-directory parent still reads as an absent target, not an error', async t => {
  // The removal paths must keep tolerating a captured entry whose parent is a
  // regular file: that proves the target is already gone. Confining removal
  // through `assertNoSymlinkTraversal` would have broken this if the walk
  // treated ENOTDIR as a hard failure instead of as "nothing resolves below".
  const dir = await mkdtemp(join(tmpdir(), 'nixos-notdir-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const lockDir = join(dir, 'locks');
  await Promise.all([mkdir(configDir), mkdir(lockDir)]);
  await writeFile(join(configDir, 'plain'), 'a regular file\n', 'utf8');

  const admin = await make(undefined, undefined, {
    env: {
      ENDO_NIXOS_CONFIG_DIR: configDir,
      ENDO_NIXOS_DIR: join(dir, 'spool'),
      ENDO_NIXOS_LOCK_DIR: lockDir,
      ENDO_NIXOS_POLL_MS: '10',
      ENDO_NIXOS_WATCH_LIMIT_MS: '2000',
    },
    systemPaths:
      process.platform === 'linux'
        ? { flock: '/usr/bin/flock', shell: '/bin/sh' }
        : {},
  });

  const result = await admin.revertFiles([{ path: 'plain/below', text: null }]);
  t.deepEqual(result.paths, ['plain/below']);
});

test('a stray symlink in the checkout is removable, and only the link goes', async t => {
  // `fingerprintConfig` refuses to fingerprint a checkout containing a
  // symlink, so one stray `result` link from a manual `nix build` — or a link
  // carried by the config repo — blocks every `build` and `apply`. Refusing
  // the FINAL component on removal too left no in-band way out: the capability
  // was bricked until someone fixed it as root, outside Endo. `rm` deletes a
  // final-component link rather than following it, whether it points at a file
  // or a directory, so allowing exactly that is safe and restores the hatch.
  const { admin, configDir, outside } = await makeCheckoutWithEscapeLink(t);

  const result = await admin.revertFiles([{ path: 'escape', text: null }]);
  t.deepEqual(result.paths, ['escape']);
  await t.throwsAsync(
    () => access(join(configDir, 'escape')),
    { code: 'ENOENT' },
    'the link itself is gone',
  );
  await t.notThrowsAsync(
    () => access(outside),
    'the directory it pointed at survives',
  );
  await t.notThrowsAsync(
    () => access(join(outside, 'secret')),
    'and so does everything under it',
  );
});

test('relaxing the final component does not relax the parents', async t => {
  // The hatch is exactly one component wide. A link used as a PARENT is still
  // refused on removal, which is the confinement property the sibling tests
  // above pin down.
  const { admin, outside } = await makeCheckoutWithEscapeLink(t);

  await t.throwsAsync(
    () => admin.revertFiles([{ path: 'escape/secret', text: null }]),
    { message: /Refusing to follow config symlink/ },
  );
  await t.notThrowsAsync(() => access(join(outside, 'secret')));
});
