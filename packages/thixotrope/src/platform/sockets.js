// @ts-check
import harden from '@endo/harden';

/**
 * A byte-oriented connection. Writes are fire-and-forget; `onData` may
 * deliver fragments in any alignment. `isDestroyed` lets a writer avoid
 * queueing frames for a peer the host already dropped.
 *
 * @typedef {object} SocketConnection
 * @property {(bytes: Uint8Array) => void} write
 * @property {() => void} end
 * @property {(error?: unknown) => void} destroy
 * @property {() => boolean} isDestroyed
 * @property {(listener: (bytes: Uint8Array) => void) => void} onData
 * @property {(listener: (error: unknown) => void) => void} onError
 * @property {(listener: () => void) => void} onClose
 *
 * @typedef {object} SocketListener
 * @property {() => void} close stop accepting, without waiting
 * @property {Promise<void>} closed resolves once the listener is closed
 *
 * Path-addressed stream sockets: Unix domain sockets on Node, named pipes
 * or equivalent elsewhere. Return values are generic connection objects,
 * never host socket types.
 *
 * @typedef {object} SocketPowers
 * @property {(path: string) => SocketConnection} connectPath
 * @property {(options: { path: string, mode?: number, onConnection: (connection: SocketConnection) => void, onError: (error: unknown) => void }) => Promise<SocketListener>} listenPath
 *   bind `path`; when `mode` is given the implementation applies those
 *   permission bits to the bound endpoint before resolving
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
