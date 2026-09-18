// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  observeNativePodmanMounts,
  validateNativePodmanMounts,
} from '../src/native-podman-mounts.js';

/** @import { NativePodmanMount } from '../src/native-podman-mounts.js' */

/** @type {readonly NativePodmanMount[]} */
const declarations = harden([
  { innerPath: '/workspace', mode: 'rw', kind: 'bind' },
  { innerPath: '/state', mode: 'rw', kind: 'bind' },
  { innerPath: '/mcp', mode: 'ro', kind: 'bind' },
  { innerPath: '/etc/resolv.conf', mode: 'ro', kind: 'generated' },
]);

/**
 * @param {string} path
 * @param {string} options
 * @param {string} [fstype]
 */
const mount = (path, options, fstype = 'ext4') =>
  `34 25 0:30 / ${path} ${options} - ${fstype} source rw\n`;

const mountinfo =
  mount('/', 'ro,relatime', 'overlay') +
  mount('/workspace', 'rw,nodev') +
  mount('/state', 'rw,nodev') +
  mount('/mcp', 'ro,nodev') +
  mount('/etc/resolv.conf', 'ro,nodev') +
  mount('/sys/fs/cgroup', 'ro,nodev', 'cgroup2');

/** @param {string} text */
const observe = text =>
  observeNativePodmanMounts(
    harden({
      /** @param {string} path */
      readFile: async path => {
        await null;
        if (path !== '/proc/77/mountinfo') throw Error('unexpected read');
        return text;
      },
      readLink: async () => {
        throw Error('unexpected link read');
      },
      readInode: async () => {
        throw Error('unexpected inode read');
      },
    }),
    77,
    declarations,
  );

test('ordinary data mounts and literal resolver declaration are accepted', t => {
  t.is(validateNativePodmanMounts(declarations), declarations);
  t.notThrows(() =>
    validateNativePodmanMounts([
      { innerPath: '/custom-data/config', mode: 'ro', kind: 'generated' },
      { innerPath: '/etcetera', mode: 'rw', kind: 'bind' },
      { innerPath: '/usr-data', mode: 'ro', kind: 'bind' },
    ]),
  );
});

test('declared mounts cannot shadow system paths or gate executable closure', t => {
  for (const root of [
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/usr',
    '/etc',
    '/proc',
    '/sys',
    '/dev',
  ]) {
    for (const innerPath of [root, `${root}/child`, `${root}/child/nested`]) {
      for (const mode of /** @type {const} */ (['ro', 'rw'])) {
        t.throws(
          () => validateNativePodmanMounts([{ innerPath, mode, kind: 'bind' }]),
          {
            message: /protected image or kernel path/,
          },
        );
      }
    }
  }
});

test('only generated read-only resolver gets the protected-path exception', t => {
  t.throws(
    () =>
      validateNativePodmanMounts([
        { innerPath: '/etc/resolv.conf', mode: 'ro', kind: 'bind' },
      ]),
    { message: /protected image/ },
  );
  t.throws(
    () =>
      validateNativePodmanMounts([
        { innerPath: '/etc/resolv.conf', mode: 'rw', kind: 'generated' },
      ]),
    { message: /must be read-only/ },
  );
  t.throws(
    () =>
      validateNativePodmanMounts([
        { innerPath: '/etc/resolv.conf/child', mode: 'ro', kind: 'generated' },
      ]),
    { message: /protected image/ },
  );
  t.throws(
    () =>
      validateNativePodmanMounts([
        { innerPath: '/etc/ld.so.preload', mode: 'ro', kind: 'generated' },
      ]),
    { message: /protected image/ },
  );
});

test('noncanonical paths cannot evade target protections', t => {
  for (const innerPath of [
    '/',
    '',
    'workspace',
    '/workspace/',
    '/workspace//data',
    '/workspace/../usr',
    '/workspace/./data',
    '/work\0space',
  ]) {
    t.throws(
      () =>
        validateNativePodmanMounts([{ innerPath, mode: 'rw', kind: 'bind' }]),
      {
        message: /canonical, absolute, and non-root/,
      },
    );
  }
});

test('declared overlaps refuse in either ordering, including literal files', t => {
  for (const innerPath of ['/workspace', '/workspace/child']) {
    /** @type {NativePodmanMount} */
    const child = { innerPath, mode: 'ro', kind: 'generated' };
    t.throws(() => validateNativePodmanMounts([declarations[0], child]), {
      message: /overlap/,
    });
    t.throws(() => validateNativePodmanMounts([child, declarations[0]]), {
      message: /overlap/,
    });
  }
});

test('actual declared mount flags and readonly cgroup2 are accepted', async t => {
  await t.notThrowsAsync(() => observe(mountinfo));
});

test('symlink-resolved mount location refuses instead of attesting declared alias', async t => {
  // The pinned image contract must prevent this before the startup gate runs.
  // This observation rejects the resulting mismatch, not the earlier execution.
  const aliased = mountinfo.replace('/ /workspace rw,nodev', '/ /usr rw,nodev');
  await t.throwsAsync(() => observe(aliased), {
    message: /declared mount is missing/,
  });
});

test('missing declared mount refuses', async t => {
  await t.throwsAsync(
    () => observe(mountinfo.replace(mount('/state', 'rw,nodev'), '')),
    {
      message: /declared mount is missing/,
    },
  );
});

test('wrong mount mode refuses', async t => {
  await Promise.all([
    t.throwsAsync(
      () => observe(mountinfo.replace('/mcp ro,nodev', '/mcp rw,nodev')),
      { message: /mount mode differs/ },
    ),
    t.throwsAsync(
      () =>
        observe(
          mountinfo.replace('/workspace rw,nodev', '/workspace ro,nodev'),
        ),
      { message: /mount mode differs/ },
    ),
  ]);
});

test('declared mount must suppress devices', async t => {
  await t.throwsAsync(
    () => observe(mountinfo.replace('/workspace rw,nodev', '/workspace rw')),
    {
      message: /permits devices/,
    },
  );
});

test('readonly parent cannot conceal a writable submount', async t => {
  await t.throwsAsync(
    () => observe(mountinfo + mount('/mcp/nested', 'rw,nodev')),
    {
      message: /writable submount/,
    },
  );
});

test('submounts also suppress devices, even under writable parents', async t => {
  await t.throwsAsync(
    () => observe(mountinfo + mount('/workspace/nested', 'rw')),
    {
      message: /permits devices/,
    },
  );
});

test('readonly submounts of writable data roots are allowed', async t => {
  await t.notThrowsAsync(() =>
    observe(mountinfo + mount('/workspace/nested', 'ro,nodev')),
  );
});

for (const fstype of ['cgroup', 'cgroup2']) {
  test(`writable ${fstype} is refused outside declared data mounts too`, async t => {
    await t.throwsAsync(
      () => observe(mountinfo + mount('/unexpected', 'rw,nodev', fstype)),
      {
        message: /writable or unproved cgroup mount/,
      },
    );
  });
}

test('unreadable or malformed mount table never attests', async t => {
  await t.throwsAsync(() => observe('unrecognized mountinfo\n'));
});
