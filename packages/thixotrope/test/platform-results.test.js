// @ts-check
import test from '@endo/ses-ava/test.js';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeFilePowers } from '../src/platform/node/files.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeSocketPowers } from '../src/platform/node/sockets.js';

const powers = makeNodePowers();

test('path powers return URL text', t => {
  const url = powers.paths.pathToFileURL('/tmp/with space');
  t.is(url, 'file:///tmp/with%20space');
  t.is(powers.paths.fileURLToPath(url), '/tmp/with space');
});

test('socket callbacks do not receive native receivers', async t => {
  const socket = new EventEmitter();
  const server = Object.assign(new EventEmitter(), {
    listen: (_path, ready) => ready(),
    close: () => {
      server.emit('close');
      return server;
    },
  });
  const sockets = makeSocketPowers({
    net: /** @type {any} */ ({
      createConnection: () => socket,
      createServer: () => server,
    }),
    chmod: async () => {},
  });
  const receivers = [];
  // Deliberately use a function to observe the event receiver.
  /** @this {unknown} */
  function recordReceiver() {
    receivers.push(this);
  }
  const connection = sockets.connectPath('fixture');
  connection.onError(recordReceiver);
  connection.onClose(recordReceiver);
  const listener = await sockets.listenPath({
    path: 'fixture',
    onConnection: () => {},
    onError: recordReceiver,
  });
  t.teardown(() => listener.close());
  socket.emit('error', Error('socket fixture'));
  socket.emit('close');
  server.emit('error', Error('server fixture'));
  t.deepEqual(receivers, [undefined, undefined, undefined]);
});

test('file powers return plain bytes and close early iteration', async t => {
  const directory = await fsp.mkdtemp(join(tmpdir(), 'thix-file-results-'));
  t.teardown(() => fsp.rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'bytes');
  await fsp.writeFile(path, new Uint8Array([1, 2, 3]));
  const bytes = await powers.files.readBytes(path);
  t.is(Object.getPrototypeOf(bytes), Uint8Array.prototype);
  t.deepEqual([...bytes], [1, 2, 3]);
  /** @type {ReturnType<typeof createReadStream> | undefined} */
  let stream;
  const files = makeFilePowers({
    fsp,
    dirname,
    createReadStream: file => {
      stream = createReadStream(file, { highWaterMark: 1 });
      return stream;
    },
  });
  t.teardown(() => stream?.destroy());
  const chunks = files.readChunks(path);
  t.deepEqual(Reflect.ownKeys(chunks), [Symbol.asyncIterator]);
  const iterator = chunks[Symbol.asyncIterator]();
  const first = await iterator.next();
  t.is(Object.getPrototypeOf(first.value), Uint8Array.prototype);
  t.deepEqual([...first.value], [1]);
  await iterator.return?.();
  t.true(stream?.destroyed);
  await t.throwsAsync(
    () =>
      files
        .readChunks(join(directory, 'missing'))
        [Symbol.asyncIterator]()
        .next(),
    {
      message: /ENOENT/,
    },
  );
});

test.serial(
  'socket powers return plain bytes and close returns nothing',
  async t => {
    t.timeout(5000);
    const directory = await fsp.mkdtemp(join(tmpdir(), 'thix-socket-results-'));
    t.teardown(() => fsp.rm(directory, { recursive: true, force: true }));
    const connections = new Set();
    let receive;
    const received = new Promise(resolve => {
      receive = resolve;
    });
    const listener = await powers.sockets.listenPath({
      path: join(directory, 'socket'),
      onConnection: connection => {
        connections.add(connection);
        connection.onError(error => t.fail(String(error)));
        connection.onData(bytes => {
          receive(bytes);
          connection.end();
        });
      },
      onError: error => t.fail(String(error)),
    });
    const client = powers.sockets.connectPath(join(directory, 'socket'));
    client.onError(error => t.fail(String(error)));
    t.teardown(async () => {
      client.destroy();
      for (const connection of connections) connection.destroy();
      listener.close();
      await listener.closed;
    });
    client.write(new Uint8Array([1, 2, 3]));
    const bytes = await received;
    t.is(Object.getPrototypeOf(bytes), Uint8Array.prototype);
    t.deepEqual([...bytes], [1, 2, 3]);
    client.destroy();
    for (const connection of connections) connection.destroy();
    t.is(listener.close(), undefined);
    await listener.closed;
  },
);

test('timer tokens expose no native methods and support cancellation', async t => {
  t.timeout(5000);
  const { timers } = powers;
  let fired = false;
  const cancelled = timers.setTimer(() => {
    fired = true;
  }, 0);
  t.teardown(() => timers.clearTimer(cancelled));
  t.deepEqual(Reflect.ownKeys(/** @type {object} */ (cancelled)), []);
  t.is(Object.getPrototypeOf(cancelled), Object.prototype);
  t.true(Object.isFrozen(cancelled));
  t.is(timers.unrefTimer?.(cancelled), undefined);
  t.is(timers.clearTimer(cancelled), undefined);
  await new Promise(resolve => {
    const token = timers.setTimer(() => resolve(undefined), 0);
    t.teardown(() => timers.clearTimer(token));
  });
  t.false(fired);
  t.is(timers.clearTimer(cancelled), undefined);
});
