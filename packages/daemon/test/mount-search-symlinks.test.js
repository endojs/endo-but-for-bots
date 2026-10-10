// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { E } from '@endo/eventual-send';

import { makeFilePowers } from '../src/manager-node-powers.js';
import { makeMount } from '../src/mount.js';

const filePowers = makeFilePowers({ fs, path });

/**
 * A tree with a directory symlink pointing back into it — the shape a
 * workspace checkout has, where every `node_modules/@endo/*` entry links to a
 * sibling package. Returns `undefined` when the platform will not create the
 * link, matching `_mount-fixture.js`'s treatment of its escaping symlink: the
 * behavior under test is simply unobservable there.
 *
 * @param {import('ava').ExecutionContext<unknown>} t
 * @returns {string | undefined} mount root
 */
const buildLinkedTree = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-link-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'pkg', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'src', 'a.js'), 'needle here\n');
  fs.mkdirSync(path.join(root, 'target'));
  fs.writeFileSync(path.join(root, 'target', 'b.js'), 'needle there\n');
  try {
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'pkg', 'link'));
  } catch {
    return undefined;
  }
  return root;
};

const mountOver = root =>
  makeMount({ rootPath: root, readOnly: false, filePowers });

// The platform engine is where the rule lives, but the daemon is where callers
// meet it, and the mount face composes glob and grep itself. Pinning the rule
// here is what keeps "handled by composition" true: a native fused `glorp` —
// which mount.js explicitly anticipates — would satisfy the platform suite
// untouched while reintroducing link-graph traversal at this seam.
test('glob `**` reports a directory symlink without descending through it', async t => {
  const root = buildLinkedTree(t);
  if (root === undefined) {
    t.pass('platform cannot create symlinks; rule unobservable');
    return;
  }
  const mount = mountOver(root);

  t.deepEqual(
    [...(await E(mount).glob('pkg/**/*.js'))],
    ['pkg/src/a.js'],
    'the walk does not cross the link',
  );
  t.true(
    [...(await E(mount).glob('pkg/**'))].includes('pkg/link'),
    'the link is still an entry, so nothing vanishes from a listing',
  );
  // A segment that names a path is bounded by the pattern's own depth, so it
  // follows the link — this is the workaround that survives the default.
  t.deepEqual([...(await E(mount).glob('pkg/link/*.js'))], ['pkg/link/b.js']);
});

test('glob followSymlinks reaches the daemon and restores the sweep', async t => {
  const root = buildLinkedTree(t);
  if (root === undefined) {
    t.pass('platform cannot create symlinks; rule unobservable');
    return;
  }
  const mount = mountOver(root);

  // Passing the option must survive the exo guard, not just the engine.
  t.deepEqual(
    [...(await E(mount).glob('pkg/**/*.js', { followSymlinks: true }))],
    ['pkg/link/b.js', 'pkg/src/a.js'],
  );
  t.deepEqual(
    [...(await E(mount).glob('pkg/**/*.js', { followSymlinks: false }))],
    ['pkg/src/a.js'],
    'explicit false is the default, not a no-op that enables the sweep',
  );
});

test('grep with paths omitted inherits the rule, and honors followSymlinks', async t => {
  const root = buildLinkedTree(t);
  if (root === undefined) {
    t.pass('platform cannot create symlinks; rule unobservable');
    return;
  }
  const mount = mountOver(root);

  t.deepEqual(
    (await E(mount).grep('needle')).map(m => m.file).sort(),
    ['pkg/src/a.js', 'target/b.js'],
    'both files reached as tree entries; neither reached twice via the link',
  );
  t.deepEqual(
    (await E(mount).grep('needle', undefined, { followSymlinks: true }))
      .map(m => m.file)
      .sort(),
    ['pkg/link/b.js', 'pkg/src/a.js', 'target/b.js'],
  );
});

test('glorp inherits the rule through its glob half', async t => {
  const root = buildLinkedTree(t);
  if (root === undefined) {
    t.pass('platform cannot create symlinks; rule unobservable');
    return;
  }
  const mount = mountOver(root);

  t.deepEqual(
    (await E(mount).glorp('pkg/**/*.js', 'needle')).map(m => m.file),
    ['pkg/src/a.js'],
  );
  t.deepEqual(
    (
      await E(mount).glorp('pkg/**/*.js', 'needle', { followSymlinks: true })
    ).map(m => m.file),
    ['pkg/link/b.js', 'pkg/src/a.js'],
  );
  // The fused call must keep agreeing with the composition it stands in for,
  // under the option as well as without it.
  const composed = await E(mount).grep(
    'needle',
    await E(mount).glob('pkg/**/*.js', { followSymlinks: true }),
  );
  t.deepEqual(
    (
      await E(mount).glorp('pkg/**/*.js', 'needle', { followSymlinks: true })
    ).map(m => m.file),
    composed.map(m => m.file),
  );
});

test('a non-boolean followSymlinks is rejected at the exo boundary', async t => {
  const root = buildLinkedTree(t);
  if (root === undefined) {
    t.pass('platform cannot create symlinks; rule unobservable');
    return;
  }
  const mount = mountOver(root);
  await t.throwsAsync(
    // @ts-expect-error deliberate guard violation
    () => E(mount).glob('pkg/**', { followSymlinks: 'yes' }),
    { message: /followSymlinks/ },
  );
});
