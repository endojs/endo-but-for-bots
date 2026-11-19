// @ts-check
/**
 * The adapter's one atomic file write and directory fsync (HR-SYN-26).
 *
 * `writeFileAtomic(path, data, options)`: write a scratch file next to
 * `path` (`<path><scratch>`, created with `mode`), fsync it, close it,
 * rename it over `path`, fsync the directory. A SIGKILL at any step leaves
 * the old file or the new one, never neither; power loss after the rename
 * and before the directory fsync can bring the old one back, so a writer
 * whose file is a cache or can be rebuilt says so at its call with
 * `syncDirectory: false`.
 *
 * The options keep each writer's own sequence: the scratch suffix (`.tmp`,
 * `.part`), the file fsync (off for the caches, which are not fsynced at
 * all), a `chmod` of the scratch file to `mode` before the rename (the
 * process umask may have narrowed the create mode), the scratch file removed
 * when a step fails, and `trace(step)` called before each step with the
 * names the kill-point tests use: `write`, `fsync`, `rename`, `fsync-dir`.
 *
 * Scratch names are fixed, as before: every writer here has one writer per
 * path at a time (unique names are a step-3 non-goal).
 *
 * Writers that do not fit stay as they are: the blob store writes and
 * fsyncs its part files in one step and names many of them under one
 * directory fsync later (`blobs.js`, which uses `syncDirectory` from here);
 * the wrapping key is created with `link` so the first of two racing
 * creators wins (`secrets/wrapping-key.js`).
 *
 * Node only (adapter).
 */
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * fsync a directory, so a rename or link in it survives power loss.
 * @param {string} path
 */
export const syncDirectory = async path => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
harden(syncDirectory);

/**
 * @typedef {'write' | 'fsync' | 'rename' | 'fsync-dir'} WriteStep
 *
 * @typedef {object} AtomicWriteOptions
 * @property {string} [scratch] suffix of the scratch file (default `.tmp`)
 * @property {number} [mode] create mode of the scratch file (default 0600)
 * @property {boolean} [chmod] set `mode` on the scratch file before the
 *   rename (default false)
 * @property {boolean} [sync] fsync the scratch file (default true)
 * @property {boolean} [syncDirectory] fsync the directory after the rename
 *   (default true)
 * @property {boolean} [removeScratchOnError] unlink the scratch file when
 *   writing or renaming it fails (default false: the writer's next load
 *   removes it)
 * @property {(step: WriteStep) => void} [trace] called before each step
 */

/**
 * @param {string} path
 * @param {string | Uint8Array | ReadonlyArray<Uint8Array>} data an array is
 *   written with one `writev`
 * @param {AtomicWriteOptions} [options]
 */
export const writeFileAtomic = async (
  path,
  data,
  {
    scratch = '.tmp',
    mode = 0o600,
    chmod: setMode = false,
    sync = true,
    syncDirectory: syncDir = true,
    removeScratchOnError = false,
    trace = () => {},
  } = {},
) => {
  const temp = `${path}${scratch}`;
  const handle = await open(temp, 'w', mode);
  try {
    try {
      trace('write');
      if (Array.isArray(data)) await handle.writev(data);
      else await handle.writeFile(/** @type {string | Uint8Array} */ (data));
      if (sync) {
        trace('fsync');
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    if (setMode) await chmod(temp, mode);
    trace('rename');
    await rename(temp, path);
  } catch (error) {
    if (removeScratchOnError) await unlink(temp).catch(() => {});
    throw error;
  }
  if (syncDir) {
    trace('fsync-dir');
    await syncDirectory(dirname(path));
  }
};
harden(writeFileAtomic);

/**
 * fsync a directory, synchronously.
 * @param {string} path
 */
export const syncDirectorySync = path => {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
harden(syncDirectorySync);

/**
 * `writeFileAtomic` for a writer that must not yield (the secrets audit
 * log's compaction runs inside a synchronous append).
 * @param {string} path
 * @param {string} data
 * @param {Pick<AtomicWriteOptions, 'scratch' | 'mode' | 'syncDirectory'>} [options]
 */
export const writeFileAtomicSync = (
  path,
  data,
  { scratch = '.tmp', mode = 0o600, syncDirectory: syncDir = true } = {},
) => {
  const temp = `${path}${scratch}`;
  const fd = openSync(temp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  if (syncDir) syncDirectorySync(dirname(path));
};
harden(writeFileAtomicSync);
