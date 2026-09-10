// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Duplex, PassThrough } from 'node:stream';
import { makeProviderPipe } from '@endo/hosted-agent/provider-pipe.js';

import {
  isPublicEgressAddress,
  makePublicEgress,
} from '../src/public-egress.js';

const mockSocket = () => {
  const written = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      written.push(new Uint8Array(chunk));
      callback();
    },
  });
  return { socket, written };
};

const setup = (t, options = {}) => {
  const connects = [];
  const lookups = [];
  const sockets = [];
  const kit = makePublicEgress({
    policy: 'public-internet',
    localAddresses: [],
    lookup: async (hostname, settings) => {
      lookups.push({ hostname, settings });
      return [{ address: '93.184.215.14', family: 4 }];
    },
    connect: args => {
      connects.push(args);
      const mock = mockSocket();
      sockets.push(mock);
      queueMicrotask(() => mock.socket.emit('connect'));
      return /** @type {any} */ (mock.socket);
    },
    ...options,
  });
  t.teardown(kit.dispose);
  return { ...kit, connects, lookups, sockets };
};

test('public address classification excludes private, special and transition ranges', t => {
  for (const address of [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.215.14',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ]) {
    t.true(isPublicEgressAddress(address), address);
  }
  for (const address of [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2001::1',
    '2001:20::1',
    '2001:db8::1',
    '2002:0808:0808::1',
    '3fff::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    'not-an-ip',
    '127.1',
    '2130706433',
  ])
    t.false(isPublicEgressAddress(address), address);
});

test('off and unsupported ports reject before DNS or connection effects', async t => {
  const off = setup(t, { policy: 'off' });
  await t.throwsAsync(E(off.endpoint).open('example.com', 443), {
    message: /disabled/,
  });
  t.deepEqual(off.lookups, []);
  const kit = setup(t);
  for (const port of [22, 8080, 0, -1, 65_536, 443.5]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(kit.endpoint).open('example.com', port), {
      message: /ports/,
    });
  }
  t.deepEqual(kit.lookups, []);
  t.deepEqual(kit.connects, []);
});

test('all DNS answers are checked and host-local public addresses are denied', async t => {
  for (const answers of [
    [
      { address: '93.184.215.14', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    [
      { address: '93.184.215.14', family: 4 },
      { address: 'fd00::1', family: 6 },
    ],
    [{ address: '93.184.215.14', family: 6 }],
    [],
  ]) {
    const kit = setup(t, { lookup: async () => answers });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(kit.endpoint).open('mixed.example', 443), {
      message: /denied/,
    });
    t.deepEqual(kit.connects, []);
  }
  const local = setup(t, { localAddresses: ['93.184.215.14'] });
  await t.throwsAsync(E(local.endpoint).open('public-host.example', 443), {
    message: /denied/,
  });
  await t.throwsAsync(E(local.endpoint).open('93.184.215.14', 443), {
    message: /denied/,
  });
  t.deepEqual(local.connects, []);
});

test('DNS is resolved once and only the vetted literal is passed to connect', async t => {
  const kit = setup(t);
  await E(kit.endpoint).open('rebind.example', 443);
  t.deepEqual(kit.lookups, [
    { hostname: 'rebind.example', settings: { all: true, verbatim: true } },
  ]);
  t.deepEqual(kit.connects, [
    { host: '93.184.215.14', family: 4, port: 443, highWaterMark: 49_152 },
  ]);
  const ipv6 = setup(t);
  await E(ipv6.endpoint).open('2606:4700:4700::1111', 443);
  t.deepEqual(ipv6.lookups, []);
  t.is(ipv6.connects[0].host, '2606:4700:4700::1111');
  t.is(ipv6.connects[0].family, 6);
});

test('constrained resolver exposes only checked addresses and a bounded TTL', async t => {
  const kit = setup(t);
  t.deepEqual(await E(kit.endpoint).resolvePublic('public.example'), {
    addresses: [{ address: '93.184.215.14', family: 4 }],
    ttlSeconds: 60,
  });
  t.deepEqual(kit.connects, []);
  await t.throwsAsync(E(kit.endpoint).resolvePublic('127.0.0.1'), {
    message: /denied/,
  });
  const mixed = setup(t, {
    lookup: async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '::1', family: 6 },
    ],
  });
  await t.throwsAsync(E(mixed.endpoint).resolvePublic('mixed.example'), {
    message: /denied/,
  });
  kit.dispose();
  await t.throwsAsync(E(kit.endpoint).resolvePublic('public.example'), {
    message: /disabled/,
  });
});

test('bounded duplex transport supports uploads/downloads and EOF', async t => {
  t.timeout(2000);
  const kit = setup(t);
  const tunnel = await E(kit.endpoint).open('example.com', 443);
  await E(tunnel).write(btoa('upload'));
  t.is(new TextDecoder().decode(kit.sockets[0].written[0]), 'upload');
  kit.sockets[0].socket.push(new TextEncoder().encode('download'));
  const downloaded = await E(tunnel).read();
  if (downloaded === null) throw Error('Unexpected EOF');
  t.is(atob(downloaded), 'download');
  const reading = E(tunnel).read();
  await t.throwsAsync(E(tunnel).read(), { message: /Concurrent/ });
  kit.sockets[0].socket.push(null);
  t.is(await reading, null);
  await E(tunnel).end();
  await t.throwsAsync(E(tunnel).write(btoa('late')), { message: /denied/ });
});

test('revocation wakes blocked reads and refuses all future connections', async t => {
  t.timeout(2000);
  const kit = setup(t);
  const tunnel = await E(kit.endpoint).open('example.com', 443);
  const read = E(tunnel).read();
  const rejected = t.throwsAsync(read, { message: /closed/ });
  kit.dispose();
  await rejected;
  t.true(kit.sockets[0].socket.destroyed);
  await t.throwsAsync(E(kit.endpoint).open('example.com', 443), {
    message: /disabled/,
  });
});

test('aggregate byte quota revokes all tunnels and chunk encodings are bounded', async t => {
  const kit = setup(t, { maxBytes: 8n });
  const first = await E(kit.endpoint).open('example.com', 443);
  const second = await E(kit.endpoint).open('example.com', 443);
  await t.throwsAsync(E(first).write('A==='));
  await t.throwsAsync(E(first).write('a'.repeat(65_540)), { message: /chunk/ });
  await E(first).write(btoa('1234'));
  await t.throwsAsync(E(second).write(btoa('56789')), { message: /quota/ });
  t.true(kit.sockets.every(({ socket }) => socket.destroyed));
  await t.throwsAsync(E(kit.endpoint).open('example.com', 443), {
    message: /disabled/,
  });
});

test('expired noncancellable DNS retains admission until it settles', async t => {
  t.timeout(2000);
  /** @type {(value:any)=>void} */
  let resolve = () => {
    throw Error('Future not initialized');
  };
  const lookup = new Promise(done => {
    resolve = done;
  });
  const kit = setup(t, {
    timeoutMs: 20,
    maxConnections: 1,
    lookup: async () => lookup,
  });
  await t.throwsAsync(E(kit.endpoint).open('slow.example', 443), {
    message: /denied/,
  });
  await t.throwsAsync(E(kit.endpoint).open('1.1.1.1', 443), {
    message: /quota/,
  });
  resolve([{ address: '1.1.1.1', family: 4 }]);
  await new Promise(done => setImmediate(done));
  await E(kit.endpoint).open('1.1.1.1', 443);
  t.is(kit.connects.length, 1, 'expired DNS never creates a delayed socket');
});

test('absolute deadlines close idle tunnels and connection count is bounded', async t => {
  t.timeout(2000);
  const kit = setup(t, { timeoutMs: 20, maxConnections: 1, maxRequests: 1 });
  const tunnel = await E(kit.endpoint).open('1.1.1.1', 443);
  await t.throwsAsync(E(kit.endpoint).open('1.1.1.1', 443), {
    message: /quota/,
  });
  await t.throwsAsync(E(tunnel).read(), { message: /closed/ });
  t.true(kit.sockets[0].socket.destroyed);
});

test('revocation rejects a stalled write even if its socket callback never returns', async t => {
  t.timeout(2000);
  /** @type {() => void} */
  let entered = () => {
    throw Error('Uninitialized write latch');
  };
  const started = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  const socket = new Duplex({
    read() {},
    write() {
      entered();
    },
  });
  const kit = setup(t, {
    connect: () => {
      queueMicrotask(() => socket.emit('connect'));
      return /** @type {any} */ (socket);
    },
  });
  const tunnel = await E(kit.endpoint).open('public.example', 443);
  const writing = E(tunnel).write(btoa('pending upload'));
  const rejected = t.throwsAsync(writing, { message: /operation stopped/ });
  await started;
  kit.dispose();
  await rejected;
  t.true(socket.destroyed);
});

test('public resolver and duplex capabilities cross the existing bounded private pipe', async t => {
  t.timeout(2000);
  const kit = setup(t);
  const leftStream = new PassThrough();
  const rightStream = new PassThrough();
  const host = makeProviderPipe({
    input: leftStream,
    output: rightStream,
    bootstrap: kit.endpoint,
  });
  const worker = makeProviderPipe({
    input: rightStream,
    output: leftStream,
    bootstrap: undefined,
  });
  t.teardown(() => {
    host.close();
    worker.close();
  });
  const remote = await worker.getBootstrap();
  t.deepEqual(await E(remote).resolvePublic('public.example'), {
    addresses: [{ address: '93.184.215.14', family: 4 }],
    ttlSeconds: 60,
  });
  const tunnel = await E(remote).open('public.example', 443);
  await E(tunnel).write(btoa('TLS bytes'));
  t.is(new TextDecoder().decode(kit.sockets[0].written[0]), 'TLS bytes');
  kit.sockets[0].socket.push(new TextEncoder().encode('response'));
  t.is(await E(tunnel).read(), btoa('response'));
  await E(tunnel).close();
  t.true(kit.sockets[0].socket.destroyed);
});
