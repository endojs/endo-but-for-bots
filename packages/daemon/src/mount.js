// @ts-check
/// <reference types="ses"/>

/** @import { FilePowers } from './types.js' */

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { mountHelp, mountFileHelp, makeHelp } from './help-text.js';
import {
  MountInterface,
  MountControlInterface,
  MountFileInterface,
} from './interfaces.js';
import { makeIteratorRef } from './reader-ref.js';

/**
 * Defense-in-depth: path segments that are always denied regardless of
 * mount root.  Prevents accidental exposure of sensitive directories
 * even when the mount root contains them.
 *
 * Checked against the lowercased segment for case-insensitive matching
 * on case-insensitive filesystems.
 */
const DENIED_SEGMENTS = harden(
  new Set([
    // SSH keys and config
    '.ssh',
    // Cloud provider credentials
    '.aws',
    '.azure',
    '.gcloud',
    '.config', // contains gcloud, docker, npm tokens, etc.
    // GPG/PGP keys
    '.gnupg',
    // Password managers
    '.password-store',
    // Docker credentials
    '.docker',
    // Node.js/npm auth tokens
    '.npmrc',
    // Environment files (common secrets location)
    '.env',
    '.env.local',
    '.env.production',
    // Kubernetes config
    '.kube',
    // Terraform state (may contain secrets)
    '.terraform',
  ]),
);

/**
 * Check if a path segment is in the deny list.
 *
 * @param {string} segment
 * @returns {boolean}
 */
const isDeniedSegment = segment => DENIED_SEGMENTS.has(segment.toLowerCase());
harden(isDeniedSegment);

/**
 * Validate a single path segment.
 * Rejects '/', '\', '\0', empty strings, and denied segments.
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
  if (isDeniedSegment(segment)) {
    throw new Error(`Access denied: ${q(segment)} is a restricted path`);
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
 * Test whether a filename matches a glob segment.
 * Supports `*` (match anything except `/`).
 *
 * @param {string} name - Filename to test.
 * @param {string} pattern - Glob segment (e.g., `*.js`, `README*`).
 * @returns {boolean}
 */
const matchSegment = (name, pattern) => {
  if (pattern === '*') return true;
  // Convert glob pattern to regex: escape special chars, replace * with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = `^${escaped.replace(/\*/g, '[^/]*')}$`;
  const regex = new RegExp(regexStr);
  return regex.test(name);
};
harden(matchSegment);

/**
 * Recursively walk a directory tree matching a glob pattern.
 *
 * Pattern segments:
 * - `*` matches any single filename
 * - `**` matches zero or more directory levels
 * - Literal strings match exactly
 * - Segments with `*` embedded (e.g., `*.js`) match via pattern
 *
 * @param {string} dir - Current directory (absolute path).
 * @param {string[]} patternSegments - Remaining pattern segments.
 * @param {string} prefix - Relative path prefix for results.
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 * @param {string[]} results - Accumulator for matched paths.
 * @param {number} maxResults - Safety cap on results.
 * @returns {Promise<void>}
 */
const walkGlob = async (
  dir,
  patternSegments,
  prefix,
  confinementRoot,
  filePowers,
  results,
  maxResults,
) => {
  if (results.length >= maxResults) return;
  if (patternSegments.length === 0) {
    // End of pattern — include this path if it exists.
    const exists = await filePowers.exists(dir);
    if (exists) {
      results.push(prefix);
    }
    return;
  }

  const [head, ...tail] = patternSegments;

  if (head === '**') {
    // ** matches zero or more levels.
    // Zero levels: skip the ** and continue matching tail from here.
    await walkGlob(
      dir, tail, prefix, confinementRoot, filePowers, results, maxResults,
    );
    // One or more levels: recurse into each subdirectory with ** still active.
    let entries;
    try {
      entries = await filePowers.readDirectory(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (results.length >= maxResults) return;
      if (isDeniedSegment(entry)) continue;
      const childPath = filePowers.joinPath(dir, entry);
      // eslint-disable-next-line no-await-in-loop
      if (!(await isConfinedPath(childPath, confinementRoot, filePowers))) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const isDir = await filePowers.isDirectory(childPath);
      if (isDir) {
        const childPrefix = prefix ? `${prefix}/${entry}` : entry;
        // eslint-disable-next-line no-await-in-loop
        await walkGlob(
          childPath, patternSegments, childPrefix,
          confinementRoot, filePowers, results, maxResults,
        );
      }
    }
    return;
  }

  // Normal segment or wildcard segment (e.g., `*.js`, `*`).
  let entries;
  try {
    entries = await filePowers.readDirectory(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (results.length >= maxResults) return;
    if (isDeniedSegment(entry)) continue;
    if (!matchSegment(entry, head)) continue;
    const childPath = filePowers.joinPath(dir, entry);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isConfinedPath(childPath, confinementRoot, filePowers))) {
      continue;
    }
    const childPrefix = prefix ? `${prefix}/${entry}` : entry;
    if (tail.length === 0) {
      results.push(childPrefix);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await walkGlob(
        childPath, tail, childPrefix,
        confinementRoot, filePowers, results, maxResults,
      );
    }
  }
};
harden(walkGlob);

const GLOB_MAX_RESULTS = 10000;

/**
 * @typedef {object} MountContext
 * @property {string} currentDir
 * @property {string} confinementRoot
 * @property {boolean} readOnly
 * @property {FilePowers} filePowers
 * @property {string} description
 * @property {((mount: object) => Promise<object>) | undefined} snapshotFn
 * @property {{ revoked: boolean }} [revokedRef] - Shared revocation state.
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
    snapshotFn,
    revokedRef,
  } = ctx;

  const assertNotRevoked = () => {
    if (revokedRef && revokedRef.revoked) {
      throw new Error('Mount has been revoked');
    }
  };

  const assertWritable = () => {
    assertNotRevoked();
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

  /** @type {object} */
  let selfRef;

  const mount = makeExo('EndoMount', MountInterface, {
    help,

    async stat(pathArg) {
      assertNotRevoked();
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(target);
      if (isDir) {
        return harden({ type: 'directory', size: 0 });
      }
      const text = await filePowers.readFileText(target);
      return harden({ type: 'file', size: text.length });
    },

    async has(...pathSegments) {
      assertNotRevoked();
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
      assertNotRevoked();
      await null;
      const target = resolve(pathSegments);
      await assertConfined(target, confinementRoot, filePowers);
      const entries = await filePowers.readDirectory(target);
      const confined = [];
      for (const entry of entries.sort()) {
        if (isDeniedSegment(entry)) {
          // eslint-disable-next-line no-continue
          continue;
        }
        const entryPath = filePowers.joinPath(target, entry);
        // eslint-disable-next-line no-await-in-loop
        if (await isConfinedPath(entryPath, confinementRoot, filePowers)) {
          confined.push(entry);
        }
      }
      return harden(confined);
    },

    async lookup(pathArg) {
      assertNotRevoked();
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
      assertNotRevoked();
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      return filePowers.readFileText(target);
    },

    async maybeReadText(pathArg) {
      assertNotRevoked();
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

    async readJson(pathArg) {
      assertNotRevoked();
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      const text = await filePowers.readFileText(target);
      return JSON.parse(text);
    },

    async writeText(pathArg, content) {
      assertNotRevoked();
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const parent = filePowers.joinPath(target, '..');
      await filePowers.makePath(parent);
      await filePowers.writeFileText(target, content);
    },

    async writeJson(pathArg, value) {
      assertNotRevoked();
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const parent = filePowers.joinPath(target, '..');
      await filePowers.makePath(parent);
      await filePowers.writeFileText(target, JSON.stringify(value, null, 2));
    },

    async remove(pathArg) {
      assertNotRevoked();
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      await filePowers.removePath(target);
    },

    async move(fromArg, toArg) {
      assertNotRevoked();
      await null;
      assertWritable();
      const from = resolve(typeof fromArg === 'string' ? [fromArg] : fromArg);
      const to = resolve(typeof toArg === 'string' ? [toArg] : toArg);
      await assertConfined(from, confinementRoot, filePowers);
      await assertConfinedOrAncestor(to, confinementRoot, filePowers);
      await filePowers.renamePath(from, to);
    },

    async makeDirectory(pathArg) {
      assertNotRevoked();
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      await filePowers.makePath(target);
    },

    async glob(pattern) {
      assertNotRevoked();
      await null;
      const segments = pattern.split('/').filter(s => s.length > 0);
      /** @type {string[]} */
      const results = [];
      await walkGlob(
        currentDir,
        segments,
        '',
        confinementRoot,
        filePowers,
        results,
        GLOB_MAX_RESULTS,
      );
      return harden(results);
    },

    /**
     * Search file contents for a pattern.
     *
     * @param {string} pattern - String or regex pattern to search for.
     * @param {object} [opts]
     * @param {string} [opts.glob] - Glob pattern to filter files
     *   (default: all files recursively).
     * @param {number} [opts.maxResults] - Max matches to return
     *   (default: 1000).
     * @returns {Promise<Array<{ file: string, line: number, text: string }>>}
     */
    async grep(pattern, opts = {}) {
      assertNotRevoked();
      await null;
      const {
        glob: globPattern = '**/*',
        maxResults = 1000,
      } = opts;

      // First, find files matching the glob.
      const globSegments = globPattern.split('/').filter(s => s.length > 0);
      /** @type {string[]} */
      const files = [];
      await walkGlob(
        currentDir,
        globSegments,
        '',
        confinementRoot,
        filePowers,
        files,
        GLOB_MAX_RESULTS,
      );

      const regex = new RegExp(pattern);
      /** @type {Array<{ file: string, line: number, text: string }>} */
      const matches = [];

      for (const file of files) {
        if (matches.length >= maxResults) break;
        const filePath = filePowers.joinPath(currentDir, ...file.split('/'));
        // Skip directories and binary files.
        // eslint-disable-next-line no-await-in-loop
        const isDir = await filePowers.isDirectory(filePath);
        if (isDir) continue;
        let content;
        try {
          // eslint-disable-next-line no-await-in-loop
          content = await filePowers.readFileText(filePath);
        } catch {
          // Skip unreadable files (binary, permission errors).
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (matches.length >= maxResults) break;
          if (regex.test(lines[i])) {
            matches.push(harden({
              file,
              line: i + 1,
              text: lines[i],
            }));
          }
        }
      }

      return harden(matches);
    },

    readOnly() {
      assertNotRevoked();
      if (readOnly) {
        return this; // eslint-disable-line no-invalid-this
      }
      return makeMountExo({
        ...ctx,
        readOnly: true,
        description: `Read-only view of ${description}`,
      });
    },

    async subDir(subpath) {
      assertNotRevoked();
      await null;
      // Validate and resolve segments.
      const segments = subpath.split('/').filter(s => s.length > 0);
      for (const seg of segments) {
        if (seg === '..' || seg === '.') {
          throw new Error(`Invalid subDir segment: ${seg}`);
        }
      }
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(target);
      if (!isDir) {
        throw new Error(`subDir target is not a directory: ${subpath}`);
      }
      return makeMountExo({
        ...ctx,
        currentDir: target,
        // The confinement root stays the same — the sub-mount cannot
        // escape above the original root.  But the sub-mount's own
        // navigation is restricted to its new currentDir because
        // resolveSegments clamps ".." to currentDir.
        confinementRoot: target,
        description: `${readOnly ? 'Read-only sub-mount' : 'Sub-mount'} at ${subpath} of ${description}`,
      });
    },

    async snapshot() {
      assertNotRevoked();
      if (!snapshotFn) {
        throw new Error('snapshot() is not available on this mount');
      }
      return snapshotFn(selfRef);
    },
  });

  selfRef = mount;
  return mount;
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
 * @param {((mount: object) => Promise<object>) | undefined} [opts.snapshotFn]
 * @returns {object}
 */
/**
 * Create a mount exo backed by a filesystem directory.
 *
 * Returns `{ mount, control }` where `mount` is the capability facet
 * and `control` is the caretaker facet for revocation.
 *
 * @param {object} opts
 * @param {string} opts.rootPath
 * @param {boolean} opts.readOnly
 * @param {FilePowers} opts.filePowers
 * @param {((mount: object) => Promise<object>) | undefined} [opts.snapshotFn]
 * @returns {{ mount: object, control: object }}
 */
export const makeMount = ({ rootPath, readOnly, filePowers, snapshotFn }) => {
  const prefix = readOnly ? 'Read-only mount' : 'Mount';
  const revokedRef = { revoked: false };

  /** @type {MountContext} */
  const ctx = {
    currentDir: rootPath,
    confinementRoot: rootPath,
    readOnly,
    filePowers,
    description: `${prefix} at ${rootPath}`,
    snapshotFn,
    revokedRef,
  };

  const mount = makeMountExo(ctx);

  const control = makeExo('EndoMountControl', MountControlInterface, {
    revoke() {
      revokedRef.revoked = true;
    },
    help() {
      return (
        `MountControl manages a mount at ${rootPath}. ` +
        `Methods: revoke(), help().`
      );
    },
  });

  return harden({ mount, control });
};
harden(makeMount);
