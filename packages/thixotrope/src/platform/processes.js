// @ts-check
/** @import { OpenFile } from './files.js' */

/**
 * A duplicated line of UTF-8 text from a child's output pipe.
 *
 * @typedef {object} ChildProcessPowers
 * @property {number} pid
 * @property {(fd: number) => AsyncIterable<string>} lines
 * @property {(fd: number) => ({ write: (text: string) => void, end: (text?: string) => void } | undefined)} input
 * @property {Promise<number | null>} exited exit code, or null when the
 *   child was signaled or failed to spawn
 * @property {(signal: string) => void} kill
 *
 * Spawn a host process. `stdio` entries name the pipes by descriptor:
 * `'pipe'`, `'inherit'`, `'ignore'`, a raw descriptor number, or an
 * {@link OpenFile} whose descriptor is passed through. Core reads text
 * lines and writes text; it never sees a process handle or stream.
 *
 * @typedef {object} ProcessPowers
 * @property {(executable: string, args: string[], options: { stdio: Array<'pipe' | 'inherit' | 'ignore' | number | OpenFile>, cwd?: string, env?: Record<string, string> }) => ChildProcessPowers} spawn
 */

// Port only: the host implementation is `node/processes.js`.
export {};
