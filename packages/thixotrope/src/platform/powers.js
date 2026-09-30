// @ts-check
/** @import { BundlerPowers } from './bundler.js' */
/** @import { DisplayPowers } from './display.js' */
/** @import { EnvironmentPowers } from './environment.js' */
/** @import { FilePowers } from './files.js' */
/** @import { HashPowers } from './hashes.js' */
/** @import { LogPowers } from './logging.js' */
/** @import { NativeWorkerPowers } from './native-workers.js' */
/** @import { PathPowers } from './paths.js' */
/** @import { ProcessPowers } from './processes.js' */
/** @import { RandomPowers } from './random.js' */
/** @import { SocketPowers } from './sockets.js' */
/** @import { SyncFilePowers } from './sync-files.js' */
/** @import { TerminalPowers } from './terminal.js' */
/** @import { TimerPowers } from './timers.js' */

/**
 * Everything a host composes for the supervisor and the command line: one
 * record of ports. Core names this contract and never a host module; a host
 * that is not Node supplies the same record from its own implementations.
 *
 * @typedef {object} PlatformPowers
 * @property {TimerPowers} timers
 * @property {RandomPowers} random
 * @property {LogPowers} logging
 * @property {PathPowers} paths
 * @property {FilePowers} files
 * @property {SyncFilePowers} syncFiles
 * @property {ProcessPowers} processes
 * @property {NativeWorkerPowers} nativeWorkers
 * @property {SocketPowers} sockets
 * @property {TerminalPowers} terminal
 * @property {HashPowers} hashes
 * @property {EnvironmentPowers} environment
 * @property {DisplayPowers} display
 * @property {BundlerPowers} bundler
 */

// Port only: the Node composition is `node/powers.js`.
export {};
