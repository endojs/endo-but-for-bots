// @ts-check

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
 */

// Port only: the host implementation is `node/sockets.js`.
export {};
