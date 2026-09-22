// @ts-check
/// <reference types="ses"/>

/** @import { FilePowers } from './types.js' */

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { mountHelp, mountFileHelp, makeHelp } from './help-text.js';
import { MountInterface, MountFileInterface } from './interfaces.js';
import { makeIteratorRef } from './reader-ref.js';
import { makeSerialJobs } from './serial-jobs.js';
import {
  splitLines,
  joinLines,
  computeLineHash,
  computeFileHash,
  validateEditPatch,
  validateAnchors,
  applyPatch,
  hashWidthForLineCount,
  utf8ByteLength,
  DEFAULT_MAX_EDIT_FILE_SIZE,
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
 * @property {string} description
 * @property {import('./types.js').SerialJobs} editLock the per-mount-instance
 *   lock that serializes the read-validate-splice-write critical section.
 *   Shared across sub-mounts and read-only attenuations of one mount
 *   instance (they spread the same context), so every `edit` against any
 *   path within one `EndoMount` serializes against every other.
 * @property {number} maxEditFileSize the per-edit file-size cap in bytes.
 */

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
    description,
    editLock,
    maxEditFileSize,
  } = ctx;

  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Mount is read-only');
    }
  };

  /**
   * Build a hardened structured edit failure result.
   *
   * @param {import('./hashline.types.js').EditFailureReason} reason
   * @param {object} [extra]
   * @returns {import('./hashline.types.js').EditResult}
   */
  const editFailure = (reason, extra = {}) =>
    harden({ success: false, failure: harden({ reason, ...extra }) });

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
     * Read a text file annotated with hashline per-line anchors. The
     * result carries everything a caller needs to author a subsequent
     * hashline `edit`: the whole-file CAS hash (`fileHash` -> the
     * patch's `expectedFileHash`) and, per line, the 1-indexed line
     * number and its CRC32 anchor (`{ line, hash }` -> an `Anchor`).
     *
     * This is the read-side companion the hashline edit round trip
     * needs (the design's `endo read --hashline`), the "sufficient
     * information for hashline edits" the review asks a read surface to
     * emit.
     *
     * @param {string | string[]} pathArg
     * @returns {Promise<import('./hashline.types.js').HashlineView>}
     */
    async readTextHashline(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      const content = await filePowers.readFileText(target);
      const parts = splitLines(content);
      const width = hashWidthForLineCount(parts.lines.length);
      const fileHash = await computeFileHash(content);
      const lines = parts.lines.map((text, index) => {
        const line = index + 1;
        return harden({ line, hash: computeLineHash(text, line, width), text });
      });
      return harden({
        fileHash,
        width,
        trailingNewline: parts.trailingNewline,
        lines: harden(lines),
      });
    },

    /**
     * Apply a hashline edit patch to a text file under a mount-internal
     * lock: read, whole-file CAS check, per-line anchor validation,
     * bottom-up splice, write — all inside the critical section so a
     * concurrent `edit` against the same mount serializes and the loser
     * sees `file-rev-mismatch`.
     *
     * Returns a structured `EditResult` value (never throws for a
     * reactable failure); only host-level OS errors (`EIO`, `ENOSPC`,
     * …) propagate as thrown errors per the design's error model.
     *
     * @param {string | string[]} pathArg
     * @param {unknown} patch the `EditPatch` envelope (revalidated here)
     * @param {import('./hashline.types.js').EditOptions} [options]
     * @returns {Promise<import('./hashline.types.js').EditResult>}
     */
    async edit(pathArg, patch, options = {}) {
      return editLock.enqueue(async () => {
        if (readOnly) {
          return editFailure('permission-denied', {
            diagnostic: 'Mount is read-only',
          });
        }

        const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
        const target = resolve(segments);

        // Confinement + existence: an absent path is `path-not-found`;
        // `edit` never implicitly creates a file (that is writeText's
        // job).
        try {
          await assertConfined(target, confinementRoot, filePowers);
        } catch {
          return editFailure('path-not-found', {
            diagnostic: `No such path in mount: ${q(target)}`,
          });
        }
        if (await filePowers.isDirectory(target)) {
          return editFailure('path-not-found', {
            diagnostic: `Path is a directory, not a file: ${q(target)}`,
          });
        }

        // Revalidate the envelope on entry (CapTP delivers plain JSON;
        // callers cannot rely on hardened round-tripping).
        let validated;
        try {
          validated = validateEditPatch(patch);
        } catch (error) {
          return editFailure('patch-syntax', {
            diagnostic:
              /** @type {any} */ (error)?.message || 'malformed patch',
          });
        }

        const content = await filePowers.readFileText(target);

        // File-size cap: reject before the splice reads a giant file.
        const size = utf8ByteLength(content);
        if (size > maxEditFileSize) {
          return editFailure('patch-syntax', {
            diagnostic: `File size ${size} exceeds edit cap ${maxEditFileSize}`,
          });
        }

        // Whole-file CAS.
        const fileHashActual = await computeFileHash(content);
        if (fileHashActual !== validated.expectedFileHash) {
          return editFailure('file-rev-mismatch', { fileHashActual });
        }

        // Per-line anchor validation.
        const parts = splitLines(content);
        const mismatches = validateAnchors(validated, parts);
        if (mismatches.length > 0) {
          // `reapply` relocation (design Open Question #5) is not yet
          // implemented; the option is accepted and behaves as strict
          // pending maintainer confirmation of the search algorithm.
          void options;
          return editFailure('hash-mismatch', { mismatches });
        }

        // Splice and write.
        let newContent;
        try {
          newContent = joinLines(applyPatch(validated, parts));
        } catch (error) {
          return editFailure('patch-syntax', {
            diagnostic: /** @type {any} */ (error)?.message || 'splice failed',
          });
        }
        if (utf8ByteLength(newContent) > maxEditFileSize) {
          return editFailure('patch-syntax', {
            diagnostic: `Result exceeds edit cap ${maxEditFileSize}`,
          });
        }

        try {
          await filePowers.writeFileText(target, newContent);
        } catch (error) {
          // Only EACCES (mode-0444 target, restricted path) is a
          // structured `permission-denied`; other OS errors (EROFS,
          // EIO, ENOSPC, EBUSY) propagate as thrown errors per the
          // design's error model.
          const code = /** @type {any} */ (error)?.code;
          if (code === 'EACCES') {
            return editFailure('permission-denied', {
              diagnostic: `Filesystem denied the write: ${code}`,
            });
          }
          throw error;
        }

        const fileHashAfter = await computeFileHash(newContent);
        return harden({ success: true, fileHashAfter });
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
 * @param {number} [opts.maxEditFileSize] per-edit file-size cap in bytes
 *   (default 16 MiB); over-cap edits fail with `patch-syntax`.
 * @returns {object}
 */
export const makeMount = ({
  rootPath,
  readOnly,
  filePowers,
  maxEditFileSize = DEFAULT_MAX_EDIT_FILE_SIZE,
}) => {
  const prefix = readOnly ? 'Read-only mount' : 'Mount';
  /** @type {MountContext} */
  const ctx = {
    currentDir: rootPath,
    confinementRoot: rootPath,
    readOnly,
    filePowers,
    description: `${prefix} at ${rootPath}`,
    // One lock per mount instance, shared with sub-mounts and read-only
    // attenuations (they spread this context).
    editLock: makeSerialJobs(),
    maxEditFileSize,
  };

  return makeMountExo(ctx);
};
harden(makeMount);
