// @ts-check
/** @import { Reader, Writer } from '@endo/stream' */
/** @import { SocketConnection, SocketPowers } from '../sockets.js' */
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

const { freeze } = Object;

const done = harden(
  /** @type {IteratorReturnResult<undefined>} */ ({
    done: true,
    value: undefined,
  }),
);
const taken = harden(
  /** @type {IteratorYieldResult<undefined>} */ ({
    done: false,
    value: undefined,
  }),
);

/**
 * Unix domain sockets on Node. `net.Socket` stays inside this module; what
 * leaves is a connection in the daemon's stream shape.
 *
 * @param {object} host
 * @param {import('net')} host.net
 * @param {(path: string, mode: number) => Promise<void>} host.chmod
 * @returns {SocketPowers}
 */
export const makeSocketPowers = ({ net, chmod }) => {
  /**
   * @param {import('net').Socket} socket
   * @returns {SocketConnection}
   */
  const wrap = socket => {
    // Every failure reaches the consumer through the reader, the pending
    // writes, and `closed`; this listener keeps one nobody is awaiting from
    // taking the host process down.
    socket.on('error', () => {});
    // Set once this side drops the socket on purpose, so the reader reports
    // the resulting premature close as an ordinary end rather than a failure.
    let dropped = false;
    /** @type {Promise<void>} */
    const closed = new Promise(resolve =>
      socket.once('close', () => resolve(undefined)),
    );
    /** @type {Promise<void>} */
    const finished = new Promise(resolve =>
      socket.once('finish', () => resolve(undefined)),
    );
    /** @param {Error} [error] */
    const drop = error => {
      dropped = true;
      socket.destroy(error);
    };
    // Node's own iterator paces the peer: it reads on demand and leaves the
    // rest in the socket's buffer.
    const chunks = socket[Symbol.asyncIterator]();
    /** @type {Reader<Uint8Array>} */
    const reader = harden({
      async next() {
        try {
          const result = await chunks.next();
          if (result.done) return done;
          // Shallow, as @endo/stream does: hardening would walk every index
          // of the chunk.
          return freeze({ done: false, value: new Uint8Array(result.value) });
        } catch (error) {
          if (dropped) return done;
          throw error;
        }
      },
      async return() {
        drop();
        return done;
      },
      async throw(error) {
        drop(error);
        return done;
      },
      [Symbol.asyncIterator]() {
        return reader;
      },
    });
    /** @type {Writer<Uint8Array>} */
    const writer = harden({
      async next(bytes) {
        // A write after `return()` must reject on its own: Node would turn
        // it into a destroy that takes the reader and unflushed bytes with it.
        (!dropped && !socket.destroyed && !socket.writableEnded) ||
          Fail`Socket is closed`;
        return new Promise((resolve, reject) => {
          // The callback fires once the host has taken the chunk, or with
          // the failure that prevented it, including a later destroy.
          socket.write(bytes, error =>
            error ? reject(error) : resolve(taken),
          );
        });
      },
      async return() {
        socket.end();
        await Promise.race([finished, closed]);
        return done;
      },
      async throw(error) {
        drop(error);
        await closed;
        return done;
      },
      [Symbol.asyncIterator]() {
        return writer;
      },
    });
    return harden({ reader, writer, closed });
  };

  return harden({
    connectPath: path => wrap(net.createConnection(path)),
    listenPath: async ({ path, mode, onConnection, onError }) => {
      const server = net.createServer();
      server.on('connection', socket => onConnection(wrap(socket)));
      let listening = false;
      await new Promise((resolve, reject) => {
        // One listener for the server's whole life: a failure to bind
        // rejects, and everything after that goes to the host's handler, so
        // there is no moment at which a failure has nowhere to go.
        server.on('error', error => {
          if (listening) onError(error);
          else reject(error);
        });
        server.listen(path, () => {
          listening = true;
          resolve(undefined);
        });
      });
      const listener = harden({
        close: () => {
          server.close();
        },
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
      return listener;
    },
  });
};
harden(makeSocketPowers);
