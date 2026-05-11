// @ts-check
/// <reference types="ses"/>

/** @import { CryptoPowers, FilePowers } from './types.js' */
/**
 * @import { EditOptions, EditPatch, EditResult } from './hashline.types.js'
 */

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { mountHelp, mountFileHelp, makeHelp } from './help-text.js';
import { MountInterface, MountFileInterface } from './interfaces.js';
import { makeIteratorRef } from './reader-ref.js';
import { makeSerialJobs } from './serial-jobs.js';
import {
  applyPatch,
  joinLines,
  splitLines,
  validateAnchors,
  validateEditPatch,
} from './hashline.js';

/**
 * Validate a single path segment.
 * Rejects '/', '\', '\0', and empty strings.
 *
 * @param {string} segment
 */
const assertValidSegment = segment => {
  if (typeof segment !== 'string') {
    throw new Error(`Path segment must be a string, got ${q(typeof segment)}`);
  }
  if (segment === '') {
    throw new Error('Path segment must not be empty');
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(
      `Path segment must not contain '/', '\\', or '\\0': ${q(segment)}`,
    );
  }
};
harden(assertValidSegment);

/**
 * Resolve path segments relative to a current directory, clamped to a
 * confinement root.  '.' skips, '..' pops (clamped at root).
 *
 * @param {string} currentDir
 * @param {string} confinementRoot
 * @param {string[]} segments
 * @param {FilePowers} filePowers
 * @returns {string}
 */
const resolveSegments = (currentDir, confinementRoot, segments, filePowers) => {
  let resolved = currentDir;
  for (const segment of segments) {
    if (segment === '.') {
      // skip
    } else if (segment === '..') {
      const parent = filePowers.joinPath(resolved, '..');
      if (parent.length >= confinementRoot.length) {
        resolved = parent;
      } else {
        resolved = confinementRoot;
      }
    } else {
      assertValidSegment(segment);
      resolved = filePowers.joinPath(resolved, segment);
    }
  }
  return resolved;
};
harden(resolveSegments);

/**
 * Assert that a resolved path is contained within the confinement root.
 *
 * @param {string} candidatePath
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 */
const assertConfined = async (candidatePath, confinementRoot, filePowers) => {
  let resolved;
  try {
    resolved = await filePowers.realPath(candidatePath);
  } catch {
    throw new Error(
      `Path does not exist and cannot be verified: ${q(candidatePath)}`,
    );
  }
  const rootResolved = await filePowers.realPath(confinementRoot);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}/`)) {
    throw new Error(`Path escapes mount root: ${q(candidatePath)}`);
  }
};
harden(assertConfined);

/**
 * Check confinement of a path that may not exist yet.
 * Walks up to find the deepest existing ancestor.
 *
 * @param {string} candidatePath
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 */
const assertConfinedOrAncestor = async (
  candidatePath,
  confinementRoot,
  filePowers,
) => {
  const rootResolved = await filePowers.realPath(confinementRoot);
  let check = candidatePath;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resolved = await filePowers.realPath(check);
      if (
        resolved !== rootResolved &&
        !resolved.startsWith(`${rootResolved}/`)
      ) {
        throw new Error(`Path escapes mount root: ${q(candidatePath)}`);
      }
      return;
    } catch (/** @type {any} */ e) {
      if (e.message && e.message.startsWith('Path escapes')) {
        throw e;
      }
      const parent = filePowers.joinPath(check, '..');
      if (parent === check) {
        throw new Error(`Path escapes mount root: ${q(candidatePath)}`);
      }
      check = parent;
    }
  }
};
harden(assertConfinedOrAncestor);

/**
 * Check if a path is confined (returns boolean, does not throw).
 *
 * @param {string} candidatePath
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 * @returns {Promise<boolean>}
 */
const isConfinedPath = async (candidatePath, confinementRoot, filePowers) => {
  try {
    const resolved = await filePowers.realPath(candidatePath);
    const rootResolved = await filePowers.realPath(confinementRoot);
    return resolved === rootResolved || resolved.startsWith(`${rootResolved}/`);
  } catch {
    return false;
  }
};
harden(isConfinedPath);

/**
 * @typedef {object} MountContext
 * @property {string} currentDir
 * @property {string} confinementRoot
 * @property {boolean} readOnly
 * @property {FilePowers} filePowers
 * @property {CryptoPowers} cryptoPowers
 * @property {ReturnType<typeof makeSerialJobs>} editLock per-mount lock
 *   serializing read-validate-write critical sections; shared across
 *   subdirectory mounts derived via `lookup()`.
 * @property {string} description
 */

/**
 * Compute SHA-256 of `text` as 64-char lowercase hex.
 * @param {CryptoPowers} cryptoPowers
 * @param {string} text
 */
const sha256Hex = (cryptoPowers, text) => {
  const digester = cryptoPowers.makeSha256();
  digester.updateText(text);
  return digester.digestHex();
};

/**
 * Create a mount exo for a filesystem directory.
 *
 * @param {MountContext} ctx
 * @returns {object}
 */
const makeMountExo = ctx => {
  const {
    currentDir,
    confinementRoot,
    readOnly,
    filePowers,
    cryptoPowers,
    editLock,
    description,
  } = ctx;

  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Mount is read-only');
    }
  };

  /**
   * @param {string[]} segments
   * @returns {string}
   */
  const resolve = segments =>
    resolveSegments(currentDir, confinementRoot, segments, filePowers);

  const help = makeHelp(mountHelp);

  return makeExo('EndoMount', MountInterface, {
    help,

    async has(...pathSegments) {
      await null;
      if (pathSegments.length === 0) {
        return true;
      }
      const target = resolve(pathSegments);
      const pathExists = await filePowers.exists(target);
      if (!pathExists) {
        return false;
      }
      return isConfinedPath(target, confinementRoot, filePowers);
    },

    async list(...pathSegments) {
      await null;
      const target = resolve(pathSegments);
      await assertConfined(target, confinementRoot, filePowers);
      const entries = await filePowers.readDirectory(target);
      const confined = [];
      for (const entry of entries.sort()) {
        const entryPath = filePowers.joinPath(target, entry);
        // eslint-disable-next-line no-await-in-loop
        if (await isConfinedPath(entryPath, confinementRoot, filePowers)) {
          confined.push(entry);
        }
      }
      return harden(confined);
    },

    async lookup(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);

      const isDir = await filePowers.isDirectory(target);
      if (isDir) {
        return makeMountExo({
          ...ctx,
          currentDir: target,
          description: `Subdirectory of ${description}`,
        });
      }

      return makeMountFileExo(target, readOnly, filePowers, confinementRoot);
    },

    async readText(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      return filePowers.readFileText(target);
    },

    async maybeReadText(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      try {
        await assertConfined(target, confinementRoot, filePowers);
        return await filePowers.readFileText(target);
      } catch {
        return undefined;
      }
    },

    async writeText(pathArg, content) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const parent = filePowers.joinPath(target, '..');
      await filePowers.makePath(parent);
      await filePowers.writeFileText(target, content);
    },

    /**
     * Apply a hashline patch atomically: acquire the mount-internal
     * lock, read the file, validate the SHA-256 file-rev CAS, validate
     * per-line CRC32 anchors, splice, write, return.
     *
     * Per design `cli-edit-verb.md` §"CAS semantics" and §"Phase 2".
     *
     * @param {string | string[]} pathArg
     * @param {EditPatch | unknown} patchInput - already-validated EditPatch
     *   or a raw object to be validated here (CapTP delivers plain
     *   objects, so we revalidate at the boundary).
     * @param {EditOptions} [_options]
     * @returns {Promise<EditResult>}
     */
    async edit(pathArg, patchInput, _options = {}) {
      // The lock guards the read-validate-write critical section so
      // two concurrent edits do not interleave. The CAS check is the
      // outer guard against modifications by *other* writers; the
      // lock is the inner guard against ourselves.
      return editLock.enqueue(async () => {
        // Resolve and confine path. We re-throw confinement errors
        // as plain errors (not structured failures) because they are
        // programming errors, not patch-content failures.
        const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
        const target = resolve(segments);
        // Read the current file; absent file → path-not-found.
        let current;
        try {
          await assertConfined(target, confinementRoot, filePowers);
          current = await filePowers.readFileText(target);
        } catch (/** @type {any} */ e) {
          /** @type {EditResult} */
          const result = harden({
            success: false,
            fileHashAfter: '',
            failure: harden({
              reason: 'path-not-found',
              message: /** @type {Error} */ (e).message,
            }),
          });
          return result;
        }

        // Validate the patch envelope. Structural errors → patch-syntax.
        let patch;
        try {
          patch = validateEditPatch(patchInput);
        } catch (/** @type {any} */ e) {
          /** @type {EditResult} */
          const result = harden({
            success: false,
            fileHashAfter: sha256Hex(cryptoPowers, current),
            failure: harden({
              reason: 'patch-syntax',
              message: /** @type {Error} */ (e).message,
            }),
          });
          return result;
        }

        // Compute current SHA-256 and check CAS.
        const fileHashCurrent = sha256Hex(cryptoPowers, current);
        if (fileHashCurrent !== patch.expectedFileHash) {
          /** @type {EditResult} */
          const result = harden({
            success: false,
            fileHashAfter: fileHashCurrent,
            failure: harden({
              reason: 'file-rev-mismatch',
              fileHashActual: fileHashCurrent,
            }),
          });
          return result;
        }

        // Split into lines and validate per-line anchors.
        const { lines, trailingNewline } = splitLines(current);
        const mismatches = validateAnchors(patch, lines);
        if (mismatches.length > 0) {
          /** @type {EditResult} */
          const result = harden({
            success: false,
            fileHashAfter: fileHashCurrent,
            failure: harden({
              reason: 'hash-mismatch',
              mismatches,
            }),
          });
          return result;
        }

        // Apply the splice.
        const { lines: newLines } = applyPatch(patch, lines);
        const next = joinLines(newLines, trailingNewline);
        if (readOnly) {
          /** @type {EditResult} */
          const result = harden({
            success: false,
            fileHashAfter: fileHashCurrent,
            failure: harden({
              reason: 'permission-denied',
              message: 'Mount is read-only',
            }),
          });
          return result;
        }
        await filePowers.writeFileText(target, next);
        const fileHashAfter = sha256Hex(cryptoPowers, next);
        /** @type {EditResult} */
        const result = harden({
          success: true,
          fileHashAfter,
        });
        return result;
      });
    },

    async remove(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      await filePowers.removePath(target);
    },

    async move(fromArg, toArg) {
      await null;
      assertWritable();
      const from = resolve(typeof fromArg === 'string' ? [fromArg] : fromArg);
      const to = resolve(typeof toArg === 'string' ? [toArg] : toArg);
      await assertConfined(from, confinementRoot, filePowers);
      await assertConfinedOrAncestor(to, confinementRoot, filePowers);
      await filePowers.renamePath(from, to);
    },

    async makeDirectory(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      await filePowers.makePath(target);
    },

    readOnly() {
      if (readOnly) {
        return this; // eslint-disable-line no-invalid-this
      }
      return makeMountExo({
        ...ctx,
        readOnly: true,
        description: `Read-only view of ${description}`,
      });
    },

    async snapshot() {
      throw new Error('snapshot() is not yet implemented');
    },
  });
};
harden(makeMountExo);

/**
 * Create a transient file exo for a file within a mount.
 *
 * @param {string} filePath
 * @param {boolean} readOnly
 * @param {FilePowers} filePowers
 * @param {string} confinementRoot
 * @returns {object}
 */
const makeMountFileExo = (filePath, readOnly, filePowers, confinementRoot) => {
  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Mount is read-only');
    }
  };

  const help = makeHelp(mountFileHelp);

  return makeExo('EndoMountFile', MountFileInterface, {
    help,

    async text() {
      await null;
      await assertConfined(filePath, confinementRoot, filePowers);
      return filePowers.readFileText(filePath);
    },

    streamBase64() {
      const reader = filePowers.makeFileReader(filePath);
      return makeIteratorRef(reader);
    },

    async json() {
      await null;
      const text = await filePowers.readFileText(filePath);
      return JSON.parse(text);
    },

    async writeText(content) {
      await null;
      assertWritable();
      await assertConfined(filePath, confinementRoot, filePowers);
      await filePowers.writeFileText(filePath, content);
    },

    async writeBytes(readableRef) {
      await null;
      assertWritable();
      await assertConfined(filePath, confinementRoot, filePowers);
      const writer = filePowers.makeFileWriter(filePath);
      const iterator = /** @type {AsyncIterator<Uint8Array>} */ (readableRef);
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await iterator.next();
        if (done) break;
        // eslint-disable-next-line no-await-in-loop
        await writer.next(value);
      }
      await writer.return(undefined);
    },

    readOnly() {
      return makeMountFileExo(filePath, true, filePowers, confinementRoot);
    },
  });
};
harden(makeMountFileExo);

/**
 * Create a mount exo backed by a filesystem directory.
 *
 * @param {object} opts
 * @param {string} opts.rootPath
 * @param {boolean} opts.readOnly
 * @param {FilePowers} opts.filePowers
 * @param {CryptoPowers} opts.cryptoPowers
 * @returns {object}
 */
export const makeMount = ({ rootPath, readOnly, filePowers, cryptoPowers }) => {
  const prefix = readOnly ? 'Read-only mount' : 'Mount';
  // One lock per mount root; subdirectory mounts derived via `lookup`
  // share the same lock so cross-subdir edits inside one mount tree
  // remain serialized.
  const editLock = makeSerialJobs();
  /** @type {MountContext} */
  const ctx = {
    currentDir: rootPath,
    confinementRoot: rootPath,
    readOnly,
    filePowers,
    cryptoPowers,
    editLock,
    description: `${prefix} at ${rootPath}`,
  };

  return makeMountExo(ctx);
};
harden(makeMount);
