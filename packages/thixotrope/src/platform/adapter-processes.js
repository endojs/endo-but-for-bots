// @ts-check

/**
 * A running native resource process. `send` hands it one OCapN frame;
 * `terminate` kills it and settles once it has exited, rethrowing the
 * failure that ended it, if any.
 *
 * @typedef {object} AdapterProcess
 * @property {(bytes: Uint8Array) => void} send throws once the process has
 *   disconnected; a frame it could not take is the caller's to handle
 * @property {() => Promise<void>} terminate
 * @property {Promise<void>} closed
 */

/**
 * @typedef {object} AdapterProcessStartOptions
 * @property {string} id
 * @property {string} bundlePath the stored ephemeral bundle: a CommonJS
 *   module whose exports are the entry module's namespace
 * @property {string} bundleDigest SHA-256 hex over the file's bytes, which
 *   the process verifies before loading it; a file that does not match does
 *   not run
 * @property {(bytes: Uint8Array) => void} onFrame
 * @property {() => void} onExit
 */

/**
 * Unconfined native resources, each in a host process of its own. `start`
 * settles once the process reports readiness; a process that exits first,
 * or stays silent past the host's startup timeout, rejects it instead.
 *
 * @typedef {object} AdapterProcessPowers
 * @property {(options: AdapterProcessStartOptions) => Promise<AdapterProcess>} start
 */

// Port only: the host implementation is `node/adapter-processes.js`.
export {};
