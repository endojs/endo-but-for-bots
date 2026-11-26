// @ts-check
// An in-memory host for acquireIronhorseRuntime: a fake lock helper that
// speaks the ownership protocol and a fake file system. The Rust worker is
// never spawned; test/ironhorse covers the same policy with built workers.
import harden from '@endo/harden';
import { createHash } from 'node:crypto';

import { makeHashPowers } from '../src/platform/node/hashes.js';

/** @import { FilePowers } from '../src/platform/files.js' */
/** @import { PathPowers } from '../src/platform/paths.js' */
/** @import { ProcessPowers } from '../src/platform/processes.js' */

export const statePath = 'state';
export const workerBinary = 'bin/worker';
export const bootPaths = harden(['boot/main.js']);
export const manifestPath = `${statePath}/runtime.json`;
export const nativeLocked = '{"op":"locked"}';

const unused = () => {
  throw Error('unused by the runtime under test');
};

/** @param {string} path */
const enoent = path =>
  Object.assign(Error(`ENOENT: ${path}`), { code: 'ENOENT' });

/**
 * @param {object} [options]
 * @param {string} [options.locked] the helper's first stderr line
 * @param {Record<string, string>} [options.extraFiles] more file contents
 * @param {(from: string, to: string) => void} [options.onCopy] runs after
 * each copy, before the copy is hashed
 */
export const makeFakeHost = ({
  locked = nativeLocked,
  extraFiles = {},
  onCopy = () => {},
} = {}) => {
  /** @type {Map<string, string>} */
  const texts = new Map([
    [workerBinary, 'worker bytes'],
    [bootPaths[0], 'bootstrap bytes'],
    ...Object.entries(extraFiles),
  ]);
  /** @type {Set<string>} */
  const directories = new Set();
  // What the runtime did, in order: `read <path>` for every hash input,
  // `copy <to>`, `write <path>`, `prepare` and `release`.
  /** @type {string[]} */
  const events = [];
  const state = { locked };
  /** @param {string} path */
  const read = path => {
    const text = texts.get(path);
    if (text === undefined) throw enoent(path);
    return text;
  };
  /** @type {FilePowers} */
  const files = {
    readText: async path => read(path),
    readBytes: unused,
    readChunks: async function* readChunks(path) {
      events.push(`read ${path}`);
      yield new TextEncoder().encode(read(path));
    },
    writeTextAtomic: async (path, text) => {
      events.push(`write ${path}`);
      texts.set(path, text);
    },
    makeDirectory: async path => {
      directories.add(path);
    },
    makeTempDirectory: unused,
    listDirectory: async path => {
      if (!directories.has(path)) throw enoent(path);
      const prefix = `${path}/`;
      const names = [...texts.keys(), ...directories]
        .filter(entry => entry.startsWith(prefix))
        .map(entry => entry.slice(prefix.length).split('/')[0]);
      return [...new Set(names)];
    },
    rename: async (from, to) => {
      texts.set(to, read(from));
      texts.delete(from);
    },
    remove: async path => {
      texts.delete(path);
    },
    copyFile: async (from, to) => {
      events.push(`copy ${to}`);
      texts.set(to, read(from));
      onCopy(from, to);
    },
    realPath: unused,
    stat: unused,
    isPrivateToUser: async () => true,
    open: async () => ({
      fd: undefined,
      writeText: async () => {},
      sync: async () => {},
      close: async () => {},
    }),
    syncPath: async () => {},
  };
  /** @type {ProcessPowers} */
  const processes = {
    spawn: () => {
      const queue = [state.locked];
      let ended = false;
      /** @type {(() => void) | undefined} */
      let wake;
      /** @type {(code: number) => void} */
      let exit = () => {};
      /** @type {Promise<number | null>} */
      const exited = new Promise(resolve => {
        exit = resolve;
      });
      const notify = () => {
        const waiter = wake;
        wake = undefined;
        waiter?.();
      };
      async function* lines() {
        await null;
        for (;;) {
          const line = queue.shift();
          if (line !== undefined) {
            yield line;
          } else if (ended) {
            return;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => {
              wake = () => resolve(undefined);
            });
          }
        }
      }
      return {
        pid: 1,
        lines,
        input: () => ({
          write: text => {
            if (text === 'prepare\n') {
              events.push('prepare');
              queue.push('{"op":"ready"}');
            }
            notify();
          },
          end: () => {
            if (!ended) events.push('release');
            ended = true;
            notify();
            exit(0);
          },
        }),
        exited,
        failed: new Promise(() => {}),
        kill: () => {},
      };
    },
  };
  /** @type {PathPowers} */
  const paths = {
    join: (...parts) => parts.join('/'),
    dirname: unused,
    basename: path => path.slice(path.lastIndexOf('/') + 1),
    resolve: unused,
    isAbsolute: path => path.startsWith('/'),
    fileURLToPath: unused,
    pathToFileURL: unused,
  };
  const hashes = makeHashPowers({ createHash, readChunks: files.readChunks });
  return harden({
    powers: { processes, files, paths, hashes },
    texts,
    /** @returns {string[]} */
    events: () => [...events],
    /** @param {string} line the next helper's first stderr line */
    setLocked: line => {
      state.locked = line;
    },
  });
};
harden(makeFakeHost);
