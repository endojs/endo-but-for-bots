// @ts-check

/**
 * A running native resource process. `send` hands it one OCapN frame;
 * `terminate` kills it and settles once it has exited, rethrowing the
 * failure that ended it, if any.
 *
 * @typedef {object} NativeWorker
 * @property {(bytes: Uint8Array) => void} send throws once the process has
 *   disconnected; a frame it could not take is the caller's to handle
 * @property {() => Promise<void>} terminate
 * @property {Promise<void>} closed
 */

/**
 * @typedef {object} NativeWorkerStartOptions
 * @property {string} id
 * @property {string} moduleUrl
 * @property {{ directory: string, digest: string }} [resourceIdentity] the
 *   installed directory the process must verify before importing `moduleUrl`
 * @property {(bytes: Uint8Array) => void} onFrame
 * @property {() => void} onExit
 */

/**
 * Unconfined native resources, each in a host process of its own. `start`
 * settles once the process reports readiness; a process that exits first,
 * or stays silent past the host's startup timeout, rejects it instead.
 *
 * @typedef {object} NativeWorkerPowers
 * @property {(options: NativeWorkerStartOptions) => Promise<NativeWorker>} start
 */

// Port only: the host implementation is `node/native-workers.js`.
export {};
