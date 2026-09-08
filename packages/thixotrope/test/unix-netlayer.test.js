// @ts-check
import test from '@endo/ses-ava/test.js';
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import {
  assertUnixPeerLocation,
  makeUnixNetLayer,
} from '../src/unix-netlayer.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { SocketOperations } from '@endo/ocapn/client/types' */

const makeSignal = () => {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise(done => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
};
const logger = { log() {}, info() {}, error() {} };
/** @param {ExecutionContext} t */
const setup = async t => {
  const path = await mkdtemp('/tmp/thix-unix-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  const socketPath = join(path, 'peer.sock');
  /** @type {Uint8Array[]} */
  const frames = [];
  const received = makeSignal();
  const receivedTwo = makeSignal();
  const closed = makeSignal();
  const handlers = {
    /**
     * @param {any} netlayer
     * @param {boolean} isOutgoing
     * @param {SocketOperations} ops
     */
    makeConnection(netlayer, isOutgoing, ops) {
      let destroyed = false;
      return {
        netlayer,
        isOutgoing,
        get isDestroyed() {
          return destroyed;
        },
        write: ops.write,
        end() {
          destroyed = true;
          ops.end();
        },
      };
    },
    /**
     * @param {any} connection
     * @param {Uint8Array} bytes
     */
    handleMessageData(connection, bytes) {
      frames.push(bytes);
      received.resolve();
      if (frames.length === 2) receivedTwo.resolve();
    },
    handleConnectionClose() {
      closed.resolve();
    },
  };
  const layer = await makeUnixNetLayer({
    socketPath,
    handlers: /** @type {any} */ (handlers),
    logger,
  });
  t.teardown(() => layer.shutdown());
  return {
    path,
    socketPath,
    layer,
    frames,
    received,
    receivedTwo,
    closed,
    handlers,
  };
};

/** @param {number[]} payload */
const frame = payload => {
  const bytes = new Uint8Array(4 + payload.length);
  new DataView(bytes.buffer).setUint32(0, payload.length);
  bytes.set(payload, 4);
  return bytes;
};

test.serial(
  'Unix transport frames split headers and payloads and coalesced messages',
  async t => {
    t.timeout(10_000);
    const { socketPath, frames, received, closed } = await setup(t);
    t.is((await stat(socketPath)).mode % 0o1000, 0o600);
    const socket = createConnection(socketPath);
    t.teardown(() => socket.destroy());
    await once(socket, 'connect');
    const first = frame([11, 12, 13]);
    for (const byte of first.subarray(0, 6)) {
      socket.write(new Uint8Array([byte]));
      // Separate writes intentionally exercise fragmented delivery.
      // eslint-disable-next-line no-await-in-loop
      await setImmediate();
    }
    const rest = new Uint8Array([first[6], ...frame([21, 22]), ...frame([31])]);
    socket.end(rest);
    await received.promise;
    await closed.promise;
    t.deepEqual(
      frames.map(bytes => [...bytes]),
      [[11, 12, 13], [21, 22], [31]],
    );
  },
);

for (const size of [0, 1024 * 1024 + 1, 0xffff_ffff]) {
  test.serial(
    `Unix transport rejects frame length ${size} before allocation or delivery`,
    async t => {
      t.timeout(10_000);
      const { socketPath, frames, closed } = await setup(t);
      const socket = createConnection(socketPath);
      t.teardown(() => socket.destroy());
      await once(socket, 'connect');
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, size);
      socket.write(header);
      await closed.promise;
      t.deepEqual(frames, []);
    },
  );
}

test.serial(
  'Unix transport discards incomplete payload on disconnect',
  async t => {
    t.timeout(10_000);
    const { socketPath, frames, closed } = await setup(t);
    const socket = createConnection(socketPath);
    t.teardown(() => socket.destroy());
    await once(socket, 'connect');
    socket.end(frame([1, 2, 3]).subarray(0, 6));
    await closed.promise;
    t.deepEqual(frames, []);
  },
);

test.serial(
  'Unix transport reconnects after close and never unlinks a successor',
  async t => {
    t.timeout(10_000);
    const sender = await setup(t);
    const receiver = await setup(t);
    const first = await sender.layer.connect(receiver.layer.location);
    first.write(new Uint8Array([42]));
    await receiver.received.promise;
    first.end();
    await sender.closed.promise;
    receiver.layer.shutdown();
    const successor = await makeUnixNetLayer({
      socketPath: receiver.socketPath,
      handlers: /** @type {any} */ (receiver.handlers),
      logger,
    });
    t.teardown(() => successor.shutdown());
    await receiver.layer.closed;
    receiver.layer.shutdown();
    t.true((await stat(receiver.socketPath)).isSocket());
    const second = await sender.layer.connect(successor.location);
    t.not(first, second);
    second.write(new Uint8Array([43]));
    await receiver.receivedTwo.promise;
    t.deepEqual(
      receiver.frames.map(bytes => [...bytes]),
      [[42], [43]],
    );
  },
);

test.serial(
  'Unix transport validates destinations, write limits, and shutdown',
  async t => {
    t.timeout(10_000);
    const { layer } = await setup(t);
    t.throws(
      () => layer.connect({ ...layer.location, network: 'tcp-testing-only' }),
      { message: /Invalid Unix peer/ },
    );
    t.throws(
      () => layer.connect({ ...layer.location, designator: 'relative.sock' }),
      { message: /Invalid Unix peer/ },
    );
    const connection = await layer.connect(layer.location);
    t.throws(() => connection.write(new Uint8Array(1024 * 1024 + 1)), {
      message: /Invalid Unix frame length/,
    });
    layer.shutdown();
    t.throws(() => layer.connect(layer.location), { message: /shut down/ });
    t.throws(() => connection.write(new Uint8Array([1])), {
      message: /closed/,
    });
  },
);

test.serial(
  'Unix transport refuses public directories and preserves occupied paths',
  async t => {
    t.timeout(10_000);
    const { path, handlers } = await setup(t);
    const socketPath = join(path, 'occupied');
    await writeFile(socketPath, 'keep me');
    const options = {
      socketPath,
      handlers: /** @type {any} */ (handlers),
      logger,
    };
    await t.throwsAsync(() => makeUnixNetLayer(options), {
      code: 'EADDRINUSE',
    });
    t.is(await readFile(socketPath, 'utf8'), 'keep me');
    await chmod(path, 0o755);
    await t.throwsAsync(
      () => makeUnixNetLayer({ ...options, socketPath: join(path, 'new') }),
      { message: /private and owned/ },
    );
  },
);

test.serial(
  'Unix transport refuses unsafe destinations before connecting',
  async t => {
    t.timeout(10_000);
    const { layer, path } = await setup(t);
    for (const location of [
      null,
      {},
      { ...layer.location, transport: 'other' },
      { ...layer.location, designator: `/tmp/${'a'.repeat(104)}` },
      { ...layer.location, designator: `${path}/bad\0.sock` },
    ]) {
      t.throws(() => assertUnixPeerLocation(location), {
        message: /Invalid Unix peer location/,
      });
    }
    // The shared temporary directory is not private and / is owned by root.
    // Neither is permitted as a bearer-token destination, even before dialing.
    for (const designator of ['/tmp/unsafe.sock', '/unsafe.sock']) {
      const location = { ...layer.location, designator };
      t.throws(() => assertUnixPeerLocation(location), {
        message: /private and owned/,
      });
      t.throws(() => layer.connect(location), { message: /private and owned/ });
    }
    await chmod(path, 0o755);
    t.throws(() => layer.connect(layer.location), {
      message: /private and owned/,
    });
  },
);

test.serial(
  'Unix base transport never shares a stream between logical sessions',
  async t => {
    t.timeout(10_000);
    const { layer } = await setup(t);
    const canonical = assertUnixPeerLocation({
      ...layer.location,
      hints: { ignored: 'alias' },
    });
    t.deepEqual(canonical, layer.location);
    const first = await layer.connect(layer.location);
    const second = await layer.connect({
      ...layer.location,
      hints: { ignored: 'alias' },
    });
    t.not(first, second);
    first.end();
    t.false(second.isDestroyed);
  },
);
