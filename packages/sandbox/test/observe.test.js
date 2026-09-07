// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  countRoutableIpv4Routes,
  countRoutableIpv6Routes,
  mapIdInward,
  parseIdMap,
  parseNamespaceInode,
  parseNetDev,
  readNetworkNamespace,
  readProcessStatus,
  readUnsharedNamespaces,
} from '../src/observe.js';

/**
 * Build a `ProcReader` over a fixture filesystem, so the parsers can be
 * driven against captured `procfs` text without a container.
 *
 * @param {Record<string, string>} files
 * @param {Record<string, string>} links
 */
const makeFixtureProc = (files, links) =>
  harden({
    /** @param {string} path */
    readFile: async path => {
      await null;
      const body = files[path];
      if (body === undefined) throw new Error(`ENOENT ${path}`);
      return body;
    },
    /** @param {string} path */
    readLink: async path => {
      await null;
      const target = links[path];
      if (target === undefined) throw new Error(`ENOENT ${path}`);
      return target;
    },
  });

const LOOPBACK_ONLY_NET_DEV = `\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes
    lo:       0       0    0    0    0     0          0         0        0
`;

const ROUTED_NET_DEV = `\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes
    lo:       0       0    0    0    0     0          0         0        0
  eth0:    1024      12    0    0    0     0          0         0     2048
`;

const EMPTY_IPV4_ROUTES = `\
Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
`;

const DEFAULT_IPV4_ROUTE = `${EMPTY_IPV4_ROUTES}\
eth0\t00000000\t0102000A\t0003\t0\t0\t0\t00000000\t0\t0\t0
`;

const LOOPBACK_IPV6_ROUTES = `\
00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000001 80200001 lo
`;

const ROUTED_IPV6_ROUTES = `${LOOPBACK_IPV6_ROUTES}\
00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000000 00000000 00000003 eth0
`;

test('a namespace link parses into a stable identity', t => {
  t.is(parseNamespaceInode('net:[4026532567]'), 'net-4026532567');
  t.is(parseNamespaceInode('mnt:[4026531840]'), 'mnt-4026531840');
  t.is(parseNamespaceInode('not a namespace'), null);
  t.is(parseNamespaceInode(''), null);
});

test('net/dev yields the interface inventory', t => {
  t.deepEqual([...parseNetDev(LOOPBACK_ONLY_NET_DEV)], ['lo']);
  t.deepEqual([...parseNetDev(ROUTED_NET_DEV)], ['lo', 'eth0']);
});

test('routes off loopback are counted, loopback routes are not', t => {
  t.is(countRoutableIpv4Routes(EMPTY_IPV4_ROUTES), 0);
  t.is(countRoutableIpv4Routes(DEFAULT_IPV4_ROUTE), 1);
  t.is(countRoutableIpv6Routes(LOOPBACK_IPV6_ROUTES), 0);
  t.is(countRoutableIpv6Routes(ROUTED_IPV6_ROUTES), 1);
});

test('an id map translates a host id into the one the slice sees', t => {
  const ranges = parseIdMap('         0     100000      65536\n');
  t.deepEqual(
    ranges.map(range => ({ ...range })),
    [{ inside: 0, outside: 100_000, count: 65_536 }],
  );
  t.is(mapIdInward(ranges, 100_999), 999);
  t.is(mapIdInward(ranges, 101_000), 1000);
  t.is(mapIdInward(ranges, 42), null);
});

test('namespaces the anchor does not share are reported unshared', async t => {
  const proc = makeFixtureProc(
    {},
    {
      '/proc/self/ns/user': 'user:[4026531837]',
      '/proc/self/ns/pid': 'pid:[4026531836]',
      '/proc/self/ns/ipc': 'ipc:[4026531839]',
      '/proc/self/ns/mnt': 'mnt:[4026531840]',
      '/proc/77/ns/user': 'user:[4026532100]',
      '/proc/77/ns/pid': 'pid:[4026532101]',
      '/proc/77/ns/ipc': 'ipc:[4026532102]',
      '/proc/77/ns/mnt': 'mnt:[4026532103]',
    },
  );
  const observed = await readUnsharedNamespaces(proc, 77);
  t.deepEqual(
    { ...observed },
    { user: true, pid: true, ipc: true, mount: true },
  );
});

test('a namespace the anchor shares with the daemon is not unshared', async t => {
  const proc = makeFixtureProc(
    {},
    {
      '/proc/self/ns/user': 'user:[4026531837]',
      '/proc/self/ns/pid': 'pid:[4026531836]',
      '/proc/self/ns/ipc': 'ipc:[4026531839]',
      '/proc/self/ns/mnt': 'mnt:[4026531840]',
      '/proc/77/ns/user': 'user:[4026531837]',
      '/proc/77/ns/pid': 'pid:[4026532101]',
      '/proc/77/ns/ipc': 'ipc:[4026532102]',
      '/proc/77/ns/mnt': 'mnt:[4026532103]',
    },
  );
  const observed = await readUnsharedNamespaces(proc, 77);
  t.deepEqual(
    { ...observed },
    { user: false, pid: true, ipc: true, mount: true },
  );
});

test('a namespace link nobody can read is not proof of isolation', async t => {
  const proc = makeFixtureProc(
    {},
    { '/proc/self/ns/user': 'user:[4026531837]' },
  );
  const observed = await readUnsharedNamespaces(proc, 77);
  t.deepEqual(
    { ...observed },
    { user: false, pid: false, ipc: false, mount: false },
  );
});

test('a loopback-only namespace reports no routable path', async t => {
  const proc = makeFixtureProc(
    {
      '/proc/77/net/dev': LOOPBACK_ONLY_NET_DEV,
      '/proc/77/net/route': EMPTY_IPV4_ROUTES,
      '/proc/77/net/ipv6_route': LOOPBACK_IPV6_ROUTES,
    },
    { '/proc/77/ns/net': 'net:[4026532567]' },
  );
  const observed = await readNetworkNamespace(proc, 77);
  t.deepEqual(
    { ...observed },
    {
      namespaceId: 'net-4026532567',
      interfaces: ['lo'],
      routableRoutes: 0,
    },
  );
});

test('a NAT-ed namespace reports the interface and route it kept', async t => {
  const proc = makeFixtureProc(
    {
      '/proc/77/net/dev': ROUTED_NET_DEV,
      '/proc/77/net/route': DEFAULT_IPV4_ROUTE,
      '/proc/77/net/ipv6_route': ROUTED_IPV6_ROUTES,
    },
    { '/proc/77/ns/net': 'net:[4026532567]' },
  );
  const observed = await readNetworkNamespace(proc, 77);
  t.deepEqual([...observed.interfaces], ['lo', 'eth0']);
  t.is(observed.routableRoutes, 2);
});

test('an unreadable inventory is an error, not an empty one', async t => {
  const proc = makeFixtureProc(
    { '/proc/77/net/route': EMPTY_IPV4_ROUTES },
    { '/proc/77/ns/net': 'net:[4026532567]' },
  );
  await t.throwsAsync(readNetworkNamespace(proc, 77), {
    message: /cannot read the slice interface inventory/,
  });
});

test('process identity is reported inside the slice user namespace', async t => {
  // The host sees the subuid the rootless engine mapped `--user 1000`
  // onto; only the map says which id the slice sees for itself.
  const proc = makeFixtureProc(
    {
      '/proc/77/status':
        'Name:\tsleep\nUid:\t100999\t100999\t100999\t100999\nGid:\t100999\t100999\t100999\t100999\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\nCapEff:\t0000000000000000\n',
      '/proc/77/uid_map': '         0     100000      65536\n',
      '/proc/77/gid_map': '         0     100000      65536\n',
    },
    {},
  );
  const identity = await readProcessStatus(proc, 77);
  t.deepEqual(
    { ...identity },
    {
      uid: 999,
      gid: 999,
      seccompMode: 2,
      noNewPrivs: true,
      effectiveCapabilities: 0n,
    },
  );
  // `Seccomp_filters:` starts with the same word as `Seccomp:`; the
  // mode must come from the field that ends at the colon.
  t.is(identity.seccompMode, 2);
});

test('an identity outside the slice map is an error, not a guess', async t => {
  const proc = makeFixtureProc(
    {
      '/proc/77/status': 'Uid:\t42\t42\t42\t42\nGid:\t42\t42\t42\t42\n',
      '/proc/77/uid_map': '         0     100000      65536\n',
      '/proc/77/gid_map': '         0     100000      65536\n',
    },
    {},
  );
  await t.throwsAsync(readProcessStatus(proc, 77), {
    message: /outside the slice user namespace map/,
  });
});

test('a kernel that reports no seccomp mode does not claim one', async t => {
  const proc = makeFixtureProc(
    {
      '/proc/77/status':
        'Uid:\t100999\t100999\t100999\t100999\nGid:\t100999\t100999\t100999\t100999\n',
      '/proc/77/uid_map': '         0     100000      65536\n',
      '/proc/77/gid_map': '         0     100000      65536\n',
    },
    {},
  );
  const identity = await readProcessStatus(proc, 77);
  t.is(identity.seccompMode, null);
  t.is(identity.noNewPrivs, null);
  t.is(identity.effectiveCapabilities, null);
});

test('a capability mask the process kept is read as a bit set', async t => {
  const proc = makeFixtureProc(
    {
      '/proc/77/status':
        'Uid:\t100999\t100999\t100999\t100999\nGid:\t100999\t100999\t100999\t100999\nNoNewPrivs:\t0\nCapEff:\t0000003fffffffff\n',
      '/proc/77/uid_map': '         0     100000      65536\n',
      '/proc/77/gid_map': '         0     100000      65536\n',
    },
    {},
  );
  const identity = await readProcessStatus(proc, 77);
  t.is(identity.noNewPrivs, false);
  // Wider than a double can hold exactly, so it is read as a bigint
  // rather than narrowed to whatever fits.
  t.is(identity.effectiveCapabilities, 0x3f_ffff_ffffn);
});
