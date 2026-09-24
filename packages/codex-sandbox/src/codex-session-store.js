// @ts-check
/* global process */

/** Host-private diagnostic values and operational thread checkpoint storage. */

import { Fail, b, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  canonicalAuditJson,
  parseCanonicalAuditJson,
} from './audit-journal.js';

/** Host-private value storage for diagnostics and the thread checkpoint. */
export const ValueStoreInterface = M.interface('CodexValueStore', {
  list: M.call().returns(M.promise()),
  has: M.call(M.string()).returns(M.promise()),
  lookup: M.call(M.string()).returns(M.promise()),
  storeValue: M.call(M.any(), M.string()).returns(M.promise()),
});

// Diagnostic names are `<prefix>-<20 digits>` or `<prefix>-content-<hash>`;
// the prefix carries a session id, so this admits the whole shape while
// excluding a separator, a leading dot, and anything that could name a parent.
const VALUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const SUFFIX = '.json';
const MAX_VALUE_BYTES = 16 * 1024 * 1024;

/** @param {string} directory */
const syncDirectory = async directory => {
  // Never acknowledge a durable update on filesystems that refuse this flush.
  /* eslint-disable no-bitwise */
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  /* eslint-enable no-bitwise */
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** @param {string} name */
const assertValueName = name => {
  (typeof name === 'string' &&
    VALUE_NAME_PATTERN.test(name) &&
    !name.includes('..')) ||
    Fail`Invalid Codex value name ${q(name)}`;
  return name;
};

/**
 * Create the directory, or adopt one this process already owns, refusing a
 * symlink at its path or anywhere above it in the part we created.
 * @param {string} directory
 * @param {string} label
 * @param {(directory: string) => Promise<void>} sync
 */
const providePrivateSubdirectory = async (directory, label, sync) => {
  const info = await lstat(directory).catch(error => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return undefined;
    throw error;
  });
  !info?.isSymbolicLink() ||
    Fail`${b(label)} must not be a symlink: ${q(directory)}`;
  if (info && !info.isDirectory()) {
    throw Fail`${b(label)} must be a directory: ${q(directory)}`;
  }
  if (!info) await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const root = await realpath(directory);
  // Flush the path on reopening too: a prior attempt may have created several
  // directories and failed before syncing their links. Existence alone is not
  // evidence that those links have been made durable.
  for (let current = root; ; current = dirname(current)) {
    // eslint-disable-next-line no-await-in-loop
    await sync(current);
    if (current === dirname(current)) break;
  }
  return root;
};

/**
 * A `list`/`has`/`lookup`/`storeValue` store over one directory of canonically
 * encoded values.
 *
 * Writes go to a fresh exclusive temporary file and are renamed into place, so
 * a crash mid-write cannot leave a half-written entry the journal would later
 * fail to decode.
 *
 * @param {string} directory
 * @param {string} [label]
 * @param {object} [powers]
 * @param {(directory: string) => Promise<void>} [powers.syncDirectory]
 */
export const makeDirectoryValueStore = async (
  directory,
  label = 'store',
  { syncDirectory: sync = syncDirectory } = {},
) => {
  const root = await providePrivateSubdirectory(directory, label, sync);
  /** @param {string} name */
  const pathFor = name => join(root, `${assertValueName(name)}${SUFFIX}`);

  const list = async () => {
    const names = await readdir(root);
    return harden(
      names
        .filter(name => name.endsWith(SUFFIX))
        .map(name => name.slice(0, -SUFFIX.length))
        .filter(name => VALUE_NAME_PATTERN.test(name)),
    );
  };

  /** @param {string} name */
  const has = async name => {
    const info = await lstat(pathFor(name)).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return undefined;
      throw error;
    });
    // A symlink is not a stored value. Reporting it absent would let the next
    // `storeValue` rename over it, which is the right outcome either way.
    return info !== undefined && info.isFile();
  };

  /** @param {string} name */
  const lookup = async name => {
    const path = pathFor(name);
    // eslint-disable-next-line no-bitwise
    const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path, readFlags);
    try {
      const text = await handle.readFile('utf8');
      return parseCanonicalAuditJson(text, MAX_VALUE_BYTES);
    } finally {
      await handle.close();
    }
  };

  /**
   * @param {unknown} value
   * @param {string} name
   */
  const storeValue = async (value, name) => {
    const path = pathFor(name);
    const text = canonicalAuditJson(value);
    new TextEncoder().encode(text).byteLength <= MAX_VALUE_BYTES ||
      Fail`Codex value ${q(name)} exceeded ${q(MAX_VALUE_BYTES)} bytes`;
    // A distinct temporary per attempt, created exclusively: two writers
    // cannot share one, and a leftover from a crashed writer is never adopted.
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    /* eslint-disable no-bitwise */
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW;
    /* eslint-enable no-bitwise */
    const handle = await open(temporary, flags, 0o600);
    try {
      await handle.writeFile(text);
      // The rename below is atomic but does not flush; a host that loses power
      // between them can present an empty file, which decodes to a refusal
      // rather than to a different value.
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    // Rename visibility is not durability. A rejected directory sync means
    // the write may have landed, never that it is safe to acknowledge.
    await sync(root);
  };

  return makeExo('CodexValueStore', ValueStoreInterface, {
    list,
    has,
    lookup,
    storeValue,
  });
};
harden(makeDirectoryValueStore);

/**
 * Diagnostics and the distinct operational thread checkpoint.
 * Old anchored layouts require deliberate session retirement.
 * @param {string} directory The session's own state directory.
 */
export const makeCodexSessionState = async directory => {
  const oldAnchor = await lstat(join(directory, 'anchors')).catch(error => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
      return undefined;
    throw error;
  });
  oldAnchor === undefined ||
    Fail`Old Codex audit layout; session reset required`;
  const entries = await makeDirectoryValueStore(
    join(directory, 'entries'),
    'diagnostic entries',
  );
  const thread = await makeDirectoryValueStore(
    join(directory, 'thread'),
    'thread checkpoint',
  );
  const THREAD = 'checkpoint';
  return harden({
    entries,
    /** @returns {Promise<Record<string, unknown>>} */
    readThread: async () => {
      if (!(await thread.has(THREAD))) return harden({});
      return /** @type {Promise<Record<string, unknown>>} */ (
        thread.lookup(THREAD)
      );
    },
    /** @param {unknown} checkpoint */
    writeThread: checkpoint => thread.storeValue(checkpoint, THREAD),
  });
};
harden(makeCodexSessionState);
