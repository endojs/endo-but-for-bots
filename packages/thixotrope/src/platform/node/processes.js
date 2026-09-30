// @ts-check
/** @import { ProcessPowers } from '../processes.js' */
import harden from '@endo/harden';

import { makeLineReader } from './line-reader.js';

/**
 * Node's `child_process.spawn`, with each pipe surfaced as an async
 * iterable of text lines rather than a stream.
 *
 * @param {object} host
 * @param {import('child_process')} host.childProcess
 * @param {import('readline')} host.readline
 * @returns {ProcessPowers}
 */
export const makeProcessPowers = ({ childProcess, readline }) => {
  /** @type {ProcessPowers['spawn']} */
  const spawn = (executable, args, options) => {
    const stdio = options.stdio.map(entry =>
      entry && typeof entry === 'object' && 'fd' in entry ? entry.fd : entry,
    );
    const child = childProcess.spawn(executable, args, {
      ...options,
      stdio: /** @type {any} */ (stdio),
    });
    // Pipe errors are emitted independently of process exit. Subscribe before
    // returning any facets so even a closed input cannot throw in the host.
    /** @type {Promise<Error>} */
    const failed = new Promise(resolve => {
      child.once('error', resolve);
      for (const stream of child.stdio) stream?.on('error', resolve);
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
    // One reader per pipe: a second reader of the same pipe would attach a
    // second readline and split the lines between them.
    /** @type {Map<number, AsyncIterable<string>>} */
    const readers = new Map();
    /** @param {number} fd */
    const linesFrom = fd => {
      let reader = readers.get(fd);
      if (reader === undefined) {
        /** @type {import('stream').Readable | null | undefined} */
        const source = streamFor(fd);
        reader = makeLineReader(
          source ? readline.createInterface({ input: source }) : undefined,
          source ?? undefined,
        );
        readers.set(fd, reader);
      }
      return reader;
    };
    return harden({
      pid: child.pid ?? 0,
      lines: linesFrom,
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
      failed,
      kill: signal => {
        child.kill(/** @type {NodeJS.Signals} */ (signal));
      },
    });
  };
  return harden({ spawn });
};
harden(makeProcessPowers);
