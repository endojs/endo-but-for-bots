// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeXfsVolumeQuotaObserver } from '../src/xfs-volume-quota.js';

const mountpoint = '/srv/storage/volumes/workspace/_data';
const attributes =
  'stat.ino = 42\nfsxattr.xflags = 0x80000200 [--------P-------X]\nfsxattr.projid = 1176\n';
const state =
  'Project quota state on /srv/storage (/dev/vdb)\n  Accounting: ON\n  Enforcement: ON\n';
const quota = '/dev/vdb 65536 0 65536 00 [--------] /srv/storage\n';

/** @param {Record<string, any>} [overrides] */
const fixture = (overrides = {}) => {
  const calls = [];
  let observations = 0;
  const observer = makeXfsVolumeQuotaObserver({
    volumeRoot: '/srv/storage/volumes',
    filesystem: '/srv/storage',
    realpath: async path => path,
    stat: async () => ({ dev: 12n, ino: 42n, isDirectory: () => true }),
    run: async (executable, argv) => {
      calls.push({ executable, argv });
      if (executable.endsWith('xfs_io')) {
        observations += 1;
        return observations > 1 && overrides.laterAttributes
          ? overrides.laterAttributes
          : (overrides.attributes ?? attributes);
      }
      return argv[2] === 'state -p'
        ? (overrides.state ?? state)
        : (overrides.quota ?? quota);
    },
    ...overrides,
  });
  return { observer, calls };
};

test('XFS observer binds project hard limit to stable volume identity', async t => {
  const { observer, calls } = fixture();
  const evidence = await observer.observe({ name: 'workspace', mountpoint });
  t.deepEqual(evidence, {
    version: 'VolumeQuotaEvidenceV1',
    name: 'workspace',
    mountpoint,
    device: '12',
    inode: '42',
    projectId: 1176,
    hardBytes: 64n * 1024n * 1024n,
    enforced: true,
    projectInherited: true,
  });
  t.deepEqual(calls[2], {
    executable: '/usr/sbin/xfs_quota',
    argv: ['-x', '-c', 'quota -p -N -n -b -v 1176', '/srv/storage'],
  });
});

for (const [label, overrides] of Object.entries({
  'unlimited project': { quota: '/dev/vdb 0 0 0 00 [--------] /srv/storage\n' },
  'disabled enforcement': {
    state: state.replace('Enforcement: ON', 'Enforcement: OFF'),
  },
  'wrong filesystem': { quota: quota.replace('/srv/storage', '/other') },
  'missing project inheritance': {
    attributes: attributes.replace('0x80000200', '0x80000000'),
  },
  'changed project': { laterAttributes: attributes.replace('1176', '1177') },
  'symbolic link': { realpath: async () => '/elsewhere' },
  'wrong inode': { attributes: attributes.replace('ino = 42', 'ino = 43') },
  'unreadable limit': { quota: '' },
})) {
  test(`XFS observer refuses ${label}`, async t => {
    const { observer } = fixture(overrides);
    await t.throwsAsync(
      () => observer.observe({ name: 'workspace', mountpoint }),
      { message: /XFS|Quota/ },
    );
  });
}

test('XFS observer refuses traversal before invoking host commands', async t => {
  const { observer, calls } = fixture();
  await t.throwsAsync(
    () => observer.observe({ name: '../workspace', mountpoint }),
    { message: /Invalid quota volume name/ },
  );
  t.is(calls.length, 0);
});

test('XFS observer accepts an enforced quota before its first write', async t => {
  const { observer } = fixture({
    quota: '/dev/vdb 0 0 65536 00 [--------] /srv/storage\n',
  });
  const evidence = await observer.observe({ name: 'workspace', mountpoint });
  t.is(evidence.hardBytes, 64n * 1024n * 1024n);
});
