// @ts-check

import baseTest from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeTcpTransport } from '../src/transports/tcp.js';
import { netListenAllowed } from './_net-permission.js';

const test = netListenAllowed ? baseTest : baseTest.skip;

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
  netA.shutdown();
  netB.shutdown();
});

test('noise network rejects a tcp-testing-only location that has no tcp-scheme hints', async t => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
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
  network.shutdown();
});
