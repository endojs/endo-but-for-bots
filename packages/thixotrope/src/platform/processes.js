// @ts-check
import harden from '@endo/harden';

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
 *
 * @param {object} host
 * @param {import('child_process')} host.childProcess
 * @param {import('readline')} host.readline
 * @returns {ProcessPowers}
 */
export const makeProcessPowers = ({ childProcess, readline }) => {
  /**
   * @param {import('stream').Readable | null | undefined} source
   * @returns {AsyncIterable<string>}
   */
  const linesFrom = source => {
    let failure;
    /** @type {(value?: unknown) => void} */
    let resolveWake = () => {};
    let done = false;
    /** @type {string[]} */
    const queue = [];
    const wake = () => {
      const resolve = resolveWake;
      resolveWake = () => {};
      resolve();
    };
    if (source) {
      const lines = readline.createInterface({ input: source });
      lines.on('line', line => {
        queue.push(line);
        wake();
      });
      lines.on('close', () => {
        done = true;
        wake();
      });
      source.on('error', error => {
        failure = error;
        wake();
      });
    } else {
      done = true;
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield /** @type {string} */ (queue.shift());
          } else if (failure !== undefined) {
            throw failure;
          } else if (done) {
            return;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => {
              resolveWake = resolve;
            });
          }
        }
      },
    };
  };

  /** @type {ProcessPowers['spawn']} */
  const spawn = (executable, args, options) => {
    const stdio = options.stdio.map(entry =>
      entry && typeof entry === 'object' && 'fd' in entry ? entry.fd : entry,
    );
    const child = childProcess.spawn(executable, args, {
      ...options,
      stdio: /** @type {any} */ (stdio),
    });
    const exited = new Promise(resolve => {
      child.once('error', () => resolve(null));
      child.once('exit', code => resolve(code));
    });
    /** @param {number} fd */
    const streamFor = fd => {
      if (fd === 0) return child.stdin;
      return /** @type {any} */ (child.stdio)[fd];
    };
    return harden({
      pid: child.pid ?? 0,
      lines: fd => linesFrom(streamFor(fd)),
      input: fd => {
        const stream = streamFor(fd);
        if (!stream || typeof stream.write !== 'function') return undefined;
        return harden({
          write: text => {
            stream.write(text);
          },
          end: text => {
            stream.end(text);
          },
        });
      },
      exited,
      kill: signal => {
        child.kill(/** @type {NodeJS.Signals} */ (signal));
      },
    });
  };
  return harden({ spawn });
};
harden(makeProcessPowers);
