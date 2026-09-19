// @ts-check
/** @import { SocketPowers } from '../sockets.js' */
import harden from '@endo/harden';

/**
 * Unix domain sockets on Node. `net.Socket` stays inside this module;
 * what leaves is a plain connection object.
 *
 * @param {object} host
 * @param {import('net')} host.net
 * @param {(path: string, mode: number) => Promise<void>} host.chmod
 * @returns {SocketPowers}
 */
export const makeSocketPowers = ({ net, chmod }) => {
  /** @param {import('net').Socket} socket */
  const wrap = socket => {
    let closed = false;
    socket.once('close', () => {
      closed = true;
    });
    return harden({
      write: bytes => {
        socket.write(bytes);
      },
      end: () => {
        socket.end();
      },
      destroy: error => {
        closed = true;
        socket.destroy(/** @type {Error | undefined} */ (error));
      },
      isDestroyed: () => closed || socket.destroyed,
      onData: listener => {
        socket.on('data', listener);
      },
      onError: listener => {
        socket.on('error', listener);
      },
      onClose: listener => {
        socket.once('close', listener);
      },
    });
  };

  return harden({
    connectPath: path => wrap(net.createConnection(path)),
    listenPath: async ({ path, mode, onConnection, onError }) => {
      const server = net.createServer();
      server.on('connection', socket => onConnection(wrap(socket)));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.removeListener('error', reject);
          resolve(undefined);
        });
      });
      const listener = harden({
        close: () => server.close(),
        closed: new Promise(resolve =>
          server.once('close', () => resolve(undefined)),
        ),
      });
      if (mode !== undefined) {
        try {
          await chmod(path, mode);
        } catch (error) {
          server.close();
          throw error;
        }
      }
      server.on('error', onError);
      return listener;
    },
  });
};
harden(makeSocketPowers);
