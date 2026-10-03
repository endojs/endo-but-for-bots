// @ts-check

/**
 * Compartment-mapper `ReadPowers` over a `ReadableTree` or `Mount`, so an
 * application can be captured from a tree the caller holds rather than from
 * the host filesystem (designs/agent-confined-application-makers.md § The tree
 * `ReadPowers`).
 *
 * Every location is a `file:` URL under a synthetic root (`file:///app/` by
 * default). The path below the root is split into segments, and each segment
 * is validated before any lookup, so a compartment map or a `package.json`
 * cannot name a file outside the tree. A location outside the root names
 * nothing in the tree: `maybeRead` answers `undefined` for it, `canonical`
 * returns it unchanged, and `read` refuses it, so the compartment mapper's
 * search for a `node_modules` directory can climb past the root and find
 * nothing there.
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';
import { collectBytes } from './extended/helpers.js';

/**
 * @import { ERef } from '@endo/eventual-send';
 * @import { ReadableTree } from './types.js';
 */

const defaultRoot = 'file:///app/';

/**
 * Percent-encoded forms of the path separators and of the NUL byte. A segment
 * carrying one of them would decode into a separator that the split did not
 * see, so it is refused in its raw form.
 */
const encodedSeparatorPattern = /%(?:2f|5c|00)/i;

/**
 * Characters that `encodeURIComponent` escapes but that Node's
 * `pathToFileURL` (and the WHATWG path percent-encode set) leave alone.
 */
const pathSafeEscapes = /%(?:24|26|2B|2C|3A|3B|3D|40)/g;

/**
 * Percent-encode one decoded segment as Node's `pathToFileURL` does, so a
 * location built here names a compartment the same way
 * `@endo/platform/fs/node` does.
 *
 * @param {string} segment
 * @returns {string}
 */
const encodeSegment = segment => {
  let encoded;
  try {
    encoded = encodeURIComponent(segment);
  } catch {
    // A lone surrogate has no UTF-8 encoding.
    throw makeError(X`Unencodable path segment ${q(segment)}`);
  }
  return encoded
    .replace(pathSafeEscapes, decodeURIComponent)
    .replace(/~/g, '%7E');
};

/**
 * Validate one raw (still percent-encoded) path segment and return its decoded
 * form. Refuses empty, `.`, and `..` segments, and any segment that names or
 * encodes a separator or a NUL byte, whether raw or percent-encoded.
 *
 * @param {string} raw
 * @param {string} location
 * @returns {string}
 */
const decodeSegment = (raw, location) => {
  if (raw === '') {
    throw makeError(X`Empty path segment in tree location ${q(location)}`);
  }
  if (encodedSeparatorPattern.test(raw)) {
    throw makeError(
      X`Encoded separator in tree location segment ${q(raw)} of ${q(location)}`,
    );
  }
  let segment;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    throw makeError(X`Malformed path segment ${q(raw)} in ${q(location)}`);
  }
  if (segment === '.' || segment === '..') {
    throw makeError(
      X`Relative path segment ${q(segment)} in tree location ${q(location)}`,
    );
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw makeError(
      X`Separator or NUL in path segment ${q(segment)} of ${q(location)}`,
    );
  }
  return segment;
};

/**
 * @param {string} root
 */
const assertRoot = root => {
  if (
    typeof root !== 'string' ||
    !root.startsWith('file:///') ||
    !root.endsWith('/') ||
    root.includes('?') ||
    root.includes('#')
  ) {
    throw makeError(
      X`Tree read powers root must be a file: URL ending in "/", got ${q(root)}`,
    );
  }
  // Every escape in the root must be well formed and must not encode a
  // separator or NUL.
  if (encodedSeparatorPattern.test(root) || /%(?![0-9a-f]{2})/i.test(root)) {
    throw makeError(
      X`Tree read powers root has a malformed or separator escape: ${q(root)}`,
    );
  }
  // A root that the URL parser would rewrite (a `.` or `..` segment, plain
  // or encoded, or an unencoded character) would not survive the
  // `fileURLToPath`/`pathToFileURL` round trip.
  if (new URL(root).href !== root) {
    throw makeError(
      X`Tree read powers root must be normalized, got ${q(root)}`,
    );
  }
};

/**
 * @typedef {object} TreeReadPowersOptions
 * @property {string} [root] - the synthetic `file:` URL the tree is mounted
 *   at; must end in `/`.
 * @property {(segments: string[]) => string[] | Promise<string[]>} [canonical]
 *   - map the decoded segments of a location under the root to the decoded
 *   segments of its canonical location under the same root. The hook receives
 *   a hardened copy and may return a new array (an empty array names the root
 *   itself); each returned segment is held to the same rule as a location's
 *   segments, so the hook cannot name anything outside the tree. A trailing
 *   `/` on the location is carried over to the result. Defaults to the
 *   identity, which returns the location unchanged. The daemon supplies one
 *   for a mount so that a package reached through more than one
 *   `node_modules` path loads as one compartment.
 */

/**
 * Make compartment-mapper `ReadPowers` (`read`, `maybeRead`, `canonical`,
 * `fileURLToPath`, `pathToFileURL`) over a `ReadableTree` or `Mount`.
 *
 * @param {ERef<ReadableTree>} tree - a `ReadableTree` or `Mount` reference
 * @param {TreeReadPowersOptions} [options]
 */
export const makeTreeReadPowers = (tree, options = {}) => {
  const { root = defaultRoot, canonical: canonicalSegments } = options;
  assertRoot(root);
  const rootPath = decodeURIComponent(new URL(root).pathname);

  /**
   * @param {unknown} location
   * @returns {location is string}
   */
  const isUnderRoot = location =>
    typeof location === 'string' && location.startsWith(root);

  /**
   * Parse a location into validated, decoded segments below the root.
   *
   * @param {string} location
   * @returns {string[]}
   */
  const toSegments = location => {
    if (typeof location !== 'string') {
      throw makeError(X`Tree location must be a string, got ${q(location)}`);
    }
    if (!location.startsWith(root)) {
      throw makeError(
        X`Tree location ${q(location)} is not under root ${q(root)}`,
      );
    }
    const rest = location.slice(root.length);
    if (rest.includes('?') || rest.includes('#') || rest.includes('\\')) {
      throw makeError(
        X`Unsupported characters in tree location ${q(location)}`,
      );
    }
    if (rest === '') {
      return [];
    }
    // A trailing slash names a directory; its segments are those before it.
    const body = rest.endsWith('/') ? rest.slice(0, -1) : rest;
    return body.split('/').map(raw => decodeSegment(raw, location));
  };

  /**
   * @param {string[]} segments
   * @param {boolean} directory
   */
  const toLocation = (segments, directory) =>
    `${root}${segments.map(encodeSegment).join('/')}${
      directory && segments.length > 0 ? '/' : ''
    }`;

  /**
   * A file has a byte reader; a directory does not.
   *
   * @param {unknown} entry
   */
  const isFile = async entry => {
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(/** @type {any} */ (entry)).__getMethodNames__();
    return methods.includes('streamBase64');
  };

  /**
   * @param {string[]} segments
   */
  const readSegments = async segments => {
    if (segments.length === 0) {
      throw makeError(X`Cannot read the tree root as a file`);
    }
    const entry = await E(tree).lookup(segments);
    if (!(await isFile(entry))) {
      throw makeError(X`Tree location ${q(segments.join('/'))} is not a file`);
    }
    return collectBytes(entry);
  };

  /**
   * @param {string} location
   * @returns {Promise<Uint8Array>}
   */
  const read = async location => {
    const segments = toSegments(location);
    return readSegments(segments);
  };

  /**
   * Decide, after a lookup of `segments` has failed, whether the location is
   * absent: some segment is missing, or a segment before the last names a
   * file rather than a directory. Returns false when every segment is
   * present, so the caller surfaces the lookup's own error.
   *
   * @param {string[]} segments
   * @returns {Promise<boolean>}
   */
  const isAbsent = async segments => {
    await null;
    /** @type {ERef<ReadableTree>} */
    let node = tree;
    for (const [index, segment] of segments.entries()) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await E(node).has(segment))) {
        return true;
      }
      if (index === segments.length - 1) {
        return false;
      }
      /** @type {unknown} */
      let child;
      try {
        // eslint-disable-next-line no-await-in-loop
        child = await E(node).lookup(segment);
      } catch (error) {
        // The entry may have been removed since `has` answered.
        // eslint-disable-next-line no-await-in-loop
        if (!(await E(node).has(segment))) {
          return true;
        }
        throw error;
      }
      // A file names no children, so the rest of the path is absent.
      // eslint-disable-next-line no-await-in-loop, no-underscore-dangle
      const methods = await E(/** @type {any} */ (child)).__getMethodNames__();
      if (!methods.includes('has') || !methods.includes('lookup')) {
        return true;
      }
      node = /** @type {ERef<ReadableTree>} */ (child);
    }
    return false;
  };

  /**
   * @param {string} location
   * @returns {Promise<Uint8Array | undefined>}
   */
  const maybeRead = async location => {
    await null;
    if (typeof location === 'string' && !isUnderRoot(location)) {
      return undefined;
    }
    const segments = toSegments(location);
    if (segments.length === 0) {
      return undefined;
    }
    // One atomic lookup, as `read` does, so a tree that changes underneath
    // cannot split a check from its use. Only a failed lookup pays for the
    // walk that tells a missing entry from any other error.
    let entry;
    try {
      entry = await E(tree).lookup(segments);
    } catch (error) {
      let absent;
      try {
        absent = await isAbsent(segments);
      } catch {
        // The walk failing says nothing about absence; keep the lookup's
        // own error.
        throw error;
      }
      if (absent) {
        return undefined;
      }
      throw error;
    }
    // A directory is absent as a file, as Node's `maybeRead` treats EISDIR.
    if (!(await isFile(entry))) {
      return undefined;
    }
    return collectBytes(entry);
  };

  /**
   * @param {string} location
   * @returns {Promise<string>}
   */
  const canonical = async location => {
    await null;
    if (typeof location === 'string' && !isUnderRoot(location)) {
      return location;
    }
    const segments = toSegments(location);
    if (canonicalSegments === undefined) {
      return location;
    }
    const mapped = await canonicalSegments(harden([...segments]));
    if (!Array.isArray(mapped)) {
      throw makeError(X`canonical hook must return an array of segments`);
    }
    // Read the hook's result once, by index, into an array of our own, so a
    // getter, an iterator, or a `map` override cannot answer validation and
    // serialization differently.
    /** @type {unknown[]} */
    const snapshot = [];
    const { length } = mapped;
    for (let index = 0; index < length; index += 1) {
      snapshot.push(mapped[index]);
    }
    harden(snapshot);
    for (const segment of snapshot) {
      if (typeof segment !== 'string') {
        throw makeError(
          X`canonical hook returned a non-string segment ${q(segment)}`,
        );
      }
      // The hook's result is held to the same rule as any location.
      decodeSegment(encodeSegment(segment), location);
    }
    return toLocation(
      /** @type {string[]} */ (snapshot),
      location.endsWith('/'),
    );
  };

  /**
   * @param {string} location
   * @returns {string}
   */
  const fileURLToPath = location => {
    const segments = toSegments(location);
    return `${rootPath}${segments.join('/')}${
      segments.length > 0 && location.endsWith('/') ? '/' : ''
    }`;
  };

  /**
   * @param {string} path
   * @returns {URL}
   */
  const pathToFileURL = path => {
    if (typeof path !== 'string' || !path.startsWith(rootPath)) {
      throw makeError(X`Path ${q(path)} is not under root ${q(rootPath)}`);
    }
    const location = toLocation(
      path
        .slice(rootPath.length)
        .split('/')
        .filter(segment => segment !== ''),
      path.endsWith('/'),
    );
    toSegments(location);
    return new URL(location);
  };

  return harden({
    read,
    maybeRead,
    canonical,
    fileURLToPath,
    pathToFileURL,
  });
};
harden(makeTreeReadPowers);
