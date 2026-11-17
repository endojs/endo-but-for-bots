// @ts-check
/**
 * An in-memory `SyncFilePowers` for store tests: a map from path to text,
 * with every durable operation counted and an optional fault before or
 * inside it.
 *
 * `fault(op, path, text)` is asked before each `writeTextAtomic` and
 * `appendTextDurable`; it returns `undefined` to let the operation run,
 * `'throw'` to fail it with nothing written, or a number n for an append to
 * write only the first n characters and then fail (a torn append). An atomic
 * write is all or nothing, as rename makes it.
 */
import harden from '@endo/harden';

/** @import { SyncFilePowers } from '../src/platform/sync-files.js' */

/**
 * @param {object} [options]
 * @param {(op: 'replace' | 'append', path: string, text: string) => (undefined | 'throw' | number)} [options.fault]
 */
export const makeMemorySyncFiles = ({ fault = () => undefined } = {}) => {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Array<{ op: string, path: string, chars: number }>} */
  const operations = [];
  /** @param {string} path */
  const missing = path => {
    const error = /** @type {any} */ (Error(`ENOENT: ${path}`));
    error.code = 'ENOENT';
    return error;
  };
  /** @type {SyncFilePowers} */
  const syncFiles = harden({
    readText: (/** @type {string} */ path) => {
      const text = files.get(path);
      if (text === undefined) throw missing(path);
      return text;
    },
    exists: (/** @type {string} */ path) => files.has(path),
    writeTextAtomic: (
      /** @type {string} */ path,
      /** @type {string} */ text,
    ) => {
      const decision = fault('replace', path, text);
      if (decision !== undefined) throw Error('injected replace failure');
      files.set(path, text);
      operations.push({ op: 'replace', path, chars: text.length });
    },
    appendTextDurable: (
      /** @type {string} */ path,
      /** @type {string} */ text,
    ) => {
      const decision = fault('append', path, text);
      if (decision === 'throw') throw Error('injected append failure');
      if (typeof decision === 'number') {
        files.set(path, (files.get(path) ?? '') + text.slice(0, decision));
        throw Error('injected torn append');
      }
      files.set(path, (files.get(path) ?? '') + text);
      operations.push({ op: 'append', path, chars: text.length });
    },
    makeDirectory: () => {},
    listDirectory: (/** @type {string} */ path) =>
      [...files.keys()]
        .filter(p => p.startsWith(`${path}/`))
        .map(p => p.slice(path.length + 1).split('/')[0]),
    remove: (/** @type {string} */ path) => {
      files.delete(path);
    },
    stat: () => harden({ kind: /** @type {const} */ ('file'), mode: 0o600 }),
    isPrivateToUser: () => true,
  });
  return { syncFiles, files, operations };
};
harden(makeMemorySyncFiles);
