// @ts-check
/**
 * The secrets wrapping key: one 32-byte file outside the state directory
 * (architecture D-6; `designs/m2-interfaces.md` 9.1), the one loader and
 * the one failure policy for every user of it: the Secrets store, the
 * sealing keys (`seal.js`) and the gateway's sign-in file
 * (`gateway/signin.js`).
 *
 * The file is refused inside the state directory, when it is not 32 bytes,
 * and when its mode lets the group or others read it; it is created 0600 if
 * absent, whole or not at all.
 *
 * `makeWrappingKey` is made once per adapter incarnation (`impl/index.js`)
 * and handed to the store and the sealing keys: one load, shared while in
 * flight and kept once it succeeds; a failed load is not kept, the next
 * `get()` tries again (HR-SYN-5).
 *
 * Node only (adapter, operator scripts).
 */
import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { syncDirectory } from '../files.js';

const KEY_BYTES = 32;

/**
 * @param {string} child
 * @param {string} parent
 */
const isInside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Create the key file whole or not at all: random bytes in a temp file
 * (0600), fsynced, linked into place (fails if another got there first,
 * whose key then wins), the directory fsynced. A SIGKILL leaves at most a
 * temp file, never an empty key file.
 * @param {string} keyFile
 */
const createWrappingKey = async keyFile => {
  const dir = dirname(keyFile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${keyFile}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(randomBytes(KEY_BYTES));
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created = true;
  try {
    await link(temp, keyFile);
  } catch (error) {
    if (/** @type {any} */ (error).code !== 'EEXIST') throw error;
    created = false;
  } finally {
    await unlink(temp).catch(() => {});
  }
  await syncDirectory(dir);
  return created;
};

/**
 * @param {{ keyFile: string, stateDir?: string }} options
 * @returns {Promise<Buffer>}
 */
const readWrappingKey = async ({ keyFile, stateDir }) => {
  if (!isAbsolute(keyFile))
    throw Error('the secrets key file path must be absolute');
  if (stateDir !== undefined && isInside(keyFile, stateDir))
    throw Error('the secrets key file must be outside the state directory');
  let created = false;
  try {
    await stat(keyFile);
  } catch (error) {
    if (/** @type {any} */ (error).code !== 'ENOENT') throw error;
    created = await createWrappingKey(keyFile);
  }
  const info = await stat(keyFile);
  // eslint-disable-next-line no-bitwise
  if (!created && (info.mode & 0o077) !== 0)
    throw Error('the secrets key file must not be readable by group or others');
  const key = await readFile(keyFile);
  if (key.length !== KEY_BYTES)
    throw Error('the secrets key file must hold exactly 32 bytes');
  return key;
};

/** @type {Map<string, Promise<Buffer>>} */
const keyLoads = new Map();

/**
 * Read the wrapping key, creating it (0600, exclusive) if absent. Loads of
 * one key file in flight at once share one read (the store and the sealing
 * keys ask together on a fresh file, J-9486); nothing is kept once it
 * settles.
 *
 * @param {object} options
 * @param {string} options.keyFile
 * @param {string} [options.stateDir] refuse a key file inside it
 * @returns {Promise<Buffer>}
 */
export const loadWrappingKey = ({ keyFile, stateDir }) => {
  const known = keyLoads.get(keyFile);
  if (known !== undefined) return known;
  const loading = readWrappingKey({ keyFile, stateDir });
  keyLoads.set(keyFile, loading);
  const done = () => keyLoads.delete(keyFile);
  void loading.then(done, done);
  return loading;
};
harden(loadWrappingKey);

/**
 * @typedef {object} WrappingKey
 * @property {() => Promise<Buffer>} get the key: loaded once, kept once
 *   loaded; a failure is not kept, the next call loads again
 */

/**
 * @param {object} options
 * @param {string} options.keyFile
 * @param {string} [options.stateDir] refuse a key file inside it
 * @returns {WrappingKey}
 */
export const makeWrappingKey = ({ keyFile, stateDir }) => {
  /** @type {Promise<Buffer> | undefined} */
  let loading;
  const get = () => {
    if (loading === undefined) {
      const attempt = loadWrappingKey({ keyFile, stateDir });
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = undefined;
      });
    }
    return loading;
  };
  return harden({ get });
};
harden(makeWrappingKey);
