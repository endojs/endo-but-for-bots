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
 * cannot name a file outside the tree.
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';
import { collectBytes } from './extended/helpers.js';

const defaultRoot = 'file:///app/';

/**
 * Percent-encoded forms of the path separators and of the NUL byte. A segment
 * carrying one of them would decode into a separator that the split did not
 * see, so it is refused in its raw form.
 */
const encodedSeparatorPattern = /%(?:2f|5c|00)/i;

/**
 * Validate one raw (still percent-encoded) path segment and return its decoded
 * form. Refuses empty, `.`, and `..` segments, and any segment that names or
 * encodes a separator.
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
  if (segment.includes('/') || segment.includes('\\')) {
    throw makeError(
      X`Separator in path segment ${q(segment)} of ${q(location)}`,
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
};

/**
 * @typedef {object} TreeReadPowersOptions
 * @property {string} [root] - the synthetic `file:` URL the tree is mounted
 *   at; must end in `/`.
 * @property {(segments: string[]) => string[] | Promise<string[]>} [canonical]
 *   - map the segments of a location to the segments of its canonical
 *   location. Defaults to the identity. The daemon supplies one for a mount so
 *   that a package reached through more than one `node_modules` path loads as
 *   one compartment.
 */

/**
 * Make compartment-mapper `ReadPowers` (`read`, `maybeRead`, `canonical`,
 * `fileURLToPath`, `pathToFileURL`) over a `ReadableTree` or `Mount`.
 *
 * @param {unknown} tree - a `ReadableTree` or `Mount` reference
 * @param {TreeReadPowersOptions} [options]
 */
export const makeTreeReadPowers = (tree, options = {}) => {
  const { root = defaultRoot, canonical: canonicalSegments } = options;
  assertRoot(root);
  const rootPath = new URL(root).pathname;

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
    `${root}${segments.map(encodeURIComponent).join('/')}${
      directory && segments.length > 0 ? '/' : ''
    }`;

  /**
   * @param {string[]} segments
   */
  const readSegments = async segments => {
    if (segments.length === 0) {
      throw makeError(X`Cannot read the tree root as a file`);
    }
    const entry = await E(tree).lookup(segments);
    return collectBytes(entry);
  };

  /** @param {string} location */
  const read = async location => {
    const segments = toSegments(location);
    return readSegments(segments);
  };

  /** @param {string} location */
  const maybeRead = async location => {
    await null;
    const segments = toSegments(location);
    if (segments.length === 0) {
      return undefined;
    }
    // Walk one segment at a time so a missing intermediate directory reads
    // as absent rather than surfacing the tree's lookup error.
    /** @type {unknown} */
    let node = tree;
    for (const segment of segments) {
      // eslint-disable-next-line no-await-in-loop
      const present = await E(node).has(segment);
      if (!present) {
        return undefined;
      }
      // eslint-disable-next-line no-await-in-loop
      node = await E(node).lookup(segment);
    }
    return collectBytes(node);
  };

  /** @param {string} location */
  const canonical = async location => {
    await null;
    const segments = toSegments(location);
    if (canonicalSegments === undefined) {
      return toLocation(segments, location.endsWith('/'));
    }
    const mapped = await canonicalSegments(harden([...segments]));
    if (!Array.isArray(mapped)) {
      throw makeError(X`canonical hook must return an array of segments`);
    }
    for (const segment of mapped) {
      // The hook's result is held to the same rule as any location.
      decodeSegment(encodeURIComponent(segment), location);
    }
    return toLocation(mapped, location.endsWith('/'));
  };

  /** @param {string} location */
  const fileURLToPath = location => {
    const segments = toSegments(location);
    return `${rootPath}${segments.join('/')}`;
  };

  /** @param {string} path */
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
