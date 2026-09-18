// @ts-check

import rawNet from 'node:net';

import baseTest from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeTcpTransport } from '../src/transports/tcp.js';
import { netListenAllowed } from './_net-permission.js';

// `test.serial` because every test in this file binds an OS port via
// `makeTcpTransport()` and shares filesystem and socket state. A
// failure mid-test would otherwise leak the listener into the next
// concurrent test.
const test = netListenAllowed ? baseTest.serial : baseTest.serial.skip;

/**
 * @param {ReturnType<typeof makeOcapnNoiseNetwork>} network
 */
const addFreshKey = network => {
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);
  return { keyId, ...signingKeys };
};

test('two noise peers exchange encrypted messages over TCP', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.teardown(() => netA.shutdown());
  t.teardown(() => netB.shutdown());
  const { keyId: keyA } = addFreshKey(netA);
  const { keyId: keyB } = addFreshKey(netB);
  await netA.addTransport(makeTcpTransport());
  await netB.addTransport(makeTcpTransport());

  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);

  t.is(sessionA.remoteLocation.designator, keyB);
  t.is(sessionB.remoteLocation.designator, keyA);

  await sessionA.writer.next(new TextEncoder().encode('hello-tcp-A'));
  await sessionB.writer.next(new TextEncoder().encode('hello-tcp-B'));
  const a = await sessionA.reader.next(undefined);
  const b = await sessionB.reader.next(undefined);
  t.false(a.done);
  t.false(b.done);
  if (!a.done && !b.done) {
    t.is(new TextDecoder().decode(a.value), 'hello-tcp-B');
    t.is(new TextDecoder().decode(b.value), 'hello-tcp-A');
  }

  sessionA.close();
  sessionB.close();
});

test('noise network rejects a tcp-testing-only location that has no tcp-scheme hints', async t => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.teardown(() => network.shutdown());
  addFreshKey(network);
  await network.addTransport(makeTcpTransport());
  await t.throwsAsync(
    async () =>
      network.provideSession({
        type: 'ocapn-peer',
        network: 'tcp-testing-only',
        transport: 'tcp-testing-only',
        designator: '00'.repeat(32),
        hints: { host: '127.0.0.1', port: '1' },
      }),
    { message: /no registered transport matches hints/ },
  );
});

test('tcp transport with framing:none delivers raw socket bytes', async t => {
  const transport = makeTcpTransport({ framing: 'none' });
  t.teardown(() => transport.shutdown());
  /** @type {(s: import('../src/types.js').ByteStream) => void} */
  let resolveStream = () => {};
  /** @type {Promise<import('../src/types.js').ByteStream>} */
  const serverStreamPromise = new Promise(resolve => {
    resolveStream = resolve;
  });
  /* eslint-disable-next-line no-use-before-define -- we capture the listen handler into a promise */
  const { listen } = transport;
  if (!listen) throw Error('tcp transport must expose listen');
  const listener = await listen(stream => {
    resolveStream(stream);
  });

  // Connect a raw Node socket (not through the transport) so we
  // control bytes on the wire exactly. The listener advertises a
  // priority-ordered list of `tcp://host:port` dial URLs; a specific
  // (non-wildcard) bind yields a single loopback entry.
  const listenUrl = new URL(listener.hints[0]);
  const sock = rawNet.createConnection({
    host: listenUrl.hostname,
    port: Number.parseInt(listenUrl.port, 10),
  });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.write(Uint8Array.of(0x48, 0x49)); // raw 'HI', not a netstring

  const serverStream = await serverStreamPromise;
  const first = await serverStream.reader.next(undefined);
  t.false(first.done);
  if (!first.done) {
    t.deepEqual(Array.from(first.value), [0x48, 0x49]);
  }

  sock.destroy();
});

test('tcp transport: a specific (non-wildcard) bind advertises that single host', async t => {
  const transport = makeTcpTransport({ host: '127.0.0.1', port: 0 });
  t.teardown(() => transport.shutdown());
  const { listen } = transport;
  if (!listen) throw Error('tcp transport must expose listen');
  const listener = await listen(() => {});
  t.teardown(() => listener.close());
  t.is(listener.hints.length, 1, 'a deliberate specific bind is advertised');
  const url = new URL(listener.hints[0]);
  t.is(url.protocol, 'tcp:');
  t.is(url.hostname, '127.0.0.1', 'the chosen host is honored as-is');
  t.not(url.port, '');
});

test('tcp transport: a wildcard bind advertises routable hosts IPv6-first, never loopback', async t => {
  // The `hosts` override makes the assertion deterministic regardless
  // of the CI host's interfaces; it exercises the same ordering and
  // loopback-omission the wildcard interface-enumeration path uses.
  const transport = makeTcpTransport({
    host: '0.0.0.0',
    port: 0,
    hosts: ['198.51.100.9', '2001:db8::2'],
  });
  t.teardown(() => transport.shutdown());
  const { listen } = transport;
  if (!listen) throw Error('tcp transport must expose listen');
  const listener = await listen(() => {});
  t.teardown(() => listener.close());
  t.is(listener.hints.length, 2);
  t.is(
    new URL(listener.hints[0]).hostname,
    '[2001:db8::2]',
    'IPv6 literal is bracketed and sorts first',
  );
  t.is(new URL(listener.hints[1]).hostname, '198.51.100.9');
  for (const hint of listener.hints) {
    t.not(new URL(hint).hostname, '127.0.0.1', 'never advertises loopback');
  }
});

test('tcp transport: a wildcard bind with no routable hosts omits the hint', async t => {
  const transport = makeTcpTransport({ host: '::', port: 0, hosts: [] });
  t.teardown(() => transport.shutdown());
  const { listen } = transport;
  if (!listen) throw Error('tcp transport must expose listen');
  const listener = await listen(() => {});
  t.teardown(() => listener.close());
  t.deepEqual(listener.hints, [], 'omits rather than advertising loopback');
});

test('tcp transport: discoverHosts results are folded into the advertised list', async t => {
  const transport = makeTcpTransport({
    host: '0.0.0.0',
    port: 0,
    hosts: ['198.51.100.9'],
    discoverHosts: () => ['203.0.113.4'],
  });
  t.teardown(() => transport.shutdown());
  const { listen } = transport;
  if (!listen) throw Error('tcp transport must expose listen');
  const listener = await listen(() => {});
  t.teardown(() => listener.close());
  const hosts = listener.hints.map(h => new URL(h).hostname);
  t.true(hosts.includes('198.51.100.9'), 'base host present');
  t.true(hosts.includes('203.0.113.4'), 'discovered host folded in');
});

// `makeTcpTransport` validates options synchronously, so this case
// doesn't actually need the listen permission gate that wraps the
// rest of this file, but keeping it under the same `test` keeps the
// file uniform.
test('tcp transport rejects an invalid framing option', t => {
  t.throws(
    () =>
      makeTcpTransport(
        /** @type {any} */ ({ framing: 'definitely-not-a-thing' }),
      ),
    { message: /framing.*must be 'netstring' or 'none'/ },
  );
});
