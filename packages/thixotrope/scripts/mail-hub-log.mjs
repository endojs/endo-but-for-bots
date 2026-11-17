// @ts-check
// Disposable benchmark experiment, not a production store format.
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

/** @import { SyncFilePowers } from '../src/platform/sync-files.js' */

/**
 * Store full hub snapshots in a bounded append log. Each append still fsyncs;
 * only creation, repair, and compaction replace and sync a directory entry.
 * Never use this wrapper to open the user's normal daemon state.
 * @param {SyncFilePowers} files
 * @param {{maxEntries?: number, maxCharacters?: number}} [options]
 * @returns {SyncFilePowers}
 */
export const makeMailHubLog = (
  files,
  { maxEntries = 64, maxCharacters = 4_000_000 } = {},
) => {
  const logs = new Map();
  /** @param {string} path */
  const load = path => {
    const log = `${path}.experiment-log`;
    if (!files.exists(log)) return undefined;
    const text = files.readText(log);
    const end = text.lastIndexOf('\n') + 1;
    end > 0 || Fail`Missing complete hub log record`;
    const complete = text.slice(0, end);
    const entries = complete.slice(0, -1).split('\n');
    for (const entry of entries) JSON.parse(entry);
    if (end !== text.length) files.writeTextAtomic(log, complete);
    const state = {
      log,
      count: entries.length,
      characters: complete.length,
      last: `${entries.at(-1)}\n`,
    };
    logs.set(path, state);
    return state;
  };
  return harden({
    ...files,
    exists: path =>
      files.exists(path) ||
      (path.endsWith('/hub.json') && files.exists(`${path}.experiment-log`)),
    readText: path =>
      path.endsWith('/hub.json')
        ? (load(path)?.last ?? files.readText(path))
        : files.readText(path),
    writeTextAtomic: (path, text, options) => {
      if (!path.endsWith('/hub.json'))
        return files.writeTextAtomic(path, text, options);
      // Validate before touching disk. A newline is the commit record boundary.
      JSON.parse(text);
      text.endsWith('\n') || Fail`Hub log record needs a newline`;
      const state = logs.get(path) ?? load(path);
      const log = `${path}.experiment-log`;
      try {
        if (
          !state ||
          state.count >= maxEntries ||
          state.characters + text.length > maxCharacters
        ) {
          files.writeTextAtomic(log, text, options);
          logs.set(path, {
            log,
            count: 1,
            characters: text.length,
            last: text,
          });
        } else {
          files.appendTextDurable(log, text);
          state.count += 1;
          state.characters += text.length;
          state.last = text;
        }
      } catch (error) {
        // An interrupted append must be repaired before another one can join it.
        logs.delete(path);
        throw error;
      }
    },
  });
};
harden(makeMailHubLog);
