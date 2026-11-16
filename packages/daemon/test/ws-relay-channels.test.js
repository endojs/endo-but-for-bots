// @ts-check

import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from '@endo/ses-ava/prepare-endo.js';
import { makeRelay } from '@endo/relay-server/relay.js';
import * as wire from '@endo/relay-server/protocol.js';

import { makeChannelIdAllocator } from '@endo/relay-server/protocol.js';

/** @param {import('ava').ExecutionContext} t */
const setup = t => {
  const domain = 'relay.test.invalid';
  const relay = makeRelay(domain);
  const sockets = [];
  t.teardown(() => {
    for (const socket of sockets) socket.close();
  });
  const preparePeer = () => {
    const keys = generateKeyPairSync('ed25519');
    const node = new Uint8Array(
      keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );
    const received = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: bytes => received.push(wire.decodeFrame(bytes)),
      close() {
        socket.readyState = 3;
        socket.emit('close');
      },
      terminate() {
        this.close();
      },
      ping() {},
    });
    sockets.push(socket);
    const send = bytes => socket.emit('message', bytes, true);
    const connect = () => {
      relay.handleConnection(/** @type {any} */ (socket));
      send(wire.encodeHello(node));
      const challenge = received.shift();
      t.is(challenge.type, wire.MSG_CHALLENGE);
      const domainBytes = new TextEncoder().encode(domain);
      const signed = new Uint8Array(
        domainBytes.length + challenge.payload.length,
      );
      signed.set(domainBytes);
      signed.set(challenge.payload, domainBytes.length);
      send(wire.encodeResponse(sign(null, signed, keys.privateKey)));
      t.is(received.shift().type, wire.MSG_AUTH_OK);
    };
    return { node, send, connect, received };
  };
  return { preparePeer };
};

test('relay keeps concurrent incoming and outgoing channel routes separate', t => {
  const { preparePeer } = setup(t);
  const a = preparePeer();
  const b = preparePeer();
  const c = preparePeer();
  a.connect();
  b.connect();
  c.connect();
  const outgoing = 0x8000_0000;
  a.send(wire.encodeOpen(outgoing, b.node));
  t.is(a.received.shift().type, wire.MSG_OPENED);
  const incomingB = wire.decodeIncoming(b.received.shift().payload).channelId;
  t.true(incomingB < outgoing);
  b.send(wire.encodeOpen(outgoing, c.node));
  t.is(b.received.shift().type, wire.MSG_OPENED);
  const incomingC = wire.decodeIncoming(c.received.shift().payload).channelId;
  t.true(incomingC < outgoing);
  a.send(wire.encodeData(outgoing, new Uint8Array([10])));
  t.deepEqual(wire.decodeDataFrame(b.received.shift().payload), {
    channelId: incomingB,
    data: new Uint8Array([10]),
  });
  b.send(wire.encodeData(outgoing, new Uint8Array([20])));
  t.deepEqual(wire.decodeDataFrame(c.received.shift().payload), {
    channelId: incomingC,
    data: new Uint8Array([20]),
  });
  c.send(wire.encodeData(incomingC, new Uint8Array([30])));
  t.deepEqual(wire.decodeDataFrame(b.received.shift().payload), {
    channelId: outgoing,
    data: new Uint8Array([30]),
  });
});

test('legacy low channel IDs cannot overwrite incoming or pending channels', t => {
  const { preparePeer } = setup(t);
  const legacy = preparePeer();
  const caller = preparePeer();
  const later = preparePeer();
  legacy.connect();
  caller.connect();
  legacy.send(wire.encodeOpen(1, later.node));
  caller.send(wire.encodeOpen(0x8000_0000, legacy.node));
  const incoming = wire.decodeIncoming(
    legacy.received.shift().payload,
  ).channelId;
  t.is(incoming, 2, 'relay skips the legacy pending outgoing channel');
  t.is(caller.received.shift().type, wire.MSG_OPENED);
  legacy.send(wire.encodeOpen(incoming, caller.node));
  t.is(legacy.received.shift().type, wire.MSG_OPEN_FAILED);
  legacy.send(wire.encodeOpen(1, caller.node));
  t.is(legacy.received.shift().type, wire.MSG_OPEN_FAILED);
  later.connect();
  const laterIncoming = wire.decodeIncoming(
    later.received.shift().payload,
  ).channelId;
  t.is(legacy.received.shift().type, wire.MSG_OPENED);
  legacy.send(wire.encodeData(1, new Uint8Array([40])));
  t.deepEqual(wire.decodeDataFrame(later.received.shift().payload), {
    channelId: laterIncoming,
    data: new Uint8Array([40]),
  });
  caller.send(wire.encodeData(0x8000_0000, new Uint8Array([50])));
  t.deepEqual(wire.decodeDataFrame(legacy.received.shift().payload), {
    channelId: incoming,
    data: new Uint8Array([50]),
  });
});

test('channel allocation exhausts without wrapping or crossing direction boundary', t => {
  const lower = makeChannelIdAllocator(0x7fff_fffe, 0x7fff_ffff);
  t.is(lower(), 0x7fff_fffe);
  t.is(lower(), 0x7fff_ffff);
  t.is(lower(), undefined);
  t.is(lower(), undefined);
  const upper = makeChannelIdAllocator(0xffff_fffe, 0xffff_ffff);
  t.is(upper(), 0xffff_fffe);
  t.is(upper(), 0xffff_ffff);
  t.is(upper(), undefined);
});
