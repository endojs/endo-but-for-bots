// @ts-check
/**
 * The secrets wrapping key: one 32-byte file outside the state directory
 * (architecture D-6; `designs/m2-interfaces.md` 9.1), the one loader and
 * the one failure policy for every user of it: the Secrets store, the
 * sealing keys (`seal.js`) and the gateway's sign-in file
 * (`gateway/signin.js`).
 *
 * The file is refused inside the state directory, when it is not 32 bytes,
 * and when its mode lets the group or others read it.
 *
 * Fail closed (Tokyo plan 4.2): a missing key file is created (0600, whole
 * or not at all) only on the first run of a state, when none of the files
 * sealed with the key (`sealedStateFiles`) exists yet, or by an explicit
 * `initWrappingKey`. A missing key with any sealed file present, a key file
 * that cannot be read, a load with no state directory to check, and a key
 * in a read-only location (a systemd credential under
 * `$CREDENTIALS_DIRECTORY`) are refusals that name the key path and change
 * nothing: a new key would make every sealed file unreadable for good.
 *
 * `makeWrappingKey` is made once per adapter incarnation (`impl/index.js`)
 * and handed to the store and the sealing keys: one load, shared while in
 * flight and kept once it succeeds; a failed load is not kept, the next
 * `get()` tries again (HR-SYN-5).
 *
 * Node only (adapter, operator scripts).
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
 * The files of a state directory that are sealed with the wrapping key: the
 * Secrets store, its audit log and the gateway's sign-in secret. While any
 * of them exists, a missing key is never replaced.
 * @param {string} stateDir
 */
export const sealedStateFiles = stateDir => {
  const state = resolve(stateDir);
  return harden([
    join(state, 'agent-host', 'secrets.enc'),
    join(state, 'agent-host', 'secrets-audit.log'),
    join(state, 'agent-host', 'gateway', 'signin.enc'),
  ]);
};
harden(sealedStateFiles);

/**
 * True when `keyFile` is under the systemd credentials directory named by
 * `env.CREDENTIALS_DIRECTORY` (`LoadCredential=`): read-only, never written.
 * @param {string} keyFile
 * @param {Record<string, string | undefined>} env
 */
export const isCredentialPath = (keyFile, env) => {
  const dir = env.CREDENTIALS_DIRECTORY;
  return (
    typeof dir === 'string' &&
    isAbsolute(dir) &&
    isAbsolute(keyFile) &&
    resolve(keyFile) !== resolve(dir) &&
    isInside(keyFile, dir)
  );
};
harden(isCredentialPath);

/** @param {unknown} error */
const codeOf = error => /** @type {any} */ (error)?.code;

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
const exists = async path => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    // Unknown is not "absent": refuse rather than mint over it.
    return true;
  }
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
    if (codeOf(error) !== 'EEXIST') throw error;
    created = false;
  } finally {
    await unlink(temp).catch(() => {});
  }
  await syncDirectory(dir);
  return created;
};

/**
 * @typedef {object} KeyOptions
 * @property {string} keyFile absolute
 * @property {string} [stateDir] the state the key seals: a key file inside
 *   it is refused, and a missing key is created only while it holds none of
 *   `sealedStateFiles`; without it a missing key is refused
 * @property {boolean} [readOnly] the key file is in a read-only location
 *   (`isCredentialPath`): never created, never written
 */

/** @param {KeyOptions} options */
const checkKeyPath = ({ keyFile, stateDir }) => {
  if (!isAbsolute(keyFile))
    throw Error('the secrets key file path must be absolute');
  if (stateDir !== undefined && isInside(keyFile, stateDir))
    throw Error('the secrets key file must be outside the state directory');
};

/**
 * Whether the key file exists; any failure but ENOENT is a refusal.
 * @param {string} keyFile
 */
const keyPresent = async keyFile => {
  try {
    await stat(keyFile);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw Error(
      `the secrets key file ${keyFile} cannot be read (${codeOf(error) ?? 'error'}); refusing to continue without it`,
      { cause: error },
    );
  }
};

/**
 * The sealed files `stateDir` already holds.
 * @param {string} stateDir
 */
const sealedPresent = async stateDir => {
  const files = sealedStateFiles(stateDir);
  const present = await Promise.all(files.map(exists));
  return files.filter((_file, at) => present[at]);
};

/**
 * @param {KeyOptions} options
 * @returns {Promise<Buffer>}
 */
const readWrappingKey = async ({ keyFile, stateDir, readOnly = false }) => {
  checkKeyPath({ keyFile, stateDir });
  let created = false;
  if (!(await keyPresent(keyFile))) {
    if (readOnly)
      throw Error(
        `the secrets key file ${keyFile} is missing from the read-only credentials directory; check the unit's LoadCredential= source`,
      );
    if (stateDir === undefined)
      throw Error(
        `the secrets key file ${keyFile} is missing and no state directory shows this is a first run; refusing to create a key`,
      );
    const sealed = await sealedPresent(stateDir);
    if (sealed.length > 0)
      throw Error(
        `the secrets key file ${keyFile} is missing, but ${resolve(stateDir)} already holds files sealed with a key (${sealed.map(file => relative(resolve(stateDir), file)).join(', ')}); refusing to create a new key, which would make them unreadable: restore the key file from its backup`,
      );
    created = await createWrappingKey(keyFile);
  }
  /** @type {import('node:fs').Stats} */
  let info;
  /** @type {Buffer} */
  let key;
  try {
    info = await stat(keyFile);
    key = await readFile(keyFile);
  } catch (error) {
    throw Error(
      `the secrets key file ${keyFile} cannot be read (${codeOf(error) ?? 'error'}); refusing to continue without it`,
      { cause: error },
    );
  }
  // eslint-disable-next-line no-bitwise
  if (!created && (info.mode & 0o077) !== 0)
    throw Error('the secrets key file must not be readable by group or others');
  if (key.length !== KEY_BYTES)
    throw Error('the secrets key file must hold exactly 32 bytes');
  return key;
};

/** @type {Map<string, Promise<Buffer>>} */
const keyLoads = new Map();

/**
 * Read the wrapping key; create it (0600, exclusive) only on a state's
 * first run (see the header). Loads of one key file with the same options
 * in flight at once share one read (the store and the sealing keys ask
 * together on a fresh file, J-9486); nothing is kept once it settles.
 *
 * @param {KeyOptions} options
 * @returns {Promise<Buffer>}
 */
export const loadWrappingKey = ({ keyFile, stateDir, readOnly = false }) => {
  const id = JSON.stringify([keyFile, stateDir ?? null, readOnly]);
  const known = keyLoads.get(id);
  if (known !== undefined) return known;
  const loading = readWrappingKey({ keyFile, stateDir, readOnly });
  keyLoads.set(id, loading);
  const done = () => keyLoads.delete(id);
  void loading.then(done, done);
  return loading;
};
harden(loadWrappingKey);

/**
 * The explicit key initialisation (operator scripts): create `keyFile`
 * (0600, exclusive). Refuses when the key file exists (never overwritten),
 * when it is read-only, and when `stateDir` already holds sealed files (a
 * new key cannot open them; the operator moves them aside first).
 *
 * @param {KeyOptions} options
 * @returns {Promise<void>}
 */
export const initWrappingKey = async ({
  keyFile,
  stateDir,
  readOnly = false,
}) => {
  checkKeyPath({ keyFile, stateDir });
  if (readOnly)
    throw Error(
      `the secrets key file ${keyFile} is in a read-only location; create it at the credential's source instead`,
    );
  if (await keyPresent(keyFile))
    throw Error(
      `the secrets key file ${keyFile} already exists; refusing to replace it`,
    );
  if (stateDir !== undefined) {
    const sealed = await sealedPresent(stateDir);
    if (sealed.length > 0)
      throw Error(
        `${resolve(stateDir)} already holds files sealed with another key (${sealed.map(file => relative(resolve(stateDir), file)).join(', ')}); a new key cannot open them`,
      );
  }
  if (!(await createWrappingKey(keyFile)))
    throw Error(
      `the secrets key file ${keyFile} was created by another process meanwhile`,
    );
};
harden(initWrappingKey);

/**
 * @typedef {object} WrappingKey
 * @property {() => Promise<Buffer>} get the key: loaded once, kept once
 *   loaded; a failure is not kept, the next call loads again
 */

/**
 * @param {KeyOptions} options
 * @returns {WrappingKey}
 */
export const makeWrappingKey = ({ keyFile, stateDir, readOnly = false }) => {
  /** @type {Promise<Buffer> | undefined} */
  let loading;
  const get = () => {
    if (loading === undefined) {
      const attempt = loadWrappingKey({ keyFile, stateDir, readOnly });
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
