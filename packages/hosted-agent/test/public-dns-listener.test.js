// @ts-check
/* eslint-disable no-bitwise -- DNS fields are bounded 16-bit wire values. */
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { createSocket } from 'node:dgram';

import {
  answerPublicDns,
  makePublicDnsListener,
} from '../src/public-dns-listener.js';

const query = (name = 'example.com', type = 1) => {
  const bytes = new Uint8Array(12 + name.length + 2 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1234);
  view.setUint16(2, 0x100);
  view.setUint16(4, 1);
  let cursor = 12;
  for (const label of name.split('.')) {
    bytes[cursor] = label.length;
    cursor += 1;
    bytes.set(new TextEncoder().encode(label), cursor);
    cursor += label.length;
  }
  view.setUint16(cursor + 1, type);
  view.setUint16(cursor + 3, 1);
  return bytes;
};
const resolver = addresses =>
  Far('Public resolver fixture', {
    resolvePublic: async name => {
      if (name !== 'example.com') throw Error('Unexpected name');
      return harden({ addresses, ttlSeconds: 60 });
    },
  });

test('DNS returns bounded A and AAAA answers with zero TTL', async t => {
  const endpoint = resolver([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  for (const type of [1, 28]) {
    // eslint-disable-next-line no-await-in-loop
    const response = await answerPublicDns(
      query('Example.COM', type),
      endpoint,
    );
    const view = new DataView(response.buffer);
    t.is(view.getUint16(0), 1234);
    t.is(view.getUint16(2), 0x8180);
    t.is(view.getUint16(6), 1);
    const offset = query().length;
    t.is(view.getUint16(offset + 2), type);
    t.is(view.getUint32(offset + 6), 0);
    t.deepEqual(
      [...response.subarray(offset + 12)],
      type === 1
        ? [93, 184, 216, 34]
        : [38, 6, 71, 0, 71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 17],
    );
  }
});

test('malformed and extended DNS packets never reach resolver', async t => {
  let calls = 0;
  const endpoint = Far('Unused resolver', {
    resolvePublic: async () => {
      calls += 1;
      return harden({ addresses: [] });
    },
  });
  const malformed = [
    new Uint8Array(),
    query('bad_name.com'),
    query().subarray(0, 15),
  ];
  for (const offset of [2, 4, 6, 8, 10, 12]) {
    const packet = query();
    packet[offset] = 255;
    malformed.push(packet);
  }
  for (const packet of malformed) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await answerPublicDns(packet, endpoint);
    t.is(new DataView(answer.buffer).getUint16(2) & 15, 1);
    t.is(answer.length, 12);
  }
  t.is(calls, 0);
});

test('unsupported records are NODATA and denied lookup is REFUSED', async t => {
  let calls = 0;
  const endpoint = Far('Deny resolver', {
    resolvePublic: async () => {
      calls += 1;
      throw Error('Private address');
    },
  });
  const nodata = await answerPublicDns(query('example.com', 16), endpoint);
  t.is(new DataView(nodata.buffer).getUint16(2) & 15, 0);
  t.is(calls, 0);
  const denied = await answerPublicDns(query(), endpoint);
  t.is(new DataView(denied.buffer).getUint16(2) & 15, 5);
  t.is(calls, 1);
  t.is(denied.length, query().length);
});

test('oversized or malformed resolver replies fail closed', async t => {
  for (const addresses of [
    Array(33).fill({ address: '93.184.216.34', family: 4 }),
    [{ address: 'not-an-ip', family: 4 }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const response = await answerPublicDns(query(), resolver(addresses));
    t.is(new DataView(response.buffer).getUint16(2) & 15, 5);
  }
  const bounded = await answerPublicDns(
    query(),
    resolver(Array(32).fill({ address: '93.184.216.34', family: 4 })),
  );
  t.is(new DataView(bounded.buffer).getUint16(6), 8);
  t.true(bounded.length <= 512);
});

test('UDP adapter answers through host capability and closes without late sends', async t => {
  t.timeout(5000);
  const server = await makePublicDnsListener({
    endpoint: resolver([{ address: '93.184.216.34', family: 4 }]),
    host: '127.0.0.1',
    port: 0,
  });
  t.teardown(() => server.dispose());
  const socket = createSocket('udp4');
  t.teardown(
    () => new Promise(resolve => socket.close(() => resolve(undefined))),
  );
  const received = new Promise((resolve, reject) => {
    socket.once('message', resolve);
    socket.once('error', reject);
  });
  socket.send(query(), server.port, server.host);
  const response = /** @type {Uint8Array} */ (await received);
  t.is(
    new DataView(
      response.buffer,
      response.byteOffset,
      response.byteLength,
    ).getUint16(6),
    1,
  );
  await server.dispose();
  await server.dispose();
});

test('DNS binding collision rejects cleanly without a leaked socket', async t => {
  t.timeout(5000);
  const endpoint = resolver([]);
  const server = await makePublicDnsListener({
    endpoint,
    host: '127.0.0.1',
    port: 0,
  });
  t.teardown(() => server.dispose());
  await t.throwsAsync(
    () =>
      makePublicDnsListener({ endpoint, host: server.host, port: server.port }),
    { code: 'EADDRINUSE' },
  );
});
