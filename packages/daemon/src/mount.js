// @ts-check
/// <reference types="ses"/>

/** @import { FilePowers } from './types.js' */

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { makeDirectory as makePlatformDirectory } from '@endo/platform/fs/node';
import { DirectoryInterface as PlatformDirectoryInterface } from '@endo/platform/fs/lite/interfaces';

import { mountHelp, mountFileHelp, makeHelp } from './help-text.js';
import { MountInterface, MountFileInterface } from './interfaces.js';
import { makeIteratorRef } from './reader-ref.js';

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
 * Clamp a sequence of path segments to a relative segment array under the
 * Mount's current directory.  '.' segments are dropped; '..' segments pop
 * the last accumulated segment (clamped at the empty root, never escaping
 * the current directory).
 *
 * The result is an array of validated, plain-name segments suitable for
 * passing to `@endo/platform/fs/node` directory operations.
 *
 * @param {string[]} segments
 * @returns {string[]}
 */
const clampSegments = segments => {
  /** @type {string[]} */
  const clamped = [];
  for (const segment of segments) {
    if (segment === '.') {
      // skip
    } else if (segment === '..') {
      if (clamped.length > 0) {
        clamped.pop();
      }
    } else {
      assertValidSegment(segment);
      clamped.push(segment);
    }
  }
  return clamped;
};
harden(clampSegments);

/**
 * Resolve clamped relative segments against a current directory, producing
 * an absolute path suitable for symlink-confinement assertions.
 *
 * @param {string} currentDir
 * @param {string[]} clampedSegments
 * @param {FilePowers} filePowers
 * @returns {string}
 */
const segmentsToAbsolutePath = (currentDir, clampedSegments, filePowers) => {
  let resolved = currentDir;
  for (const segment of clampedSegments) {
    resolved = filePowers.joinPath(resolved, segment);
  }
  return resolved;
};
harden(segmentsToAbsolutePath);

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
 */

/**
 * Create a mount exo for a filesystem directory.
 *
 * Mount delegates the unconfined filesystem work to the platform
 * `makeDirectory` primitive from `@endo/platform/fs/node`.  The Mount exo
 * keeps only the confinement policy: segment validation, `.`/`..` clamping,
 * symlink-escape assertion, and the `readOnly` attenuation.
 *
 * Sub-directory `lookup` retains its bespoke transient sub-exo
 * construction rather than reusing `directory.lookup()`, because the
 * confinement policy must apply at every traversal step.  Reusing the
 * platform `directory.lookup` would require either a clamping-policy hook
 * on the platform side or a wrapper that re-clamps every returned exo;
 * both are out of scope for this PR.
 * See `designs/platform-fs-daemon-integration.md` for the alternative.
 *
 * @param {MountContext} ctx
 * @returns {object}
 */
const makeMountExo = ctx => {
  const { currentDir, confinementRoot, readOnly, filePowers, description } =
    ctx;

  const directory = makePlatformDirectory(currentDir);

  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Mount is read-only');
    }
  };

  /**
   * Clamp incoming segments and compute the absolute path for the
   * symlink-confinement assertion.
   *
   * @param {string[]} segments
   * @returns {{ clamped: string[], absolute: string }}
   */
  const clamp = segments => {
    const clamped = clampSegments(segments);
    const absolute = segmentsToAbsolutePath(currentDir, clamped, filePowers);
    return { clamped, absolute };
  };

  const help = makeHelp(mountHelp);

  /** @type {object | undefined} */
  let directoryFacet;
  /** @type {object} */
  let mountExo;

  // eslint-disable-next-line prefer-const
  mountExo = makeExo('EndoMount', MountInterface, {
    help,

    async has(...pathSegments) {
      await null;
      if (pathSegments.length === 0) {
        return true;
      }
      const { clamped, absolute } = clamp(pathSegments);
      const pathExists = await filePowers.exists(absolute);
      if (!pathExists) {
        return false;
      }
      const confined = await isConfinedPath(
        absolute,
        confinementRoot,
        filePowers,
      );
      if (!confined) {
        return false;
      }
      return directory.has(...clamped);
    },

    async list(...pathSegments) {
      await null;
      const { absolute } = clamp(pathSegments);
      await assertConfined(absolute, confinementRoot, filePowers);
      // Mount keeps its own list rather than delegating to the platform
      // directory because the platform list filters out symlinks
      // unconditionally, while Mount surfaces internal-pointing symlinks
      // (the symlink-confinement assertion catches escapes at use time).
      // See `designs/platform-fs-daemon-integration.md`.
      const entries = await filePowers.readDirectory(absolute);
      const confined = [];
      for (const entry of entries.sort()) {
        const entryPath = filePowers.joinPath(absolute, entry);
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
      const { absolute } = clamp(segments);
      await assertConfined(absolute, confinementRoot, filePowers);

      const isDir = await filePowers.isDirectory(absolute);
      if (isDir) {
        return makeMountExo({
          ...ctx,
          currentDir: absolute,
          description: `Subdirectory of ${description}`,
        });
      }

      return makeMountFileExo(absolute, readOnly, filePowers, confinementRoot);
    },

    async readText(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const { absolute } = clamp(segments);
      await assertConfined(absolute, confinementRoot, filePowers);
      return filePowers.readFileText(absolute);
    },

    async maybeReadText(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const { absolute } = clamp(segments);
      try {
        await assertConfined(absolute, confinementRoot, filePowers);
        return await filePowers.readFileText(absolute);
      } catch {
        return undefined;
      }
    },

    async writeText(pathArg, content) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const { absolute } = clamp(segments);
      await assertConfinedOrAncestor(absolute, confinementRoot, filePowers);
      const parent = filePowers.joinPath(absolute, '..');
      await filePowers.makePath(parent);
      await filePowers.writeFileText(absolute, content);
    },

    async remove(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const { clamped, absolute } = clamp(segments);
      await assertConfined(absolute, confinementRoot, filePowers);
      await directory.remove(clamped);
    },

    async removeTree(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const { clamped, absolute } = clamp(segments);
      await assertConfined(absolute, confinementRoot, filePowers);
      await directory.removeTree(clamped);
    },

    async move(fromArg, toArg) {
      await null;
      assertWritable();
      const fromSegments = typeof fromArg === 'string' ? [fromArg] : fromArg;
      const toSegments = typeof toArg === 'string' ? [toArg] : toArg;
      const { clamped: fromClamped, absolute: fromAbsolute } =
        clamp(fromSegments);
      const { clamped: toClamped, absolute: toAbsolute } = clamp(toSegments);
      await assertConfined(fromAbsolute, confinementRoot, filePowers);
      await assertConfinedOrAncestor(toAbsolute, confinementRoot, filePowers);
      await directory.move(fromClamped, toClamped);
    },

    async copy(fromArg, toArg) {
      await null;
      assertWritable();
      const fromSegments = typeof fromArg === 'string' ? [fromArg] : fromArg;
      const toSegments = typeof toArg === 'string' ? [toArg] : toArg;
      const { clamped: fromClamped, absolute: fromAbsolute } =
        clamp(fromSegments);
      const { clamped: toClamped, absolute: toAbsolute } = clamp(toSegments);
      await assertConfined(fromAbsolute, confinementRoot, filePowers);
      await assertConfinedOrAncestor(toAbsolute, confinementRoot, filePowers);
      await directory.copy(fromClamped, toClamped);
    },

    async write(pathSegments, value) {
      await null;
      assertWritable();
      const { clamped, absolute } = clamp(pathSegments);
      await assertConfinedOrAncestor(absolute, confinementRoot, filePowers);
      await directory.write(clamped, value);
    },

    async makeDirectory(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const { clamped, absolute } = clamp(segments);
      await assertConfinedOrAncestor(absolute, confinementRoot, filePowers);
      await directory.makeDirectory(clamped);
    },

    readOnly() {
      if (readOnly) {
        return mountExo;
      }
      return makeMountExo({
        ...ctx,
        readOnly: true,
        description: `Read-only view of ${description}`,
      });
    },

    asDirectory() {
      if (!directoryFacet) {
        directoryFacet = makeMountDirectoryFacet(mountExo);
      }
      return directoryFacet;
    },

    async snapshot() {
      throw new Error('snapshot() is not yet implemented');
    },
  });

  return mountExo;
};
harden(makeMountExo);

/**
 * Create a strict-`DirectoryInterface` facet of a Mount.
 *
 * Adapts the Mount's lenient calling conventions (string-or-array
 * `pathArg`) to the platform's strict array-only segments.
 * Forwards every operation to the underlying Mount, so confinement,
 * symlink-escape, and `readOnly` policies still apply.
 *
 * The returned exo satisfies `@endo/platform/fs/lite` `DirectoryInterface`
 * and may be handed to a worker or caplet that has been written
 * against `import { DirectoryInterface } from '@endo/platform/fs/lite/interfaces'`.
 * See `designs/platform-fs-daemon-integration.md` Mode 2.
 *
 * @param {any} mount
 * @returns {object}
 */
const makeMountDirectoryFacet = mount => {
  return makeExo(
    'Directory',
    PlatformDirectoryInterface,
    /** @type {any} */ ({
      has: (...segments) => mount.has(...segments),
      list: (...segments) => mount.list(...segments),
      // Re-wrap sub-Mounts as Directory facets so the consumer never
      // observes a `Mount`-shaped exo from a `Directory`-shaped one.
      // Sub-files surface as `MountFile` exos, which expose a subset of
      // the platform `FileInterface` (no `append`, no `snapshot`).
      // The gap is intentional and surfaced in
      // `designs/platform-fs-daemon-integration.md`.
      lookup: async pathArg => {
        const child = await mount.lookup(pathArg);
        if (typeof child.asDirectory === 'function') {
          return child.asDirectory();
        }
        return child;
      },
      write: (segments, value) => mount.write(segments, value),
      remove: segments => mount.remove(segments),
      removeTree: segments => mount.removeTree(segments),
      move: (from, to) => mount.move(from, to),
      copy: (from, to) => mount.copy(from, to),
      makeDirectory: segments => mount.makeDirectory(segments),
      readOnly: () => mount.readOnly(),
      snapshot: () => mount.snapshot(),
    }),
  );
};
harden(makeMountDirectoryFacet);

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
 * `Mount` is the agent-visible name for a `Directory`-shaped capability
 * (see `@endo/platform/fs/lite/types`) whose root is a confined real
 * filesystem subtree.
 * It exposes a structural superset of the platform `DirectoryInterface`
 * for backward compatibility with daemon-only clients (notably the
 * convenience `readText`/`writeText`/`maybeReadText` text I/O methods).
 * The strict `Directory` facet returned by `Mount.asDirectory()` is the
 * canonical surface for cross-realm consumers (workers, caplets) that
 * have been written against `import { Directory } from '@endo/platform/fs/lite/types'`.
 *
 * See `designs/platform-fs-daemon-integration.md` for the integration
 * modes and the platform layer cake.
 *
 * @param {object} opts
 * @param {string} opts.rootPath
 * @param {boolean} opts.readOnly
 * @param {FilePowers} opts.filePowers
 * @returns {object}
 */
export const makeMount = ({ rootPath, readOnly, filePowers }) => {
  const prefix = readOnly ? 'Read-only mount' : 'Mount';
  /** @type {MountContext} */
  const ctx = {
    currentDir: rootPath,
    confinementRoot: rootPath,
    readOnly,
    filePowers,
    description: `${prefix} at ${rootPath}`,
  };

  return makeMountExo(ctx);
};
harden(makeMount);
