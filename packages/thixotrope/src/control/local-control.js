// @ts-check
/** @import { RandomPowers } from '../platform/random.js' */
/** @import { SocketConnection, SocketPowers } from '../platform/sockets.js' */
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makePipeNetwork } from '../net/pipe-network.js';

// Local admin frames have a four-byte length, capped before allocation.
const MAX_FRAME = 8 * 1024 * 1024;
const secret = frozenBytes(new TextEncoder().encode('admin'));

/**
 * An OCapN session over a private Unix socket. Each socket has fresh client
 * tables; the fixed pipe identities authorize nothing beyond socket access.
 * @param {object} powers
 * @param {SocketPowers} powers.sockets
 * @param {RandomPowers} powers.random
 * @param {SocketConnection} socket
 * @param {'host' | 'worker'} role
 * @param {object} [admin]
 */
export const makeLocalControl = async (
  { sockets, random },
  socket,
  role,
  admin = undefined,
) => {
  let finish;
  const closed = new Promise(resolve => {
    finish = resolve;
  });
  let ended = false;
  /** @type {Awaited<ReturnType<typeof makeOcapn>> | undefined} */
  let client;
  const pipe = makePipeNetwork({
    codec: syrupCodec,
    workerId: 'local-admin-v1',
    role,
    send: bytes => {
      if (ended) return;
      if (bytes.length > MAX_FRAME) {
        socket.destroy(Error('Admin frame too large'));
        return;
      }
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, bytes.length);
      socket.write(header);
      socket.write(bytes);
    },
  });
  let target = new Uint8Array(4);
  let offset = 0;
  let header = true;
  socket.onData(bytes => {
    let cursor = 0;
    while (cursor < bytes.length && !ended) {
      const length = Math.min(target.length - offset, bytes.length - cursor);
      target.set(bytes.subarray(cursor, cursor + length), offset);
      offset += length;
      cursor += length;
      if (offset === target.length) {
        if (header) {
          const size = new DataView(target.buffer).getUint32(0);
          if (size === 0 || size > MAX_FRAME) {
            socket.destroy(Error('Invalid admin frame length'));
            return;
          }
          target = new Uint8Array(size);
        } else {
          pipe.deliver(target);
          target = new Uint8Array(4);
        }
        header = !header;
        offset = 0;
      }
    }
  });
  socket.onError(() => socket.destroy());
  socket.onClose(() => {
    ended = true;
    pipe.close();
    client?.shutdown();
    finish();
  });
  client = await makeOcapn({
    randomBytes: length => random.randomBytes(length),
    logger: harden({ log: () => {}, error: () => {}, info: () => {} }),
    codec: syrupCodec,
    network: pipe.network,
    locator: new Map(admin === undefined ? [] : [['admin', admin]]),
  });
  if (ended) client.shutdown();
  else await client.provideSession(pipe.peerLocation);
  const close = () => {
    client?.shutdown();
    pipe.close();
    socket.destroy();
  };
  return harden({
    closed,
    close,
    getAdmin: async () => {
      if (!client || ended) throw Error('Supervisor disconnected');
      const session = await client.provideSession(pipe.peerLocation);
      return E(/** @type {any} */ (session.getBootstrap())).fetch(secret);
    },
  });
};
harden(makeLocalControl);

/**
 * @param {object} powers
 * @param {SocketPowers} powers.sockets
 * @param {RandomPowers} powers.random
 * @param {string} socketPath
 */
export const connectLocalControl = async ({ sockets, random }, socketPath) => {
  const socket = sockets.connectPath(socketPath);
  const control = await makeLocalControl({ sockets, random }, socket, 'host');
  const disconnected = control.closed.then(() => {
    throw Error(
      'Supervisor disconnected; evaluation outcome may be unknown. No retry was sent.',
    );
  });
  // The disconnect can occur while the terminal is idle.
  disconnected.catch(() => {});
  try {
    const admin = await Promise.race([control.getAdmin(), disconnected]);
    return harden({
      close: control.close,
      closed: control.closed,
      /**
       * @param {string} method
       * @param {any[]} args
       */
      call: (method, ...args) =>
        Promise.race([E(admin)[method](...args), disconnected]),
    });
  } catch (error) {
    control.close();
    throw error;
  }
};
harden(connectLocalControl);
