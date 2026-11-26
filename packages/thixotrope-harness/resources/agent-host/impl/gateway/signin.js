// @ts-check
/**
 * The gateway's sign-in secret (M3 W3.1; m3-interfaces.md 4.3, 7, 8; R6-9,
 * R8-39, P-02; architecture D-6).
 *
 * 32 random bytes, shown as 64 lowercase hex digits, minted at the first
 * `ensure()` and kept in `<state>/agent-host/gateway/signin.enc`:
 * AES-256-GCM with the secrets wrapping key (M2 `secrets/store.js`, used
 * read-only), additional data `thixotrope-harness-signin-1`, written
 * `signin.enc.tmp`, fsync, rename, fsync of the directory, so a SIGKILL
 * leaves the old file or the new one, never neither (K2).
 *
 * In memory the store keeps only the SHA-256 of the hex text and compares
 * digests with `timingSafeEqual`; the value itself is read back from the
 * file only by `fragment(host)`, for `scripts/gateway.mjs url`. Nothing here
 * puts the value, the key or file bytes into an error or a log line.
 *
 * Node only (adapter, operator script).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { decrypt, encrypt, findSecretsFiles } from '../secrets/store.js';
import { loadWrappingKey } from '../secrets/wrapping-key.js';

/** Additional data of the sealed file (its format revision). */
export const SIGNIN_AAD = 'thixotrope-harness-signin-1';
const SECRET_BYTES = 32;

/** Fixed texts of this module's errors (no value, no bytes). */
export const signInTexts = harden({
  unreadable:
    'the gateway sign-in file cannot be read (wrong wrapping key or damaged file)',
  notReady: 'the gateway sign-in store is not ready (call ensure first)',
});

/**
 * Where the sealed sign-in secret of a state directory lives.
 * @param {string} stateDir
 */
export const signInFile = stateDir =>
  join(resolve(stateDir), 'agent-host', 'gateway', 'signin.enc');
harden(signInFile);

/**
 * Whether `key` opens the bytes of a `signin.enc` (scripts/preflight.mjs):
 * a yes or no, never the secret; the plain text is wiped.
 * @param {Buffer} key
 * @param {Buffer} raw
 */
export const signInFileOpens = (key, raw) => {
  try {
    const plain = decrypt(key, raw, SIGNIN_AAD);
    const whole = plain.length === SECRET_BYTES;
    plain.fill(0);
    return whole;
  } catch {
    return false;
  }
};
harden(signInFileOpens);

/** @param {string} hex */
const digestOf = hex => createHash('sha256').update(hex, 'utf8').digest();

/** @param {string} path */
const syncDirectory = async path => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * @typedef {object} SignInHooks test-only kill points of `rotate` and the
 *   first write (K2): each is awaited at its step
 * @property {() => unknown} [afterTemp] the temporary file is written and
 *   fsynced, not yet renamed
 * @property {() => unknown} [afterRename] renamed, directory not yet fsynced
 *
 * @typedef {object} SignInStore
 * @property {() => Promise<void>} ensure reads the file, minting it first if
 *   absent; removes a temporary file a crash left
 * @property {(candidate: unknown) => boolean} matches constant-time digest
 *   comparison; false before `ensure` settled
 * @property {() => Promise<void>} rotate mints and writes a new secret
 * @property {(host: string) => Promise<string>} fragment
 *   `#gateway=<host>&agent=<secret>`, read from the file (operator script)
 */

/**
 * @param {object} options
 * @param {string} options.stateDir
 * @param {Record<string, string | undefined>} [options.env] where the
 *   wrapping key is (`THIX_HARNESS_SECRETS_KEY`), as the secrets store
 * @param {string} [options.home] for the default key location (tests)
 * @param {SignInHooks} [options.hooks]
 * @returns {SignInStore}
 */
export const makeSignInStore = ({ stateDir, env = {}, home, hooks = {} }) => {
  const files = findSecretsFiles({ stateDir, env, home });
  const file = signInFile(stateDir);
  const temp = `${file}.tmp`;
  /** @type {Promise<Buffer> | undefined} */
  let keyPromise;
  /** @type {Buffer | undefined} */
  let digest;
  /** Serializes ensure and rotate so two writes never interleave. */
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  const wrappingKey = () => {
    if (keyPromise === undefined) {
      keyPromise = loadWrappingKey({
        keyFile: files.keyFile,
        stateDir: files.stateDir,
        readOnly: files.keyReadOnly,
      });
      // A failed load is retried by the next call.
      keyPromise.catch(() => {
        keyPromise = undefined;
      });
    }
    return keyPromise;
  };

  /**
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  const serialize = job => {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  };

  /** @returns {Promise<string | undefined>} the hex secret, if the file exists */
  const readSecret = async () => {
    const key = await wrappingKey();
    /** @type {Buffer} */
    let sealed;
    try {
      sealed = await readFile(file);
    } catch (error) {
      if (/** @type {any} */ (error).code === 'ENOENT') return undefined;
      throw error;
    }
    /** @type {Buffer} */
    let plain;
    try {
      plain = decrypt(key, sealed, SIGNIN_AAD);
    } catch {
      throw Error(signInTexts.unreadable);
    }
    if (plain.length !== SECRET_BYTES) throw Error(signInTexts.unreadable);
    return plain.toString('hex');
  };

  /** @returns {Promise<string>} the new hex secret */
  const writeNew = async () => {
    const key = await wrappingKey();
    const plain = randomBytes(SECRET_BYTES);
    const sealed = encrypt(key, plain, SIGNIN_AAD);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(sealed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hooks.afterTemp) await hooks.afterTemp();
    await rename(temp, file);
    if (hooks.afterRename) await hooks.afterRename();
    await syncDirectory(dirname(file));
    return plain.toString('hex');
  };

  const ensure = () =>
    serialize(async () => {
      await unlink(temp).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      const hex = (await readSecret()) ?? (await writeNew());
      digest = digestOf(hex);
    });

  const rotate = () =>
    serialize(async () => {
      const hex = await writeNew();
      digest = digestOf(hex);
    });

  /** @param {unknown} candidate */
  const matches = candidate => {
    if (digest === undefined || typeof candidate !== 'string') return false;
    // Hash first: equal-length inputs to timingSafeEqual whatever the
    // candidate's length, and its time depends on no secret byte.
    return timingSafeEqual(digestOf(candidate), digest);
  };

  /** @param {string} host */
  const fragment = host =>
    serialize(async () => {
      const hex = await readSecret();
      if (hex === undefined) throw Error(signInTexts.notReady);
      return `#gateway=${host}&agent=${hex}`;
    });

  return harden({ ensure, matches, rotate, fragment });
};
harden(makeSignInStore);
