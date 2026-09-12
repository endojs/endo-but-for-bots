// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { listenMcpSocket } from '../src/mcp-socket.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { Interface } from 'node:readline' */

/**
 * @param {ExecutionContext} t
 * @param {(message: any) => Promise<object | undefined>} handleMessage
 * @param {number} [maxFrameLength]
 */
const setup = async (t, handleMessage, maxFrameLength = 64) => {
  t.timeout(5000);
  const directory = await mkdtemp(join(tmpdir(), 'mcp-wire-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'mcp.sock');
  const listener = await listenMcpSocket({
    socketPath,
    bridge: { handleMessage },
    maxFrameLength,
  });
  t.teardown(() => listener.close());
  const socket = connect(socketPath);
  t.teardown(() => socket.destroy());
  await once(socket, 'connect');
  const reader = createInterface({ input: socket });
  t.teardown(() => reader.close());
  return { socket, reader, listener };
};

/**
 * @param {Interface} reader
 * @param {number} count
 * @returns {Promise<any[]>}
 */
const readReplies = (reader, count) =>
  new Promise(resolve => {
    /** @type {any[]} */
    const replies = [];
    const onLine = line => {
      replies.push(JSON.parse(line));
      if (replies.length === count) {
        reader.removeListener('line', onLine);
        resolve(replies);
      }
    };
    reader.on('line', onLine);
  });

for (const [name, chunks] of [
  ['complete', [`"${'x'.repeat(63)}"\n`]],
  ['partial', ['x'.repeat(65)]],
  ['split', ['"hello', `${'x'.repeat(60)}"\n`]],
  ['whitespace', [`${' '.repeat(65)}\n`]],
  ['padded valid JSON', [`${' '.repeat(63)}{}\n`]],
]) {
  test(`rejects oversized ${name} frames before dispatch`, async t => {
    const calls = [];
    const { socket } = await setup(t, async message => {
      calls.push(message);
      return { result: 'unexpected' };
    });
    const closed = once(socket, 'close');
    for (const chunk of chunks) socket.write(chunk);
    await closed;
    t.deepEqual(calls, []);
  });
}

test('the limit is per frame, counts UTF-16, and accepts the exact boundary', async t => {
  const { socket, reader } = await setup(t, async message => ({
    result: message,
  }));
  const value = '🦋'.repeat(31);
  const frame = JSON.stringify(value);
  t.is(frame.length, 64);
  const replies = readReplies(reader, 3);
  const bytes = new TextEncoder().encode(`${frame}\n${frame}\n${frame}\n`);
  // Split within a multibyte code point; Node's UTF-8 decoder carries it.
  socket.write(bytes.subarray(0, 3));
  socket.write(bytes.subarray(3));
  t.deepEqual(await replies, [
    { result: value },
    { result: value },
    { result: value },
  ]);
});

test('valid frames before an oversized frame dispatch; trailing frames do not', async t => {
  const calls = [];
  const { socket } = await setup(t, async message => {
    calls.push(message);
    return undefined;
  });
  const closed = once(socket, 'close');
  socket.write(`1\n${'x'.repeat(65)}\n2\n`);
  await closed;
  t.deepEqual(calls, [1]);
});

test('parse errors, blank lines and a partial tail retain framing', async t => {
  const { socket, reader } = await setup(t, async message => ({
    result: message,
  }));
  const replies = readReplies(reader, 3);
  socket.write(' \nno-json\n{"n":');
  socket.write('1}\n{"n":2}\n');
  t.deepEqual(await replies, [
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32_700, message: 'Parse error' },
    },
    { result: { n: 1 } },
    { result: { n: 2 } },
  ]);
});

test('close drops connected peers without waiting for an outstanding host call', async t => {
  let release = () => {};
  const pending = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(release);
  let admitted = () => {};
  const admission = new Promise(resolve => {
    admitted = () => resolve(undefined);
  });
  const { socket, listener } = await setup(t, async () => {
    admitted();
    await pending;
    return { result: 'late' };
  });
  socket.write('{}\n');
  await admission;
  const closed = once(socket, 'close');
  await Promise.all([listener.close(), listener.close()]);
  await closed;
  release();
  t.true(socket.destroyed);
});
