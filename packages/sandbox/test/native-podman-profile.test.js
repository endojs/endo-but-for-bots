// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertNativePodmanProfile,
  nativePodmanProfileArgs,
  observeNativePodmanProfile,
} from '../src/native-podman-profile.js';

const profile = harden({
  uid: 1000,
  gid: 1001,
  memoryBytes: 536_870_912n,
  pids: 128,
  cpuQuotaMicros: 200_000n,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 3,
});

const cgroup =
  '/user.slice/user-1000.slice/user@1000.service/libpod-operation.scope';
const directory = `/sys/fs/cgroup${cgroup}`;

// procfs/cgroupfs-shaped fixtures, not native Podman acceptance evidence.
const makeFixture = () => {
  /** @type {Record<string, string>} */
  const files = {
    '/proc/77/status': `Name:\tstartup-gate
Uid:\t1000\t1000\t1000\t1000
Gid:\t1000\t1000\t1000\t1000
CapEff:\t0000000000000000
CapPrm:\t0000000000000000
CapBnd:\t0000000000000000
NoNewPrivs:\t1
Seccomp:\t2
`,
    '/proc/77/uid_map':
      '         0     100000       1000\n      1000       1000          1\n      1001     101000      64536\n',
    '/proc/77/gid_map':
      '         0     100000       1001\n      1001       1000          1\n      1002     101001      64535\n',
    '/proc/77/mountinfo':
      '811 701 0:90 / / ro,relatime - overlay overlay rw,lowerdir=/image\n',
    '/proc/self/mountinfo':
      '34 25 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate\n',
    '/proc/77/cgroup': `0::${cgroup}\n`,
    [`${directory}/memory.max`]: '536870912\n',
    [`${directory}/memory.swap.max`]: '0\n',
    [`${directory}/pids.max`]: '128\n',
    [`${directory}/cpu.max`]: '200000 100000\n',
  };
  /** @type {Record<string, string>} */
  const links = {};
  for (const ns of ['user', 'pid', 'ipc', 'mnt']) {
    links[`/proc/self/ns/${ns}`] = `${ns}:[4026531837]`;
    links[`/proc/77/ns/${ns}`] = `${ns}:[4026532999]`;
  }
  /** @type {string[]} */
  const reads = [];
  const proc = harden({
    /** @param {string} path */
    readFile: async path => {
      await null;
      reads.push(path);
      if (!(path in files)) throw Error(`missing fixture ${path}`);
      return files[path];
    },
    /** @param {string} path */
    readLink: async path => {
      await null;
      if (!(path in links)) throw Error(`missing fixture ${path}`);
      return links[path];
    },
    readInode: async () => {
      throw Error('unexpected inode read');
    },
  });
  const observe = () =>
    observeNativePodmanProfile({
      proc,
      pid: 77,
      profile,
      hostUid: 1000,
      hostGid: 1000,
    });
  return { files, links, reads, proc, observe };
};

test('profile requires explicit operator quantities and permits guest root', t => {
  t.is(assertNativePodmanProfile(profile), profile);
  t.is(assertNativePodmanProfile({ ...profile, uid: 0, gid: 0 }).uid, 0);
  const { memoryBytes, ...missing } = profile;
  t.is(memoryBytes, 536_870_912n);
  t.throws(() => assertNativePodmanProfile(missing));
  t.throws(() => assertNativePodmanProfile({ ...profile, nofile: 100 }));
  for (const value of [0, -1, 1.5, 2 ** 32, Infinity, NaN]) {
    t.throws(() => assertNativePodmanProfile({ ...profile, pids: value }));
    t.throws(() =>
      assertNativePodmanProfile({ ...profile, maxConcurrentOperations: value }),
    );
  }
  for (const value of [0n, -1n, 2n ** 63n, 123]) {
    t.throws(() =>
      assertNativePodmanProfile({ ...profile, memoryBytes: value }),
    );
  }
  t.throws(() => assertNativePodmanProfile({ ...profile, uid: 0xffff_ffff }));
  t.throws(() =>
    assertNativePodmanProfile({ ...profile, cpuQuotaMicros: 999n }),
  );
  t.throws(() =>
    assertNativePodmanProfile({ ...profile, cpuPeriodMicros: 999 }),
  );
  t.throws(() =>
    assertNativePodmanProfile({ ...profile, cpuPeriodMicros: 1_000_001 }),
  );
});

test('argv uses exact integer controls without adding other budgets or networking', t => {
  t.deepEqual(nativePodmanProfileArgs(profile), [
    '--userns=keep-id:uid=1000,gid=1001',
    '--user=1000:1001',
    '--pid=private',
    '--ipc=private',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    '--read-only',
    '--memory=536870912',
    '--memory-swap=536870912',
    '--pids-limit=128',
    '--cpu-period=100000',
    '--cpu-quota=200000',
  ]);
  t.true(
    nativePodmanProfileArgs({
      ...profile,
      memoryBytes: 9_007_199_254_740_993n,
    }).includes('--memory=9007199254740993'),
  );
});

test('observer reads actual gate cgroup and mapped host identity', async t => {
  const { observe, reads } = makeFixture();
  const evidence = await observe();
  t.is(evidence.cgroupPath, cgroup);
  t.like(evidence.status, { uid: 1000, gid: 1001, noNewPrivs: true });
  t.deepEqual(evidence.namespaces.pid, {
    id: 'pid-4026532999',
    unshared: true,
  });
  for (const name of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) {
    t.true(reads.includes(`${directory}/${name}`));
  }
});

for (const ns of ['user', 'pid', 'ipc', 'mnt']) {
  test(`observer refuses shared ${ns} namespace`, async t => {
    const { observe, links } = makeFixture();
    links[`/proc/77/ns/${ns}`] = links[`/proc/self/ns/${ns}`];
    await t.throwsAsync(observe, { message: /namespace is not private/ });
  });
}

for (const [field, replacement] of [
  ['NoNewPrivs', '0'],
  ['Seccomp', '0'],
  ['CapEff', '0000000000000001'],
  ['CapPrm', '0000000000000001'],
  ['CapBnd', '0000000000000001'],
]) {
  test(`observer refuses ineffective privilege control ${field}`, async t => {
    const { observe, files } = makeFixture();
    files['/proc/77/status'] = files['/proc/77/status'].replace(
      new RegExp(`${field}:\\t[^\\n]+`),
      `${field}:\t${replacement}`,
    );
    await t.throwsAsync(observe, { message: /privilege restrictions/ });
  });
}

test('correct guest UID with wrong host mapping refuses', async t => {
  const { observe, files } = makeFixture();
  files['/proc/77/uid_map'] = '1000 1234 1\n';
  files['/proc/77/status'] = files['/proc/77/status'].replace(
    'Uid:\t1000\t1000\t1000\t1000',
    'Uid:\t1234\t1234\t1234\t1234',
  );
  await t.throwsAsync(observe, { message: /configured host identity/ });
});

test('malformed and overlapping identity maps refuse even with a usable range', async t => {
  await Promise.all(
    ['garbage\n', '1000 2000 1\n', '2000 1000 1\n'].map(extra => {
      const { observe, files } = makeFixture();
      files['/proc/77/uid_map'] += extra;
      return t.throwsAsync(observe, { message: /identity map/ });
    }),
  );
});

test('writable root refuses independently of cgroup controls', async t => {
  const { observe, files } = makeFixture();
  files['/proc/77/mountinfo'] = files['/proc/77/mountinfo'].replace(
    '/ / ro,',
    '/ / rw,',
  );
  await t.throwsAsync(observe, { message: /root filesystem is not read-only/ });
});

test('unknown or escaping cgroup membership refuses before control reads', async t => {
  await Promise.all(
    [
      '0::/\n',
      '0::/../escape\n',
      '0::/a/../../escape\n',
      '0::/a/./b\n',
      '0:://a\n',
      '0::/a/\n',
      '0::/a (deleted)\n',
      '0::/a\\b\n',
      '1:memory:/a\n',
      '0::/a\n0::/b\n',
      '',
    ].map(async membership => {
      const { observe, files, reads } = makeFixture();
      files['/proc/77/cgroup'] = membership;
      await t.throwsAsync(observe, { message: /cgroup (path|membership)/ });
      t.false(reads.some(path => path.startsWith('/sys/fs/cgroup/')));
    }),
  );
});

test('observer requires unshadowed full cgroup2 mount', async t => {
  await Promise.all(
    [
      '',
      '34 25 0:30 / /sys/fs/cgroup rw - tmpfs tmpfs rw\n',
      '34 25 0:30 /delegated /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    ].map(mount => {
      const { observe, files } = makeFixture();
      files['/proc/self/mountinfo'] = mount;
      return t.throwsAsync(observe, { message: /full cgroup2 mount/ });
    }),
  );
  await Promise.all(
    [`${directory}/memory.max`, directory, '/sys/fs/cgroup/user.slice'].map(
      target => {
        const { observe, files } = makeFixture();
        files['/proc/self/mountinfo'] +=
          `35 34 0:31 / ${target} rw - tmpfs tmpfs rw\n`;
        return t.throwsAsync(observe, { message: /shadowed/ });
      },
    ),
  );
});

for (const [name, wrong] of [
  ['memory.max', '536875008\n'],
  ['memory.swap.max', '1\n'],
  ['pids.max', '129\n'],
  ['cpu.max', '200001 100000\n'],
  ['cpu.max', '200000 100001\n'],
]) {
  test(`observer refuses wrong ${name}: ${wrong.trim()}`, async t => {
    const { observe, files } = makeFixture();
    files[`${directory}/${name}`] = wrong;
    await t.throwsAsync(observe, { message: /controls do not match/ });
  });
}

test('an unbounded leaf beneath a limited scope is refused without consulting the scope', async t => {
  // The observer attests the process's own cgroup. A leaf reading `max` is
  // unbounded to it even when an ancestor carries the limits: ancestors are
  // never consulted, so hierarchy cannot supply what the leaf lacks.
  const { observe, files, reads } = makeFixture();
  const leaf = `${cgroup}/container`;
  files['/proc/77/cgroup'] = `0::${leaf}\n`;
  for (const name of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) {
    files[`/sys/fs/cgroup${leaf}/${name}`] =
      name === 'cpu.max' ? 'max 100000\n' : 'max\n';
  }
  await t.throwsAsync(observe, {
    message: /unbounded or unrecognized native cgroup control/,
  });
  t.true(reads.some(path => path.startsWith(`/sys/fs/cgroup${leaf}/`)));
  const controls = ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'];
  t.false(
    reads.some(path => controls.some(name => path === `${directory}/${name}`)),
    'the limited scope above the leaf is never read',
  );
});

test('missing, malformed and unbounded kernel controls never attest', async t => {
  const checks = [];
  for (const name of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) {
    for (const value of [undefined, 'max\n', '-1\n', '', '1.0\n']) {
      const { observe, files } = makeFixture();
      if (value === undefined) delete files[`${directory}/${name}`];
      else files[`${directory}/${name}`] = value;
      checks.push(t.throwsAsync(observe));
    }
  }
  await Promise.all(checks);
});
