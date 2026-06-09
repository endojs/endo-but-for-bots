// @ts-check
/* global Buffer */

import test from '@endo/ses-ava/prepare-endo.js';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { firstData, make } from '../src/dbus-sock.js';

const methodReturn = serial => {
  const reply = Buffer.alloc(16);
  reply[0] = 0x6c;
  reply[1] = 2;
  reply[2] = 0;
  reply[3] = 1;
  reply.writeUInt32LE(0, 4);
  reply.writeUInt32LE(serial, 8);
  reply.writeUInt32LE(0, 12);
  return reply;
};

test('firstData clears timeout after receiving data', async t => {
  const socket = new EventEmitter();
  /** @type {unknown[]} */
  const cleared = [];
  /** @type {((...args: unknown[]) => void) | undefined} */
  let timeoutCallback;

  const timerPowers = harden({
    setTimeout(callback, _timeoutMs) {
      timeoutCallback = callback;
      return 'timer-token';
    },
    clearTimeout(token) {
      cleared.push(token);
    },
  });

  const pending = firstData(
    /** @type {import('node:net').Socket} */ (/** @type {unknown} */ (socket)),
    30000,
    timerPowers,
  );
  socket.emit('data', Buffer.from('ok'));

  const data = await pending;
  t.is(data.toString(), 'ok');
  t.deepEqual(cleared, ['timer-token']);
  t.truthy(timeoutCallback, 'timeout callback should have been registered');
});

test('hello sends a method call with serial 1', async t => {
  await null;
  const socket = /** @type {import('node:net').Socket} */ (
    /** @type {unknown} */ (new EventEmitter())
  );
  socket.write = chunk => {
    if (typeof chunk === 'string' && chunk.includes('BEGIN')) {
      Promise.resolve().then(() => socket.emit('data', Buffer.from('OK\r\n')));
      return true;
    }
    if (Buffer.isBuffer(chunk) && chunk.length >= 12 && chunk[1] === 1) {
      const serial = chunk.readUInt32LE(8);
      if (serial === 1) {
        Promise.resolve().then(() => socket.emit('data', methodReturn(1)));
      }
    }
    return true;
  };
  socket.destroy = () => socket;

  const originalCreateConnection = net.createConnection;
  net.createConnection = () => {
    Promise.resolve().then(() => socket.emit('connect'));
    return /** @type {import('node:net').Socket} */ (
      /** @type {unknown} */ (socket)
    );
  };

  try {
    const dbusSock = make(undefined, undefined, { env: { UID: '1000' } });
    await dbusSock.connect();
    await dbusSock.authenticate();
    await t.notThrowsAsync(() => dbusSock.hello());
  } finally {
    net.createConnection = originalCreateConnection;
  }
});
