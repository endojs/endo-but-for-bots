// @ts-check
/* global process */

/**
 * Codex's per-session durable state, kept in host files under a directory the
 * daemon-owned state provider hands out.
 *
 * This is what replaces the `codex-subscription-state/<sessionId>/{entries,
 * anchors,thread}` petstore subtree. That subtree was the reason the backend
 * caplet held `@agent`: writing it needed `makeDirectory`, `storeValue`,
 * `lookup` and `remove` on the host agent, which is the whole of an agent's
 * naming authority, granted for the sake of three directories. The journal
 * itself never wanted a petstore — `makeStoredAuditJournal` asks only for
 * `list`, `has`, `lookup` and `storeValue`, four methods a directory answers
 * just as well.
 *
 * Values are stored in the audit journal's own canonical encoding rather than
 * plain JSON: an entry's `sequence` is a bigint, and the canonical form is the
 * form the hash chain is computed over, so a file on disk is verifiable against
 * the chain exactly as written.
 *
 * @module
 */

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
import { join } from 'node:path';

import {
  canonicalAuditJson,
  parseCanonicalAuditJson,
} from './audit-journal.js';

/**
 * The methods `makeStoredAuditJournal` asks of its powers. `remove` is what
 * lets the anchor store keep only the newest head, so it stops being a second
 * copy of the whole journal.
 */
export const ValueStoreInterface = M.interface('CodexValueStore', {
  list: M.call().returns(M.promise()),
  has: M.call(M.string()).returns(M.promise()),
  lookup: M.call(M.string()).returns(M.promise()),
  storeValue: M.call(M.any(), M.string()).returns(M.promise()),
  remove: M.call(M.string()).returns(M.promise()),
});

// Journal names are `<prefix>-<20 digits>` and `<prefix>-head-<20 digits>`
// where the prefix carries a session id, so this admits the whole shape while
// excluding a separator, a leading dot, and anything that could name a parent.
const VALUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const SUFFIX = '.json';
const MAX_VALUE_BYTES = 16 * 1024 * 1024;

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
 */
const providePrivateSubdirectory = async (directory, label) => {
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
  return realpath(directory);
};

/**
 * A `list`/`has`/`lookup`/`storeValue` store over one directory of canonically
 * encoded values.
 *
 * Writes go to a fresh exclusive temporary file and are renamed into place, so
 * a crash mid-write cannot leave a half-written entry the journal would later
 * fail to decode — an append-only chain has no way to repair one.
 *
 * @param {string} directory
 * @param {string} [label]
 */
export const makeDirectoryValueStore = async (directory, label = 'store') => {
  const root = await providePrivateSubdirectory(directory, label);
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
  };

  /** @param {string} name */
  const remove = async name => {
    // Never through a symlink, and absent is not an error: a removal is only
    // ever of a value a newer one has superseded.
    const path = pathFor(name);
    const info = await lstat(path).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (info === undefined) return;
    info.isFile() || Fail`Codex value ${q(name)} is not a stored value`;
    await rm(path, { force: true });
  };

  return makeExo('CodexValueStore', ValueStoreInterface, {
    list,
    has,
    lookup,
    storeValue,
    remove,
  });
};
harden(makeDirectoryValueStore);

/**
 * The three stores one Codex session keeps: the audit journal's entries, its
 * independently protected anchors, and the opaque thread checkpoint Floot
 * acknowledges each turn.
 *
 * Entries and anchors are deliberately separate directories, because
 * `makeStoredAuditJournal` refuses to take the same powers for both: an
 * anchor that could be written through the entry store would not be an
 * independent witness of the chain.
 *
 * @param {string} directory The session's own state directory.
 */
export const makeCodexSessionState = async directory => {
  const [entries, anchors] = await Promise.all([
    makeDirectoryValueStore(join(directory, 'entries'), 'journal entries'),
    makeDirectoryValueStore(join(directory, 'anchors'), 'journal anchors'),
  ]);
  const thread = await makeDirectoryValueStore(
    join(directory, 'thread'),
    'thread checkpoint',
  );
  const THREAD = 'checkpoint';
  return harden({
    entries,
    anchors,
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
