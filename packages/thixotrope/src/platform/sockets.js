// @ts-check
/** @import { Reader, Writer } from '@endo/stream' */

/**
 * A byte-oriented connection in the shape the Endo daemon uses: a
 * pull-based reader, a writer whose `next` resolves once the host has
 * taken the chunk (so a producer that awaits it is paced by the peer), and
 * a `closed` promise. Chunks arrive in any alignment; framing is the
 * consumer's job.
 *
 * Failure reaches the consumer through the streams — the reader rejects
 * and every pending write rejects — and through `closed` resolving, never
 * through an event a late listener could miss: the host is listening
 * before the connection is handed out.
 *
 * - `writer.return()` ends the write side and resolves once this side has
 *   flushed or the connection has closed.
 * - `writer.throw(error)` drops the connection at once, taking pending
 *   reads and writes down with it.
 * - `reader.return()` also drops the connection, as the iterator of a
 *   Node.js readable does: a consumer that stops reading is done with the
 *   peer. A drop from this side ends the reader without an error.
 *
 * @typedef {object} SocketConnection
 * @property {Reader<Uint8Array>} reader
 * @property {Writer<Uint8Array>} writer
 * @property {Promise<void>} closed resolves once the host has released the
 *   connection, however it ended
 */

/**
 * @typedef {object} SocketListener
 * @property {() => void} close stop accepting, without waiting
 * @property {Promise<void>} closed resolves once the listener is closed
 */

/**
 * Path-addressed stream sockets: Unix domain sockets on Node, named pipes
 * or equivalent elsewhere. Return values are generic connection objects,
 * never host socket types.
 *
 * @typedef {object} SocketPowers
 * @property {(path: string) => SocketConnection} connectPath dial `path`; a
 *   failure to connect surfaces through the connection's streams
 * @property {(options: { path: string, mode?: number, onConnection: (connection: SocketConnection) => void, onError: (error: unknown) => void }) => Promise<SocketListener>} listenPath
 *   bind `path`; when `mode` is given the implementation applies those
 *   permission bits to the bound endpoint before resolving. A failure to
 *   bind rejects; every later listener failure goes to `onError`
 */

// Port only: the host implementation is `node/sockets.js`.
export {};
