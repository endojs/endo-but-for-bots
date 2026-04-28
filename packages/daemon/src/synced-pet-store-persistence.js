// @ts-check

// Persistence skeleton for the synced pet store.  See
// `designs/daemon-cross-peer-gc.md` § "Persistence Format" — in
// particular § "Directory Layout" and § "Atomic Writes".  This module
// is filesystem-only; it has no knowledge of the daemon, the formula
// graph, or the sync protocol, and is unconfined-safe.
//
// This is Phase 1 of the cross-peer-GC design and is **not yet** wired
// into the daemon's `writeJobs` queue or formulator — the factory is
// exposed for the formulator to compose later.  See § "Formula Type"
// for the eventual integration.
//
// TODO(designs/daemon-cross-peer-gc.md § "Filesystem Ordering and
// `fsync`"): the design's full durability story requires an `fsyncPath`
// extension to `filePowers` that wraps `fs.fdatasyncSync` /
// `fs.fsync(2)` on the temporary file, the renamed final file, and the
// parent directory.  Phase 1 inherits the existing pet-store durability
// story (write-then-rename without explicit directory fsync).  A
// follow-up PR will add the extension and call it from `atomicWriteJSON`.

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

/**
 * @import {
 *   FilePowers,
 *   FormulaNumber,
 *   PetName,
 *   SyncedEntry,
 *   SyncedPetStoreMetadata,
 *   SyncedPetStoreState,
 * } from './types.js'
 */

/** Subdirectory under `statePath` where synced pet stores are rooted. */
const SYNCED_PET_STORE_DIR = 'synced-pet-store';

/** Subdirectory within a synced pet store where pet name entries live. */
const NAMES_SUBDIR = 'names';

/** Filename of the sync watermark metadata. */
const CLOCK_FILE = 'clock.json';

/** Suffix appended to entry filenames on disk. */
const ENTRY_SUFFIX = '.json';

/** Prefix marker for in-progress write-then-rename temporary files. */
const TEMPORARY_PREFIX = '.tmp.';

/**
 * Computes the on-disk directory for a synced pet store, sharded by the
 * first two hex characters of the formula number to avoid creating
 * directories with thousands of subdirectories on large deployments.
 *
 * Layout per design § "Directory Layout":
 *   {statePath}/synced-pet-store/{ab}/{cdef0123…}/
 *     names/
 *       {petName}.json
 *     clock.json
 *
 * @param {FilePowers} filePowers
 * @param {string} statePath
 * @param {FormulaNumber} formulaNumber
 * @returns {string}
 */
const computeStoreRoot = (filePowers, statePath, formulaNumber) => {
  if (formulaNumber.length < 2) {
    throw makeError(
      X`Synced pet store formula number too short: ${q(formulaNumber)}`,
    );
  }
  const prefix = formulaNumber.slice(0, 2);
  const suffix = formulaNumber.slice(2);
  return filePowers.joinPath(statePath, SYNCED_PET_STORE_DIR, prefix, suffix);
};

/**
 * Atomic write of a JSON-serializable value to a target file.
 *
 * The implementation follows the "write to a uniquely-named temporary in
 * the same directory, then rename to the final path" pattern; POSIX
 * `rename(2)` is metadata-atomic, so a crash leaves either the prior
 * file (or absent file) at the final path, never a truncated or empty
 * file.  See design § "Atomic Writes" and § "Recovery After Crash".
 *
 * The temporary filename starts with `.tmp.` so that
 * `listStaleTemporaries` can identify and clean up any leftover
 * temporaries from interrupted writes.
 *
 * @param {FilePowers} filePowers
 * @param {() => Promise<string>} randomHex - source of cryptographic
 *   randomness for unique temporary names.  Conventionally
 *   `cryptoPowers.randomHex256` from the daemon, but any unique-string
 *   producer works for testing.
 * @param {string} targetDir - directory in which to perform the atomic
 *   write.  The temporary file is created in this same directory so the
 *   subsequent `rename` is intra-filesystem and therefore atomic.
 * @param {string} fileName - final filename (no directory component).
 * @param {unknown} value - JSON-serializable payload.
 * @returns {Promise<void>}
 */
export const atomicWriteJSON = async (
  filePowers,
  randomHex,
  targetDir,
  fileName,
  value,
) => {
  const suffix = await randomHex();
  const temporaryPath = filePowers.joinPath(
    targetDir,
    `${TEMPORARY_PREFIX}${suffix}`,
  );
  const finalPath = filePowers.joinPath(targetDir, fileName);
  await filePowers.writeFileText(temporaryPath, `${JSON.stringify(value)}\n`);
  await filePowers.renamePath(temporaryPath, finalPath);
};
harden(atomicWriteJSON);

/**
 * Validates that a parsed entry has the expected `SyncedEntry` shape.
 * Throws a descriptive error otherwise; this is the only invariant
 * enforcement on the read path.
 *
 * @param {unknown} parsed
 * @param {string} sourceLabel - human-readable label used in error
 *   messages (e.g. the file path).
 * @returns {SyncedEntry}
 */
const assertSyncedEntry = (parsed, sourceLabel) => {
  if (parsed === null || typeof parsed !== 'object') {
    throw makeError(
      X`Invalid synced entry at ${q(sourceLabel)}: not an object`,
    );
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const { locator, timestamp, writer } = obj;
  if (locator !== null && typeof locator !== 'string') {
    throw makeError(
      X`Invalid synced entry at ${q(sourceLabel)}: locator must be string or null`,
    );
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw makeError(
      X`Invalid synced entry at ${q(sourceLabel)}: timestamp must be finite number`,
    );
  }
  if (typeof writer !== 'string' || writer.length === 0) {
    throw makeError(
      X`Invalid synced entry at ${q(sourceLabel)}: writer must be non-empty string`,
    );
  }
  return /** @type {SyncedEntry} */ (harden({ locator, timestamp, writer }));
};

/**
 * Validates that a parsed metadata blob has the expected
 * `SyncedPetStoreMetadata` shape.
 *
 * @param {unknown} parsed
 * @param {string} sourceLabel
 * @returns {SyncedPetStoreMetadata}
 */
const assertSyncedMetadata = (parsed, sourceLabel) => {
  if (parsed === null || typeof parsed !== 'object') {
    throw makeError(
      X`Invalid synced metadata at ${q(sourceLabel)}: not an object`,
    );
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const { localClock, remoteAckedClock } = obj;
  if (typeof localClock !== 'number' || !Number.isFinite(localClock)) {
    throw makeError(
      X`Invalid synced metadata at ${q(sourceLabel)}: localClock must be finite number`,
    );
  }
  if (
    typeof remoteAckedClock !== 'number' ||
    !Number.isFinite(remoteAckedClock)
  ) {
    throw makeError(
      X`Invalid synced metadata at ${q(sourceLabel)}: remoteAckedClock must be finite number`,
    );
  }
  return harden({ localClock, remoteAckedClock });
};

/**
 * Decodes a filename from the names directory back into a pet name plus
 * a flag indicating whether the file should be considered as a stale
 * temporary that the caller should clean up.
 *
 * @param {string} fileName
 * @returns {{ kind: 'entry', petName: PetName } | { kind: 'temporary' } | { kind: 'other' }}
 */
const classifyEntryFileName = fileName => {
  if (fileName.startsWith(TEMPORARY_PREFIX)) {
    return harden({ kind: 'temporary' });
  }
  if (!fileName.endsWith(ENTRY_SUFFIX)) {
    return harden({ kind: 'other' });
  }
  const base = fileName.slice(0, fileName.length - ENTRY_SUFFIX.length);
  if (base.length === 0) {
    return harden({ kind: 'other' });
  }
  return harden({
    kind: 'entry',
    petName: /** @type {PetName} */ (base),
  });
};

/**
 * Constructs a persistence facade for a single synced pet store
 * instance, identified by its formula number.  The returned object is
 * intentionally narrow — it does not expose path manipulation or
 * filesystem primitives directly; callers operate in terms of pet names,
 * entries, and metadata.
 *
 * The facade owns no in-memory cache.  Callers (notably the future
 * synced-pet-store formula maker) are expected to load the state into a
 * `SyncedPetStoreState` map at startup via `readState`, then issue
 * `writeEntry` / `writeMetadata` calls as the CRDT mutates.
 *
 * @param {FilePowers} filePowers
 * @param {() => Promise<string>} randomHex
 * @param {string} statePath - the daemon state root.
 * @param {FormulaNumber} formulaNumber - this synced pet store's
 *   formula number; determines the on-disk directory.
 */
export const makeSyncedPetStorePersistence = (
  filePowers,
  randomHex,
  statePath,
  formulaNumber,
) => {
  const storeRoot = computeStoreRoot(filePowers, statePath, formulaNumber);
  const namesDir = filePowers.joinPath(storeRoot, NAMES_SUBDIR);

  const ensureDirectories = async () => {
    await filePowers.makePath(namesDir);
  };

  /**
   * Lists the names of any stale temporary files left over from
   * interrupted writes.  Callers should run this on startup, before
   * trusting the directory listing to reflect the committed state.
   *
   * Returns absolute paths so that the caller can pass them straight to
   * `removePath` (and to make them usable in error messages).
   *
   * @returns {Promise<string[]>}
   */
  const listStaleTemporaries = async () => {
    await ensureDirectories();
    // Both the names subdirectory and the store root may contain
    // temporaries (the entry write path uses namesDir; the metadata
    // write path uses storeRoot).  Inspect the two directories in
    // parallel so the awaits are independent.
    const dirs = [namesDir, storeRoot];
    const listings = await Promise.all(
      dirs.map(async dir => {
        const exists = await filePowers.exists(dir);
        if (!exists) {
          return /** @type {string[]} */ ([]);
        }
        const entries = await filePowers.readDirectory(dir);
        return entries
          .filter(name => name.startsWith(TEMPORARY_PREFIX))
          .map(name => filePowers.joinPath(dir, name));
      }),
    );
    return harden(listings.flat());
  };

  /**
   * Deletes every stale temporary file under the store, leaving
   * committed entry and metadata files untouched.  Idempotent.
   */
  const deleteStaleTemporaries = async () => {
    const stale = await listStaleTemporaries();
    await Promise.all(stale.map(p => filePowers.removePath(p)));
  };

  /**
   * Reads the entire state of this replica from disk.  Stale
   * temporaries are ignored (and should be cleaned up by the caller via
   * `deleteStaleTemporaries` before relying on `readState` over a long
   * uptime; on a cold start the listing-then-cleanup order is
   * harmless).
   *
   * @returns {Promise<SyncedPetStoreState>}
   */
  const readState = async () => {
    await ensureDirectories();
    /** @type {SyncedPetStoreState} */
    const state = new Map();
    const fileNames = await filePowers.readDirectory(namesDir);
    await Promise.all(
      fileNames.map(async fileName => {
        const classified = classifyEntryFileName(fileName);
        if (classified.kind !== 'entry') {
          return;
        }
        const filePath = filePowers.joinPath(namesDir, fileName);
        const text = await filePowers.readFileText(filePath);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          throw makeError(
            X`Failed to parse synced entry at ${q(filePath)}: ${q(/** @type {Error} */ (cause).message)}`,
          );
        }
        const entry = assertSyncedEntry(parsed, filePath);
        state.set(classified.petName, entry);
      }),
    );
    return state;
  };

  /**
   * Atomically writes a single entry for `petName` to disk.  The caller
   * is responsible for having merged the entry into the in-memory CRDT
   * state first; this function does not perform any merge.
   *
   * @param {PetName} petName
   * @param {SyncedEntry} entry
   */
  const writeEntry = async (petName, entry) => {
    await ensureDirectories();
    const fileName = `${petName}${ENTRY_SUFFIX}`;
    await atomicWriteJSON(filePowers, randomHex, namesDir, fileName, entry);
  };

  /**
   * Removes the on-disk file for `petName`.  Used by tombstone pruning
   * once the design's full sync watermark is implemented; see § "Pruning
   * Procedure" in the design.  Idempotent: removing a non-existent
   * entry is a no-op.
   *
   * @param {PetName} petName
   */
  const deleteEntry = async petName => {
    const filePath = filePowers.joinPath(namesDir, `${petName}${ENTRY_SUFFIX}`);
    await filePowers.removePath(filePath);
  };

  /**
   * Reads the sync watermark metadata from disk.  Returns the
   * default (`localClock: 0`, `remoteAckedClock: 0`) if no metadata file
   * exists yet — i.e., the replica has never synced or written.
   *
   * @returns {Promise<SyncedPetStoreMetadata>}
   */
  const readMetadata = async () => {
    await ensureDirectories();
    const filePath = filePowers.joinPath(storeRoot, CLOCK_FILE);
    const text = await filePowers.maybeReadFileText(filePath);
    if (text === undefined) {
      return harden({ localClock: 0, remoteAckedClock: 0 });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw makeError(
        X`Failed to parse synced metadata at ${q(filePath)}: ${q(/** @type {Error} */ (cause).message)}`,
      );
    }
    return assertSyncedMetadata(parsed, filePath);
  };

  /**
   * Atomically writes the sync watermark metadata to disk.
   *
   * @param {SyncedPetStoreMetadata} metadata
   */
  const writeMetadata = async metadata => {
    await ensureDirectories();
    await atomicWriteJSON(
      filePowers,
      randomHex,
      storeRoot,
      CLOCK_FILE,
      metadata,
    );
  };

  return harden({
    readState,
    writeEntry,
    deleteEntry,
    readMetadata,
    writeMetadata,
    listStaleTemporaries,
    deleteStaleTemporaries,
  });
};
harden(makeSyncedPetStorePersistence);
