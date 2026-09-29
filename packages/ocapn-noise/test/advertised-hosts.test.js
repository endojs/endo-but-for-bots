// @ts-check

import os from 'node:os';

import test from '@endo/ses-ava/test.js';

import {
  bracketHost,
  computeAdvertisedHosts,
} from '../src/transports/advertised-hosts.js';

const isIpv6 = (/** @type {string} */ addr) => addr.includes(':');

test('bracketHost brackets IPv6 literals and passes others through', t => {
  t.is(bracketHost('::1'), '[::1]');
  t.is(bracketHost('2001:db8::1'), '[2001:db8::1]');
  t.is(bracketHost('192.0.2.1'), '192.0.2.1');
  t.is(bracketHost('example.com'), 'example.com');
});

test('a specific bind advertises the bound address, loopback included', async t => {
  const hosts = await computeAdvertisedHosts({
    bindHost: '127.0.0.1',
    boundAddress: '127.0.0.1',
  });
  t.deepEqual(hosts, ['127.0.0.1']);
});

test('an explicit hosts override is advertised IPv6-first, deduplicated, loopback kept', async t => {
  const hosts = await computeAdvertisedHosts({
    bindHost: '0.0.0.0',
    boundAddress: '0.0.0.0',
    hosts: ['192.0.2.1', '::1', '127.0.0.1', '2001:db8::1', '192.0.2.1'],
  });
  t.deepEqual(hosts, ['::1', '2001:db8::1', '192.0.2.1', '127.0.0.1']);
});

test('a wildcard bind enumerates routable interfaces, dropping loopback and link-local', async t => {
  const hosts = await computeAdvertisedHosts({
    bindHost: '0.0.0.0',
    boundAddress: '0.0.0.0',
  });
  const expected = Object.values(os.networkInterfaces())
    .flatMap(infos => infos ?? [])
    .filter(
      info =>
        !info.internal &&
        !(
          isIpv6(info.address) && info.address.toLowerCase().startsWith('fe80')
        ),
    )
    .map(info => info.address);
  t.deepEqual(
    [...hosts].sort(),
    [...new Set(expected)].sort(),
    'every routable interface address is advertised exactly once',
  );
  for (const host of hosts) {
    t.false(host.startsWith('127.') || host === '::1', `${host} is loopback`);
    t.false(host.toLowerCase().startsWith('fe80'), `${host} is link-local`);
  }
  const firstV4 = hosts.findIndex(host => !isIpv6(host));
  t.true(
    firstV4 === -1 || hosts.slice(firstV4).every(host => !isIpv6(host)),
    'every IPv6 address precedes every IPv4 address',
  );
});

test('a wildcard bound address alone also triggers enumeration', async t => {
  const fromBindHost = await computeAdvertisedHosts({
    bindHost: '::',
    boundAddress: '::',
  });
  const fromBoundAddress = await computeAdvertisedHosts({
    bindHost: 'localhost',
    boundAddress: '::',
  });
  t.deepEqual(fromBoundAddress, fromBindHost);
});

test('discovered hosts fold in after the base set with loopback and duplicates dropped', async t => {
  const hosts = await computeAdvertisedHosts({
    bindHost: '192.0.2.1',
    boundAddress: '192.0.2.1',
    discoverHosts: async () => [
      '203.0.113.4',
      '127.0.0.1',
      '192.0.2.1',
      '2001:db8::2',
      '::1',
      '0.0.0.0',
    ],
  });
  t.deepEqual(hosts, ['192.0.2.1', '2001:db8::2', '203.0.113.4']);
});
